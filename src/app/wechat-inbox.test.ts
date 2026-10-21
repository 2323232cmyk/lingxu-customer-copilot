import { describe, expect, it } from 'vitest';
import type { WechatLiveConversation, WechatLiveMessage } from '../shared/contracts';
import { createWechatCustomer, filterWechatConversations, formatWechatTime, mergeLiveMessages, mergeWechatConversationActivity } from './wechat-inbox';
import { replayLiveStrategy } from './strategy-runtime';

const conversation: WechatLiveConversation = {
  contactKey: 'c:one', displayName: '测试会话', kind: 'contact', unreadCount: 2, preview: '想了解法拍',
};
const message = (id: string, contactKey = 'c:one', text = '我想先了解一下'): WechatLiveMessage => ({
  id, contactKey, direction: 'incoming', sender: '测试会话', text, messageType: 'text',
  sentAt: `2026-08-31T01:00:${id.padStart(2, '0')}.000Z`, observedAt: '2026-08-31T01:01:00.000Z',
});

describe('real WeChat inbox context', () => {
  it('updates only known conversations with actual latest activity while retaining native unread counts', () => {
    const current = Object.freeze({ ...conversation, preview: '已知最新摘要', lastMessageAt: '2026-08-31T01:00:03.000Z' });
    expect(mergeWechatConversationActivity([current], [message('1'), message('2', 'c:foreign')])).toEqual([current]);
    const updated = mergeWechatConversationActivity([current], [message('4'), message('5')]);
    expect(updated).toEqual([{ ...current, preview: message('5').text, lastMessageAt: message('5').sentAt }]);
    expect(updated[0].unreadCount).toBe(2); expect(current.preview).toBe('已知最新摘要');
  });

  it('excludes official and service conversations in every sales list without matching display names', () => {
    const human = { ...conversation, displayName: '微信团队' };
    const group = { ...conversation, contactKey: 'c:group', kind: 'group' as const };
    const official = { ...conversation, contactKey: 'c:official', kind: 'official' as const };
    const service = { ...conversation, contactKey: 'c:service', kind: 'other' as const };
    expect(filterWechatConversations([human, group, official, service], '全部', '')).toEqual([human, group]);
    expect(filterWechatConversations([human, group, official, service], '未读', '')).toEqual([human, group]);
    expect(filterWechatConversations([human, official, service], '全部', '测试')).toEqual([]);
  });

  it('does not invent CRM facts, grade, phone, owner, call records or evidence', () => {
    const customer = createWechatCustomer(conversation);
    expect(customer).toMatchObject({ source: 'wechat', level: null, phone: '', owner: '', callSummary: '', evidence: [] });
    const result = replayLiveStrategy(customer, 'c:one', [message('1')]);
    expect(result?.state.facts.budget.status).toBe('missing');
    expect(result?.state.facts.purpose.status).toBe('missing');
    expect(result?.state.facts.decisionMaker.status).toBe('missing');
  });

  it('uses the real conversation history and changes strategy for the latest message', () => {
    const customer = createWechatCustomer(conversation);
    const earlier = replayLiveStrategy(customer, 'c:one', [message('1', 'c:one', '我准备自住，预算200万')]);
    const latest = replayLiveStrategy(customer, 'c:one', [
      message('1', 'c:one', '我准备自住，预算200万'), message('2', 'c:one', '不用了，谢谢，不考虑了'),
    ]);
    expect(earlier?.state.facts.purpose.value).toBeTruthy();
    expect(latest?.state.stage).toBe('closed');
    expect(latest?.state.version).toBeGreaterThan(earlier?.state.version ?? 0);
  });

  it('never merges a delayed response from another selected conversation', () => {
    expect(mergeLiveMessages([message('1')], [message('2', 'c:two'), message('3')], 'c:one')
      .map((item) => item.id)).toEqual(['1', '3']);
  });

  it('deduplicates and caps retained message context', () => {
    const messages = Array.from({ length: 510 }, (_, index) => ({ ...message('1'), id: String(index) }));
    expect(mergeLiveMessages(messages, [messages[0]], 'c:one')).toHaveLength(500);
  });

  it('searches every supplied session including more than the old 500 limit', () => {
    const sessions = Array.from({ length: 700 }, (_, index) => ({ ...conversation, contactKey: `c:${index}`, displayName: `会话${index}` }));
    expect(filterWechatConversations(sessions, '全部', '会话699')).toHaveLength(1);
    expect(filterWechatConversations(sessions, '全部', '')).toHaveLength(700);
  });

  it('uses real unread metadata and separates group conversations', () => {
    const sessions = [conversation, { ...conversation, contactKey: 'c:group', kind: 'group' as const, unreadCount: 0 }];
    expect(filterWechatConversations(sessions, '未读', '')).toEqual([conversation]);
    expect(filterWechatConversations(sessions, '群聊', '')[0].contactKey).toBe('c:group');
  });

  it('does not turn a session preview or a remark into confirmed customer facts', () => {
    const customer = createWechatCustomer({
      ...conversation,
      remark: 'A类 13800000000 已交费',
      preview: '预算300万，自住，在杭州，周六可以来，配偶决策',
    });
    expect(customer).toMatchObject({
      name: 'A类 13800000000 已交费', level: null, phone: '', owner: '',
      budget: '未知', area: '未知', purpose: '未知', decisionMaker: '未知',
      messages: [], evidence: [], callSummary: '',
    });
    expect(replayLiveStrategy(customer, conversation.contactKey, [])).toBeNull();
    const live = replayLiveStrategy(customer, conversation.contactKey, [message('1')]);
    expect(live).not.toBeNull();
    if (!live) return;
    for (const key of ['budget', 'area', 'purpose', 'decisionMaker'] as const) {
      expect(live.state.facts[key].status).toBe('missing');
      expect(live.state.facts[key].sourceMessageIds).toEqual([]);
    }
  });

  it('keeps identically named contacts independent rather than guessing a CRM match', () => {
    const first = createWechatCustomer({ ...conversation, displayName: '张先生' });
    const second = createWechatCustomer({ ...conversation, displayName: '张先生', contactKey: 'c:two' });
    expect(first.name).toBe(second.name);
    expect(first.id).not.toBe(second.id);
    expect(replayLiveStrategy(second, 'c:two', [message('1')])).toBeNull();
    const ownResult = replayLiveStrategy(second, 'c:two', [message('1', 'c:two')]);
    expect(ownResult?.state.facts.budget.status).toBe('missing');
  });

  it('selecting a new conversation starts without facts learned from the previous one', () => {
    const first = createWechatCustomer(conversation);
    const previous = replayLiveStrategy(first, 'c:one', [message('1', 'c:one', '我准备自住，预算200万')]);
    expect(previous?.state.facts.budget.status).toBe('confirmed');
    const second = createWechatCustomer({ ...conversation, contactKey: 'c:two' });
    const mixed = mergeLiveMessages([message('1', 'c:one', '我准备自住，预算200万')], [message('2', 'c:two')], 'c:two');
    const current = replayLiveStrategy(second, 'c:two', mixed);
    expect(current?.state.facts.budget.status).toBe('missing');
    expect(current?.state.facts.purpose.status).toBe('missing');
  });

  it('keeps system notices visible without using their apparent budget or visit agreement as evidence', () => {
    const customer = createWechatCustomer(conversation);
    const human = message('1');
    const system: WechatLiveMessage = {
      ...message('2', 'c:one', '[微信系统] 周六可以来，预算300万，自住'),
      direction: 'system', messageType: 'system', sender: '微信系统',
    };
    const merged = mergeLiveMessages([human], [system], 'c:one');
    expect(merged).toEqual([human, system]);
    expect(replayLiveStrategy(customer, 'c:one', merged))
      .toEqual(replayLiveStrategy(customer, 'c:one', [human]));
  });

  it.each(['group', 'official', 'other'] as const)('does not assign CRM facts to a %s conversation', (kind) => {
    const customer = createWechatCustomer({ ...conversation, kind });
    expect(customer).toMatchObject({ source: 'wechat', level: null, owner: '', phone: '', budget: '未知', purpose: '未知' });
    expect(customer.evidence).toEqual([]);
    expect(customer.messages).toEqual([]);
  });

  it('filters foreign cached rows as well as foreign incoming rows before deduplication', () => {
    const own = message('1', 'c:one', '本会话内容');
    const foreign = message('1', 'c:two', '另一会话内容');
    expect(mergeLiveMessages([foreign, own], [foreign], 'c:one')).toEqual([own]);
  });

  it('replaces a duplicate within the selected conversation without retaining two copies', () => {
    const older = message('1', 'c:one', '先前内容');
    const updated = { ...older, text: '本轮消息内容', observedAt: '2026-08-31T01:02:00.000Z' };
    expect(mergeLiveMessages([older], [updated, message('2', 'c:two')], 'c:one')).toEqual([updated]);
  });

  it('retains the latest 500 matching messages by timestamp rather than input order', () => {
    const rows = Array.from({ length: 510 }, (_, index) => ({
      ...message('1'), id: `item-${510 - index}`,
      sentAt: new Date(Date.parse('2026-08-31T01:00:00.000Z') + index * 1000).toISOString(),
    }));
    const foreign = { ...message('1', 'c:two'), sentAt: '2026-09-01T00:00:00.000Z' };
    const merged = mergeLiveMessages([...rows.slice(255)].reverse(), [...rows.slice(0, 255), foreign].reverse(), 'c:one');
    expect(merged.map((row) => row.id)).toEqual(rows.slice(10).map((row) => row.id));
  });

  it('does not mutate the caller arrays while sorting or deduplicating', () => {
    const first = Object.freeze(message('1'));
    const second = Object.freeze(message('2'));
    const current = Object.freeze([second, first]);
    const incoming = Object.freeze([first]);
    const merged = mergeLiveMessages(current, incoming, 'c:one');
    expect(merged).toEqual([first, second]);
    expect(current).toEqual([second, first]);
    expect(incoming).toEqual([first]);
    expect(merged).not.toBe(current);
  });

  it('orders same-second messages by the real lossless sequence rather than their opaque IDs', () => {
    const older = { ...message('1'), id: 'z-older', sortSequence: '9007199254740992' };
    const newer = { ...message('1'), id: 'a-newer', sortSequence: '9007199254740993' };
    expect(mergeLiveMessages([newer], [older], 'c:one').map((item) => item.id)).toEqual(['z-older', 'a-newer']);
  });

  it('preserves stable arrival order for same-second legacy messages without a sequence', () => {
    const first = { ...message('1'), id: 'z-first' };
    const second = { ...message('1'), id: 'a-second' };
    expect(mergeLiveMessages([first], [second], 'c:one').map((item) => item.id)).toEqual(['z-first', 'a-second']);
  });

  it('searches remarks case-insensitively without modifying the source session list', () => {
    const matched = Object.freeze({ ...conversation, remark: 'Alice 预算待确认' });
    const other = Object.freeze({ ...conversation, contactKey: 'c:two', displayName: 'Bob' });
    const sessions = Object.freeze([matched, other]);
    expect(filterWechatConversations(sessions, '全部', '  ALIce  ')).toEqual([matched]);
    expect(filterWechatConversations(sessions, '全部', '   ')).toEqual(sessions);
    expect(sessions).toEqual([matched, other]);
  });

  it.each([undefined, '', 'not-a-date'])('does not display an invalid message timestamp: %s', (value) => {
    expect(formatWechatTime(value)).toBe('');
  });
});
