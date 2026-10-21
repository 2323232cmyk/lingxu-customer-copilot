import { afterEach, describe, expect, it, vi } from 'vitest';
import { MEDIA_CHUNK_BYTES, MEDIA_MAX_BYTES, NativeMediaTransfer } from './native-media-transfer';

type MediaSource = ConstructorParameters<typeof NativeMediaTransfer>[0];
type Image = NonNullable<Awaited<ReturnType<MediaSource['readMedia']>>>;
const key = (index = 1) => `media_${index.toString(16).padStart(64, '0')}`;
const image = (size = 19): Image => {
  const bytes = Buffer.alloc(size, 0x39);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes);
  return { bytes, mimeType: 'image/png' };
};
const source = () => ({
  readMedia: vi.fn<MediaSource['readMedia']>(async () => image()),
  getMediaRef: vi.fn<MediaSource['getMediaRef']>(() => undefined),
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
const wiped = (bytes: Buffer) => bytes.equals(Buffer.alloc(bytes.length));

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('bounded native media transfers with synthetic buffers only', () => {
  it('returns 32 KiB chunks with exact offsets and wipes its owned image after the final chunk', async () => {
    vi.useFakeTimers();
    const media = image(MEDIA_CHUNK_BYTES * 2 + 7);
    const expected = Buffer.from(media.bytes);
    const reader = source(); reader.readMedia.mockResolvedValue(media);
    const transfer = new NativeMediaTransfer(reader);
    const chunks: Buffer[] = [];
    for (const offset of [0, MEDIA_CHUNK_BYTES, MEDIA_CHUNK_BYTES * 2]) {
      const result = await transfer.read(key(), offset);
      const end = Math.min(offset + MEDIA_CHUNK_BYTES, expected.length);
      expect(result).toEqual({ ok: true, mime: 'image/png', offset, totalBytes: expected.length,
        data: expected.subarray(offset, end).toString('base64'), nextOffset: end });
      chunks.push(Buffer.from(String(result.data), 'base64'));
    }
    expect(Buffer.concat(chunks)).toEqual(expected);
    expect(reader.readMedia).toHaveBeenCalledOnce();
    expect(wiped(media.bytes)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(await transfer.read(key(), MEDIA_CHUNK_BYTES)).toEqual({ ok: false, status: 'missing' });
  });

  it('accepts exactly 8 MiB as 256 bounded chunks and refuses an oversized buffer before encoding', async () => {
    const media = image(MEDIA_MAX_BYTES);
    const reader = source(); reader.readMedia.mockResolvedValue(media);
    const transfer = new NativeMediaTransfer(reader);
    let chunks = 0;
    for (let offset = 0; offset < MEDIA_MAX_BYTES; offset += MEDIA_CHUNK_BYTES) {
      const result = await transfer.read(key(), offset);
      expect(result).toMatchObject({ ok: true, totalBytes: MEDIA_MAX_BYTES, nextOffset: offset + MEDIA_CHUNK_BYTES });
      expect(String(result.data).length).toBeLessThanOrEqual(43_692);
      chunks += 1;
    }
    expect(chunks).toBe(256);
    expect(wiped(media.bytes)).toBe(true);
    const tooLarge = image(MEDIA_MAX_BYTES + 1);
    const encode = vi.spyOn(tooLarge.bytes, 'toString');
    reader.readMedia.mockResolvedValueOnce(tooLarge);
    expect(await transfer.read(key(2), 0)).toEqual({ ok: false, status: 'unsupported' });
    expect(encode).not.toHaveBeenCalled();
    expect(wiped(tooLarge.bytes)).toBe(true);
    transfer.dispose();
  });

  it.each([undefined, null, 12, {}, '', 'a'.repeat(64), `media_${'A'.repeat(64)}`,
    'C:\\synthetic-private\\image.png', 'https://example.invalid/image.png', `${key()}?offset=0`, `${key()}\n`])(
    'rejects invalid media keys without calling the source %#', async (mediaKey) => {
      const reader = source(); const transfer = new NativeMediaTransfer(reader);
      expect(await transfer.read(mediaKey as string, 0)).toEqual({ ok: false, status: 'missing' });
      expect(reader.readMedia).not.toHaveBeenCalled();
      expect(reader.getMediaRef).not.toHaveBeenCalled();
    },
  );

  it('does not coerce a caller object into a registered native key', async () => {
    const reader = source(); const transfer = new NativeMediaTransfer(reader);
    const toString = vi.fn(() => key());
    expect(await transfer.read({ toString } as unknown as string, 0)).toEqual({ ok: false, status: 'missing' });
    expect(toString).not.toHaveBeenCalled();
    expect(reader.readMedia).not.toHaveBeenCalled();
  });

  it.each([-1, 1, MEDIA_CHUNK_BYTES + 1, 0.5, NaN, Infinity, MEDIA_MAX_BYTES, MEDIA_MAX_BYTES + MEDIA_CHUNK_BYTES])(
    'refuses a misaligned or out-of-range offset without reading a file: %s', async (offset) => {
      const reader = source(); const transfer = new NativeMediaTransfer(reader);
      expect(await transfer.read(key(), offset)).toEqual({ ok: false, status: 'missing' });
      expect(reader.readMedia).not.toHaveBeenCalled();
    },
  );

  it('does not open a source for a continuation with no live transfer or a nonsequential offset', async () => {
    const reader = source(); const transfer = new NativeMediaTransfer(reader);
    expect(await transfer.read(key(), MEDIA_CHUNK_BYTES)).toEqual({ ok: false, status: 'missing' });
    expect(reader.readMedia).not.toHaveBeenCalled();
    reader.readMedia.mockResolvedValue(image(MEDIA_CHUNK_BYTES * 3));
    await transfer.read(key(), 0);
    expect(await transfer.read(key(), MEDIA_CHUNK_BYTES * 2)).toEqual({ ok: false, status: 'missing' });
    expect((await transfer.read(key(), MEDIA_CHUNK_BYTES)).ok).toBe(true);
    expect(await transfer.read(key(), MEDIA_CHUNK_BYTES * 3)).toEqual({ ok: false, status: 'missing' });
    transfer.dispose();
  });

  it('rejects empty images and unsupported MIME types and wipes both source buffers', async () => {
    const reader = source(); const transfer = new NativeMediaTransfer(reader);
    for (const media of [image(0), { ...image(), mimeType: 'text/html' } as unknown as Image]) {
      reader.readMedia.mockResolvedValueOnce(media);
      expect(await transfer.read(key(), 0)).toEqual({ ok: false, status: 'unsupported' });
      expect(wiped(media.bytes)).toBe(true);
    }
    transfer.dispose();
  });

  it('keeps at most three cached images, evicts and wipes the oldest, and clears all timers on dispose', async () => {
    vi.useFakeTimers();
    const images = Array.from({ length: 4 }, () => image(MEDIA_CHUNK_BYTES + 1));
    const reader = source();
    images.forEach((media) => reader.readMedia.mockResolvedValueOnce(media));
    const transfer = new NativeMediaTransfer(reader);
    for (let index = 1; index <= 4; index += 1) expect((await transfer.read(key(index), 0)).ok).toBe(true);
    expect(wiped(images[0].bytes)).toBe(true);
    expect(images.slice(1).every((media) => !wiped(media.bytes))).toBe(true);
    expect(await transfer.read(key(), MEDIA_CHUNK_BYTES)).toEqual({ ok: false, status: 'missing' });
    expect(vi.getTimerCount()).toBe(3);
    transfer.dispose();
    expect(images.every((media) => wiped(media.bytes))).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(await transfer.read(key(5), 0)).toEqual({ ok: false, status: 'missing' });
    expect(reader.readMedia).toHaveBeenCalledTimes(4);
  });

  it('expires a transfer after ten inactive seconds and refreshes only on a valid chunk', async () => {
    vi.useFakeTimers();
    const media = image(MEDIA_CHUNK_BYTES * 3 + 1);
    const reader = source(); reader.readMedia.mockResolvedValue(media);
    const transfer = new NativeMediaTransfer(reader);
    await transfer.read(key(), 0);
    await vi.advanceTimersByTimeAsync(4_999);
    expect((await transfer.read(key(), MEDIA_CHUNK_BYTES * 2)).ok).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(wiped(media.bytes)).toBe(false);
    expect((await transfer.read(key(), MEDIA_CHUNK_BYTES)).ok).toBe(true);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(wiped(media.bytes)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(wiped(media.bytes)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(await transfer.read(key(), MEDIA_CHUNK_BYTES * 2)).toEqual({ ok: false, status: 'missing' });
    expect(reader.readMedia).toHaveBeenCalledOnce();
  });

  it('coalesces simultaneous initial reads including one-chunk images without leaking an overwritten buffer', async () => {
    vi.useFakeTimers();
    const waiting = deferred<Image>();
    const reader = source(); reader.readMedia.mockImplementation(() => waiting.promise);
    const transfer = new NativeMediaTransfer(reader);
    const first = transfer.read(key(), 0);
    const duplicate = transfer.read(key(), 0);
    expect(reader.readMedia).toHaveBeenCalledOnce();
    const media = image(); const expected = media.bytes.toString('base64');
    waiting.resolve(media);
    const results = await Promise.all([first, duplicate]);
    expect(results[0]).toMatchObject({ ok: true, data: expected });
    expect(results[1]).toEqual(results[0]);
    expect(results[1]).not.toBe(results[0]);
    expect(wiped(media.bytes)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds concurrent source loads and wipes late buffers after dispose without creating timers', async () => {
    vi.useFakeTimers();
    const waiting = Array.from({ length: 3 }, () => deferred<Image>());
    const reader = source(); waiting.forEach((item) => reader.readMedia.mockImplementationOnce(() => item.promise));
    const transfer = new NativeMediaTransfer(reader);
    const pending = waiting.map((_item, index) => transfer.read(key(index + 1), 0));
    expect((await transfer.read(key(4), 0)).ok).toBe(false);
    expect(reader.readMedia).toHaveBeenCalledTimes(3);
    transfer.dispose();
    const images = waiting.map(() => image(MEDIA_CHUNK_BYTES + 1));
    waiting.forEach((item, index) => item.resolve(images[index]));
    expect((await Promise.all(pending)).every((result) => result.ok === false)).toBe(true);
    expect(images.every((media) => wiped(media.bytes))).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reserves pending-load slots from the same three-image budget as cached buffers', async () => {
    vi.useFakeTimers();
    const reader = source();
    const cached = Array.from({ length: 3 }, () => image(MEDIA_CHUNK_BYTES + 1));
    cached.forEach((media) => reader.readMedia.mockResolvedValueOnce(media));
    const transfer = new NativeMediaTransfer(reader);
    for (let index = 0; index < 3; index += 1) await transfer.read(key(index + 1), 0);
    const waiting = Array.from({ length: 3 }, () => deferred<Image>());
    waiting.forEach((item) => reader.readMedia.mockImplementationOnce(() => item.promise));
    const pending = waiting.map((_item, index) => transfer.read(key(index + 4), 0));
    expect(cached.every((media) => wiped(media.bytes))).toBe(true);
    expect((await transfer.read(key(7), 0)).ok).toBe(false);
    expect(reader.readMedia).toHaveBeenCalledTimes(6);
    const loaded = waiting.map(() => image(MEDIA_CHUNK_BYTES + 1));
    waiting.forEach((item, index) => item.resolve(loaded[index]));
    expect((await Promise.all(pending)).every((result) => result.ok === true)).toBe(true);
    expect(vi.getTimerCount()).toBe(3);
    transfer.dispose();
    expect(loaded.every((media) => wiped(media.bytes))).toBe(true);
  });

  it('suppresses an already buffered chunk if disposal happens before the async result is delivered', async () => {
    vi.useFakeTimers();
    const media = image(MEDIA_CHUNK_BYTES * 2 + 1);
    const reader = source(); reader.readMedia.mockResolvedValue(media);
    const transfer = new NativeMediaTransfer(reader);
    await transfer.read(key(), 0);
    const pending = transfer.read(key(), MEDIA_CHUNK_BYTES);
    transfer.dispose();
    expect(await pending).toEqual({ ok: false, status: 'missing' });
    expect(wiped(media.bytes)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('returns only safe missing or encryption status and never exposes a source exception', async () => {
    const reader = source(); reader.readMedia.mockResolvedValue(undefined);
    reader.getMediaRef.mockReturnValue({ status: 'encrypted' });
    const transfer = new NativeMediaTransfer(reader);
    expect(await transfer.read(key(), 0)).toEqual({ ok: false, status: 'encrypted' });
    reader.readMedia.mockRejectedValueOnce(new Error('C:\\synthetic-private\\file.dat key=DO_NOT_FORWARD'));
    const result = await transfer.read(key(2), 0);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('DO_NOT_FORWARD');
    expect(JSON.stringify(result)).not.toContain('synthetic-private');
    transfer.dispose();
  });
});
