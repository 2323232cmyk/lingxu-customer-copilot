import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_MEDIA_LIMITS, LocalMediaRegistry, type LocalMediaLoader } from './local-media';

const png = () => ({
  buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6D1AAAAAASUVORK5CYII=', 'base64'),
  mime: 'image/png',
});
const largePng = () => {
  const image = png();
  const buffer = Buffer.alloc(LOCAL_MEDIA_LIMITS.imageBytes);
  image.buffer.copy(buffer);
  return { buffer, mime: image.mime };
};
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
type LoadedImage = Awaited<ReturnType<LocalMediaLoader>>;

afterEach(() => vi.useRealTimers());

describe('local media registry', () => {
  it('registers unpredictable opaque keys and loads nothing until requested', async () => {
    const registry = new LocalMediaRegistry();
    const loader = vi.fn(async () => png());
    const key = registry.register(loader);
    expect(key).toMatch(/^[a-f0-9]{64}$/u);
    expect(registry.register(loader)).not.toBe(key);
    expect(loader).not.toHaveBeenCalled();
    const result = await registry.resolveForRenderer(key);
    expect(result).toEqual({ ok: true, mime: 'image/png', dataUrl: `data:image/png;base64,${png().buffer.toString('base64')}` });
    expect(loader).toHaveBeenCalledOnce();
    expect(loader.mock.calls[0]).toEqual([{ signal: expect.any(AbortSignal), maxBytes: LOCAL_MEDIA_LIMITS.imageBytes }]);
    expect(Object.keys(result).sort()).toEqual(['dataUrl', 'mime', 'ok']);
  });

  it.each([
    undefined, null, 1, {}, [], 'a'.repeat(63), 'A'.repeat(64), `${'a'.repeat(64)}\n`,
    'C:\\Users\\Private\\picture.png', 'file:///C:/private/picture.png',
    'https://example.invalid/private.png', 'http://127.0.0.1/private',
    '../private.png', `?key=${'a'.repeat(64)}`, `${'a'.repeat(64)}?size=1`,
    `${'a'.repeat(64)}/../file`, '%2e%2e%2fprivate', 'data:image/png;base64,AAAA',
  ])('rejects paths, URLs, queries and malformed keys without resolving %#', async (key) => {
    const registry = new LocalMediaRegistry();
    const loader = vi.fn(async () => png());
    registry.register(loader);
    expect(await registry.resolveForRenderer(key)).toEqual({ ok: false, reason: 'missing' });
    expect(loader).not.toHaveBeenCalled();
  });

  it('does not convert arbitrary objects to media keys', async () => {
    const registry = new LocalMediaRegistry();
    const toString = vi.fn(() => { throw new Error('private path'); });
    expect(await registry.resolveForRenderer({ toString })).toEqual({ ok: false, reason: 'missing' });
    expect(toString).not.toHaveBeenCalled();
  });

  it.each([
    ['image/png', png().buffer],
    ['image/jpeg', Buffer.from('ffd8ffe00002ffd9', 'hex')],
    ['image/gif', Buffer.from('GIF89a', 'ascii')],
    ['image/gif', Buffer.from('GIF87a', 'ascii')],
    ['image/webp', Buffer.from('RIFF\u0000\u0000\u0000\u0000WEBPVP8L', 'ascii')],
  ])('accepts only a matching raster MIME and magic header: %s', async (mime, buffer) => {
    const registry = new LocalMediaRegistry();
    const expectedDataUrl = `data:${mime};base64,${buffer.toString('base64')}`;
    const key = registry.register(async () => ({ mime, buffer }));
    expect(await registry.resolveForRenderer(key)).toEqual({ ok: true, mime, dataUrl: expectedDataUrl });
    expect(buffer.every((byte) => byte === 0)).toBe(true);
  });

  it.each([
    { mime: 'image/svg+xml', buffer: Buffer.from('<svg onload="alert(1)"/>') },
    { mime: 'text/html', buffer: Buffer.from('<script>alert(1)</script>') },
    { mime: 'image/png', buffer: Buffer.from('<svg/>') },
    { mime: 'image/jpeg', buffer: png().buffer },
    { mime: 'image/png; charset=UTF-8', buffer: png().buffer },
    { mime: 'image/png\nX-Secret: private', buffer: png().buffer },
    { mime: 'image/png', buffer: Buffer.alloc(0) },
    { mime: 'image/webp', buffer: Buffer.from('RIFF\u0000\u0000\u0000\u0000WEBPJUNK', 'ascii') },
    { mime: 'image/gif', buffer: Buffer.from([0xc7, 0xc9, 0xc6, 0xb8, 0xb9, 0xe1]) },
    { mime: 'image/webp', buffer: Buffer.from(Buffer.from('RIFF\u0000\u0000\u0000\u0000WEBPVP8L', 'ascii').map((byte) => byte | 0x80)) },
  ])('rejects unsupported or spoofed image data %#', async (image) => {
    const registry = new LocalMediaRegistry();
    expect(await registry.resolveForRenderer(registry.register(async () => image)))
      .toEqual({ ok: false, reason: 'unsupported' });
    expect(image.buffer.every((byte) => byte === 0)).toBe(true);
  });

  it('rejects oversized images before converting them to a data URL', async () => {
    const registry = new LocalMediaRegistry();
    const image = { ...png(), buffer: Buffer.alloc(LOCAL_MEDIA_LIMITS.imageBytes + 1) };
    png().buffer.copy(image.buffer);
    const toString = vi.spyOn(image.buffer, 'toString');
    expect(await registry.resolveForRenderer(registry.register(async () => image)))
      .toEqual({ ok: false, reason: 'unsupported' });
    expect(toString).not.toHaveBeenCalled();
    expect(image.buffer.every((byte) => byte === 0)).toBe(true);
  });

  it('rejects a non-buffer payload even if a buggy loader claims an image MIME', async () => {
    const registry = new LocalMediaRegistry();
    const key = registry.register(async () => ({ buffer: '<svg/>', mime: 'image/png' } as unknown as LoadedImage));
    expect(await registry.resolveForRenderer(key)).toEqual({ ok: false, reason: 'unsupported' });
  });

  it('caches validated data without exposing mutable buffers or result objects', async () => {
    const registry = new LocalMediaRegistry();
    const image = png();
    const expected = image.buffer.toString('base64');
    const loader = vi.fn(async () => image);
    const key = registry.register(loader);
    const first = await registry.resolveForRenderer(key);
    if (!first.ok) throw new Error('expected image');
    first.dataUrl = 'data:text/html,untrusted';
    expect(image.buffer.every((byte) => byte === 0)).toBe(true);
    expect(await registry.resolveForRenderer(key)).toEqual({ ok: true, mime: 'image/png', dataUrl: `data:image/png;base64,${expected}` });
    expect(loader).toHaveBeenCalledOnce();
  });

  it('retries missing and failed media instead of permanently caching a placeholder', async () => {
    const registry = new LocalMediaRegistry();
    const loader = vi.fn<LocalMediaLoader>()
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('C:\\Private\\account key=secret'))
      .mockResolvedValue(png());
    const key = registry.register(loader);
    expect(await registry.resolveForRenderer(key)).toEqual({ ok: false, reason: 'missing' });
    expect(await registry.resolveForRenderer(key)).toEqual({ ok: false, reason: 'unavailable' });
    expect((await registry.resolveForRenderer(key)).ok).toBe(true);
    expect(loader).toHaveBeenCalledTimes(3);
  });

  it('bounds metadata registration without evicting existing opaque keys', async () => {
    const registry = new LocalMediaRegistry();
    const loader = vi.fn(async () => png());
    const keys = Array.from({ length: LOCAL_MEDIA_LIMITS.registeredEntries }, () => registry.register(loader));
    expect(keys.every((key) => key !== null)).toBe(true);
    expect(new Set(keys).size).toBe(LOCAL_MEDIA_LIMITS.registeredEntries);
    expect(registry.register(loader)).toBeNull();
    expect((await registry.resolveForRenderer(keys[0])).ok).toBe(true);
    registry.clear();
    expect(registry.register(loader)).not.toBeNull();
  });

  it('evicts least recently used cache entries but keeps their lazy loaders', async () => {
    const registry = new LocalMediaRegistry();
    const loaders = Array.from({ length: LOCAL_MEDIA_LIMITS.cacheEntries + 1 }, () => vi.fn(async () => png()));
    const keys = loaders.map((loader) => registry.register(loader));
    for (const key of keys.slice(0, -1)) await registry.resolveForRenderer(key);
    await registry.resolveForRenderer(keys[0]);
    await registry.resolveForRenderer(keys.at(-1));
    await registry.resolveForRenderer(keys[0]);
    await registry.resolveForRenderer(keys[1]);
    expect(loaders[0]).toHaveBeenCalledOnce();
    expect(loaders[1]).toHaveBeenCalledTimes(2);
  });

  it('counts encoded data URLs against the cache byte budget and accepts exactly 8 MiB', async () => {
    const registry = new LocalMediaRegistry();
    const first = vi.fn(async () => largePng());
    const second = vi.fn(async () => largePng());
    const firstKey = registry.register(first);
    const secondKey = registry.register(second);
    expect((await registry.resolveForRenderer(firstKey)).ok).toBe(true);
    expect((await registry.resolveForRenderer(secondKey)).ok).toBe(true);
    expect((await registry.resolveForRenderer(firstKey)).ok).toBe(true);
    expect(first).toHaveBeenCalledTimes(2);
  });

  it('coalesces one media request and permits at most three different loaders', async () => {
    const registry = new LocalMediaRegistry();
    const waiting = Array.from({ length: LOCAL_MEDIA_LIMITS.concurrentLoads }, () => deferred<LoadedImage>());
    const loaders = waiting.map((item) => vi.fn(async () => item.promise));
    const keys = loaders.map((loader) => registry.register(loader));
    const pending = keys.map((key) => registry.resolveForRenderer(key));
    const duplicate = registry.resolveForRenderer(keys[0]);
    const extraLoader = vi.fn(async () => png());
    const extraKey = registry.register(extraLoader);
    expect(await registry.resolveForRenderer(extraKey)).toEqual({ ok: false, reason: 'unavailable' });
    expect(extraLoader).not.toHaveBeenCalled();
    waiting.forEach((item) => item.resolve(png()));
    expect((await Promise.all([...pending, duplicate])).every((result) => result.ok)).toBe(true);
    loaders.forEach((loader) => expect(loader).toHaveBeenCalledOnce());
    expect((await registry.resolveForRenderer(extraKey)).ok).toBe(true);
  });

  it('times out and aborts a loader without leaking its rejection or recycling a live slot', async () => {
    vi.useFakeTimers();
    const registry = new LocalMediaRegistry();
    const waiting = Array.from({ length: LOCAL_MEDIA_LIMITS.concurrentLoads }, () => deferred<LoadedImage>());
    const signals: AbortSignal[] = [];
    const keys = waiting.map((item) => registry.register(async ({ signal }) => { signals.push(signal); return item.promise; }));
    const pending = keys.map((key) => registry.resolveForRenderer(key));
    await vi.advanceTimersByTimeAsync(LOCAL_MEDIA_LIMITS.loadTimeoutMs);
    expect(await Promise.all(pending)).toEqual(waiting.map(() => ({ ok: false, reason: 'unavailable' })));
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    const extra = vi.fn(async () => png());
    const extraKey = registry.register(extra);
    expect(await registry.resolveForRenderer(extraKey)).toEqual({ ok: false, reason: 'unavailable' });
    expect(extra).not.toHaveBeenCalled();
    waiting.forEach((item) => item.reject(new Error('private native diagnostics')));
    await vi.advanceTimersByTimeAsync(0);
    expect((await registry.resolveForRenderer(extraKey)).ok).toBe(true);
  });

  it('clears cached keys and pending callers immediately when switching accounts', async () => {
    const registry = new LocalMediaRegistry();
    const cachedKey = registry.register(async () => png());
    await registry.resolveForRenderer(cachedKey);
    const old = deferred<LoadedImage>();
    let signal: AbortSignal | undefined;
    const oldKey = registry.register(async (options) => { signal = options.signal; return old.promise; });
    const pending = registry.resolveForRenderer(oldKey);
    registry.clear();
    expect(signal?.aborted).toBe(true);
    expect(await pending).toEqual({ ok: false, reason: 'missing' });
    expect(await registry.resolveForRenderer(cachedKey)).toEqual({ ok: false, reason: 'missing' });
    const lateImage = png();
    old.resolve(lateImage);
    await Promise.resolve();
    await Promise.resolve();
    expect(lateImage.buffer.every((byte) => byte === 0)).toBe(true);
    expect(await registry.resolveForRenderer(oldKey)).toEqual({ ok: false, reason: 'missing' });
    const newKey = registry.register(async () => png());
    expect(newKey).not.toBe(oldKey);
    expect((await registry.resolveForRenderer(newKey)).ok).toBe(true);
  });

  it('discards a successful late result after a timeout instead of caching it', async () => {
    vi.useFakeTimers();
    const registry = new LocalMediaRegistry();
    const waiting = deferred<LoadedImage>();
    const loader = vi.fn<LocalMediaLoader>()
      .mockImplementationOnce(async () => waiting.promise)
      .mockResolvedValue(png());
    const key = registry.register(loader);
    const pending = registry.resolveForRenderer(key);
    await vi.advanceTimersByTimeAsync(LOCAL_MEDIA_LIMITS.loadTimeoutMs);
    expect(await pending).toEqual({ ok: false, reason: 'unavailable' });
    const lateImage = png();
    waiting.resolve(lateImage);
    await vi.advanceTimersByTimeAsync(0);
    expect(lateImage.buffer.every((byte) => byte === 0)).toBe(true);
    expect((await registry.resolveForRenderer(key)).ok).toBe(true);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('suppresses a load which settles in the same turn as an account switch', async () => {
    const registry = new LocalMediaRegistry();
    const waiting = deferred<LoadedImage>();
    const key = registry.register(async () => waiting.promise);
    const pending = registry.resolveForRenderer(key);
    waiting.resolve(png());
    registry.clear();
    expect(await pending).toEqual({ ok: false, reason: 'missing' });
  });

  it('rechecks the account generation before delivering an already cached result', async () => {
    const registry = new LocalMediaRegistry();
    const key = registry.register(async () => png());
    await registry.resolveForRenderer(key);
    const pending = registry.resolveForRenderer(key);
    registry.clear();
    expect(await pending).toEqual({ ok: false, reason: 'missing' });
  });

  it('does not let repeated account clears bypass the global concurrency limit', async () => {
    const registry = new LocalMediaRegistry();
    const waiting = Array.from({ length: LOCAL_MEDIA_LIMITS.concurrentLoads }, () => deferred<LoadedImage>());
    for (const item of waiting) {
      const key = registry.register(async () => item.promise);
      const pending = registry.resolveForRenderer(key);
      registry.clear();
      expect(await pending).toEqual({ ok: false, reason: 'missing' });
    }
    const extra = vi.fn(async () => png());
    const extraKey = registry.register(extra);
    expect(await registry.resolveForRenderer(extraKey)).toEqual({ ok: false, reason: 'unavailable' });
    expect(extra).not.toHaveBeenCalled();
    waiting.forEach((item) => item.resolve(png()));
    await Promise.resolve();
    await Promise.resolve();
    expect((await registry.resolveForRenderer(extraKey)).ok).toBe(true);
  });
});
