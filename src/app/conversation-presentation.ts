import type { WechatLiveConversation, WechatLiveMessage } from '../shared/contracts';
import type { CrmCustomerContext } from '../shared/integration-contracts';
import { createWechatCustomer } from './wechat-inbox';

export function messageAvatar(message: WechatLiveMessage, conversation: WechatLiveConversation, selfAvatarMediaKey?: string) {
  if (message.direction === 'system') return null;
  const outgoing = message.direction === 'outgoing';
  const name = outgoing ? '我' : message.senderDisplayName || (conversation.kind === 'group'
    ? message.sender || '群成员' : conversation.remark || conversation.displayName);
  return { name, fallback: Array.from(name)[0] || '聊', mediaKey: message.senderAvatarMediaKey
    || (outgoing ? selfAvatarMediaKey : conversation.kind === 'contact' ? conversation.avatarMediaKey : undefined) };
}

/** Ignore changing observation times; invalidate drafts on any actual context edit. */
export function conversationSignature(messages: readonly WechatLiveMessage[]): string {
  return JSON.stringify(messages.map(({ id, direction, sentAt, text, messageType }) => [id, direction, sentAt, text, messageType]));
}

export function crmText(record: Record<string, unknown> | undefined, ...keys: string[]): string {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

export function customerWithCrm(conversation: WechatLiveConversation, context: CrmCustomerContext | null) {
  const customer = createWechatCustomer(conversation);
  if (!context) return customer;
  // Preserve the exact units and words recorded in CRM; do not infer budget amounts.
  return { ...customer, phone: crmText(context.customer, 'phone'),
    budget: crmText(context.customer, 'budget') || '未知',
    area: crmText(context.customer, 'area') || '未知',
    purpose: crmText(context.customer, 'customerType', 'houseRequirement', 'targetProperty') || '未知',
    decisionMaker: crmText(context.customer, 'decision_maker') || '未知' };
}
