import { createCipheriv, createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_NATIVE_MEDIA_BYTES, NativeWechatMediaStore } from './wechat-media-store';
import { decodeWechatV2Image, type WechatImageCryptoProvider } from './wechat-image-crypto';
import { MEDIA_MAX_BYTES, NativeMediaTransfer } from './native-media-transfer';

const roots: string[] = [];
const stores: NativeWechatMediaStore[] = [];
const username = 'synthetic-contact';
const md5 = 'a1'.repeat(16);
const otherMd5 = 'b2'.repeat(16);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Array(24).fill(0x31), 0xff, 0xd9]);
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, ...Array(24).fill(0x32)]);
const gif = Buffer.from('GIF89aSyntheticLocalEmoji');
const webp = Buffer.from('RIFF0000WEBPSyntheticRaster');
const v2 = Buffer.from([7, 8, 86, 50, 8, 7, ...Array(40).fill(0x91)]);
const syntheticImageKey = Buffer.from('0123456789abcdef', 'ascii');
const syntheticXor = 0x5a;
const encryptedImage = (image: Buffer): Buffer => {
  const head = image.subarray(0, Math.min(20, image.length - 2));
  const header = Buffer.alloc(15);
  v2.copy(header, 0, 0, 6);
  header.writeUInt32LE(head.length, 6);
  header.writeUInt32LE(2, 10);
  const cipher = createCipheriv('aes-128-ecb', syntheticImageKey, null);
  return Buffer.concat([header, cipher.update(head), cipher.final(), image.subarray(head.length, -2),
    Buffer.from(image.subarray(-2).map((byte) => byte ^ syntheticXor))]);
};
const decoderFixture = () => ({
  decode: vi.fn<WechatImageCryptoProvider['decode']>((bytes) => decodeWechatV2Image(bytes, syntheticImageKey, syntheticXor)),
});
const xml = (type = 'img', digest = md5) => `<msg><${type} md5="${digest}" /></msg>`;
const packedImage = (digest: string, outerTag = 3, innerTag = 4): Buffer => Buffer.concat([
  Buffer.from([outerTag * 8 + 2, 34, innerTag * 8 + 2, 32]), Buffer.from(digest, 'ascii'),
]);

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  stores.splice(0).forEach((store) => store.dispose());
  for (const root of roots.splice(0)) {
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('copilot-media-fixture-')) {
      throw new Error('Refusing to remove an unexpected fixture directory');
    }
    await rm(root, { recursive: true, force: true });
  }
});

function store(options: ConstructorParameters<typeof NativeWechatMediaStore>[0]) {
  const instance = new NativeWechatMediaStore(options);
  stores.push(instance);
  return instance;
}

async function fixture(imageDecoder?: ConstructorParameters<typeof NativeWechatMediaStore>[0]['imageDecoder']) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'copilot-media-fixture-'));
  roots.push(root);
  const accountRoot = path.join(root, 'synthetic account');
  await mkdir(accountRoot);
  return { accountRoot, media: store({ accountRoot, databases: [], imageDecoder }) };
}

async function imageFile(root: string, content: Buffer, suffix = '.dat', digest = md5) {
  const chatHash = createHash('md5').update(username).digest('hex');
  const directory = path.join(root, 'msg', 'attach', chatHash, '2026-08', 'Img');
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `${digest}${suffix}`);
  await writeFile(file, content);
  return file;
}

function avatarFixture(image = jpeg) {
  const headers: Buffer[] = [];
  const blobs: Buffer[] = [];
  const query = vi.fn((sql: string, params: readonly unknown[]): Record<string, string | number | Buffer | null>[] => {
    if (params[0] !== username) return [];
    if (sql.startsWith('SELECT image_buffer')) {
      const bytes = Buffer.from(image);
      blobs.push(bytes);
      return [{ image_buffer: bytes }];
    }
    const header = Buffer.from(image.subarray(0, 12));
    headers.push(header);
    return [{ md5, update_time: '1788134400', byte_length: String(image.length), header }];
  });
  const media = store({ databases: [{ kind: 'avatar', db: { query } }], accountRoot: path.resolve('synthetic-not-opened') });
  return { media, query, headers, blobs };
}

describe('local avatar BLOBs', () => {
  it.each([['image/jpeg', jpeg], ['image/png', png], ['image/gif', gif], ['image/webp', webp]] as const)(
    'returns an opaque reference and worker-only %s bytes', async (mimeType, image) => {
      const { media, query, headers } = avatarFixture(image);
      const ref = media.getAvatar(username);
      expect(ref).toMatchObject({ kind: 'avatar', status: 'ready', mimeType, byteLength: image.length });
      expect(ref?.mediaKey).toMatch(/^media_[a-f0-9]{64}$/u);
      expect(JSON.stringify(ref)).not.toContain(username);
      expect(JSON.stringify(ref)).not.toContain(md5);
      expect(headers.every((header) => header.every((byte) => byte === 0))).toBe(true);
      expect(query).toHaveBeenCalledTimes(1);
      expect(query.mock.calls[0][0]).not.toContain(username);
      expect(query.mock.calls[0][1]).toEqual([username]);
      const result = await media.readMedia(ref?.mediaKey ?? '');
      expect(result).toEqual({ mimeType, bytes: image });
      expect(query.mock.calls[1][1]).toEqual([username, md5, '1788134400', 1024 * 1024]);
      result?.bytes.fill(0);
    },
  );

  it('does not query other optional databases or fetch a contact avatar URL', () => {
    const query = vi.fn(() => { throw new Error('Must not query credential or URL columns'); });
    const media = store({ accountRoot: '', databases: [{ kind: 'contact', db: { query } }, { kind: 'emoji', db: { query } }] });
    expect(media.getAvatar(username)).toBeUndefined();
    expect(query).not.toHaveBeenCalled();
  });

  it('handles unknown contacts, malformed metadata, and optional schema errors without exposing them', () => {
    const { media, query } = avatarFixture();
    expect(media.getAvatar('unknown')).toBeUndefined();
    query.mockImplementationOnce(() => { throw new Error('SECRET_SQL_AND_ACCOUNT_PATH'); });
    expect(media.getAvatar(username)).toBeUndefined();
    for (const byteLength of ['0', '-1', 'NaN', String(1024 * 1024 + 1)]) {
      query.mockReturnValueOnce([{ md5, update_time: '1', byte_length: byteLength, header: Buffer.from(jpeg) }]);
      expect(media.getAvatar(username)).toBeUndefined();
    }
  });

  it('does not guess a raster format for SVG, HTML, or an opaque BLOB', async () => {
    const { media } = avatarFixture(Buffer.from('<svg onload="unsafe()"></svg>'));
    const ref = media.getAvatar(username);
    expect(ref?.status).toBe('unsupported');
    expect(await media.readMedia(ref?.mediaKey ?? '')).toBeUndefined();
  });

  it('rejects stale/corrupt returned bytes and wipes rejected buffers', async () => {
    const { media, query, blobs } = avatarFixture();
    const ref = media.getAvatar(username);
    const corrupt = Buffer.alloc(jpeg.length, 0x41);
    query.mockReturnValueOnce([{ image_buffer: corrupt }]);
    expect(await media.readMedia(ref?.mediaKey ?? '')).toBeUndefined();
    expect(corrupt).toEqual(Buffer.alloc(jpeg.length));
    query.mockReturnValueOnce([]);
    expect(await media.readMedia(ref?.mediaKey ?? '')).toBeUndefined();
    expect(blobs).toHaveLength(0);
  });

  it('does not share capability keys across stores and invalidates them on dispose', async () => {
    const first = avatarFixture().media;
    const second = avatarFixture().media;
    const ref = first.getAvatar(username);
    expect(first.getAvatar(username)?.mediaKey).toBe(ref?.mediaKey);
    expect(second.getAvatar(username)?.mediaKey).not.toBe(ref?.mediaKey);
    expect(await second.readMedia(ref?.mediaKey ?? '')).toBeUndefined();
    first.dispose();
    expect(first.getAvatar(username)).toBeUndefined();
    expect(await first.readMedia(ref?.mediaKey ?? '')).toBeUndefined();
  });
});

describe('local image and emoji matching', () => {
  it.each(['aes-128-ecb', 'aes-128-cbc'])('decodes a local %s sticker only with its message key and exact digest', async (algorithm) => {
    const { accountRoot, media } = await fixture();
    const digest = createHash('md5').update(gif).digest('hex');
    const key = Buffer.alloc(16, 7);
    const cipher = createCipheriv(algorithm, key, algorithm.endsWith('ecb') ? null : Buffer.alloc(16));
    const encrypted = Buffer.concat([cipher.update(gif), cipher.final()]);
    const directory = path.join(accountRoot, 'cache', '2026-09', 'Emoticon', digest.slice(0, 2));
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, digest), encrypted);
    const ref = media.registerMessageMedia(username, 47, `<emoji md5="${digest}" aeskey="${key.toString('hex')}" />`);
    expect((await media.readMedia(ref?.mediaKey ?? ''))?.bytes).toEqual(gif);
    expect(JSON.stringify(ref)).not.toContain(key.toString('hex'));
    const wrong = media.registerMessageMedia('another-peer', 47, `<emoji md5="${digest}" aeskey="${'09'.repeat(16)}" />`);
    expect(await media.readMedia(wrong?.mediaKey ?? '')).toBeUndefined();
  });
  it('uses only the verified packed field 3 -> 4 for local image filenames, not XML content MD5', async () => {
    const { accountRoot, media } = await fixture();
    await imageFile(accountRoot, jpeg);
    const packed = packedImage(md5);
    const before = Buffer.from(packed);
    const ref = media.registerMessageMedia(username, 3, xml('img', otherMd5), packed);
    packed.fill(0); // The lazy source owns the parsed identifier, never the input BLOB.
    expect(ref?.status).toBe('pending');
    expect((await media.readMedia(ref?.mediaKey ?? ''))?.bytes).toEqual(jpeg);
    const direct = await media.getMessageMedia(username, 3, xml('img', otherMd5), before);
    expect(direct?.mediaKey).toBe(ref?.mediaKey);
    expect(before).toEqual(packedImage(md5));
  });

  it.each([
    packedImage(md5, 2, 4),
    packedImage(md5, 3, 5),
    Buffer.concat([packedImage(md5), packedImage(otherMd5)]),
    Buffer.concat([Buffer.from([26, 68]), packedImage(md5).subarray(2), packedImage(otherMd5).subarray(2)]),
    packedImage(md5).subarray(0, -1),
    Buffer.concat([Buffer.from([26, 34, 34, 32]), Buffer.alloc(32, 0xe1)]),
    Buffer.from([26, 0xff]),
    Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f]),
    Buffer.from(md5, 'ascii'),
    Buffer.alloc(131_073),
  ])('does not guess a cache ID from malformed, duplicate, or differently tagged protobuf (case %#)', async (packed) => {
    const { media } = await fixture();
    expect(media.registerMessageMedia(username, 3, xml(), packed)).toBeUndefined();
    expect(await media.getMessageMedia(username, 3, xml(), packed)).toBeUndefined();
  });

  it('ignores unrelated well-formed protobuf fields and their tempting 32-hex values', async () => {
    const { accountRoot, media } = await fixture();
    await imageFile(accountRoot, jpeg);
    await imageFile(accountRoot, png, '.dat', otherMd5);
    const packed = Buffer.concat([Buffer.from([8, 1, 74, 32]), Buffer.from(otherMd5, 'ascii'), packedImage(md5)]);
    const ref = await media.getMessageMedia(username, 3, xml('img', otherMd5), packed);
    expect(ref?.mimeType).toBe('image/jpeg');
  });

  it('registers synchronously without resolving a file, then loads it on the first byte request', async () => {
    const { accountRoot, media } = await fixture();
    const pending = media.registerMessageMedia(username, 3, xml());
    expect(pending).toMatchObject({ status: 'pending', kind: 'image' });
    expect(pending?.byteLength).toBeUndefined();
    await imageFile(accountRoot, jpeg);
    expect((await media.readMedia(pending?.mediaKey ?? ''))?.bytes).toEqual(jpeg);
    const ready = media.getMediaRef(pending?.mediaKey ?? '');
    expect(ready).toMatchObject({ status: 'ready', mediaKey: pending?.mediaKey });
    expect(media.registerMessageMedia(username, 3, xml())).toBe(ready);
  });

  it('makes an encrypted lazy result observable without exposing bytes', async () => {
    const { accountRoot, media } = await fixture();
    await imageFile(accountRoot, v2);
    const pending = media.registerMessageMedia(username, 3, xml());
    expect(await media.readMedia(pending?.mediaKey ?? '')).toBeUndefined();
    expect(media.getMediaRef(pending?.mediaKey ?? '')?.status).toBe('encrypted');
    media.dispose();
    expect(media.getMediaRef(pending?.mediaKey ?? '')).toBeUndefined();
    expect(media.registerMessageMedia(username, 3, xml())).toBeUndefined();
  });

  it('reads only the exact selected-contact digest file and preserves its bytes', async () => {
    const { accountRoot, media } = await fixture();
    const file = await imageFile(accountRoot, jpeg);
    await imageFile(accountRoot, png, '.dat', otherMd5);
    const ref = await media.getMessageMedia(username, 65536 + 3, xml());
    expect(ref).toMatchObject({ kind: 'image', status: 'ready', mimeType: 'image/jpeg', thumbnail: false });
    expect(JSON.stringify(ref)).not.toContain(accountRoot);
    expect(JSON.stringify(ref)).not.toContain(md5);
    expect(await media.readMedia(ref?.mediaKey ?? '')).toEqual({ mimeType: 'image/jpeg', bytes: jpeg });
    expect(await readFile(file)).toEqual(jpeg);
    expect(await media.getMessageMedia('different-contact', 3, xml())).toMatchObject({ status: 'missing' });
  });

  it('keeps the independently encrypted V2 DAT unavailable, never using a database key', async () => {
    const { accountRoot, media } = await fixture();
    await imageFile(accountRoot, v2);
    const ref = await media.getMessageMedia(username, 3, xml());
    expect(ref).toMatchObject({ kind: 'image', status: 'encrypted', byteLength: v2.length });
    expect(ref?.mimeType).toBeUndefined();
    expect(await media.readMedia(ref?.mediaKey ?? '')).toBeUndefined();
  });

  it('uses a real readable thumbnail when the larger image is still encrypted', async () => {
    const { accountRoot, media } = await fixture();
    await imageFile(accountRoot, v2);
    await imageFile(accountRoot, png, '_t.dat');
    const ref = await media.getMessageMedia(username, 3, xml());
    expect(ref).toMatchObject({ status: 'ready', mimeType: 'image/png', thumbnail: true });
    expect((await media.readMedia(ref?.mediaKey ?? ''))?.bytes).toEqual(png);
  });

  it('recognizes the measured two-hex cache buckets without broad file searches', async () => {
    const { accountRoot, media } = await fixture();
    const directory = path.join(accountRoot, 'cache', 'synthetic-owner', 'Emoticon', md5.slice(0, 2));
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, md5), gif);
    const ref = await media.getMessageMedia(username, 47, xml('emoji'));
    expect(ref).toMatchObject({ kind: 'emoji', status: 'ready', mimeType: 'image/gif' });
    expect((await media.readMedia(ref?.mediaKey ?? ''))?.bytes).toEqual(gif);
  });

  it('reports an opaque cache file as unsupported, not as a successfully decrypted emoji', async () => {
    const { accountRoot, media } = await fixture();
    const directory = path.join(accountRoot, 'cache', 'synthetic-owner', 'Emoticon', md5.slice(0, 2));
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, md5), Buffer.alloc(64, 0x93));
    expect(await media.getMessageMedia(username, 47, xml('emoji'))).toMatchObject({ kind: 'emoji', status: 'unsupported' });
  });

  it('can recheck an uncached reference after a local file becomes available', async () => {
    const { accountRoot, media } = await fixture();
    const missing = await media.getMessageMedia(username, 3, xml());
    expect(missing?.status).toBe('missing');
    await imageFile(accountRoot, jpeg);
    const ready = await media.getMessageMedia(username, 3, xml());
    expect(ready?.mediaKey).toBe(missing?.mediaKey);
    expect(ready?.status).toBe('ready');
  });

  it.each([
    '<msg aeskey="' + md5 + '"><img /></msg>',
    '<img cdnurl="https://example.invalid/' + md5 + '" />',
    '<img title=" md5=\'' + md5 + '\'" />',
    '<emoji md5="' + md5 + '" />',
    '<img md5="' + md5 + '" md5="' + otherMd5 + '"/>',
    '<img md5="' + md5 + '"/><img md5="' + otherMd5 + '"/>',
    '<!DOCTYPE msg [<!ENTITY x SYSTEM "file:///private">]><img md5="' + md5 + '"/>',
    '<img md5="../../private"/>',
    '<img md5="' + md5 + '"/>' + ' '.repeat(131_073),
  ])('rejects non-digest or ambiguous image XML without searching local files (case %#)', async (content) => {
    const media = store({ accountRoot: '', databases: [] });
    expect(await media.getMessageMedia(username, 3, content)).toBeUndefined();
  });

  it('does not interpret another message type, invalid usernames, or forged keys as media capabilities', async () => {
    const { media } = await fixture();
    expect(await media.getMessageMedia(username, 49, xml())).toBeUndefined();
    expect(await media.getMessageMedia('bad\0contact', 3, xml())).toBeUndefined();
    expect(await media.readMedia(path.resolve('private.png'))).toBeUndefined();
  });

  it('does not follow an attachment junction outside the selected account', async () => {
    const { accountRoot, media } = await fixture();
    const other = path.join(roots[0], 'another-account');
    await imageFile(other, jpeg);
    await symlink(path.join(other, 'msg'), path.join(accountRoot, 'msg'), 'junction');
    expect(await media.getMessageMedia(username, 3, xml())).toMatchObject({ status: 'missing' });
  });

  it('rechecks source size and format at read time and refuses oversized local files', async () => {
    const { accountRoot, media } = await fixture();
    const file = await imageFile(accountRoot, jpeg);
    const ref = await media.getMessageMedia(username, 3, xml());
    await writeFile(file, Buffer.alloc(jpeg.length, 0x41));
    expect(await media.readMedia(ref?.mediaKey ?? '')).toBeUndefined();
    await writeFile(file, Buffer.concat([jpeg, Buffer.alloc(1)]));
    expect(await media.readMedia(ref?.mediaKey ?? '')).toBeUndefined();
    await writeFile(file, Buffer.alloc(MAX_NATIVE_MEDIA_BYTES + 1));
    expect(await media.getMessageMedia(username, 3, xml())).toMatchObject({ status: 'missing' });
  });

  it('stops local media reads after disposal', async () => {
    const { accountRoot, media } = await fixture();
    await imageFile(accountRoot, jpeg);
    const ref = await media.getMessageMedia(username, 3, xml());
    media.dispose();
    expect(await media.getMessageMedia(username, 3, xml())).toBeUndefined();
    expect(await media.readMedia(ref?.mediaKey ?? '')).toBeUndefined();
  });
});

describe('lazy V2 media decoding with synthetic data only', () => {
  it('does not decrypt during registration and prefers a supported original over its readable thumbnail', async () => {
    const decoder = decoderFixture();
    const { accountRoot, media } = await fixture(decoder);
    const encrypted = encryptedImage(png);
    const file = await imageFile(accountRoot, encrypted);
    const thumbnailFile = await imageFile(accountRoot, jpeg, '_t.dat');
    const ref = await media.getMessageMedia(username, 3, xml());
    expect(ref).toMatchObject({ status: 'encrypted', byteLength: encrypted.length, thumbnail: false });
    expect(decoder.decode).not.toHaveBeenCalled();
    const result = await media.readMedia(ref?.mediaKey ?? '');
    expect(result).toEqual({ mimeType: 'image/png', bytes: png });
    expect(media.getMediaRef(ref?.mediaKey ?? '')).toMatchObject({
      mediaKey: ref?.mediaKey, status: 'ready', mimeType: 'image/png', byteLength: png.length, thumbnail: false,
    });
    expect(ref?.byteLength).toBe(encrypted.length);
    expect(Object.isFrozen(ref)).toBe(true);
    expect(decoder.decode.mock.calls[0][0].every((byte) => byte === 0)).toBe(true);
    expect(await readFile(file)).toEqual(encrypted);
    expect(await readFile(thumbnailFile)).toEqual(jpeg);
    expect(JSON.stringify(media.getMediaRef(ref?.mediaKey ?? ''))).not.toMatch(/synthetic|\.dat|cipher|accountRoot|0123456789abcdef/);
    result?.bytes.fill(0);
  });

  it('falls back from a V2 wxgf original to the same image encrypted JPEG thumbnail and erases probe buffers', async () => {
    const decoder = decoderFixture();
    const { accountRoot, media } = await fixture(decoder);
    const original = encryptedImage(Buffer.from('wxgfSyntheticUnsupportedOriginalContainer'));
    const thumbnail = encryptedImage(jpeg);
    const file = await imageFile(accountRoot, original);
    const thumbnailFile = await imageFile(accountRoot, thumbnail, '_t.dat');
    const pending = media.registerMessageMedia(username, 3, xml());
    const result = await media.readMedia(pending?.mediaKey ?? '');
    expect(result).toEqual({ mimeType: 'image/jpeg', bytes: jpeg });
    expect(media.getMediaRef(pending?.mediaKey ?? '')).toMatchObject({
      status: 'ready', mimeType: 'image/jpeg', byteLength: jpeg.length, thumbnail: true,
    });
    expect(decoder.decode).toHaveBeenCalledTimes(2);
    for (const [input, probes] of decoder.decode.mock.calls) {
      expect(input.every((byte) => byte === 0)).toBe(true);
      expect(probes).toHaveLength(1);
      expect(probes?.every((probe) => probe.cipher.every((byte) => byte === 0) && probe.tail.every((byte) => byte === 0))).toBe(true);
    }
    expect(await readFile(file)).toEqual(original);
    expect(await readFile(thumbnailFile)).toEqual(thumbnail);
    result?.bytes.fill(0);
  });

  it('passes plaintext length and MIME through the real bounded transfer, not V2 container length', async () => {
    const { accountRoot, media } = await fixture(decoderFixture());
    const encrypted = encryptedImage(jpeg);
    await imageFile(accountRoot, encrypted);
    const pending = media.registerMessageMedia(username, 3, xml());
    const transfer = new NativeMediaTransfer(media);
    try {
      expect(await transfer.read(pending?.mediaKey ?? '', 0)).toEqual({
        ok: true, mime: 'image/jpeg', offset: 0, totalBytes: jpeg.length,
        nextOffset: jpeg.length, data: jpeg.toString('base64'),
      });
      expect(media.getMediaRef(pending?.mediaKey ?? '')?.byteLength).toBe(jpeg.length);
      expect(jpeg.length).not.toBe(encrypted.length);
    } finally { transfer.dispose(); }
  });

  it.each(['pending', 'encrypted', 'unsupported'] as const)('retains a failed %s source and retries after a bounded cooldown', async (status) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const decoder = decoderFixture();
    decoder.decode.mockReturnValueOnce({ status });
    const { accountRoot, media } = await fixture(decoder);
    await imageFile(accountRoot, encryptedImage(jpeg));
    const pending = media.registerMessageMedia(username, 3, xml());
    expect(await media.readMedia(pending?.mediaKey ?? '')).toBeUndefined();
    expect(media.getMediaRef(pending?.mediaKey ?? '')?.status).toBe(status);
    for (let retry = 0; retry < 4; retry += 1) expect(await media.readMedia(pending?.mediaKey ?? '')).toBeUndefined();
    expect(decoder.decode).toHaveBeenCalledOnce();
    vi.setSystemTime(Date.now() + 1001);
    const result = await media.readMedia(pending?.mediaKey ?? '');
    expect(result).toEqual({ mimeType: 'image/jpeg', bytes: jpeg });
    expect(decoder.decode).toHaveBeenCalledTimes(2);
    expect(media.getMediaRef(pending?.mediaKey ?? '')).toMatchObject({ status: 'ready', mediaKey: pending?.mediaKey });
    result?.bytes.fill(0);
  });

  it('finds a file downloaded later using the same previously missing lazy capability', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const decoder = decoderFixture();
    const { accountRoot, media } = await fixture(decoder);
    const pending = media.registerMessageMedia(username, 3, xml());
    expect(await media.readMedia(pending?.mediaKey ?? '')).toBeUndefined();
    expect(media.getMediaRef(pending?.mediaKey ?? '')?.status).toBe('missing');
    await imageFile(accountRoot, encryptedImage(jpeg));
    for (let retry = 0; retry < 4; retry += 1) expect(await media.readMedia(pending?.mediaKey ?? '')).toBeUndefined();
    expect(decoder.decode).not.toHaveBeenCalled();
    vi.setSystemTime(Date.now() + 1001);
    const result = await media.readMedia(pending?.mediaKey ?? '');
    expect(result?.bytes).toEqual(jpeg);
    expect(decoder.decode).toHaveBeenCalledOnce();
    result?.bytes.fill(0);
  });

  it('erases an oversized decrypted original and uses a thumbnail within the transfer limit', async () => {
    const tooLarge = Buffer.alloc(MEDIA_MAX_BYTES + 1, 0x39);
    jpeg.copy(tooLarge); jpeg.subarray(-2).copy(tooLarge, tooLarge.length - 2);
    const decoder = decoderFixture();
    let decrypted: Buffer | undefined;
    decoder.decode.mockImplementation((bytes) => {
      const decoded = decodeWechatV2Image(bytes, syntheticImageKey, syntheticXor);
      if (decoded.status === 'ready') decrypted = decoded.bytes;
      return decoded;
    });
    const { accountRoot, media } = await fixture(decoder);
    await imageFile(accountRoot, encryptedImage(tooLarge));
    await imageFile(accountRoot, jpeg, '_t.dat');
    const ref = media.registerMessageMedia(username, 3, xml());
    const result = await media.readMedia(ref?.mediaKey ?? '');
    expect(result).toEqual({ mimeType: 'image/jpeg', bytes: jpeg });
    expect(decrypted?.length).toBe(MEDIA_MAX_BYTES + 1);
    expect(decrypted?.equals(Buffer.alloc(decrypted.length))).toBe(true);
    expect(media.getMediaRef(ref?.mediaKey ?? '')).toMatchObject({ status: 'ready', byteLength: jpeg.length, thumbnail: true });
    result?.bytes.fill(0);
  });

  it('rejects a decoder MIME mismatch, wipes both buffers, and suppresses provider diagnostics', async () => {
    const decoder = decoderFixture();
    const malformed = Buffer.from('<svg>not a permitted raster</svg>');
    decoder.decode.mockReturnValueOnce({ status: 'ready', mimeType: 'image/png', bytes: malformed });
    const { accountRoot, media } = await fixture(decoder);
    await imageFile(accountRoot, encryptedImage(jpeg));
    const ref = media.registerMessageMedia(username, 3, xml());
    expect(await media.readMedia(ref?.mediaKey ?? '')).toBeUndefined();
    expect(malformed.every((byte) => byte === 0)).toBe(true);
    expect(decoder.decode.mock.calls[0][0].every((byte) => byte === 0)).toBe(true);
    expect(media.getMediaRef(ref?.mediaKey ?? '')).toMatchObject({ status: 'unsupported' });

    const another = media.registerMessageMedia(username, 3, xml('img', otherMd5));
    await imageFile(accountRoot, encryptedImage(jpeg), '.dat', otherMd5);
    decoder.decode.mockImplementationOnce(() => { throw new Error('PRIVATE_KEY_AND_ACCOUNT_PATH'); });
    expect(await media.readMedia(another?.mediaKey ?? '')).toBeUndefined();
    expect(JSON.stringify(media.getMediaRef(another?.mediaKey ?? ''))).not.toContain('PRIVATE_KEY_AND_ACCOUNT_PATH');
    expect(decoder.decode.mock.calls[1][0].every((byte) => byte === 0)).toBe(true);
  });

  it('does not read another account thumbnail through a candidate Img junction', async () => {
    const decoder = decoderFixture();
    const { accountRoot, media } = await fixture(decoder);
    await imageFile(accountRoot, encryptedImage(Buffer.from('wxgfSyntheticUnsupportedOriginalContainer')));
    const outside = path.join(path.dirname(accountRoot), 'different-account');
    const outsideFile = await imageFile(outside, encryptedImage(jpeg), '_t.dat');
    const month = path.join(accountRoot, 'msg', 'attach', createHash('md5').update(username).digest('hex'), '2026-07');
    await mkdir(month, { recursive: true });
    await symlink(path.dirname(outsideFile), path.join(month, 'Img'), 'junction');
    const ref = media.registerMessageMedia(username, 3, xml());
    expect(await media.readMedia(ref?.mediaKey ?? '')).toBeUndefined();
    expect(decoder.decode).toHaveBeenCalledOnce();
    expect(decoder.decode.mock.calls[0][1]).toEqual([]);
    expect(media.getMediaRef(ref?.mediaKey ?? '')?.status).toBe('unsupported');
    expect(await readFile(outsideFile)).toEqual(encryptedImage(jpeg));
  });

  it('rechecks containment when a registered encrypted source is replaced by an external junction', async () => {
    const decoder = decoderFixture();
    const { accountRoot, media } = await fixture(decoder);
    const file = await imageFile(accountRoot, encryptedImage(jpeg));
    const ref = await media.getMessageMedia(username, 3, xml());
    const outside = path.join(path.dirname(accountRoot), 'different-account');
    const outsideFile = await imageFile(outside, encryptedImage(png));
    await rename(path.dirname(file), `${path.dirname(file)}-saved`);
    await symlink(path.dirname(outsideFile), path.dirname(file), 'junction');
    expect(await media.readMedia(ref?.mediaKey ?? '')).toBeUndefined();
    expect(decoder.decode).not.toHaveBeenCalled();
    expect(await readFile(outsideFile)).toEqual(encryptedImage(png));
  });

  it('erases a decoded late result after disposal without taking ownership of the borrowed provider', async () => {
    const decoder = { ...decoderFixture(), dispose: vi.fn() };
    const { accountRoot, media } = await fixture(decoder);
    await imageFile(accountRoot, encryptedImage(jpeg));
    const ref = media.registerMessageMedia(username, 3, xml());
    const lateBytes = Buffer.from(jpeg);
    decoder.decode.mockImplementation(() => {
      media.dispose();
      return { status: 'ready', mimeType: 'image/jpeg', bytes: lateBytes };
    });
    expect(await media.readMedia(ref?.mediaKey ?? '')).toBeUndefined();
    expect(lateBytes.every((byte) => byte === 0)).toBe(true);
    expect(decoder.decode.mock.calls[0][0].every((byte) => byte === 0)).toBe(true);
    expect(media.getMediaRef(ref?.mediaKey ?? '')).toBeUndefined();
    expect(decoder.dispose).not.toHaveBeenCalled();
  });

  it('retains the 4096-reference bound including pending or encrypted-capable entries', async () => {
    const decoder = decoderFixture();
    const media = store({ accountRoot: '', databases: [], imageDecoder: decoder });
    const refs = Array.from({ length: 4097 }, (_, index) => media.registerMessageMedia(
      username, 3, xml('img', index.toString(16).padStart(32, '0')),
    ));
    expect(media.getMediaRef(refs[0]?.mediaKey ?? '')).toBeUndefined();
    expect(media.getMediaRef(refs[1]?.mediaKey ?? '')).toBeDefined();
    expect(media.getMediaRef(refs.at(-1)?.mediaKey ?? '')).toBeDefined();
    expect(await media.readMedia(refs[0]?.mediaKey ?? '')).toBeUndefined();
    expect(decoder.decode).not.toHaveBeenCalled();
  });
});
