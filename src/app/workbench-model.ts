import type { WechatLiveConversation } from '../shared/contracts';
import type { CrmCustomerContext, CrmCustomerSummary, CrmTask } from '../shared/integration-contracts';
import { crmRecordParts, fieldText } from './feature-views-model';

export function workbenchTime(value?: string | null, fallback = '未记录'): string {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }) : value;
}

export function sourceHost(value?: string): string {
  if (!value) return 'CRM 尚未读取';
  try { return new URL(value).host || 'CRM'; } catch { return 'CRM'; }
}

export function customerGrade(value?: string): string {
  const letter = value?.trim().match(/^([A-E])(?:类|\b|\s|[·・：:])/i)?.[1];
  return letter ? `${letter.toUpperCase()}类` : value?.trim() || '未分级';
}

export function taskState(task: Pick<CrmTask, 'done' | 'dueAt'>, now = Date.now()): 'done' | 'overdue' | 'today' | 'future' | 'unknown' {
  if (task.done) return 'done';
  const due = new Date(task.dueAt).getTime();
  if (!task.dueAt || !Number.isFinite(due)) return 'unknown';
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
  return due < today.getTime() ? 'overdue' : due < tomorrow.getTime() ? 'today' : 'future';
}

export const taskStateLabels = { done: '已完成', overdue: '逾期', today: '今天', future: '计划中', unknown: '时间待定' } as const;

export function pageCustomerFacts(customers: readonly CrmCustomerSummary[], now = Date.now()) {
  let due = 0; let unscheduled = 0;
  for (const customer of customers) {
    if (!customer.nextFollowupAt || !Number.isFinite(new Date(customer.nextFollowupAt).getTime())) { unscheduled += 1; continue; }
    if (['today', 'overdue'].includes(taskState({ dueAt: customer.nextFollowupAt, done: false }, now))) due += 1;
  }
  return { due, unscheduled };
}

export function crmTimeline(context: CrmCustomerContext) {
  const allowed = [
    ...(context.availability.followups === 'available' ? context.followups.map((record, index) => ({ ...crmRecordParts(record, 'followup'), kind: 'followup' as const, index })) : []),
    ...(context.availability.calls === 'available' ? context.calls.map((record, index) => ({ ...crmRecordParts(record, 'call'), kind: 'call' as const, index })) : []),
  ];
  return allowed.map((entry) => ({ ...entry, key: `${entry.kind}-${entry.id || entry.index}-${entry.index}` }))
    .sort((a, b) => (Number.isFinite(Date.parse(b.stamp)) ? Date.parse(b.stamp) : -Infinity)
      - (Number.isFinite(Date.parse(a.stamp)) ? Date.parse(a.stamp) : -Infinity));
}

export function crmContextTasks(context: CrmCustomerContext): CrmTask[] {
  return context.tasks.map((value, index) => {
    const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
    return {
      id: Number(fieldText(record, 'id')) || -(index + 1), customerId: Number(fieldText(context.customer, 'id')),
      title: fieldText(record, 'title', 'content') || '未填写任务标题',
      dueAt: fieldText(record, 'dueAt', 'due_at'), done: record.done === true || record.done === 1 || record.done === '1',
      doneAt: fieldText(record, 'doneAt', 'done_at') || null, source: fieldText(record, 'source'),
      customerName: fieldText(context.customer, 'name'), customerLevel: fieldText(context.customer, 'level'),
      accessProfile: fieldText(context.customer, 'accessProfile', 'access_profile') === 'masked' ? 'masked' as const : 'full' as const,
    };
  }).sort((a, b) => Number(a.done) - Number(b.done) || (Date.parse(a.dueAt) || Infinity) - (Date.parse(b.dueAt) || Infinity));
}

/** The caller supplies the account's visible inbox; these are unread markers, not sales tasks. */
export function unreadPeople(conversations: readonly WechatLiveConversation[], hiddenContactKeys: readonly string[] = []) {
  const hidden = new Set(hiddenContactKeys);
  return conversations.filter((conversation) => conversation.kind === 'contact' && !hidden.has(conversation.contactKey)
    && typeof conversation.unreadCount === 'number' && Number.isFinite(conversation.unreadCount) && conversation.unreadCount > 0)
    .sort((a, b) => (Date.parse(b.lastMessageAt || '') || 0) - (Date.parse(a.lastMessageAt || '') || 0));
}

export function nextCustomerIndex(length: number, current: number, key: string): number | null {
  if (length <= 0) return null;
  if (key === 'Home') return 0;
  if (key === 'End') return length - 1;
  if (key === 'ArrowDown') return Math.min(length - 1, current + 1);
  if (key === 'ArrowUp') return Math.max(0, current - 1);
  return null;
}
