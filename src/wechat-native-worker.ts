import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, realpath, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import { compareWechatMessageOrder } from './shared/wechat-message-order';
import {
  createAccountKey, normalizeWechatAccountName, parseWechatTasklistPids,
  type NativeConversation, type NativeMessage,
} from './main/adapters/wechat-native/native-normalize';
import { probeWechatNativeResources } from './main/adapters/wechat-native/probe';
import adapterRuntime from './main/adapters/wechat-native/adapter-runtime-data.json';
import { OPEN_WECHAT_READER_MANIFEST } from './main/adapters/wechat-native/manifest';
import {
  loadSqliteReader, SqliteReaderError, type SqliteReader, type SqliteReadOnlyDatabase,
} from './main/adapters/wechat-native/sqlite-reader';
import {
  findWechatDatabaseFiles, WechatDatabaseFileError,
} from './main/adapters/wechat-native/wechat-database-files';
import {
  openReadonlyWechatProcess, scanWechatDatabaseKeys, WechatMemoryReadError,
} from './main/adapters/wechat-native/wechat-readonly-memory';
import {
  WechatMessageStore, WechatMessageStoreError, type WechatHistoryPosition,
} from './main/adapters/wechat-native/wechat-message-store';
import { NativeWechatMediaStore } from './main/adapters/wechat-native/wechat-media-store';
import { WechatImageCryptoProvider } from './main/adapters/wechat-native/wechat-image-crypto';
import { NativeMediaTransfer } from './main/adapters/wechat-native/native-media-transfer';
import { MAX_WECHAT_VOICE_BYTES, NativeWechatVoiceStore } from './main/adapters/wechat-native/wechat-voice-store';
import {
  WechatConversationPages, WechatConversationPageError,
} from './main/adapters/wechat-native/wechat-conversation-pages';
import {
  readUnseenWechatMessages, WechatStreamPageError,
} from './main/adapters/wechat-native/wechat-stream-page';
import {
  isWechatWorkerRequest, unwrapWechatWorkerMessageEvent, WECHAT_WORKER_PROTOCOL_VERSION,
  type WechatWorkerCommand, type WechatWorkerEvent, type WechatWorkerHello,
  type WechatWorkerRequest, type WechatWorkerResponse,
} from './shared/wechat-worker-protocol';

const execFileAsync = promisify(execFile);
const CAPABILITIES = [
  'engine.start', 'conversations.list', 'messages.snapshot', 'messages.history', 'media.read', 'voice.read', 'stream.subscribe', 'stream.pause', 'batch.ack', 'engine.stop',
] as const satisfies readonly WechatWorkerCommand[];
const MAX_SNAPSHOT_MESSAGES = 500;
const BASELINE_MESSAGES = 100;
const MAX_BATCH_MESSAGES = 200;
const MAX_CURSOR_RECORDS = 64;
const MAX_SEEN_MESSAGES = 5000;
const POLL_MS = 2000;
type KoffiModule = typeof import('koffi');

interface ReaderRuntime {
  readonly koffi: KoffiModule;
  readonly reader: SqliteReader;
}
interface AccountConnection {
  readonly accountKey: string;
  readonly accountName: string;
  readonly store: WechatMessageStore;
  readonly databases: readonly SqliteReadOnlyDatabase[];
  readonly media: NativeWechatMediaStore;
  readonly mediaTransfer: NativeMediaTransfer;
  readonly imageCrypto: WechatImageCryptoProvider;
  readonly voice: NativeWechatVoiceStore;
  readonly voiceTransfer: NativeMediaTransfer;
}
interface HistoryCursorRecord {
  readonly accountKey: string;
  readonly contactKey: string;
  readonly from: number;
  readonly to: number;
  readonly after: WechatHistoryPosition;
}
interface CursorRecord {
  readonly accountKey: string;
  readonly contactKeys: readonly string[];
  readonly seenIds: readonly string[];
  readonly emptyContactKeys: readonly string[];
}
interface Subscription {
  readonly subscriptionId: string;
  readonly accountKey: string;
  readonly contactKeys: readonly string[];
  seenIds: Set<string>;
  seenOrder: string[];
  emptyContactKeys: string[];
  cursor: string;
  invalidated?: boolean;
  pending?: {
    readonly batchId: string;
    readonly cursor: string;
    readonly record: CursorRecord;
  };
}

class WorkerFailure extends Error {
  constructor(readonly code: string, message: string, readonly retryable: boolean) {
    super(message);
    this.name = 'WorkerFailure';
  }
}

const generation = String(process.env.WECHAT_WORKER_GENERATION || '').trim();
const parentPort = process.parentPort;
let eventSequence = 0;
let runtime: ReaderRuntime | undefined;
let readOnlySelfTestPassed = false;
let connection: AccountConnection | undefined;
let conversationsByKey = new Map<string, NativeConversation>();
let conversationPages: WechatConversationPages | undefined;
let startInFlight: Promise<Record<string, unknown>> | undefined;
let stopRequested = false;
let stopEpoch = 0;
let pollTimer: ReturnType<typeof setInterval> | undefined;
let changePollTimer: ReturnType<typeof setTimeout> | undefined;
let pollInFlight = false;
let pollFailed = false;
const subscriptions = new Map<string, Subscription>();
const historyCursors = new Map<string, HistoryCursorRecord>();
const cursorRecords = new Map<string, CursorRecord>();
const fingerprint = createHash('sha256')
  .update(JSON.stringify({ manifest: OPEN_WECHAT_READER_MANIFEST, adapterRuntime })).digest('hex');

const post = (message: WechatWorkerHello | WechatWorkerResponse | WechatWorkerEvent): void => {
  parentPort.postMessage(message);
};
const emitState = (
  state: 'starting' | 'ready' | 'streaming' | 'paused' | 'stopped' | 'backoff' | 'fatal',
  detailCode?: string,
): void => {
  post({
    protocolVersion: WECHAT_WORKER_PROTOCOL_VERSION, kind: 'event', generation,
    sequence: ++eventSequence, event: 'engine.state',
    payload: { state, ...(detailCode ? { detailCode } : {}) },
  });
};
const emitCursorInvalidated = (accountKey: string): void => {
  post({
    protocolVersion: WECHAT_WORKER_PROTOCOL_VERSION, kind: 'event', generation,
    sequence: ++eventSequence, event: 'cursor.invalidated',
    payload: { accountKey, reason: 'cursor-expired' },
  });
};
const responseOk = (requestId: string, result?: unknown): void => {
  post({
    protocolVersion: WECHAT_WORKER_PROTOCOL_VERSION, kind: 'response', generation, requestId,
    ok: true, ...(result === undefined ? {} : { result }),
  });
};
const responseError = (requestId: string, error: WorkerFailure): void => {
  post({
    protocolVersion: WECHAT_WORKER_PROTOCOL_VERSION, kind: 'response', generation, requestId,
    ok: false, error: { code: error.code, message: error.message, retryable: error.retryable },
  });
};
const asFailure = (error: unknown): WorkerFailure => {
  if (error instanceof WorkerFailure) return error;
  if (error instanceof WechatMessageStoreError) {
    return new WorkerFailure(error.code, error.message, error.retryable);
  }
  if (error instanceof WechatConversationPageError) {
    return new WorkerFailure(error.code, error.message, error.code === 'conversations.cursorExpired');
  }
  if (error instanceof WechatMemoryReadError || error instanceof WechatDatabaseFileError
    || error instanceof SqliteReaderError || error instanceof WechatStreamPageError) {
    return new WorkerFailure(error.code, '微信只读连接尚未完成，请查看连接状态',
      !['account.invalid', 'database.missing', 'database.schema', 'key.adapter'].includes(error.code));
  }
  return new WorkerFailure('engine.unavailable', '微信数据引擎暂时不可用', true);
};
const runStage = async <T>(code: string, task: () => Promise<T> | T): Promise<T> => {
  try { return await task(); } catch (error) {
    const failure = asFailure(error);
    if (failure.code !== 'engine.unavailable') throw failure;
    throw new WorkerFailure(code, '微信只读连接尚未完成，请查看连接状态', true);
  }
};
const requireAbsoluteEnv = (name: string): string => {
  const value = String(process.env[name] || '').trim();
  if (!value || !path.isAbsolute(value)) {
    throw new WorkerFailure('configuration.missing', '本地数据源尚未配置', false);
  }
  return path.resolve(value);
};
const verifyFile = async (filePath: string, expected: { readonly size: number; readonly sha256: string }): Promise<void> => {
  const fileStat = await stat(filePath);
  if (!fileStat.isFile() || fileStat.size !== expected.size
    || createHash('sha256').update(await readFile(filePath)).digest('hex') !== expected.sha256) {
    throw new WorkerFailure('resource.invalid', '本地读取组件校验失败', false);
  }
};

const loadReaderRuntime = async (): Promise<ReaderRuntime> => {
  if (runtime) return runtime;
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new WorkerFailure('platform.unsupported', '本地微信读取仅支持 Windows x64', false);
  }
  const resourceRoot = requireAbsoluteEnv('WECHAT_NATIVE_RESOURCE_ROOT');
  const koffiNodePath = requireAbsoluteEnv('WECHAT_KOFFI_NODE_PATH');
  if (!(await probeWechatNativeResources(resourceRoot)).available) {
    throw new WorkerFailure('resource.invalid', '本地读取组件校验失败', false);
  }
  await verifyFile(koffiNodePath, adapterRuntime);
  const koffi = createRequire(__filename)(koffiNodePath) as KoffiModule;
  const reader = loadSqliteReader(koffi, path.join(resourceRoot, 'sqlite3mc.dll'));
  if (reader.version() !== '2.5.1') {
    throw new WorkerFailure('resource.invalid', '本地读取组件版本不符', false);
  }
  reader.preflight();
  readOnlySelfTestPassed = true;
  runtime = { koffi, reader };
  return runtime;
};

const findWechatPids = async (): Promise<number[]> => {
  try {
    const { stdout } = await execFileAsync(
      path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tasklist.exe'),
      ['/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 5000, encoding: 'utf8', maxBuffer: 1024 * 1024 },
    );
    return parseWechatTasklistPids(String(stdout));
  } catch {
    throw new WorkerFailure('wechat.processScan', '无法检查微信运行状态', true);
  }
};
const closeDatabases = (databases: readonly SqliteReadOnlyDatabase[]): void => {
  for (const database of databases) {
    try { database.close(); } catch { /* Continue closing the remaining read-only handles. */ }
  }
};
const updateConversationIndex = (accountKey: string, store: WechatMessageStore): void => {
  const next = store.listConversations();
  const pages = new WechatConversationPages(accountKey, next);
  conversationsByKey = new Map(next.map((item) => [item.contactKey, item]));
  conversationPages = pages;
};
const connectedResult = (): Record<string, unknown> => {
  if (!conversationPages) throw new WorkerFailure('engine.notReady', '微信数据引擎尚未就绪', true);
  return conversationPageWithAvatars(conversationPages.page());
};

const conversationPageWithAvatars = (page: ReturnType<WechatConversationPages['page']>): Record<string, unknown> => {
  const selfAvatar = connection?.media.getAvatar(connection.accountName);
  return { ...page, ...(selfAvatar?.status === 'ready' ? { selfAvatarMediaKey: selfAvatar.mediaKey } : {}),
    conversations: page.conversations.map((item) => {
    const username = conversationsByKey.get(item.contactKey)?.username;
    const avatar = username ? connection?.media.getAvatar(username) : undefined;
    return { ...item, ...(avatar?.status === 'ready' ? { avatarMediaKey: avatar.mediaKey } : {}) };
    }),
  };
};

const startEngine = async (providedProcessIds: readonly number[], queuedStopEpoch: number): Promise<Record<string, unknown>> => {
  if (queuedStopEpoch !== stopEpoch) throw new WorkerFailure('engine.stopped', '已停止连接', false);
  if (connection) return connectedResult();
  if (startInFlight) return startInFlight;
  stopRequested = false;
  startInFlight = (async () => {
    emitState('starting');
    const accountRoot = await runStage('account.invalid', () => realpath(requireAbsoluteEnv('WECHAT_ACCOUNT_ROOT')));
    const files = await runStage('database.missing', () => findWechatDatabaseFiles(accountRoot));
    const opened: SqliteReadOnlyDatabase[] = [];
    let keys: Map<string, Buffer> | undefined;
    let media: NativeWechatMediaStore | undefined;
    let imageCrypto: WechatImageCryptoProvider | undefined;
    let voice: NativeWechatVoiceStore | undefined;
    try {
      const native = await runStage('resource.load', loadReaderRuntime);
      const detected = await findWechatPids();
      const pids = [...new Set([...providedProcessIds.filter((pid) => detected.includes(pid)), ...detected])];
      keys = await scanWechatDatabaseKeys(
        (pid) => openReadonlyWechatProcess(native.koffi, pid), pids, files,
        { cancelled: () => stopRequested },
      );
      // Missing historical shards must not silently look like complete history.
      if (files.some((file) => ['session', 'contact', 'message'].includes(file.kind) && !keys?.has(file.id))) {
        throw new WorkerFailure('key.incomplete', '部分微信数据库尚未通过只读校验，未开始消息读取', true);
      }
      const sources = [];
      for (const file of files) {
        const key = keys.get(file.id);
        if (!key) continue;
        try {
          const db = native.reader.openReadOnly(file.path, key);
          opened.push(db);
          sources.push({ id: file.id, kind: file.kind, db });
        } catch (error) {
          if (['session', 'contact', 'message'].includes(file.kind)) throw error;
        } finally { key.fill(0); }
      }
      const accountKey = createAccountKey(accountRoot);
      const accountName = normalizeWechatAccountName(path.basename(accountRoot));
      // Optional image keys are acquired only when a visible image is requested.
      imageCrypto = new WechatImageCryptoProvider({
        accountName,
        open: (pid) => openReadonlyWechatProcess(native.koffi, pid),
        discoverProcessIds: findWechatPids,
      });
      media = new NativeWechatMediaStore({ databases: sources, accountRoot, imageDecoder: imageCrypto });
      voice = new NativeWechatVoiceStore(sources);
      const accountMedia = media;
      const accountVoice = voice;
      const store = new WechatMessageStore({
        databases: sources, accountKey,
        accountName,
        registerAvatar: (username) => {
          const avatar = accountMedia.getAvatar(username);
          return avatar?.status === 'ready' ? avatar.mediaKey : undefined;
        },
        registerVoice: (username, identity) => accountVoice.registerMessageVoice(username, identity)?.mediaKey,
        registerMedia: (username, type, xml, packedInfo) => {
          const ref = accountMedia.registerMessageMedia(username, type, xml, packedInfo);
          return ref ? { mediaKey: ref.mediaKey, mediaKind: ref.kind === 'emoji' ? 'sticker' : 'image', mediaStatus: ref.status } : undefined;
        },
      });
      updateConversationIndex(accountKey, store);
      if (stopRequested) throw new WorkerFailure('engine.stopped', '已停止连接', false);
      connection = { accountKey, accountName, store, databases: opened, media, mediaTransfer: new NativeMediaTransfer(media), imageCrypto,
        voice, voiceTransfer: new NativeMediaTransfer({
          readMedia: async (key) => {
            const result = accountVoice.readVoice(key);
            return result ? { bytes: result.bytes, mimeType: result.format === 'wav' ? 'audio/wav' : 'audio/x-silk' } : undefined;
          },
          getMediaRef: (key) => accountVoice.getVoiceRef(key),
        }, { mimeTypes: ['audio/wav', 'audio/x-silk'], maxBytes: MAX_WECHAT_VOICE_BYTES }),
      };
      emitState('ready');
      return connectedResult();
    } finally {
      for (const key of keys?.values() ?? []) key.fill(0);
      for (const file of files) file.pageOne.fill(0);
      if (!connection) {
        media?.dispose();
        imageCrypto?.dispose();
        voice?.dispose();
        closeDatabases(opened);
      }
    }
  })();
  try { return await startInFlight; } finally { startInFlight = undefined; }
};

const requireAccount = (accountKey: unknown): AccountConnection => {
  if (!connection) throw new WorkerFailure('engine.notReady', '微信数据引擎尚未就绪', true);
  if (accountKey !== connection.accountKey) throw new WorkerFailure('account.unknown', '账号标识已失效', false);
  return connection;
};
const queryMessages = (contactKey: string, limit: number, offset = 0): NativeMessage[] => {
  if (!connection) throw new WorkerFailure('engine.notReady', '微信数据引擎尚未就绪', true);
  const conversation = conversationsByKey.get(contactKey);
  if (!conversation) throw new WorkerFailure('contact.unknown', '会话标识已失效', false);
  return connection.store.readMessages(conversation.username, Math.min(MAX_SNAPSHOT_MESSAGES, Math.max(1, limit)), offset);
};
const rememberCursor = (record: CursorRecord): string => {
  const cursor = `cursor:${randomUUID()}`;
  cursorRecords.set(cursor, record);
  while (cursorRecords.size > MAX_CURSOR_RECORDS) {
    const oldest = cursorRecords.keys().next().value as string | undefined;
    if (oldest) cursorRecords.delete(oldest);
  }
  return cursor;
};
const appendSeen = (seenIds: readonly string[], messages: readonly NativeMessage[]): string[] =>
  [...new Set([...seenIds, ...messages.map((message) => message.messageId)])].slice(-MAX_SEEN_MESSAGES);
const sortMessages = (messages: NativeMessage[]): NativeMessage[] => messages.sort((left, right) =>
  compareWechatMessageOrder(left.occurredAt, right.occurredAt, left.sortSequence, right.sortSequence));
const stopPolling = (): void => {
  if (pollTimer) clearInterval(pollTimer);
  if (changePollTimer) clearTimeout(changePollTimer);
  pollTimer = undefined;
  changePollTimer = undefined;
};
const cleanupEngine = (): void => {
  stopRequested = true;
  stopPolling();
  subscriptions.clear();
  cursorRecords.clear();
  historyCursors.clear();
  conversationsByKey.clear();
  conversationPages = undefined;
  connection?.mediaTransfer.dispose();
  connection?.media.dispose();
  connection?.imageCrypto.dispose();
  connection?.voiceTransfer.dispose();
  connection?.voice.dispose();
  if (connection) closeDatabases(connection.databases);
  connection = undefined;
};

const pollSubscriptions = (): void => {
  if (pollInFlight || !connection || subscriptions.size === 0) return;
  pollInFlight = true;
  try {
    for (const subscription of subscriptions.values()) {
      // One unacknowledged batch only: no loss of progress and bounded memory.
      if (subscription.pending || subscription.invalidated) continue;
      const delta: NativeMessage[] = [];
      try {
        for (const contactKey of subscription.contactKeys) {
          delta.push(...readUnseenWechatMessages(
            (limit, offset) => queryMessages(contactKey, limit, offset),
            subscription.seenIds, subscription.emptyContactKeys.includes(contactKey),
          ));
        }
      } catch (error) {
        if (error instanceof WechatStreamPageError || (error instanceof WechatMessageStoreError
          && error.code === 'database.scanLimit')) {
          subscription.invalidated = true;
          emitCursorInvalidated(subscription.accountKey);
          continue;
        }
        throw error;
      }
      const batch = sortMessages(delta).slice(0, MAX_BATCH_MESSAGES);
      if (!batch.length) continue;
      const record: CursorRecord = {
        accountKey: subscription.accountKey, contactKeys: subscription.contactKeys,
        seenIds: appendSeen(subscription.seenOrder, batch),
        emptyContactKeys: subscription.emptyContactKeys.filter((key) => !batch.some((message) => message.contactKey === key)),
      };
      const nextCursor = rememberCursor(record);
      const batchId = `batch:${randomUUID()}`;
      subscription.pending = { batchId, cursor: nextCursor, record };
      post({
        protocolVersion: WECHAT_WORKER_PROTOCOL_VERSION, kind: 'event', generation,
        sequence: ++eventSequence, event: 'messages.delta',
        payload: {
          subscriptionId: subscription.subscriptionId, batchId,
          baseCursor: subscription.cursor, nextCursor, messages: batch,
        },
      });
    }
    if (pollFailed) emitState('streaming');
    pollFailed = false;
  } catch (error) {
    pollFailed = true;
    emitState('backoff', asFailure(error).code);
  } finally { pollInFlight = false; }
};
const queuePoll = (): void => {
  if (changePollTimer || subscriptions.size === 0) return;
  changePollTimer = setTimeout(() => {
    changePollTimer = undefined;
    pollSubscriptions();
  }, 0);
};

const handleSnapshot = (request: WechatWorkerRequest): Record<string, unknown> => {
  const accountKey = String(request.payload.accountKey);
  const contactKey = String(request.payload.contactKey);
  requireAccount(accountKey);
  const limit = Math.min(MAX_SNAPSHOT_MESSAGES, Number(request.payload.limit));
  let previous: CursorRecord | undefined;
  if (typeof request.payload.cursor === 'string') {
    previous = cursorRecords.get(request.payload.cursor);
    if (!previous || previous.accountKey !== accountKey
      || previous.contactKeys.length !== 1 || previous.contactKeys[0] !== contactKey) {
      throw new WorkerFailure('cursor.expired', '消息游标已失效', true);
    }
  }
  const messages = previous
    ? sortMessages(readUnseenWechatMessages(
      (size, offset) => queryMessages(contactKey, size, offset),
      new Set(previous.seenIds), previous.emptyContactKeys.includes(contactKey),
    )).slice(0, limit)
    : queryMessages(contactKey, limit);
  const cursor = rememberCursor({
    accountKey, contactKeys: [contactKey], seenIds: appendSeen(previous?.seenIds ?? [], messages),
    emptyContactKeys: messages.length > 0 || (previous && !previous.emptyContactKeys.includes(contactKey)) ? [] : [contactKey],
  });
  return { contactKey, cursor, messages };
};

const handleConversations = (request: WechatWorkerRequest): Record<string, unknown> => {
  const account = requireAccount(request.payload.accountKey);
  const cursor = typeof request.payload.cursor === 'string' ? request.payload.cursor : undefined;
  if (cursor === undefined) updateConversationIndex(account.accountKey, account.store);
  if (!conversationPages) throw new WorkerFailure('engine.notReady', '微信数据引擎尚未就绪', true);
  return conversationPageWithAvatars(conversationPages.page(Number(request.payload.limit), cursor));
};

const handleHistory = (request: WechatWorkerRequest): Record<string, unknown> => {
  const account = requireAccount(request.payload.accountKey);
  const contactKey = String(request.payload.contactKey);
  const conversation = conversationsByKey.get(contactKey);
  if (!conversation) throw new WorkerFailure('contact.unknown', '会话标识已失效', false);
  const from = Number(request.payload.from), to = Number(request.payload.to);
  const cursor = typeof request.payload.cursor === 'string' ? request.payload.cursor : undefined;
  const previous = cursor ? historyCursors.get(cursor) : undefined;
  if (cursor && (!previous || previous.accountKey !== account.accountKey || previous.contactKey !== contactKey || previous.from !== from || previous.to !== to)) {
    throw new WorkerFailure('cursor.expired', '历史导出游标已失效，请重新导出', false);
  }
  const page = account.store.readHistoryPage(conversation.username, Number(request.payload.limit), { from, to, after: previous?.after });
  if (!page.done && !page.after) throw new WorkerFailure('database.pagination', '历史消息分页未完成', false);
  let nextCursor: string | undefined;
  if (!page.done && page.after) {
    nextCursor = `history:${randomUUID()}`;
    historyCursors.set(nextCursor, { accountKey: account.accountKey, contactKey, from, to, after: page.after });
  }
  if (cursor) historyCursors.delete(cursor);
  while (historyCursors.size > 64) historyCursors.delete(historyCursors.keys().next().value as string);
  return { contactKey, messages: page.messages, done: page.done, ...(nextCursor ? { nextCursor } : {}) };
};

const handleSubscribe = (request: WechatWorkerRequest): Record<string, unknown> => {
  const accountKey = String(request.payload.accountKey);
  requireAccount(accountKey);
  const contactKeys = [...new Set(request.payload.contactKeys as string[])].slice(0, 50);
  for (const key of contactKeys) {
    if (!conversationsByKey.has(key)) throw new WorkerFailure('contact.unknown', '会话标识已失效', false);
  }
  let record = typeof request.payload.cursor === 'string' ? cursorRecords.get(request.payload.cursor) : undefined;
  if (record && (record.accountKey !== accountKey || record.contactKeys.join('\0') !== contactKeys.join('\0'))) record = undefined;
  const staleCursor = typeof request.payload.cursor === 'string' && !record;
  if (!record) {
    const seenIds: string[] = [];
    const emptyContactKeys: string[] = [];
    for (const key of contactKeys) {
      const messages = queryMessages(key, BASELINE_MESSAGES);
      seenIds.push(...messages.map((message) => message.messageId));
      if (!messages.length) emptyContactKeys.push(key);
    }
    record = { accountKey, contactKeys, seenIds: [...new Set(seenIds)].slice(-MAX_SEEN_MESSAGES), emptyContactKeys };
  }
  const subscription: Subscription = {
    subscriptionId: `subscription:${randomUUID()}`, accountKey, contactKeys,
    seenIds: new Set(record.seenIds), seenOrder: [...record.seenIds],
    emptyContactKeys: [...record.emptyContactKeys], cursor: rememberCursor(record),
  };
  subscriptions.set(subscription.subscriptionId, subscription);
  if (!pollTimer) pollTimer = setInterval(pollSubscriptions, POLL_MS);
  emitState('streaming');
  if (staleCursor) {
    // Respond first, so the parent can pause this exact subscription before reset.
    subscription.invalidated = true;
    setTimeout(() => {
      if (subscriptions.has(subscription.subscriptionId)) emitCursorInvalidated(accountKey);
    }, 0);
  }
  return { subscriptionId: subscription.subscriptionId, cursor: subscription.cursor };
};
const handlePause = (request: WechatWorkerRequest): Record<string, never> => {
  if (!subscriptions.delete(String(request.payload.subscriptionId))) {
    throw new WorkerFailure('subscription.unknown', '订阅标识已失效', false);
  }
  if (subscriptions.size === 0) stopPolling();
  emitState(subscriptions.size === 0 ? 'paused' : 'streaming');
  return {};
};
const handleBatchAck = (request: WechatWorkerRequest): Record<string, never> => {
  const subscription = subscriptions.get(String(request.payload.subscriptionId));
  const pending = subscription?.pending;
  if (!subscription || !pending || pending.batchId !== request.payload.batchId || pending.cursor !== request.payload.cursor) {
    throw new WorkerFailure('batch.unknown', '消息批次标识已失效', false);
  }
  subscription.cursor = pending.cursor;
  subscription.seenOrder = [...pending.record.seenIds];
  subscription.seenIds = new Set(pending.record.seenIds);
  subscription.emptyContactKeys = [...pending.record.emptyContactKeys];
  subscription.pending = undefined;
  queuePoll();
  return {};
};

const handleRequest = async (request: WechatWorkerRequest, queuedStopEpoch: number): Promise<void> => {
  try {
    switch (request.command) {
      case 'engine.start':
        responseOk(request.requestId, await startEngine(Array.isArray(request.payload.processIds) ? request.payload.processIds.map(Number) : [], queuedStopEpoch));
        return;
      case 'messages.snapshot': responseOk(request.requestId, handleSnapshot(request)); return;
      case 'messages.history': responseOk(request.requestId, handleHistory(request)); return;
      case 'conversations.list': responseOk(request.requestId, handleConversations(request)); return;
      case 'media.read': {
        const account = requireAccount(request.payload.accountKey);
        responseOk(request.requestId, await account.mediaTransfer.read(String(request.payload.mediaKey), Number(request.payload.offset)));
        return;
      }
      case 'voice.read': {
        const account = requireAccount(request.payload.accountKey);
        responseOk(request.requestId, await account.voiceTransfer.read(String(request.payload.mediaKey), Number(request.payload.offset)));
        return;
      }
      case 'stream.subscribe': responseOk(request.requestId, handleSubscribe(request)); return;
      case 'stream.pause': responseOk(request.requestId, handlePause(request)); return;
      case 'batch.ack': responseOk(request.requestId, handleBatchAck(request)); return;
      case 'engine.stop': cleanupEngine(); emitState('stopped'); responseOk(request.requestId, {}); return;
      default: throw new WorkerFailure('protocol.unsupported', '不支持的引擎命令', false);
    }
  } catch (error) {
    const failure = asFailure(error);
    if (request.command === 'engine.start') emitState('backoff', failure.code);
    responseError(request.requestId, failure);
  }
};
process.once('exit', cleanupEngine);
process.once('SIGTERM', () => { cleanupEngine(); process.exit(0); });

if (!/^[a-zA-Z0-9._:-]{1,96}$/u.test(generation)) {
  process.exit(1);
} else if (process.env.WECHAT_WORKER_PREFLIGHT === '1') {
  // Same packaged worker and dependencies, but no account lookup or WeChat handle.
  const report = (ok: boolean, code?: string): void => {
    parentPort.postMessage({
      kind: 'native-preflight', ok, ...(code ? { code } : {}),
      reader: { implementation: 'sqlite3mc', version: '2.5.1', readOnlySelfTestPassed },
      runtime: {
        electron: process.versions.electron, node: process.versions.node, v8: process.versions.v8,
        architecture: process.arch, processType: process.type,
      },
      openedDatabase: false, requestedLoginKey: false,
    });
  };
  void runStage('resource.load', loadReaderRuntime).then(() => report(true))
    .catch((error: unknown) => report(false, asFailure(error).code));
} else {
  let requestQueue = Promise.resolve();
  parentPort.on('message', (messageEvent: unknown) => {
    const value = unwrapWechatWorkerMessageEvent(messageEvent);
    if (!isWechatWorkerRequest(value) || value.generation !== generation) {
      emitState('fatal', 'protocol.invalid'); return;
    }
    if (value.command === 'engine.stop') { stopRequested = true; stopEpoch += 1; }
    const queuedStopEpoch = stopEpoch;
    // Optional media I/O must not hold up text polling, conversation changes or stop.
    if (value.command === 'media.read' || value.command === 'voice.read') {
      void handleRequest(value, queuedStopEpoch);
      return;
    }
    requestQueue = requestQueue.then(() => handleRequest(value, queuedStopEpoch));
  });
  // Handshake precedes any slow credential scan; the host can cancel the worker.
  post({
    protocolVersion: WECHAT_WORKER_PROTOCOL_VERSION, kind: 'hello', generation,
    engineVersion: '0.4.1', resourceFingerprint: fingerprint, capabilities: CAPABILITIES,
  });
}
