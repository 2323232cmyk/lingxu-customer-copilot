import { randomBytes } from 'node:crypto';

export const LOCAL_MEDIA_LIMITS = {
  imageBytes: 8 * 1024 * 1024,
  cacheBytes: 32 * 1024 * 1024,
  cacheEntries: 128,
  registeredEntries: 8192,
  concurrentLoads: 3,
  loadTimeoutMs: 10_000,
} as const;

export type LocalMediaMime = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
export type LocalMediaResult =
  | { ok: true; dataUrl: string; mime: LocalMediaMime }
  | { ok: false; reason: 'missing' | 'unsupported' | 'unavailable' };

/** Each successful loader call transfers ownership of its returned buffer to the registry. */
export type LocalMediaLoader = (options: {
  signal: AbortSignal;
  maxBytes: number;
}) => Promise<{ buffer: Buffer; mime: string } | null>;

type MediaSuccess = Extract<LocalMediaResult, { ok: true }>;
type MediaFailure = Extract<LocalMediaResult, { ok: false }>;
type PendingLoad = {
  result: Promise<LocalMediaResult>;
  cancel(reason: MediaFailure['reason']): void;
};

const failure = (reason: MediaFailure['reason']): MediaFailure => ({ ok: false, reason });

const detectImageMime = (buffer: Buffer): LocalMediaMime | null => {
  if (buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (buffer.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))) return 'image/jpeg';
  const gif = buffer.toString('latin1', 0, 6);
  if (gif === 'GIF87a' || gif === 'GIF89a') return 'image/gif';
  if (
    buffer.length >= 16
    && buffer.toString('latin1', 0, 4) === 'RIFF'
    && buffer.toString('latin1', 8, 12) === 'WEBP'
    && ['VP8 ', 'VP8L', 'VP8X'].includes(buffer.toString('latin1', 12, 16))
  ) return 'image/webp';
  return null;
};

const toRendererImage = (image: Awaited<ReturnType<LocalMediaLoader>>): LocalMediaResult => {
  if (image === null) return failure('missing');
  if (
    !image || !Buffer.isBuffer(image.buffer)
    || image.buffer.length === 0 || image.buffer.length > LOCAL_MEDIA_LIMITS.imageBytes
  ) return failure('unsupported');
  const mime = detectImageMime(image.buffer);
  if (!mime || mime !== image.mime) return failure('unsupported');
  return { ok: true, dataUrl: `data:${mime};base64,${image.buffer.toString('base64')}`, mime };
};

/** Main-process only. The IPC caller must first authenticate the actual sender frame. */
export class LocalMediaRegistry {
  private readonly loaders = new Map<string, LocalMediaLoader>();
  private readonly cache = new Map<string, { image: MediaSuccess; bytes: number }>();
  private readonly pending = new Map<string, PendingLoad>();
  private cacheBytes = 0;
  private activeLoads = 0;
  private generation = 0;

  /** Register once per media item; keep this opaque key until the account is cleared. */
  register(loader: LocalMediaLoader): string | null {
    if (typeof loader !== 'function' || this.loaders.size >= LOCAL_MEDIA_LIMITS.registeredEntries) return null;
    const key = randomBytes(32).toString('hex');
    this.loaders.set(key, loader);
    return key;
  }

  async resolveForRenderer(key: unknown): Promise<LocalMediaResult> {
    if (typeof key !== 'string' || key.length !== 64 || !/^[a-f0-9]{64}$/u.test(key)) return failure('missing');
    const loader = this.loaders.get(key);
    if (!loader) return failure('missing');
    const generation = this.generation;
    const cached = this.cache.get(key);
    let result: LocalMediaResult;
    if (cached) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      result = await Promise.resolve(cached.image);
    } else {
      result = await (this.pending.get(key)?.result ?? this.load(key, loader));
    }
    if (generation !== this.generation) return failure('missing');
    return { ...result };
  }

  /** Also cancels callers waiting on old-account loads; no source file is changed. */
  clear(): void {
    this.generation += 1;
    this.loaders.clear();
    this.cache.clear();
    this.cacheBytes = 0;
    for (const flight of this.pending.values()) flight.cancel('missing');
    this.pending.clear();
    // Do not reset activeLoads: an abort-ignoring loader still occupies its slot.
  }

  private load(key: string, loader: LocalMediaLoader): Promise<LocalMediaResult> {
    if (this.activeLoads >= LOCAL_MEDIA_LIMITS.concurrentLoads) return Promise.resolve(failure('unavailable'));
    const generation = this.generation;
    const controller = new AbortController();
    let complete!: (result: LocalMediaResult) => void;
    const result = new Promise<LocalMediaResult>((resolve) => { complete = resolve; });
    const flight: PendingLoad = {
      result,
      cancel: (reason) => {
        complete(failure(reason));
        controller.abort();
      },
    };
    this.pending.set(key, flight);
    this.activeLoads += 1;
    const timer = setTimeout(() => flight.cancel('unavailable'), LOCAL_MEDIA_LIMITS.loadTimeoutMs);
    void (async () => {
      let ownedBuffer: Buffer | undefined;
      try {
        const image = await loader({ signal: controller.signal, maxBytes: LOCAL_MEDIA_LIMITS.imageBytes });
        if (image && Buffer.isBuffer(image.buffer)) ownedBuffer = image.buffer;
        if (controller.signal.aborted || generation !== this.generation) return;
        const response = toRendererImage(image);
        if (response.ok) this.remember(key, response);
        complete(response);
      } catch {
        complete(failure('unavailable'));
      } finally {
        ownedBuffer?.fill(0);
        clearTimeout(timer);
        this.activeLoads -= 1;
        if (this.pending.get(key) === flight) this.pending.delete(key);
      }
    })();
    return result;
  }

  private remember(key: string, image: MediaSuccess): void {
    // Keep only the data URL, not the original buffer. Budget conservatively for UTF-16.
    const bytes = image.dataUrl.length * 2;
    if (bytes > LOCAL_MEDIA_LIMITS.cacheBytes) return;
    while (
      this.cache.size > 0
      && (this.cache.size >= LOCAL_MEDIA_LIMITS.cacheEntries || this.cacheBytes + bytes > LOCAL_MEDIA_LIMITS.cacheBytes)
    ) {
      const oldest = this.cache.keys().next().value as string;
      const removed = this.cache.get(oldest);
      this.cache.delete(oldest);
      this.cacheBytes -= removed?.bytes ?? 0;
    }
    this.cache.set(key, { image, bytes });
    this.cacheBytes += bytes;
  }
}
