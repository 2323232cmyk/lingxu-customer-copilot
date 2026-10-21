import type { WechatLiveConversation, WechatLiveMessage } from '../shared/contracts';
import { compareWechatMessageOrder } from '../shared/wechat-message-order';
import { isSalesWechatConversation } from '../shared/wechat-conversation-policy';
import type { CustomerQueueItem } from './types';

export const conversationKindText: Record<WechatLiveConversation['kind'], string> = {
  contact: '微信单聊', group: '微信群聊', official: '公众号', other: '其他会话',
};

export const formatWechatTime = (value?: string): string => {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const today = new Date();
  return date.toDateString() === today.toDateString()
    ? date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
    : date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
};

/** A selected WeChat conversation is its own context, never a guessed CRM match. */
export const createWechatCustomer = (conversation: WechatLiveConversation): CustomerQueueItem => ({
  id: `wechat:${conversation.contactKey}`,
  source: 'wechat',
  name: conversation.remark || conversation.displayName,
  initials: Array.from(conversation.remark || conversation.displayName)[0] || '聊',
  phone: '', level: null,
  stage: conversationKindText[conversation.kind], owner: '',
  preview: conversation.preview ?? '', lastContact: formatWechatTime(conversation.lastMessageAt),
  unread: conversation.unreadCount ?? 0, priority: 'normal', status: '全部',
  budget: '未知', area: '未知', purpose: '未知', decisionMaker: '未知',
  obstacle: '从当前会话核实', nextAction: '等待读取聊天上下文',
  callSummary: '', messages: [], evidence: [],
});

export const mergeLiveMessages = (
  current: readonly WechatLiveMessage[], incoming: readonly WechatLiveMessage[], contactKey: string,
): WechatLiveMessage[] => {
  const byId = new Map<string, WechatLiveMessage>();
  for (const message of [...current, ...incoming]) {
    if (message.contactKey === contactKey) byId.set(message.id, message);
  }
  return [...byId.values()]
    .sort((left, right) =>
      compareWechatMessageOrder(left.sentAt, right.sentAt, left.sortSequence, right.sortSequence))
    .slice(-500);
};

/** Update visible activity from actual received messages, not a fabricated unread count. */
export const mergeWechatConversationActivity = (
  conversations: readonly WechatLiveConversation[], incoming: readonly WechatLiveMessage[],
): WechatLiveConversation[] => {
  const latest = new Map<string, WechatLiveMessage>();
  for (const message of incoming) {
    const previous = latest.get(message.contactKey);
    if (!previous || compareWechatMessageOrder(previous.sentAt, message.sentAt, previous.sortSequence, message.sortSequence) <= 0) {
      latest.set(message.contactKey, message);
    }
  }
  return conversations.map((conversation) => {
    const message = latest.get(conversation.contactKey);
    if (!message || (conversation.lastMessageAt && Date.parse(conversation.lastMessageAt) > Date.parse(message.sentAt))) return conversation;
    return { ...conversation, lastMessageAt: message.sentAt, preview: message.text };
  });
};

export type WechatInboxFilter = '全部' | '未读' | '单聊' | '群聊';

export const filterWechatConversations = (
  conversations: readonly WechatLiveConversation[], filter: WechatInboxFilter, query: string,
): WechatLiveConversation[] => {
  const keyword = query.trim().toLocaleLowerCase();
  return conversations.filter((conversation) => {
    if (!isSalesWechatConversation(conversation)) return false;
    if (filter === '未读' && !(Number(conversation.unreadCount) > 0)) return false;
    if (filter === '单聊' && conversation.kind !== 'contact') return false;
    if (filter === '群聊' && conversation.kind !== 'group') return false;
    return !keyword || [conversation.displayName, conversation.remark ?? '', conversation.preview ?? '']
      .some((value) => value.toLocaleLowerCase().includes(keyword));
  });
};
