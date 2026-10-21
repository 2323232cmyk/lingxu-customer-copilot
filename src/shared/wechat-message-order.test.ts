import { describe, expect, it } from 'vitest';
import { compareWechatMessageOrder, isWechatSortSequence } from './wechat-message-order';

const TIME = '2026-08-31T01:00:00.000Z';

describe('WeChat source message ordering', () => {
  it.each(['0', '-1', '9007199254740993', '9223372036854775807', '-9223372036854775808'])(
    'accepts a lossless signed int64 string: %s', (value) => {
      expect(isWechatSortSequence(value)).toBe(true);
    },
  );

  it.each([
    undefined, null, 1, 9007199254740992, 1n, '', '1.5', '1e3', '+1', ' 1',
    '9223372036854775808', '-9223372036854775809', '1'.repeat(1000), 'private/path',
  ])('rejects an invalid source sequence: %s', (value) => {
    expect(isWechatSortSequence(value)).toBe(false);
  });

  it('compares adjacent sequences above the JavaScript safe-integer limit without rounding', () => {
    expect(compareWechatMessageOrder(TIME, TIME, '9007199254740992', '9007199254740993')).toBe(-1);
    expect(compareWechatMessageOrder(TIME, TIME, '9223372036854775807', '-9223372036854775808')).toBe(1);
    expect(compareWechatMessageOrder(TIME, TIME, '7', '7')).toBe(0);
  });

  it('uses the timestamp before the sequence and compares equivalent time-zone representations', () => {
    expect(compareWechatMessageOrder(TIME, '2026-08-31T01:00:01.000Z', '99', '1')).toBeLessThan(0);
    expect(compareWechatMessageOrder(TIME, '2026-08-31T09:00:00.000+08:00', '2', '1')).toBe(1);
  });

  it('keeps stable input order when either same-time sequence is missing or invalid', () => {
    expect(compareWechatMessageOrder(TIME, TIME)).toBe(0);
    expect(compareWechatMessageOrder(TIME, TIME, '1')).toBe(0);
    expect(compareWechatMessageOrder(TIME, TIME, undefined, '1')).toBe(0);
    expect(compareWechatMessageOrder(TIME, TIME, 'private/path', '1')).toBe(0);
    expect(compareWechatMessageOrder(TIME, TIME, '1', '9223372036854775808')).toBe(0);
  });
});
