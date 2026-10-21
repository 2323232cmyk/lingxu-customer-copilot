import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WechatLiveMessage, WechatLiveSnapshot } from '../../shared/contracts';
import type { ExportMessage } from '../../shared/export-contracts';
import type { FeatureResult, ConversationReplyPreview } from '../../shared/feature-bridge-contracts';
import type { VoiceTranscriptionResult } from '../../shared/voice-contracts';
import { FeatureController, type FeatureLiveSource } from './feature-controller';
import { IntegrationService } from './integration-service';
import type { OfflineTranscriptionService } from './offline-transcription';
import type { ExportArchiveInput } from './conversation-export';
import { LocalPlanStore } from './local-plan-store';
import type { KnowledgeImportResult } from '../../shared/knowledge-workspace-contracts';

vi.mock('node:fs/promises', async (load) => {
  const actual = await load<typeof import('node:fs/promises')>();
  return { ...actual, realpath: vi.fn(actual.realpath) };
});

const folders: string[] = [];
const scope = { accountKey: 'account-one', contactKey: 'contact-one' };
const voiceAlias = 'a'.repeat(64);
const textMessage = (id = 'm1'): WechatLiveMessage => ({ id, contactKey: scope.contactKey, direction: 'incoming', sender: '客户', text: '流程是怎样的？', sentAt: '2026-08-31T10:00:00+08:00', observedAt: '2026-08-31T10:00:01+08:00', messageType: 'text' });
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
function value<T>(result: FeatureResult<T>): T { if (!result.ok) throw new Error(result.error); return result.value; }

function setup(options: { secureKnowledge?: boolean } = {}) {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'lingxu-feature-test-')); folders.push(folder);
  const state = {
    snapshot: { revision: 1, accountKey: scope.accountKey, status: { state: 'ready', monitoring: false, detail: 'ready', updatedAt: 'now' }, conversations: [{ contactKey: scope.contactKey, displayName: '客户', kind: 'contact' }, { contactKey: 'contact-two', displayName: '另一客户', kind: 'contact' }] } as WechatLiveSnapshot,
    messages: [textMessage()],
    pages: [[textMessage()]],
    permissions: ['*'],
    exported: [] as ExportMessage[],
    exportSourceCompleteness: [] as string[],
  };
  const fetcher = vi.fn<typeof fetch>(async (url) => {
    const target = String(url);
    if (target.endsWith('/auth/login') || target.endsWith('/device/verify')) return json({ token: 'mock-token' });
    if (target.endsWith('/auth/me')) return json({ user: { id: 1, displayName: '测试账号', permissions: state.permissions } });
    if (target.endsWith('/followups')) return json({ followups: Array.from({ length: 20 }, (_, id) => ({ id, content: '真实结构模拟跟进', followupAt: '2026-08-31' })) });
    if (target.endsWith('/calls')) return json({ calls: [] });
    if (/\/customers\/\d+$/.test(target)) return json({ customer: { id: Number(target.split('/').at(-1)), name: '确认客户', budget: '待确认' }, tasks: [] });
    if (target.endsWith('/chat/completions')) return json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ drafts: [{ text: '可以，您最想先了解哪个环节？', reason: '回应流程问题', sourceIds: ['chat:1'] }] }) } }] });
    throw new Error('Unexpected test URL');
  });
  const integrations = new IntegrationService({ settingsPath: path.join(folder, 'integrations.json'), fetch: fetcher,
    secretStorage: { isEncryptionAvailable: () => options.secureKnowledge === true,
      encryptString: (text) => Buffer.from(text.split('').reverse().join('')), decryptString: (bytes) => bytes.toString('utf8').split('').reverse().join('') } });
  integrations.updateSettings({ crm: { baseUrl: 'https://crm.test' }, ai: { model: 'test-model', apiKey: 'model-test-key', allowRemote: true } });
  const localPlans = new LocalPlanStore(path.join(folder, 'local-plans.enc.json'), { isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value.split('').reverse().join('')), decryptString: (bytes) => bytes.toString('utf8').split('').reverse().join('') });
  const live: FeatureLiveSource = {
    snapshot: () => structuredClone(state.snapshot),
    messagesSnapshot: vi.fn(async () => state.messages.map((message) => ({ ...message }))),
    mediaForRenderer: vi.fn(async () => ({ ok: false as const, reason: 'missing' as const })),
    readVoice: vi.fn(async () => ({ bytes: Buffer.from('#!SILK_V3\0test'), format: 'silk' as const })),
    exportMessages: vi.fn(async function* () { for (const page of state.pages) yield page; }),
  };
  const voice = {
    status: vi.fn(async () => ({ engine: 'SenseVoice' as const, state: 'ready' as const, detail: 'test', downloadedBytes: 1, totalBytes: 1, queued: 0, active: false })),
    downloadModel: vi.fn(), cancelDownload: vi.fn(), importModelDirectory: vi.fn(),
    transcribeVoice: vi.fn(async (): Promise<VoiceTranscriptionResult> => ({ ok: true, text: '语音中说周六上午方便', engine: 'SenseVoice' })),
    transcribeFile: vi.fn(async (): Promise<VoiceTranscriptionResult> => ({ ok: true, text: '本地文件文字', engine: 'SenseVoice' })),
    decodeWechatVoiceToWav: vi.fn(async () => ({ ok: true as const, bytes: Buffer.from('RIFF........WAVEfmt test'), mime: 'audio/wav' as const })),
    cancelPending: vi.fn(), dispose: vi.fn(),
  };
  const choosePath = vi.fn(async () => folder as string | null);
  const chooseKnowledgeFiles = vi.fn(async () => null as string[] | null);
  const openDirectory = vi.fn(async () => '');
  const exportArchive = vi.fn(async (input: ExportArchiveInput) => {
    for (const source of input.conversations) {
      if (Symbol.asyncIterator in source.messages) for await (const page of source.messages as AsyncIterable<readonly ExportMessage[]>) state.exported.push(...page);
      else state.exported.push(...source.messages as ExportMessage[]);
      state.exportSourceCompleteness.push(source.completeness);
    }
    return { directory: folder, entryPath: path.join(folder, 'archive.html'), manifestPath: path.join(folder, 'manifest.json'), messageCount: state.exported.length, mediaCount: 0, warnings: [] };
  });
  const getLiveService = vi.fn(async () => live);
  const controller = new FeatureController({ userDataPath: folder, integrations, localPlans, voice: voice as unknown as OfflineTranscriptionService, getLiveService, choosePath, chooseKnowledgeFiles, openDirectory, exportArchive });
  return { folder, state, fetcher, integrations, localPlans, getLiveService, live, voice, choosePath, chooseKnowledgeFiles, openDirectory, exportArchive, controller };
}
afterEach(() => { vi.restoreAllMocks(); for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });

describe('FeatureController boundaries', () => {
  it('cancels only the matching reply and discards a late successful result', async () => {
    const test = setup();
    const preview = value(await test.controller.previewConversationReply({ scope, includeKnowledge: false }));
    const pending = Promise.withResolvers<Awaited<ReturnType<IntegrationService['generatePreview']>>>();
    const generate = vi.spyOn(test.integrations, 'generatePreview').mockReturnValueOnce(pending.promise);
    const result = test.controller.generateConversationReply({ scope, previewId: preview.previewId, remoteConsent: true });
    await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());
    const signal = generate.mock.calls[0][2];
    expect(signal?.aborted).toBe(false);
    expect(await test.controller.cancelConversationReply({ scope: { ...scope, contactKey: 'contact-two' }, previewId: preview.previewId })).toMatchObject({ ok: false });
    expect(signal?.aborted).toBe(false);
    expect(await test.controller.cancelConversationReply({ scope, previewId: preview.previewId })).toMatchObject({ ok: true });
    expect(signal?.aborted).toBe(true);
    pending.resolve({ drafts: [], provider: 'openai', model: 'synthetic', sources: [], warnings: [] });
    expect(await result).toMatchObject({ ok: false, cancelled: true, error: expect.stringContaining('已停止生成') });
    expect(await test.controller.cancelConversationReply({ scope, previewId: preview.previewId })).toMatchObject({ ok: true });
    expect(test.fetcher).not.toHaveBeenCalled();
    const next = value(await test.controller.previewConversationReply({ scope, includeKnowledge: false }));
    expect(await test.controller.generateConversationReply({ scope, previewId: next.previewId, remoteConsent: true })).toMatchObject({ ok: true });
    expect(test.fetcher).toHaveBeenCalledOnce();
  });

  it('revokes a dismissed preview without dispatching the model', async () => {
    const test = setup();
    const preview = value(await test.controller.previewConversationReply({ scope, includeKnowledge: false }));
    expect(await test.controller.cancelConversationReply({ scope, previewId: preview.previewId, arbitrary: true })).toMatchObject({ ok: false });
    expect(await test.controller.cancelConversationReply({ scope, previewId: preview.previewId })).toMatchObject({ ok: true });
    expect(await test.controller.generateConversationReply({ scope, previewId: preview.previewId, remoteConsent: true })).toMatchObject({ ok: false });
    expect(test.fetcher).not.toHaveBeenCalled();
  });

  it.each(['account', 'configuration', 'dispose'] as const)('aborts an in-flight request when %s changes', async (change) => {
    const test = setup();
    const preview = value(await test.controller.previewConversationReply({ scope, includeKnowledge: false }));
    const pending = Promise.withResolvers<Awaited<ReturnType<IntegrationService['generatePreview']>>>();
    const generate = vi.spyOn(test.integrations, 'generatePreview').mockReturnValueOnce(pending.promise);
    const result = test.controller.generateConversationReply({ scope, previewId: preview.previewId, remoteConsent: true });
    await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());
    if (change === 'account') test.controller.resetWechatScope('account-two');
    else if (change === 'configuration') await test.controller.updateIntegrationSettings({ ai: { model: 'another-model' } });
    else test.controller.dispose();
    expect(generate.mock.calls[0][2]?.aborted).toBe(true);
    pending.resolve({ drafts: [], provider: 'openai', model: 'synthetic', sources: [], warnings: [] });
    expect(await result).toMatchObject({ ok: false });
    expect(test.fetcher).not.toHaveBeenCalled();
  });

  it('returns actionable login transport errors through the renderer boundary', async () => {
    const test = setup();
    test.fetcher.mockRejectedValueOnce(new Error('net::ERR_CONNECTION_RESET private-details'));
    expect(await test.controller.loginCrm({ username: 'tester', password: 'synthetic-password' })).toEqual({
      ok: false, error: 'CRM连接失败或超时，请检查地址、网络和证书',
    });
  });

  it('passes a device challenge through login and sends the matching cookie on verification', async () => {
    const test = setup();
    test.fetcher.mockResolvedValueOnce(json({ code: 'DEVICE_VERIFICATION_REQUIRED', challengeId: 12, expiresAt: '2026-09-08' }, 403));
    expect(await test.controller.loginCrm({ username: 'tester', password: 'synthetic-password' })).toMatchObject({ ok: true, value: { kind: 'verification-required', challengeId: 12 } });
    const sentDevice = JSON.parse(String(test.fetcher.mock.calls[0][1]?.body)).deviceId;
    expect(await test.controller.verifyCrmDevice(12, '123456')).toMatchObject({ ok: true, value: { kind: 'authenticated' } });
    expect(test.fetcher.mock.calls[1][1]?.headers).toMatchObject({ Cookie: `fafuzx_device_id=${sentDevice}` });
  });

  it('clears knowledge previews after detecting another instance change, but preserves chat-only previews', async () => {
    const test = setup({ secureKnowledge: true });
    test.state.messages = [{ ...textMessage(), text: '服务费怎么收？' }];
    const draft = value(await test.controller.createKnowledgeDocument({ title: '服务费用', body: '服务费用以书面合同为准。', expiry: null }));
    const approved = value(await test.controller.setKnowledgeDocumentStatus({ id: draft.id, expectedRevision: draft.revision, status: 'approved' }));
    const withKnowledge = value(await test.controller.previewConversationReply({ scope, includeKnowledge: true }));
    const withoutKnowledge = value(await test.controller.previewConversationReply({ scope, includeKnowledge: false }));
    const second = new IntegrationService({ settingsPath: path.join(test.folder, 'integrations.json'), fetch: test.fetcher,
      secretStorage: { isEncryptionAvailable: () => true, encryptString: (text) => Buffer.from(text.split('').reverse().join('')),
        decryptString: (bytes) => bytes.toString('utf8').split('').reverse().join('') } });
    await second.initialize();
    await second.setKnowledgeDocumentStatus({ id: approved.id, expectedRevision: approved.revision, status: 'disabled' });
    expect(await test.controller.getKnowledgeWorkspace()).toMatchObject({ ok: false, error: expect.stringContaining('重新打开软件') });
    const generate = vi.spyOn(test.integrations, 'generatePreview');
    expect(await test.controller.generateConversationReply({ scope, previewId: withKnowledge.previewId, remoteConsent: true })).toMatchObject({ ok: false, error: expect.stringContaining('预览已失效') });
    expect(generate).not.toHaveBeenCalled(); expect(test.fetcher).not.toHaveBeenCalled();
    expect(await test.controller.generateConversationReply({ scope, previewId: withoutKnowledge.previewId, remoteConsent: true })).toMatchObject({ ok: true });
    expect(generate).toHaveBeenCalledOnce();
    expect(String(test.fetcher.mock.calls[0][1]?.body)).not.toContain('本机资料/');
  });

  it('keeps the company knowledge inbox independent from WeChat and CRM accounts', async () => {
    const test = setup({ secureKnowledge: true });
    test.state.snapshot.accountKey = undefined;
    const draft = value(await test.controller.createKnowledgeDocument({ title: '服务费用', body: '服务费用以书面合同为准。', expiry: null }));
    expect(value(await test.controller.getKnowledgeWorkspace()).documents).toEqual([expect.objectContaining({ id: draft.id, status: 'draft' })]);
    expect(value(await test.controller.getKnowledgeDocument(draft.id)).body).toContain('书面合同');
    expect(await test.controller.getKnowledgeDocument('C:/outside.txt')).toMatchObject({ ok: false });
    expect(test.getLiveService).not.toHaveBeenCalled(); expect(test.fetcher).not.toHaveBeenCalled();
    expect(await test.controller.reindexKnowledge()).toMatchObject({ ok: true, value: { folderPath: '', documents: 0 } });
  });

  it('does not accept renderer paths, approval flags, or revision guesses in knowledge writes', async () => {
    const test = setup({ secureKnowledge: true });
    expect(await test.controller.importKnowledgeDocuments(['C:/outside.txt'])).toMatchObject({ ok: false });
    expect(await test.controller.createKnowledgeDocument({ title: '资料', body: '正文', expiry: null, status: 'approved' })).toMatchObject({ ok: false });
    expect(await test.controller.createKnowledgeDocument({ title: '资料', body: '正文', expiry: null, filePath: 'C:/outside.txt' })).toMatchObject({ ok: false });
    expect(value(await test.controller.getKnowledgeWorkspace()).documents).toEqual([]);
    expect(test.chooseKnowledgeFiles).not.toHaveBeenCalled();
    expect(test.fetcher).not.toHaveBeenCalled();
  });

  it('imports only explicitly selected local files as drafts and reports cancellation', async () => {
    const test = setup({ secureKnowledge: true });
    expect(await test.controller.importKnowledgeDocuments()).toMatchObject({ ok: false, cancelled: true });
    const selected = path.join(test.folder, 'approved-source.md');
    writeFileSync(selected, '---\nstatus: approved\n---\n# 服务费用\n服务费用以书面合同为准。');
    test.chooseKnowledgeFiles.mockResolvedValueOnce([selected]);
    const imported = value(await test.controller.importKnowledgeDocuments());
    expect(imported.imported).toEqual([expect.objectContaining({ status: 'draft', sourceName: 'approved-source.md' })]);
    expect(value(await test.controller.searchKnowledge('服务费用'))).toEqual([]);
    expect(JSON.stringify(imported)).not.toContain(test.folder);
    expect(test.fetcher).not.toHaveBeenCalled();
  });

  it.each([['relative.md'], Array.from({ length: 21 }, (_, index) => path.resolve(`selected-${index}.md`))])('rejects invalid or excessive main-side file selections', async (...selected) => {
    const test = setup({ secureKnowledge: true });
    test.chooseKnowledgeFiles.mockResolvedValueOnce(selected as string[]);
    const importing = vi.spyOn(test.integrations, 'importKnowledgeDocuments');
    expect(await test.controller.importKnowledgeDocuments()).toMatchObject({ ok: false });
    expect(importing).not.toHaveBeenCalled();
  });

  it('shares the file-dialog lock and ignores a selection that resolves after shutdown', async () => {
    const test = setup({ secureKnowledge: true });
    const selected = path.join(test.folder, 'draft.md'); writeFileSync(selected, '# 草稿\n只在手动导入后保存。');
    const pending = Promise.withResolvers<string[] | null>(); test.chooseKnowledgeFiles.mockReturnValueOnce(pending.promise);
    const importing = vi.spyOn(test.integrations, 'importKnowledgeDocuments');
    const request = test.controller.importKnowledgeDocuments();
    await vi.waitFor(() => expect(test.chooseKnowledgeFiles).toHaveBeenCalledOnce());
    expect(await test.controller.selectKnowledgeFolder()).toMatchObject({ ok: false, error: expect.stringContaining('已经打开') });
    test.controller.dispose(); pending.resolve([selected]);
    expect(await request).toMatchObject({ ok: false, error: expect.stringContaining('已停止') });
    expect(importing).not.toHaveBeenCalled();
    expect(test.fetcher).not.toHaveBeenCalled();
  });

  it.each(['save', 'disable', 'import'] as const)('invalidates knowledge previews when a local %s starts, without invalidating chat-only previews', async (action) => {
    const test = setup({ secureKnowledge: true });
    test.state.messages = [{ ...textMessage(), text: '服务费怎么收？' }];
    const draft = value(await test.controller.createKnowledgeDocument({ title: '服务费用', body: '服务费用以书面合同为准。', expiry: null }));
    const approved = value(await test.controller.setKnowledgeDocumentStatus({ id: draft.id, expectedRevision: draft.revision, status: 'approved' }));
    const withKnowledge = value(await test.controller.previewConversationReply({ scope, includeKnowledge: true }));
    const withoutKnowledge = value(await test.controller.previewConversationReply({ scope, includeKnowledge: false }));
    expect(withKnowledge.sources.some((source) => source.id.startsWith('kb:'))).toBe(true);
    if (action === 'save') await test.controller.saveKnowledgeDocument({ id: approved.id, expectedRevision: approved.revision, title: approved.title, body: '服务费用待核对新合同。', expiry: null });
    if (action === 'disable') await test.controller.setKnowledgeDocumentStatus({ id: approved.id, expectedRevision: approved.revision, status: 'disabled' });
    let releaseImport: (() => void) | undefined;
    let importing: Promise<FeatureResult<KnowledgeImportResult>> | undefined;
    if (action === 'import') {
      const pending = Promise.withResolvers<KnowledgeImportResult>();
      test.chooseKnowledgeFiles.mockResolvedValueOnce([path.join(test.folder, 'new.md')]);
      const importDocuments = vi.spyOn(test.integrations, 'importKnowledgeDocuments').mockReturnValueOnce(pending.promise);
      importing = test.controller.importKnowledgeDocuments();
      releaseImport = () => pending.resolve({ imported: [], skipped: [] });
      await vi.waitFor(() => expect(importDocuments).toHaveBeenCalledOnce());
    }
    expect(await test.controller.generateConversationReply({ scope, previewId: withKnowledge.previewId, remoteConsent: true })).toMatchObject({ ok: false });
    expect(await test.controller.generateConversationReply({ scope, previewId: withoutKnowledge.previewId, remoteConsent: true })).toMatchObject({ ok: true });
    releaseImport?.(); if (importing) await importing;
    expect(test.fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not auto-download, transcribe, export or call a model on startup', async () => {
    const test = setup();
    await test.controller.getIntegrationSettings();
    expect(test.fetcher).not.toHaveBeenCalled();
    expect(test.voice.downloadModel).not.toHaveBeenCalled();
    expect(test.voice.transcribeVoice).not.toHaveBeenCalled();
    expect(test.exportArchive).not.toHaveBeenCalled();
  });

  it('rejects unallowlisted CRM list/task input before any network request', async () => {
    const test = setup();
    expect(await test.controller.listCrmCustomers({ page: 1, limit: 5000, export: 1 })).toMatchObject({ ok: false });
    expect(await test.controller.listCrmTasks({ scope: 'all', customerId: '../private' })).toMatchObject({ ok: false });
    expect(test.fetcher).not.toHaveBeenCalled();
  });

  it('creates local plans only for the current WeChat account and never contacts CRM', async () => {
    const test = setup();
    const plan = value(await test.controller.createLocalPlan({ accountKey: scope.accountKey, title: '确认明天时间', dueAt: '2026-09-01T10:00:00+08:00' }));
    expect(value(await test.controller.listLocalPlans(scope.accountKey))).toEqual([plan]);
    expect(await test.controller.listLocalPlans('another-account')).toMatchObject({ ok: false });
    test.state.snapshot.accountKey = 'another-account';
    test.controller.resetWechatScope('another-account');
    expect(value(await test.controller.listLocalPlans('another-account'))).toEqual([]);
    expect(await test.controller.updateLocalPlan({ accountKey: 'another-account', id: plan.id, done: true })).toMatchObject({ ok: false });
    expect(await test.controller.deleteLocalPlan({ accountKey: 'another-account', id: plan.id })).toMatchObject({ ok: false });
    expect(test.localPlans.list(scope.accountKey)).toEqual([plan]);
    expect(test.fetcher).not.toHaveBeenCalled();
  });

  it('refuses local plan operations without a selected account', async () => {
    const test = setup();
    test.state.snapshot.accountKey = undefined;
    expect(await test.controller.listLocalPlans(scope.accountKey)).toMatchObject({ ok: false });
    expect(await test.controller.createLocalPlan({ accountKey: scope.accountKey, title: 'not created', dueAt: '2026-09-01T00:00:00Z' })).toMatchObject({ ok: false });
    expect(await test.controller.listLocalPlans('')).toMatchObject({ ok: false });
    expect(test.localPlans.list(scope.accountKey)).toEqual([]);
  });

  it('does not persist a plan after the live-service lookup arrives for an old account', async () => {
    const test = setup();
    const pending = Promise.withResolvers<FeatureLiveSource>();
    test.getLiveService.mockReturnValueOnce(pending.promise);
    const create = vi.spyOn(test.localPlans, 'create');
    const result = test.controller.createLocalPlan({ accountKey: scope.accountKey, title: 'late plan', dueAt: '2026-09-01T00:00:00Z' });
    await vi.waitFor(() => expect(test.getLiveService).toHaveBeenCalled());
    test.controller.resetWechatScope('another-account');
    pending.resolve(test.live);
    expect(await result).toMatchObject({ ok: false, error: expect.stringContaining('微信账号已变化') });
    expect(create).not.toHaveBeenCalled();
  });

  it.each(['wechat-account', 'connection-settings', 'dispose'] as const)('rejects an in-flight workspace read after %s changes', async (change) => {
    const test = setup();
    const pending = Promise.withResolvers<Awaited<ReturnType<IntegrationService['listCrmCustomers']>>>();
    const read = vi.spyOn(test.integrations, 'listCrmCustomers').mockReturnValue(pending.promise);
    test.controller.resetWechatScope('account-one');
    const result = test.controller.listCrmCustomers({});
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    if (change === 'wechat-account') test.controller.resetWechatScope('account-two');
    if (change === 'connection-settings') await test.controller.updateIntegrationSettings({ crm: { baseUrl: 'https://another.example' } });
    if (change === 'dispose') test.controller.dispose();
    pending.resolve({ customers: [], total: 0, page: 1, limit: 50, hasMore: false, fetchedAt: '2026-08-31T10:00:00+08:00', sourceBaseUrl: 'https://old.example' });
    expect(await result).toMatchObject({ ok: false, error: expect.stringContaining('旧 CRM 请求结果已丢弃') });
  });

  it('rejects stale account scopes before reading data or opening a file dialog', async () => {
    const test = setup();
    expect(await test.controller.previewConversationReply({ scope: { ...scope, accountKey: 'wrong' }, includeKnowledge: true })).toMatchObject({ ok: false });
    expect(await test.controller.startConversationExport({ accountKey: 'wrong', request: { contactKeys: [scope.contactKey], format: 'html' } })).toMatchObject({ ok: false });
    expect(test.live.messagesSnapshot).not.toHaveBeenCalled();
    expect(test.choosePath).not.toHaveBeenCalled();
  });

  it('requires explicit CRM binding and never matches a customer from a chat nickname', async () => {
    const test = setup();
    await test.controller.loginCrm({ username: 'test-user', password: 'test-password' });
    expect(value(await test.controller.getConversationCrmBinding(scope))).toBe(null);
    const binding = value(await test.controller.setConversationCrmBinding(scope, 77));
    expect(binding).toMatchObject({ customerId: 77, customerName: '确认客户' });
    expect(value(await test.controller.getConversationCrmBinding(scope))).toEqual(binding);
    expect(value(await test.controller.getConversationCrmBinding({ ...scope, contactKey: 'contact-two' }))).toBe(null);
    await test.controller.setConversationCrmBinding(scope, null);
    expect(value(await test.controller.getConversationCrmBinding(scope))).toBe(null);
  });

  it('obtains paths only from the main-process chooser', async () => {
    const test = setup();
    const start = value(await test.controller.startConversationExport({ accountKey: scope.accountKey, request: { contactKeys: [scope.contactKey], format: 'html', directory: 'C:/attacker-directory' } }));
    await vi.waitFor(async () => expect(value(await test.controller.getConversationExportTask(start.id))?.state).toBe('complete'));
    expect(test.choosePath).toHaveBeenCalledWith('export');
    expect(test.exportArchive.mock.calls[0][0].directory).toBe(test.folder);
    expect(JSON.stringify(start)).not.toContain(test.folder);
  });

  it('reports chooser cancellation without starting an export', async () => {
    const test = setup(); test.choosePath.mockResolvedValue(null);
    expect(await test.controller.startConversationExport({ accountKey: scope.accountKey, request: { contactKeys: [scope.contactKey], format: 'html' } })).toMatchObject({ ok: false, cancelled: true });
    expect(test.exportArchive).not.toHaveBeenCalled();
  });

  it('exports multiple full history pages, never calls the 500-message snapshot as all history', async () => {
    const test = setup();
    test.state.pages = [Array.from({ length: 200 }, (_, id) => textMessage(`m${id}`)), Array.from({ length: 200 }, (_, id) => textMessage(`m${id + 200}`)), Array.from({ length: 123 }, (_, id) => textMessage(`m${id + 400}`))];
    const task = value(await test.controller.startConversationExport({ accountKey: scope.accountKey, request: { contactKeys: [scope.contactKey], format: 'html', from: '2026-08-31', to: '2026-08-31' } }));
    await vi.waitFor(async () => expect(value(await test.controller.getConversationExportTask(task.id))?.state).toBe('complete'));
    expect(test.state.exported).toHaveLength(523);
    expect(test.state.exportSourceCompleteness).toEqual(['complete']);
    expect(test.live.messagesSnapshot).not.toHaveBeenCalled();
    expect(test.live.exportMessages).toHaveBeenCalledWith(scope.contactKey, expect.objectContaining({ from: '2026-08-31T00:00:00.000+08:00', to: '2026-08-31T23:59:59.999+08:00' }));
  });

  it('does not claim complete when a later history page fails', async () => {
    const test = setup();
    test.live.exportMessages = async function* () { yield [textMessage()]; throw new Error('读取历史未完成'); };
    const task = value(await test.controller.startConversationExport({ accountKey: scope.accountKey, request: { contactKeys: [scope.contactKey], format: 'html' } }));
    await vi.waitFor(async () => expect(value(await test.controller.getConversationExportTask(task.id))?.state).toBe('failed'));
    expect(test.state.exportSourceCompleteness).toEqual([]);
    expect((value(await test.controller.getConversationExportTask(task.id)))?.result).toMatchObject({ ok: false, cancelled: false });
  });

  it('exports chat without requiring a CRM binding even when optional CRM enrichment is enabled', async () => {
    const test = setup();
    const task = value(await test.controller.startConversationExport({ accountKey: scope.accountKey, request: { contactKeys: [scope.contactKey], format: 'html', includeCrm: true } }));
    await vi.waitFor(async () => expect(value(await test.controller.getConversationExportTask(task.id))?.state).toBe('complete'));
    expect(test.exportArchive).toHaveBeenCalledOnce();
    expect(test.exportArchive.mock.calls[0][0].conversations[0].crm).toBeUndefined();
    expect(test.exportArchive.mock.calls[0][0].conversations[0].crmNotice).toBeUndefined();
  });

  it('omits CRM rather than leaking it or blocking chat export when export permission is denied', async () => {
    const test = setup();
    await test.controller.loginCrm({ username: 'test', password: 'password' });
    await test.controller.setConversationCrmBinding(scope, 77);
    test.state.permissions = ['customers.view'];
    const task = value(await test.controller.startConversationExport({ accountKey: scope.accountKey, request: { contactKeys: [scope.contactKey], format: 'html', includeCrm: true } }));
    await vi.waitFor(async () => expect(value(await test.controller.getConversationExportTask(task.id))?.state).toBe('complete'));
    expect(test.exportArchive).toHaveBeenCalledOnce();
    expect(test.exportArchive.mock.calls[0][0].conversations[0].crm).toBeUndefined();
    expect(test.exportArchive.mock.calls[0][0].conversations[0].crmNotice).toContain('无权导出 CRM');
  });

  it('continues the WeChat export when a saved CRM session can no longer be verified', async () => {
    const test = setup();
    await test.controller.loginCrm({ username: 'test', password: 'password' });
    await test.controller.setConversationCrmBinding(scope, 77);
    vi.spyOn(test.integrations, 'testCrm').mockRejectedValueOnce(new Error('CRM 登录已过期'));
    const task = value(await test.controller.startConversationExport({ accountKey: scope.accountKey, request: { contactKeys: [scope.contactKey], format: 'html', includeCrm: true } }));
    await vi.waitFor(async () => expect(value(await test.controller.getConversationExportTask(task.id))?.state).toBe('complete'));
    expect(test.exportArchive).toHaveBeenCalledOnce();
    expect(test.exportArchive.mock.calls[0][0].conversations[0].crm).toBeUndefined();
    expect(test.exportArchive.mock.calls[0][0].conversations[0].crmNotice).toContain('微信聊天仍已正常导出');
  });

  it('checks an unavailable optional CRM identity only once for a multi-chat export', async () => {
    const test = setup();
    await test.controller.loginCrm({ username: 'test', password: 'password' });
    const contactKeys = Array.from({ length: 5 }, (_, index) => `contact-${index + 1}`);
    test.state.snapshot.conversations = contactKeys.map((contactKey) => ({ contactKey, displayName: contactKey, kind: 'contact' as const }));
    const identity = vi.spyOn(test.integrations, 'testCrm').mockRejectedValue(new Error('CRM 服务离线'));
    const task = value(await test.controller.startConversationExport({ accountKey: scope.accountKey, request: { contactKeys, format: 'html', includeCrm: true } }));
    await vi.waitFor(async () => expect(value(await test.controller.getConversationExportTask(task.id))?.state).toBe('complete'));
    expect(identity).toHaveBeenCalledOnce();
    expect(test.exportArchive.mock.calls[0][0].conversations).toHaveLength(5);
    expect(test.exportArchive.mock.calls[0][0].conversations.every((conversation) => conversation.crmNotice?.includes('微信聊天仍已正常导出'))).toBe(true);
  });

  it('warns the remaining chats when the optional CRM session expires during enrichment', async () => {
    const test = setup();
    await test.controller.loginCrm({ username: 'test', password: 'password' });
    const contactKeys = ['contact-one', 'contact-two', 'contact-three'];
    test.state.snapshot.conversations = contactKeys.map((contactKey) => ({ contactKey, displayName: contactKey, kind: 'contact' as const }));
    for (let index = 0; index < contactKeys.length; index += 1) {
      await test.controller.setConversationCrmBinding({ accountKey: scope.accountKey, contactKey: contactKeys[index] }, 77 + index);
    }
    const original = test.integrations.getCrmContext.bind(test.integrations);
    let reads = 0;
    const contexts = vi.spyOn(test.integrations, 'getCrmContext').mockImplementation(async (...args) => {
      reads += 1;
      if (reads === 2) { test.integrations.disconnectCrm(); throw new Error('读取 CRM 失败：401，请重新登录'); }
      return original(...args);
    });
    const task = value(await test.controller.startConversationExport({ accountKey: scope.accountKey, request: { contactKeys, format: 'html', includeCrm: true } }));
    await vi.waitFor(async () => expect(value(await test.controller.getConversationExportTask(task.id))?.state).toBe('complete'));
    expect(contexts).toHaveBeenCalledTimes(2);
    const exported = test.exportArchive.mock.calls[0][0].conversations;
    expect(exported[0].crm).toBeDefined();
    expect(exported[1].crmNotice).toContain('微信聊天仍已正常导出');
    expect(exported[2].crmNotice).toContain('微信聊天仍已正常导出');
  });

  it('cancels an in-progress export and opens only a task-created directory', async () => {
    const test = setup();
    let observedSignal: AbortSignal | undefined;
    test.exportArchive.mockImplementationOnce((input) => new Promise((_, reject) => {
      observedSignal = input.signal;
      input.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    }));
    const task = value(await test.controller.startConversationExport({ accountKey: scope.accountKey, request: { contactKeys: [scope.contactKey], format: 'html' } }));
    await vi.waitFor(() => expect(observedSignal).toBeDefined());
    await test.controller.cancelConversationExport(task.id);
    await vi.waitFor(async () => expect(value(await test.controller.getConversationExportTask(task.id))?.state).toBe('cancelled'));
    expect(await test.controller.openConversationExport(task.id)).toMatchObject({ ok: false });
    expect(await test.controller.openConversationExport('C:/private')).toMatchObject({ ok: false });
    expect(test.openDirectory).not.toHaveBeenCalled();
    const next = value(await test.controller.startConversationExport({ accountKey: scope.accountKey, request: { contactKeys: [scope.contactKey], format: 'html' } }));
    await vi.waitFor(async () => expect(value(await test.controller.getConversationExportTask(next.id))?.state).toBe('complete'));
    expect(await test.controller.openConversationExport(next.id)).toMatchObject({ ok: true });
    expect(test.openDirectory).toHaveBeenCalledWith(realpathSync.native(test.folder));
  });

  it('opens a canonical export directory through an alias but rejects a retargeted alias', async () => {
    const test = setup();
    const target = path.join(test.folder, 'export target');
    const other = path.join(test.folder, 'unrelated directory');
    const alias = path.join(test.folder, 'export alias');
    mkdirSync(target); mkdirSync(other);
    symlinkSync(target, alias, 'junction');
    test.exportArchive.mockResolvedValueOnce({ directory: alias, entryPath: path.join(alias, 'archive.html'),
      manifestPath: path.join(alias, 'manifest.json'), messageCount: 1, mediaCount: 0, warnings: [] });
    const task = value(await test.controller.startConversationExport({ accountKey: scope.accountKey, request: { contactKeys: [scope.contactKey], format: 'html' } }));
    await vi.waitFor(async () => expect(value(await test.controller.getConversationExportTask(task.id))?.state).toBe('complete'));
    expect(await test.controller.openConversationExport(task.id)).toMatchObject({ ok: true });
    expect(test.openDirectory).toHaveBeenCalledWith(realpathSync.native(target));
    test.openDirectory.mockClear();
    unlinkSync(alias); symlinkSync(other, alias, 'junction');
    expect(await test.controller.openConversationExport(task.id)).toMatchObject({ ok: false, error: expect.stringContaining('目录已变化') });
    expect(test.openDirectory).not.toHaveBeenCalled();
  });

  it.each(['account', 'dispose'] as const)('does not open a finished export when %s changes during path resolution', async (change) => {
    const test = setup();
    const task = value(await test.controller.startConversationExport({ accountKey: scope.accountKey, request: { contactKeys: [scope.contactKey], format: 'html' } }));
    await vi.waitFor(async () => expect(value(await test.controller.getConversationExportTask(task.id))?.state).toBe('complete'));
    const pending = Promise.withResolvers<string>();
    const resolvePath = vi.mocked(fsPromises.realpath).mockClear().mockImplementationOnce(() => pending.promise);
    const opening = test.controller.openConversationExport(task.id);
    await vi.waitFor(() => expect(resolvePath).toHaveBeenCalledOnce());
    if (change === 'account') test.controller.resetWechatScope('account-two');
    else test.controller.dispose();
    pending.resolve(realpathSync.native(test.folder));
    expect(await opening).toMatchObject({ ok: false });
    expect(test.openDirectory).not.toHaveBeenCalled();
  });

  it('invalidates finished export handles when the WeChat account changes', async () => {
    const test = setup();
    const task = value(await test.controller.startConversationExport({ accountKey: scope.accountKey, request: { contactKeys: [scope.contactKey], format: 'html' } }));
    await vi.waitFor(async () => expect(value(await test.controller.getConversationExportTask(task.id))?.state).toBe('complete'));
    test.controller.resetWechatScope('account-two');
    expect(value(await test.controller.getConversationExportTask(task.id))).toBe(null);
    expect(await test.controller.openConversationExport(task.id)).toMatchObject({ ok: false });
    expect(test.openDirectory).not.toHaveBeenCalled();
  });

  it('converts an exported SILK voice locally without ASR or a model download', async () => {
    const test = setup();
    test.state.pages = [[{ ...textMessage('voice-1'), text: '[语音]', messageType: 'voice', voiceMediaKey: voiceAlias }]];
    const source = Buffer.from('#!SILK_V3-test');
    const decoded = Buffer.from('RIFF........WAVEfmt test');
    vi.mocked(test.live.readVoice).mockResolvedValueOnce({ bytes: source, format: 'silk' });
    test.voice.decodeWechatVoiceToWav.mockResolvedValueOnce({ ok: true, bytes: decoded, mime: 'audio/wav' });
    let exportedBytes: Uint8Array | undefined;
    test.exportArchive.mockImplementationOnce(async (input) => {
      for await (const page of input.conversations[0].messages as AsyncIterable<readonly ExportMessage[]>) {
        const result = await input.resolveMedia?.(String(page[0].mediaKey), { signal: new AbortController().signal, maxBytes: 1024 });
        if (result?.ok) { expect(result.mime).toBe('audio/wav'); exportedBytes = result.bytes; }
      }
      return { directory: test.folder, entryPath: path.join(test.folder, 'archive.html'), manifestPath: path.join(test.folder, 'manifest.json'), messageCount: 1, mediaCount: 1, warnings: [] };
    });
    const task = value(await test.controller.startConversationExport({ accountKey: scope.accountKey, request: { contactKeys: [scope.contactKey], format: 'html', media: 'available' } }));
    await vi.waitFor(async () => expect(value(await test.controller.getConversationExportTask(task.id))?.state).toBe('complete'));
    expect(Buffer.from(exportedBytes ?? []).toString()).toContain('WAVE');
    expect([...source].every((byte) => byte === 0)).toBe(true);
    expect([...decoded].every((byte) => byte === 0)).toBe(true);
    expect(test.voice.decodeWechatVoiceToWav).toHaveBeenCalledTimes(1);
    expect(test.voice.transcribeVoice).not.toHaveBeenCalled();
    expect(test.voice.downloadModel).not.toHaveBeenCalled();
  });

  it('rejects arbitrary paths and unknown keys in configuration operations', async () => {
    const test = setup();
    expect(await test.controller.updateIntegrationSettings({ ai: { model: 'x' }, filePath: '/private' })).toMatchObject({ ok: false });
    expect(await test.controller.getCrmCustomerContext('file:///private')).toMatchObject({ ok: false });
    expect(test.fetcher).not.toHaveBeenCalled();
  });
});

describe('exact preview and human-confirmed transcripts', () => {
  it('does not dispatch an unconsumed five-minute preview after its knowledge expires at midnight', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-08-31T23:59:30+08:00'));
    const test = setup();
    writeFileSync(path.join(test.folder, 'expiry.md'), '---\nstatus: approved\nexpiry: 2026-08-31\n---\n# 服务费用\n服务费用以书面合同为准。');
    await test.controller.selectKnowledgeFolder();
    test.state.messages = [{ ...textMessage(), text: '服务费怎么收？' }];
    const preview = value(await test.controller.previewConversationReply({ scope, includeKnowledge: true }));
    expect(preview.sources.some((source) => source.id.startsWith('kb:'))).toBe(true);
    clock.mockReturnValue(Date.parse('2026-09-01T00:00:30+08:00'));
    expect(Date.parse(preview.expiresAt)).toBeGreaterThan(Date.now());
    expect(await test.controller.generateConversationReply({ scope, previewId: preview.previewId, remoteConsent: true })).toMatchObject({ ok: false, error: expect.stringContaining('知识库引用已过期') });
    expect(test.fetcher).not.toHaveBeenCalled();
  });

  it.each(['rebuild', 'clear'] as const)('only invalidates knowledge-bearing previews during a knowledge %s', async (action) => {
    const test = setup();
    writeFileSync(path.join(test.folder, 'fees.md'), '# 服务费用\n服务费用以书面合同为准。');
    await test.controller.selectKnowledgeFolder();
    test.state.messages = [{ ...textMessage(), text: '服务费怎么收？' }];
    const withKnowledge = value(await test.controller.previewConversationReply({ scope, includeKnowledge: true }));
    const withoutKnowledge = value(await test.controller.previewConversationReply({ scope, includeKnowledge: false }));
    if (action === 'rebuild') await test.controller.reindexKnowledge();
    else await test.controller.clearKnowledge();
    expect(await test.controller.generateConversationReply({ scope, previewId: withKnowledge.previewId, remoteConsent: true })).toMatchObject({ ok: false });
    expect(await test.controller.generateConversationReply({ scope, previewId: withoutKnowledge.previewId, remoteConsent: true })).toMatchObject({ ok: true });
    expect(test.fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])('rechecks only knowledge-bearing in-flight replies after rebuilding: includeKnowledge=%s', async (includeKnowledge) => {
    const test = setup();
    writeFileSync(path.join(test.folder, 'fees.md'), '# 服务费用\n服务费用以书面合同为准。');
    await test.controller.selectKnowledgeFolder();
    test.state.messages = [{ ...textMessage(), text: '服务费怎么收？' }];
    const preview = value(await test.controller.previewConversationReply({ scope, includeKnowledge }));
    const pending = Promise.withResolvers<Awaited<ReturnType<IntegrationService['generatePreview']>>>();
    const generate = vi.spyOn(test.integrations, 'generatePreview').mockReturnValueOnce(pending.promise);
    const result = test.controller.generateConversationReply({ scope, previewId: preview.previewId, remoteConsent: true });
    await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());
    await test.controller.reindexKnowledge();
    pending.resolve({ drafts: [{ text: '我们先核实费用。', reason: '回应问题', sourceIds: ['chat:1'] }], provider: 'openai', model: 'test-model', sources: [], warnings: [] });
    expect(await result).toMatchObject(includeKnowledge ? { ok: false, error: expect.stringContaining('知识库已变化') } : { ok: true });
    expect(test.fetcher).not.toHaveBeenCalled();
  });

  it.each(['好的', '周六下午可以', '[图片]'])('allows requested drafting while preserving the actual live policy for %s', async (text) => {
    const test = setup();
    test.state.messages.push({ ...textMessage('m2'), text, ...(text === '[图片]' ? { messageType: 'image' as const } : {}) });
    const preview = value(await test.controller.previewConversationReply({ scope, includeKnowledge: false }));
    expect(preview.replyPolicy?.nextMove).toMatch(/wait|human_review/);
    const actualMove = preview.replyPolicy?.nextMove;
    // The renderer receives a clone, not the cached authorization state.
    if (preview.replyPolicy) preview.replyPolicy.nextMove = 'offer_visit';
    expect(test.fetcher).not.toHaveBeenCalled();
    const sourceId = text === '[图片]' ? 'chat:1' : 'chat:2';
    test.fetcher.mockResolvedValueOnce(json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ drafts: [{ text: '您还有哪一点想先了解？', reason: '承接已知对话，供人工选择发送时机', sourceIds: [sourceId] }] }) } }] }));
    expect(await test.controller.generateConversationReply({ scope, previewId: preview.previewId, remoteConsent: true })).toMatchObject({ ok: true });
    const body = JSON.parse(String(test.fetcher.mock.calls[0][1]?.body));
    expect(body.messages[0].content).toContain(`"nextMove":"${actualMove}"`);
    expect(body.messages[0].content).not.toContain('"nextMove":"offer_visit"');
    expect(JSON.parse(body.messages[1].content)).toMatchObject({ currentMessageSourceId: sourceId, latestMessageHasText: text !== '[图片]' });
  });

  it('generates on user request after the latest outgoing message and still consumes consent once', async () => {
    const test = setup();
    test.state.messages.push({ ...textMessage('outbound'), direction: 'outgoing', text: '您哪天方便来公司了解？' });
    const preview = value(await test.controller.previewConversationReply({ scope, includeKnowledge: false }));
    expect(preview.replyPolicy).toMatchObject({ nextMove: 'wait', stage: 'invited' });
    expect(preview.isRemote).toBe(true);
    expect(test.fetcher).not.toHaveBeenCalled();
    test.fetcher.mockResolvedValueOnce(json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ drafts: [{ text: '您还有想先了解的问题吗？', reason: '不重复已发邀约，供人工择时使用', sourceIds: ['chat:2'] }] }) } }] }));
    expect(await test.controller.generateConversationReply({ scope, previewId: preview.previewId, remoteConsent: true })).toMatchObject({ ok: true });
    expect(await test.controller.generateConversationReply({ scope, previewId: preview.previewId, remoteConsent: true })).toMatchObject({ ok: false });
    expect(test.fetcher).toHaveBeenCalledOnce();
  });

  it('returns a local clarification when only an unread voice message is available', async () => {
    const test = setup();
    test.state.messages = [{ ...textMessage('voice-1'), text: '[语音]', messageType: 'voice', voiceMediaKey: voiceAlias }];
    const preview = value(await test.controller.previewConversationReply({ scope, includeKnowledge: false }));
    expect(preview.isRemote).toBe(false);
    const result = value(await test.controller.generateConversationReply({ scope, previewId: preview.previewId, remoteConsent: false }));
    expect(result.model).toBe('本地澄清（未调用模型）');
    expect(result.drafts).toHaveLength(2);
    expect(test.fetcher).not.toHaveBeenCalled();
  });

  it.each(['最近比较忙，过段时间再联系', '不要再联系我'])('only returns local acknowledgements for %s', async (text) => {
    const test = setup();
    test.state.messages.push({ ...textMessage('m2'), text });
    const preview = value(await test.controller.previewConversationReply({ scope, includeKnowledge: false }));
    const result = value(await test.controller.generateConversationReply({ scope, previewId: preview.previewId, remoteConsent: false }));
    expect(preview.isRemote).toBe(false);
    expect(result.model).toContain('未调用模型');
    expect(result.drafts.every((draft) => !/电话|到店|公司|预约|[？?]/.test(draft.text))).toBe(true);
    expect(test.fetcher).not.toHaveBeenCalled();
  });

  it('rejects renderer-provided messages or policies before reading any live context', async () => {
    const test = setup();
    expect(await test.controller.previewConversationReply({ scope, includeKnowledge: false, replyPolicy: { nextMove: 'offer_visit' } })).toMatchObject({ ok: false });
    expect(await test.controller.previewConversationReply({ scope, includeKnowledge: false, messages: [textMessage()] })).toMatchObject({ ok: false });
    expect(test.live.messagesSnapshot).not.toHaveBeenCalled();
    expect(test.fetcher).not.toHaveBeenCalled();
  });

  it('invalidates a preview when the same message changes from text to unrecognized media', async () => {
    const test = setup();
    const preview = value(await test.controller.previewConversationReply({ scope, includeKnowledge: false }));
    test.state.messages[0].messageType = 'image';
    expect(await test.controller.generateConversationReply({ scope, previewId: preview.previewId, remoteConsent: true })).toMatchObject({ ok: false });
    expect(test.fetcher).not.toHaveBeenCalled();
  });

  it('rechecks current CRM facts against the cached strategy before dispatching a model', async () => {
    const test = setup();
    await test.controller.loginCrm({ username: 'test-user', password: 'test-password' });
    await test.controller.setConversationCrmBinding(scope, 77);
    test.state.messages = [{ ...textMessage(), text: '预算300万' }];
    const preview = value(await test.controller.previewConversationReply({ scope, includeKnowledge: false }));
    expect(preview.replyPolicy?.nextMove).toBe('ask_one_fact');
    const current = await test.integrations.getCrmContext(77);
    vi.spyOn(test.integrations, 'getCrmContext').mockResolvedValueOnce({ ...current, customer: { ...current.customer, budget: '400万' } });
    test.fetcher.mockClear();
    expect(await test.controller.generateConversationReply({ scope, previewId: preview.previewId, remoteConsent: true })).toMatchObject({ ok: false, error: expect.stringContaining('客户状态或资料已变化') });
    expect(test.fetcher).not.toHaveBeenCalled();
  });

  it('rejects changed CRM followup evidence even when the strategy is unchanged', async () => {
    const test = setup();
    await test.controller.loginCrm({ username: 'test-user', password: 'test-password' });
    await test.controller.setConversationCrmBinding(scope, 77);
    const preview = value(await test.controller.previewConversationReply({ scope, includeKnowledge: false }));
    const current = await test.integrations.getCrmContext(77);
    vi.spyOn(test.integrations, 'getCrmContext').mockResolvedValueOnce({ ...current, followups: [{ content: '刚确认预算变更，待本人核实', followupAt: '2026-09-12' }] });
    test.fetcher.mockClear();
    expect(await test.controller.generateConversationReply({ scope, previewId: preview.previewId, remoteConsent: true })).toMatchObject({ ok: false, error: expect.stringContaining('CRM 资料或跟进记录已变化') });
    expect(test.fetcher).not.toHaveBeenCalled();
  });

  it('allows the same CRM excerpts fetched at a later time and sends the reviewed source snapshot', async () => {
    const test = setup();
    await test.controller.loginCrm({ username: 'test-user', password: 'test-password' });
    await test.controller.setConversationCrmBinding(scope, 77);
    const preview = value(await test.controller.previewConversationReply({ scope, includeKnowledge: false }));
    const current = await test.integrations.getCrmContext(77);
    vi.spyOn(test.integrations, 'getCrmContext').mockResolvedValueOnce({ ...current, fetchedAt: '2099-01-01' });
    test.fetcher.mockClear();
    expect(await test.controller.generateConversationReply({ scope, previewId: preview.previewId, remoteConsent: true })).toMatchObject({ ok: true });
    const body = JSON.parse(String(test.fetcher.mock.calls[0][1]?.body));
    expect(JSON.parse(body.messages[1].content).sources).toEqual(preview.sources);
    expect(test.fetcher).toHaveBeenCalledOnce();
  });

  it('discards a model draft when a pause arrives while generation is in flight', async () => {
    const test = setup();
    const preview = value(await test.controller.previewConversationReply({ scope, includeKnowledge: false }));
    const pending = Promise.withResolvers<Awaited<ReturnType<IntegrationService['generatePreview']>>>();
    const generate = vi.spyOn(test.integrations, 'generatePreview').mockReturnValue(pending.promise);
    const result = test.controller.generateConversationReply({ scope, previewId: preview.previewId, remoteConsent: true });
    await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());
    test.state.messages.push({ ...textMessage('pause-now'), text: '最近比较忙，过段时间再联系' });
    pending.resolve({ drafts: [{ text: '想来公司吗？', reason: '旧上下文', sourceIds: ['chat:1'] }], provider: 'openai', model: 'test-model', sources: [], warnings: [] });
    expect(await result).toMatchObject({ ok: false, error: expect.stringContaining('客户已有新消息') });
    expect(test.fetcher).not.toHaveBeenCalled();
  });

  it('previews locally and only sends after explicit consent, consuming the preview once', async () => {
    const test = setup();
    const preview = value(await test.controller.previewConversationReply({ scope, includeKnowledge: false }));
    expect(preview.isRemote).toBe(true);
    expect(preview.contextSummary?.knowledgeStatus).toBe('disabled');
    expect(test.fetcher).not.toHaveBeenCalled();
    expect(preview.sources[0].text).toBe('流程是怎样的？');
    const generated = await test.controller.generateConversationReply({ scope, previewId: preview.previewId, remoteConsent: true });
    expect(generated).toMatchObject({ ok: true });
    const body = JSON.parse(String(test.fetcher.mock.calls[0][1]?.body));
    expect(JSON.parse(body.messages[1].content).sources).toEqual(preview.sources);
    expect(await test.controller.generateConversationReply({ scope, previewId: preview.previewId, remoteConsent: true })).toMatchObject({ ok: false });
    expect(test.fetcher).toHaveBeenCalledTimes(1);
  });

  it('supports chat-only replies when CRM identity is unavailable and only dispatches one paid request', async () => {
    const test = setup();
    await test.integrations.loginCrm({ username: 'tester', password: 'synthetic-password' });
    test.fetcher.mockClear();
    const identity = vi.spyOn(test.integrations, 'testCrm').mockRejectedValue(new Error('CRM unavailable'));
    const preview = value(await test.controller.previewConversationReply({ scope, includeKnowledge: false, includeCrm: false }));
    expect(identity).not.toHaveBeenCalled();
    expect(test.fetcher).not.toHaveBeenCalled();
    const request = { scope, previewId: preview.previewId, remoteConsent: true };
    const results = await Promise.all([test.controller.generateConversationReply(request), test.controller.generateConversationReply(request)]);
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(test.fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not send paid model requests without this-request permission', async () => {
    const test = setup();
    const preview = value(await test.controller.previewConversationReply({ scope, includeKnowledge: false }));
    expect(await test.controller.generateConversationReply({ scope, previewId: preview.previewId, remoteConsent: false })).toMatchObject({ ok: false });
    expect(test.fetcher).not.toHaveBeenCalled();
  });

  it('rejects a preview after new messages, configuration changes or an account switch', async () => {
    const test = setup();
    let preview: ConversationReplyPreview = value(await test.controller.previewConversationReply({ scope, includeKnowledge: false }));
    test.state.messages.push({ ...textMessage('m2'), text: '我已经改主意了' });
    expect(await test.controller.generateConversationReply({ scope, previewId: preview.previewId, remoteConsent: true })).toMatchObject({ ok: false });
    preview = value(await test.controller.previewConversationReply({ scope, includeKnowledge: false }));
    await test.controller.updateIntegrationSettings({ ai: { model: 'other-model' } });
    expect(await test.controller.generateConversationReply({ scope, previewId: preview.previewId, remoteConsent: true })).toMatchObject({ ok: false });
    preview = value(await test.controller.previewConversationReply({ scope, includeKnowledge: false }));
    test.controller.resetWechatScope('another-account');
    expect(await test.controller.generateConversationReply({ scope, previewId: preview.previewId, remoteConsent: true })).toMatchObject({ ok: false });
    expect(test.fetcher).not.toHaveBeenCalled();
  });

  it.each(['account', 'configuration', 'confirmed voice'] as const)('does not send stale context when %s changes during the final message snapshot', async (change) => {
    const test = setup();
    if (change === 'confirmed voice') {
      test.state.messages.push({ ...textMessage('voice-1'), text: '[语音]', messageType: 'voice', voiceMediaKey: voiceAlias });
      expect(await test.controller.transcribeWechatVoice(voiceAlias, scope)).toMatchObject({ ok: true });
      expect(await test.controller.confirmWechatVoiceTranscript({ scope, voiceMediaKey: voiceAlias, text: '周六方便' })).toMatchObject({ ok: true });
      // A previously recognized voice may be outside the latest 100-message window.
      // Confirming it still invalidates this conversation's user-visible preview.
      test.state.messages = [textMessage()];
    }
    const preview = value(await test.controller.previewConversationReply({ scope, includeKnowledge: false }));
    const generate = vi.spyOn(test.integrations, 'generatePreview');
    const oldMessages = test.state.messages.map((message) => ({ ...message }));
    let releaseSnapshot: ((messages: WechatLiveMessage[]) => void) | undefined;
    const snapshot = vi.mocked(test.live.messagesSnapshot).mockReset().mockResolvedValue(oldMessages);
    snapshot.mockResolvedValueOnce(oldMessages).mockImplementationOnce(() => new Promise((resolve) => { releaseSnapshot = resolve; }));

    const pending = test.controller.generateConversationReply({ scope, previewId: preview.previewId, remoteConsent: true });
    await vi.waitFor(() => expect(releaseSnapshot).toBeDefined());
    expect(snapshot).toHaveBeenCalledTimes(2);
    if (change === 'account') {
      test.state.snapshot.accountKey = 'account-two';
      test.controller.resetWechatScope('account-two');
    } else if (change === 'configuration') {
      // Keep the model destination unchanged so its own endpoint check cannot mask the race.
      expect(await test.controller.updateIntegrationSettings({ crm: { username: 'other-account' } })).toMatchObject({ ok: true });
    } else {
      expect(await test.controller.confirmWechatVoiceTranscript({ scope, voiceMediaKey: voiceAlias, text: '改为周日方便' })).toMatchObject({ ok: true });
    }
    if (!releaseSnapshot) throw new Error('The second snapshot was not requested');
    releaseSnapshot(oldMessages);
    const result = await pending;

    expect(generate).not.toHaveBeenCalled();
    expect(test.fetcher).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false });
  });

  it('keeps unreviewed ASR outside AI and exports, then uses only user-confirmed text', async () => {
    const test = setup();
    const voiceMessage: WechatLiveMessage = { ...textMessage('voice-1'), text: '[语音]', messageType: 'voice', voiceMediaKey: voiceAlias };
    test.state.messages.push(voiceMessage); test.state.pages = [[voiceMessage]];
    expect(await test.controller.transcribeWechatVoice(voiceAlias, scope)).toMatchObject({ ok: true, sourceKey: voiceAlias });
    let preview = value(await test.controller.previewConversationReply({ scope, includeKnowledge: false }));
    expect(JSON.stringify(preview)).not.toContain('周六上午');
    expect(preview.replyPolicy?.nextMove).toBe('human_review');
    expect(await test.controller.generateConversationReply({ scope, previewId: preview.previewId, remoteConsent: true })).toMatchObject({ ok: true });
    expect(test.fetcher).toHaveBeenCalledOnce();
    expect(String(test.fetcher.mock.calls[0][1]?.body)).not.toContain('周六上午');
    const before = value(await test.controller.startConversationExport({ accountKey: scope.accountKey, request: { contactKeys: [scope.contactKey], format: 'html', includeVoiceTranscripts: true } }));
    await vi.waitFor(async () => expect(value(await test.controller.getConversationExportTask(before.id))?.state).toBe('complete'));
    expect(test.state.exported[0].voiceTranscript).toBeUndefined();
    expect(await test.controller.confirmWechatVoiceTranscript({ scope, voiceMediaKey: voiceAlias, text: '校对后：周日早上方便' })).toMatchObject({ ok: true });
    preview = value(await test.controller.previewConversationReply({ scope, includeKnowledge: false }));
    expect(JSON.stringify(preview)).toContain('周日早上');
    expect(JSON.stringify(preview)).toContain('经用户核对');
    expect(JSON.stringify(preview)).not.toContain('周六上午');
    expect(test.voice.transcribeVoice).toHaveBeenCalledTimes(1);
  });

  it('applies a refusal from a user-confirmed voice transcript without calling the model', async () => {
    const test = setup();
    test.state.messages.push({ ...textMessage('voice-1'), text: '[语音]', messageType: 'voice', voiceMediaKey: voiceAlias });
    await test.controller.transcribeWechatVoice(voiceAlias, scope);
    await test.controller.confirmWechatVoiceTranscript({ scope, voiceMediaKey: voiceAlias, text: '不考虑了，不要再联系我' });
    const preview = value(await test.controller.previewConversationReply({ scope, includeKnowledge: false }));
    expect(preview.replyPolicy?.nextMove).toBe('acknowledge_close');
    const result = value(await test.controller.generateConversationReply({ scope, previewId: preview.previewId, remoteConsent: false }));
    expect(result.drafts.every((draft) => /不再|停止/.test(draft.text))).toBe(true);
    expect(result.model).toContain('未调用模型');
    expect(test.fetcher).not.toHaveBeenCalled();
  });

  it('cannot confirm arbitrary voice ids or cross-conversation results', async () => {
    const test = setup();
    expect(await test.controller.confirmWechatVoiceTranscript({ scope, voiceMediaKey: voiceAlias, text: '编造内容' })).toMatchObject({ ok: false });
    test.state.messages.push({ ...textMessage('voice-1'), text: '[语音]', messageType: 'voice', voiceMediaKey: voiceAlias });
    await test.controller.transcribeWechatVoice(voiceAlias, scope);
    expect(await test.controller.confirmWechatVoiceTranscript({ scope: { ...scope, contactKey: 'contact-two' }, voiceMediaKey: voiceAlias, text: '错误客户' })).toMatchObject({ ok: false });
  });

  it('discards pending voice results and clears reviewed text on account switch', async () => {
    const test = setup();
    test.state.messages.push({ ...textMessage('voice-1'), text: '[语音]', messageType: 'voice', voiceMediaKey: voiceAlias });
    let finish: (result: VoiceTranscriptionResult) => void = () => undefined;
    test.voice.transcribeVoice.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pending = test.controller.transcribeWechatVoice(voiceAlias, scope);
    await vi.waitFor(() => expect(test.voice.transcribeVoice).toHaveBeenCalledTimes(1));
    test.state.snapshot.accountKey = 'account-two'; test.controller.resetWechatScope('account-two');
    finish({ ok: true, text: '旧账号内容', engine: 'SenseVoice' });
    expect(await pending).toMatchObject({ ok: false, reason: 'cancelled' });
    expect(test.voice.cancelPending).toHaveBeenCalled();
    expect(await test.controller.confirmWechatVoiceTranscript({ scope: { ...scope, accountKey: 'account-two' }, voiceMediaKey: voiceAlias, text: '旧账号内容' })).toMatchObject({ ok: false });
  });
});
