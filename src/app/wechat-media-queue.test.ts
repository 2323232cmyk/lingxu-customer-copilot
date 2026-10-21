import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WechatMediaResult } from '../shared/contracts';
import { describeWechatMediaFailure, WECHAT_MEDIA_QUEUE_LIMITS, WechatMediaReadQueue } from './wechat-media-queue';

const key = (index: number) => index.toString(16).padStart(64, '0');
const image = (): WechatMediaResult => ({ ok: true, mime: 'image/png', dataUrl: 'data:image/png;base64,aW1hZ2U=' });
const unavailable = (): WechatMediaResult => ({ ok: false, reason: 'unavailable' });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('renderer WeChat media queue', () => {
  it('starts at most three reads and advances the remaining visible items in FIFO order', async () => {
    const waiting = Array.from({ length: 8 }, () => deferred<WechatMediaResult>());
    const read = vi.fn((mediaKey: string) => waiting[Number.parseInt(mediaKey, 16)].promise);
    const queue = new WechatMediaReadQueue(read);
    const tickets = waiting.map((_, index) => queue.enqueue(key(index)));
    expect(read.mock.calls.map(([mediaKey]) => mediaKey)).toEqual([key(0), key(1), key(2)]);
    waiting[1].resolve(image());
    await vi.advanceTimersByTimeAsync(0);
    expect(read.mock.calls.map(([mediaKey]) => mediaKey)).toEqual([key(0), key(1), key(2), key(3)]);
    waiting.forEach((item) => item.resolve(image()));
    expect((await Promise.all(tickets.map((ticket) => ticket.result))).every((result) => result?.ok)).toBe(true);
    expect(read.mock.calls.map(([mediaKey]) => mediaKey)).toEqual(waiting.map((_, index) => key(index)));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels a not-yet-started item without asking IPC to read it', async () => {
    const waiting = deferred<WechatMediaResult>();
    const read = vi.fn(async () => waiting.promise);
    const queue = new WechatMediaReadQueue(read);
    const first = [0, 1, 2].map((index) => queue.enqueue(key(index)));
    const cancelled = queue.enqueue(key(3));
    cancelled.cancel(); cancelled.cancel();
    expect(await cancelled.result).toBeNull();
    waiting.resolve(image());
    await Promise.all(first.map((ticket) => ticket.result));
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('ignores a cancelled in-flight result without freeing its still-running IPC slot', async () => {
    const waiting = Array.from({ length: 4 }, () => deferred<WechatMediaResult>());
    const read = vi.fn((mediaKey: string) => waiting[Number.parseInt(mediaKey, 16)].promise);
    const queue = new WechatMediaReadQueue(read);
    const tickets = waiting.map((_, index) => queue.enqueue(key(index)));
    tickets[0].cancel();
    expect(await tickets[0].result).toBeNull();
    expect(read).toHaveBeenCalledTimes(3);
    waiting[0].resolve(image());
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(4);
    expect(await tickets[0].result).toBeNull();
    waiting.forEach((item) => item.resolve(image()));
    await Promise.all(tickets.map((ticket) => ticket.result));
  });

  it('retries temporary unavailability twice, without occupying a slot during the delay', async () => {
    const read = vi.fn<(key: string) => Promise<WechatMediaResult>>()
      .mockResolvedValueOnce(unavailable()).mockResolvedValueOnce(image())
      .mockResolvedValueOnce(unavailable()).mockResolvedValue(image());
    const queue = new WechatMediaReadQueue(read);
    const first = queue.enqueue(key(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(await queue.enqueue(key(2)).result).toEqual(image());
    await vi.advanceTimersByTimeAsync(WECHAT_MEDIA_QUEUE_LIMITS.retryDelaysMs[0] - 1);
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(WECHAT_MEDIA_QUEUE_LIMITS.retryDelaysMs[1]);
    expect(await first.result).toEqual(image());
    expect(read.mock.calls.map(([mediaKey]) => mediaKey)).toEqual([key(1), key(2), key(1), key(1)]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops after a bounded number of temporary failures', async () => {
    const read = vi.fn(async () => unavailable());
    const ticket = new WechatMediaReadQueue(read).enqueue(key(1));
    await vi.advanceTimersByTimeAsync(WECHAT_MEDIA_QUEUE_LIMITS.timeoutMs);
    expect(await ticket.result).toEqual(unavailable());
    expect(read).toHaveBeenCalledTimes(WECHAT_MEDIA_QUEUE_LIMITS.attempts);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gives a four-second background preparation time to finish using two delayed retries', async () => {
    const started = Date.now();
    const pending: WechatMediaResult = { ok: false, reason: 'unavailable', mediaStatus: 'pending' };
    const read = vi.fn(async () => Date.now() - started < 4_000 ? pending : image());
    const ticket = new WechatMediaReadQueue(read).enqueue(key(1));
    await vi.advanceTimersByTimeAsync(1_499);
    expect(read).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(await ticket.result).toEqual(image());
    expect(read).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops polling persistent preparation and permits a later manual retry', async () => {
    const pending: WechatMediaResult = { ok: false, reason: 'unavailable', mediaStatus: 'pending' };
    const read = vi.fn(async (): Promise<WechatMediaResult> => pending);
    const queue = new WechatMediaReadQueue(read);
    const first = queue.enqueue(key(1));
    await vi.advanceTimersByTimeAsync(WECHAT_MEDIA_QUEUE_LIMITS.timeoutMs);
    expect(await first.result).toEqual(pending);
    expect(read).toHaveBeenCalledTimes(WECHAT_MEDIA_QUEUE_LIMITS.preparationAttempts);
    expect(vi.getTimerCount()).toBe(0);
    read.mockResolvedValue(image());
    expect(await queue.enqueue(key(1)).result).toEqual(image());
    expect(read).toHaveBeenCalledTimes(WECHAT_MEDIA_QUEUE_LIMITS.preparationAttempts + 1);
  });

  it('waits for a twenty-second native image preparation without requiring a manual retry', async () => {
    const started = Date.now();
    const pending: WechatMediaResult = { ok: false, reason: 'unavailable', mediaStatus: 'pending' };
    const read = vi.fn(async () => Date.now() - started < 20_000 ? pending : image());
    const ticket = new WechatMediaReadQueue(read).enqueue(key(1));
    await vi.advanceTimersByTimeAsync(21_500);
    expect(await ticket.result).toEqual(image());
    expect(read).toHaveBeenCalledTimes(6);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['encrypted', 'unsupported'] as const)('only re-reads a settled %s failure when requested again', async (mediaStatus) => {
    const failure: WechatMediaResult = { ok: false, reason: 'unsupported', mediaStatus };
    const read = vi.fn(async (): Promise<WechatMediaResult> => failure);
    const queue = new WechatMediaReadQueue(read);
    expect(await queue.enqueue(key(1)).result).toEqual(failure);
    await vi.advanceTimersByTimeAsync(WECHAT_MEDIA_QUEUE_LIMITS.timeoutMs);
    expect(read).toHaveBeenCalledOnce();
    read.mockResolvedValue(image());
    expect(await queue.enqueue(key(1)).result).toEqual(image());
    expect(read).toHaveBeenCalledTimes(2);
  });

  it.each(['missing', 'unsupported'] as const)('does not retry a genuine %s result', async (reason) => {
    const read = vi.fn(async (): Promise<WechatMediaResult> => ({ ok: false, reason }));
    const ticket = new WechatMediaReadQueue(read).enqueue(key(1));
    expect(await ticket.result).toEqual({ ok: false, reason });
    await vi.advanceTimersByTimeAsync(WECHAT_MEDIA_QUEUE_LIMITS.timeoutMs);
    expect(read).toHaveBeenCalledOnce();
  });

  it('converts rejected IPC errors to fixed safe results and retries only within the same limit', async () => {
    const read = vi.fn(async (): Promise<WechatMediaResult> => { throw new Error('private account path and diagnostics'); });
    const ticket = new WechatMediaReadQueue(read).enqueue(key(1));
    await vi.advanceTimersByTimeAsync(WECHAT_MEDIA_QUEUE_LIMITS.timeoutMs);
    expect(await ticket.result).toEqual(unavailable());
    expect(read).toHaveBeenCalledTimes(WECHAT_MEDIA_QUEUE_LIMITS.attempts);
  });

  it('removes retry timers when a component becomes invisible or changes its key', async () => {
    const read = vi.fn(async () => unavailable());
    const ticket = new WechatMediaReadQueue(read).enqueue(key(1));
    await vi.advanceTimersByTimeAsync(0);
    ticket.cancel();
    expect(await ticket.result).toBeNull();
    await vi.advanceTimersByTimeAsync(WECHAT_MEDIA_QUEUE_LIMITS.timeoutMs);
    expect(read).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ends loading on a stalled IPC, but never replaces still-running calls with extra calls', async () => {
    const waiting = deferred<WechatMediaResult>();
    const read = vi.fn(async () => waiting.promise);
    const queue = new WechatMediaReadQueue(read);
    const tickets = [0, 1, 2, 3].map((index) => queue.enqueue(key(index)));
    await vi.advanceTimersByTimeAsync(WECHAT_MEDIA_QUEUE_LIMITS.timeoutMs);
    expect(await Promise.all(tickets.map((ticket) => ticket.result))).toEqual(tickets.map(() => unavailable()));
    expect(read).toHaveBeenCalledTimes(3);
    const next = queue.enqueue(key(4));
    expect(read).toHaveBeenCalledTimes(3);
    waiting.resolve(image());
    await vi.advanceTimersByTimeAsync(0);
    expect(await next.result).toEqual(image());
    expect(read.mock.calls).toHaveLength(4);
    expect(await tickets[0].result).toEqual(unavailable());
  });

  it.each([
    'a'.repeat(63), 'A'.repeat(64), `${'a'.repeat(64)}\n`, 'file:///private.png', '../private', 'https://example.invalid/image',
  ])('rejects non-opaque media references without IPC: %#', async (mediaKey) => {
      const read = vi.fn(async () => image());
      const ticket = new WechatMediaReadQueue(read).enqueue(mediaKey);
      expect(await ticket.result).toEqual({ ok: false, reason: 'missing' });
      ticket.cancel();
      expect(read).not.toHaveBeenCalled();
    });

  it('bounds queued metadata and allows new work after cancelled items are removed', async () => {
    const waiting = deferred<WechatMediaResult>();
    const read = vi.fn(async () => waiting.promise);
    const queue = new WechatMediaReadQueue(read);
    const tickets = Array.from({ length: WECHAT_MEDIA_QUEUE_LIMITS.pendingReads }, (_, index) => queue.enqueue(key(index)));
    expect(await queue.enqueue(key(999)).result).toEqual(unavailable());
    tickets.forEach((ticket) => ticket.cancel());
    const next = queue.enqueue(key(1000));
    waiting.resolve(image());
    expect(await next.result).toEqual(image());
    expect(read).toHaveBeenCalledTimes(4);
  });

  it('keeps no completed-image cache or completed metadata', async () => {
    const read = vi.fn(async () => image());
    const queue = new WechatMediaReadQueue(read);
    for (let index = 0; index <= WECHAT_MEDIA_QUEUE_LIMITS.pendingReads; index += 1) {
      expect(await queue.enqueue(key(1)).result).toEqual(image());
    }
    expect(read).toHaveBeenCalledTimes(WECHAT_MEDIA_QUEUE_LIMITS.pendingReads + 1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not retry an unavailable result which arrives after cancelling an in-flight request', async () => {
    const waiting = deferred<WechatMediaResult>();
    const read = vi.fn(async () => waiting.promise);
    const ticket = new WechatMediaReadQueue(read).enqueue(key(1));
    ticket.cancel();
    waiting.resolve(unavailable());
    await vi.advanceTimersByTimeAsync(WECHAT_MEDIA_QUEUE_LIMITS.timeoutMs);
    expect(await ticket.result).toBeNull();
    expect(read).toHaveBeenCalledOnce();
  });

  it.each(['pending', 'encrypted', 'missing', 'unsupported'] as const)('preserves a precise %s media status from IPC', async (mediaStatus) => {
    const result: WechatMediaResult = { ok: false, reason: 'missing', mediaStatus };
    const read = vi.fn(async () => result);
    expect(await new WechatMediaReadQueue(read).enqueue(key(1)).result).toEqual(result);
  });
});

describe('truthful media placeholders', () => {
  it.each([
    ['pending', '图片仍在准备'], ['encrypted', '本地图片尚未解密'],
    ['missing', '本机尚无这张图片'], ['unsupported', '暂不支持此媒体格式'],
  ] as const)('describes %s without suggesting a picture was read successfully', (mediaStatus, label) => {
    expect(describeWechatMediaFailure({ ok: false, reason: 'missing', mediaStatus })).toBe(label);
  });

  it.each([
    ['missing', '本机尚无这张图片'], ['unsupported', '暂不支持此媒体格式'], ['unavailable', '暂时无法读取'],
  ] as const)('supports legacy %s results with no detailed media status', (reason, label) => {
    expect(describeWechatMediaFailure({ ok: false, reason })).toBe(label);
  });
});
