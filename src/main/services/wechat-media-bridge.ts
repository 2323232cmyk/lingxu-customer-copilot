import { randomBytes } from 'node:crypto';
import type { WechatMediaResult } from '../../shared/contracts';
import { LOCAL_MEDIA_LIMITS, LocalMediaRegistry, type LocalMediaLoader } from './local-media';

const CHUNK_BYTES = 32 * 1024;
type MediaFailureStatus = 'pending' | 'encrypted' | 'missing' | 'unsupported';
interface MediaEntry { nativeKey: string; registeredKey?: string; mediaStatus?: MediaFailureStatus }
const isFailureStatus = (value: unknown): value is MediaFailureStatus =>
  typeof value === 'string' && ['pending', 'encrypted', 'missing', 'unsupported'].includes(value);

/** Account/generation scoped aliases. Only approved native refs can be requested by the UI. */
export class WechatMediaBridge {
  private readonly registry = new LocalMediaRegistry();
  private readonly aliases = new Map<string, string>();
  private readonly entries = new Map<string, MediaEntry>();
  private disposed = false;

  constructor(private readonly options: {
    isCurrent(): boolean;
    request(mediaKey: string, offset: number): Promise<unknown>;
  }) {}

  register(nativeKey: string | undefined): string | undefined {
    if (this.disposed || typeof nativeKey !== 'string' || !/^media_[a-f0-9]{64}$/u.test(nativeKey)) return undefined;
    const existing = this.aliases.get(nativeKey);
    if (existing) return existing;
    if (this.aliases.size >= LOCAL_MEDIA_LIMITS.registeredEntries) return undefined;
    const key = randomBytes(32).toString('hex');
    this.aliases.set(nativeKey, key);
    this.entries.set(key, { nativeKey });
    return key;
  }

  async resolve(key: unknown): Promise<WechatMediaResult> {
    if (this.disposed || !this.options.isCurrent() || typeof key !== 'string' || !/^[a-f0-9]{64}$/u.test(key)) {
      return { ok: false, reason: 'missing' };
    }
    const entry = this.entries.get(key);
    if (!entry) return { ok: false, reason: 'missing' };
    entry.registeredKey ??= this.registry.register(this.loader(entry)) ?? undefined;
    if (!entry.registeredKey) return { ok: false, reason: 'unavailable' };
    const result = await this.registry.resolveForRenderer(entry.registeredKey);
    if (this.disposed || !this.options.isCurrent()) return { ok: false, reason: 'missing' };
    return !result.ok && entry.mediaStatus ? {
      ...result, reason: entry.mediaStatus === 'pending' ? 'unavailable' : result.reason, mediaStatus: entry.mediaStatus,
    } : result;
  }

  private loader(entry: MediaEntry): LocalMediaLoader {
    return async ({ signal, maxBytes }) => {
      entry.mediaStatus = undefined;
      const chunks: Buffer[] = [];
      let offset = 0;
      let expectedSize: number | undefined;
      let mime: string | undefined;
      try {
        while (!signal.aborted && !this.disposed && this.options.isCurrent()) {
          const value = await this.options.request(entry.nativeKey, offset);
          if (signal.aborted || this.disposed || !this.options.isCurrent()) return null;
          if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
          const chunk = value as Record<string, unknown>;
          if (chunk.ok === false) {
            if (isFailureStatus(chunk.status)) entry.mediaStatus = chunk.status;
            return null;
          }
          if (chunk.ok !== true || typeof chunk.mime !== 'string' || !['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(chunk.mime)
            || !Number.isSafeInteger(chunk.totalBytes) || Number(chunk.totalBytes) < 1 || Number(chunk.totalBytes) > maxBytes
            || chunk.offset !== offset || typeof chunk.data !== 'string' || chunk.data.length > Math.ceil(CHUNK_BYTES / 3) * 4
            || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(chunk.data)) return null;
          const totalBytes = Number(chunk.totalBytes);
          if ((expectedSize !== undefined && expectedSize !== totalBytes) || (mime !== undefined && mime !== chunk.mime)) return null;
          expectedSize = totalBytes; mime = chunk.mime;
          const bytes = Buffer.from(chunk.data, 'base64');
          chunks.push(bytes);
          if (bytes.toString('base64') !== chunk.data) return null;
          const end = Math.min(offset + CHUNK_BYTES, totalBytes);
          if (bytes.length !== end - offset || chunk.nextOffset !== end || end <= offset) return null;
          offset = end;
          if (offset === totalBytes) return { buffer: Buffer.concat(chunks, totalBytes), mime };
        }
        return null;
      } finally { for (const bytes of chunks) bytes.fill(0); }
    };
  }

  clear(): void {
    this.disposed = true;
    for (const entry of this.entries.values()) entry.mediaStatus = undefined;
    this.registry.clear(); this.aliases.clear(); this.entries.clear();
  }
}
