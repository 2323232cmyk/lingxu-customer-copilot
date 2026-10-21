import { randomBytes } from 'node:crypto';
import { MAX_WECHAT_VOICE_BYTES, voiceFormat } from '../adapters/wechat-native/wechat-voice-store';

const CHUNK_BYTES = 32 * 1024;
/** Raw audio is main-process-only; these aliases can never resolve through the image renderer. */
export class WechatVoiceBridge {
  private readonly aliases = new Map<string, string>();
  private readonly entries = new Map<string, string>();
  private disposed = false;
  private active = 0;
  constructor(private readonly options: {
    isCurrent(): boolean;
    request(mediaKey: string, offset: number): Promise<unknown>;
  }) {}

  register(nativeKey: string | undefined): string | undefined {
    if (this.disposed || !nativeKey || !/^media_[a-f0-9]{64}$/u.test(nativeKey)) return undefined;
    const known = this.aliases.get(nativeKey);
    if (known) return known;
    const key = randomBytes(32).toString('hex');
    this.aliases.set(nativeKey, key); this.entries.set(key, nativeKey);
    if (this.entries.size > 8192) {
      const oldest = this.entries.entries().next().value;
      if (oldest) { this.entries.delete(oldest[0]); this.aliases.delete(oldest[1]); }
    }
    return key;
  }

  async read(key: unknown, options: { signal?: AbortSignal } = {}): Promise<{ bytes: Buffer; format: 'silk' | 'wav' } | undefined> {
    if (this.disposed || !this.options.isCurrent() || options.signal?.aborted || typeof key !== 'string'
      || !/^[a-f0-9]{64}$/u.test(key) || this.active >= 3) return undefined;
    const nativeKey = this.entries.get(key);
    if (!nativeKey) return undefined;
    const chunks: Buffer[] = [];
    let offset = 0, expected: number | undefined, format: 'silk' | 'wav' | undefined;
    this.active += 1;
    try {
      while (!this.disposed && this.options.isCurrent() && !options.signal?.aborted) {
        const raw = await this.options.request(nativeKey, offset);
        if (this.disposed || !this.options.isCurrent() || options.signal?.aborted || !raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
        const value = raw as Record<string, unknown>;
        const nextFormat = value.mime === 'audio/wav' ? 'wav' : value.mime === 'audio/x-silk' ? 'silk' : undefined;
        if (value.ok !== true || !nextFormat || !Number.isSafeInteger(value.totalBytes) || Number(value.totalBytes) < 1 || Number(value.totalBytes) > MAX_WECHAT_VOICE_BYTES
          || value.offset !== offset || typeof value.data !== 'string' || value.data.length > Math.ceil(CHUNK_BYTES / 3) * 4
          || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value.data)) return undefined;
        const total = Number(value.totalBytes);
        if (expected !== undefined && expected !== total || format !== undefined && format !== nextFormat) return undefined;
        expected = total; format = nextFormat;
        const bytes = Buffer.from(value.data, 'base64'); chunks.push(bytes);
        const end = Math.min(offset + CHUNK_BYTES, total);
        if (bytes.toString('base64') !== value.data || bytes.length !== end - offset || value.nextOffset !== end || end <= offset) return undefined;
        offset = end;
        if (end === total) {
          const result = Buffer.concat(chunks, total);
          if (voiceFormat(result) === format) return { bytes: result, format };
          result.fill(0); return undefined;
        }
      }
    } catch { /* Database/protocol diagnostics must not disclose account data. */ }
    finally { this.active -= 1; for (const chunk of chunks) chunk.fill(0); }
    return undefined;
  }

  clear(): void { this.disposed = true; this.entries.clear(); this.aliases.clear(); }
}
