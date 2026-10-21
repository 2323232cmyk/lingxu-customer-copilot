import { describe, expect, it } from 'vitest';
import type { CrmCustomerContext, CrmCustomerSummary } from '../shared/integration-contracts';
import type { WechatLiveConversation } from '../shared/contracts';
import { crmContextTasks, crmTimeline, customerGrade, nextCustomerIndex, pageCustomerFacts, sourceHost, taskState, unreadPeople, workbenchTime } from './workbench-model';

const customer = (value: Partial<CrmCustomerSummary>): CrmCustomerSummary => ({
  id: 1, name: '合成客户', phone: '', ownerId: 1, accessProfile: 'full', area: '', budget: '', location: '', firstContact: '', customerType: '', lastFollowupAt: '', lastFollowupContent: '', nextFollowupAt: '', followupCount: 0, isVisited: false, isDeal: false, visitAt: '', dealSignedAt: '', updatedAt: '', isFavorite: false, tags: '', ...value,
});
const context = (value: Partial<CrmCustomerContext> = {}): CrmCustomerContext => ({
  customer: { id: 1, name: '合成客户' }, followups: [], calls: [], tasks: [], houseTargets: [], fetchedAt: '2026-08-31T10:00:00+08:00', sourceBaseUrl: 'https://crm.example.test', availability: { followups: 'available', calls: 'available' }, ...value,
});

describe('workbench truth-preserving presentation', () => {
  it.each([['A类 · 高意向', 'A类'], ['b', 'B类'], ['C类', 'C类'], ['', '未分级'], ['A custom', 'A类'], ['VIP', 'VIP']])('formats only a recorded customer level: %s', (input, expected) => {
    expect(customerGrade(input)).toBe(expected);
  });
  it('shows no URL credentials, path, query or fragments in the source footer', () => {
    expect(sourceHost('https://user:secret@crm.example.test/private?token=secret#fragment')).toBe('crm.example.test');
    expect(sourceHost('bad-source')).toBe('CRM'); expect(sourceHost()).toBe('CRM 尚未读取');
  });
  it('keeps invalid dates as supplied and separates missing dates', () => {
    expect(workbenchTime('未确认时间')).toBe('未确认时间');
    expect(workbenchTime(undefined, '未安排')).toBe('未安排');
    expect(workbenchTime('2026-08-31T10:00:00+08:00')).not.toContain('Invalid');
  });
  it('separates done, overdue, today, future and unknown plans by local calendar day', () => {
    const now = new Date(2026, 7, 31, 12).getTime();
    const time = (day: number) => new Date(2026, 7, day, 10).toISOString();
    expect(taskState({ done: true, dueAt: '' }, now)).toBe('done');
    expect(taskState({ done: false, dueAt: time(30) }, now)).toBe('overdue');
    expect(taskState({ done: false, dueAt: time(31) }, now)).toBe('today');
    expect(taskState({ done: false, dueAt: time(32) }, now)).toBe('future');
    expect(taskState({ done: false, dueAt: 'invalid' }, now)).toBe('unknown');
  });
  it('counts only provided page records and never invents whole-CRM totals', () => {
    const now = new Date(2026, 7, 31, 12).getTime();
    expect(pageCustomerFacts([customer({ nextFollowupAt: new Date(2026, 7, 30, 10).toISOString() }), customer({ id: 2 }), customer({ id: 3, nextFollowupAt: 'unconfirmed' })], now)).toEqual({ due: 1, unscheduled: 2 });
    expect(pageCustomerFacts([], now)).toEqual({ due: 0, unscheduled: 0 });
  });
  it('merges authorized calls and followups by their actual time without removing duplicate records', () => {
    const rows = crmTimeline(context({ followups: [{ id: 2, content: '同样的备注', followupAt: '2026-08-31T12:00:00Z' }, { id: 3, content: '同样的备注', followupAt: '2026-08-31T11:00:00Z' }], calls: [{ id: 2, note: '电话原文', calledAt: '2026-08-31T13:00:00Z' }] }));
    expect(rows.map((row) => row.kind)).toEqual(['call', 'followup', 'followup']);
    expect(new Set(rows.map((row) => row.key)).size).toBe(3);
  });
  it('never displays a forbidden record even if an upstream fixture accidentally includes it', () => {
    const rows = crmTimeline(context({ followups: [{ content: 'do-not-display' }], calls: [{ note: 'authorized' }], availability: { followups: 'forbidden', calls: 'available' } }));
    expect(rows).toHaveLength(1); expect(rows[0].text).toBe('authorized');
  });
  it('does not mistake string zero or false for a completed CRM task', () => {
    const rows = crmContextTasks(context({ tasks: [{ id: 1, title: '未完成', done: '0' }, { id: 2, title: '完成', done: 1 }, { id: 3, title: '布尔', done: false }] }));
    expect(rows.find((row) => row.id === 1)?.done).toBe(false);
    expect(rows.find((row) => row.id === 2)?.done).toBe(true);
    expect(rows.find((row) => row.id === 3)?.done).toBe(false);
  });
  it('counts only visible single-person unread conversation markers, not groups or tasks', () => {
    const rows: WechatLiveConversation[] = [
      { contactKey: 'a', displayName: 'person', kind: 'contact', unreadCount: 3 },
      { contactKey: 'group', displayName: 'group', kind: 'group', unreadCount: 7 },
      { contactKey: 'official', displayName: 'official', kind: 'official', unreadCount: 8 },
      { contactKey: 'other', displayName: 'system', kind: 'other', unreadCount: 4 },
      { contactKey: 'hidden', displayName: 'hidden', kind: 'contact', unreadCount: 1 },
      { contactKey: 'read', displayName: 'read', kind: 'contact', unreadCount: 0 },
      { contactKey: 'invalid', displayName: 'invalid', kind: 'contact', unreadCount: NaN },
    ];
    expect(unreadPeople(rows, ['hidden']).map((row) => row.contactKey)).toEqual(['a']);
  });
  it('supports complete keyboard selection without wrapping out of the list', () => {
    expect(nextCustomerIndex(4, 0, 'ArrowUp')).toBe(0);
    expect(nextCustomerIndex(4, 0, 'ArrowDown')).toBe(1);
    expect(nextCustomerIndex(4, 3, 'ArrowDown')).toBe(3);
    expect(nextCustomerIndex(4, 0, 'End')).toBe(3);
    expect(nextCustomerIndex(4, 3, 'Home')).toBe(0);
    expect(nextCustomerIndex(0, 0, 'Home')).toBeNull();
    expect(nextCustomerIndex(4, 0, 'Tab')).toBeNull();
  });
});
