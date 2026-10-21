import { describe, expect, it } from 'vitest';
import { normalizeNativeConversations } from './native-normalize';
import { WechatConversationPages } from './wechat-conversation-pages';
import { isWechatEngineStartResult } from '../../../shared/wechat-worker-protocol';

const conversations = (length: number) => Array.from({ length }, (_, index) =>
  normalizeNativeConversations([{ username: `wxid_synthetic_${index}`, nickname: `合成会话${index}` }])[0]);

describe('bounded conversation metadata pages', () => {
  it('filters service and official entries before paging, so they consume no visible pages', () => {
    const services = Array.from({ length: 250 }, (_, index) =>
      normalizeNativeConversations([{ username: `gh_synthetic_${index}`, nickname: '合成公众号' }])[0]);
    const people = conversations(50);
    const source = [...services, ...people];
    const pages = new WechatConversationPages('a:synthetic', source);
    const first = pages.page(100);
    expect(first.conversations.map((row) => row.contactKey)).toEqual(people.map((row) => row.contactKey));
    expect(first.nextConversationCursor).toBeUndefined();
    expect(source).toHaveLength(300);
  });

  it('returns all 651 conversations across bounded pages without raw usernames or message bodies', () => {
    const pages = new WechatConversationPages('a:synthetic', conversations(651));
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const result = pages.page(100, cursor);
      expect(result.conversations.length).toBeLessThanOrEqual(100);
      expect(isWechatEngineStartResult(result)).toBe(true);
      expect(JSON.stringify(result)).not.toContain('wxid_synthetic_');
      seen.push(...result.conversations.map((row) => row.contactKey));
      cursor = result.nextConversationCursor;
    } while (cursor);
    expect(seen).toHaveLength(651);
    expect(new Set(seen).size).toBe(651);
  });

  it('keeps an in-flight list stable and invalidates cursors after an account or refresh replacement', () => {
    const rows = conversations(3);
    const old = new WechatConversationPages('a:first', rows);
    const first = old.page(1);
    rows.reverse();
    expect(old.page(1, first.nextConversationCursor).conversations[0].displayName).toBe('合成会话1');
    const refreshed = new WechatConversationPages('a:first', rows);
    const otherAccount = new WechatConversationPages('a:other', rows);
    for (const pages of [refreshed, otherAccount]) {
      expect(() => pages.page(1, first.nextConversationCursor)).toThrow('会话列表已刷新');
    }
  });

  it('preserves real metadata and isolates returned rows from the index', () => {
    const rows = conversations(1).map((row) => ({ ...row, lastMessageAt: '2026-08-31T01:00:00.000Z', unreadCount: 3, preview: '合成摘要' }));
    const pages = new WechatConversationPages('a:synthetic', rows);
    const result = pages.page();
    expect(result.conversations[0]).toMatchObject({ unreadCount: 3, preview: '合成摘要', lastMessageAt: rows[0].lastMessageAt });
    expect(result.conversations[0]).not.toHaveProperty('username');
    expect(new WechatConversationPages('a:synthetic', []).page()).toEqual({ accountKey: 'a:synthetic', conversations: [] });
  });

  it.each([0, -1, 201, 0.5, NaN])('rejects unsupported page size %s', (limit) => {
    expect(() => new WechatConversationPages('a:synthetic', []).page(limit)).toThrow('会话分页范围无效');
  });
});
