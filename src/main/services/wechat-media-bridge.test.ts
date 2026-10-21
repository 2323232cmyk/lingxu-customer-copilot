import { afterEach, describe, expect, it, vi } from 'vitest';
import { WechatMediaBridge } from './wechat-media-bridge';
import { LOCAL_MEDIA_LIMITS } from './local-media';

const CHUNK_BYTES = 32 * 1024;
const MAX_BYTES = 8 * 1024 * 1024;
const nativeKey = (index = 1) => `media_${index.toString(16).padStart(64, '0')}`;
const png = (length = 19) => {
  const bytes = Buffer.alloc(length, 0x39);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes);
  return bytes;
};
const chunk = (bytes: Buffer, offset = 0, mime = 'image/png') => {
  const end = Math.min(offset + CHUNK_BYTES, bytes.length);
  return { ok: true, mime, offset, totalBytes: bytes.length,
    data: bytes.subarray(offset, end).toString('base64'), nextOffset: end };
};
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('account-scoped WeChat media bridge with synthetic data only', () => {
  it('uses the same bounded registration budget as its registry without resolving metadata eagerly', () => {
    const request = vi.fn(); const bridge = new WechatMediaBridge({ isCurrent: () => true, request });
    const keys = Array.from({ length: LOCAL_MEDIA_LIMITS.registeredEntries }, (_, index) => bridge.register(nativeKey(index + 1)));
    expect(keys.every((key) => typeof key === 'string')).toBe(true);
    expect(new Set(keys).size).toBe(LOCAL_MEDIA_LIMITS.registeredEntries);
    expect(bridge.register(nativeKey(LOCAL_MEDIA_LIMITS.registeredEntries + 1))).toBeUndefined();
    expect(bridge.register(nativeKey())).toBe(keys[0]);
    expect(request).not.toHaveBeenCalled();
    bridge.clear();
    expect(bridge.register(nativeKey())).toBeUndefined();
    const nextAccount = new WechatMediaBridge({ isCurrent: () => true, request });
    expect(nextAccount.register(nativeKey())).not.toBe(keys[0]);
    nextAccount.clear();
  });

  it('lazily aliases approved refs, downloads consecutive 32 KiB chunks, and returns only a raster data URL', async () => {
    const bytes = png(CHUNK_BYTES * 2 + 7);
    const request = vi.fn(async (_key: string, offset: number) => chunk(bytes, offset));
    const bridge = new WechatMediaBridge({ isCurrent: () => true, request });
    const key = bridge.register(nativeKey());
    expect(key).toMatch(/^[a-f0-9]{64}$/u);
    expect(key).not.toBe(nativeKey().slice(6));
    expect(bridge.register(nativeKey())).toBe(key);
    expect(request).not.toHaveBeenCalled();
    const concat = vi.spyOn(Buffer, 'concat');
    const result = await bridge.resolve(key);
    expect(result).toEqual({ ok: true, mime: 'image/png', dataUrl: `data:image/png;base64,${bytes.toString('base64')}` });
    expect(request.mock.calls).toEqual([0, CHUNK_BYTES, CHUNK_BYTES * 2].map((offset) => [nativeKey(), offset]));
    expect(concat.mock.calls[0][0].every((part) => part.every((byte) => byte === 0))).toBe(true);
    expect((await bridge.resolve(key)).ok).toBe(true);
    expect(request).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(result)).not.toContain(nativeKey());
    bridge.clear();
  });

  it('accepts exactly 8 MiB while requesting at most 256 chunks', async () => {
    const bytes = png(MAX_BYTES);
    const request = vi.fn(async (_key: string, offset: number) => chunk(bytes, offset));
    const bridge = new WechatMediaBridge({ isCurrent: () => true, request });
    const result = await bridge.resolve(bridge.register(nativeKey()));
    expect(result.ok).toBe(true);
    expect(request).toHaveBeenCalledTimes(256);
    expect(request.mock.calls.at(-1)?.[1]).toBe(MAX_BYTES - CHUNK_BYTES);
    bridge.clear();
  });

  it.each([undefined, null, 4, {}, [], 'A'.repeat(64), 'a'.repeat(63), `${'a'.repeat(64)}\n`,
    nativeKey(), 'C:\\synthetic-private\\image.png', 'https://example.invalid/image.png', 'a'.repeat(64)])(
    'rejects malformed or unregistered aliases before calling a worker %#', async (value) => {
      const request = vi.fn(); const bridge = new WechatMediaBridge({ isCurrent: () => true, request });
      bridge.register(nativeKey());
      expect(await bridge.resolve(value)).toEqual({ ok: false, reason: 'missing' });
      expect(request).not.toHaveBeenCalled();
      bridge.clear();
    },
  );

  it('does not coerce arbitrary objects or register raw paths as native references', async () => {
    const request = vi.fn(); const bridge = new WechatMediaBridge({ isCurrent: () => true, request });
    const toString = vi.fn(() => nativeKey());
    expect(bridge.register({ toString } as unknown as string)).toBeUndefined();
    expect(await bridge.resolve({ toString })).toEqual({ ok: false, reason: 'missing' });
    expect(bridge.register('C:\\synthetic-private\\image.png')).toBeUndefined();
    expect(toString).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    bridge.clear();
  });

  it.each([
    { offset: 1 }, { nextOffset: 1 }, { totalBytes: 0 }, { totalBytes: 0.5 },
    { totalBytes: MAX_BYTES + 1 }, { data: '' }, { data: '%%%=' }, { data: 'abcd\n' },
    { data: 'A'.repeat(43_696) }, { data: 'file:///private' }, { mime: 'image/svg+xml' },
    { mime: 'text/html' }, { mime: 'image/jpeg' }, { ok: false },
  ])('rejects wrong offset, length, base64 or MIME metadata %#', async (patch) => {
    const request = vi.fn(async () => ({ ...chunk(png()), ...patch }));
    const bridge = new WechatMediaBridge({ isCurrent: () => true, request });
    const result = await bridge.resolve(bridge.register(nativeKey()));
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('dataUrl');
    expect(request).toHaveBeenCalledOnce();
    bridge.clear();
  });

  it('rejects noncanonical base64 padding bits even when permissive decoding gives valid bytes', async () => {
    const good = chunk(png());
    expect(good.data.endsWith('OQ==')).toBe(true);
    const request = vi.fn(async () => ({ ...good, data: `${good.data.slice(0, -4)}OR==` }));
    const bridge = new WechatMediaBridge({ isCurrent: () => true, request });
    expect((await bridge.resolve(bridge.register(nativeKey()))).ok).toBe(false);
    bridge.clear();
  });

  it.each([{ totalBytes: CHUNK_BYTES + 8 }, { mime: 'image/jpeg' }, { offset: 0 }])(
    'rejects mid-transfer metadata changes and clears already decoded chunks %#', async (patch) => {
      const bytes = png(CHUNK_BYTES + 7);
      const request = vi.fn(async (_key: string, offset: number) => ({ ...chunk(bytes, offset), ...(offset ? patch : {}) }));
      const bridge = new WechatMediaBridge({ isCurrent: () => true, request });
      const decode = vi.spyOn(Buffer, 'from');
      const result = await bridge.resolve(bridge.register(nativeKey()));
      expect(result.ok).toBe(false);
      const decoded = decode.mock.results.filter((item, index) => item.type === 'return'
        && Buffer.isBuffer(item.value) && String(decode.mock.calls[index].at(1)) === 'base64');
      expect(decoded).toHaveLength(1);
      for (const item of decoded) if (item.type === 'return') expect(item.value.every((byte: number) => byte === 0)).toBe(true);
      bridge.clear();
    },
  );

  it('rechecks the current account and generation after awaiting a cached image', async () => {
    let current = true;
    const request = vi.fn(async () => chunk(png()));
    const bridge = new WechatMediaBridge({ isCurrent: () => current, request });
    const key = bridge.register(nativeKey());
    expect((await bridge.resolve(key)).ok).toBe(true);
    const pending = bridge.resolve(key);
    current = false;
    expect(await pending).toEqual({ ok: false, reason: 'missing' });
    expect(request).toHaveBeenCalledOnce();
    bridge.clear();
  });

  it('rejects old account data between chunks, stops further reads and wipes received bytes', async () => {
    let current = true;
    const bytes = png(CHUNK_BYTES * 2 + 1);
    const request = vi.fn(async (_key: string, offset: number) => {
      if (offset) current = false;
      return chunk(bytes, offset);
    });
    const bridge = new WechatMediaBridge({ isCurrent: () => current, request });
    const decode = vi.spyOn(Buffer, 'from');
    expect(await bridge.resolve(bridge.register(nativeKey()))).toEqual({ ok: false, reason: 'missing' });
    expect(request).toHaveBeenCalledTimes(2);
    const decoded = decode.mock.results.filter((item, index) => item.type === 'return'
      && Buffer.isBuffer(item.value) && String(decode.mock.calls[index].at(1)) === 'base64');
    expect(decoded).toHaveLength(1);
    for (const item of decoded) if (item.type === 'return') expect(item.value.every((byte: number) => byte === 0)).toBe(true);
    bridge.clear();
  });

  it('clears cached aliases and cancels an in-flight request without returning its late image', async () => {
    const waiting = deferred<unknown>();
    const request = vi.fn(async () => waiting.promise);
    const bridge = new WechatMediaBridge({ isCurrent: () => true, request });
    const key = bridge.register(nativeKey());
    const pending = bridge.resolve(key);
    bridge.clear();
    expect(await pending).toEqual({ ok: false, reason: 'missing' });
    waiting.resolve(chunk(png()));
    await Promise.resolve(); await Promise.resolve();
    expect(await bridge.resolve(key)).toEqual({ ok: false, reason: 'missing' });
    expect(bridge.register(nativeKey())).toBeUndefined();
    expect(request).toHaveBeenCalledOnce();
  });

  it('does not attach a previous account failure status after its pending read is cleared', async () => {
    const waiting = deferred<unknown>();
    const bridge = new WechatMediaBridge({ isCurrent: () => true, request: async () => waiting.promise });
    const pending = bridge.resolve(bridge.register(nativeKey()));
    waiting.resolve({ ok: false, status: 'encrypted' });
    bridge.clear();
    expect(await pending).toEqual({ ok: false, reason: 'missing' });
  });

  it('times out a stalled worker request and does not cache or publish its eventual response', async () => {
    vi.useFakeTimers();
    const waiting = deferred<unknown>();
    const request = vi.fn(async () => waiting.promise);
    const bridge = new WechatMediaBridge({ isCurrent: () => true, request });
    const key = bridge.register(nativeKey());
    const pending = bridge.resolve(key);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toEqual({ ok: false, reason: 'unavailable' });
    waiting.resolve(chunk(png()));
    await vi.advanceTimersByTimeAsync(0);
    request.mockImplementation(async () => chunk(png()));
    expect((await bridge.resolve(key)).ok).toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
    bridge.clear();
  });

  it.each(['pending', 'encrypted', 'missing', 'unsupported'] as const)(
    'preserves only the safe native failure status %s for the current account', async (status) => {
      const request = vi.fn(async () => ({ ok: false, status, privatePath: 'C:\\synthetic-private\\file.dat' }));
      const bridge = new WechatMediaBridge({ isCurrent: () => true, request });
      expect(await bridge.resolve(bridge.register(nativeKey()))).toEqual({
        ok: false, reason: status === 'pending' ? 'unavailable' : 'missing', mediaStatus: status,
      });
      bridge.clear();
    },
  );

  it('makes background decryption retryable and loads the completed image under the same alias', async () => {
    const request = vi.fn<(_key: string, offset: number) => Promise<unknown>>()
      .mockResolvedValueOnce({ ok: false, status: 'pending' })
      .mockResolvedValue(chunk(png()));
    const bridge = new WechatMediaBridge({ isCurrent: () => true, request });
    const key = bridge.register(nativeKey());
    expect(await bridge.resolve(key)).toEqual({ ok: false, reason: 'unavailable', mediaStatus: 'pending' });
    expect(await bridge.resolve(key)).toEqual({ ok: true, mime: 'image/png', dataUrl: `data:image/png;base64,${png().toString('base64')}` });
    expect(request).toHaveBeenCalledTimes(2);
    expect((await bridge.resolve(key)).ok).toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
    bridge.clear();
  });

  it('forgets a prior failure status on retry and never forwards unrecognized state or exceptions', async () => {
    const request = vi.fn<(_key: string, offset: number) => Promise<unknown>>()
      .mockResolvedValueOnce({ ok: false, status: 'encrypted' })
      .mockResolvedValueOnce({ ok: false, status: 'C:\\synthetic-private\\file.dat key=DO_NOT_FORWARD' })
      .mockRejectedValueOnce(new Error('private native key=DO_NOT_FORWARD'))
      .mockResolvedValue(chunk(png()));
    const bridge = new WechatMediaBridge({ isCurrent: () => true, request });
    const key = bridge.register(nativeKey());
    expect(await bridge.resolve(key)).toEqual({ ok: false, reason: 'missing', mediaStatus: 'encrypted' });
    expect(await bridge.resolve(key)).toEqual({ ok: false, reason: 'missing' });
    expect(await bridge.resolve(key)).toEqual({ ok: false, reason: 'unavailable' });
    expect((await bridge.resolve(key)).ok).toBe(true);
    bridge.clear();
  });
});
