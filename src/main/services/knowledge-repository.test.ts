import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KnowledgeDocument, KnowledgeDraftInput } from '../../shared/knowledge-workspace-contracts';
import type { SecretStorage } from './integration-settings';
import { KnowledgeRepository } from './knowledge-repository';

const roots: string[] = [];
function fixture(secrets?: SecretStorage) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'lingxu-knowledge-inbox-test-')); roots.push(root);
  const file = path.join(root, 'company-knowledge.enc.json');
  const crypto: SecretStorage = secrets ?? {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value, 'utf8').reverse(),
    decryptString: (value) => Buffer.from(value).reverse().toString('utf8'),
  };
  return { root, file, crypto, repository: new KnowledgeRepository(file, crypto) };
}
const draft: KnowledgeDraftInput = { title: '服务费用说明', body: '费用项目以经审核的书面合同为准。', expiry: null };
const version = (document: KnowledgeDocument) => ({ id: document.id, expectedRevision: document.revision });
const serializedLimit = 21 * 1024 * 1024;
const backslash = String.fromCharCode(92);
const escapedBody = (index: number) => `${String(index).padStart(3, '0')}: ${backslash.repeat(199_000)}`;
const fileHash = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
function escapedFixture(includeEditable: boolean) {
  const test = fixture();
  const base = test.repository.createDraft(draft);
  const documents = Array.from({ length: 55 }, (_, index) => ({ ...base, id: randomUUID(), body: escapedBody(index) }));
  if (includeEditable) documents.push({ ...base, id: randomUUID(), body: '待修订的较短资料' });
  const payload = JSON.stringify({ version: 1, documents });
  expect(Buffer.byteLength(payload, 'utf8')).toBeLessThan(serializedLimit);
  writeFileSync(test.file, JSON.stringify({ version: 1, encrypted: test.crypto.encryptString(payload).toString('base64') }));
  return { ...test, documents, repository: new KnowledgeRepository(test.file, test.crypto) };
}
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('KnowledgeRepository', () => {
  it('starts empty without keys, login, models or creating a file', () => {
    const crypto = { isEncryptionAvailable: vi.fn(() => false), encryptString: vi.fn(), decryptString: vi.fn() };
    const { file, repository } = fixture(crypto);
    expect(repository.list()).toEqual({ documents: [], counts: { total: 0, draft: 0, approved: 0, disabled: 0, expired: 0 } });
    expect(repository.approvedDocuments()).toEqual([]);
    expect(existsSync(file)).toBe(false);
    expect(crypto.decryptString).not.toHaveBeenCalled();
    expect(() => repository.createDraft(draft)).toThrow('安全存储');
    expect(existsSync(file)).toBe(false);
  });

  it('persists drafts encrypted and returns defensive copies without bodies in the list', () => {
    const { file, crypto, repository } = fixture();
    const created = repository.createDraft(draft);
    expect(created).toMatchObject({ ...draft, status: 'draft', revision: 1, sourceKind: 'manual', sourceName: null, approvedAt: null });
    expect(readFileSync(file, 'utf8')).not.toContain(draft.body);
    expect(repository.list().documents[0]).toMatchObject({ id: created.id, characters: draft.body.length });
    expect(repository.list().documents[0]).not.toHaveProperty('body');
    created.body = '不能从返回值修改仓库';
    expect(repository.get(created.id).body).toBe(draft.body);
    const reopened = new KnowledgeRepository(file, crypto);
    expect(reopened.get(created.id)).toEqual(repository.get(created.id));
  });

  it('requires approval, retracts the approved version on revision, and makes disable reversible through draft', () => {
    const { repository } = fixture();
    const first = repository.createDraft(draft);
    expect(repository.approvedDocuments()).toEqual([]);
    const approved = repository.setStatus({ ...version(first), status: 'approved' });
    expect(approved.revision).toBe(2);
    expect(approved.approvedAt).not.toBeNull();
    expect(repository.approvedDocuments()).toEqual([{ id: approved.id, revision: 2, ...draft }]);
    const revised = repository.saveDraft({ ...version(approved), ...draft, body: '新版费用需要重新审核。' });
    expect(revised).toMatchObject({ revision: 3, status: 'draft', approvedAt: null });
    expect(repository.approvedDocuments()).toEqual([]);
    const approvedAgain = repository.setStatus({ ...version(revised), status: 'approved' });
    const disabled = repository.setStatus({ ...version(approvedAgain), status: 'disabled' });
    expect(repository.approvedDocuments()).toEqual([]);
    expect(() => repository.setStatus({ ...version(disabled), status: 'approved' })).toThrow('待审核');
    const restored = repository.setStatus({ ...version(disabled), status: 'draft' });
    expect(restored.status).toBe('draft');
    expect(repository.list().counts).toEqual({ total: 1, draft: 1, approved: 0, disabled: 0, expired: 0 });
    expect(repository).not.toHaveProperty('delete');
  });

  it('rejects stale revisions and invalid ids without changing the saved file', () => {
    const { repository, file } = fixture();
    const created = repository.createDraft(draft);
    repository.setStatus({ ...version(created), status: 'approved' });
    const before = readFileSync(file);
    expect(() => repository.saveDraft({ ...version(created), ...draft, body: '过时窗口覆盖' })).toThrow('版本');
    expect(() => repository.setStatus({ ...version(created), status: 'disabled' })).toThrow('版本');
    expect(() => repository.get('../other-file')).toThrow('资料');
    expect(readFileSync(file)).toEqual(before);
  });

  it('enforces real calendar dates and inclusive Beijing expiry on approval and retrieval', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-08-31T23:59:59.999+08:00'));
    const { repository } = fixture();
    for (const expiry of ['2026-02-30', 'tomorrow', '', '2026-8-31']) expect(() => repository.createDraft({ ...draft, expiry })).toThrow('日期');
    const created = repository.createDraft({ ...draft, expiry: '2026-08-31' });
    repository.setStatus({ ...version(created), status: 'approved' });
    expect(repository.approvedDocuments()).toHaveLength(1);
    clock.mockReturnValue(Date.parse('2026-09-01T00:00:00+08:00'));
    expect(repository.approvedDocuments()).toEqual([]);
    expect(repository.list().counts).toMatchObject({ approved: 0, expired: 1 });
    const old = repository.createDraft({ ...draft, title: '过期草稿', body: '过期草稿正文', expiry: '2026-08-31' });
    expect(() => repository.setStatus({ ...version(old), status: 'approved' })).toThrow('过期');
  });

  it('imports approved frontmatter only as a draft copy and never changes the source file', async () => {
    const { root, repository } = fixture();
    const source = path.join(root, '公司费用.md');
    const raw = '\uFEFF---\r\nstatus: approved\r\nexpiry: 2099-12-31\r\n---\r\n# 费用说明\r\n以书面合同为准。';
    writeFileSync(source, raw);
    const result = await repository.importFiles([source]);
    expect(result.skipped).toEqual([]);
    expect(result.imported[0]).toMatchObject({ status: 'draft', sourceKind: 'file', sourceName: '公司费用.md', revision: 1 });
    const saved = repository.get(result.imported[0].id);
    expect(saved.body).toContain('status: approved');
    expect(saved.body).not.toContain('\r');
    expect(saved.expiry).toBeNull();
    expect(repository.approvedDocuments()).toEqual([]);
    expect(readFileSync(source, 'utf8')).toBe(raw);
    expect(JSON.stringify(result)).not.toContain(root);
  });

  it('reports duplicate content and rejected files individually without publishing partial drafts', async () => {
    const { root, repository } = fixture();
    const files = ['first.md', 'same.txt', 'binary.txt', 'voice.mp3', 'credentials.md', 'gbk.txt'];
    const bodies = [draft.body, draft.body, Buffer.from([0, 1, 2]), 'not audio', 'API_SECRET=not-a-real-secret', Buffer.from([0xff, 0xfe])];
    files.forEach((name, index) => writeFileSync(path.join(root, name), bodies[index]));
    const result = await repository.importFiles(files.map((name) => path.join(root, name)));
    expect(result.imported).toHaveLength(1);
    expect(result.skipped).toHaveLength(5);
    expect(result.skipped.find((item) => item.name === 'same.txt')?.error).toContain('重复');
    expect(result.skipped.find((item) => item.name === 'gbk.txt')?.error).toContain('UTF-8');
    expect(repository.list().counts.draft).toBe(1);
    expect(repository.approvedDocuments()).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(root);
  });

  it('rejects truncation, invalid shape, embedded credentials and unsupported import batches', async () => {
    const { repository, root } = fixture();
    expect(() => repository.createDraft({ ...draft, body: 'a'.repeat(200_001) })).toThrow('200000');
    expect(() => repository.createDraft({ ...draft, title: 'a'.repeat(201) })).toThrow('标题');
    expect(() => repository.createDraft({ ...draft, body: 'OPENAI_API_KEY=not-real' })).toThrow('敏感');
    expect(() => repository.createDraft({ ...draft, approved: true } as KnowledgeDraftInput)).toThrow('参数');
    expect(() => repository.createDraft({ ...draft, body: '' })).toThrow('正文');
    await expect(repository.importFiles(Array.from({ length: 21 }, () => path.join(root, 'first.md')))).rejects.toThrow('20');
    await expect(repository.importFiles(['relative.md'])).rejects.toThrow('路径');
    expect(repository.list().counts.total).toBe(0);
  });

  it('never overwrites a corrupt or undecryptable repository', () => {
    const { file, crypto } = fixture();
    writeFileSync(file, 'not-a-repository');
    const before = readFileSync(file);
    const broken = new KnowledgeRepository(file, crypto);
    expect(() => broken.list()).toThrow('未覆盖');
    expect(() => broken.approvedDocuments()).toThrow('未覆盖');
    expect(() => broken.createDraft(draft)).toThrow('未覆盖');
    expect(readFileSync(file)).toEqual(before);
  });

  it.each([
    { id: '../elsewhere' }, { revision: 0 }, { revision: 1.5 }, { expiry: '2026-02-30' },
    { sourceKind: 'crm' }, { sourceKind: 'file', sourceName: 'C:\\private\\file.md' },
    { status: 'approved', approvedAt: null }, { body: 'ACCESS_TOKEN=private-test-marker' },
  ])('rejects invalid stored identities and metadata without repairing the file: %j', (patch) => {
    const { file, crypto, repository } = fixture();
    const document = repository.createDraft(draft);
    const serialized = JSON.stringify({ version: 1, encrypted: crypto.encryptString(JSON.stringify({ version: 1, documents: [{ ...document, ...patch }] })).toString('base64') });
    writeFileSync(file, serialized);
    const reopened = new KnowledgeRepository(file, crypto);
    expect(() => reopened.approvedDocuments()).toThrow('未覆盖');
    expect(() => reopened.createDraft({ ...draft, body: '其他资料正文' })).toThrow('未覆盖');
    expect(readFileSync(file, 'utf8')).toBe(serialized);
  });

  it('does not overwrite an existing repository when decryption is unavailable', () => {
    const { file, crypto, repository } = fixture();
    repository.createDraft(draft);
    const before = readFileSync(file);
    const locked = new KnowledgeRepository(file, { ...crypto, isEncryptionAvailable: () => false });
    expect(() => locked.list()).toThrow('未覆盖');
    expect(() => locked.createDraft(draft)).toThrow('未覆盖');
    expect(readFileSync(file)).toEqual(before);
  });

  it('enforces the 500-document cap without removing old or disabled material', () => {
    const { file, crypto, repository } = fixture();
    const base = repository.createDraft(draft);
    const documents = Array.from({ length: 500 }, (_, index) => ({ ...base, id: randomUUID(), body: `第${index}份费用资料` }));
    writeFileSync(file, JSON.stringify({ version: 1, encrypted: crypto.encryptString(JSON.stringify({ version: 1, documents })).toString('base64') }));
    const full = new KnowledgeRepository(file, crypto);
    const before = readFileSync(file);
    expect(full.list().counts.total).toBe(500);
    expect(() => full.createDraft({ ...draft, body: '第501份新增资料' })).toThrow('500');
    expect(readFileSync(file)).toEqual(before);
  });

  it('enforces total text capacity without silently truncating a document', () => {
    const { file, crypto, repository } = fixture();
    const base = repository.createDraft(draft);
    const documents = Array.from({ length: 34 }, (_, index) => ({ ...base, id: randomUUID(), body: `${index}：${'甲'.repeat(199_990)}` }));
    writeFileSync(file, JSON.stringify({ version: 1, encrypted: crypto.encryptString(JSON.stringify({ version: 1, documents })).toString('base64') }));
    const full = new KnowledgeRepository(file, crypto);
    const before = createHash('sha256').update(readFileSync(file)).digest('hex');
    expect(full.list().counts.total).toBe(34);
    expect(() => full.createDraft({ ...draft, body: '乙'.repeat(200_000) })).toThrow('20MB');
    expect(createHash('sha256').update(readFileSync(file)).digest('hex')).toBe(before);
  });

  // These real encrypted file round-trips cover the full 21 MiB capacity, not
  // response-time performance. Hosted Windows disks need more than 5 seconds.
  it.each(['create', 'revise', 'import'] as const)('rejects escaped JSON capacity before %s can overwrite a reopenable repository', async (operation) => {
    const { root, file, crypto, repository, documents } = escapedFixture(operation === 'revise');
    expect(repository.list().counts.total).toBe(documents.length);
    const before = fileHash(file);
    const encrypt = vi.spyOn(crypto, 'encryptString');
    const body = escapedBody(55);
    if (operation === 'create') {
      expect(() => repository.createDraft({ ...draft, body })).toThrow('序列化');
    } else if (operation === 'revise') {
      const previous = documents.at(-1) as KnowledgeDocument;
      expect(() => repository.saveDraft({ ...version(previous), ...draft, body })).toThrow('序列化');
      expect(repository.get(previous.id).revision).toBe(previous.revision);
    } else {
      const source = path.join(root, 'escaped.md'); writeFileSync(source, body);
      const sourceBefore = fileHash(source);
      const result = await repository.importFiles([source]);
      expect(result.imported).toHaveLength(0);
      expect(result.skipped).toEqual([{ name: 'escaped.md', error: expect.stringContaining('序列化') }]);
      expect(fileHash(source)).toBe(sourceBefore);
    }
    expect(encrypt).not.toHaveBeenCalled();
    expect(fileHash(file)).toBe(before);
    expect(repository.list().counts.total).toBe(documents.length);
    expect(new KnowledgeRepository(file, crypto).list().counts.total).toBe(documents.length);
  }, 20_000);

  it.each(['create', 'revise', 'import'] as const)('reopens a repository saved exactly at serialized capacity through %s', async (operation) => {
    const { root, file, crypto, repository, documents } = escapedFixture(operation === 'revise');
    const previous = documents.at(-1) as KnowledgeDocument;
    const title = operation === 'import' ? 'capacity' : '容量边界资料';
    const candidate: KnowledgeDocument = { ...previous, id: operation === 'revise' ? previous.id : randomUUID(), title, body: 'm',
      revision: operation === 'revise' ? previous.revision + 1 : 1, sourceKind: operation === 'import' ? 'file' : 'manual', sourceName: operation === 'import' ? 'capacity.md' : null };
    const next = operation === 'revise' ? [...documents.slice(0, -1), candidate] : [...documents, candidate];
    const remainingBytes = serializedLimit - Buffer.byteLength(JSON.stringify({ version: 1, documents: next }), 'utf8');
    candidate.body += backslash.repeat(Math.floor(remainingBytes / 2)) + (remainingBytes % 2 ? 'a' : '');
    expect(candidate.body.length).toBeLessThan(200_000);
    expect(Buffer.byteLength(JSON.stringify({ version: 1, documents: next }), 'utf8')).toBe(serializedLimit);
    let savedId: string;
    if (operation === 'create') savedId = repository.createDraft({ title, body: candidate.body, expiry: null }).id;
    else if (operation === 'revise') savedId = repository.saveDraft({ ...version(previous), title, body: candidate.body, expiry: null }).id;
    else {
      const source = path.join(root, 'capacity.md'); writeFileSync(source, candidate.body);
      const result = await repository.importFiles([source]);
      expect(result.skipped).toEqual([]);
      expect(result.imported).toHaveLength(1);
      savedId = result.imported[0].id;
    }
    const envelope = JSON.parse(readFileSync(file, 'utf8')) as { encrypted: string };
    expect(Buffer.byteLength(crypto.decryptString(Buffer.from(envelope.encrypted, 'base64')), 'utf8')).toBe(serializedLimit);
    const reopened = new KnowledgeRepository(file, crypto);
    expect(reopened.list().counts.total).toBe(next.length);
    expect(createHash('sha256').update(reopened.get(savedId).body).digest('hex')).toBe(createHash('sha256').update(candidate.body).digest('hex'));
    expect(reopened.get(savedId).revision).toBe(candidate.revision);
  }, 20_000);

  it('skips files exceeding text or byte limits and leaves their bytes intact', async () => {
    const { root, repository } = fixture();
    const tooManyCharacters = path.join(root, 'too-long.md');
    const tooManyBytes = path.join(root, 'too-large.txt');
    writeFileSync(tooManyCharacters, 'a'.repeat(200_001));
    writeFileSync(tooManyBytes, 'a'.repeat(2 * 1024 * 1024 + 1));
    const result = await repository.importFiles([tooManyCharacters, tooManyBytes]);
    expect(result.imported).toEqual([]);
    expect(result.skipped.map((item) => item.error)).toEqual([expect.stringContaining('200000'), expect.stringContaining('2MB')]);
    expect(readFileSync(tooManyCharacters).length).toBe(200_001);
    expect(readFileSync(tooManyBytes).length).toBe(2 * 1024 * 1024 + 1);
  });

  it('does not commit a file if the ongoing import was cancelled', async () => {
    const { root, repository, file } = fixture();
    const source = path.join(root, 'selected.md');
    writeFileSync(source, draft.body);
    const controller = new AbortController();
    const importing = repository.importFiles([source], { signal: controller.signal });
    controller.abort();
    await expect(importing).rejects.toThrow('取消');
    expect(repository.list().counts.total).toBe(0);
    expect(existsSync(file)).toBe(false);
    expect(readFileSync(source, 'utf8')).toBe(draft.body);
  });

  it('rejects duplicated document ids in an existing file', () => {
    const { file, crypto, repository } = fixture();
    const document = repository.createDraft(draft);
    writeFileSync(file, JSON.stringify({ version: 1, encrypted: crypto.encryptString(JSON.stringify({ version: 1, documents: [document, document] })).toString('base64') }));
    const before = readFileSync(file);
    const reopened = new KnowledgeRepository(file, crypto);
    expect(() => reopened.list()).toThrow('未覆盖');
    expect(readFileSync(file)).toEqual(before);
  });

  it('detects another repository instance changing the file instead of losing its changes', () => {
    const { file, crypto, repository } = fixture();
    const other = new KnowledgeRepository(file, crypto);
    repository.createDraft(draft);
    const before = readFileSync(file);
    expect(() => other.createDraft({ ...draft, body: '旧实例写入' })).toThrow('其他');
    expect(() => other.list()).toThrow('其他');
    expect(readFileSync(file)).toEqual(before);
  });

  it('rejects an occupied save lock and retains the original file and in-memory state', () => {
    const { repository, file } = fixture();
    const created = repository.createDraft(draft);
    const before = readFileSync(file);
    writeFileSync(`${file}.lock`, 'another writer');
    expect(() => repository.setStatus({ ...version(created), status: 'approved' })).toThrow('正在保存');
    expect(readFileSync(file)).toEqual(before);
    expect(repository.get(created.id).status).toBe('draft');
    expect(readFileSync(`${file}.lock`, 'utf8')).toBe('another writer');
  });

  it('does not mutate memory or an existing file when encryption fails', () => {
    const { repository, file, crypto } = fixture();
    const created = repository.createDraft(draft);
    const before = readFileSync(file);
    vi.spyOn(crypto, 'encryptString').mockImplementation(() => { throw new Error('synthetic encryption failure'); });
    expect(() => repository.setStatus({ ...version(created), status: 'approved' })).toThrow('加密');
    expect(repository.get(created.id).status).toBe('draft');
    expect(readFileSync(file)).toEqual(before);
  });
});
