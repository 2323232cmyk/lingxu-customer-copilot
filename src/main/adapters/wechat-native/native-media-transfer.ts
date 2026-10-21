export const MEDIA_CHUNK_BYTES = 32 * 1024;
export const MEDIA_MAX_BYTES = 8 * 1024 * 1024;
interface MediaSource {
  readMedia(mediaKey: string): Promise<{ bytes: Buffer; mimeType: string } | undefined>;
  getMediaRef(mediaKey: string): { status: string } | undefined;
}
interface Transfer {
  bytes: Buffer;
  mime: string;
  nextOffset: number;
  timer: ReturnType<typeof setTimeout>;
}

/** Keep at most three bounded media payloads while their IPC chunks are in flight. */
export class NativeMediaTransfer {
  private readonly transfers = new Map<string, Transfer>();
  private readonly pending = new Map<string, Promise<Record<string, unknown>>>();
  private activeLoads = 0;
  private disposed = false;
  constructor(private readonly source: MediaSource, private readonly options: {
    readonly mimeTypes?: readonly string[];
    readonly maxBytes?: number;
  } = {}) {}

  async read(mediaKey: string, offset: number): Promise<Record<string, unknown>> {
    if (this.disposed || typeof mediaKey !== 'string' || !/^media_[a-f0-9]{64}$/u.test(mediaKey) || !Number.isSafeInteger(offset)
      || offset < 0 || offset >= (this.options.maxBytes ?? MEDIA_MAX_BYTES) || offset % MEDIA_CHUNK_BYTES !== 0) {
      return { ok: false, status: 'missing' };
    }
    let flight = this.pending.get(mediaKey);
    if (offset === 0 && !flight && !this.transfers.has(mediaKey)) {
      if (this.activeLoads >= 3) return { ok: false, status: 'pending' };
      while (this.transfers.size + this.activeLoads >= 3) this.release(this.transfers.keys().next().value as string);
      this.activeLoads += 1;
      const pending: Promise<Record<string, unknown>> = this.loadFirstChunk(mediaKey).finally(() => {
        this.activeLoads -= 1;
        if (this.pending.get(mediaKey) === pending) this.pending.delete(mediaKey);
      });
      this.pending.set(mediaKey, pending);
      flight = pending;
    }
    const result = offset === 0 && flight ? await flight : await Promise.resolve(this.readChunk(mediaKey, offset));
    return this.disposed ? { ok: false, status: 'missing' } : { ...result };
  }

  private async loadFirstChunk(mediaKey: string): Promise<Record<string, unknown>> {
    let owned: Buffer | undefined;
    try {
      const media = await this.source.readMedia(mediaKey);
      owned = media && Buffer.isBuffer(media.bytes) ? media.bytes : undefined;
      if (this.disposed) return { ok: false, status: 'missing' };
      if (!media) {
        const status = this.source.getMediaRef(mediaKey)?.status;
        return { ok: false, status: status && ['pending', 'encrypted', 'missing', 'unsupported'].includes(status) ? status : 'missing' };
      }
      if (!owned || !owned.length || owned.length > (this.options.maxBytes ?? MEDIA_MAX_BYTES)
        || !(this.options.mimeTypes ?? ['image/jpeg', 'image/png', 'image/gif', 'image/webp']).includes(media.mimeType)) {
        return { ok: false, status: 'unsupported' };
      }
      const transfer: Transfer = { bytes: owned, mime: media.mimeType, nextOffset: 0,
        timer: setTimeout(() => this.release(mediaKey), 10_000) };
      transfer.timer.unref?.();
      this.transfers.set(mediaKey, transfer);
      owned = undefined;
      return this.readChunk(mediaKey, 0);
    } catch {
      this.release(mediaKey);
      return { ok: false, status: 'missing' };
    } finally {
      owned?.fill(0);
    }
  }

  private readChunk(mediaKey: string, offset: number): Record<string, unknown> {
    const transfer = this.transfers.get(mediaKey);
    if (!transfer || offset >= transfer.bytes.length || (offset !== 0 && offset !== transfer.nextOffset)) {
      return { ok: false, status: 'missing' };
    }
    const end = Math.min(offset + MEDIA_CHUNK_BYTES, transfer.bytes.length);
    const result = { ok: true, mime: transfer.mime, offset, totalBytes: transfer.bytes.length,
      data: transfer.bytes.subarray(offset, end).toString('base64'), nextOffset: end };
    transfer.nextOffset = end;
    if (end === transfer.bytes.length) this.release(mediaKey);
    else {
      clearTimeout(transfer.timer);
      transfer.timer = setTimeout(() => this.release(mediaKey), 10_000);
      transfer.timer.unref?.();
    }
    return result;
  }

  private release(key: string): void {
    const transfer = this.transfers.get(key);
    if (transfer) { clearTimeout(transfer.timer); transfer.bytes.fill(0); this.transfers.delete(key); }
  }

  dispose(): void {
    this.disposed = true;
    for (const key of this.transfers.keys()) this.release(key);
    this.pending.clear();
  }
}
