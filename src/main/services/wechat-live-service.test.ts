import { describe, expect, it, vi } from 'vitest';
import {
  WECHAT_WORKER_PROTOCOL_VERSION,
  type WechatWorkerCommand,
  type WechatWorkerEvent,
} from '../../shared/wechat-worker-protocol';
import {
  WechatWorkerCommandError,
  type WechatEngineManagerSnapshot,
} from '../adapters/wechat-native';
import {
  WechatLiveService,
  WechatLiveServiceError,
  type WechatEngineController,
} from './wechat-live-service';

// All tests inject FakeManager. Keep Electron's binary downloader and native
// process creation outside this unit-test import graph, even on a clean install.
vi.mock('../adapters/wechat-native/live-worker-spawn', () => ({
  createLiveWechatWorkerSpawn: () => { throw new Error('Synthetic tests must inject their worker manager'); },
}));

interface RequestCall {
  readonly command: WechatWorkerCommand;
  readonly payload: Record<string, unknown>;
}

class FakeManager implements WechatEngineController {
  readonly requestCalls: RequestCall[] = [];
  stopCalls = 0;
  engineStartCalls = 0;
  subscriptionCalls = 0;
  readonly engineStartResults: unknown[] = [];
  readonly conversationPageResults: unknown[] = [];
  readonly historyPageResults: unknown[] = [];
  readonly subscriptionResults: unknown[] = [];
  snapshotResult: unknown = {
    contactKey: 'contact-1',
    cursor: 'cursor-snapshot',
    messages: [],
  };

  private snapshotValue: WechatEngineManagerSnapshot = {
    state: 'stopped',
    restartAttempt: 0,
  };
  private readonly stateListeners = new Set<(snapshot: WechatEngineManagerSnapshot) => void>();
  private readonly eventListeners = new Set<(event: WechatWorkerEvent) => void>();
  private generationNumber = 0;

  getSnapshot(): WechatEngineManagerSnapshot {
    return { ...this.snapshotValue };
  }

  subscribeState(listener: (snapshot: WechatEngineManagerSnapshot) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  subscribeEvents(listener: (event: WechatWorkerEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  async start(): Promise<void> {
    if (this.snapshotValue.state === 'ready') return;
    const generation = `generation-${++this.generationNumber}`;
    this.emitState('starting', generation);
    this.emitState('ready', generation);
  }

  stop(): void {
    this.stopCalls += 1;
    this.emitState('stopped');
  }

  async request(
    command: WechatWorkerCommand,
    payload: Record<string, unknown>,
  ): Promise<unknown> {
    this.requestCalls.push({ command, payload });
    switch (command) {
      case 'engine.start':
        this.engineStartCalls += 1;
        if (this.engineStartResults.length > 0) {
          const result = this.engineStartResults.shift();
          if (result instanceof Error) throw result;
          return result;
        }
        return {
          accountKey: 'account-opaque',
          conversations: [{
            contactKey: 'contact-1',
            displayName: '林先生',
            remark: '城西客户',
            kind: 'contact',
          }],
        };
      case 'stream.subscribe':
        this.subscriptionCalls += 1;
        if (this.subscriptionResults.length > 0) {
          const result = this.subscriptionResults.shift();
          if (result instanceof Error) throw result;
          return result;
        }
        return {
          subscriptionId: `subscription-${this.subscriptionCalls}`,
          cursor: typeof payload.cursor === 'string' ? payload.cursor : 'cursor-0',
        };
      case 'messages.snapshot':
        return this.snapshotResult;
      case 'messages.history': {
        const result = this.historyPageResults.shift();
        if (result instanceof Error) throw result;
        return result;
      }
      case 'conversations.list': {
        const result = this.conversationPageResults.shift();
        if (result instanceof Error) throw result;
        return result;
      }
      default:
        return {};
    }
  }

  emitState(state: WechatEngineManagerSnapshot['state'], generation?: string): void {
    this.snapshotValue = {
      state,
      ...(generation ? { generation } : {}),
      restartAttempt: state === 'backoff' ? 1 : 0,
    };
    for (const listener of this.stateListeners) listener(this.getSnapshot());
  }

  emitEvent(event: WechatWorkerEvent): void {
    for (const listener of this.eventListeners) listener(event);
  }
}

const now = () => new Date('2026-08-30T05:00:00.000Z');
const settlePromises = () => new Promise<void>((resolve) => setImmediate(resolve));
const databaseFailureGuidance = [
  ['account.keyMismatch', '微信数据库未通过只读验证；原因可能涉及读取凭证、文件状态或版本兼容性，尚不能判定账号目录选错'],
  ['database.validationFailed', '微信数据库未通过只读验证；原因可能涉及读取凭证、文件状态或版本兼容性，尚不能判定账号目录选错'],
  ['database.protectionFailed', '微信数据库读取组件初始化校验失败，尚未进入账号验证；请检查组件兼容性'],
] as const;
const readOnlyFailureGuidance = [
  ['wechat.notRunning', '未检测到正在运行的微信客户端'],
  ['key.notFound', '尚未找到通过校验的微信读取凭证，数据验证未完成；不能据此判定账号目录选错'],
  ['key.scanTimeout', '微信只读校验已超时，尚未验证成功；请稍后重试，不能据此判定账号目录选错'],
  ['key.incomplete', '部分微信数据库尚未通过只读校验，未开始消息读取；不能据此判定账号目录选错'],
  ['database.identity', '无法核实微信消息的收发身份，尚不能判定账号目录选错'],
  ['database.schema', '当前微信数据库结构暂不受支持，请检查微信版本与读取组件兼容性'],
  ['database.direction', '无法可靠判断部分消息的收发方向，本次消息读取未完成'],
  ['database.content', '部分微信消息的内容格式或大小暂不受支持，无法安全解码'],
  ['database.message', '部分微信消息的标识或时间格式暂不受支持，无法确认读取结果'],
  ['database.pagination', '消息读取范围参数无效，请调整后重试'],
  ['database.scanLimit', '本次消息读取达到安全扫描上限，尚未完成同步；请缩小读取范围'],
  ['database.query', '微信数据库只读查询暂未完成，请稍后重试'],
  ['database.busy', '微信数据库正在被使用，暂时无法完成只读查询，请稍后重试'],
  ['database.configure', '微信数据库只读配置未通过检查，请确认读取组件兼容性'],
  ['database.keyInvalid', '微信数据库读取凭证未通过格式检查，尚未开始读取；不能据此判定账号目录选错'],
  ['database.key', '微信数据库读取凭证暂时无法使用，尚未完成验证；不能据此判定账号目录选错'],
  ['database.queryDenied', '本次查询未通过只读安全检查，未执行该查询'],
  ['database.prepare', '微信数据库查询准备失败，请检查读取组件与微信版本兼容性'],
  ['database.bind', '微信数据库查询参数未通过检查，暂未执行查询'],
  ['database.finalize', '微信只读查询未能正常结束，请停止读取后重试'],
  ['database.close', '微信只读会话未能正常关闭，请停止读取后重试'],
  ['database.closed', '微信只读会话已结束，请重新启动实时读取'],
] as const;

const deltaEvent = (
  sequence: number,
  batchId: string,
  messageId: string,
  nextCursor: string,
): WechatWorkerEvent => ({
  protocolVersion: WECHAT_WORKER_PROTOCOL_VERSION,
  kind: 'event',
  generation: 'generation-1',
  sequence,
  event: 'messages.delta',
  payload: {
    subscriptionId: 'subscription-1',
    batchId,
    nextCursor,
    messages: [{
      messageId,
      accountKey: 'account-opaque',
      contactKey: 'contact-1',
      direction: 'incoming',
      messageType: 'text',
      occurredAt: '2026-08-30T12:59:30+08:00',
      text: '周末可以到公司看看',
    }],
  },
});

describe('WechatLiveService', () => {
  it('pauses the selected chat without stopping the account metadata reader', async () => {
    const manager = new FakeManager();
    const service = new WechatLiveService({ accountRoot: 'C:\\synthetic', manager, now });
    await service.start(); await service.watchContacts(['contact-1']);
    const stopped = await service.unwatchContacts();
    expect(stopped).toMatchObject({ accountKey: 'account-opaque', status: { state: 'ready', monitoring: false } });
    expect(manager.requestCalls.filter((call) => call.command === 'stream.pause'))
      .toEqual([{ command: 'stream.pause', payload: { subscriptionId: 'subscription-1' } }]);
    expect(manager.stopCalls).toBe(0);
    const listener = vi.fn(); service.subscribe(listener);
    manager.emitEvent(deltaEvent(1, 'old-batch', 'old-message', 'old-cursor'));
    expect(listener).not.toHaveBeenCalled();
    await service.unwatchContacts();
    expect(manager.requestCalls.filter((call) => call.command === 'stream.pause')).toHaveLength(1);
    service.dispose();
  });

  it('cancels and pauses a watch whose native subscription resolves after the chat was hidden', async () => {
    const manager = new FakeManager();
    let resolveWatch!: (result: unknown) => void;
    manager.subscriptionResults.push(new Promise((resolve) => { resolveWatch = resolve; }));
    const service = new WechatLiveService({ accountRoot: 'C:\\synthetic', manager, now }); await service.start();
    const watching = service.watchContacts(['contact-1']);
    const cancelled = expect(watching).rejects.toMatchObject({ message: '会话切换已取消，请重新选择会话' });
    await settlePromises();
    const hiding = service.unwatchContacts();
    resolveWatch({ subscriptionId: 'late-subscription', cursor: 'late-cursor' });
    await cancelled; await hiding;
    expect(manager.requestCalls).toContainEqual({ command: 'stream.pause', payload: { subscriptionId: 'late-subscription' } });
    expect(service.snapshot().status.monitoring).toBe(false);
    expect(manager.subscriptionCalls).toBe(1);
    service.dispose();
  });

  it('stops the reader safely if a hidden chat subscription cannot be paused', async () => {
    const manager = new FakeManager();
    const service = new WechatLiveService({ accountRoot: 'C:\\synthetic', manager, now });
    await service.start(); await service.watchContacts(['contact-1']);
    const request = manager.request.bind(manager);
    vi.spyOn(manager, 'request').mockImplementation((command, payload) =>
      command === 'stream.pause' ? Promise.reject(new Error('private-path')) : request(command, payload));
    await expect(service.unwatchContacts()).rejects.toMatchObject({ message: '微信数据暂时不可用，请稍后重试' });
    expect(service.snapshot().status).toMatchObject({ state: 'fatal', monitoring: false });
    expect(manager.stopCalls).toBe(1);
    expect(JSON.stringify(service.snapshot())).not.toContain('private-path');
    service.dispose();
  });

  it('does not rewind the acknowledged live cursor after reading earlier history', async () => {
    const manager = new FakeManager();
    const service = new WechatLiveService({ accountRoot: 'C:\\synthetic', manager, now });
    await service.start(); await service.watchContacts(['contact-1']);
    manager.emitEvent(deltaEvent(1, 'new-batch', 'new-message', 'acknowledged-cursor'));
    manager.snapshotResult = { contactKey: 'contact-1', cursor: 'history-read-cursor', messages: [] };
    await service.messagesSnapshot('contact-1', 500);
    manager.emitState('backoff', 'generation-1'); manager.emitState('ready', 'generation-2');
    await settlePromises();
    expect(manager.requestCalls.filter((call) => call.command === 'stream.subscribe').at(-1)?.payload.cursor)
      .toBe('acknowledged-cursor');
    service.dispose();
  });

  it('drops one-use initial cursors on stop and when their short handoff window expires', async () => {
    const manager = new FakeManager(); let time = now().getTime();
    const service = new WechatLiveService({ accountRoot: 'C:\\synthetic', manager, now: () => new Date(time) });
    await service.start(); await service.messagesSnapshot('contact-1'); time += 15_001;
    await service.watchContacts(['contact-1']);
    expect(manager.requestCalls.filter((call) => call.command === 'stream.subscribe').at(-1)?.payload.cursor).toBeUndefined();
    await service.stop(); await service.start(); await service.watchContacts(['contact-1']);
    expect(manager.requestCalls.filter((call) => call.command === 'stream.subscribe').at(-1)?.payload.cursor).toBeUndefined();
    service.dispose();
  });

  it('reuses the fresh initial message cursor for subscription without another baseline read', async () => {
    const manager = new FakeManager();
    const service = new WechatLiveService({ accountRoot: 'C:\\synthetic', manager, now });
    await service.start();
    await service.messagesSnapshot('contact-1', 200);
    await service.watchContacts(['contact-1']);
    expect(manager.requestCalls.filter((call) => call.command === 'messages.snapshot')).toHaveLength(1);
    expect(manager.requestCalls.find((call) => call.command === 'stream.subscribe')?.payload)
      .toEqual({ accountKey: 'account-opaque', contactKeys: ['contact-1'], cursor: 'cursor-snapshot' });
    service.dispose();
  });

  it('does not pause and recreate a healthy subscription when refreshing the same chat', async () => {
    const manager = new FakeManager();
    const service = new WechatLiveService({ accountRoot: 'C:\\synthetic', manager, now });
    await service.start();
    await service.watchContacts(['contact-1']);
    await service.messagesSnapshot('contact-1', 200);
    await service.watchContacts(['contact-1']);
    await service.messagesSnapshot('contact-1', 500);
    await service.watchContacts(['contact-1']);
    expect(manager.subscriptionCalls).toBe(1);
    expect(manager.requestCalls.filter((call) => call.command === 'stream.pause')).toHaveLength(0);
    service.dispose();
  });

  it('does not send hidden service conversations to the renderer or register their avatars', async () => {
    const manager = new FakeManager();
    manager.engineStartResults.push({ accountKey: 'account-opaque', conversations: [
      { contactKey: 'contact-1', displayName: '微信团队', kind: 'contact' },
      { contactKey: 'group-1', displayName: '合成群', kind: 'group' },
      { contactKey: 'official-1', displayName: '合成公众号', kind: 'official' },
      { contactKey: 'service-1', displayName: '合成服务', kind: 'other' },
    ] });
    const service = new WechatLiveService({ accountRoot: 'C:\\synthetic', manager, now });
    const snapshot = await service.start();
    expect(snapshot.conversations.map((row) => row.contactKey)).toEqual(['contact-1', 'group-1']);
    await expect(service.messagesSnapshot('official-1')).rejects.toBeInstanceOf(WechatLiveServiceError);
    expect(manager.requestCalls.filter((call) => call.command === 'messages.snapshot')).toHaveLength(0);
    service.dispose();
  });

  const historyMessage = (index: number, patch: Record<string, unknown> = {}) => ({
    messageId: `history:${index}`, accountKey: 'account-opaque', contactKey: 'contact-1',
    direction: 'incoming', messageType: 'text', text: `合成历史${index}`,
    occurredAt: new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString(), ...patch,
  });

  it('maps actual self and group sender avatars to current-account opaque aliases', async () => {
    const manager = new FakeManager(), self = `media_${'a'.repeat(64)}`, peer = `media_${'b'.repeat(64)}`;
    manager.engineStartResults.push({ accountKey: 'account-opaque', selfAvatarMediaKey: self,
      conversations: [{ contactKey: 'contact-1', displayName: '合成群', kind: 'group', avatarMediaKey: `media_${'c'.repeat(64)}` }] });
    const service = new WechatLiveService({ accountRoot: 'C:\\synthetic', manager, now });
    const initial = await service.start();
    expect(initial.selfAvatarMediaKey).toMatch(/^[a-f0-9]{64}$/u);
    manager.snapshotResult = { contactKey: 'contact-1', messages: [
      historyMessage(0, { direction: 'outgoing', senderAvatarMediaKey: self }),
      historyMessage(1, { senderAvatarMediaKey: peer, senderDisplayName: '真实合成群成员' }),
      historyMessage(2),
      historyMessage(3, { direction: 'system', messageType: 'system' }),
    ] };
    const messages = await service.messagesSnapshot('contact-1');
    expect(messages[0]).toMatchObject({ sender: '我', senderAvatarMediaKey: initial.selfAvatarMediaKey });
    expect(messages[1]).toMatchObject({ sender: '真实合成群成员', senderDisplayName: '真实合成群成员' });
    expect(messages[1].senderAvatarMediaKey).toMatch(/^[a-f0-9]{64}$/u);
    expect(messages[1].senderAvatarMediaKey).not.toBe(initial.conversations[0].avatarMediaKey);
    expect(messages[2]).toMatchObject({ sender: '群成员' }); expect(messages[2].senderAvatarMediaKey).toBeUndefined();
    expect(messages[3].senderAvatarMediaKey).toBeUndefined(); expect(messages[3].senderDisplayName).toBeUndefined();
    expect(JSON.stringify(messages)).not.toContain('media_');
    await service.stop(); expect(service.snapshot().selfAvatarMediaKey).toBeUndefined();
    expect(await service.mediaForRenderer(initial.selfAvatarMediaKey)).toMatchObject({ ok: false });
    service.dispose();
  });

  it('registers voice separately from image media and revokes audio access on stop', async () => {
    const manager = new FakeManager(), voice = `media_${'d'.repeat(64)}`;
    const bytes = Buffer.from('\x02#!SILK_V3\x01\x00\x00', 'binary');
    const original = manager.request.bind(manager);
    const request = vi.spyOn(manager, 'request').mockImplementation(async (command, payload) => command === 'voice.read'
      ? { ok: true, mime: 'audio/x-silk', offset: payload.offset, totalBytes: bytes.length, nextOffset: bytes.length, data: bytes.toString('base64') }
      : original(command, payload));
    const service = new WechatLiveService({ accountRoot: 'C:\\synthetic', manager, now }); await service.start();
    manager.snapshotResult = { contactKey: 'contact-1', messages: [historyMessage(1, { messageType: 'voice', text: undefined, voiceMediaKey: voice })] };
    const [message] = await service.messagesSnapshot('contact-1');
    expect(message.voiceMediaKey).toMatch(/^[a-f0-9]{64}$/u); expect(message.text).toBe('[语音]');
    expect(await service.mediaForRenderer(message.voiceMediaKey)).toMatchObject({ ok: false });
    expect(await service.readVoice(voice)).toBeUndefined();
    const result = await service.readVoice(message.voiceMediaKey);
    expect(result).toEqual({ bytes, format: 'silk' }); result?.bytes.fill(0);
    expect(request).toHaveBeenCalledWith('voice.read', { accountKey: 'account-opaque', mediaKey: voice, offset: 0 }, 8000);
    await service.stop(); expect(await service.readVoice(message.voiceMediaKey)).toBeUndefined();
    service.dispose();
  });

  it('exports more than 500 messages through all bounded history pages with a fixed upper time', async () => {
    const manager = new FakeManager();
    for (let offset = 0; offset < 1201; offset += 200) {
      const count = Math.min(200, 1201 - offset), done = offset + count === 1201;
      manager.historyPageResults.push({ contactKey: 'contact-1', done,
        messages: Array.from({ length: count }, (_, index) => historyMessage(offset + index)),
        ...(done ? {} : { nextCursor: `history:${offset + count}` }) });
    }
    const service = new WechatLiveService({ accountRoot: 'C:\\synthetic', manager, now }); await service.start();
    const ids: string[] = [];
    for await (const page of service.exportMessages('contact-1')) {
      expect(page.length).toBeLessThanOrEqual(200); ids.push(...page.map((message) => message.id));
    }
    expect(ids).toEqual(Array.from({ length: 1201 }, (_, index) => `history:${index}`));
    const reads = manager.requestCalls.filter((call) => call.command === 'messages.history');
    expect(reads).toHaveLength(7);
    expect(reads[0].payload).toEqual({ accountKey: 'account-opaque', contactKey: 'contact-1', limit: 200, from: 946684800, to: now().getTime() / 1000 });
    expect(reads[1].payload).toMatchObject({ cursor: 'history:200' });
    expect(new Set(reads.map((call) => call.payload.to)).size).toBe(1);
    expect(manager.requestCalls.some((call) => call.command === 'messages.snapshot')).toBe(false); service.dispose();
  });

  it('deduplicates replicated history at page boundaries and never treats a repeated cursor as completion', async () => {
    const manager = new FakeManager();
    manager.historyPageResults.push(
      { contactKey: 'contact-1', messages: [historyMessage(1), historyMessage(2)], done: false, nextCursor: 'history:2' },
      { contactKey: 'contact-1', messages: [historyMessage(2), historyMessage(3)], done: true },
    );
    const service = new WechatLiveService({ accountRoot: 'C:\\synthetic', manager, now }); await service.start();
    const ids = []; for await (const page of service.exportMessages('contact-1')) ids.push(...page.map((message) => message.id));
    expect(ids).toEqual(['history:1', 'history:2', 'history:3']);
    manager.historyPageResults.push(
      { contactKey: 'contact-1', messages: [historyMessage(1)], done: false, nextCursor: 'history:again' },
      { contactKey: 'contact-1', messages: [], done: false, nextCursor: 'history:again' },
    );
    const iterator = service.exportMessages('contact-1'); await iterator.next();
    await expect(iterator.next()).rejects.toThrow('未完成导出'); service.dispose();
  });

  it.each(['abort', 'stop', 'restart'] as const)('rejects history completion after %s while a page is being consumed', async (mode) => {
    const manager = new FakeManager();
    manager.historyPageResults.push({ contactKey: 'contact-1', messages: [historyMessage(1)], done: true });
    const service = new WechatLiveService({ accountRoot: 'C:\\synthetic', manager, now }); await service.start();
    const controller = new AbortController(), iterator = service.exportMessages('contact-1', { signal: controller.signal });
    expect((await iterator.next()).done).toBe(false);
    if (mode === 'abort') controller.abort();
    else if (mode === 'stop') await service.stop();
    else manager.emitState('backoff', 'generation-2');
    await expect(iterator.next()).rejects.toThrow('历史导出已取消或微信账号已切换');
    service.dispose();
  });

  it('rejects foreign-account/date data and native errors without declaring a partial export complete', async () => {
    const manager = new FakeManager();
    const service = new WechatLiveService({ accountRoot: 'C:\\synthetic', manager, now }); await service.start();
    for (const patch of [{ accountKey: 'different-account' }, { contactKey: 'contact-other' }, { occurredAt: '2099-01-01T00:00:00Z' }]) {
      manager.historyPageResults.push({ contactKey: 'contact-1', done: true, messages: [historyMessage(1, patch)] });
      await expect(service.exportMessages('contact-1').next()).rejects.toThrow('未完成导出');
    }
    manager.historyPageResults.push(new Error('C:/private/account/messages.db'));
    await expect(service.exportMessages('contact-1').next()).rejects.toThrow('微信数据暂时不可用');
    await expect(service.exportMessages('contact-1', { from: 'not-a-date' }).next()).rejects.toThrow('日期范围无效');
    await expect(service.exportMessages('contact-other').next()).rejects.toThrow('请先在当前微信账号选择');
    service.dispose();
  });
  it('announces read-only validation without claiming login interception', async () => {
    const manager = new FakeManager();
    const service = new WechatLiveService({ accountRoot: 'C:\\wechat', manager, now });
    const running = service.start();
    expect(service.snapshot().status).toMatchObject({
      state: 'starting', detail: '正在只读校验微信数据',
    });
    await running;
    manager.emitEvent({
      protocolVersion: WECHAT_WORKER_PROTOCOL_VERSION,
      kind: 'event',
      generation: 'generation-1',
      sequence: 1,
      event: 'engine.state',
      payload: { state: 'waiting-login' },
    });
    expect(service.snapshot().status.detail).toBe('尚未完成微信只读校验，请保持微信已登录');
    expect(service.snapshot().status.detail).not.toContain('重新登录');
  });

  it('starts the engine, validates its account result, and returns a safe snapshot', async () => {
    const manager = new FakeManager();
    const service = new WechatLiveService({ accountRoot: 'C:\\wechat', manager, now });

    const snapshot = await service.start();

    expect(manager.requestCalls[0]).toEqual({
      command: 'engine.start',
      payload: { processIds: [] },
    });
    expect(snapshot).toMatchObject({
      status: { state: 'ready', monitoring: false },
      conversations: [{ contactKey: 'contact-1', displayName: '林先生' }],
    });
    expect(snapshot.accountKey).toBe('account-opaque');
    expect(JSON.stringify(snapshot)).not.toContain('C:\\wechat');
  });

  it('maps unknown native startup failures without exposing their message or local path', async () => {
    const manager = new FakeManager();
    manager.engineStartResults.push(new WechatWorkerCommandError(
      'native.secretFailure',
      'C:\\Users\\example-user\\secret\\session.db key=0123456789abcdef', // gitleaks:allow -- Synthetic error-message fixture.
      false,
    ));
    const service = new WechatLiveService({ accountRoot: 'C:\\wechat', manager, now });

    await expect(service.start()).rejects.toMatchObject({
      name: 'WechatLiveServiceError',
      message: '微信数据暂时不可用，请稍后重试',
    });
    expect(service.snapshot().status).toMatchObject({
      state: 'fatal',
      detail: '微信数据暂时不可用，请稍后重试',
    });
    expect(JSON.stringify(service.snapshot())).not.toContain('session.db');
    expect(JSON.stringify(service.snapshot())).not.toContain('0123456789abcdef');
  });

  it('maps a known key error to fixed guidance without returning the native detail', async () => {
    const manager = new FakeManager();
    manager.engineStartResults.push(new WechatWorkerCommandError(
      'key.unavailable',
      'hook failed at C:\\private\\wx_key.dll',
      true,
    ));
    const service = new WechatLiveService({ accountRoot: 'C:\\wechat', manager, now });

    await expect(service.start()).rejects.toMatchObject({
      message: '尚未找到通过校验的微信读取凭证，数据验证未完成；不能据此判定账号目录选错',
    });
    expect(service.snapshot().status.detail).toBe(
      '尚未找到通过校验的微信读取凭证，数据验证未完成；不能据此判定账号目录选错',
    );
    expect(service.snapshot().status.detail).not.toContain('wx_key.dll');
  });

  it.each([
    ['key.accessDenied', '当前微信进程拒绝访问，请确认本软件与微信使用同一 Windows 用户及相同运行权限'],
    ['key.hookFailed', '微信读取组件未能连接到微信进程，请检查当前微信版本的兼容性'],
    ['key.waitTimeout', '微信只读校验已超时，尚未验证成功；请稍后重试，不能据此判定账号目录选错'],
    ['database.initialize', '微信数据库引擎初始化失败，请检查本地读取组件'],
    ['database.open', '微信数据库暂时无法只读打开，请检查文件访问权限及读取组件兼容性'],
    ...databaseFailureGuidance,
    ...readOnlyFailureGuidance,
  ] satisfies ReadonlyArray<readonly [string, string]>)('maps %s to actionable guidance without leaking native details', async (code, detail) => {
    const manager = new FakeManager();
    manager.engineStartResults.push(new WechatWorkerCommandError(
      code, 'C:\\private\\wx_key.dll native-detail key=0123456789abcdef', true, // gitleaks:allow -- Synthetic error-message fixture.
    ));
    const service = new WechatLiveService({ accountRoot: 'C:\\wechat', manager, now });

    await expect(service.start()).rejects.toMatchObject({ message: detail });
    expect(service.snapshot().status).toMatchObject({ state: 'fatal', detail });
    expect(JSON.stringify(service.snapshot())).not.toContain('native-detail');
    expect(JSON.stringify(service.snapshot())).not.toContain('C:\\private');
    expect(JSON.stringify(service.snapshot())).not.toContain('0123456789abcdef');
    expect(service.snapshot().status.detail).not.toContain('重新登录');
  });

  it.each([...databaseFailureGuidance, ...readOnlyFailureGuidance])('maps the %s status event without inferring an account mismatch', async (code, detail) => {
    const manager = new FakeManager();
    const service = new WechatLiveService({ accountRoot: 'C:\\wechat', manager, now });
    await service.start();

    manager.emitEvent({
      protocolVersion: WECHAT_WORKER_PROTOCOL_VERSION,
      kind: 'event',
      generation: 'generation-1',
      sequence: 1,
      event: 'engine.state',
      payload: { state: 'backoff', detailCode: code },
    });

    expect(service.snapshot().status).toMatchObject({ state: 'backoff', detail });
    expect(service.snapshot().status.detail).not.toContain('账号目录不一致');
    expect(service.snapshot().status.detail).not.toContain('重新登录');
  });

  it.each(['messages.snapshot', 'stream.subscribe'] as const)(
    'preserves fixed database error guidance for %s without exposing native content', async (command) => {
      const manager = new FakeManager();
      const service = new WechatLiveService({ accountRoot: 'C:\\wechat', manager, now });
      await service.start();
      vi.spyOn(manager, 'request').mockRejectedValue(new WechatWorkerCommandError(
        'database.direction', 'private message C:\\private\\message.db key=0123456789abcdef', false, // gitleaks:allow -- Synthetic error-message fixture.
      ));
      const operation = command === 'messages.snapshot'
        ? service.messagesSnapshot('contact-1') : service.watchContacts(['contact-1']);

      await expect(operation).rejects.toMatchObject({
        message: '无法可靠判断部分消息的收发方向，本次消息读取未完成',
      });
      expect(JSON.stringify(service.snapshot())).not.toContain('private');
      expect(JSON.stringify(service.snapshot())).not.toContain('0123456789abcdef');
    },
  );

  it.each(databaseFailureGuidance)('ignores a stale generation status event carrying %s after reconnecting', async (code) => {
    const manager = new FakeManager();
    const service = new WechatLiveService({ accountRoot: 'C:\\wechat', manager, now });
    await service.start();
    await service.stop();
    await service.start();
    const connected = service.snapshot();
    const listener = vi.fn();
    service.subscribe(listener);

    manager.emitEvent({
      protocolVersion: WECHAT_WORKER_PROTOCOL_VERSION,
      kind: 'event',
      generation: 'generation-1',
      sequence: 1,
      event: 'engine.state',
      payload: { state: 'fatal', detailCode: code },
    });

    expect(manager.getSnapshot().generation).toBe('generation-2');
    expect(service.snapshot()).toEqual(connected);
    expect(listener).not.toHaveBeenCalled();
  });

  it('uses only known worker status codes and preserves a specific failure on generic error events', async () => {
    const manager = new FakeManager();
    const service = new WechatLiveService({ accountRoot: 'C:\\wechat', manager, now });
    await service.start();
    manager.emitEvent({
      protocolVersion: WECHAT_WORKER_PROTOCOL_VERSION,
      kind: 'event',
      generation: 'generation-1',
      sequence: 1,
      event: 'engine.state',
      payload: { state: 'backoff', detailCode: 'key.accessDenied' },
    });
    const detail = '当前微信进程拒绝访问，请确认本软件与微信使用同一 Windows 用户及相同运行权限';
    expect(service.snapshot().status).toMatchObject({ state: 'backoff', detail });

    manager.emitEvent({
      protocolVersion: WECHAT_WORKER_PROTOCOL_VERSION,
      kind: 'event',
      generation: 'generation-1',
      sequence: 2,
      event: 'engine.state',
      payload: { state: 'fatal', detailCode: 'C:\\private\\untrusted-error' },
    });
    manager.emitEvent({
      protocolVersion: WECHAT_WORKER_PROTOCOL_VERSION,
      kind: 'event',
      generation: 'generation-1',
      sequence: 3,
      event: 'engine.state',
      payload: { state: 'fatal' },
    });

    expect(service.snapshot().status).toMatchObject({ state: 'fatal', detail });
    expect(JSON.stringify(service.snapshot())).not.toContain('untrusted-error');
  });

  it.each([false, true])('ignores repeated ready notifications for an initialized generation (watching=%s)', async (watching) => {
    const manager = new FakeManager();
    const service = new WechatLiveService({ accountRoot: 'C:\\wechat', manager, now });
    await service.start();
    if (watching) await service.watchContacts(['contact-1']);
    const connected = service.snapshot();

    manager.emitState('ready', 'generation-1');
    await settlePromises();

    expect(service.snapshot()).toEqual(connected);
    expect(manager.engineStartCalls).toBe(1);
    expect(manager.subscriptionCalls).toBe(watching ? 1 : 0);
  });

  it('keeps a startup failure until an explicit retry instead of retrying on the same ready generation', async () => {
    const manager = new FakeManager();
    manager.engineStartResults.push(new WechatWorkerCommandError(
      'key.unavailable', 'private hook detail', true,
    ));
    const service = new WechatLiveService({ accountRoot: 'C:\\wechat', manager, now });
    await expect(service.start()).rejects.toBeInstanceOf(WechatLiveServiceError);
    const failed = service.snapshot();

    manager.emitState('ready', 'generation-1');
    await settlePromises();

    expect(service.snapshot()).toEqual(failed);
    expect(manager.engineStartCalls).toBe(1);
    expect(manager.getSnapshot()).toMatchObject({ state: 'ready', generation: 'generation-1' });
    expect(manager.stopCalls).toBe(0);
    await expect(service.start()).resolves.toMatchObject({ status: { state: 'ready' } });
    expect(manager.engineStartCalls).toBe(2);
    expect(manager.stopCalls).toBe(1);
    expect(manager.getSnapshot().generation).toBe('generation-2');
    expect(manager.subscriptionCalls).toBe(0);
  });

  it('cleans up a ready worker after a native identity failure before explicitly retrying', async () => {
    const manager = new FakeManager();
    manager.engineStartResults.push(new WechatWorkerCommandError(
      'database.identity', 'private account identity detail', false,
    ));
    const service = new WechatLiveService({ accountRoot: 'C:\\wechat', manager, now });
    await expect(service.start()).rejects.toMatchObject({
      message: '无法核实微信消息的收发身份，尚不能判定账号目录选错',
    });
    expect(manager.getSnapshot().state).toBe('ready');
    expect(manager.stopCalls).toBe(0);

    await expect(service.start()).resolves.toMatchObject({ status: { state: 'ready' } });

    expect(manager.stopCalls).toBe(1);
    expect(manager.getSnapshot().generation).toBe('generation-2');
    expect(manager.engineStartCalls).toBe(2);
  });

  it('clears a cached initialized session before explicitly retrying a fatal worker state', async () => {
    const manager = new FakeManager();
    const service = new WechatLiveService({ accountRoot: 'C:\\wechat', manager, now });
    await service.start();
    await service.watchContacts(['contact-1']);
    manager.emitEvent({
      protocolVersion: WECHAT_WORKER_PROTOCOL_VERSION,
      kind: 'event',
      generation: 'generation-1',
      sequence: 1,
      event: 'engine.state',
      payload: { state: 'fatal', detailCode: 'database.identity' },
    });
    let resolveRetry!: (value: unknown) => void;
    manager.engineStartResults.push(new Promise((resolve) => {
      resolveRetry = resolve;
    }));

    const retried = service.start();
    await vi.waitFor(() => expect(manager.engineStartCalls).toBe(2));
    expect(service.snapshot()).toMatchObject({
      status: { state: 'starting' }, conversations: [],
    });
    resolveRetry({
      accountKey: 'account-opaque',
      conversations: [{ contactKey: 'contact-1', displayName: '已刷新联系人', kind: 'contact' }],
    });

    await expect(retried).resolves.toMatchObject({
      status: { state: 'ready' },
      conversations: [{ displayName: '已刷新联系人' }],
    });
    expect(manager.stopCalls).toBe(1);
    expect(manager.getSnapshot().generation).toBe('generation-2');
    expect(manager.subscriptionCalls).toBe(1);
  });

  it('does not let a discarded initialization poison a successful explicit retry from fatal', async () => {
    let rejectFirst!: (reason: Error) => void;
    const manager = new FakeManager();
    manager.engineStartResults.push(new Promise((_resolve, reject) => {
      rejectFirst = reject;
    }));
    const service = new WechatLiveService({ accountRoot: 'C:\\wechat', manager, now });
    const firstStart = service.start();
    const cancelled = expect(firstStart).rejects.toMatchObject({
      message: '微信实时读取启动已取消',
    });
    await vi.waitFor(() => expect(manager.engineStartCalls).toBe(1));
    manager.emitEvent({
      protocolVersion: WECHAT_WORKER_PROTOCOL_VERSION,
      kind: 'event',
      generation: 'generation-1',
      sequence: 1,
      event: 'engine.state',
      payload: { state: 'fatal', detailCode: 'database.identity' },
    });

    const retried = service.start();
    try {
      await vi.waitFor(() => expect(manager.engineStartCalls).toBe(2));
      const connected = await retried;
      rejectFirst(new WechatWorkerCommandError('database.identity', 'old native detail', false));
      await cancelled;
      await settlePromises();

      expect(service.snapshot()).toEqual(connected);
      expect(manager.stopCalls).toBe(1);
      expect(manager.getSnapshot().generation).toBe('generation-2');
    } finally {
      rejectFirst(new WechatWorkerCommandError('database.identity', 'old native detail', false));
      await Promise.allSettled([firstStart, cancelled, retried]);
    }
  });

  it('preserves safe diagnostic guidance when a background generation fails to initialize', async () => {
    const manager = new FakeManager();
    const service = new WechatLiveService({ accountRoot: 'C:\\wechat', manager, now });
    await service.start();
    manager.engineStartResults.push(new WechatWorkerCommandError(
      'database.open', 'private native database detail', true,
    ));

    manager.emitState('backoff', 'generation-1');
    manager.emitState('ready', 'generation-2');
    await settlePromises();

    expect(service.snapshot().status).toMatchObject({
      state: 'fatal',
      detail: '微信数据库暂时无法只读打开，请检查文件访问权限及读取组件兼容性',
    });
    expect(JSON.stringify(service.snapshot())).not.toContain('private native');
  });

  it('treats a superseded startup as cancelled and cannot poison a later successful start', async () => {
    let resolveFirst!: (value: unknown) => void;
    const firstResult = new Promise<unknown>((resolve) => {
      resolveFirst = resolve;
    });
    const successfulResult = {
      accountKey: 'account-opaque',
      conversations: [{
        contactKey: 'contact-1',
        displayName: '林先生',
        kind: 'contact',
      }],
    };
    const manager = new FakeManager();
    manager.engineStartResults.push(firstResult, successfulResult);
    const service = new WechatLiveService({ accountRoot: 'C:\\wechat', manager, now });

    const firstStart = service.start();
    await vi.waitFor(() => expect(manager.engineStartCalls).toBe(1));
    await service.stop();
    await expect(service.start()).resolves.toMatchObject({ status: { state: 'ready' } });
    resolveFirst(successfulResult);

    await expect(firstStart).rejects.toMatchObject({
      name: 'WechatLiveServiceError',
      message: '微信实时读取启动已取消',
    });
    expect(service.snapshot().status).toMatchObject({ state: 'ready', monitoring: false });
  });

  it('ignores an old background initialization rejection after stopping and starting successfully', async () => {
    let rejectFirst!: (reason: Error) => void;
    const firstResult = new Promise<unknown>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const manager = new FakeManager();
    manager.engineStartResults.push(firstResult);
    const service = new WechatLiveService({ accountRoot: 'C:\\wechat', manager, now });
    const firstStart = service.start();
    const cancelled = expect(firstStart).rejects.toMatchObject({
      message: '微信实时读取启动已取消',
    });
    await vi.waitFor(() => expect(manager.engineStartCalls).toBe(1));
    await service.stop();
    await service.start();
    const connected = service.snapshot();

    rejectFirst(new WechatWorkerCommandError('key.unavailable', 'old private error', true));
    await cancelled;
    await settlePromises();

    expect(service.snapshot()).toEqual(connected);
  });

  it.each(databaseFailureGuidance)('ignores an old %s startup rejection after a replacement generation succeeds', async (code) => {
    let rejectFirst!: (reason: Error) => void;
    const firstResult = new Promise<unknown>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const manager = new FakeManager();
    manager.engineStartResults.push(firstResult);
    const service = new WechatLiveService({ accountRoot: 'C:\\wechat', manager, now });
    const firstStart = service.start();
    const cancelled = expect(firstStart).rejects.toMatchObject({
      message: '微信实时读取启动已取消',
    });
    await vi.waitFor(() => expect(manager.engineStartCalls).toBe(1));
    manager.emitState('backoff', 'generation-1');
    manager.emitState('ready', 'generation-2');
    await vi.waitFor(() => expect(service.snapshot().status.state).toBe('ready'));
    const connected = service.snapshot();

    rejectFirst(new WechatWorkerCommandError(code, 'old private error key=0123456789abcdef', true)); // gitleaks:allow -- Synthetic error-message fixture.
    await cancelled;
    await settlePromises();

    expect(service.snapshot()).toEqual(connected);
  });

  it('converts deltas, acknowledges every batch, and drops duplicate messages', async () => {
    const manager = new FakeManager();
    const service = new WechatLiveService({ accountRoot: 'C:\\wechat', manager, now });
    const received = vi.fn();
    service.subscribe(received);
    await service.start();
    await service.watchContacts(['contact-1']);
    received.mockClear();

    manager.emitEvent(deltaEvent(1, 'batch-1', 'message-1', 'cursor-1'));
    manager.emitEvent(deltaEvent(2, 'batch-2', 'message-1', 'cursor-2'));

    expect(received).toHaveBeenCalledTimes(1);
    expect(received.mock.calls[0][0]).toMatchObject({
      contactKey: 'contact-1',
      messages: [{
        id: 'message-1',
        sender: '城西客户',
        sentAt: '2026-08-30T04:59:30.000Z',
        observedAt: '2026-08-30T05:00:00.000Z',
      }],
    });
    expect(manager.requestCalls.filter((call) => call.command === 'batch.ack')).toEqual([
      {
        command: 'batch.ack',
        payload: {
          subscriptionId: 'subscription-1',
          batchId: 'batch-1',
          cursor: 'cursor-1',
        },
      },
      {
        command: 'batch.ack',
        payload: {
          subscriptionId: 'subscription-1',
          batchId: 'batch-2',
          cursor: 'cursor-2',
        },
      },
    ]);
  });

  it('preserves the exact source sequence when converting snapshots and live deltas', async () => {
    const manager = new FakeManager();
    const service = new WechatLiveService({ accountRoot: 'C:\\wechat', manager, now });
    await service.start();
    const sourceMessages = ['9007199254740992', '9007199254740993'].map((sortSequence, index) => ({
      messageId: index ? 'a-newer' : 'z-older', accountKey: 'account-opaque', contactKey: 'contact-1',
      direction: 'incoming', messageType: 'text', occurredAt: '2026-08-31T01:00:00.000Z',
      text: `合成消息${index}`, sortSequence,
    }));
    manager.snapshotResult = { contactKey: 'contact-1', messages: sourceMessages };
    const snapshot = await service.messagesSnapshot('contact-1');
    expect(snapshot.map((message) => message.sortSequence)).toEqual(sourceMessages.map((message) => message.sortSequence));
    expect(snapshot.map((message) => message.id)).toEqual(['z-older', 'a-newer']);
    await service.watchContacts(['contact-1']);
    const received = vi.fn();
    service.subscribe(received);
    const event = deltaEvent(1, 'batch-ordered', 'unused', 'cursor-ordered');
    event.payload.messages = sourceMessages;
    manager.emitEvent(event);
    expect(received.mock.calls.at(-1)?.[0].messages).toEqual(snapshot);
    expect(manager.requestCalls.filter((call) => call.command === 'batch.ack')).toHaveLength(1);
  });

  it.each([9007199254740992, '9223372036854775808', '-9223372036854775809', 'private/path key=DO_NOT_FORWARD'])(
    'rejects unsafe snapshot and delta sequence %s without exposing its raw value', async (sortSequence) => {
      const manager = new FakeManager();
      const service = new WechatLiveService({ accountRoot: 'C:\\wechat', manager, now });
      await service.start();
      const event = deltaEvent(1, 'batch-invalid-order', 'message-1', 'cursor-invalid-order');
      event.payload.messages = [{
        messageId: 'message-1', accountKey: 'account-opaque', contactKey: 'contact-1',
        direction: 'incoming', messageType: 'text', occurredAt: '2026-08-31T01:00:00.000Z', sortSequence,
      }];
      manager.snapshotResult = { contactKey: 'contact-1', messages: event.payload.messages };
      await expect(service.messagesSnapshot('contact-1')).rejects.toEqual(new WechatLiveServiceError());
      await service.watchContacts(['contact-1']);
      const received = vi.fn();
      service.subscribe(received);
      manager.emitEvent(event);
      expect(service.snapshot().status.state).toBe('fatal');
      expect(received.mock.calls.every(([delta]) => delta.messages.length === 0)).toBe(true);
      expect(manager.requestCalls.filter((call) => call.command === 'batch.ack')).toHaveLength(0);
      expect(JSON.stringify(service.snapshot())).not.toContain('DO_NOT_FORWARD');
      expect(JSON.stringify(received.mock.calls)).not.toContain('private/path');
    },
  );

  it('preserves neutral system deltas, acknowledges their cursors, and never labels them as the customer', async () => {
    const manager = new FakeManager();
    const service = new WechatLiveService({ accountRoot: 'C:\\wechat', manager, now });
    const received = vi.fn();
    service.subscribe(received);
    await service.start();
    await service.watchContacts(['contact-1']);
    received.mockClear();
    const event = deltaEvent(1, 'batch-system-1', 'system-1', 'cursor-system-1');
    event.payload.messages = [{
      messageId: 'system-1', accountKey: 'account-opaque', contactKey: 'contact-1',
      direction: 'system', messageType: 'system',
      occurredAt: '2026-08-30T12:59:30+08:00', text: '周六可以来，预算300万',
    }];
    manager.emitEvent(event);
    manager.emitEvent({
      ...event, sequence: 2,
      payload: { ...event.payload, batchId: 'batch-system-2', nextCursor: 'cursor-system-2' },
    });

    expect(received).toHaveBeenCalledTimes(1);
    expect(received.mock.calls[0][0].messages).toEqual([expect.objectContaining({
      id: 'system-1', direction: 'system', messageType: 'system', sender: '微信系统',
      text: '[微信系统] 周六可以来，预算300万',
    })]);
    expect(manager.requestCalls.filter((call) => call.command === 'batch.ack').map((call) => call.payload))
      .toEqual([
        { subscriptionId: 'subscription-1', batchId: 'batch-system-1', cursor: 'cursor-system-1' },
        { subscriptionId: 'subscription-1', batchId: 'batch-system-2', cursor: 'cursor-system-2' },
      ]);
    expect(service.snapshot().status.state).toBe('streaming');
  });

  it('restarts engine.start and restores contacts and cursor after a new generation is ready', async () => {
    const manager = new FakeManager();
    const service = new WechatLiveService({ accountRoot: 'C:\\wechat', manager, now });
    await service.start();
    await service.watchContacts(['contact-1']);
    manager.emitEvent(deltaEvent(1, 'batch-1', 'message-1', 'cursor-9'));

    manager.emitState('backoff', 'generation-1');
    manager.emitState('ready', 'generation-2');

    await vi.waitFor(() => expect(manager.engineStartCalls).toBe(2));
    await vi.waitFor(() => expect(manager.subscriptionCalls).toBe(2));
    expect(manager.requestCalls.filter((call) => call.command === 'stream.subscribe')[1])
      .toEqual({
        command: 'stream.subscribe',
        payload: {
          accountKey: 'account-opaque',
          contactKeys: ['contact-1'],
          cursor: 'cursor-9',
        },
      });
    expect(service.snapshot().status).toMatchObject({ state: 'streaming', monitoring: true });
  });

  it('validates snapshot results and never exposes a native error to callers', async () => {
    const manager = new FakeManager();
    const service = new WechatLiveService({ accountRoot: 'C:\\wechat', manager, now });
    await service.start();
    manager.snapshotResult = { privatePath: 'C:\\secret\\db', error: 'native key failed' };

    await expect(service.messagesSnapshot('contact-1')).rejects.toEqual(
      new WechatLiveServiceError(),
    );
  });

  it('keeps a system notification in its original snapshot position without an invented human sender', async () => {
    const manager = new FakeManager();
    const service = new WechatLiveService({ accountRoot: 'C:\\wechat', manager, now });
    await service.start();
    const common = {
      accountKey: 'account-opaque', contactKey: 'contact-1',
      occurredAt: '2026-08-30T12:59:30+08:00',
    };
    manager.snapshotResult = {
      contactKey: 'contact-1',
      messages: [
        { ...common, messageId: 'before', direction: 'incoming', messageType: 'text', text: '你好' },
        { ...common, messageId: 'system-1', direction: 'system', messageType: 'system', text: '周六可以来，预算300万' },
        { ...common, messageId: 'after', direction: 'outgoing', messageType: 'text', text: '收到' },
      ],
    };

    const messages = await service.messagesSnapshot('contact-1');
    expect(messages.map((message) => message.id)).toEqual(['before', 'system-1', 'after']);
    expect(messages.map((message) => message.sender)).toEqual(['城西客户', '微信系统', '我']);
    expect(messages[1]).toMatchObject({
      direction: 'system', messageType: 'system', text: '[微信系统] 周六可以来，预算300万',
    });
  });

  it.each([
    ['system', 'text'],
    ['system', 'other'],
    ['incoming', 'system'],
    ['outgoing', 'system'],
    ['unknown', 'text'],
    [undefined, 'text'],
  ])('rejects direction %s / type %s in snapshots instead of guessing the human sender', async (direction, messageType) => {
    const manager = new FakeManager();
    const service = new WechatLiveService({ accountRoot: 'C:\\wechat', manager, now });
    await service.start();
    manager.snapshotResult = {
      contactKey: 'contact-1',
      messages: [{
        messageId: 'message-1', accountKey: 'account-opaque', contactKey: 'contact-1',
        direction, messageType, occurredAt: '2026-08-30T12:59:30+08:00', text: '周六可以来',
      }],
    };
    await expect(service.messagesSnapshot('contact-1')).rejects.toEqual(new WechatLiveServiceError());
  });

  it('normalizes trusted snapshot timestamps and keeps the receipt time separate', async () => {
    const manager = new FakeManager();
    const service = new WechatLiveService({ accountRoot: 'C:\\wechat', manager, now });
    await service.start();
    manager.snapshotResult = {
      contactKey: 'contact-1',
      messages: [{
        messageId: 'message-'.padEnd(120, 'x'),
        accountKey: 'account-opaque',
        contactKey: 'contact-1',
        direction: 'outgoing',
        messageType: 'image',
        occurredAt: '2026-08-30T12:59:30+08:00',
      }],
    };

    await expect(service.messagesSnapshot('contact-1')).resolves.toMatchObject([{
      sender: '我',
      text: '[图片]',
      sentAt: '2026-08-30T04:59:30.000Z',
      observedAt: '2026-08-30T05:00:00.000Z',
    }]);
  });

  it('stops the worker and does not restore a subscription after a later ready signal', async () => {
    const manager = new FakeManager();
    const service = new WechatLiveService({ accountRoot: 'C:\\wechat', manager, now });
    await service.start();
    await service.watchContacts(['contact-1']);

    const stopped = await service.stop();
    manager.emitState('ready', 'generation-2');
    await Promise.resolve();

    expect(manager.requestCalls.some((call) => call.command === 'engine.stop')).toBe(true);
    expect(manager.stopCalls).toBe(1);
    expect(manager.engineStartCalls).toBe(1);
    expect(manager.subscriptionCalls).toBe(1);
    expect(stopped).toMatchObject({ status: { state: 'stopped', monitoring: false } });
  });

  it('merges metadata pages and explicitly refreshes them without fetching message bodies', async () => {
    const manager = new FakeManager();
    const first = { contactKey: 'contact-1', displayName: '合成会话一', kind: 'contact', unreadCount: 3, preview: '合成摘要' };
    const second = { contactKey: 'contact-2', displayName: '合成会话二', kind: 'group' };
    manager.engineStartResults.push({ accountKey: 'account-opaque', conversations: [first], nextConversationCursor: 'page:next' });
    manager.conversationPageResults.push(
      { accountKey: 'account-opaque', conversations: [second] },
      { accountKey: 'account-opaque', conversations: [{ ...second, unreadCount: 1 }] },
    );
    const service = new WechatLiveService({ accountRoot: 'C:\\wechat', manager, now });
    const start = await service.start();
    expect(start.nextConversationCursor).toBe('page:next');
    const complete = await service.conversationsPage(start.nextConversationCursor);
    expect(complete.conversations.map((item) => item.contactKey)).toEqual(['contact-1', 'contact-2']);
    expect(complete).not.toHaveProperty('nextConversationCursor');
    const refreshed = await service.conversationsPage();
    expect(refreshed.conversations).toEqual([{ ...second, unreadCount: 1 }]);
    expect(manager.requestCalls.some((call) => call.command === 'messages.snapshot' || call.command === 'stream.subscribe')).toBe(false);
    expect(manager.requestCalls.filter((call) => call.command === 'conversations.list').map((call) => call.payload))
      .toEqual([{ accountKey: 'account-opaque', limit: 100, cursor: 'page:next' }, { accountKey: 'account-opaque', limit: 100 }]);
  });

  it('does not let an old metadata page overwrite a newer refresh', async () => {
    const manager = new FakeManager();
    let resolveOld!: (result: unknown) => void;
    manager.conversationPageResults.push(new Promise((resolve) => { resolveOld = resolve; }), {
      accountKey: 'account-opaque', conversations: [{ contactKey: 'contact-2', displayName: '新的合成会话', kind: 'contact' }],
    });
    const service = new WechatLiveService({ accountRoot: 'C:\\wechat', manager, now });
    await service.start();
    const old = service.conversationsPage();
    const cancelled = expect(old).rejects.toMatchObject({ message: '会话列表读取已取消，请重新刷新' });
    await settlePromises();
    const current = await service.conversationsPage();
    resolveOld({ accountKey: 'account-opaque', conversations: [{ contactKey: 'contact-old', displayName: '旧的合成会话', kind: 'contact' }] });
    await cancelled;
    expect(service.snapshot()).toEqual(current);
  });

  it('stops the previous subscription and reports failure instead of pretending a failed selection is streaming', async () => {
    const manager = new FakeManager();
    manager.engineStartResults.push({ accountKey: 'account-opaque', conversations: [
      { contactKey: 'contact-1', displayName: '合成会话一', kind: 'contact' },
      { contactKey: 'contact-2', displayName: '合成会话二', kind: 'contact' },
    ] });
    const service = new WechatLiveService({ accountRoot: 'C:\\wechat', manager, now });
    await service.start();
    await service.watchContacts(['contact-1']);
    manager.subscriptionResults.push(new WechatWorkerCommandError('database.schema', 'PRIVATE_PATH PRIVATE_CONTENT', false));
    await expect(service.watchContacts(['contact-2'])).rejects.toMatchObject({
      message: '当前微信数据库结构暂不受支持，请检查微信版本与读取组件兼容性',
    });
    expect(manager.requestCalls).toContainEqual({ command: 'stream.pause', payload: { subscriptionId: 'subscription-1' } });
    expect(service.snapshot().status.monitoring).toBe(false);
    const listener = vi.fn();
    service.subscribe(listener);
    manager.emitEvent(deltaEvent(1, 'batch-stale', 'message-stale', 'cursor-stale'));
    expect(listener).not.toHaveBeenCalled();
    expect(service.snapshot().status.state).not.toBe('fatal');
    expect(JSON.stringify(service.snapshot())).not.toContain('PRIVATE_');
  });

  it('serializes rapid A-to-B selection and discards a delayed A result', async () => {
    const manager = new FakeManager();
    manager.engineStartResults.push({ accountKey: 'account-opaque', conversations: [
      { contactKey: 'contact-1', displayName: '合成会话一', kind: 'contact' },
      { contactKey: 'contact-2', displayName: '合成会话二', kind: 'contact' },
    ] });
    let resolveFirst!: (result: unknown) => void;
    manager.subscriptionResults.push(new Promise((resolve) => { resolveFirst = resolve; }));
    const service = new WechatLiveService({ accountRoot: 'C:\\wechat', manager, now });
    await service.start();
    const first = service.watchContacts(['contact-1']);
    const cancelled = expect(first).rejects.toMatchObject({ message: '会话切换已取消，请重新选择会话' });
    await vi.waitFor(() => expect(manager.subscriptionCalls).toBe(1));
    manager.emitEvent({ protocolVersion: WECHAT_WORKER_PROTOCOL_VERSION, kind: 'event', generation: 'generation-1',
      sequence: 1, event: 'engine.state', payload: { state: 'streaming' } });
    expect(service.snapshot().status.monitoring).toBe(false);
    const second = service.watchContacts(['contact-2']);
    await settlePromises();
    expect(manager.subscriptionCalls).toBe(1);
    resolveFirst({ subscriptionId: 'subscription-first', cursor: 'cursor-first' });
    await cancelled;
    await expect(second).resolves.toMatchObject({ status: { state: 'streaming', monitoring: true } });
    expect(manager.requestCalls).toContainEqual({ command: 'stream.pause', payload: { subscriptionId: 'subscription-first' } });
    expect(manager.requestCalls.filter((call) => call.command === 'stream.subscribe').map((call) => call.payload.contactKeys))
      .toEqual([['contact-1'], ['contact-2']]);
    const listener = vi.fn();
    service.subscribe(listener);
    manager.emitEvent({ ...deltaEvent(1, 'batch-first', 'message-first', 'cursor-old'), payload: {
      ...deltaEvent(1, 'batch-first', 'message-first', 'cursor-old').payload, subscriptionId: 'subscription-first',
    } });
    expect(listener).not.toHaveBeenCalled();
    expect(service.snapshot().status.state).toBe('streaming');
  });

  it('rejects a snapshot that finishes after the worker generation was replaced', async () => {
    const manager = new FakeManager();
    let resolveOld!: (result: unknown) => void;
    manager.snapshotResult = new Promise((resolve) => { resolveOld = resolve; });
    const service = new WechatLiveService({ accountRoot: 'C:\\wechat', manager, now });
    await service.start();
    const pending = service.messagesSnapshot('contact-1');
    const rejected = expect(pending).rejects.toBeInstanceOf(WechatLiveServiceError);
    await settlePromises();
    await service.stop();
    await service.start();
    resolveOld({ contactKey: 'contact-1', messages: [] });
    await rejected;
    expect(service.snapshot().status.state).toBe('ready');
  });

  it('does not allow an old acknowledgement failure to change the selected conversation status', async () => {
    const manager = new FakeManager();
    manager.engineStartResults.push({ accountKey: 'account-opaque', conversations: [
      { contactKey: 'contact-1', displayName: '合成会话一', kind: 'contact' },
      { contactKey: 'contact-2', displayName: '合成会话二', kind: 'contact' },
    ] });
    let rejectAck!: (reason: unknown) => void;
    const pendingAck = new Promise((_resolve, reject) => { rejectAck = reject; });
    const original = manager.request.bind(manager);
    vi.spyOn(manager, 'request').mockImplementation((command, payload) =>
      command === 'batch.ack' ? pendingAck : original(command, payload));
    const service = new WechatLiveService({ accountRoot: 'C:\\wechat', manager, now });
    await service.start();
    await service.watchContacts(['contact-1']);
    const listener = vi.fn();
    service.subscribe(listener);
    manager.emitEvent(deltaEvent(1, 'batch-old', 'message-old', 'cursor-old'));
    expect(listener.mock.calls.at(-1)?.[0].accountKey).toBe('account-opaque');
    await service.watchContacts(['contact-2']);
    const current = service.snapshot();
    rejectAck(new Error('PRIVATE_OLD_ACK'));
    await settlePromises();
    expect(service.snapshot()).toEqual(current);
  });

  it('rejects cross-account list pages and clears opaque account identity on stop', async () => {
    const manager = new FakeManager();
    const service = new WechatLiveService({ accountRoot: 'C:\\wechat', manager, now });
    await service.start();
    const current = service.snapshot();
    manager.conversationPageResults.push({ accountKey: 'a:other', conversations: [
      { contactKey: 'c:other', displayName: '另一合成会话', kind: 'contact' },
    ] });
    await expect(service.conversationsPage()).rejects.toBeInstanceOf(WechatLiveServiceError);
    expect(service.snapshot()).toEqual(current);
    const stopped = await service.stop();
    expect(stopped).not.toHaveProperty('accountKey');
    expect(stopped).not.toHaveProperty('nextConversationCursor');
  });
});
