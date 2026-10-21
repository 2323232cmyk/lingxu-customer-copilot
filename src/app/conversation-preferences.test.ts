import { describe, expect, it } from 'vitest';
import { conversationWindow, emptyConversationPreferences, orderVisibleConversations, readConversationPreferences, saveConversationPreferences, toggleConversationPreference } from './conversation-preferences';
import { readWorkspaceDesign, saveWorkspaceDesign, WORKSPACE_DESIGN_KEY, NAVIGATION_LAYOUT_KEY } from './layout-preferences';
import type { WechatLiveConversation } from '../shared/contracts';

function memoryStorage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}
describe('workspace layout and private conversation preferences', () => {
  it('remembers actual A/B separately from navigation collapse', () => {
    const storage = memoryStorage();
    expect(readWorkspaceDesign(storage)).toBe('A');
    storage.setItem(NAVIGATION_LAYOUT_KEY, 'compact');
    expect(saveWorkspaceDesign(storage, 'B')).toBe(true);
    expect(readWorkspaceDesign(storage)).toBe('B');
    expect(storage.getItem(NAVIGATION_LAYOUT_KEY)).toBe('compact');
    storage.setItem(WORKSPACE_DESIGN_KEY, 'unknown');
    expect(readWorkspaceDesign(storage)).toBe('A');
  });
  it('isolates hidden and pinned keys by account and supports recovery', () => {
    const storage = memoryStorage();
    const value = toggleConversationPreference(emptyConversationPreferences(), 'hidden', 'c1');
    expect(saveConversationPreferences(storage, 'a1', value)).toBe(true);
    expect(readConversationPreferences(storage, 'a2').hidden).toEqual([]);
    expect(readConversationPreferences(storage, 'a1').hidden).toEqual(['c1']);
    expect(toggleConversationPreference(value, 'hidden', 'c1').hidden).toEqual([]);
  });
  it('leaves input rows untouched and keeps original order except pinned', () => {
    const rows = ['c1', 'c2', 'c3'].map((contactKey) => ({ contactKey, displayName: contactKey, kind: 'contact' as const }));
    const preferences = { hidden: ['c2'], pinned: ['c3'] };
    expect(orderVisibleConversations(rows, preferences).map((row) => row.contactKey)).toEqual(['c3', 'c1']);
    expect(orderVisibleConversations(rows, preferences, true).map((row) => row.contactKey)).toEqual(['c2']);
    expect(rows[0].contactKey).toBe('c1');
  });
  it('does not store display names or message contents', () => {
    const row: WechatLiveConversation = { contactKey: 'c1', displayName: 'private name', preview: 'private text', kind: 'contact' };
    const storage = memoryStorage();
    const value = toggleConversationPreference(emptyConversationPreferences(), 'pinned', row.contactKey);
    saveConversationPreferences(storage, 'a1', value);
    expect(JSON.stringify(readConversationPreferences(storage, 'a1'))).not.toMatch(/private/);
  });
  it('handles blocked storage without throwing or claiming persistence', () => {
    const storage = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(readWorkspaceDesign(storage)).toBe('A');
    expect(saveWorkspaceDesign(storage, 'B')).toBe(false);
    expect(readConversationPreferences(storage, 'a1')).toEqual(emptyConversationPreferences());
    expect(saveConversationPreferences(storage, 'a1', emptyConversationPreferences())).toBe(false);
  });
  it('renders a bounded window for a thousand conversations', () => {
    const first = conversationWindow(1032, 0, 650);
    expect(first.end - first.start).toBeLessThanOrEqual(20);
    const middle = conversationWindow(1032, 43_000, 650);
    expect(middle.end - middle.start).toBeLessThanOrEqual(22);
    expect(middle.before + (middle.end - middle.start) * 86 + middle.after).toBe(1032 * 86);
    expect(conversationWindow(0, 0, 650)).toEqual({ start: 0, end: 0, before: 0, after: 0 });
  });
  it('keeps remaining rows visible when filtering shortens a scrolled list', () => {
    const range = conversationWindow(3, 43_000, 650);
    expect(range).toEqual({ start: 0, end: 3, before: 0, after: 0 });
  });
});
