import type { WechatLiveConversation } from '../shared/contracts';

export interface ConversationPreferences { hidden: string[]; pinned: string[] }
const PREFIX = 'lingxu.conversation-preferences.v1:';
const MAX_KEYS = 5000;
export const emptyConversationPreferences = (): ConversationPreferences => ({ hidden: [], pinned: [] });
const validKey = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9:._-]{1,256}$/.test(value);

export function readConversationPreferences(storage: Pick<Storage, 'getItem'>, accountKey?: string): ConversationPreferences {
  if (!accountKey || !validKey(accountKey)) return emptyConversationPreferences();
  try {
    const raw = storage.getItem(PREFIX + accountKey);
    if (!raw || raw.length > 3_000_000) return emptyConversationPreferences();
    const data = JSON.parse(raw);
    const keys = (value: unknown) => Array.isArray(value) ? [...new Set(value.filter(validKey))].slice(0, MAX_KEYS) : [];
    return { hidden: keys(data?.hidden), pinned: keys(data?.pinned) };
  } catch { return emptyConversationPreferences(); }
}

export function saveConversationPreferences(storage: Pick<Storage, 'setItem'>, accountKey: string, value: ConversationPreferences): boolean {
  if (!validKey(accountKey)) return false;
  try { storage.setItem(PREFIX + accountKey, JSON.stringify(value)); return true; }
  catch { return false; }
}

export function toggleConversationPreference(value: ConversationPreferences, kind: keyof ConversationPreferences, contactKey: string): ConversationPreferences {
  if (!validKey(contactKey)) return value;
  const exists = value[kind].includes(contactKey);
  if (!exists && value[kind].length >= MAX_KEYS) throw new Error('本机保存的会话偏好已达上限，请先恢复部分会话。');
  return { ...value, [kind]: exists ? value[kind].filter((key) => key !== contactKey) : [...value[kind], contactKey] };
}

export function orderVisibleConversations(conversations: readonly WechatLiveConversation[], preferences: ConversationPreferences, showHidden = false) {
  const hidden = new Set(preferences.hidden);
  const pinned = new Set(preferences.pinned);
  return conversations.filter((item) => hidden.has(item.contactKey) === showHidden)
    .sort((a, b) => Number(pinned.has(b.contactKey)) - Number(pinned.has(a.contactKey)));
}

export const CONVERSATION_ROW_HEIGHT = 86;
export function conversationWindow(total: number, scrollTop: number, viewportHeight: number) {
  const overscan = 6;
  const height = Math.max(1, viewportHeight);
  const top = Math.min(Math.max(0, scrollTop), Math.max(0, total * CONVERSATION_ROW_HEIGHT - height));
  const start = Math.max(0, Math.floor(top / CONVERSATION_ROW_HEIGHT) - overscan);
  const end = Math.min(total, Math.ceil((top + height) / CONVERSATION_ROW_HEIGHT) + overscan);
  return { start, end, before: start * CONVERSATION_ROW_HEIGHT, after: (total - end) * CONVERSATION_ROW_HEIGHT };
}
