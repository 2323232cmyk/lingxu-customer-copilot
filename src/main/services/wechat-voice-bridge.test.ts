import { describe, expect, it, vi } from 'vitest';
import { MAX_WECHAT_VOICE_BYTES } from '../adapters/wechat-native/wechat-voice-store';
import { WechatVoiceBridge } from './wechat-voice-bridge';

const CHUNK = 32 * 1024;
const nativeKey = `media_${'a'.repeat(64)}`;
const audio = (size = 73) => {
  const bytes = Buffer.alloc(size, 17); bytes.write('\x02#!SILK_V3', 0, 'binary'); return bytes;
};
const part = (bytes: Buffer, offset: number) => ({ ok: true, mime: 'audio/x-silk', offset,
  totalBytes: bytes.length, nextOffset: Math.min(offset + CHUNK, bytes.length),
  data: bytes.subarray(offset, Math.min(offset + CHUNK, bytes.length)).toString('base64') });

describe('main-only account-scoped voice bridge', () => {
  it('uses opaque aliases and reconstructs only bounded sequential audio chunks', async () => {
    const bytes = audio(CHUNK * 2 + 17);
    const request = vi.fn(async (_key: string, offset: number) => part(bytes, offset));
    const bridge = new WechatVoiceBridge({ isCurrent: () => true, request });
    const key = bridge.register(nativeKey);
    expect(key).toMatch(/^[a-f0-9]{64}$/u); expect(key).not.toBe(nativeKey.slice(6));
    expect(bridge.register(nativeKey)).toBe(key);
    expect(bridge.register('C:/private/voice.wav')).toBeUndefined();
    const result = await bridge.read(key);
    expect(result).toMatchObject({ format: 'silk', bytes });
    expect(request.mock.calls).toEqual([[nativeKey, 0], [nativeKey, CHUNK], [nativeKey, 2 * CHUNK]]);
    result?.bytes.fill(0); bridge.clear();
  });

  it('does not request raw native identifiers, invented aliases, or another account alias', async () => {
    const request = vi.fn(async () => part(audio(), 0));
    const one = new WechatVoiceBridge({ isCurrent: () => true, request });
    const other = new WechatVoiceBridge({ isCurrent: () => true, request });
    const key = one.register(nativeKey);
    expect(await other.read(key)).toBeUndefined(); expect(await one.read(nativeKey)).toBeUndefined();
    expect(await one.read('a'.repeat(64))).toBeUndefined(); expect(request).not.toHaveBeenCalled();
    one.clear(); expect(await one.read(key)).toBeUndefined();
  });

  it.each(['cancelled', 'stale', 'disposed'] as const)('never returns in-flight bytes after the session becomes %s', async (mode) => {
    let release: ((value: unknown) => void) | undefined;
    let current = true;
    const request = vi.fn(() => new Promise<unknown>((resolve) => { release = resolve; }));
    const bridge = new WechatVoiceBridge({ isCurrent: () => current, request });
    const controller = new AbortController();
    const reading = bridge.read(bridge.register(nativeKey), { signal: controller.signal });
    if (mode === 'cancelled') controller.abort();
    else if (mode === 'stale') current = false;
    else bridge.clear();
    release?.(part(audio(), 0));
    expect(await reading).toBeUndefined(); expect(request).toHaveBeenCalledOnce(); bridge.clear();
  });

  it.each([
    { totalBytes: MAX_WECHAT_VOICE_BYTES + 1 }, { totalBytes: 0 }, { totalBytes: 17.5 },
    { data: 'AB==' }, { data: 'A'.repeat(CHUNK * 2) }, { nextOffset: 99 }, { offset: 1 },
    { mime: 'text/html' }, { mime: 'image/jpeg' }, { ok: false, status: 'missing' },
  ])('rejects invalid chunk framing %#', async (patch) => {
    const request = vi.fn(async () => ({ ...part(audio(), 0), ...patch }));
    const bridge = new WechatVoiceBridge({ isCurrent: () => true, request });
    expect(await bridge.read(bridge.register(nativeKey))).toBeUndefined(); bridge.clear();
  });

  it('rejects format/header mismatch and an altered total or MIME mid-transfer', async () => {
    const fake = Buffer.alloc(50, 0);
    let bridge = new WechatVoiceBridge({ isCurrent: () => true, request: async () => part(fake, 0) });
    expect(await bridge.read(bridge.register(nativeKey))).toBeUndefined(); bridge.clear();
    const bytes = audio(CHUNK + 30);
    for (const patch of [{ totalBytes: bytes.length - 1 }, { mime: 'audio/wav' }]) {
      bridge = new WechatVoiceBridge({ isCurrent: () => true,
        request: async (_key, offset) => ({ ...part(bytes, offset), ...(offset ? patch : {}) }) });
      expect(await bridge.read(bridge.register(nativeKey))).toBeUndefined(); bridge.clear();
    }
  });

  it('bounds simultaneous readers and hides database exceptions', async () => {
    const pending: ((value: unknown) => void)[] = [];
    const request = vi.fn(() => new Promise<unknown>((resolve) => pending.push(resolve)));
    const bridge = new WechatVoiceBridge({ isCurrent: () => true, request });
    const key = bridge.register(nativeKey);
    const reads = Array.from({ length: 3 }, () => bridge.read(key));
    expect(await bridge.read(key)).toBeUndefined(); expect(request).toHaveBeenCalledTimes(3);
    for (const release of pending) release({ ok: false, status: 'missing' });
    expect(await Promise.all(reads)).toEqual([undefined, undefined, undefined]);
    request.mockRejectedValueOnce(new Error('synthetic private path must not escape'));
    expect(await bridge.read(key)).toBeUndefined(); bridge.clear();
  });
});
