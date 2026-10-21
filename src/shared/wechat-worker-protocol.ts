import { isWechatSortSequence } from './wechat-message-order';

export const WECHAT_WORKER_PROTOCOL_VERSION = 1 as const;

const MAX_ID_LENGTH = 96;
const MAX_KEY_LENGTH = 256;
const MAX_CURSOR_LENGTH = 1024;
const MAX_TEXT_LENGTH = 64 * 1024;
const MAX_BATCH_MESSAGES = 200;

export type WechatWorkerCommand =
  | 'engine.start'
  | 'engine.stop'
  | 'accounts.list'
  | 'account.connect'
  | 'conversations.list'
  | 'messages.snapshot'
  | 'messages.history'
  | 'media.read'
  | 'voice.read'
  | 'stream.subscribe'
  | 'stream.pause'
  | 'batch.ack';

export type WechatWorkerEventName =
  | 'engine.state'
  | 'messages.delta'
  | 'cursor.invalidated';

export interface WechatWorkerRequest {
  readonly protocolVersion: typeof WECHAT_WORKER_PROTOCOL_VERSION;
  readonly kind: 'request';
  readonly generation: string;
  readonly requestId: string;
  readonly command: WechatWorkerCommand;
  readonly payload: Record<string, unknown>;
}

export interface WechatWorkerHello {
  readonly protocolVersion: typeof WECHAT_WORKER_PROTOCOL_VERSION;
  readonly kind: 'hello';
  readonly generation: string;
  readonly engineVersion: string;
  readonly resourceFingerprint: string;
  readonly capabilities: readonly WechatWorkerCommand[];
}

export interface WechatWorkerError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface WechatWorkerResponse {
  readonly protocolVersion: typeof WECHAT_WORKER_PROTOCOL_VERSION;
  readonly kind: 'response';
  readonly generation: string;
  readonly requestId: string;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: WechatWorkerError;
}

export interface WechatWorkerEvent {
  readonly protocolVersion: typeof WECHAT_WORKER_PROTOCOL_VERSION;
  readonly kind: 'event';
  readonly generation: string;
  readonly sequence: number;
  readonly event: WechatWorkerEventName;
  readonly payload: Record<string, unknown>;
}

export interface WechatWorkerConversation {
  readonly contactKey: string;
  readonly displayName: string;
  readonly remark?: string;
  readonly kind: 'contact' | 'group' | 'official' | 'other';
  readonly lastMessageAt?: string;
  readonly unreadCount?: number;
  readonly preview?: string;
  readonly avatarMediaKey?: string;
}

export interface WechatEngineStartResult {
  readonly accountKey: string;
  readonly selfAvatarMediaKey?: string;
  readonly conversations: readonly WechatWorkerConversation[];
  readonly nextConversationCursor?: string;
}

export type WechatWorkerIncomingMessage =
  | WechatWorkerHello
  | WechatWorkerResponse
  | WechatWorkerEvent;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// Electron's utility-process parentPort delivers a MessageEvent in the child,
// while UtilityProcess emits the posted value directly in the main process.
export const unwrapWechatWorkerMessageEvent = (value: unknown): unknown =>
  isRecord(value) && 'data' in value ? value.data : value;

const hasOnlyKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
};

const isIdentifier = (value: unknown, maxLength = MAX_ID_LENGTH): value is string =>
  typeof value === 'string'
  && value.length > 0
  && value.length <= maxLength
  && /^[a-zA-Z0-9._:-]+$/u.test(value);

const isOpaqueKey = (value: unknown): value is string =>
  typeof value === 'string'
  && value.length > 0
  && value.length <= MAX_KEY_LENGTH
  && /^[a-zA-Z0-9._:@-]+$/u.test(value);

const isCursor = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= MAX_CURSOR_LENGTH;

const isProtocolVersion = (value: unknown): value is typeof WECHAT_WORKER_PROTOCOL_VERSION =>
  value === WECHAT_WORKER_PROTOCOL_VERSION;

const commands: readonly WechatWorkerCommand[] = [
  'engine.start',
  'engine.stop',
  'accounts.list',
  'account.connect',
  'conversations.list',
  'messages.snapshot',
  'messages.history',
  'media.read',
  'voice.read',
  'stream.subscribe',
  'stream.pause',
  'batch.ack',
];

const isCommand = (value: unknown): value is WechatWorkerCommand =>
  typeof value === 'string' && commands.includes(value as WechatWorkerCommand);

const emptyPayload = (payload: Record<string, unknown>): boolean =>
  Object.keys(payload).length === 0;

const isProcessIds = (value: unknown): value is number[] =>
  Array.isArray(value)
  && value.length <= 32
  && value.every((pid) => Number.isSafeInteger(pid) && Number(pid) > 0)
  && new Set(value).size === value.length;

const isRequestPayload = (
  command: WechatWorkerCommand,
  payload: unknown,
): payload is Record<string, unknown> => {
  if (!isRecord(payload)) return false;
  switch (command) {
    case 'engine.start':
      return emptyPayload(payload)
        || (hasOnlyKeys(payload, ['processIds']) && isProcessIds(payload.processIds));
    case 'engine.stop':
    case 'accounts.list':
      return emptyPayload(payload);
    case 'account.connect':
      return hasOnlyKeys(payload, ['accountKey']) && isOpaqueKey(payload.accountKey);
    case 'conversations.list':
      return hasOnlyKeys(payload, ['accountKey', 'limit', 'cursor'])
        && isOpaqueKey(payload.accountKey)
        && Number.isSafeInteger(payload.limit)
        && Number(payload.limit) >= 1 && Number(payload.limit) <= 200
        && (payload.cursor === undefined || isIdentifier(payload.cursor, MAX_CURSOR_LENGTH));
    case 'messages.snapshot':
      return hasOnlyKeys(payload, ['accountKey', 'contactKey', 'limit', 'cursor'])
        && isOpaqueKey(payload.accountKey)
        && isOpaqueKey(payload.contactKey)
        && Number.isSafeInteger(payload.limit)
        && Number(payload.limit) >= 1
        && Number(payload.limit) <= 500
        && (payload.cursor === undefined || isCursor(payload.cursor));
    case 'messages.history':
      return hasOnlyKeys(payload, ['accountKey', 'contactKey', 'limit', 'cursor', 'from', 'to'])
        && isOpaqueKey(payload.accountKey) && isOpaqueKey(payload.contactKey)
        && Number.isSafeInteger(payload.limit) && Number(payload.limit) >= 1 && Number(payload.limit) <= 200
        && (payload.cursor === undefined || isIdentifier(payload.cursor, MAX_CURSOR_LENGTH))
        && Number.isSafeInteger(payload.from) && Number(payload.from) >= 946684800
        && Number.isSafeInteger(payload.to) && Number(payload.to) <= 4102444800
        && Number(payload.from) <= Number(payload.to);
    case 'voice.read':
      return hasOnlyKeys(payload, ['accountKey', 'mediaKey', 'offset'])
        && isOpaqueKey(payload.accountKey)
        && typeof payload.mediaKey === 'string' && /^media_[a-f0-9]{64}$/u.test(payload.mediaKey)
        && Number.isSafeInteger(payload.offset) && Number(payload.offset) >= 0
        && Number(payload.offset) < 4 * 1024 * 1024 && Number(payload.offset) % (32 * 1024) === 0;
    case 'media.read':
      return hasOnlyKeys(payload, ['accountKey', 'mediaKey', 'offset'])
        && isOpaqueKey(payload.accountKey)
        && typeof payload.mediaKey === 'string' && /^media_[a-f0-9]{64}$/u.test(payload.mediaKey)
        && Number.isSafeInteger(payload.offset) && Number(payload.offset) >= 0
        && Number(payload.offset) < 8 * 1024 * 1024 && Number(payload.offset) % (32 * 1024) === 0;
    case 'stream.subscribe':
      return hasOnlyKeys(payload, ['accountKey', 'contactKeys', 'cursor'])
        && isOpaqueKey(payload.accountKey)
        && Array.isArray(payload.contactKeys)
        && payload.contactKeys.length >= 1
        && payload.contactKeys.length <= 50
        && payload.contactKeys.every(isOpaqueKey)
        && new Set(payload.contactKeys).size === payload.contactKeys.length
        && (payload.cursor === undefined || isCursor(payload.cursor));
    case 'stream.pause':
      return hasOnlyKeys(payload, ['subscriptionId'])
        && isIdentifier(payload.subscriptionId);
    case 'batch.ack':
      return hasOnlyKeys(payload, ['subscriptionId', 'batchId', 'cursor'])
        && isIdentifier(payload.subscriptionId)
        && isIdentifier(payload.batchId)
        && isCursor(payload.cursor);
  }
};

export const isWechatWorkerRequest = (value: unknown): value is WechatWorkerRequest => {
  if (!isRecord(value)) return false;
  if (!hasOnlyKeys(value, [
    'protocolVersion',
    'kind',
    'generation',
    'requestId',
    'command',
    'payload',
  ])) return false;
  return isProtocolVersion(value.protocolVersion)
    && value.kind === 'request'
    && isIdentifier(value.generation)
    && isIdentifier(value.requestId)
    && isCommand(value.command)
    && isRequestPayload(value.command, value.payload);
};

export const createWechatWorkerRequest = (
  generation: string,
  requestId: string,
  command: WechatWorkerCommand,
  payload: Record<string, unknown>,
): WechatWorkerRequest => {
  const request: WechatWorkerRequest = {
    protocolVersion: WECHAT_WORKER_PROTOCOL_VERSION,
    kind: 'request',
    generation,
    requestId,
    command,
    payload,
  };
  if (!isWechatWorkerRequest(request)) {
    throw new Error(`Invalid WeChat worker request: ${command}`);
  }
  return request;
};

const isConversation = (value: unknown): value is WechatWorkerConversation =>
  isRecord(value)
  && hasOnlyKeys(value, ['contactKey', 'displayName', 'remark', 'kind', 'lastMessageAt', 'unreadCount', 'preview', 'avatarMediaKey'])
  && isOpaqueKey(value.contactKey)
  && typeof value.displayName === 'string'
  && value.displayName.length > 0
  && value.displayName.length <= 256
  && (value.remark === undefined
    || (typeof value.remark === 'string' && value.remark.length <= 256))
  && (value.lastMessageAt === undefined || (typeof value.lastMessageAt === 'string'
    && value.lastMessageAt.length <= 64 && Number.isFinite(Date.parse(value.lastMessageAt))))
  && (value.unreadCount === undefined || (Number.isSafeInteger(value.unreadCount) && Number(value.unreadCount) >= 0))
  && (value.preview === undefined || (typeof value.preview === 'string' && value.preview.length <= 1024))
  && (value.avatarMediaKey === undefined || (typeof value.avatarMediaKey === 'string' && /^media_[a-f0-9]{64}$/u.test(value.avatarMediaKey)))
  && ['contact', 'group', 'official', 'other'].includes(String(value.kind));

export const isWechatEngineStartResult = (
  value: unknown,
): value is WechatEngineStartResult =>
  isRecord(value)
  && hasOnlyKeys(value, ['accountKey', 'conversations', 'nextConversationCursor', 'selfAvatarMediaKey'])
  && isOpaqueKey(value.accountKey)
  && (value.selfAvatarMediaKey === undefined || (typeof value.selfAvatarMediaKey === 'string' && /^media_[a-f0-9]{64}$/u.test(value.selfAvatarMediaKey)))
  && Array.isArray(value.conversations)
  && value.conversations.length <= 200
  && (value.nextConversationCursor === undefined
    || (isIdentifier(value.nextConversationCursor, MAX_CURSOR_LENGTH) && value.conversations.length > 0))
  && value.conversations.every(isConversation)
  && new Set(value.conversations.map((item) => item.contactKey)).size
    === value.conversations.length;

const isBoundedValue = (value: unknown, depth = 0, budget = { nodes: 0 }): boolean => {
  budget.nodes += 1;
  if (budget.nodes > 5000 || depth > 6) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return value.length <= MAX_TEXT_LENGTH;
  if (Array.isArray(value)) {
    return value.length <= 500
      && value.every((item) => isBoundedValue(item, depth + 1, budget));
  }
  if (!isRecord(value) || Object.keys(value).length > 64) return false;
  return Object.entries(value).every(([key, item]) =>
    key.length <= 128 && isBoundedValue(item, depth + 1, budget));
};

const isWorkerError = (value: unknown): value is WechatWorkerError =>
  isRecord(value)
  && hasOnlyKeys(value, ['code', 'message', 'retryable'])
  && isIdentifier(value.code, 64)
  && typeof value.message === 'string'
  && value.message.length > 0
  && value.message.length <= 500
  && typeof value.retryable === 'boolean';

const isHello = (value: Record<string, unknown>): boolean =>
  hasOnlyKeys(value, [
    'protocolVersion',
    'kind',
    'generation',
    'engineVersion',
    'resourceFingerprint',
    'capabilities',
  ])
  && isProtocolVersion(value.protocolVersion)
  && value.kind === 'hello'
  && isIdentifier(value.generation)
  && typeof value.engineVersion === 'string'
  && value.engineVersion.length > 0
  && value.engineVersion.length <= 64
  && typeof value.resourceFingerprint === 'string'
  && /^[a-f0-9]{64}$/u.test(value.resourceFingerprint)
  && Array.isArray(value.capabilities)
  && value.capabilities.length <= commands.length
  && value.capabilities.every(isCommand)
  && new Set(value.capabilities).size === value.capabilities.length;

const isResponse = (value: Record<string, unknown>): boolean => {
  if (!hasOnlyKeys(value, [
    'protocolVersion',
    'kind',
    'generation',
    'requestId',
    'ok',
    'result',
    'error',
  ])) return false;
  if (!isProtocolVersion(value.protocolVersion)
    || value.kind !== 'response'
    || !isIdentifier(value.generation)
    || !isIdentifier(value.requestId)
    || typeof value.ok !== 'boolean') return false;
  if (value.ok) {
    if (value.error !== undefined) return false;
    // Snapshot fields have their own fixed limits. Do not relax the generic
    // response budget merely because up to 500 messages carry optional metadata.
    if (isRecord(value.result) && ('messages' in value.result || 'contactKey' in value.result)) {
      return isMessagesSnapshotResult(value.result) || isMessagesHistoryResult(value.result);
    }
    return value.result === undefined || isBoundedValue(value.result);
  }
  return value.result === undefined && isWorkerError(value.error);
};

const isEngineStatePayload = (payload: Record<string, unknown>): boolean =>
  hasOnlyKeys(payload, ['state', 'detailCode'])
  && [
    'starting',
    'waiting-login',
    'ready',
    'streaming',
    'paused',
    'stopped',
    'backoff',
    'fatal',
  ].includes(
    String(payload.state),
  )
  && (payload.detailCode === undefined || isIdentifier(payload.detailCode, 64));

const isDeltaMessage = (value: unknown): boolean =>
  isRecord(value)
  && hasOnlyKeys(value, [
    'messageId',
    'accountKey',
    'contactKey',
    'direction',
    'messageType',
    'occurredAt',
    'sortSequence',
    'text',
    'mediaKey',
    'mediaKind',
    'mediaStatus',
    'attachmentKind',
    'senderAvatarMediaKey',
    'senderDisplayName',
    'voiceMediaKey',
  ])
  && isIdentifier(value.messageId, 256)
  && isOpaqueKey(value.accountKey)
  && isOpaqueKey(value.contactKey)
  && ['incoming', 'outgoing', 'system'].includes(String(value.direction))
  && ['text', 'image', 'voice', 'system', 'other'].includes(String(value.messageType))
  && (value.direction === 'system') === (value.messageType === 'system')
  && (value.senderAvatarMediaKey === undefined || (value.direction !== 'system' && typeof value.senderAvatarMediaKey === 'string' && /^media_[a-f0-9]{64}$/u.test(value.senderAvatarMediaKey)))
  && (value.senderDisplayName === undefined || (value.direction !== 'system' && typeof value.senderDisplayName === 'string' && value.senderDisplayName.length > 0 && value.senderDisplayName.length <= 256))
  && (value.voiceMediaKey === undefined || (value.messageType === 'voice' && typeof value.voiceMediaKey === 'string' && /^media_[a-f0-9]{64}$/u.test(value.voiceMediaKey)))
  && (value.mediaKey === undefined || (typeof value.mediaKey === 'string' && /^media_[a-f0-9]{64}$/u.test(value.mediaKey)))
  && (value.mediaKind === undefined || ['image', 'sticker'].includes(String(value.mediaKind)))
  && (value.mediaStatus === undefined || ['pending', 'ready', 'encrypted', 'missing', 'unsupported'].includes(String(value.mediaStatus)))
  && (value.attachmentKind === undefined || ['video', 'file', 'unknown'].includes(String(value.attachmentKind)))
  && typeof value.occurredAt === 'string'
  && value.occurredAt.length > 0
  && value.occurredAt.length <= 64
  && (value.sortSequence === undefined || isWechatSortSequence(value.sortSequence))
  && (value.text === undefined
    || (typeof value.text === 'string' && value.text.length <= MAX_TEXT_LENGTH));

const isMessagesSnapshotResult = (value: Record<string, unknown>): boolean =>
  hasOnlyKeys(value, ['contactKey', 'cursor', 'messages'])
  && isOpaqueKey(value.contactKey)
  && (value.cursor === undefined || isCursor(value.cursor))
  && Array.isArray(value.messages)
  && value.messages.length <= 500
  && value.messages.every((message) => isDeltaMessage(message)
    && isRecord(message) && message.contactKey === value.contactKey);

const isMessagesHistoryResult = (value: Record<string, unknown>): boolean =>
  hasOnlyKeys(value, ['contactKey', 'nextCursor', 'messages', 'done'])
  && isOpaqueKey(value.contactKey) && typeof value.done === 'boolean'
  && (value.done ? value.nextCursor === undefined : isIdentifier(value.nextCursor, MAX_CURSOR_LENGTH))
  && Array.isArray(value.messages) && value.messages.length <= 200
  && value.messages.every((message) => isDeltaMessage(message)
    && isRecord(message) && message.contactKey === value.contactKey);

const isDeltaPayload = (payload: Record<string, unknown>): boolean =>
  hasOnlyKeys(payload, [
    'subscriptionId',
    'batchId',
    'baseCursor',
    'nextCursor',
    'messages',
  ])
  && isIdentifier(payload.subscriptionId)
  && isIdentifier(payload.batchId)
  && (payload.baseCursor === undefined || isCursor(payload.baseCursor))
  && isCursor(payload.nextCursor)
  && Array.isArray(payload.messages)
  && payload.messages.length <= MAX_BATCH_MESSAGES
  && payload.messages.every(isDeltaMessage);

const isCursorInvalidatedPayload = (payload: Record<string, unknown>): boolean =>
  hasOnlyKeys(payload, ['accountKey', 'reason'])
  && isOpaqueKey(payload.accountKey)
  && ['database-reset', 'shard-changed', 'cursor-expired'].includes(String(payload.reason));

const isEvent = (value: Record<string, unknown>): boolean => {
  if (!hasOnlyKeys(value, [
    'protocolVersion',
    'kind',
    'generation',
    'sequence',
    'event',
    'payload',
  ])) return false;
  if (!isProtocolVersion(value.protocolVersion)
    || value.kind !== 'event'
    || !isIdentifier(value.generation)
    || !Number.isSafeInteger(value.sequence)
    || Number(value.sequence) < 1
    || !isRecord(value.payload)) return false;
  switch (value.event) {
    case 'engine.state':
      return isEngineStatePayload(value.payload);
    case 'messages.delta':
      return isDeltaPayload(value.payload);
    case 'cursor.invalidated':
      return isCursorInvalidatedPayload(value.payload);
    default:
      return false;
  }
};

export const isWechatWorkerIncomingMessage = (
  value: unknown,
): value is WechatWorkerIncomingMessage => {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case 'hello':
      return isHello(value);
    case 'response':
      return isResponse(value);
    case 'event':
      return isEvent(value);
    default:
      return false;
  }
};
