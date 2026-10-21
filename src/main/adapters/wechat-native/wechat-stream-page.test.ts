import { describe, expect, it, vi } from 'vitest';
import type { NativeMessage } from './native-normalize';
import { readUnseenWechatMessages, WechatStreamPageError } from './wechat-stream-page';

const message = (index: number, timeIndex = index): NativeMessage => ({
  messageId: `message:${index}`, accountKey: 'account:fixture', contactKey: 'contact:fixture',
  direction: 'incoming', messageType: 'text', text: 'fixture',
  occurredAt: new Date(Date.UTC(2026, 0, 1) + timeIndex * 1000).toISOString(),
});

const pageReader = (messages: readonly NativeMessage[]) => vi.fn((limit: number, offset: number) =>
  [...messages].reverse().slice(offset, offset + limit).reverse());

describe('readUnseenWechatMessages', () => {
  it('decodes only 64 recent rows for an unchanged active conversation instead of 500', () => {
    const messages = Array.from({ length: 900 }, (_, index) => message(index));
    const read = pageReader(messages);
    expect(readUnseenWechatMessages(read, new Set(messages.slice(-200).map((row) => row.messageId)), false)).toEqual([]);
    expect(read.mock.calls).toEqual([[64, 0]]);
  });

  it('falls back to the full window for an ambiguous same-second legacy boundary', () => {
    const messages = Array.from({ length: 200 }, (_, index) => message(index, 1));
    const read = pageReader(messages);
    const result = readUnseenWechatMessages(read, new Set(messages.slice(140, 190).map((row) => row.messageId)), false);
    expect(new Set(result.map((row) => row.messageId)))
      .toEqual(new Set([...messages.slice(0, 140), ...messages.slice(190)].map((row) => row.messageId)));
  });

  it('does not replay older history outside the acknowledged boundary', () => {
    const messages = Array.from({ length: 650 }, (_, index) => message(index));
    const seen = new Set(messages.slice(540, 640).map((item) => item.messageId));
    const read = pageReader(messages);
    expect(readUnseenWechatMessages(read, seen, false).map((item) => item.messageId))
      .toEqual(messages.slice(640).map((item) => item.messageId));
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('keeps a burst larger than a single page and walks real offsets', () => {
    const messages = Array.from({ length: 920 }, (_, index) => message(index));
    const seen = new Set(messages.slice(0, 120).map((item) => item.messageId));
    const read = pageReader(messages);
    const result = readUnseenWechatMessages(read, seen, false);
    expect(result).toHaveLength(800);
    expect(new Set(result.map((item) => item.messageId)).size).toBe(800);
    expect(read.mock.calls).toEqual([[64, 0], [500, 0], [500, 500]]);
  });

  it('preserves unseen messages in the same second as the boundary', () => {
    const read = pageReader([message(0, 0), message(1, 2), message(2, 2), message(3, 3)]);
    expect(readUnseenWechatMessages(read, new Set(['message:2']), false).map((item) => item.messageId))
      .toEqual(['message:1', 'message:3']);
  });

  it('does not emit an old tie at the truncated baseline edge as a new message', () => {
    const read = pageReader([message(0, 0), message(1, 0), message(2, 10), message(3, 11)]);
    expect(readUnseenWechatMessages(read, new Set(['message:1', 'message:2']), false).map((item) => item.messageId))
      .toEqual(['message:3']);
  });

  it('uses the exact source sequence to avoid replaying older same-second rows outside the baseline', () => {
    const messages = Array.from({ length: 201 }, (_, index) => ({
      ...message(index, 1), sortSequence: String(9007199254740992n + BigInt(index)),
    }));
    const seen = new Set(messages.slice(100, 200).map((item) => item.messageId));
    const result = readUnseenWechatMessages(pageReader(messages), seen, false);
    expect(result.map((item) => item.messageId)).toEqual(['message:200']);
    expect(result[0].sortSequence).toBe('9007199254741192');
  });

  it('does not guess an unseen same-second message position when either boundary sequence is missing', () => {
    const before = { ...message(1, 1), sortSequence: '1' };
    const known = { ...message(2, 1), sortSequence: '2' };
    expect(readUnseenWechatMessages(pageReader([message(0, 1), known]), new Set([known.messageId]), false)
      .map((item) => item.messageId)).toEqual(['message:0']);
    expect(readUnseenWechatMessages(pageReader([before, { ...known, sortSequence: undefined }]), new Set([known.messageId]), false)
      .map((item) => item.messageId)).toEqual(['message:1']);
    expect(readUnseenWechatMessages(pageReader([before, known, message(3, 1)]), new Set([known.messageId, 'message:3']), false)
      .map((item) => item.messageId)).toEqual(['message:1']);
  });

  it('accepts the first messages in a previously empty conversation', () => {
    const read = pageReader([message(1), message(2)]);
    expect(readUnseenWechatMessages(read, new Set(), true)).toHaveLength(2);
  });

  it('does not pretend that a missing cursor boundary is a clean baseline', () => {
    expect(() => readUnseenWechatMessages(pageReader([message(1)]), new Set(['gone']), false))
      .toThrowError(expect.objectContaining({ code: 'cursor.expired' }));
  });

  it('returns no messages when nothing changed or a conversation is empty', () => {
    expect(readUnseenWechatMessages(pageReader([message(1)]), new Set(['message:1']), false)).toEqual([]);
    expect(readUnseenWechatMessages(pageReader([]), new Set(), true)).toEqual([]);
  });

  it('stops at a bounded scan instead of emitting an incomplete delta', () => {
    const read = vi.fn((limit: number, offset: number) =>
      Array.from({ length: limit }, (_, index) => message(offset + index)));
    expect(() => readUnseenWechatMessages(read, new Set(), true)).toThrow(WechatStreamPageError);
    expect(read).toHaveBeenCalledTimes(11);
  });
});
