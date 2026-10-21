import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createAccountKey, type NativeConversation, type NativeMessage,
} from './main/adapters/wechat-native/native-normalize';
import type { WechatDatabaseFile } from './main/adapters/wechat-native/wechat-database-files';
import {
  createWechatWorkerRequest, isWechatWorkerIncomingMessage,
  type WechatWorkerCommand, type WechatWorkerEvent, type WechatWorkerIncomingMessage,
  type WechatWorkerResponse,
} from './shared/wechat-worker-protocol';

const GENERATION = 'synthetic-worker';
const ACCOUNT_ROOT = path.resolve('synthetic-fixture', 'wxid_fixture');
const ACCOUNT_KEY = createAccountKey(ACCOUNT_ROOT);
const CONTACT_KEY = 'contact:synthetic-peer';
const RUNTIME_BYTES = Buffer.from('synthetic runtime only');

class FakeParentPort extends EventEmitter {
  readonly posted: WechatWorkerIncomingMessage[] = [];
  postMessage(message: WechatWorkerIncomingMessage): void { this.posted.push(message); }
}

const message = (index: number): NativeMessage => ({
  messageId: `message:${index}`, accountKey: ACCOUNT_KEY, contactKey: CONTACT_KEY,
  direction: index % 2 === 0 ? 'incoming' : 'outgoing', messageType: 'text',
  occurredAt: new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString(),
  text: `合成消息 ${index}`,
});

describe.skipIf(process.platform !== 'win32' || process.arch !== 'x64')('read-only worker protocol wiring', () => {
  let port: FakeParentPort;
  let parentDescriptor: PropertyDescriptor | undefined;
  let existingExitListeners: Set<(code: number) => void>;
  let existingSignalListeners: Set<(signal: 'SIGTERM') => void>;
  let requestCounter: number;
  let files: WechatDatabaseFile[];
  let keys: Map<string, Buffer>;
  let rows: NativeMessage[];
  let databases: { close: ReturnType<typeof vi.fn> }[];
  let scan: ReturnType<typeof vi.fn>;
  let openProcess: ReturnType<typeof vi.fn>;
  let openReadOnly: ReturnType<typeof vi.fn>;
  let listProcesses: ReturnType<typeof vi.fn>;
  let readMessages: ReturnType<typeof vi.fn>;
  let readHistoryPage: ReturnType<typeof vi.fn>;
  let listConversations: ReturnType<typeof vi.fn>;
  let findFiles: ReturnType<typeof vi.fn>;
  let imageProviders: { decode: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }[];
  let createImageProvider: ReturnType<typeof vi.fn>;

  const dispatch = (command: WechatWorkerCommand, payload: Record<string, unknown> = {}): string => {
    const requestId = `request:${++requestCounter}`;
    port.emit('message', { data: createWechatWorkerRequest(GENERATION, requestId, command, payload) });
    return requestId;
  };
  const flush = async (): Promise<void> => { await vi.advanceTimersByTimeAsync(0); };
  const response = (requestId: string): WechatWorkerResponse => {
    const found = port.posted.find((item) => item.kind === 'response' && item.requestId === requestId);
    expect(found, `response for ${requestId}`).toBeDefined();
    return found as WechatWorkerResponse;
  };
  const request = async (command: WechatWorkerCommand, payload: Record<string, unknown> = {}): Promise<WechatWorkerResponse> => {
    const id = dispatch(command, payload);
    await flush();
    return response(id);
  };
  const events = (name: WechatWorkerEvent['event']): WechatWorkerEvent[] =>
    port.posted.filter((item): item is WechatWorkerEvent => item.kind === 'event' && item.event === name);
  const subscribe = async (cursor?: string): Promise<{ subscriptionId: string; cursor: string }> => {
    const result = await request('stream.subscribe', {
      accountKey: ACCOUNT_KEY, contactKeys: [CONTACT_KEY], ...(cursor ? { cursor } : {}),
    });
    expect(result.ok).toBe(true);
    return result.result as { subscriptionId: string; cursor: string };
  };
  const assertWiped = (): void => {
    for (const key of keys.values()) expect(key.equals(Buffer.alloc(key.length))).toBe(true);
    for (const file of files) expect(file.pageOne.equals(Buffer.alloc(4096))).toBe(true);
  };

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    requestCounter = 0;
    port = new FakeParentPort();
    parentDescriptor = Object.getOwnPropertyDescriptor(process, 'parentPort');
    existingExitListeners = new Set(process.listeners('exit'));
    existingSignalListeners = new Set(process.listeners('SIGTERM'));
    Object.defineProperty(process, 'parentPort', { configurable: true, value: port });
    vi.stubEnv('WECHAT_WORKER_GENERATION', GENERATION);
    vi.stubEnv('WECHAT_WORKER_PREFLIGHT', '0');
    vi.stubEnv('WECHAT_ACCOUNT_ROOT', ACCOUNT_ROOT);
    vi.stubEnv('WECHAT_NATIVE_RESOURCE_ROOT', path.resolve('synthetic-fixture', 'reader'));
    vi.stubEnv('WECHAT_KOFFI_NODE_PATH', path.resolve('synthetic-fixture', 'koffi.node'));
    files = (['contact', 'session', 'message'] as const).map((kind) => ({
      id: kind, kind, path: path.join(ACCOUNT_ROOT, `${kind}.db`), pageOne: Buffer.alloc(4096, 0x17),
    }));
    keys = new Map(files.map((file, index) => [file.id, Buffer.alloc(32, index + 1)]));
    rows = [message(0)];
    databases = files.map(() => ({ close: vi.fn() }));
    let openedCount = 0;
    openReadOnly = vi.fn(() => databases[openedCount++]);
    openProcess = vi.fn(() => ({ close: vi.fn(), read: vi.fn(), regions: vi.fn() }));
    scan = vi.fn(async () => keys);
    listProcesses = vi.fn(async () => ({ stdout: '"Weixin.exe","101","Console","1","10 K"\n"Weixin.exe","202","Console","1","10 K"' }));
    findFiles = vi.fn(async () => files);
    imageProviders = [];
    createImageProvider = vi.fn(function () {
      const provider = { decode: vi.fn(() => ({ status: 'pending' })), dispose: vi.fn() };
      imageProviders.push(provider);
      return provider;
    });
    readMessages = vi.fn((_username: string, limit: number, offset: number) =>
      [...rows].sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))
        .slice(offset, offset + limit).reverse());
    readHistoryPage = vi.fn(() => ({ messages: [...rows], done: true }));
    const conversation: NativeConversation = {
      username: 'synthetic-peer', contactKey: CONTACT_KEY, displayName: '合成会话', kind: 'contact',
    };
    listConversations = vi.fn(() => [conversation]);
    // Every I/O and native boundary is replaced before importing the worker.
    vi.doMock('node:fs/promises', () => ({
      realpath: vi.fn(async (value: string) => value),
      stat: vi.fn(async () => ({ isFile: () => true, size: RUNTIME_BYTES.length })),
      readFile: vi.fn(async () => RUNTIME_BYTES),
    }));
    vi.doMock('node:child_process', () => ({
      execFile: Object.assign(vi.fn(), { [Symbol.for('nodejs.util.promisify.custom')]: listProcesses }),
    }));
    vi.doMock('node:module', () => ({ createRequire: () => () => ({ synthetic: true }) }));
    vi.doMock('./main/adapters/wechat-native/adapter-runtime-data.json', () => ({
      default: { size: RUNTIME_BYTES.length, sha256: createHash('sha256').update(RUNTIME_BYTES).digest('hex') },
    }));
    vi.doMock('./main/adapters/wechat-native/probe', () => ({
      probeWechatNativeResources: vi.fn(async () => ({ available: true })),
    }));
    vi.doMock('./main/adapters/wechat-native/sqlite-reader', () => ({
      loadSqliteReader: () => ({ version: () => '2.5.1', preflight: vi.fn(), openReadOnly }),
      SqliteReaderError: class extends Error {},
    }));
    vi.doMock('./main/adapters/wechat-native/wechat-database-files', () => ({
      findWechatDatabaseFiles: findFiles, WechatDatabaseFileError: class extends Error {},
    }));
    vi.doMock('./main/adapters/wechat-native/wechat-readonly-memory', () => ({
      openReadonlyWechatProcess: openProcess, scanWechatDatabaseKeys: scan,
      WechatMemoryReadError: class extends Error {},
    }));
    vi.doMock('./main/adapters/wechat-native/wechat-image-crypto', () => ({
      WechatImageCryptoProvider: createImageProvider,
    }));
    vi.doMock('./main/adapters/wechat-native/wechat-message-store', () => ({
      WechatMessageStore: vi.fn(function () { return { listConversations, readMessages, readHistoryPage }; }),
      WechatMessageStoreError: class extends Error {},
    }));
    await import('./wechat-native-worker');
  });

  afterEach(() => {
    // Invoke and remove only this import's lifecycle handlers, not Vitest's handlers.
    for (const listener of process.listeners('exit')) {
      if (!existingExitListeners.has(listener)) { listener(0); process.removeListener('exit', listener); }
    }
    for (const listener of process.listeners('SIGTERM')) {
      if (!existingSignalListeners.has(listener)) process.removeListener('SIGTERM', listener);
    }
    if (parentDescriptor) Object.defineProperty(process, 'parentPort', parentDescriptor);
    else Reflect.deleteProperty(process, 'parentPort');
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('sends hello without I/O, starts only the new reader, wipes keys and closes handles on stop', async () => {
    expect(port.posted).toMatchObject([{ kind: 'hello', engineVersion: '0.4.1' }]);
    expect(findFiles).not.toHaveBeenCalled();
    expect(scan).not.toHaveBeenCalled();
    expect(createImageProvider).not.toHaveBeenCalled();
    scan.mockImplementation(async (open: (pid: number) => unknown, pids: number[]) => {
      pids.forEach(open);
      return keys;
    });
    const started = await request('engine.start', { processIds: [999, 202] });
    expect(started).toMatchObject({ ok: true, result: { accountKey: ACCOUNT_KEY, conversations: [{ contactKey: CONTACT_KEY }] } });
    expect(JSON.stringify(started)).not.toContain('"username"');
    expect(scan.mock.calls[0][1]).toEqual([202, 101]);
    expect(openProcess.mock.calls.map((call) => call[1])).toEqual([202, 101]);
    expect(openReadOnly).toHaveBeenCalledTimes(3);
    expect(createImageProvider).toHaveBeenCalledOnce();
    expect(createImageProvider.mock.calls[0][0]).toMatchObject({
      accountName: 'wxid_fixture',
      open: expect.any(Function), discoverProcessIds: expect.any(Function),
    });
    expect(imageProviders[0].decode).not.toHaveBeenCalled();
    assertWiped();
    await request('engine.start');
    expect(scan).toHaveBeenCalledTimes(1);
    expect((await request('engine.stop')).ok).toBe(true);
    expect(imageProviders[0].dispose).toHaveBeenCalledOnce();
    for (const db of databases) expect(db.close).toHaveBeenCalledTimes(1);
    expect(port.posted.every(isWechatWorkerIncomingMessage)).toBe(true);
  });

  it('adds self/sender avatar and voice registration without exposing raw usernames through the worker protocol', async () => {
    const { NativeWechatMediaStore } = await import('./main/adapters/wechat-native/wechat-media-store');
    const { NativeWechatVoiceStore } = await import('./main/adapters/wechat-native/wechat-voice-store');
    const { WechatMessageStore } = await import('./main/adapters/wechat-native/wechat-message-store');
    const self = `media_${'a'.repeat(64)}`, peer = `media_${'b'.repeat(64)}`, voice = `media_${'c'.repeat(64)}`;
    vi.spyOn(NativeWechatMediaStore.prototype, 'getAvatar').mockImplementation((username) => ({
      kind: 'avatar', status: 'ready', mediaKey: username === 'wxid_fixture' ? self : peer,
    }));
    const register = vi.spyOn(NativeWechatVoiceStore.prototype, 'registerMessageVoice')
      .mockReturnValue({ mediaKey: voice, status: 'pending' });
    expect(await request('engine.start')).toMatchObject({ ok: true, result: {
      selfAvatarMediaKey: self, conversations: [{ avatarMediaKey: peer }],
    } });
    const options = vi.mocked(WechatMessageStore).mock.calls[0][0];
    expect(options.registerAvatar?.('wxid_fixture')).toBe(self);
    expect(options.registerAvatar?.('synthetic-peer')).toBe(peer);
    const identity = { localId: '7', serverId: '9007199254740993', createTime: '1788105600' };
    expect(options.registerVoice?.('synthetic-peer', identity)).toBe(voice);
    expect(register).toHaveBeenCalledWith('synthetic-peer', identity);
    rows = [{ ...message(0), messageType: 'voice', text: undefined, senderAvatarMediaKey: peer,
      senderDisplayName: '合成发送者', voiceMediaKey: voice }];
    const snapshot = await request('messages.snapshot', { accountKey: ACCOUNT_KEY, contactKey: CONTACT_KEY, limit: 1 });
    expect(snapshot).toMatchObject({ ok: true, result: { messages: [rows[0]] } });
    expect(JSON.stringify(port.posted)).not.toContain('wxid_fixture');
    expect(port.posted.every(isWechatWorkerIncomingMessage)).toBe(true);
  });

  it('reads voice only through its account-scoped bounded audio command and wipes transferred bytes', async () => {
    const { NativeWechatVoiceStore } = await import('./main/adapters/wechat-native/wechat-voice-store');
    const bytes = Buffer.from('\x02#!SILK_V3\x01\x00\x00', 'binary');
    const expected = Buffer.from(bytes), mediaKey = `media_${'c'.repeat(64)}`;
    const read = vi.spyOn(NativeWechatVoiceStore.prototype, 'readVoice').mockReturnValue({ bytes, format: 'silk' });
    const disposed = vi.spyOn(NativeWechatVoiceStore.prototype, 'dispose');
    await request('engine.start');
    expect(await request('voice.read', { accountKey: 'a:wrong', mediaKey, offset: 0 }))
      .toMatchObject({ ok: false, error: { code: 'account.unknown' } });
    expect(read).not.toHaveBeenCalled();
    const result = await request('voice.read', { accountKey: ACCOUNT_KEY, mediaKey, offset: 0 });
    expect(result).toMatchObject({ ok: true, result: { ok: true, mime: 'audio/x-silk', offset: 0,
      totalBytes: expected.length, nextOffset: expected.length, data: expected.toString('base64') } });
    expect(bytes).toEqual(Buffer.alloc(bytes.length));
    expect(await request('media.read', { accountKey: ACCOUNT_KEY, mediaKey, offset: 0 }))
      .toMatchObject({ ok: true, result: { ok: false } });
    await request('engine.stop'); expect(disposed).toHaveBeenCalledOnce();
    expect(await request('voice.read', { accountKey: ACCOUNT_KEY, mediaKey, offset: 0 }))
      .toMatchObject({ ok: false, error: { code: 'engine.notReady' } });
  });

  it('uses opaque single-use account/date-scoped cursors for full message history', async () => {
    const after = { timestamp: '1788105600', sequence: '9007199254740993', localId: '1', sourceId: 'synthetic-shard' };
    readHistoryPage.mockReturnValueOnce({ messages: [message(0)], done: false, after })
      .mockReturnValueOnce({ messages: [message(1)], done: true });
    await request('engine.start');
    const payload = { accountKey: ACCOUNT_KEY, contactKey: CONTACT_KEY, from: 946684800, to: 1893456000, limit: 200 };
    const first = await request('messages.history', payload);
    expect(first).toMatchObject({ ok: true, result: { done: false, messages: [message(0)] } });
    const cursor = (first.result as { nextCursor?: string }).nextCursor;
    expect(cursor).toMatch(/^history:[a-f0-9-]+$/u);
    expect(JSON.stringify(first)).not.toContain('synthetic-shard');
    expect(JSON.stringify(first)).not.toContain('"username"');
    expect(await request('messages.history', { ...payload, cursor, to: payload.to + 1 }))
      .toMatchObject({ ok: false, error: { code: 'cursor.expired' } });
    const last = await request('messages.history', { ...payload, cursor });
    expect(last).toMatchObject({ ok: true, result: { done: true, messages: [message(1)] } });
    expect((last.result as { nextCursor?: string }).nextCursor).toBeUndefined();
    expect(readHistoryPage.mock.calls[1]).toEqual(['synthetic-peer', 200, { from: payload.from, to: payload.to, after }]);
    expect(await request('messages.history', { ...payload, cursor }))
      .toMatchObject({ ok: false, error: { code: 'cursor.expired' } });
    expect(readMessages).not.toHaveBeenCalled();
    expect(port.posted.every(isWechatWorkerIncomingMessage)).toBe(true);
  });

  it('revokes unfinished history cursors on stop/reconnect rather than continuing against another session', async () => {
    readHistoryPage.mockReturnValue({ messages: [message(0)], done: false,
      after: { timestamp: '1788105600', sequence: '1', localId: '1', sourceId: 'synthetic' } });
    await request('engine.start');
    const payload = { accountKey: ACCOUNT_KEY, contactKey: CONTACT_KEY, from: 946684800, to: 1893456000, limit: 200 };
    const first = await request('messages.history', payload);
    await request('engine.stop'); openReadOnly.mockImplementation(() => ({ close: vi.fn() }));
    await request('engine.start');
    expect(await request('messages.history', { ...payload, cursor: (first.result as { nextCursor?: string }).nextCursor }))
      .toMatchObject({ ok: false, error: { code: 'cursor.expired' } });
  });

  it('disposes optional image credentials if initialization fails after their creation', async () => {
    listConversations.mockImplementationOnce(() => { throw new Error('synthetic private session failure'); });
    expect((await request('engine.start')).ok).toBe(false);
    expect(imageProviders).toHaveLength(1);
    expect(imageProviders[0].dispose).toHaveBeenCalledOnce();
    expect(imageProviders[0].decode).not.toHaveBeenCalled();
    for (const db of databases) expect(db.close).toHaveBeenCalledOnce();
    expect(JSON.stringify(port.posted)).not.toContain('synthetic private session failure');
  });

  it('creates fresh optional media credentials after stopping and reconnecting', async () => {
    expect((await request('engine.start')).ok).toBe(true);
    expect((await request('engine.stop')).ok).toBe(true);
    openReadOnly.mockImplementation(() => ({ close: vi.fn() }));
    expect((await request('engine.start')).ok).toBe(true);
    expect(imageProviders).toHaveLength(2);
    expect(imageProviders[0]).not.toBe(imageProviders[1]);
    expect(imageProviders[0].dispose).toHaveBeenCalledOnce();
    expect(imageProviders[1].dispose).not.toHaveBeenCalled();
    expect((await request('engine.stop')).ok).toBe(true);
    expect(imageProviders[1].dispose).toHaveBeenCalledOnce();
  });

  it('wipes all candidates and closes already-open handles if a later database fails', async () => {
    openReadOnly.mockImplementationOnce(() => databases[0]).mockImplementationOnce(() => {
      throw new Error('private native detail must not leave the worker');
    });
    const failed = await request('engine.start');
    expect(failed).toMatchObject({ ok: false, error: { code: 'engine.unavailable' } });
    expect(JSON.stringify(port.posted)).not.toContain('private native detail');
    assertWiped();
    expect(databases[0].close).toHaveBeenCalledTimes(1);
    expect(databases[1].close).not.toHaveBeenCalled();
  });

  it.each(['missing-key', 'open-failed'] as const)(
    'keeps core chat reads available when optional avatar and emoji databases are %s', async (mode) => {
      for (const kind of ['avatar', 'emoji', 'voice'] as const) {
        files.push({ id: kind, kind, path: path.join(ACCOUNT_ROOT, `${kind}.db`), pageOne: Buffer.alloc(4096, 0x17) });
        if (mode === 'open-failed') keys.set(kind, Buffer.alloc(32, 0x29));
      }
      if (mode === 'open-failed') {
        openReadOnly.mockImplementation((filePath: string) => {
          const index = files.findIndex((file) => file.path === filePath);
          if (index >= 3) throw new Error('synthetic optional image database cannot be opened');
          return databases[index];
        });
      }
      expect(await request('engine.start')).toMatchObject({ ok: true, result: { accountKey: ACCOUNT_KEY } });
      expect(await request('messages.snapshot', { accountKey: ACCOUNT_KEY, contactKey: CONTACT_KEY, limit: 20 }))
        .toMatchObject({ ok: true, result: { messages: [message(0)] } });
      expect(openReadOnly).toHaveBeenCalledTimes(mode === 'missing-key' ? 3 : 6);
      assertWiped();
      await request('engine.stop');
      for (const db of databases) expect(db.close).toHaveBeenCalledOnce();
    },
  );

  it.each(['contact', 'session', 'message'] as const)(
    'still refuses to claim complete history when the required %s database key is missing', async (kind) => {
      keys.delete(kind);
      expect(await request('engine.start')).toMatchObject({ ok: false, error: { code: 'key.incomplete' } });
      expect(openReadOnly).not.toHaveBeenCalled();
      expect(readMessages).not.toHaveBeenCalled();
      assertWiped();
    },
  );

  it('pages every sales conversation as metadata, supports later selections and refreshes without rescanning keys', async () => {
    const all = Array.from({ length: 651 }, (_, index) => ({
      username: `synthetic-peer-${index}`, contactKey: `c:synthetic-${index}`, displayName: `合成会话${index}`,
      kind: index % 3 === 0 ? 'group' : index % 3 === 1 ? 'official' : 'contact',
      unreadCount: index % 4, preview: '合成摘要', lastMessageAt: '2026-08-31T00:00:00.000Z',
    }));
    listConversations.mockReturnValue(all);
    const started = (await request('engine.start')).result as { conversations: NativeConversation[]; nextConversationCursor?: string };
    expect(started.conversations).toHaveLength(100);
    const oldCursor = started.nextConversationCursor;
    let cursor = oldCursor;
    const seen = [...started.conversations.map((item) => item.contactKey)];
    while (cursor) {
      const loaded = await request('conversations.list', { accountKey: ACCOUNT_KEY, limit: 100, cursor });
      expect(loaded.ok).toBe(true);
      expect(isWechatWorkerIncomingMessage(loaded)).toBe(true);
      const page = loaded.result as { conversations: NativeConversation[]; nextConversationCursor?: string };
      seen.push(...page.conversations.map((item) => item.contactKey));
      cursor = page.nextConversationCursor;
    }
    expect(seen).toEqual(all.filter((row) => row.kind !== 'official').map((row) => row.contactKey));
    expect(new Set(seen).size).toBe(434);
    expect(all).toHaveLength(651);
    expect(readMessages).not.toHaveBeenCalled();
    expect(JSON.stringify(port.posted)).not.toContain('"username"');
    rows = [];
    const selected = await request('messages.snapshot', { accountKey: ACCOUNT_KEY, contactKey: all[650].contactKey, limit: 10 });
    expect(selected).toMatchObject({ ok: true, result: { contactKey: all[650].contactKey, messages: [] } });
    expect(readMessages.mock.calls[0][0]).toBe(all[650].username);
    listConversations.mockReturnValue([{ ...all[650], unreadCount: 9 }]);
    expect(await request('conversations.list', { accountKey: ACCOUNT_KEY, limit: 100 }))
      .toMatchObject({ ok: true, result: { conversations: [{ contactKey: all[650].contactKey, unreadCount: 9 }] } });
    expect(await request('conversations.list', { accountKey: ACCOUNT_KEY, limit: 100, cursor: oldCursor }))
      .toMatchObject({ ok: false, error: { code: 'conversations.cursorExpired' } });
    expect(await request('conversations.list', { accountKey: 'a:other', limit: 100 }))
      .toMatchObject({ ok: false, error: { code: 'account.unknown' } });
    expect(listConversations).toHaveBeenCalledTimes(2);
    expect(scan).toHaveBeenCalledOnce();
    expect(readMessages).toHaveBeenCalledOnce();
  });

  it('keeps one outstanding batch and only advances the cursor after the exact ACK', async () => {
    await request('engine.start');
    const subscribed = await subscribe();
    rows = Array.from({ length: 231 }, (_, index) => message(index));
    await vi.advanceTimersByTimeAsync(2000);
    const first = events('messages.delta')[0].payload;
    expect(first.baseCursor).toBe(subscribed.cursor);
    expect(first.messages).toHaveLength(200);
    const readCount = readMessages.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(events('messages.delta')).toHaveLength(1);
    expect(readMessages).toHaveBeenCalledTimes(readCount);
    expect(await request('batch.ack', {
      subscriptionId: subscribed.subscriptionId, batchId: first.batchId, cursor: 'wrong-cursor',
    })).toMatchObject({ ok: false, error: { code: 'batch.unknown' } });
    expect(events('messages.delta')).toHaveLength(1);
    await request('batch.ack', {
      subscriptionId: subscribed.subscriptionId, batchId: first.batchId, cursor: first.nextCursor,
    });
    await vi.advanceTimersByTimeAsync(1);
    const second = events('messages.delta')[1].payload;
    expect(second.baseCursor).toBe(first.nextCursor);
    expect((second.messages as NativeMessage[]).map((item) => item.messageId))
      .toEqual(Array.from({ length: 30 }, (_, index) => `message:${index + 201}`));
    expect(new Set([...(first.messages as NativeMessage[]), ...(second.messages as NativeMessage[])]
      .map((item) => item.messageId)).size).toBe(230);
  });

  it('reuses a displayed snapshot cursor without another baseline read and delivers messages arriving before subscription', async () => {
    await request('engine.start');
    rows = Array.from({ length: 200 }, (_, index) => message(index));
    const initial = await request('messages.snapshot', { accountKey: ACCOUNT_KEY, contactKey: CONTACT_KEY, limit: 200 });
    expect(initial.ok).toBe(true);
    expect(readMessages).toHaveBeenCalledOnce();
    rows.push(message(200), message(201));
    const subscribed = await subscribe((initial.result as { cursor: string }).cursor);
    expect(readMessages).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(2000);
    expect(events('messages.delta')).toHaveLength(1);
    const batch = events('messages.delta')[0].payload;
    expect((batch.messages as NativeMessage[]).map((row) => row.messageId)).toEqual(['message:200', 'message:201']);
    expect(readMessages.mock.calls.at(-1)?.slice(1)).toEqual([64, 0]);
    await request('batch.ack', { subscriptionId: subscribed.subscriptionId, batchId: batch.batchId, cursor: batch.nextCursor });
    await vi.advanceTimersByTimeAsync(1);
    expect(events('messages.delta')).toHaveLength(1);
  });

  it('invalidates a lost history boundary once and does not silently skip to new messages', async () => {
    await request('engine.start');
    await subscribe();
    rows = [message(1)];
    await vi.advanceTimersByTimeAsync(2000);
    expect(events('cursor.invalidated')).toMatchObject([{ payload: { accountKey: ACCOUNT_KEY, reason: 'cursor-expired' } }]);
    expect(events('messages.delta')).toHaveLength(0);
    const count = readMessages.mock.calls.length;
    await vi.advanceTimersByTimeAsync(6000);
    expect(readMessages).toHaveBeenCalledTimes(count);
    expect(events('cursor.invalidated')).toHaveLength(1);
  });

  it('returns a stale subscription ID before invalidation so the host can pause it', async () => {
    await request('engine.start');
    const subscribed = await subscribe('cursor:missing');
    const replyIndex = port.posted.findIndex((item) => item.kind === 'response'
      && (item.result as { subscriptionId?: string })?.subscriptionId === subscribed.subscriptionId);
    const invalidIndex = port.posted.findIndex((item) => item.kind === 'event' && item.event === 'cursor.invalidated');
    expect(invalidIndex).toBeGreaterThan(replyIndex);
    expect((await request('stream.pause', { subscriptionId: subscribed.subscriptionId })).ok).toBe(true);
    const count = readMessages.mock.calls.length;
    await vi.advanceTimersByTimeAsync(6000);
    expect(readMessages).toHaveBeenCalledTimes(count);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops pending delivery, polling and database handles, and rejects an old ACK', async () => {
    await request('engine.start');
    const subscribed = await subscribe();
    rows.push(message(1));
    await vi.advanceTimersByTimeAsync(2000);
    const batch = events('messages.delta')[0].payload;
    await request('engine.stop');
    const count = readMessages.mock.calls.length;
    rows.push(message(2));
    await vi.advanceTimersByTimeAsync(6000);
    expect(readMessages).toHaveBeenCalledTimes(count);
    expect(events('messages.delta')).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    for (const db of databases) expect(db.close).toHaveBeenCalledTimes(1);
    expect(await request('batch.ack', {
      subscriptionId: subscribed.subscriptionId, batchId: batch.batchId, cursor: batch.nextCursor,
    })).toMatchObject({ ok: false, error: { code: 'batch.unknown' } });
    expect(await request('messages.snapshot', { accountKey: ACCOUNT_KEY, contactKey: CONTACT_KEY, limit: 20 }))
      .toMatchObject({ ok: false, error: { code: 'engine.notReady' } });
  });

  it('marks an in-flight scan cancelled immediately and wipes its eventual result', async () => {
    let cancelled = (): boolean => false;
    let finishScan: (result: Map<string, Buffer>) => void = () => { throw new Error('scan did not start'); };
    scan.mockImplementation((_open: unknown, _pids: unknown, _files: unknown, options: { cancelled: () => boolean }) => {
      cancelled = options.cancelled;
      return new Promise<Map<string, Buffer>>((resolve) => { finishScan = resolve; });
    });
    const startId = dispatch('engine.start');
    await flush();
    expect(cancelled()).toBe(false);
    const stopId = dispatch('engine.stop');
    expect(cancelled()).toBe(true);
    finishScan(keys);
    await flush();
    expect(response(startId)).toMatchObject({ ok: false, error: { code: 'engine.stopped' } });
    expect(response(stopId).ok).toBe(true);
    assertWiped();
    for (const call of openReadOnly.mock.results) {
      if (call.type === 'return') expect(call.value.close).toHaveBeenCalledTimes(1);
    }
  });

  it('does not start a queued credential scan after an immediate stop request', async () => {
    const startId = dispatch('engine.start');
    const stopId = dispatch('engine.stop');
    await flush();
    expect(response(startId)).toMatchObject({ ok: false, error: { code: 'engine.stopped' } });
    expect(response(stopId).ok).toBe(true);
    expect(scan).not.toHaveBeenCalled();
    expect(openReadOnly).not.toHaveBeenCalled();
  });

  it('allows a new explicit start after a completed stop', async () => {
    expect((await request('engine.stop')).ok).toBe(true);
    expect((await request('engine.start')).ok).toBe(true);
    expect(scan).toHaveBeenCalledTimes(1);
    assertWiped();
  });

  it('orders same-second snapshots and ACK batches by the exact source sequence, never the opaque ID', async () => {
    // The message store returns each selected page chronologically.
    readMessages.mockImplementation((_username: string, limit: number, offset = 0) =>
      [...rows].reverse().slice(offset, offset + limit).reverse());
    await request('engine.start');
    const initial = (await request('messages.snapshot', {
      accountKey: ACCOUNT_KEY, contactKey: CONTACT_KEY, limit: 20,
    })).result as { cursor: string };
    const subscribed = await subscribe();
    const older = { ...message(1), messageId: 'z-older', sortSequence: '9007199254740992' };
    const newer = { ...message(1), messageId: 'a-newer', sortSequence: '9007199254740993' };
    rows.push(older, newer);
    await vi.advanceTimersByTimeAsync(2000);
    const batch = events('messages.delta')[0];
    expect(batch.payload.messages).toEqual([older, newer]);
    expect(isWechatWorkerIncomingMessage(batch)).toBe(true);
    const incremental = await request('messages.snapshot', {
      accountKey: ACCOUNT_KEY, contactKey: CONTACT_KEY, limit: 20, cursor: initial.cursor,
    });
    expect(incremental).toMatchObject({ ok: true, result: { messages: [older, newer] } });
    expect(isWechatWorkerIncomingMessage(incremental)).toBe(true);
    await request('batch.ack', {
      subscriptionId: subscribed.subscriptionId, batchId: batch.payload.batchId, cursor: batch.payload.nextCursor,
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(events('messages.delta')).toHaveLength(1);
    const latest = { ...message(1), messageId: 'b-latest', sortSequence: '9007199254740994' };
    rows.push(latest);
    await vi.advanceTimersByTimeAsync(2000);
    expect(events('messages.delta')[1].payload).toMatchObject({
      baseCursor: batch.payload.nextCursor, messages: [latest],
    });
  });

  it('keeps the source page order for same-second legacy messages without a sort sequence', async () => {
    readMessages.mockImplementation((_username: string, limit: number, offset = 0) =>
      [...rows].reverse().slice(offset, offset + limit).reverse());
    await request('engine.start');
    await subscribe();
    const first = { ...message(1), messageId: 'z-first' };
    const second = { ...message(1), messageId: 'a-second' };
    rows.push(first, second);
    await vi.advanceTimersByTimeAsync(2000);
    expect(events('messages.delta')[0].payload.messages).toEqual([first, second]);
  });

  it('retains a neutral system notification in the ACK sequence before later participant messages', async () => {
    await request('engine.start');
    const subscribed = await subscribe();
    rows.push({ ...message(1), direction: 'system', messageType: 'system', text: '合成系统提示' });
    await vi.advanceTimersByTimeAsync(2000);
    const first = events('messages.delta')[0];
    expect(first.payload.messages).toMatchObject([{ direction: 'system', messageType: 'system', text: '合成系统提示' }]);
    expect(isWechatWorkerIncomingMessage(first)).toBe(true);
    rows.push(message(2));
    await request('batch.ack', {
      subscriptionId: subscribed.subscriptionId, batchId: first.payload.batchId, cursor: first.payload.nextCursor,
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(events('messages.delta')[1].payload).toMatchObject({
      baseCursor: first.payload.nextCursor,
      messages: [{ messageId: 'message:2', direction: 'incoming', messageType: 'text' }],
    });
  });
});
