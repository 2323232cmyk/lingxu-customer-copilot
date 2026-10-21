import { createDecipheriv, createHash } from 'node:crypto';
import type { ReadableWechatProcess } from './wechat-readonly-memory';

// V2 layout reference (Apache-2.0); independent implementation, no upstream runtime:
// fanyuantaier/wechatauto-replica@22ee7adf875414da5bb8984860565930ecb31d7a/wechatauto/media.py
const V2_SIGNATURE = Buffer.from([7, 8, 86, 50, 8, 7]);
const MAX_FILE_BYTES = 12 * 1024 * 1024;
const MAX_AES_PLAIN_BYTES = 65536;
const CHUNK_BYTES = 2 * 1024 * 1024;
const MAX_SCAN_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_CANDIDATES = 100000;
const MAX_THUMBNAILS = 16;
const CONFIG_LANDMARK = Buffer.from('global_config');
const HEX_DIGITS = Buffer.from('0123456789abcdef');
type ImageMime = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
type ImageFormat = ImageMime | 'wxgf';

export type WechatImageDecodeResult =
  | { readonly status: 'ready'; readonly mimeType: ImageMime; readonly bytes: Buffer }
  | { readonly status: 'pending' | 'encrypted' | 'unsupported' };

/** Owns its two small buffers; clear after use. It contains no path, account or plaintext. */
export interface WechatV2Probe {
  readonly plainLength: number;
  readonly xorLength: number;
  readonly fileLength: number;
  readonly cipher: Buffer;
  readonly tail: Buffer;
}

const bounded = (value: number | undefined, maximum: number, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(maximum, Math.max(1, Math.floor(value))) : fallback;
const yieldTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const isAlnum = (byte: number): boolean => byte >= 48 && byte <= 57
  || byte >= 65 && byte <= 90 || byte >= 97 && byte <= 122;

function imageFormat(bytes: Buffer): ImageFormat | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return 'image/gif';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (bytes.length >= 4 && bytes.toString('ascii', 0, 4) === 'wxgf') return 'wxgf';
  return undefined;
}

function validProbe(probe: WechatV2Probe): boolean {
  return Boolean(probe) && Number.isSafeInteger(probe.plainLength) && probe.plainLength > 0 && probe.plainLength <= MAX_AES_PLAIN_BYTES
    && Number.isSafeInteger(probe.xorLength) && probe.xorLength >= 0
    && Number.isSafeInteger(probe.fileLength) && probe.fileLength <= MAX_FILE_BYTES
    && Buffer.isBuffer(probe.cipher) && probe.cipher.length === probe.plainLength + 16 - probe.plainLength % 16
    && probe.fileLength >= 15 + probe.cipher.length + probe.xorLength
    && Buffer.isBuffer(probe.tail) && probe.tail.length === 2;
}

/** Snapshot only the bounded AES segment and encrypted EOF, never retain caller-owned file bytes. */
export function createWechatV2Probe(bytes: Buffer): WechatV2Probe | undefined {
  if (!Buffer.isBuffer(bytes) || bytes.length < 31 || bytes.length > MAX_FILE_BYTES
    || !bytes.subarray(0, 6).equals(V2_SIGNATURE)) return undefined;
  const plainLength = bytes.readUInt32LE(6);
  const xorLength = bytes.readUInt32LE(10);
  const cipherLength = plainLength + 16 - plainLength % 16;
  if (plainLength < 1 || plainLength > MAX_AES_PLAIN_BYTES || 15 + cipherLength + xorLength > bytes.length) return undefined;
  return { plainLength, xorLength, fileLength: bytes.length,
    cipher: Buffer.from(bytes.subarray(15, 15 + cipherLength)), tail: Buffer.from(bytes.subarray(-2)) };
}

export function clearWechatV2Probe(probe: WechatV2Probe): void {
  probe.cipher.fill(0);
  probe.tail.fill(0);
}

function decryptHead(key: Buffer, probe: WechatV2Probe): Buffer | undefined {
  if (!Buffer.isBuffer(key) || key.length !== 16 || !validProbe(probe)) return undefined;
  let first: Buffer | undefined;
  let last: Buffer | undefined;
  let clear: Buffer | undefined;
  try {
    const decipher = createDecipheriv('aes-128-ecb', key, null);
    // Keep default PKCS#7 validation: a plausible first block alone is not sufficient.
    first = decipher.update(probe.cipher);
    last = decipher.final();
    clear = Buffer.concat([first, last]);
    if (clear.length !== probe.plainLength || !imageFormat(clear)) return undefined;
    const result = clear;
    clear = undefined;
    return result;
  } catch { return undefined; }
  finally { first?.fill(0); last?.fill(0); clear?.fill(0); }
}

function verifiedFormat(key: Buffer, probe: WechatV2Probe): ImageFormat | undefined {
  const head = decryptHead(key, probe);
  try { return head ? imageFormat(head) : undefined; }
  finally { head?.fill(0); }
}

/** Crypto/layout validation only; the media channel must still decode raster pixels before display. */
export function decodeWechatV2Image(bytes: Buffer, key: Buffer, xorKey?: number): WechatImageDecodeResult {
  const probe = createWechatV2Probe(bytes);
  if (!probe) return { status: 'unsupported' };
  let head: Buffer | undefined;
  let output: Buffer | undefined;
  try {
    head = decryptHead(key, probe);
    if (!head) return { status: 'encrypted' };
    const mimeType = imageFormat(head);
    if (!mimeType || mimeType === 'wxgf') return { status: 'unsupported' };
    if (probe.xorLength > 0 && (typeof xorKey !== 'number' || !Number.isInteger(xorKey) || xorKey < 0 || xorKey > 255)) return { status: 'encrypted' };
    output = Buffer.alloc(head.length + bytes.length - 15 - probe.cipher.length);
    head.copy(output);
    bytes.copy(output, head.length, 15 + probe.cipher.length);
    for (let index = output.length - probe.xorLength; index < output.length; index += 1) output[index] ^= xorKey ?? 0;
    const result: WechatImageDecodeResult = { status: 'ready', mimeType, bytes: output };
    output = undefined;
    return result;
  } finally { head?.fill(0); output?.fill(0); clearWechatV2Probe(probe); }
}

/** Only JPEG thumbnail EOF from the same verified AES key can supply an XOR byte. */
function thumbnailXor(key: Buffer, thumbnails: readonly WechatV2Probe[]): number | undefined {
  const frequencies = new Map<number, number>();
  for (const probe of thumbnails.slice(0, MAX_THUMBNAILS)) {
    if (!validProbe(probe) || probe.xorLength < 2 || verifiedFormat(key, probe) !== 'image/jpeg') continue;
    const value = probe.tail[0] ^ 0xff;
    if ((probe.tail[1] ^ 0xd9) !== value) continue;
    frequencies.set(value, (frequencies.get(value) ?? 0) + 1);
  }
  const ordered = [...frequencies].sort((left, right) => right[1] - left[1]);
  return ordered.length && (ordered.length === 1 || ordered[0][1] > ordered[1][1]) ? ordered[0][0] : undefined;
}

/** Config layout reference: the same pinned upstream db.py. Never reads its DB master key. */
function configImageKey(
  read: (address: number, length: number) => Buffer | null,
  landmark: number, account: Buffer, requested: WechatV2Probe,
): Buffer | undefined {
  const pointer = (bytes: Buffer, offset: number): number => {
    const value = bytes.readBigUInt64LE(offset);
    return value >= 0x10000n && value < 0x800000000000n ? Number(value) : 0;
  };
  const descriptor = read(landmark, 32);
  try {
    if (!descriptor || !descriptor.subarray(0, 13).equals(CONFIG_LANDMARK) || descriptor[13] !== 0
      || descriptor.readBigUInt64LE(16) !== 13n || descriptor.readBigUInt64LE(24) !== 15n) return undefined;
  } finally { descriptor?.fill(0); }
  // Published layouts differ here. Both require an exact account match AND image validation.
  for (const back of [0x138, 0x130]) {
    const buffers: Buffer[] = [];
    const owned = (address: number, length: number): Buffer | null => {
      const bytes = read(address, length);
      if (bytes) buffers.push(bytes);
      return bytes;
    };
    let key: Buffer | undefined;
    try {
      const parent = owned(landmark + 16 - back, 8);
      const parentAddress = parent && pointer(parent, 0);
      if (!parentAddress) continue;
      const link = owned(parentAddress + 0x68, 8);
      const configAddress = link && pointer(link, 0);
      if (!configAddress) continue;
      const config = owned(configAddress + 0x40, 40);
      if (!config || config.readBigUInt64LE(24) !== BigInt(account.length)) continue;
      const capacity = config.readBigUInt64LE(32);
      if (capacity < BigInt(account.length) || capacity > 4096n) continue;
      const accountAddress = capacity <= 15n ? configAddress + 0x48 : pointer(config, 8);
      if (!accountAddress) continue;
      const actual = owned(accountAddress, account.length + 1);
      if (!actual || actual[account.length] !== 0 || !actual.subarray(0, account.length).equals(account)) continue;
      const decimal = Buffer.alloc(10);
      buffers.push(decimal);
      let value = config.readUInt32LE(0);
      let start = decimal.length;
      do { decimal[--start] = 48 + value % 10; value = Math.floor(value / 10); } while (value > 0);
      const digest = createHash('md5').update(decimal.subarray(start)).update(account).digest();
      buffers.push(digest);
      key = Buffer.alloc(16);
      for (let index = 0; index < 8; index++) {
        key[index * 2] = HEX_DIGITS[digest[index] >> 4];
        key[index * 2 + 1] = HEX_DIGITS[digest[index] & 15];
      }
      if (verifiedFormat(key, requested)) { const result = key; key = undefined; return result; }
    } finally { key?.fill(0); for (const buffer of buffers) buffer.fill(0); }
  }
  return undefined;
}

interface ScanOptions {
  readonly accountName?: string;
  readonly timeoutMs?: number;
  readonly maxScannedBytes?: number;
  readonly maxCandidates?: number;
  readonly cancelled?: () => boolean;
  readonly now?: () => number;
  readonly yieldControl?: () => Promise<void>;
}

/** Returns an owned 16-byte key only after checking the requested file; caller must erase it. */
export async function scanWechatImageKey(
  open: (pid: number) => ReadableWechatProcess,
  pids: readonly number[],
  requested: WechatV2Probe,
  options: ScanOptions = {},
): Promise<Buffer | undefined> {
  if (!validProbe(requested)) return undefined;
  const now = options.now ?? Date.now;
  const pause = options.yieldControl ?? yieldTurn;
  const deadline = now() + bounded(options.timeoutMs, 30000, 20000);
  const byteLimit = bounded(options.maxScannedBytes, MAX_SCAN_BYTES, MAX_SCAN_BYTES);
  const candidateLimit = bounded(options.maxCandidates, MAX_CANDIDATES, MAX_CANDIDATES);
  const expired = (): boolean => options.cancelled?.() === true || now() >= deadline;
  const seen = new Set<string>();
  const configLocations = new Set<string>();
  const account = typeof options.accountName === 'string' && /^[a-zA-Z0-9_-]{1,128}$/u.test(options.accountName)
    ? Buffer.from(options.accountName) : undefined;
  let scanned = 0;
  let candidates = 0;
  try {
    await pause();
    for (const pid of [...new Set(pids)].filter((value) => Number.isInteger(value) && value > 0 && value <= 0xffffffff).slice(0, 8)) {
      if (expired() || scanned >= byteLimit || candidates >= candidateLimit) break;
      let reader: ReadableWechatProcess | undefined;
      try {
        reader = open(pid);
        for (const region of reader.regions()) {
          for (let offset = 0; offset < region.size; offset += CHUNK_BYTES) {
            if (expired() || scanned >= byteLimit || candidates >= candidateLimit) return undefined;
            // Overlap includes an entire UTF-16LE 32-character key and its delimiters.
            const length = Math.min(CHUNK_BYTES + 128, region.size - offset, byteLimit - scanned);
            const chunk = reader.read(region.address + offset, length);
            scanned += length;
            if (chunk) {
              try {
                if (account) {
                  for (let at = chunk.indexOf(CONFIG_LANDMARK); at >= 0 && configLocations.size < 32;
                    at = chunk.indexOf(CONFIG_LANDMARK, at + 1)) {
                    const address = region.address + offset + at;
                    const location = `${pid}:${address}`;
                    if (configLocations.has(location)) continue;
                    configLocations.add(location);
                    const key = configImageKey((target, count) => {
                      if (expired() || scanned + count > byteLimit) return null;
                      scanned += count;
                      return reader?.read(target, count) ?? null;
                    }, address, account, requested);
                    if (key) {
                      if (!expired()) return key;
                      key.fill(0); return undefined;
                    }
                  }
                }
                let examined = 0;
                for (let index = 0; index < chunk.length;) {
                  if (candidates >= candidateLimit || (index & 0x3fff) === 0 && expired()) return undefined;
                  if (!isAlnum(chunk[index])) { index += 1; continue; }
                  const start = index;
                  const width = chunk[index + 1] === 0 ? 2 : 1;
                  while (index < chunk.length && isAlnum(chunk[index]) && (width === 1 || chunk[index + 1] === 0)) index += width;
                  if (![16, 32].includes((index - start) / width)) continue;
                  if (expired()) return undefined;
                  const key = Buffer.alloc(16);
                  try {
                    for (let character = 0; character < 16; character += 1) key[character] = chunk[start + character * width];
                    const fingerprint = createHash('sha256').update(key).digest('hex');
                    if (!seen.has(fingerprint)) {
                      seen.add(fingerprint);
                      candidates += 1;
                      if (verifiedFormat(key, requested) && !expired()) return Buffer.from(key);
                    }
                  } finally { key.fill(0); }
                  examined += 1;
                  if (examined % 256 === 0) await pause();
                }
              } finally { chunk.fill(0); }
            }
            await pause();
          }
        }
      } catch { /* A vanished/inaccessible process must not hide other caller-approved WeChat PIDs. */ }
      finally { try { reader?.close(); } catch { /* No native error text leaves this module. */ } }
    }
    return undefined;
  } catch { return undefined; }
  finally { account?.fill(0); }
}

interface ProviderOptions {
  readonly accountName?: string;
  readonly open: (pid: number) => ReadableWechatProcess;
  readonly discoverProcessIds: () => Promise<readonly number[]>;
  readonly timeoutMs?: number;
  readonly cooldownMs?: number;
  readonly onReady?: () => void;
  readonly now?: () => number;
  readonly yieldControl?: () => Promise<void>;
}

/** One account worker owns one instance; no disk/network/cache-key serialization. */
export class WechatImageCryptoProvider {
  private readonly keys: { key: Buffer; xor?: number }[] = [];
  private inflight?: Promise<void>;
  private pending?: { requested: WechatV2Probe; thumbnails: WechatV2Probe[] };
  private cancelDiscovery?: () => void;
  private retryAt = 0;
  private disposed = false;

  constructor(private readonly options: ProviderOptions) {}

  /** Returns immediately; a cache miss only schedules a background scan after yielding. */
  decode(bytes: Buffer, thumbnailProbes: readonly WechatV2Probe[] = []): WechatImageDecodeResult {
    if (this.disposed) return { status: 'encrypted' };
    let requested = createWechatV2Probe(bytes);
    if (!requested) return { status: 'unsupported' };
    try {
      for (const cached of this.keys) {
        if (!verifiedFormat(cached.key, requested)) continue;
        cached.xor = thumbnailXor(cached.key, thumbnailProbes) ?? cached.xor;
        return decodeWechatV2Image(bytes, cached.key, cached.xor);
      }
      if (this.inflight) return { status: 'pending' };
      if ((this.options.now ?? Date.now)() < this.retryAt) return { status: 'encrypted' };
      const thumbnails = thumbnailProbes.slice(0, MAX_THUMBNAILS).filter(validProbe).map((probe) => ({
        plainLength: probe.plainLength, xorLength: probe.xorLength, fileLength: probe.fileLength,
        cipher: Buffer.from(probe.cipher), tail: Buffer.from(probe.tail),
      }));
      const material = { requested, thumbnails };
      this.pending = material;
      requested = undefined;
      this.inflight = this.prepare(material);
      return { status: 'pending' };
    } finally { if (requested) clearWechatV2Probe(requested); }
  }

  private async prepare(material: { requested: WechatV2Probe; thumbnails: WechatV2Probe[] }): Promise<void> {
    const now = this.options.now ?? Date.now;
    const timeout = bounded(this.options.timeoutMs, 30000, 20000);
    const deadline = now() + timeout;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let key: Buffer | undefined;
    let found = false;
    try {
      await (this.options.yieldControl ?? yieldTurn)();
      if (this.disposed || now() >= deadline) return;
      const stopped = new Promise<undefined>((resolve) => {
        this.cancelDiscovery = () => resolve(undefined);
        timer = setTimeout(() => resolve(undefined), Math.max(1, deadline - now()));
      });
      const pids = await Promise.race([this.options.discoverProcessIds(), stopped]);
      if (!pids || this.disposed || now() >= deadline) return;
      key = await scanWechatImageKey(this.options.open, pids, material.requested, {
        accountName: this.options.accountName,
        timeoutMs: deadline - now(), now, yieldControl: this.options.yieldControl,
        cancelled: () => this.disposed || now() >= deadline,
      });
      if (!key || this.disposed) return;
      this.keys.push({ key, xor: thumbnailXor(key, material.thumbnails) });
      key = undefined;
      while (this.keys.length > 4) this.keys.shift()?.key.fill(0);
      found = true;
    } catch { /* Fail closed without any process bytes, paths, or provider exception text. */ }
    finally {
      if (timer) clearTimeout(timer);
      this.cancelDiscovery = undefined;
      key?.fill(0);
      clearWechatV2Probe(material.requested);
      for (const probe of material.thumbnails) clearWechatV2Probe(probe);
      if (this.pending === material) this.pending = undefined;
      this.inflight = undefined;
      if (!found && !this.disposed) this.retryAt = now() + bounded(this.options.cooldownMs, 30000, 30000);
    }
    if (found && !this.disposed) {
      try { this.options.onReady?.(); } catch { /* A notification must not affect credential lifetime. */ }
    }
  }

  waitForIdle(): Promise<void> { return this.inflight ?? Promise.resolve(); }

  dispose(): void {
    this.disposed = true;
    this.cancelDiscovery?.();
    for (const cached of this.keys) { cached.key.fill(0); cached.xor = undefined; }
    this.keys.length = 0;
    if (this.pending) {
      clearWechatV2Probe(this.pending.requested);
      for (const probe of this.pending.thumbnails) clearWechatV2Probe(probe);
    }
  }
}
