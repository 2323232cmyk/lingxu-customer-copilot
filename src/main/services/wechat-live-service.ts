import path from 'node:path';
import { isWechatSortSequence } from '../../shared/wechat-message-order';
import { isSalesWechatConversation } from '../../shared/wechat-conversation-policy';
import type {
  WechatLiveConversation,
  WechatLiveDelta,
  WechatLiveEngineState,
  WechatLiveMessage,
  WechatLiveSnapshot,
  WechatLiveStatus,
  WechatMediaResult,
} from '../../shared/contracts';
import {
  isWechatEngineStartResult,
  type WechatWorkerCommand,
  type WechatWorkerEvent,
} from '../../shared/wechat-worker-protocol';
import {
  createLiveWechatWorkerSpawn,
  WechatEngineManager,
  WechatWorkerCommandError,
  type WechatEngineManagerSnapshot,
} from '../adapters/wechat-native';
import { findWechatProcessIds } from './wechat-processes';
import { WechatMediaBridge } from './wechat-media-bridge';
import { WechatVoiceBridge } from './wechat-voice-bridge';

const PUBLIC_ERROR = '微信数据暂时不可用，请稍后重试';
const START_CANCELLED = '微信实时读取启动已取消';
const SELECTION_CANCELLED = '会话切换已取消，请重新选择会话';
const LIST_CANCELLED = '会话列表读取已取消，请重新刷新';
const HISTORY_CANCELLED = '历史导出已取消或微信账号已切换，请重新导出';
const HISTORY_LIMIT = '历史导出超过单次安全范围，未完成导出；请按日期分段导出';
const MAX_SEEN_MESSAGES = 20_000;
const MAX_SNAPSHOT_CURSORS = 8;

export interface WechatEngineController {
  getSnapshot(): WechatEngineManagerSnapshot;
  subscribeState(listener: (snapshot: WechatEngineManagerSnapshot) => void): () => void;
  subscribeEvents(listener: (event: WechatWorkerEvent) => void): () => void;
  start(): Promise<void>;
  stop(): void;
  request(
    command: WechatWorkerCommand,
    payload: Record<string, unknown>,
    timeoutOverrideMs?: number,
  ): Promise<unknown>;
}

export interface WechatLiveServiceOptions {
  readonly accountRoot: string;
  readonly manager?: WechatEngineController;
  readonly now?: () => Date;
  readonly processIds?: () => Promise<readonly number[]>;
}

interface WorkerMessage {
  readonly messageId: string;
  readonly accountKey: string;
  readonly contactKey: string;
  readonly direction: WechatLiveMessage['direction'];
  readonly messageType: 'text' | 'image' | 'voice' | 'system' | 'other';
  readonly occurredAt: string;
  readonly sortSequence?: string;
  readonly text?: string;
  readonly mediaKey?: string;
  readonly mediaKind?: WechatLiveMessage['mediaKind'];
  readonly mediaStatus?: WechatLiveMessage['mediaStatus'];
  readonly attachmentKind?: WechatLiveMessage['attachmentKind'];
  readonly senderAvatarMediaKey?: string;
  readonly senderDisplayName?: string;
  readonly voiceMediaKey?: string;
}

interface WorkerDelta {
  readonly subscriptionId: string;
  readonly batchId: string;
  readonly baseCursor?: string;
  readonly nextCursor: string;
  readonly messages: readonly WorkerMessage[];
}

interface SubscriptionResult {
  readonly subscriptionId: string;
  readonly cursor?: string;
}

interface MessagesSnapshotResult {
  readonly contactKey: string;
  readonly cursor?: string;
  readonly messages: readonly WorkerMessage[];
}

interface MessagesHistoryResult {
  readonly contactKey: string;
  readonly nextCursor?: string;
  readonly done: boolean;
  readonly messages: readonly WorkerMessage[];
}

type WorkerEngineState =
  | 'starting'
  | 'waiting-login'
  | 'ready'
  | 'streaming'
  | 'paused'
  | 'stopped'
  | 'backoff'
  | 'fatal';

export class WechatLiveServiceError extends Error {
  constructor(message = PUBLIC_ERROR) {
    super(message);
    this.name = 'WechatLiveServiceError';
  }
}

const publicWorkerError = (code: string): string | undefined => {
  switch (code) {
    case 'wechat.offline':
    case 'wechat.notRunning':
      return '未检测到正在运行的微信客户端';
    case 'wechat.processScan':
      return '无法检查微信运行状态，请重新启动本软件';
    case 'key.unavailable':
    case 'key.notFound':
      return '尚未找到通过校验的微信读取凭证，数据验证未完成；不能据此判定账号目录选错';
    case 'key.accessDenied':
      return '当前微信进程拒绝访问，请确认本软件与微信使用同一 Windows 用户及相同运行权限';
    case 'key.hookFailed':
      return '微信读取组件未能连接到微信进程，请检查当前微信版本的兼容性';
    case 'key.waitTimeout':
    case 'key.scanTimeout':
      return '微信只读校验已超时，尚未验证成功；请稍后重试，不能据此判定账号目录选错';
    case 'key.incomplete':
      return '部分微信数据库尚未通过只读校验，未开始消息读取；不能据此判定账号目录选错';
    case 'account.keyMismatch':
    case 'database.validationFailed':
      return '微信数据库未通过只读验证；原因可能涉及读取凭证、文件状态或版本兼容性，尚不能判定账号目录选错';
    case 'account.invalid':
      return '所选目录未通过账号目录检查，请选择包含 db_storage 的微信账号目录';
    case 'database.missing':
      return '未找到所需的微信数据库文件，请确认微信已登录并选择对应的账号目录';
    case 'configuration.missing':
      return '微信读取配置尚不完整，请检查账号目录与本地读取组件';
    case 'platform.unsupported':
      return '微信实时读取仅支持 Windows x64';
    case 'resource.invalid':
      return '微信原生读取组件校验失败，请重新安装当前版本';
    case 'resource.load':
      return '微信原生读取组件加载失败，请重新安装当前版本';
    case 'key.adapter':
      return '微信密钥读取组件无法启动，当前微信版本可能不兼容';
    case 'database.initialize':
      return '微信数据库引擎初始化失败，请检查本地读取组件';
    case 'database.protectionFailed':
      return '微信数据库读取组件初始化校验失败，尚未进入账号验证；请检查组件兼容性';
    case 'database.identity':
      return '无法核实微信消息的收发身份，尚不能判定账号目录选错';
    case 'database.open':
      return '微信数据库暂时无法只读打开，请检查文件访问权限及读取组件兼容性';
    case 'database.schema':
      return '当前微信数据库结构暂不受支持，请检查微信版本与读取组件兼容性';
    case 'database.direction':
      return '无法可靠判断部分消息的收发方向，本次消息读取未完成';
    case 'database.content':
      return '部分微信消息的内容格式或大小暂不受支持，无法安全解码';
    case 'database.message':
      return '部分微信消息的标识或时间格式暂不受支持，无法确认读取结果';
    case 'database.pagination':
      return '消息读取范围参数无效，请调整后重试';
    case 'conversations.cursorExpired':
      return '会话列表已刷新，请重新加载列表';
    case 'cursor.expired':
      return '历史导出范围已失效，未完成导出；请重新开始';
    case 'database.scanLimit':
      return '本次消息读取达到安全扫描上限，尚未完成同步；请缩小读取范围';
    case 'database.query':
      return '微信数据库只读查询暂未完成，请稍后重试';
    case 'database.busy':
      return '微信数据库正在被使用，暂时无法完成只读查询，请稍后重试';
    case 'database.configure':
      return '微信数据库只读配置未通过检查，请确认读取组件兼容性';
    case 'database.keyInvalid':
      return '微信数据库读取凭证未通过格式检查，尚未开始读取；不能据此判定账号目录选错';
    case 'database.key':
      return '微信数据库读取凭证暂时无法使用，尚未完成验证；不能据此判定账号目录选错';
    case 'database.queryDenied':
      return '本次查询未通过只读安全检查，未执行该查询';
    case 'database.prepare':
      return '微信数据库查询准备失败，请检查读取组件与微信版本兼容性';
    case 'database.bind':
      return '微信数据库查询参数未通过检查，暂未执行查询';
    case 'database.finalize':
      return '微信只读查询未能正常结束，请停止读取后重试';
    case 'database.close':
      return '微信只读会话未能正常关闭，请停止读取后重试';
    case 'database.closed':
      return '微信只读会话已结束，请重新启动实时读取';
    default:
      return undefined;
  }
};

const publicStartError = (error: unknown): string => {
  if (error instanceof WechatWorkerCommandError) {
    return publicWorkerError(error.code) ?? PUBLIC_ERROR;
  }
  if (!(error instanceof Error)) return PUBLIC_ERROR;
  const message = error.message.toLowerCase();
  if (message.includes('invalid engine.start result')) {
    return '微信原生读取组件返回格式不兼容，请更新当前版本';
  }
  if (message.includes('does not support')) {
    return '微信原生读取组件缺少所需能力，请更新当前版本';
  }
  if (message.includes('timed out')) {
    return '微信数据引擎启动超时，请停止读取后重试';
  }
  if (message.includes('handshake') || message.includes('invalid protocol')) {
    return '微信隔离进程启动失败，请重新启动本软件';
  }
  return PUBLIC_ERROR;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasOnlyKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
};

const isIdentifier = (value: unknown): value is string =>
  typeof value === 'string'
  && value.length > 0
  && value.length <= 96
  && /^[a-zA-Z0-9._:-]+$/u.test(value);

const isMessageId = (value: unknown): value is string =>
  typeof value === 'string'
  && value.length > 0
  && value.length <= 256
  && /^[a-zA-Z0-9._:-]+$/u.test(value);

const isOpaqueKey = (value: unknown): value is string =>
  typeof value === 'string'
  && value.length > 0
  && value.length <= 256
  && /^[a-zA-Z0-9._:@-]+$/u.test(value);

const isCursor = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 1024;

const isTimestamp = (value: unknown): value is string =>
  typeof value === 'string'
  && value.length > 0
  && value.length <= 64
  && Number.isFinite(Date.parse(value));

const isWorkerMessage = (value: unknown): value is WorkerMessage =>
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
  && isMessageId(value.messageId)
  && isOpaqueKey(value.accountKey)
  && isOpaqueKey(value.contactKey)
  && ['incoming', 'outgoing', 'system'].includes(String(value.direction))
  && ['text', 'image', 'voice', 'system', 'other'].includes(String(value.messageType))
  && (value.direction === 'system') === (value.messageType === 'system')
  && (value.mediaKey === undefined || (typeof value.mediaKey === 'string' && /^media_[a-f0-9]{64}$/u.test(value.mediaKey)))
  && (value.mediaKind === undefined || ['image', 'sticker'].includes(String(value.mediaKind)))
  && (value.mediaStatus === undefined || ['pending', 'ready', 'encrypted', 'missing', 'unsupported'].includes(String(value.mediaStatus)))
  && (value.attachmentKind === undefined || ['video', 'file', 'unknown'].includes(String(value.attachmentKind)))
  && (value.senderAvatarMediaKey === undefined || (value.direction !== 'system'
    && typeof value.senderAvatarMediaKey === 'string' && /^media_[a-f0-9]{64}$/u.test(value.senderAvatarMediaKey)))
  && (value.senderDisplayName === undefined || (value.direction !== 'system'
    && typeof value.senderDisplayName === 'string' && value.senderDisplayName.length > 0 && value.senderDisplayName.length <= 256))
  && (value.voiceMediaKey === undefined || (value.messageType === 'voice'
    && typeof value.voiceMediaKey === 'string' && /^media_[a-f0-9]{64}$/u.test(value.voiceMediaKey)))
  && isTimestamp(value.occurredAt)
  && (value.sortSequence === undefined || isWechatSortSequence(value.sortSequence))
  && (value.text === undefined
    || (typeof value.text === 'string' && value.text.length <= 64 * 1024));

const isWorkerDelta = (value: unknown): value is WorkerDelta =>
  isRecord(value)
  && hasOnlyKeys(value, [
    'subscriptionId',
    'batchId',
    'baseCursor',
    'nextCursor',
    'messages',
  ])
  && isIdentifier(value.subscriptionId)
  && isIdentifier(value.batchId)
  && (value.baseCursor === undefined || isCursor(value.baseCursor))
  && isCursor(value.nextCursor)
  && Array.isArray(value.messages)
  && value.messages.length <= 200
  && value.messages.every(isWorkerMessage);

const isSubscriptionResult = (value: unknown): value is SubscriptionResult =>
  isRecord(value)
  && hasOnlyKeys(value, ['subscriptionId', 'cursor'])
  && isIdentifier(value.subscriptionId)
  && (value.cursor === undefined || isCursor(value.cursor));

const isMessagesSnapshotResult = (value: unknown): value is MessagesSnapshotResult =>
  isRecord(value)
  && hasOnlyKeys(value, ['contactKey', 'cursor', 'messages'])
  && isOpaqueKey(value.contactKey)
  && (value.cursor === undefined || isCursor(value.cursor))
  && Array.isArray(value.messages)
  && value.messages.length <= 500
  && value.messages.every(isWorkerMessage);

const isMessagesHistoryResult = (value: unknown): value is MessagesHistoryResult =>
  isRecord(value)
  && hasOnlyKeys(value, ['contactKey', 'nextCursor', 'done', 'messages'])
  && isOpaqueKey(value.contactKey)
  && typeof value.done === 'boolean'
  && (value.done ? value.nextCursor === undefined : isCursor(value.nextCursor))
  && Array.isArray(value.messages) && value.messages.length <= 200
  && value.messages.every(isWorkerMessage);

const isEmptyResult = (value: unknown): value is Record<string, never> =>
  isRecord(value) && Object.keys(value).length === 0;

const isEngineState = (value: unknown): value is WorkerEngineState => [
  'starting',
  'waiting-login',
  'ready',
  'streaming',
  'paused',
  'stopped',
  'backoff',
  'fatal',
].includes(String(value));

const statusDetail: Record<WechatLiveEngineState, string> = {
  stopped: '微信数据同步已停止',
  starting: '正在只读校验微信数据',
  'waiting-login': '尚未完成微信只读校验，请保持微信已登录',
  ready: '微信数据已连接',
  streaming: '正在同步微信消息',
  backoff: '微信连接中断，正在重试',
  fatal: '微信数据引擎暂时不可用',
};

const mediaText: Record<WorkerMessage['messageType'], string> = {
  text: '',
  image: '[图片]',
  voice: '[语音]',
  system: '[系统消息]',
  other: '[其他消息]',
};
const attachmentText: Record<NonNullable<WorkerMessage['attachmentKind']>, string> = {
  video: '[视频]',
  file: '[文件]',
  unknown: '[附件或卡片消息]',
};

export class WechatLiveService {
  private readonly manager: WechatEngineController;
  private readonly now: () => Date;
  private readonly processIds: () => Promise<readonly number[]>;
  private readonly listeners = new Set<(delta: WechatLiveDelta) => void>();
  private readonly seenMessageIds = new Set<string>();
  private readonly seenMessageOrder: string[] = [];
  private readonly unsubscribeManagerState: () => void;
  private readonly unsubscribeManagerEvents: () => void;

  private desiredRunning = false;
  private revision = 0;
  private epoch = 0;
  private accountKey: string | undefined;
  private conversations: WechatLiveConversation[] = [];
  private readonly knownConversations = new Map<string, WechatLiveConversation>();
  private nextConversationCursor: string | undefined;
  private conversationOperation = 0;
  private contactKeys: string[] = [];
  private subscriptionId: string | undefined;
  private cursor: string | undefined;
  private readonly snapshotCursors = new Map<string, { cursor: string; receivedAt: number }>();
  private initializedGeneration: string | undefined;
  private announcedReadyGeneration: string | undefined;
  private initialization: { generation: string; promise: Promise<void> } | undefined;
  private watchOperation = 0;
  private activeWatchOperation = 0;
  private pendingWatchOperation: number | undefined;
  private subscriptionQueue: Promise<void> = Promise.resolve();
  private status: WechatLiveStatus;
  private media: WechatMediaBridge | undefined;
  private voice: WechatVoiceBridge | undefined;
  private selfAvatarMediaKey: string | undefined;

  constructor(options: WechatLiveServiceOptions) {
    if (!options.accountRoot.trim()) throw new Error('WeChat account root is required');
    const accountRoot = path.resolve(options.accountRoot);
    this.manager = options.manager ?? new WechatEngineManager({
      spawn: createLiveWechatWorkerSpawn({ accountRoot }),
    });
    this.now = options.now ?? (() => new Date());
    this.processIds = options.processIds
      ?? (options.manager ? async () => [] : findWechatProcessIds);
    this.status = this.createStatus('stopped');
    this.unsubscribeManagerState = this.manager.subscribeState((snapshot) => {
      this.handleManagerState(snapshot);
    });
    this.unsubscribeManagerEvents = this.manager.subscribeEvents((event) => {
      this.handleWorkerEvent(event);
    });
  }

  snapshot(): WechatLiveSnapshot {
    return {
      revision: this.revision,
      status: { ...this.status },
      conversations: this.conversations.map((conversation) => ({ ...conversation })),
      ...(this.accountKey ? { accountKey: this.accountKey } : {}),
      ...(this.selfAvatarMediaKey ? { selfAvatarMediaKey: this.selfAvatarMediaKey } : {}),
      ...(this.nextConversationCursor ? { nextConversationCursor: this.nextConversationCursor } : {}),
    };
  }

  subscribe(listener: (delta: WechatLiveDelta) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  mediaForRenderer(key: unknown): Promise<WechatMediaResult> {
    return this.media?.resolve(key) ?? Promise.resolve({ ok: false, reason: 'missing' });
  }

  /** Main-process-only audio. Renderer callers receive a transcript, never these bytes. */
  readVoice(key: unknown, options: { signal?: AbortSignal } = {}): Promise<{ bytes: Buffer; format: 'silk' | 'wav' } | undefined> {
    return this.voice?.read(key, options) ?? Promise.resolve(undefined);
  }

  private toLiveConversation(conversation: WechatLiveConversation): WechatLiveConversation {
    const { avatarMediaKey, ...fields } = conversation;
    const key = this.media?.register(avatarMediaKey);
    return { ...fields, ...(key ? { avatarMediaKey: key } : {}) };
  }

  async start(): Promise<WechatLiveSnapshot> {
    if (this.status.state === 'fatal') {
      this.manager.stop();
      this.clearSessionState();
    }
    if (this.desiredRunning && this.initializedGeneration) return this.snapshot();
    this.desiredRunning = true;
    this.epoch += 1;
    const startEpoch = this.epoch;
    let startGeneration: string | undefined;
    this.setStatus('starting');
    try {
      await this.manager.start();
      startGeneration = this.manager.getSnapshot().generation;
      await this.ensureInitialized();
      if (
        !this.desiredRunning
        || this.epoch !== startEpoch
        || this.manager.getSnapshot().generation !== startGeneration
      ) {
        throw new Error('WeChat start cancelled');
      }
      return this.snapshot();
    } catch (error) {
      const cancelled = !this.desiredRunning
        || this.epoch !== startEpoch
        || (startGeneration !== undefined
          && this.manager.getSnapshot().generation !== startGeneration);
      const message = cancelled ? START_CANCELLED : publicStartError(error);
      if (!cancelled) this.setStatus('fatal', message);
      throw new WechatLiveServiceError(message);
    }
  }

  async messagesSnapshot(contactKey: string, limit = 100): Promise<WechatLiveMessage[]> {
    if (!isOpaqueKey(contactKey) || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new WechatLiveServiceError();
    }
    try {
      await this.ensureInitialized();
      if (!this.accountKey) throw new Error('Account is unavailable');
      if (!this.knownConversations.has(contactKey)) {
        throw new Error('Unknown conversation');
      }
      const accountKey = this.accountKey;
      const generation = this.initializedGeneration;
      const epoch = this.epoch;
      const result = await this.manager.request('messages.snapshot', {
        accountKey,
        contactKey,
        limit,
      });
      if (!this.isCurrentSession(epoch, generation, accountKey)) throw new Error('Stale messages snapshot');
      if (!isMessagesSnapshotResult(result) || result.contactKey !== contactKey) {
        throw new Error('Invalid messages snapshot');
      }
      if (result.messages.some((message) =>
        message.accountKey !== accountKey || message.contactKey !== contactKey)) {
        throw new Error('Messages snapshot scope mismatch');
      }
      // A new selection can subscribe from this exact read boundary. Historical
      // refreshes must never rewind an already active stream's acknowledged cursor.
      if (result.cursor && !this.contactKeys.includes(contactKey)) {
        this.snapshotCursors.delete(contactKey);
        this.snapshotCursors.set(contactKey, { cursor: result.cursor, receivedAt: this.now().getTime() });
        while (this.snapshotCursors.size > MAX_SNAPSHOT_CURSORS) {
          this.snapshotCursors.delete(this.snapshotCursors.keys().next().value as string);
        }
      }
      return result.messages.map((message) => this.toLiveMessage(message));
    } catch (error) {
      throw new WechatLiveServiceError(error instanceof WechatWorkerCommandError
        ? publicWorkerError(error.code) : undefined);
    }
  }

  async conversationsPage(cursor?: string): Promise<WechatLiveSnapshot> {
    if (cursor !== undefined && (!isCursor(cursor) || !/^[a-zA-Z0-9._:-]+$/u.test(cursor))) {
      throw new WechatLiveServiceError('会话分页范围无效');
    }
    const operation = ++this.conversationOperation;
    try {
      await this.ensureInitialized();
      const accountKey = this.accountKey;
      const generation = this.initializedGeneration;
      const epoch = this.epoch;
      if (!accountKey || operation !== this.conversationOperation) throw new WechatLiveServiceError(LIST_CANCELLED);
      if (cursor !== undefined && cursor !== this.nextConversationCursor) {
        throw new WechatLiveServiceError('会话列表已刷新，请重新加载列表');
      }
      const result = await this.manager.request('conversations.list', {
        accountKey, limit: 100, ...(cursor === undefined ? {} : { cursor }),
      });
      if (operation !== this.conversationOperation || !this.isCurrentSession(epoch, generation, accountKey)) {
        throw new WechatLiveServiceError(LIST_CANCELLED);
      }
      if (!isWechatEngineStartResult(result) || result.accountKey !== accountKey
        || (cursor !== undefined && result.nextConversationCursor === cursor)) throw new Error('Invalid conversation page');
      const previous = new Set(this.conversations.map((item) => item.contactKey));
      if (cursor !== undefined && result.conversations.some((item) => previous.has(item.contactKey))) {
        throw new Error('Duplicate conversation page');
      }
      const page = result.conversations.filter(isSalesWechatConversation).map((item) => this.toLiveConversation(item));
      if (result.selfAvatarMediaKey) this.selfAvatarMediaKey = this.media?.register(result.selfAvatarMediaKey);
      this.conversations = cursor === undefined ? page : [...this.conversations, ...page];
      for (const item of page) this.knownConversations.set(item.contactKey, item);
      this.nextConversationCursor = result.nextConversationCursor;
      this.revision += 1;
      this.emit({ revision: this.revision, messages: [], status: { ...this.status } });
      return this.snapshot();
    } catch (error) {
      if (error instanceof WechatLiveServiceError) throw error;
      throw new WechatLiveServiceError(error instanceof WechatWorkerCommandError
        ? publicWorkerError(error.code) : undefined);
    }
  }

  /** Completes only after all pages in the local readable date range have been consumed.
   * The range is fixed at start; this is not a cross-device/transactional WeChat backup.
   * Abort, account changes and safety limits throw, so exporters cannot call partial output complete.
   */
  async *exportMessages(contactKey: string, options: { from?: string; to?: string; signal?: AbortSignal } = {}): AsyncGenerator<WechatLiveMessage[]> {
    const from = options.from === undefined ? 946684800 : Math.ceil(Date.parse(options.from) / 1000);
    const to = Math.floor((options.to === undefined ? this.now().getTime() : Date.parse(options.to)) / 1000);
    if (!isOpaqueKey(contactKey) || !Number.isSafeInteger(from) || !Number.isSafeInteger(to)
      || from < 946684800 || to > 4102444800 || from > to) throw new WechatLiveServiceError('历史导出的日期范围无效');
    if (options.signal?.aborted) throw new WechatLiveServiceError(HISTORY_CANCELLED);
    try {
      await this.ensureInitialized();
      const accountKey = this.accountKey, generation = this.initializedGeneration, epoch = this.epoch;
      if (!accountKey || !this.knownConversations.has(contactKey)) throw new WechatLiveServiceError('请先在当前微信账号选择要导出的会话');
      const current = () => !options.signal?.aborted && this.isCurrentSession(epoch, generation, accountKey);
      const seen = new Set<string>();
      let cursor: string | undefined;
      for (let pages = 0; pages < 10_000; pages += 1) {
        if (!current()) throw new WechatLiveServiceError(HISTORY_CANCELLED);
        const result = await this.manager.request('messages.history', {
          accountKey, contactKey, limit: 200, from, to, ...(cursor ? { cursor } : {}),
        });
        if (!current()) throw new WechatLiveServiceError(HISTORY_CANCELLED);
        if (!isMessagesHistoryResult(result) || result.contactKey !== contactKey
          || (!result.done && result.nextCursor === cursor)
          || result.messages.some((message) => message.accountKey !== accountKey || message.contactKey !== contactKey
            || Date.parse(message.occurredAt) < from * 1000 || Date.parse(message.occurredAt) > to * 1000)) {
          throw new WechatLiveServiceError('历史记录返回不完整或范围不一致，未完成导出，请重试');
        }
        const page: WechatLiveMessage[] = [];
        for (const message of result.messages) {
          if (seen.has(message.messageId)) continue;
          if (seen.size >= 100_000) throw new WechatLiveServiceError(HISTORY_LIMIT);
          seen.add(message.messageId); page.push(this.toLiveMessage(message));
        }
        if (page.length) yield page;
        if (!current()) throw new WechatLiveServiceError(HISTORY_CANCELLED);
        if (result.done) return;
        cursor = result.nextCursor;
      }
      throw new WechatLiveServiceError(HISTORY_LIMIT);
    } catch (error) {
      if (error instanceof WechatLiveServiceError) throw error;
      throw new WechatLiveServiceError(error instanceof WechatWorkerCommandError ? publicWorkerError(error.code) : undefined);
    }
  }

  async watchContacts(contactKeys: readonly string[]): Promise<WechatLiveSnapshot> {
    if (
      contactKeys.length < 1
      || contactKeys.length > 50
      || contactKeys.some((key) => !isOpaqueKey(key))
      || new Set(contactKeys).size !== contactKeys.length
    ) {
      throw new WechatLiveServiceError();
    }
    if (this.status.state === 'streaming' && this.subscriptionId
      && this.pendingWatchOperation === undefined && this.activeWatchOperation === this.watchOperation
      && this.initializedGeneration === this.manager.getSnapshot().generation
      && this.contactKeys.join('\0') === contactKeys.join('\0')) return this.snapshot();
    const nextContactKeys = [...contactKeys];
    const operation = ++this.watchOperation;
    this.pendingWatchOperation = operation;
    if (this.desiredRunning && this.initializedGeneration) this.setStatus('ready');
    try {
      await this.ensureInitialized();
      if (operation !== this.watchOperation) throw new WechatLiveServiceError(SELECTION_CANCELLED);
      await this.restoreSubscription(true, nextContactKeys, operation);
      if (operation !== this.watchOperation || !this.desiredRunning) {
        throw new WechatLiveServiceError(SELECTION_CANCELLED);
      }
      return this.snapshot();
    } catch (error) {
      const message = error instanceof WechatLiveServiceError ? error.message
        : error instanceof WechatWorkerCommandError ? publicWorkerError(error.code) ?? PUBLIC_ERROR : PUBLIC_ERROR;
      if (operation === this.watchOperation && this.desiredRunning && this.status.state !== 'fatal') {
        this.setStatus('ready', message);
      }
      throw new WechatLiveServiceError(message);
    } finally {
      if (this.pendingWatchOperation === operation) this.pendingWatchOperation = undefined;
    }
  }

  /** Cancels a pending selection too; hidden chats must not keep a live reader. */
  async unwatchContacts(): Promise<WechatLiveSnapshot> {
    const operation = ++this.watchOperation;
    this.pendingWatchOperation = operation;
    const accountKey = this.accountKey, generation = this.initializedGeneration, epoch = this.epoch;
    this.contactKeys = [];
    this.cursor = undefined;
    this.snapshotCursors.clear();
    if (this.desiredRunning && generation) this.setStatus('ready');
    const task = this.subscriptionQueue.then(async () => {
      if (operation !== this.watchOperation) throw new WechatLiveServiceError(SELECTION_CANCELLED);
      const subscriptionId = this.subscriptionId;
      this.subscriptionId = undefined;
      if (subscriptionId && accountKey && this.isCurrentSession(epoch, generation, accountKey)) {
        await this.pauseSubscription(subscriptionId, epoch, generation, accountKey);
      }
      if (operation !== this.watchOperation) throw new WechatLiveServiceError(SELECTION_CANCELLED);
    });
    this.subscriptionQueue = task.then(() => undefined, () => undefined);
    try { await task; return this.snapshot(); }
    catch (error) { throw new WechatLiveServiceError(error instanceof WechatLiveServiceError ? error.message : PUBLIC_ERROR); }
    finally { if (this.pendingWatchOperation === operation) this.pendingWatchOperation = undefined; }
  }

  async stop(): Promise<WechatLiveSnapshot> {
    this.desiredRunning = false;
    this.epoch += 1;
    const managerReady = this.manager.getSnapshot().state === 'ready';
    if (managerReady && this.initializedGeneration) {
      try {
        const result = await this.manager.request('engine.stop', {});
        if (!isEmptyResult(result)) throw new Error('Invalid engine stop result');
      } catch {
        // The manager is always stopped below; native details must not escape this boundary.
      }
    }
    this.manager.stop();
    this.clearSessionState();
    this.setStatus('stopped');
    return this.snapshot();
  }

  dispose(): void {
    this.desiredRunning = false;
    this.unsubscribeManagerState();
    this.unsubscribeManagerEvents();
    this.listeners.clear();
    this.media?.clear(); this.media = undefined;
    this.voice?.clear(); this.voice = undefined;
    this.selfAvatarMediaKey = undefined;
    this.manager.stop();
  }

  private clearSessionState(): void {
    this.media?.clear(); this.media = undefined;
    this.voice?.clear(); this.voice = undefined;
    this.selfAvatarMediaKey = undefined;
    this.initializedGeneration = undefined;
    this.announcedReadyGeneration = undefined;
    this.initialization = undefined;
    this.accountKey = undefined;
    this.conversations = [];
    this.knownConversations.clear();
    this.nextConversationCursor = undefined;
    this.conversationOperation += 1;
    this.watchOperation += 1;
    this.pendingWatchOperation = undefined;
    this.subscriptionQueue = Promise.resolve();
    this.subscriptionId = undefined;
    this.cursor = undefined;
    this.snapshotCursors.clear();
    this.contactKeys = [];
    this.seenMessageIds.clear();
    this.seenMessageOrder.length = 0;
  }

  private ensureInitialized(): Promise<void> {
    const managerSnapshot = this.manager.getSnapshot();
    const generation = managerSnapshot.generation;
    if (
      !this.desiredRunning
      || managerSnapshot.state !== 'ready'
      || !generation
    ) {
      return Promise.reject(new Error('WeChat engine is not ready'));
    }
    if (this.initializedGeneration === generation && this.accountKey) {
      return Promise.resolve();
    }
    if (this.initialization?.generation === generation) return this.initialization.promise;

    const epoch = this.epoch;
    const promise = this.initializeGeneration(generation, epoch).finally(() => {
      if (this.initialization?.promise === promise) this.initialization = undefined;
    });
    this.initialization = { generation, promise };
    return promise;
  }

  private async initializeGeneration(generation: string, epoch: number): Promise<void> {
    const processIds = [...new Set(await this.processIds())]
      .filter((pid) => Number.isSafeInteger(pid) && pid > 0)
      .slice(0, 32);
    const result = await this.manager.request('engine.start', { processIds });
    if (!isWechatEngineStartResult(result)) throw new Error('Invalid engine start result');
    if (
      !this.desiredRunning
      || this.epoch !== epoch
      || this.manager.getSnapshot().generation !== generation
    ) return;

    if (this.accountKey !== result.accountKey) {
      this.knownConversations.clear();
      this.contactKeys = [];
      this.cursor = undefined;
      this.seenMessageIds.clear();
      this.seenMessageOrder.length = 0;
    }
    this.accountKey = result.accountKey;
    this.media?.clear();
    this.voice?.clear();
    const accountKey = result.accountKey;
    this.media = new WechatMediaBridge({
      isCurrent: () => this.isCurrentSession(epoch, generation, accountKey),
      request: (mediaKey, offset) => this.manager.request('media.read', { accountKey, mediaKey, offset }, 8000),
    });
    this.voice = new WechatVoiceBridge({
      isCurrent: () => this.isCurrentSession(epoch, generation, accountKey),
      request: (mediaKey, offset) => this.manager.request('voice.read', { accountKey, mediaKey, offset }, 8000),
    });
    this.selfAvatarMediaKey = this.media.register(result.selfAvatarMediaKey);
    this.conversations = result.conversations.filter(isSalesWechatConversation).map((conversation) => this.toLiveConversation(conversation));
    for (const item of this.conversations) this.knownConversations.set(item.contactKey, item);
    this.nextConversationCursor = result.nextConversationCursor;
    this.initializedGeneration = generation;
    this.subscriptionId = undefined;
    if (this.contactKeys.length > 0 && this.pendingWatchOperation === undefined) {
      await this.restoreSubscription(false);
    } else {
      this.setStatus('ready');
    }
  }

  private isCurrentSession(epoch: number, generation: string | undefined, accountKey: string): boolean {
    return this.desiredRunning && this.epoch === epoch && generation !== undefined
      && this.initializedGeneration === generation && this.manager.getSnapshot().generation === generation
      && this.accountKey === accountKey;
  }

  private async pauseSubscription(subscriptionId: string, epoch: number, generation: string | undefined, accountKey: string): Promise<void> {
    try {
      const result = await this.manager.request('stream.pause', { subscriptionId });
      if (!isEmptyResult(result)) throw new Error('Invalid stream pause result');
    } catch (error) {
      if (this.isCurrentSession(epoch, generation, accountKey)) {
        this.manager.stop(); this.clearSessionState(); this.setStatus('fatal', PUBLIC_ERROR);
      }
      throw error;
    }
  }

  private restoreSubscription(
    pausePrevious: boolean,
    nextContactKeys: readonly string[] = [...this.contactKeys],
    operation = this.watchOperation,
  ): Promise<void> {
    const accountKey = this.accountKey;
    const generation = this.initializedGeneration;
    const epoch = this.epoch;
    const current = (): boolean => operation === this.watchOperation && accountKey !== undefined
      && this.isCurrentSession(epoch, generation, accountKey);
    const cancel = (): never => { throw new WechatLiveServiceError(SELECTION_CANCELLED); };
    const pause = (subscriptionId: string) => this.pauseSubscription(subscriptionId, epoch, generation, accountKey as string);
    const task = this.subscriptionQueue.then(async () => {
      if (!current() || !accountKey || nextContactKeys.length === 0) return cancel();
      const previousSubscriptionId = this.subscriptionId;
      const cached = nextContactKeys.length === 1 ? this.snapshotCursors.get(nextContactKeys[0]) : undefined;
      const cursor = this.contactKeys.join('\0') === nextContactKeys.join('\0') ? this.cursor
        : cached && this.now().getTime() - cached.receivedAt <= 15_000 ? cached.cursor : undefined;
      for (const key of nextContactKeys) this.snapshotCursors.delete(key);
      this.subscriptionId = undefined;
      this.contactKeys = [];
      this.cursor = undefined;
      this.setStatus('ready');
      if (pausePrevious && previousSubscriptionId) {
        await pause(previousSubscriptionId);
        if (!current()) return cancel();
      }
      if (nextContactKeys.some((key) => !this.knownConversations.has(key))) throw new Error('Unknown conversation');
      const result = await this.manager.request('stream.subscribe', {
        accountKey, contactKeys: [...nextContactKeys], ...(cursor ? { cursor } : {}),
      });
      if (!isSubscriptionResult(result)) {
        if (this.isCurrentSession(epoch, generation, accountKey)) {
          this.manager.stop();
          this.clearSessionState();
          this.setStatus('fatal', PUBLIC_ERROR);
        }
        throw new Error('Invalid subscription result');
      }
      if (!current()) {
        if (this.isCurrentSession(epoch, generation, accountKey)) await pause(result.subscriptionId);
        return cancel();
      }
      this.contactKeys = [...nextContactKeys];
      this.subscriptionId = result.subscriptionId;
      this.cursor = result.cursor;
      this.activeWatchOperation = operation;
      this.setStatus('streaming');
    });
    this.subscriptionQueue = task.then(() => undefined, () => undefined);
    return task;
  }

  private handleManagerState(snapshot: WechatEngineManagerSnapshot): void {
    if (snapshot.state !== 'ready') this.snapshotCursors.clear();
    switch (snapshot.state) {
      case 'starting':
        this.media?.clear(); this.media = undefined;
        this.voice?.clear(); this.voice = undefined;
        this.selfAvatarMediaKey = undefined;
        this.watchOperation += 1;
        this.pendingWatchOperation = undefined;
        this.conversationOperation += 1;
        this.subscriptionQueue = Promise.resolve();
        this.initializedGeneration = undefined;
        this.subscriptionId = undefined;
        if (this.desiredRunning) this.setStatus('starting');
        break;
      case 'ready': {
        const generation = snapshot.generation;
        if (
          !this.desiredRunning
          || !generation
          || this.announcedReadyGeneration === generation
        ) break;
        this.announcedReadyGeneration = generation;
        if (this.initializedGeneration === generation) break;
        const epoch = this.epoch;
        this.setStatus('starting');
        void this.ensureInitialized().catch((error: unknown) => {
          if (
            this.desiredRunning
            && this.epoch === epoch
            && this.manager.getSnapshot().generation === generation
          ) this.setStatus('fatal', publicStartError(error));
        });
        break;
      }
      case 'backoff':
        this.media?.clear(); this.media = undefined;
        this.voice?.clear(); this.voice = undefined;
        this.selfAvatarMediaKey = undefined;
        this.watchOperation += 1;
        this.pendingWatchOperation = undefined;
        this.conversationOperation += 1;
        this.initializedGeneration = undefined;
        this.subscriptionId = undefined;
        if (this.desiredRunning) this.setStatus('backoff');
        break;
      case 'fatal':
        this.media?.clear(); this.media = undefined;
        this.voice?.clear(); this.voice = undefined;
        this.selfAvatarMediaKey = undefined;
        this.watchOperation += 1;
        this.pendingWatchOperation = undefined;
        this.conversationOperation += 1;
        this.initializedGeneration = undefined;
        this.subscriptionId = undefined;
        if (this.desiredRunning) this.setStatus('fatal');
        break;
      case 'stopped':
        if (!this.desiredRunning) this.setStatus('stopped');
        break;
    }
  }

  private handleWorkerEvent(event: WechatWorkerEvent): void {
    if (event.generation !== this.manager.getSnapshot().generation) return;
    try {
      if (event.event === 'engine.state') {
        const state = event.payload.state;
        if (!isEngineState(state)) throw new Error('Invalid engine state');
        const mappedState: WechatLiveEngineState = state === 'paused' ? 'ready' : state;
        if (mappedState === 'streaming'
          && (!this.subscriptionId || this.activeWatchOperation !== this.watchOperation)) return;
        if (mappedState === 'fatal' || mappedState === 'backoff') {
          const detailCode = event.payload.detailCode;
          const knownDetail = typeof detailCode === 'string'
            ? publicWorkerError(detailCode)
            : undefined;
          const previousDetail = (this.status.state === 'fatal' || this.status.state === 'backoff')
            && this.status.detail !== statusDetail[this.status.state]
            ? this.status.detail
            : undefined;
          this.setStatus(mappedState, knownDetail ?? previousDetail);
        } else {
          this.setStatus(mappedState);
        }
        return;
      }
      if (event.event === 'messages.delta') {
        this.handleMessagesDelta(event.payload);
        return;
      }
      if (event.event === 'cursor.invalidated') {
        if (event.payload.accountKey !== this.accountKey) {
          throw new Error('Cursor account mismatch');
        }
        this.cursor = undefined;
        if (this.desiredRunning && this.contactKeys.length > 0 && this.pendingWatchOperation === undefined) {
          const operation = ++this.watchOperation;
          void this.restoreSubscription(true, [...this.contactKeys], operation).catch((error: unknown) => {
            if (operation === this.watchOperation && this.desiredRunning && this.status.state !== 'fatal') {
              this.setStatus('backoff', error instanceof WechatWorkerCommandError ? publicWorkerError(error.code) : undefined);
            }
          });
        }
      }
    } catch {
      if (this.desiredRunning) this.setStatus('fatal');
    }
  }

  private handleMessagesDelta(payload: Record<string, unknown>): void {
    if (!isWorkerDelta(payload)) {
      throw new Error('Invalid messages delta');
    }
    if (!this.accountKey || !this.subscriptionId || payload.subscriptionId !== this.subscriptionId
      || this.activeWatchOperation !== this.watchOperation) return;
    const watched = new Set(this.contactKeys);
    if (payload.messages.some((message) =>
      message.accountKey !== this.accountKey || !watched.has(message.contactKey))) {
      throw new Error('Messages delta scope mismatch');
    }

    const messages: WechatLiveMessage[] = [];
    for (const message of payload.messages) {
      const dedupeKey = `${message.accountKey}:${message.messageId}`;
      if (this.seenMessageIds.has(dedupeKey)) continue;
      this.rememberMessage(dedupeKey);
      messages.push(this.toLiveMessage(message));
    }
    this.cursor = payload.nextCursor;
    const epoch = this.epoch;
    const generation = this.initializedGeneration;
    const accountKey = this.accountKey;
    const operation = this.watchOperation;
    const current = (): boolean => this.subscriptionId === payload.subscriptionId
      && operation === this.watchOperation && this.isCurrentSession(epoch, generation, accountKey);
    void this.manager.request('batch.ack', {
      subscriptionId: payload.subscriptionId,
      batchId: payload.batchId,
      cursor: payload.nextCursor,
    }).then((result) => {
      if (!isEmptyResult(result) && current()) this.setStatus('fatal');
    }).catch(() => {
      if (current()) this.setStatus('backoff');
    });

    if (messages.length === 0) return;
    this.revision += 1;
    const uniqueContacts = new Set(messages.map((message) => message.contactKey));
    this.emit({
      revision: this.revision,
      ...(uniqueContacts.size === 1 ? { contactKey: messages[0].contactKey } : {}),
      messages,
      status: { ...this.status },
    });
  }

  private toLiveMessage(message: WorkerMessage): WechatLiveMessage {
    const conversation = this.knownConversations.get(message.contactKey);
    const systemMessage = message.direction === 'system';
    const sender = systemMessage
      ? '微信系统'
      : message.direction === 'outgoing'
        ? '我'
        : message.senderDisplayName || (conversation?.kind === 'group' ? '群成员' : conversation?.remark || conversation?.displayName || '微信联系人');
    const senderAvatarMediaKey = systemMessage ? undefined : this.media?.register(message.senderAvatarMediaKey)
      ?? (message.direction === 'outgoing' ? this.selfAvatarMediaKey : conversation?.kind !== 'group' ? conversation?.avatarMediaKey : undefined);
    const voiceMediaKey = message.voiceMediaKey ? this.voice?.register(message.voiceMediaKey) : undefined;
    return {
      id: message.messageId,
      contactKey: message.contactKey,
      direction: message.direction,
      sender,
      text: systemMessage
        ? (message.text ? `[微信系统] ${message.text}` : '[微信系统]')
        : message.text ?? (message.attachmentKind ? attachmentText[message.attachmentKind] : mediaText[message.messageType]),
      sentAt: new Date(message.occurredAt).toISOString(),
      ...(message.sortSequence === undefined ? {} : { sortSequence: message.sortSequence }),
      messageType: message.messageType,
      observedAt: this.now().toISOString(),
      ...(message.mediaKey ? { mediaKey: this.media?.register(message.mediaKey) } : {}),
      ...(message.mediaKind ? { mediaKind: message.mediaKind } : {}),
      ...(message.mediaStatus ? { mediaStatus: message.mediaStatus } : {}),
      ...(message.attachmentKind ? { attachmentKind: message.attachmentKind } : {}),
      ...(senderAvatarMediaKey ? { senderAvatarMediaKey } : {}),
      ...(!systemMessage ? { senderDisplayName: sender } : {}),
      ...(voiceMediaKey ? { voiceMediaKey } : {}),
    };
  }

  private rememberMessage(key: string): void {
    this.seenMessageIds.add(key);
    this.seenMessageOrder.push(key);
    if (this.seenMessageOrder.length <= MAX_SEEN_MESSAGES) return;
    const oldest = this.seenMessageOrder.shift();
    if (oldest) this.seenMessageIds.delete(oldest);
  }

  private createStatus(state: WechatLiveEngineState, detail = statusDetail[state]): WechatLiveStatus {
    return {
      state,
      detail,
      monitoring: state === 'streaming',
      updatedAt: this.now().toISOString(),
    };
  }

  private setStatus(state: WechatLiveEngineState, detail = statusDetail[state]): void {
    if (this.status.state === state && this.status.detail === detail) return;
    this.status = this.createStatus(state, detail);
    this.revision += 1;
    this.emit({
      revision: this.revision,
      messages: [],
      status: { ...this.status },
    });
  }

  private emit(delta: WechatLiveDelta): void {
    for (const listener of this.listeners) {
      try {
        listener({
          ...delta,
          ...(this.accountKey ? { accountKey: this.accountKey } : {}),
          messages: delta.messages.map((message) => ({ ...message })),
          status: { ...delta.status },
        });
      } catch {
        // UI listeners are isolated from the native lifecycle.
      }
    }
  }
}
