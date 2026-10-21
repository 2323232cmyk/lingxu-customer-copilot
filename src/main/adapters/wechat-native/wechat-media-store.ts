import { createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { clearWechatV2Probe, createWechatV2Probe, type WechatImageCryptoProvider, type WechatV2Probe } from './wechat-image-crypto';

type QueryValue = string | number | Buffer | null;
interface MediaDatabase {
  readonly kind: string;
  readonly db: { query(sql: string, params: readonly QueryValue[]): readonly Record<string, QueryValue>[] };
}
type MediaKind = 'avatar' | 'image' | 'emoji';
type MimeType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
export interface NativeWechatMediaRef {
  readonly mediaKey: string;
  readonly kind: MediaKind;
  readonly status: 'pending' | 'ready' | 'encrypted' | 'missing' | 'unsupported';
  readonly mimeType?: MimeType;
  readonly byteLength?: number;
  readonly thumbnail?: boolean;
}
interface AvatarSource {
  readonly type: 'avatar';
  readonly database: MediaDatabase;
  readonly username: string;
  readonly md5: string | null;
  readonly updatedAt: string | number | null;
}
interface PendingSource { readonly type: 'pending'; readonly username: string; readonly kind: 'image' | 'emoji'; readonly md5: string }
interface FileInfo { readonly file: string; readonly byteLength: number; readonly mimeType?: MimeType; readonly encrypted: boolean }
interface FileCandidate extends FileInfo { readonly thumbnail: boolean }
interface FileSource { readonly type: 'file'; readonly lookup: PendingSource; readonly candidates: readonly FileCandidate[] }
type Entry = { readonly ref: NativeWechatMediaRef; readonly source?: AvatarSource | FileSource | PendingSource; retryAfter?: number };

export const MAX_NATIVE_MEDIA_BYTES = 12 * 1024 * 1024;
const MAX_AVATAR_BYTES = 1024 * 1024;
const MAX_REFERENCES = 4096;
const MAX_FILE_CANDIDATES = 12;
const MAX_RENDERED_MEDIA_BYTES = 8 * 1024 * 1024;
const RETRY_DELAY_MS = 1000;
const validUsername = (value: string): boolean => typeof value === 'string' && value.length > 0
  && value.length <= 512 && value.trim() === value && !value.includes('\0');
const within = (candidate: string, root: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative.length > 0 && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

function mimeOf(bytes: Buffer): MimeType | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return 'image/gif';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return undefined;
}

function mediaMd5(type: number, xml: string): string | undefined {
  if (!Number.isSafeInteger(type) || type < 0 || typeof xml !== 'string' || xml.length > 131_072
    || /<!DOCTYPE|<!ENTITY|\0/iu.test(xml)) return undefined;
  const tag = type % 65536 === 3 ? 'img' : type % 65536 === 47 ? 'emoji' : undefined;
  if (!tag) return undefined;
  const tags = [...xml.matchAll(new RegExp(`<${tag}\\b([^<>]*)>`, 'giu'))];
  if (tags.length !== 1) return undefined;
  // Only the named attribute in the expected message element is an image digest.
  // An arbitrary 32-hex value elsewhere can be an encryption key, not a filename.
  const attributes = tags[0][1];
  const attribute = /\s+([a-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/iy;
  let digest: string | undefined;
  let cursor = 0;
  for (let count = 0; count < 64; count += 1) {
    if (/^\s*\/?\s*$/u.test(attributes.slice(cursor))) return digest;
    attribute.lastIndex = cursor;
    const match = attribute.exec(attributes);
    if (!match) return undefined;
    cursor = attribute.lastIndex;
    if (match[1].toLowerCase() !== 'md5') continue;
    const value = match[2] ?? match[3];
    if (digest || !/^[a-f\d]{32}$/iu.test(value)) return undefined;
    digest = value.toLowerCase();
  }
  return undefined;
}

function imageCacheDigest(packed: Buffer): string | undefined {
  if (!Buffer.isBuffer(packed) || packed.length > 131_072) return undefined;
  const bytesFields = (bytes: Buffer): Map<number, Buffer[]> | undefined => {
    let cursor = 0;
    const fields = new Map<number, Buffer[]>();
    const integer = (): bigint => {
      let value = 0n;
      for (let shift = 0n; shift <= 63n; shift += 7n) {
        if (cursor >= bytes.length) throw new Error('Truncated protobuf');
        const byte = bytes[cursor++];
        if (shift === 63n && byte > 1) throw new Error('Oversized protobuf integer');
        value |= BigInt(byte & 0x7f) << shift;
        if (!(byte & 0x80)) return value;
      }
      throw new Error('Oversized protobuf integer');
    };
    try {
      for (let count = 0; cursor < bytes.length && count < 128; count += 1) {
        const tag = integer();
        if (tag < 8n || tag > 0xffffffffn) return undefined;
        const field = Number(tag >> 3n);
        const wire = Number(tag & 7n);
        if (wire === 0) integer();
        else if (wire === 1) cursor += 8;
        else if (wire === 5) cursor += 4;
        else if (wire === 2) {
          const length = integer();
          if (length > BigInt(bytes.length - cursor)) return undefined;
          const value = bytes.subarray(cursor, cursor + Number(length));
          const previous = fields.get(field) ?? [];
          previous.push(value);
          fields.set(field, previous);
          cursor += Number(length);
        } else return undefined;
        if (cursor > bytes.length) return undefined;
      }
      return cursor === bytes.length ? fields : undefined;
    } catch { return undefined; }
  };
  // Measured WeChat 4.1.9 image records: packed_info_data field 3 -> field 4 is
  // the local cache identifier (170/170 exact local matches), not XML's content MD5.
  const outer = bytesFields(packed)?.get(3);
  if (outer?.length !== 1) return undefined;
  const values = bytesFields(outer[0])?.get(4);
  if (values?.length !== 1 || values[0].length !== 32) return undefined;
  const digest = values[0].toString('utf8');
  return /^[a-f\d]{32}$/iu.test(digest) ? digest.toLowerCase() : undefined;
}

function messageDigest(type: number, xml: string, packedInfo?: Buffer): string | undefined {
  const digest = mediaMd5(type, xml);
  if (!digest) return undefined;
  return type % 65536 === 3 && packedInfo !== undefined ? imageCacheDigest(packedInfo) : digest;
}

/** Optional local media only. Never fetches contact URLs or closes caller-owned databases. */
export class NativeWechatMediaStore {
  private readonly secret = randomBytes(32);
  private readonly entries = new Map<string, Entry>();
  private readonly stickerKeys = new Map<string, Buffer>();
  private root?: Promise<string | undefined>;
  private disposed = false;

  constructor(private readonly options: {
    readonly databases: readonly MediaDatabase[];
    readonly accountRoot: string;
    /** Borrowed from the account worker; this store never owns or exposes provider credentials. */
    readonly imageDecoder?: Pick<WechatImageCryptoProvider, 'decode'>;
  }) {}

  private mediaKey(identity: readonly unknown[]): string {
    return `media_${createHmac('sha256', this.secret).update(JSON.stringify(identity)).digest('hex')}`;
  }

  private register(identity: readonly unknown[], ref: Omit<NativeWechatMediaRef, 'mediaKey'>, source?: Entry['source']): NativeWechatMediaRef | undefined {
    if (this.disposed) return undefined;
    const mediaKey = this.mediaKey(identity);
    const result = Object.freeze({ ...ref, mediaKey });
    const retryAfter = this.entries.get(mediaKey)?.retryAfter;
    this.entries.delete(mediaKey);
    this.entries.set(mediaKey, { ref: result, source, retryAfter });
    while (this.entries.size > MAX_REFERENCES) {
      const oldest = this.entries.keys().next().value;
      if (oldest) this.entries.delete(oldest);
    }
    return result;
  }

  getAvatar(username: string): NativeWechatMediaRef | undefined {
    if (this.disposed || !validUsername(username)) return undefined;
    for (const database of this.options.databases.filter((item) => item.kind === 'avatar')) {
      let header: Buffer | undefined;
      try {
        const row = database.db.query(
          'SELECT md5, update_time, length(image_buffer) AS byte_length, substr(image_buffer, 1, 12) AS header FROM head_image WHERE username = ? LIMIT 1',
          [username],
        )[0];
        if (!row) continue;
        header = Buffer.isBuffer(row.header) ? row.header : undefined;
        const byteLength = Number(row.byte_length);
        if (!header || !Number.isSafeInteger(byteLength) || byteLength < 1 || byteLength > MAX_AVATAR_BYTES
          || (row.md5 !== null && (typeof row.md5 !== 'string' || row.md5.length > 128))
          || !['string', 'number'].includes(typeof row.update_time) && row.update_time !== null) continue;
        const mimeType = mimeOf(header);
        return this.register(['avatar', username, row.md5, row.update_time, byteLength], {
          kind: 'avatar', status: mimeType ? 'ready' : 'unsupported', mimeType, byteLength,
        }, { type: 'avatar', database, username, md5: row.md5 as string | null, updatedAt: row.update_time as string | number | null });
      } catch { /* Missing/unsupported optional avatar data must not break message reads. */ }
      finally { header?.fill(0); }
    }
    return undefined;
  }

  /** Cheap synchronous registration for message normalization: no filesystem or database reads. */
  registerMessageMedia(username: string, type: number, decodedXml: string, packedInfo?: Buffer): NativeWechatMediaRef | undefined {
    if (this.disposed || !validUsername(username)) return undefined;
    const md5 = messageDigest(type, decodedXml, packedInfo);
    if (!md5) return undefined;
    const kind = type % 65536 === 3 ? 'image' : 'emoji';
    if (kind === 'emoji') {
      const attributes = decodedXml.match(/<emoji\b([^<>]*)>/iu)?.[1] ?? '';
      const matches = [...attributes.matchAll(/\saeskey\s*=\s*(?:"([a-f\d]{32})"|'([a-f\d]{32})')/giu)];
      if (matches.length === 1) {
        const identity = this.mediaKey([kind, username, md5]);
        this.stickerKeys.get(identity)?.fill(0);
        this.stickerKeys.set(identity, Buffer.from(matches[0][1] || matches[0][2], 'hex'));
        if (this.stickerKeys.size > MAX_REFERENCES) {
          const oldest = this.stickerKeys.keys().next().value as string;
          this.stickerKeys.get(oldest)?.fill(0); this.stickerKeys.delete(oldest);
        }
      }
    }
    const existing = this.entries.get(this.mediaKey([kind, username, md5]));
    return existing?.ref ?? this.register([kind, username, md5], { kind, status: 'pending' },
      { type: 'pending', username, kind, md5 });
  }

  getMediaRef(mediaKey: string): NativeWechatMediaRef | undefined {
    return this.disposed ? undefined : this.entries.get(mediaKey)?.ref;
  }

  private accountRoot(): Promise<string | undefined> {
    this.root ??= path.isAbsolute(this.options.accountRoot)
      ? realpath(this.options.accountRoot).catch(() => undefined) : Promise.resolve(undefined);
    return this.root;
  }

  private async safePath(candidate: string): Promise<string | undefined> {
    const root = await this.accountRoot();
    if (!root || !within(candidate, root)) return undefined;
    const canonical = await realpath(candidate).catch(() => undefined);
    return canonical && within(canonical, root) ? canonical : undefined;
  }

  private async directories(parent: string, limit: number, pattern?: RegExp): Promise<string[]> {
    const canonical = await this.safePath(parent);
    if (!canonical) return [];
    const entries = await readdir(canonical, { withFileTypes: true }).catch(() => []);
    return entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && (!pattern || pattern.test(entry.name)))
      .map((entry) => entry.name).sort().reverse().slice(0, limit).map((name) => path.join(canonical, name));
  }

  private async fileInfo(file: string): Promise<FileInfo | undefined> {
    const canonical = await this.safePath(file);
    if (!canonical) return undefined;
    const handle = await open(canonical, 'r').catch(() => undefined);
    if (!handle) return undefined;
    const header = Buffer.alloc(16);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size < 1 || stat.size > MAX_NATIVE_MEDIA_BYTES) return undefined;
      const { bytesRead } = await handle.read(header, 0, Math.min(header.length, stat.size), 0);
      const prefix = header.subarray(0, bytesRead);
      return { file: canonical, byteLength: stat.size, mimeType: mimeOf(prefix),
        encrypted: prefix.length >= 6 && prefix.subarray(0, 6).equals(Buffer.from([7, 8, 86, 50, 8, 7])) };
    } catch { return undefined; }
    finally { header.fill(0); await handle.close().catch(() => undefined); }
  }

  async getMessageMedia(username: string, type: number, decodedXml: string, packedInfo?: Buffer): Promise<NativeWechatMediaRef | undefined> {
    if (this.disposed || !validUsername(username)) return undefined;
    const md5 = messageDigest(type, decodedXml, packedInfo);
    if (!md5) return undefined;
    this.registerMessageMedia(username, type, decodedXml, packedInfo);
    const kind = type % 65536 === 3 ? 'image' : 'emoji';
    return this.resolveMessageMedia(username, kind, md5);
  }

  private async resolveMessageMedia(username: string, kind: 'image' | 'emoji', md5: string): Promise<NativeWechatMediaRef | undefined> {
    const root = await this.accountRoot();
    const candidates: { file: string; thumbnail: boolean }[] = [];
    if (root && kind === 'image') {
      const chatHash = createHash('md5').update(username).digest('hex');
      for (const month of await this.directories(path.join(root, 'msg', 'attach', chatHash), 120, /^20\d{2}-(?:0[1-9]|1[0-2])$/u)) {
        for (const suffix of ['.dat', '_h.dat', '_t.dat']) {
          candidates.push({ file: path.join(month, 'Img', `${md5}${suffix}`), thumbnail: suffix === '_t.dat' });
        }
      }
    } else if (root) {
      for (const owner of await this.directories(path.join(root, 'cache'), 8)) {
        candidates.push({ file: path.join(owner, 'Emoticon', md5.slice(0, 2), md5), thumbnail: false });
      }
    }
    const files: FileCandidate[] = [];
    for (const candidate of candidates) {
      if (this.disposed) return undefined;
      const info = await this.fileInfo(candidate.file);
      if (!info) continue;
      files.push(Object.freeze({ ...info, thumbnail: candidate.thumbnail }));
      if (files.length >= MAX_FILE_CANDIDATES
        || info.mimeType && info.byteLength <= MAX_RENDERED_MEDIA_BYTES && !candidate.thumbnail) break;
    }
    const readable = (file: FileCandidate): boolean => Boolean(file.mimeType) && file.byteLength <= MAX_RENDERED_MEDIA_BYTES;
    const preferred = (this.options.imageDecoder
      ? files.find((file) => !file.thumbnail && (readable(file) || file.encrypted)) : undefined)
      ?? files.find(readable) ?? files.find((file) => file.encrypted) ?? files[0];
    const lookup: PendingSource = { type: 'pending', username, kind, md5 };
    return this.register([kind, username, md5], {
      kind, status: preferred ? readable(preferred) ? 'ready' : preferred.encrypted ? 'encrypted' : 'unsupported' : 'missing',
      ...(preferred ? { byteLength: preferred.byteLength, thumbnail: preferred.thumbnail,
        ...(readable(preferred) ? { mimeType: preferred.mimeType } : {}) } : {}),
    }, files.length ? { type: 'file', lookup, candidates: Object.freeze(files) } : lookup);
  }

  private async readFileBytes(source: FileCandidate): Promise<Buffer | undefined> {
    let bytes: Buffer | undefined;
    try {
      const file = await this.safePath(source.file);
      if (!file || this.disposed) return undefined;
      const handle = await open(file, 'r');
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size < 1 || stat.size > MAX_NATIVE_MEDIA_BYTES || stat.size !== source.byteLength) return undefined;
        bytes = Buffer.alloc(stat.size);
        let offset = 0;
        while (offset < bytes.length) {
          const read = await handle.read(bytes, offset, bytes.length - offset, offset);
          if (!read.bytesRead) return undefined;
          offset += read.bytesRead;
        }
        if (this.disposed) return undefined;
        const result = bytes;
        bytes = undefined;
        return result;
      } finally { await handle.close().catch(() => undefined); }
    } catch { return undefined; }
    finally { bytes?.fill(0); }
  }

  private async thumbnailProbes(source: FileSource): Promise<WechatV2Probe[]> {
    const probes: WechatV2Probe[] = [];
    for (const candidate of source.candidates.filter((file) => file.thumbnail && file.encrypted).slice(0, 2)) {
      const bytes = await this.readFileBytes(candidate);
      try {
        const probe = bytes && createWechatV2Probe(bytes);
        if (probe) probes.push(probe);
      } finally { bytes?.fill(0); }
    }
    return probes;
  }

  private async readFileMedia(mediaKey: string, entry: Entry, source: FileSource): Promise<{ mimeType: MimeType; bytes: Buffer } | undefined> {
    let probes: WechatV2Probe[] | undefined;
    let failure: NativeWechatMediaRef['status'] = 'missing';
    let failedFile: FileCandidate | undefined;
    const failed = (status: 'pending' | 'encrypted' | 'unsupported', file: FileCandidate): void => {
      if (failure === 'missing' || status === 'pending' || status === 'encrypted' && failure !== 'pending') {
        failure = status; failedFile = file;
      }
    };
    try {
      // Try supported full images before any thumbnail, even when the original is V2 encrypted.
      const candidates = [...source.candidates].sort((left, right) => Number(left.thumbnail) - Number(right.thumbnail));
      for (const file of candidates) {
        let input: Buffer | undefined;
        let output: Buffer | undefined;
        try {
          if (this.disposed || this.entries.get(mediaKey) !== entry) return undefined;
          input = await this.readFileBytes(file);
          if (!input || this.disposed) continue;
          if (source.lookup.kind === 'emoji' && !file.mimeType) {
            const key = this.stickerKeys.get(mediaKey);
            if (!key) { failed('unsupported', file); continue; }
            // Accept only bytes whose digest is the exact registered emoji MD5.
            // Keys stay inside this worker and are never inferred from other messages.
            for (const iv of [null, Buffer.alloc(16), key]) {
              let candidate: Buffer | undefined;
              try {
                const decipher = createDecipheriv(iv === null ? 'aes-128-ecb' : 'aes-128-cbc', key, iv);
                candidate = Buffer.concat([decipher.update(input), decipher.final()]);
                if (mimeOf(candidate) && createHash('md5').update(candidate).digest('hex') === source.lookup.md5) {
                  output = candidate; candidate = undefined; break;
                }
              } catch { /* Unsupported cache variants remain unavailable. */ }
              finally { candidate?.fill(0); }
            }
            if (!output) { failed('unsupported', file); continue; }
          } else if (file.encrypted) {
            if (!this.options.imageDecoder) { failed('encrypted', file); continue; }
            probes ??= await this.thumbnailProbes(source);
            if (this.disposed || this.entries.get(mediaKey) !== entry) return undefined;
            const decoded = this.options.imageDecoder.decode(input, probes);
            if (decoded.status !== 'ready') { failed(decoded.status, file); continue; }
            output = Buffer.isBuffer(decoded.bytes) ? decoded.bytes : undefined;
            if (!output || mimeOf(output) !== decoded.mimeType) { failed('unsupported', file); continue; }
          } else {
            output = input; input = undefined;
            if (mimeOf(output) !== file.mimeType) { failed('unsupported', file); continue; }
          }
          const mimeType = mimeOf(output);
          if (!output.length || output.length > MAX_RENDERED_MEDIA_BYTES || !mimeType) { failed('unsupported', file); continue; }
          if (this.disposed || this.entries.get(mediaKey) !== entry) return undefined;
          const { username, kind, md5 } = source.lookup;
          const ref = this.register([kind, username, md5], {
            kind, status: 'ready', mimeType, byteLength: output.length, thumbnail: file.thumbnail,
          }, source);
          if (!ref) return undefined;
          const current = this.entries.get(mediaKey);
          if (current) current.retryAfter = undefined;
          const bytes = output; output = undefined;
          return { mimeType, bytes };
        } catch { failed(file.encrypted ? 'encrypted' : 'unsupported', file); }
        finally { input?.fill(0); output?.fill(0); }
      }
      if (!this.disposed && this.entries.get(mediaKey) === entry) {
        const { username, kind, md5 } = source.lookup;
        this.register([kind, username, md5], {
          kind, status: failure,
          ...(failedFile ? { byteLength: failedFile.byteLength, thumbnail: failedFile.thumbnail } : {}),
        }, source);
        const current = this.entries.get(mediaKey);
        if (current) current.retryAfter = Date.now() + RETRY_DELAY_MS;
      }
      return undefined;
    } finally { for (const probe of probes ?? []) clearWechatV2Probe(probe); }
  }

  /** Worker-only bytes. Caller must clear the returned buffer after its bounded transfer. */
  async readMedia(mediaKey: string): Promise<{ mimeType: MimeType; bytes: Buffer } | undefined> {
    let entry = this.entries.get(mediaKey);
    if (this.disposed || !entry?.source) return undefined;
    if (entry.source.type !== 'avatar') {
      if ((entry.retryAfter ?? 0) > Date.now()) return undefined;
      entry.retryAfter = Date.now() + RETRY_DELAY_MS;
      if (entry.source.type === 'pending' || entry.ref.status !== 'ready') {
        const { username, kind, md5 } = entry.source.type === 'pending' ? entry.source : entry.source.lookup;
        await this.resolveMessageMedia(username, kind, md5);
        entry = this.entries.get(mediaKey);
      }
      if (this.disposed || entry?.source?.type !== 'file') return undefined;
      return this.readFileMedia(mediaKey, entry, entry.source);
    }
    if (entry.ref.status !== 'ready') return undefined;
    let bytes: Buffer | undefined;
    try {
      if (entry.source.type === 'avatar') {
        const { database, username, md5, updatedAt } = entry.source;
        const row = database.db.query(
          'SELECT image_buffer FROM head_image WHERE username = ? AND md5 IS ? AND update_time IS ? AND length(image_buffer) BETWEEN 1 AND ? LIMIT 1',
          [username, md5, updatedAt, MAX_AVATAR_BYTES],
        )[0];
        bytes = Buffer.isBuffer(row?.image_buffer) ? row.image_buffer : undefined;
      }
      const mimeType = bytes && mimeOf(bytes);
      if (!this.disposed && bytes && bytes.length === entry.ref.byteLength && bytes.length <= MAX_NATIVE_MEDIA_BYTES
        && mimeType && mimeType === entry.ref.mimeType) return { mimeType, bytes };
    } catch { /* Never surface local paths, query contents, or media data in exceptions. */ }
    bytes?.fill(0);
    return undefined;
  }

  dispose(): void {
    this.disposed = true;
    this.entries.clear();
    for (const key of this.stickerKeys.values()) key.fill(0);
    this.stickerKeys.clear();
    this.secret.fill(0);
  }
}
