import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';
import type { RuntimeStatus } from '../shared/contracts';
import type { KnowledgeIndexStatus } from '../shared/integration-contracts';
import { registerIpcHandlers, type IpcRegistration } from './ipc';

const fixtures = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>(),
  hint: vi.fn(),
  openDialog: vi.fn(),
  featureOptions: [] as Array<{ chooseKnowledgeFiles?: () => Promise<string[] | null> }>,
  integrationOptions: [] as Array<{ settingsPath: string; knowledgeRepositoryPath?: string }>,
  knowledgeStatus: { state: 'idle', documents: 0, chunks: 0 } as Pick<KnowledgeIndexStatus, 'state' | 'documents' | 'chunks'>,
  services: [] as { watchContacts: ReturnType<typeof vi.fn>; unwatchContacts: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }[],
}));
vi.mock('electron', () => ({
  app: { getPath: () => 'C:/synthetic-userdata', getAppPath: () => 'C:/synthetic-app', isPackaged: false, getVersion: () => 'synthetic' },
  BrowserWindow: { getAllWindows: () => [] }, clipboard: { writeText: vi.fn() },
  dialog: { showOpenDialog: fixtures.openDialog },
  ipcMain: { handle: (channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => fixtures.handlers.set(channel, handler) },
  net: { fetch: vi.fn() }, safeStorage: {}, shell: { openPath: vi.fn().mockResolvedValue('') },
}));
vi.mock('./adapters/wechat-native', () => ({ probeWechatNativeResources: vi.fn().mockResolvedValue({ available: true }) }));
vi.mock('./services/wechat-account-root', () => ({ resolveWechatAccountRootHint: fixtures.hint, saveWechatAccountRoot: vi.fn() }));
vi.mock('./services/conversation-import', () => ({ importConversationFile: vi.fn() }));
vi.mock('./feature-ipc', () => ({ registerFeatureHandlers: () => () => undefined }));
vi.mock('./services/feature-controller', () => ({ FeatureController: class {
  constructor(options: { chooseKnowledgeFiles?: () => Promise<string[] | null> }) { fixtures.featureOptions.push(options); }
  resetWechatScope() { /* No private scope in this fixture. */ }
  onWechatDelta() { /* No real messages. */ }
  dispose() { /* No resources. */ }
} }));
vi.mock('./services/integration-service', () => ({ IntegrationService: class {
  constructor(options: { settingsPath: string; knowledgeRepositoryPath?: string }) { fixtures.integrationOptions.push(options); }
  getSettings() { return { crm: { hasSession: false }, knowledge: { ...fixtures.knowledgeStatus } }; }
} }));
vi.mock('./services/offline-transcription', () => ({ OfflineTranscriptionService: class {} }));
vi.mock('./services/local-plan-store', () => ({ LocalPlanStore: class {} }));
vi.mock('./services/wechat-live-service', () => ({ WechatLiveService: class {
  watchContacts = vi.fn().mockResolvedValue(undefined);
  unwatchContacts = vi.fn().mockResolvedValue(undefined);
  stop = vi.fn().mockResolvedValue({ revision: 1, conversations: [], status: { state: 'stopped' } });
  constructor() { fixtures.services.push(this); }
  subscribe() { return () => undefined; }
  snapshot() { return { revision: 1, accountKey: 'synthetic-account', conversations: [], status: { state: 'ready' } }; }
  dispose() { /* No worker is created. */ }
} }));

const expectedUrl = 'file:///synthetic-app/index.html';
const event = (trusted = true) => {
  const frame = { url: trusted ? expectedUrl : 'file:///untrusted/index.html' };
  return { senderFrame: frame, sender: { mainFrame: frame } } as unknown as IpcMainInvokeEvent;
};
const invoke = (channel: string, ...args: unknown[]) => fixtures.handlers.get(channel)?.(event(), ...args);
let registration: IpcRegistration;
beforeEach(() => {
  fixtures.handlers.clear(); fixtures.services.length = 0; fixtures.featureOptions.length = 0; fixtures.integrationOptions.length = 0;
  fixtures.openDialog.mockReset().mockResolvedValue({ canceled: true, filePaths: [] });
  fixtures.knowledgeStatus = { state: 'idle', documents: 0, chunks: 0 };
  fixtures.hint.mockReset().mockResolvedValue({ accountRoot: 'C:/synthetic-wechat-account' });
  registration = registerIpcHandlers(expectedUrl);
});
afterEach(() => { registration.dispose(); });

describe('trusted WeChat watch and unwatch IPC', () => {
  it.each([
    ['indexing', 'attention', '正在整理'],
    ['error', 'offline', '整理失败'],
  ] as const)('never reports %s knowledge as ready even if a stale count is present', async (state, expectedState, detail) => {
    fixtures.knowledgeStatus = { state, documents: 8, chunks: 40 };
    const status = await invoke('runtime:get-status') as RuntimeStatus;
    const knowledge = status.sources.find((source) => source.id === 'knowledge');
    expect(knowledge).toMatchObject({ state: expectedState, detail: expect.stringContaining(detail) });
    expect(knowledge?.detail).not.toContain('已索引');
    expect(knowledge?.detail).not.toContain('8');
  });

  it('only declares knowledge ready for a successful non-empty index', async () => {
    fixtures.knowledgeStatus = { state: 'ready', documents: 2, chunks: 4 };
    const ready = await invoke('runtime:get-status') as RuntimeStatus;
    expect(ready.sources.find((source) => source.id === 'knowledge')).toMatchObject({ state: 'ready', detail: expect.stringContaining('2') });
    fixtures.knowledgeStatus = { state: 'ready', documents: 0, chunks: 0 };
    const empty = await invoke('runtime:get-status') as RuntimeStatus;
    expect(empty.sources.find((source) => source.id === 'knowledge')?.state).toBe('attention');
  });

  it('keeps the knowledge repository under the fixed app userData path and selects files only in main', async () => {
    expect(fixtures.integrationOptions[0].knowledgeRepositoryPath?.replace(/\\/g, '/')).toBe('C:/synthetic-userdata/knowledge-workspace.enc.json');
    const chooseFiles = fixtures.featureOptions[0].chooseKnowledgeFiles;
    expect(await chooseFiles?.()).toBe(null);
    expect(fixtures.openDialog).toHaveBeenCalledWith({
      title: expect.stringContaining('20'),
      properties: ['openFile', 'multiSelections', 'dontAddToRecent'],
      filters: [{ name: '知识资料', extensions: ['md', 'txt'] }],
    });
    fixtures.openDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['C:/synthetic-material/one.md', 'C:/synthetic-material/two.txt'] });
    expect(await chooseFiles?.()).toEqual(['C:/synthetic-material/one.md', 'C:/synthetic-material/two.txt']);
    expect(fixtures.hint).not.toHaveBeenCalled(); expect(fixtures.services).toHaveLength(0);
  });

  it('does not resolve account paths, start a service or read any body for unwatch before connection', async () => {
    await invoke('wechat:unwatch-conversation');
    expect(fixtures.hint).not.toHaveBeenCalled(); expect(fixtures.services).toHaveLength(0);
  });

  it('cancels a watch still waiting for the account hint when the user hides that chat', async () => {
    await invoke('wechat:get-snapshot');
    let resolveHint!: (value: { accountRoot: string }) => void;
    fixtures.hint.mockImplementationOnce(() => new Promise((resolve) => { resolveHint = resolve; }));
    const watching = invoke('wechat:watch-conversation', 'contact-1');
    const cancelled = expect(watching).rejects.toThrow('会话切换已取消');
    await invoke('wechat:unwatch-conversation');
    expect(fixtures.services[0].unwatchContacts).toHaveBeenCalledOnce();
    resolveHint({ accountRoot: 'C:/synthetic-wechat-account' }); await cancelled;
    expect(fixtures.services[0].watchContacts).not.toHaveBeenCalled();
  });

  it('does not let an older queued watch revive after stopping the reader', async () => {
    await invoke('wechat:get-snapshot');
    let resolveHint!: (value: { accountRoot: string }) => void;
    fixtures.hint.mockImplementationOnce(() => new Promise((resolve) => { resolveHint = resolve; }));
    const watching = invoke('wechat:watch-conversation', 'contact-1');
    const cancelled = expect(watching).rejects.toThrow('会话切换已取消');
    await invoke('wechat:stop');
    resolveHint({ accountRoot: 'C:/synthetic-wechat-account' }); await cancelled;
    expect(fixtures.services[0].stop).toHaveBeenCalledOnce(); expect(fixtures.services[0].watchContacts).not.toHaveBeenCalled();
  });

  it('rejects untrusted watch and unwatch requests before touching the live service', async () => {
    await invoke('wechat:get-snapshot');
    await expect(fixtures.handlers.get('wechat:watch-conversation')?.(event(false), 'contact-1')).rejects.toThrow('非受信任');
    await expect(fixtures.handlers.get('wechat:unwatch-conversation')?.(event(false))).rejects.toThrow('非受信任');
    expect(fixtures.services[0].watchContacts).not.toHaveBeenCalled(); expect(fixtures.services[0].unwatchContacts).not.toHaveBeenCalled();
  });

  it('allows a current trusted selection and routes only its exact contact key', async () => {
    await invoke('wechat:get-snapshot'); await invoke('wechat:watch-conversation', 'contact-1');
    expect(fixtures.services[0].watchContacts).toHaveBeenCalledOnce();
    expect(fixtures.services[0].watchContacts).toHaveBeenCalledWith(['contact-1']);
  });
});
