import { describe, expect, it } from 'vitest';
import { isSalesWechatConversation } from './wechat-conversation-policy';

describe('sales conversation visibility', () => {
  it.each([
    ['contact', true], ['group', true], ['official', false], ['other', false],
  ] as const)('keeps %s only when it is a human conversation category', (kind, visible) => {
    expect(isSalesWechatConversation(Object.freeze({ kind }))).toBe(visible);
  });
});
