import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiDraftRequest, CrmCustomerContext } from '../../shared/integration-contracts';
import { IntegrationService } from './integration-service';
import { KnowledgeLibrary } from './knowledge-library';
import { KnowledgeRepository } from './knowledge-repository';
import type { KnowledgeImportResult } from '../../shared/knowledge-workspace-contracts';

const folders: string[] = [];
const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status });
const request: AiDraftRequest = { messages: [{ id: '1', direction: 'incoming', sender: '客户', text: '需要先了解流程', sentAt: '2026-08-31' }], includeKnowledge: true, remoteConsent: true };
function setup(fetcher: typeof fetch, options: { secure?: boolean; settingsPath?: string; cloudKnowledge?: boolean } = {}) {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'lingxu-service-test-'));
  folders.push(folder);
  return new IntegrationService({ cloudKnowledge: options.cloudKnowledge, settingsPath: options.settingsPath ?? path.join(folder, 'integration.json'), fetch: fetcher, secretStorage: {
    isEncryptionAvailable: () => options.secure === true,
    encryptString: (text) => { if (!options.secure) throw new Error('not available'); return Buffer.from(text.split('').reverse().join('')); },
    decryptString: (bytes) => { if (!options.secure) throw new Error('not available'); return bytes.toString('utf8').split('').reverse().join(''); },
  } });
}
function enableAi(service: IntegrationService) { service.updateSettings({ ai: { model: 'test-model', apiKey: 'secret', allowRemote: true } }); }
function knowledgeFolder() { const folder = mkdtempSync(path.join(os.tmpdir(), 'lingxu-service-kb-test-')); folders.push(folder); return folder; }
const modelReply = () => json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ drafts: [{ text: '我们先核实费用依据。', reason: '回应费用问题', sourceIds: ['chat:1'] }] }) } }] });
const feeRequest: AiDraftRequest = { ...request, messages: [{ ...request.messages[0], text: '服务费怎么收？' }] };
const companyDraft = { title: '服务费用', body: '服务费用以双方确认的书面合同为准。', expiry: null };
afterEach(() => { vi.restoreAllMocks(); for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });

describe('IntegrationService', () => {
  it.each([true, false])('retrieves cloud knowledge before any model request even with an old opt-out (hits: %s)', async (hasHits) => {
    const version = 'd'.repeat(64);
    const events: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      const target = String(url); events.push(target);
      if (target.endsWith('/auth/login')) return json({ token: 'synthetic' });
      if (target.endsWith('/auth/me')) return json({ user: { id: 1 } });
      if (target.endsWith('/status')) return json({ version, documents: 1, chunks: 1 });
      if (target.endsWith('/search')) return json({ version, hits: hasHits ? [{ id: 'kb:fee', title: '费用核对', text: '费用须核对书面依据。', score: 1 }] : [] });
      if (target.endsWith('/chat/completions')) return modelReply();
      throw new Error('Unexpected synthetic endpoint');
    });
    const service = setup(fetcher, { cloudKnowledge: true }); enableAi(service);
    service.updateSettings({ crm: { baseUrl: 'https://crm.example.com' } });
    await service.loginCrm({ username: 'synthetic', password: 'synthetic' });
    events.length = 0;
    const result = await service.generateDrafts({ ...feeRequest, includeKnowledge: false, remoteConsent: hasHits });
    expect(result.contextSummary?.knowledgeStatus).toBe(hasHits ? 'included' : 'no_match');
    const searchIndex = events.findIndex(url => url === 'https://knowledge.example.com/v1/knowledge/search');
    expect(searchIndex).toBeGreaterThan(-1);
    const modelIndex = events.findIndex(url => url.endsWith('/chat/completions'));
    if (hasHits) expect(modelIndex).toBeGreaterThan(searchIndex);
    else {
      expect(modelIndex).toBe(-1);
      expect(result.model).toContain('本地待核实');
      expect(result.drafts.every(draft => draft.sourceIds.includes('chat:1'))).toBe(true);
    }
  });

  it('does not let a cloud opt-out bypass missing employee authentication', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const service = setup(fetcher, { cloudKnowledge: true }); enableAi(service);
    await expect(service.generateDrafts({ ...feeRequest, includeKnowledge: false })).rejects.toThrow('请先登录公司 CRM');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('automatically connects company cloud after login and never indexes local documents', async () => {
    const version = 'c'.repeat(64);
    const fetcher = vi.fn<typeof fetch>(async url => {
      const target = String(url);
      if (target.endsWith('/auth/login')) return json({ token: 'synthetic' });
      if (target.endsWith('/auth/me')) return json({ user: { id: 1 } });
      if (target.endsWith('/status')) return json({ version, documents: 6, chunks: 6 });
      return json({ version, hits: [{ id: 'kb:fee', title: '付款规则', text: '拍中之后付尾款', sourcePath: 'fees.md', score: 1 }] });
    });
    const service = setup(fetcher, { cloudKnowledge: true });
    await service.initialize();
    expect(service.getSettings().knowledge).toMatchObject({ source: 'cloud', state: 'error' });
    service.updateSettings({ crm: { baseUrl: 'https://crm.example.com' } });
    await service.loginCrm({ username: 'synthetic', password: 'synthetic' });
    expect(service.getSettings().knowledge).toMatchObject({ source: 'cloud', state: 'ready', documents: 6 });
    expect(await service.searchKnowledge('尾款')).toMatchObject([{ text: '拍中之后付尾款' }]);
    await expect(service.createKnowledgeDocument(companyDraft)).rejects.toThrow('云端统一发布');
    service.disconnectCrm();
    await expect(service.searchKnowledge('尾款')).rejects.toThrow('请先登录公司 CRM');
  });
  it.each(['workspace', 'search', 'preview', 'dispatch'] as const)('independently rejects an old approved snapshot after another instance disables it: %s', async (read) => {
    const settingsPath = path.join(knowledgeFolder(), 'integrations.json');
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => modelReply());
    const first = setup(fetcher, { secure: true, settingsPath }); enableAi(first); await first.initialize();
    const draft = await first.createKnowledgeDocument(companyDraft);
    const approved = await first.setKnowledgeDocumentStatus({ id: draft.id, expectedRevision: draft.revision, status: 'approved' });
    const preview = await first.previewDrafts(feeRequest);
    expect(preview.sources.some((source) => source.id.startsWith('kb:'))).toBe(true);
    const second = setup(fetcher, { secure: true, settingsPath }); await second.initialize();
    await second.setKnowledgeDocumentStatus({ id: approved.id, expectedRevision: approved.revision, status: 'disabled' });
    expect(second.searchKnowledge('服务费用')).toEqual([]);
    if (read === 'workspace') expect(() => first.getKnowledgeWorkspace()).toThrow('重新打开软件');
    if (read === 'search') expect(() => first.searchKnowledge('服务费用')).toThrow('重新打开软件');
    if (read === 'preview') await expect(first.previewDrafts(feeRequest)).rejects.toThrow('重新打开软件');
    if (read === 'dispatch') await expect(first.generatePreview(preview, true)).rejects.toThrow('重新打开软件');
    expect(first.getSettings().knowledge).toMatchObject({ state: 'error', documents: 0, chunks: 0 });
    expect(first.getSettings().knowledge.warnings.join('')).toContain('旧知识引用已停用');
    await expect(first.generatePreview(preview, true)).rejects.toThrow('重新打开软件');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects an in-flight reply when another instance changes the repository before the result returns', async () => {
    const settingsPath = path.join(knowledgeFolder(), 'integrations.json');
    const pending = Promise.withResolvers<Response>(); const fetcher = vi.fn<typeof fetch>().mockReturnValue(pending.promise);
    const first = setup(fetcher, { secure: true, settingsPath }); enableAi(first);
    const draft = await first.createKnowledgeDocument(companyDraft);
    const approved = await first.setKnowledgeDocumentStatus({ id: draft.id, expectedRevision: draft.revision, status: 'approved' });
    const preview = await first.previewDrafts(feeRequest);
    const generating = first.generatePreview(preview, true);
    expect(fetcher).toHaveBeenCalledOnce();
    const second = setup(fetcher, { secure: true, settingsPath }); await second.initialize();
    await second.setKnowledgeDocumentStatus({ id: approved.id, expectedRevision: approved.revision, status: 'disabled' });
    pending.resolve(modelReply());
    await expect(generating).rejects.toThrow('重新打开软件');
    expect(first.getSettings().knowledge).toMatchObject({ state: 'error', documents: 0, chunks: 0 });
  });

  it('does not block chat-only drafts when a different instance changed the unused knowledge repository', async () => {
    const settingsPath = path.join(knowledgeFolder(), 'integrations.json');
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => modelReply());
    const first = setup(fetcher, { secure: true, settingsPath }); enableAi(first);
    const draft = await first.createKnowledgeDocument(companyDraft);
    const approved = await first.setKnowledgeDocumentStatus({ id: draft.id, expectedRevision: draft.revision, status: 'approved' });
    const preview = await first.previewDrafts({ ...feeRequest, includeKnowledge: false });
    const second = setup(fetcher, { secure: true, settingsPath }); await second.initialize();
    await second.setKnowledgeDocumentStatus({ id: approved.id, expectedRevision: approved.revision, status: 'disabled' });
    expect(() => first.getKnowledgeWorkspace()).toThrow('重新打开软件');
    await expect(first.generatePreview(preview, true)).resolves.toMatchObject({ model: 'test-model' });
    const next = await first.previewDrafts({ ...feeRequest, includeKnowledge: false });
    expect(next.sources.every((source) => !source.id.startsWith('kb:'))).toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(String(fetcher.mock.calls[0][1]?.body)).not.toContain('本机资料/');
  });

  it('keeps the local inbox empty on startup and refuses plaintext fallback when encryption is unavailable', async () => {
    const fetcher = vi.fn<typeof fetch>(); const service = setup(fetcher);
    await service.initialize();
    expect(service.getKnowledgeWorkspace()).toMatchObject({ documents: [], counts: { total: 0 } });
    await expect(service.createKnowledgeDocument(companyDraft)).rejects.toThrow(/加密|安全存储/);
    expect(service.getKnowledgeWorkspace().documents).toEqual([]);
    expect(service.getSettings().knowledge.documents).toBe(0);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('publishes only the explicitly approved revision through the existing knowledge index', async () => {
    const fetcher = vi.fn<typeof fetch>(); const service = setup(fetcher, { secure: true }); enableAi(service);
    const draft = await service.createKnowledgeDocument(companyDraft);
    expect(draft.status).toBe('draft');
    expect(service.getKnowledgeWorkspace().documents[0]).not.toHaveProperty('body');
    expect(service.getKnowledgeDocument(draft.id).body).toBe(companyDraft.body);
    expect(service.searchKnowledge('服务费怎么收')).toEqual([]);
    const approved = await service.setKnowledgeDocumentStatus({ id: draft.id, expectedRevision: draft.revision, status: 'approved' });
    expect(approved.status).toBe('approved');
    const preview = await service.previewDrafts(feeRequest);
    expect(preview.sources.filter((source) => source.id.startsWith('kb:'))).toEqual([expect.objectContaining({ text: expect.stringContaining(companyDraft.body), sourcePath: expect.stringContaining('本机资料/') })]);
    const revised = await service.saveKnowledgeDocument({ id: approved.id, expectedRevision: approved.revision, ...companyDraft, body: '服务费用应依据更新后审核的合同。' });
    expect(revised.status).toBe('draft');
    expect(service.searchKnowledge('服务费怎么收')).toEqual([]);
    await expect(service.generatePreview(preview, true)).rejects.toThrow(/知识.*失效|知识.*变化|知识.*不再/);
    await expect(service.setKnowledgeDocumentStatus({ id: approved.id, expectedRevision: approved.revision, status: 'approved' })).rejects.toThrow(/版本|更新|修订/);
    expect(service.getKnowledgeDocument(draft.id).body).toBe(revised.body);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('revokes disabled material immediately and restoring it to draft does not publish it', async () => {
    const fetcher = vi.fn<typeof fetch>(); const service = setup(fetcher, { secure: true }); enableAi(service);
    const draft = await service.createKnowledgeDocument(companyDraft);
    const approved = await service.setKnowledgeDocumentStatus({ id: draft.id, expectedRevision: draft.revision, status: 'approved' });
    const preview = await service.previewDrafts(feeRequest);
    const disabled = await service.setKnowledgeDocumentStatus({ id: approved.id, expectedRevision: approved.revision, status: 'disabled' });
    expect(service.searchKnowledge('服务费怎么收')).toEqual([]);
    await expect(service.generatePreview(preview, true)).rejects.toThrow();
    await expect(service.setKnowledgeDocumentStatus({ id: disabled.id, expectedRevision: disabled.revision, status: 'approved' })).rejects.toThrow();
    const restored = await service.setKnowledgeDocumentStatus({ id: disabled.id, expectedRevision: disabled.revision, status: 'draft' });
    expect(restored.status).toBe('draft'); expect(service.searchKnowledge('服务费怎么收')).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('merges local approvals with external material on startup and detaches only the external folder', async () => {
    const settingsPath = path.join(knowledgeFolder(), 'integration.json');
    const external = knowledgeFolder(); writeFileSync(path.join(external, 'loan.md'), '# 贷款资格\n贷款资格应先核实。');
    const fetcher = vi.fn<typeof fetch>();
    const service = setup(fetcher, { secure: true, settingsPath });
    const draft = await service.createKnowledgeDocument(companyDraft);
    await service.setKnowledgeDocumentStatus({ id: draft.id, expectedRevision: draft.revision, status: 'approved' });
    await service.indexKnowledge(external);
    expect(service.getSettings().knowledge.documents).toBe(2);
    const reopened = setup(fetcher, { secure: true, settingsPath }); await reopened.initialize();
    expect(reopened.getSettings().knowledge.documents).toBe(2);
    await reopened.clearKnowledge();
    expect(reopened.getSettings().knowledge).toMatchObject({ folderPath: '', documents: 1 });
    expect(reopened.searchKnowledge('贷款资格')).toEqual([]);
    expect(reopened.searchKnowledge('服务费用')).toHaveLength(1);
    expect(reopened.getKnowledgeDocument(draft.id).status).toBe('approved');
    const secondReopen = setup(fetcher, { secure: true, settingsPath }); await secondReopen.initialize();
    expect(secondReopen.getSettings().knowledge).toMatchObject({ folderPath: '', documents: 1 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('imports selected files as unapproved copies without publishing source frontmatter', async () => {
    const source = path.join(knowledgeFolder(), 'fee.md');
    writeFileSync(source, '---\nstatus: approved\n---\n# 服务费用\n服务费用以书面合同为准。');
    const fetcher = vi.fn<typeof fetch>(); const service = setup(fetcher, { secure: true });
    const result = await service.importKnowledgeDocuments([source]);
    expect(result.imported).toHaveLength(1);
    expect(result.imported[0]).toMatchObject({ status: 'draft', sourceKind: 'file', sourceName: 'fee.md' });
    expect(JSON.stringify(result)).not.toContain(path.dirname(source));
    expect(service.searchKnowledge('服务费用')).toEqual([]);
    expect((await service.importKnowledgeDocuments([source])).imported).toHaveLength(0);
    expect(service.getKnowledgeWorkspace().counts.total).toBe(1);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('blocks old knowledge during a pending import and rejects concurrent knowledge changes', async () => {
    const fetcher = vi.fn<typeof fetch>(); const service = setup(fetcher, { secure: true }); enableAi(service);
    const draft = await service.createKnowledgeDocument(companyDraft);
    await service.setKnowledgeDocumentStatus({ id: draft.id, expectedRevision: draft.revision, status: 'approved' });
    const pending = Promise.withResolvers<KnowledgeImportResult>();
    const importFiles = vi.spyOn(KnowledgeRepository.prototype, 'importFiles').mockReturnValueOnce(pending.promise);
    const importing = service.importKnowledgeDocuments([]);
    expect(importFiles).toHaveBeenCalledOnce();
    expect(service.getSettings().knowledge).toMatchObject({ state: 'indexing', documents: 0, chunks: 0 });
    expect(() => service.searchKnowledge('服务费用')).toThrow('知识库正在');
    await expect(service.previewDrafts(feeRequest)).rejects.toThrow('知识库正在');
    await expect(service.createKnowledgeDocument(companyDraft)).rejects.toThrow('另一项变更');
    await expect(service.clearKnowledge()).rejects.toThrow('另一项变更');
    expect((await service.previewDrafts({ ...feeRequest, includeKnowledge: false })).sources.some((source) => source.id.startsWith('kb:'))).toBe(false);
    pending.resolve({ imported: [], skipped: [] }); await importing;
    expect(service.getSettings().knowledge).toMatchObject({ state: 'ready', documents: 1, chunks: 1 });
    expect(service.searchKnowledge('服务费用')).toHaveLength(1);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('cancels the active local import on dispose and never returns its late result', async () => {
    const fetcher = vi.fn<typeof fetch>(); const service = setup(fetcher, { secure: true });
    const pending = Promise.withResolvers<KnowledgeImportResult>();
    const importFiles = vi.spyOn(KnowledgeRepository.prototype, 'importFiles').mockReturnValueOnce(pending.promise);
    const importing = service.importKnowledgeDocuments([]);
    const signal = importFiles.mock.calls[0][1]?.signal;
    expect(signal?.aborted).toBe(false);
    service.dispose(); expect(signal?.aborted).toBe(true);
    pending.resolve({ imported: [], skipped: [] });
    await expect(importing).rejects.toThrow('服务已停止');
    expect(() => service.getKnowledgeWorkspace()).toThrow('服务已停止');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reports saved material separately from a failed index and recovers without creating it twice', async () => {
    const fetcher = vi.fn<typeof fetch>(); const service = setup(fetcher, { secure: true });
    const index = vi.spyOn(KnowledgeLibrary.prototype, 'index').mockRejectedValueOnce(new Error('synthetic index failure'));
    await expect(service.createKnowledgeDocument(companyDraft)).rejects.toThrow('资料已保存或更新，但索引未完成');
    expect(service.getKnowledgeWorkspace().documents).toEqual([expect.objectContaining({ title: companyDraft.title, status: 'draft' })]);
    expect(service.getSettings().knowledge.warnings.join('')).toContain('索引未完成');
    expect(service.getSettings().knowledge).toMatchObject({ state: 'error', documents: 0, chunks: 0 });
    expect(() => service.searchKnowledge('服务费用')).toThrow('知识库整理失败');
    index.mockRestore();
    await service.indexKnowledge('');
    expect(service.getKnowledgeWorkspace().counts.total).toBe(1);
    expect(service.getSettings().knowledge.warnings.join('')).not.toContain('索引未完成');
    expect(service.searchKnowledge('服务费用')).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('drops an in-flight model reply when its approved local source is revised', async () => {
    const pending = Promise.withResolvers<Response>(); const fetcher = vi.fn<typeof fetch>().mockReturnValue(pending.promise);
    const service = setup(fetcher, { secure: true }); enableAi(service);
    const draft = await service.createKnowledgeDocument(companyDraft);
    const approved = await service.setKnowledgeDocumentStatus({ id: draft.id, expectedRevision: draft.revision, status: 'approved' });
    const preview = await service.previewDrafts(feeRequest);
    const generating = service.generatePreview(preview, true);
    expect(fetcher).toHaveBeenCalledOnce();
    await service.saveKnowledgeDocument({ ...companyDraft, id: approved.id, expectedRevision: approved.revision, body: '费用说明修订后需要重新审核。' });
    pending.resolve(modelReply());
    await expect(generating).rejects.toThrow(/知识.*失效|知识.*变化|知识.*不再/);
  });

  it('rejects a cached reference after Beijing midnight even within the preview window', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-08-31T23:59:30+08:00'));
    const folder = knowledgeFolder();
    writeFileSync(path.join(folder, 'fee.md'), '---\nstatus: approved\nexpiry: 2026-08-31\n---\n# 服务费用\n服务费用以书面合同为准。');
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => modelReply());
    const service = setup(fetcher); enableAi(service); await service.indexKnowledge(folder);
    const preview = await service.previewDrafts(feeRequest);
    expect(preview.sources.some((source) => source.id.startsWith('kb:'))).toBe(true);
    clock.mockReturnValue(Date.parse('2026-09-01T00:00:30+08:00'));
    await expect(service.generatePreview(preview, true)).rejects.toThrow(/知识.*过期|知识.*失效/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not create a knowledge preview from old chunks while an asynchronous rebuild is running', async () => {
    const folder = knowledgeFolder(); writeFileSync(path.join(folder, 'fee.md'), '# 服务费用\n服务费用以书面合同为准。');
    const fetcher = vi.fn<typeof fetch>(); const service = setup(fetcher); enableAi(service); await service.indexKnowledge(folder);
    const rebuilding = service.indexKnowledge(folder);
    const preview = service.previewDrafts(feeRequest);
    try { await expect(preview).rejects.toThrow('知识库正在'); }
    finally { await rebuilding; }
    expect((await service.previewDrafts(feeRequest)).sources.some((source) => source.id.startsWith('kb:'))).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not block a request without knowledge citations during or after a failed rebuild', async () => {
    const folder = knowledgeFolder(); writeFileSync(path.join(folder, 'fee.md'), '# 服务费用\n服务费用以书面合同为准。');
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => modelReply());
    const service = setup(fetcher); enableAi(service); await service.indexKnowledge(folder);
    const preview = await service.previewDrafts({ ...feeRequest, includeKnowledge: false });
    const rebuilding = service.indexKnowledge(folder);
    const generating = service.generatePreview(preview, true);
    await rebuilding;
    await expect(generating).resolves.toMatchObject({ model: 'test-model' });
    await expect(service.indexKnowledge(path.join(folder, 'not-a-directory'))).rejects.toThrow();
    await expect(service.generateDrafts({ ...feeRequest, includeKnowledge: false })).resolves.toMatchObject({ model: 'test-model' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('prioritizes the latest customer question over old outgoing invitation scripts', async () => {
    const folder = knowledgeFolder();
    writeFileSync(path.join(folder, 'fee.md'), '# 服务费用\n服务费用以书面合同为准。');
    writeFileSync(path.join(folder, 'visit.md'), '# 到店预约\n到公司了解法拍流程，先核对接待安排和准确地址。');
    const service = setup(vi.fn()); enableAi(service); await service.indexKnowledge(folder);
    const search = vi.spyOn(KnowledgeLibrary.prototype, 'search');
    const preview = await service.previewDrafts({ ...feeRequest, messages: [
      { ...request.messages[0], id: 'old', text: '公司地址在哪里？' },
      { ...request.messages[0], id: 'outgoing', direction: 'outgoing', text: '到公司了解法拍流程、费用和风险。先核对接待安排。'.repeat(15) },
      { ...request.messages[0], id: 'latest', text: '服务费怎么收？' },
    ] });
    expect(search.mock.calls[0][0]).toBe('服务费怎么收？');
    expect(preview.sources.filter((source) => source.id.startsWith('kb:')).map((source) => source.sourcePath)).toEqual(['fee.md']);
  });

  it('keeps an explicit query authoritative even when current customer text differs', async () => {
    const service = setup(vi.fn()); enableAi(service);
    const search = vi.spyOn(KnowledgeLibrary.prototype, 'search');
    await service.previewDrafts({ ...feeRequest, query: '用户明确选择的核实问题' });
    expect(search.mock.calls.map(([query]) => query)).toEqual(['用户明确选择的核实问题']);
  });

  it('borrows short adjacent customer context for a dependent latest question', async () => {
    const folder = knowledgeFolder(); writeFileSync(path.join(folder, 'loan.md'), '# 贷款资格\n贷款资格应先核实。');
    const service = setup(vi.fn()); enableAi(service); await service.indexKnowledge(folder);
    const search = vi.spyOn(KnowledgeLibrary.prototype, 'search');
    const preview = await service.previewDrafts({ ...feeRequest, messages: [
      { ...request.messages[0], id: 'outgoing', direction: 'outgoing', text: '周六到公司来了解' },
      { ...request.messages[0], id: 'topic', text: '贷款资格' },
      { ...request.messages[0], id: 'latest', text: '那这个呢？' },
    ] });
    expect(search.mock.calls.map(([query]) => query)).toEqual(['那这个呢？', '贷款']);
    expect(preview.sources.find((source) => source.id.startsWith('kb:'))?.sourcePath).toBe('loan.md');
  });

  it('retrieves evidence for multiple unanswered customer questions even when the last question already matches', async () => {
    const folder = knowledgeFolder();
    writeFileSync(path.join(folder, 'fee.md'), '# 服务费\n服务费用以合同约定为准。');
    writeFileSync(path.join(folder, 'loan.md'), '# 贷款资格\n贷款资格需先核实金融审核结果。');
    const service = setup(vi.fn()); enableAi(service); await service.indexKnowledge(folder);
    const search = vi.spyOn(KnowledgeLibrary.prototype, 'search');
    const preview = await service.previewDrafts({ ...feeRequest, messages: [
      { ...request.messages[0], id: 'outgoing', direction: 'outgoing', text: '您好，有什么想了解的？' },
      { ...request.messages[0], id: 'fee', text: '服务费怎么收？' },
      { ...request.messages[0], id: 'loan', text: '贷款资格怎么审核？' },
    ] });
    expect(search.mock.calls.map(([query]) => query)).toEqual(['贷款资格怎么审核？', '服务费']);
    expect(preview.sources.filter((source) => source.id.startsWith('kb:')).map((source) => source.sourcePath)).toEqual(expect.arrayContaining(['loan.md', 'fee.md']));
    expect(preview.contextSummary).toMatchObject({ focus: '贷款资格怎么审核？', chatMessages: 3, knowledgeHits: 2, knowledgeStatus: 'included', knowledgeQueries: ['贷款资格怎么审核？', '服务费'] });
  });

  it.each(['另外', '还有'])('keeps fee and refund questions independent when the latest starts with %s and names a new subject', async (prefix) => {
    const folder = knowledgeFolder();
    writeFileSync(path.join(folder, 'fee.md'), '# 服务费\n服务费用以合同约定为准。');
    writeFileSync(path.join(folder, 'refund.md'), '# 退款\n退款条件以书面规则为准。');
    writeFileSync(path.join(folder, 'loan.md'), '# 贷款审核\n贷款审核需要准备征信报告与银行流水。');
    const service = setup(vi.fn()); enableAi(service); await service.indexKnowledge(folder);
    const search = vi.spyOn(KnowledgeLibrary.prototype, 'search');
    const preview = await service.previewDrafts({ ...feeRequest, messages: [
      { ...request.messages[0], id: 'fee', text: '服务费怎么收？' },
      { ...request.messages[0], id: 'refund', text: '退款条件是什么？' },
      { ...request.messages[0], id: 'loan', text: `${prefix}贷款审核需要哪些材料？` },
    ] });
    expect(search.mock.calls.map(([query]) => query)).toEqual([`${prefix}贷款审核需要哪些材料？`, '退款', '服务费']);
    expect(preview.sources.filter((source) => source.id.startsWith('kb:')).map((source) => source.sourcePath)).toEqual(expect.arrayContaining(['loan.md', 'refund.md', 'fee.md']));
  });

  it('does not append unrelated personal details from earlier incoming messages to a knowledge query', async () => {
    const service = setup(vi.fn()); enableAi(service);
    const search = vi.spyOn(KnowledgeLibrary.prototype, 'search');
    await service.previewDrafts({ ...feeRequest, messages: [
      { ...request.messages[0], id: 'identity', text: '我叫测试客户，手机是 13800000000，身份证 110101199001010000，邮箱 synthetic@example.invalid' },
      { ...request.messages[0], id: 'latest', text: '服务费怎么收？' },
    ] });
    expect(search.mock.calls.map(([query]) => query)).toEqual(['服务费怎么收？']);
  });

  it.each([false, true])('redacts obvious identifiers from knowledge questions, including explicit overrides (%s)', async (explicit) => {
    const service = setup(vi.fn()); enableAi(service);
    const search = vi.spyOn(KnowledgeLibrary.prototype, 'search');
    const question = '手机13800000000，电话0571-88888888，身份证110101199001010000，邮箱synthetic@example.invalid，预算300万，服务费怎么收？';
    const preview = await service.previewDrafts({ ...feeRequest, ...(explicit ? { query: question } : { messages: [{ ...request.messages[0], text: question }] }) });
    const queries = search.mock.calls.map(([query]) => query);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain('服务费怎么收？');
    expect(queries[0]).toContain('预算300万');
    expect(queries[0]).not.toMatch(/13800000000|0571-88888888|110101199001010000|synthetic@example.invalid/);
    expect(preview.contextSummary?.knowledgeQueries).toEqual(queries);
  });

  it('does not borrow an obsolete earlier topic when a short follow-up names its own subject', async () => {
    const service = setup(vi.fn()); enableAi(service);
    const search = vi.spyOn(KnowledgeLibrary.prototype, 'search');
    await service.previewDrafts({ ...feeRequest, messages: [
      { ...request.messages[0], id: 'old', text: '贷款需要哪些材料？' },
      { ...request.messages[0], id: 'outgoing', direction: 'outgoing', text: '贷款问题已经说明。' },
      { ...request.messages[0], id: 'latest', text: '那服务费怎么收？' },
    ] });
    expect(search.mock.calls.map(([query]) => query)).toEqual(['那服务费怎么收？']);
  });

  it('resolves a short follow-up across an outgoing turn using customer topic labels instead of our sales scripts', async () => {
    const folder = knowledgeFolder(); writeFileSync(path.join(folder, 'loan.md'), '# 贷款资格\n贷款资格需先核实。');
    const service = setup(vi.fn()); enableAi(service); await service.indexKnowledge(folder);
    const search = vi.spyOn(KnowledgeLibrary.prototype, 'search');
    const preview = await service.previewDrafts({ ...feeRequest, messages: [
      { ...request.messages[0], id: 'topic', text: '贷款资格怎么审核？' },
      { ...request.messages[0], id: 'outgoing', direction: 'outgoing', text: '请到公司来了解我们服务流程。' },
      { ...request.messages[0], id: 'latest', text: '那这个需要哪些材料？' },
    ] });
    expect(search.mock.calls.map(([query]) => query)).toEqual(['那这个需要哪些材料？', '贷款']);
    expect(preview.sources.some((source) => source.sourcePath === 'loan.md')).toBe(true);
    expect(JSON.stringify(search.mock.calls)).not.toContain('请到公司');
  });

  it('uses only topic labels from explicitly bound CRM for an otherwise ambiguous follow-up', async () => {
    const folder = knowledgeFolder(); writeFileSync(path.join(folder, 'loan.md'), '# 贷款资格\n贷款资格需先核实。');
    const service = setup(vi.fn()); enableAi(service); await service.indexKnowledge(folder);
    const crm: CrmCustomerContext = { customer: { id: 7, name: 'private-name', phone: 'private-phone', loanRemark: '贷款审批待核实' },
      followups: [{ content: 'private-followup 客户此前咨询贷款' }], calls: [], tasks: [], houseTargets: [], fetchedAt: 'now', sourceBaseUrl: 'https://crm.example', availability: { calls: 'available', followups: 'available' } };
    vi.spyOn(service, 'getCrmContext').mockResolvedValue(crm);
    const search = vi.spyOn(KnowledgeLibrary.prototype, 'search');
    const preview = await service.previewDrafts({ ...feeRequest, crmCustomerId: 7, messages: [{ ...request.messages[0], text: '那需要哪些材料？' }] });
    expect(search.mock.calls.map(([query]) => query)).toEqual(['那需要哪些材料？', '贷款']);
    expect(JSON.stringify(search.mock.calls)).not.toMatch(/private-name|private-phone|private-followup|审批待核实/);
    expect(preview.contextSummary).toMatchObject({ crmRecords: 2, knowledgeHits: 1 });
    search.mockClear();
    await service.previewDrafts({ ...feeRequest, crmCustomerId: 7 });
    expect(search.mock.calls.map(([query]) => query)).toEqual(['服务费怎么收？']);
  });

  it('skips greetings and unrecognized media and bounds the last effective customer query', async () => {
    const service = setup(vi.fn()); enableAi(service);
    const search = vi.spyOn(KnowledgeLibrary.prototype, 'search');
    const text = '贷款资格'.repeat(500);
    await service.previewDrafts({ ...feeRequest, messages: [
      { ...request.messages[0], id: 'effective', text },
      { ...request.messages[0], id: 'ack', text: '好的，谢谢' },
      { ...request.messages[0], id: 'image', text: '[图片]' },
    ] });
    expect(search.mock.calls[0][0]).toBe(text.slice(0, 600));
    expect(search.mock.calls[0][0].length).toBeLessThanOrEqual(600);
  });

  it('discards an in-flight result if referenced knowledge expires before it returns', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-08-31T23:59:30+08:00'));
    const folder = knowledgeFolder(); writeFileSync(path.join(folder, 'fee.md'), '---\nstatus: approved\nexpiry: 2026-08-31\n---\n# 服务费用\n服务费用以书面合同为准。');
    const pending = Promise.withResolvers<Response>();
    const fetcher = vi.fn<typeof fetch>().mockReturnValue(pending.promise);
    const service = setup(fetcher); enableAi(service); await service.indexKnowledge(folder);
    const preview = await service.previewDrafts(feeRequest);
    const result = service.generatePreview(preview, true);
    expect(fetcher).toHaveBeenCalledOnce();
    clock.mockReturnValue(Date.parse('2026-09-01T00:00:30+08:00'));
    pending.resolve(modelReply());
    await expect(result).rejects.toThrow('知识库引用已过期');
  });

  it('does not auto-login or contact any network on startup', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const service = setup(fetcher);
    await service.initialize();
    expect(service.getSettings().crm.hasSession).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('keeps credentials main-side and clears them on disconnect', async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) => String(url).endsWith('/login') ? json({ token: 'private-token' }) : json({ user: { id: 1, name: 'tester' } }));
    const service = setup(fetcher);
    service.updateSettings({ crm: { baseUrl: 'https://crm.example' } });
    expect(await service.loginCrm({ username: 'tester', password: 'private-password' })).toMatchObject({ kind: 'authenticated', user: { id: 1 } });
    expect(service.getSettings().crm.hasSession).toBe(true);
    expect(JSON.stringify(service.getSettings())).not.toMatch(/private-token|private-password/);
    expect(service.disconnectCrm().crm.hasSession).toBe(false);
    await expect(service.testCrm()).rejects.toThrow('请先登录');
  });

  it('only verifies the challenge established in the current connection', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ code: 'DEVICE_VERIFICATION_REQUIRED', challengeId: 12, expiresAt: 'future' }, 403));
    const service = setup(fetcher);
    service.updateSettings({ crm: { baseUrl: 'https://crm.example' } });
    expect(await service.loginCrm({ username: 'tester', password: 'password' })).toMatchObject({ kind: 'verification-required' });
    await expect(service.verifyCrmDevice(99, '123456')).rejects.toThrow('失效');
    service.disconnectCrm();
    await expect(service.verifyCrmDevice(12, '123456')).rejects.toThrow('失效');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('discards a late old-account token after CRM settings change', async () => {
    let finish: (value: Response) => void = () => undefined;
    const fetcher = vi.fn<typeof fetch>(() => new Promise<Response>((resolve) => { finish = resolve; }));
    const service = setup(fetcher);
    service.updateSettings({ crm: { baseUrl: 'https://old.example' } });
    const login = service.loginCrm({ username: 'old-user', password: 'password' });
    service.updateSettings({ crm: { baseUrl: 'https://new.example', username: 'new-user' } });
    finish(json({ token: 'old-account-token' }));
    await expect(login).rejects.toThrow('旧请求结果已丢弃');
    expect(service.getSettings().crm.hasSession).toBe(false);
  });

  it('previews without a model request and never auto-associates CRM by nickname', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const service = setup(fetcher);
    enableAi(service);
    const preview = await service.previewDrafts(request);
    expect(preview.sources[0].text).toBe('需要先了解流程');
    expect(preview.warnings.join('')).toContain('未附带已确认关联');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('serializes model calls instead of starting an unbounded queue', async () => {
    let finish: (value: Response) => void = () => undefined;
    const fetcher = vi.fn<typeof fetch>(() => new Promise<Response>((resolve) => { finish = resolve; }));
    const service = setup(fetcher);
    enableAi(service);
    const first = service.testAi();
    await expect(service.testAi()).rejects.toThrow('已有一项');
    finish(json({ choices: [{ message: { content: '{"ok":true}' } }] }));
    await first;
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not send a prompt to an old model endpoint after settings change', async () => {
    let finishCustomer: (value: Response) => void = () => undefined;
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      if (String(url).endsWith('/login')) return json({ token: 'token' });
      if (String(url).endsWith('/me')) return json({ user: { id: 1 } });
      if (String(url).endsWith('/customers/1')) return new Promise<Response>((resolve) => { finishCustomer = resolve; });
      if (String(url).endsWith('/followups')) return json({ followups: [] });
      if (String(url).endsWith('/calls')) return json({ calls: [] });
      throw new Error('The model must not be called');
    });
    const service = setup(fetcher);
    service.updateSettings({ crm: { baseUrl: 'https://crm.example' } });
    await service.loginCrm({ username: 'test', password: 'pass' });
    enableAi(service);
    const generating = service.generateDrafts({ ...request, crmCustomerId: 1 });
    service.updateSettings({ ai: { allowRemote: false } });
    finishCustomer(json({ customer: { id: 1, name: 'test' } }));
    await expect(generating).rejects.toThrow('配置已变更');
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('/chat/completions'))).toBe(false);
  });

  it('does not silently ignore a forbidden confirmed CRM account', async () => {
    const service = setup(vi.fn<typeof fetch>());
    enableAi(service);
    await expect(service.generateDrafts({ ...request, crmCustomerId: 42 })).rejects.toThrow('CRM');
  });

  it.each([
    ['customers', (service: IntegrationService) => service.listCrmCustomers({}), '/api/customers', { customers: [], total: 0, page: 1, limit: 50 }],
    ['tasks', (service: IntegrationService) => service.listCrmTasks({}), '/api/tasks', { tasks: [] }],
    ['dashboard', (service: IntegrationService) => service.getCrmWorkspaceOverview(), '/api/dashboard', {
      stats: { totalCustomers: 0, todayTasks: 0, overdueTasks: 0, monthNew: 0, todayNew: 0, weekVisited: 0, monthVisited: 0, monthDeal: 0 },
      today: [], overdue: [], future: [], priorityCustomers: [], staleCustomers: [], staleCount: 0, levelStats: [], workTrend: [],
    }],
  ] as const)('discards late %s results when the configured CRM account changes', async (_name, read, endpoint, payload) => {
    let finish: (value: Response) => void = () => undefined;
    const started = Promise.withResolvers<void>();
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname.endsWith('/login')) return json({ token: 'old-account-session' });
      if (pathname.endsWith('/me')) return json({ user: { id: 1, role: 'admin', permissions: ['*'] } });
      if (pathname === endpoint) return new Promise<Response>((resolve) => { finish = resolve; started.resolve(); });
      throw new Error('Unexpected test URL');
    });
    const service = setup(fetcher);
    service.updateSettings({ crm: { baseUrl: 'https://old.example' } });
    await service.loginCrm({ username: 'old-user', password: 'password' });
    const reading = read(service);
    await started.promise;
    service.updateSettings({ crm: { baseUrl: 'https://new.example', username: 'new-user' } });
    finish(json(payload));
    await expect(reading).rejects.toThrow('旧请求结果已丢弃');
    expect(service.getSettings().crm.hasSession).toBe(false);
  });

  it('requires existing user-configured authorization for every workspace read', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const service = setup(fetcher);
    await expect(service.listCrmCustomers({})).rejects.toThrow('请先配置');
    await expect(service.listCrmTasks({})).rejects.toThrow('请先配置');
    await expect(service.getCrmWorkspaceOverview()).rejects.toThrow('请先配置');
    service.updateSettings({ crm: { baseUrl: 'https://crm.example' } });
    await expect(service.listCrmCustomers({})).rejects.toThrow('请先登录');
    await expect(service.listCrmTasks({})).rejects.toThrow('请先登录');
    await expect(service.getCrmWorkspaceOverview()).rejects.toThrow('请先登录');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
