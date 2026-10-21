import { createHash } from 'node:crypto';
import { wechatCardText } from './wechat-card-text';
import { compareWechatMessageOrder, isWechatSortSequence } from '../../../shared/wechat-message-order';

const MAX_LABEL_LENGTH = 256;
const MAX_MESSAGE_TEXT_LENGTH = 8192;
const SERVICE_USERNAMES = new Set([
  'weixin', 'filehelper', 'fmessage', 'brandsessionholder', 'notifymessage',
]);

export interface NativeConversation {
  readonly username: string;
  readonly contactKey: string;
  readonly displayName: string;
  readonly remark?: string;
  readonly kind: 'contact' | 'group' | 'official' | 'other';
  readonly lastMessageAt?: string;
  readonly unreadCount?: number;
  readonly preview?: string;
}

export interface NativeMessage {
  readonly messageId: string;
  readonly accountKey: string;
  readonly contactKey: string;
  readonly direction: 'incoming' | 'outgoing' | 'system';
  readonly messageType: 'text' | 'image' | 'voice' | 'system' | 'other';
  readonly occurredAt: string;
  readonly sortSequence?: string;
  readonly text?: string;
  readonly senderAvatarMediaKey?: string;
  readonly senderDisplayName?: string;
  readonly voiceMediaKey?: string;
  readonly mediaKey?: string;
  readonly mediaKind?: 'image' | 'sticker';
  readonly mediaStatus?: 'pending' | 'ready' | 'encrypted' | 'missing' | 'unsupported';
  /** The message contains an attachment/card that this reader deliberately does not decode yet. */
  readonly attachmentKind?: 'video' | 'file' | 'unknown';
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hashOpaque = (prefix: string, value: string): string =>
  `${prefix}:${createHash('sha256').update(value).digest('hex')}`;

const pickValue = (
  row: Record<string, unknown>,
  names: readonly string[],
): unknown => {
  for (const name of names) {
    if (row[name] !== undefined && row[name] !== null) return row[name];
  }
  return undefined;
};

const boundedString = (value: unknown, maxLength: number): string => {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') {
    return '';
  }
  return String(value)
    .replaceAll('\u0000', '')
    .trim()
    .slice(0, maxLength);
};

const pickString = (
  row: Record<string, unknown>,
  names: readonly string[],
  maxLength: number,
): string => boundedString(pickValue(row, names), maxLength);

const normalizeTimestamp = (value: unknown): number | null => {
  const numeric = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  const milliseconds = numeric > 10_000_000_000 ? numeric : numeric * 1000;
  if (milliseconds < Date.UTC(2000, 0, 1) || milliseconds > Date.UTC(2100, 0, 1)) {
    return null;
  }
  return Math.trunc(milliseconds);
};

const booleanLike = (value: unknown): boolean | null => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 0 ? false : value === 1 ? true : null;
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes'].includes(normalized)) return true;
  if (['0', 'false', 'no'].includes(normalized)) return false;
  return null;
};

const normalizeDirection = (
  row: Record<string, unknown>,
): NativeMessage['direction'] | null => {
  const isSend = booleanLike(pickValue(row, [
    'computed_is_send',
    'computedIsSend',
    'is_send',
    'isSend',
    'WCDB_CT_is_send',
  ]));
  if (isSend !== null) return isSend ? 'outgoing' : 'incoming';

  const mesDes = Number(pickValue(row, ['mesDes']));
  if (mesDes === 0) return 'outgoing';
  if (mesDes === 1) return 'incoming';
  return null;
};

const normalizeMessageType = (value: unknown): NativeMessage['messageType'] => {
  const type = Number(String(value ?? '').trim());
  if (type === 1) return 'text';
  if (type === 3) return 'image';
  if (type === 34) return 'voice';
  if (type === 10_000 || type === 10_002) return 'system';
  return 'other';
};

const unsupportedAttachmentKind = (type: number, content: string): NativeMessage['attachmentKind'] => {
  if (type === 43 || type === 62) return 'video';
  if (type !== 49) return undefined;
  const appType = content.match(/<type>\s*(\d+)\s*<\/type>/iu)?.[1];
  if (appType === '6') return 'file';
  if (appType === '4') return 'video';
  return 'unknown';
};

export const createAccountKey = (accountRoot: string): string =>
  hashOpaque('a', accountRoot.toLowerCase());

export const normalizeWechatAccountName = (directoryName: string): string => {
  const name = directoryName.trim();
  if (/^wxid_/iu.test(name)) return name.match(/^wxid_[^_]+/iu)?.[0] ?? name;
  return name.replace(/_[a-z0-9]{4}$/iu, '');
};

export const createContactKey = (username: string): string =>
  hashOpaque('c', username);

export const parseWechatTasklistPids = (stdout: string): number[] => {
  const pids = new Set<number>();
  for (const line of stdout.split(/\r?\n/u)) {
    const match = line.match(/^"([^"]+)","(\d+)"/u);
    if (!match || !['weixin.exe', 'wechat.exe'].includes(match[1].toLowerCase())) continue;
    const pid = Number(match[2]);
    if (Number.isSafeInteger(pid) && pid > 0) pids.add(pid);
  }
  return [...pids];
};

export const normalizeNativeConversations = (
  value: unknown,
  limit = 500,
): NativeConversation[] => {
  if (!Array.isArray(value)) return [];
  const conversations = new Map<string, NativeConversation>();
  for (const candidate of value) {
    if (!isRecord(candidate)) continue;
    const username = pickString(candidate, [
      'username',
      'user_name',
      'userName',
      'usrName',
      'UsrName',
      'talker',
      'talker_id',
      'talkerId',
      'sessionId',
      'session_id',
    ], 512);
    if (!username) continue;
    const remark = pickString(candidate, [
      'remark',
      'remarkName',
      'remark_name',
      'contactRemark',
      'contact_remark',
    ], MAX_LABEL_LENGTH);
    const nickname = pickString(candidate, [
      'nickname',
      'nickName',
      'displayName',
      'display_name',
      'name',
    ], MAX_LABEL_LENGTH);
    const contactKey = createContactKey(username);
    const lastMessageAt = typeof candidate.lastMessageAt === 'string'
      && Number.isFinite(Date.parse(candidate.lastMessageAt)) ? candidate.lastMessageAt : undefined;
    const unreadCount = typeof candidate.unreadCount === 'number'
      && Number.isSafeInteger(candidate.unreadCount) && candidate.unreadCount >= 0 ? candidate.unreadCount : undefined;
    const preview = typeof candidate.preview === 'string' ? boundedString(candidate.preview, 1024) : undefined;
    if (!conversations.has(contactKey)) {
      conversations.set(contactKey, {
        username,
        contactKey,
        displayName: remark || nickname || '微信会话',
        ...(remark ? { remark } : {}),
        ...(lastMessageAt === undefined ? {} : { lastMessageAt }),
        ...(unreadCount === undefined ? {} : { unreadCount }),
        ...(preview === undefined ? {} : { preview }),
        kind: username.endsWith('@chatroom')
          ? 'group'
          : username.toLowerCase().startsWith('gh_')
            ? 'official'
            : !SERVICE_USERNAMES.has(username.toLowerCase()) && /^(wxid_|[a-zA-Z0-9_-]+$)/u.test(username)
              ? 'contact'
              : 'other',
      });
    }
    if (conversations.size >= Math.max(1, Math.min(500, limit))) break;
  }
  return [...conversations.values()];
};

export const normalizeNativeMessages = (
  value: unknown,
  context: {
    readonly accountKey: string;
    readonly contactKey: string;
    readonly username: string;
  },
  limit = 100,
  maxTextLength = MAX_MESSAGE_TEXT_LENGTH,
): NativeMessage[] => {
  if (!Array.isArray(value)) return [];
  const messages = new Map<string, NativeMessage>();
  for (const candidate of value) {
    if (!isRecord(candidate)) continue;
    const messageType = normalizeMessageType(pickValue(candidate, [
      'local_type',
      'localType',
      'message_type',
      'messageType',
      'msg_type',
      'msgType',
      'type',
      'WCDB_CT_local_type',
    ]));
    const direction = messageType === 'system' ? 'system' : normalizeDirection(candidate);
    const occurredAtMs = normalizeTimestamp(pickValue(candidate, [
      'create_time',
      'createTime',
      'msg_create_time',
      'msgCreateTime',
      'time',
      'WCDB_CT_create_time',
    ]));
    if (!direction || occurredAtMs === null) continue;

    const sourceSequence = pickValue(candidate, ['sort_seq', 'sortSequence']);
    const sortSequence = typeof sourceSequence === 'bigint'
      || (typeof sourceSequence === 'number' && Number.isSafeInteger(sourceSequence))
      ? String(sourceSequence) : sourceSequence;
    if (sortSequence !== undefined && !isWechatSortSequence(sortSequence)) continue;

    const serverId = pickString(candidate, [
      'server_id',
      'serverId',
      'svr_id',
      'svrId',
      'msg_svr_id',
      'msgSvrId',
      'message_id',
      'messageId',
      'new_msg_id',
      'newMsgId',
      'WCDB_CT_server_id',
    ], 256);
    const localId = pickString(candidate, [
      'local_id',
      'localId',
      'msg_local_id',
      'msgLocalId',
      'mesLocalID',
      'id',
    ], 256);
    const content = pickString(candidate, [
      'message_content',
      'messageContent',
      'content',
      'msg_content',
      'msgContent',
      'WCDB_CT_message_content',
    ], Math.min(64 * 1024, Math.max(MAX_MESSAGE_TEXT_LENGTH, maxTextLength)));
    const nativeType = Number(pickValue(candidate, [
      'local_type', 'localType', 'message_type', 'messageType', 'msg_type', 'msgType', 'type', 'WCDB_CT_local_type',
    ]));
    const attachmentKind = unsupportedAttachmentKind(nativeType, content);
    const cardText = wechatCardText(nativeType, content);
    const identity = serverId && serverId !== '0'
      ? `server:${serverId}`
      : localId
        ? `local:${localId}:${occurredAtMs}`
        : `fallback:${occurredAtMs}:${createHash('sha256').update(content).digest('hex')}`;
    const messageId = hashOpaque('m', `${context.username}:${identity}`);
    if (messages.has(messageId)) continue;
    messages.set(messageId, {
      messageId,
      accountKey: context.accountKey,
      contactKey: context.contactKey,
      direction,
      messageType,
      occurredAt: new Date(occurredAtMs).toISOString(),
      ...(sortSequence === undefined ? {} : { sortSequence }),
      ...(direction !== 'system' && typeof candidate.senderAvatarMediaKey === 'string'
        && /^media_[a-f0-9]{64}$/u.test(candidate.senderAvatarMediaKey)
        ? { senderAvatarMediaKey: candidate.senderAvatarMediaKey } : {}),
      ...(direction !== 'system' && typeof candidate.senderDisplayName === 'string'
        && candidate.senderDisplayName.trim()
        ? { senderDisplayName: boundedString(candidate.senderDisplayName, MAX_LABEL_LENGTH) } : {}),
      ...(messageType === 'voice' && typeof candidate.voiceMediaKey === 'string'
        && /^media_[a-f0-9]{64}$/u.test(candidate.voiceMediaKey)
        ? { voiceMediaKey: candidate.voiceMediaKey } : {}),
      ...(attachmentKind ? { attachmentKind } : {}),
      ...((messageType === 'image' || nativeType === 47) ? {
        mediaKind: messageType === 'image' ? 'image' as const : 'sticker' as const,
        ...(typeof candidate.mediaKey === 'string' && /^media_[a-f0-9]{64}$/u.test(candidate.mediaKey)
          ? { mediaKey: candidate.mediaKey } : {}),
        ...(['pending', 'ready', 'encrypted', 'missing', 'unsupported'].includes(String(candidate.mediaStatus))
          ? { mediaStatus: candidate.mediaStatus as NativeMessage['mediaStatus'] } : {}),
      } : {}),
      ...(cardText ? { text: cardText } : {}),
      ...((messageType === 'text' || messageType === 'system') && content
        ? { text: content }
        : {}),
    });
  }

  const ordered = [...messages.values()].sort((left, right) =>
    compareWechatMessageOrder(left.occurredAt, right.occurredAt, left.sortSequence, right.sortSequence));
  return ordered.slice(-Math.max(1, Math.min(100, limit)));
};
