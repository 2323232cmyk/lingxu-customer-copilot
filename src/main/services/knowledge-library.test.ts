import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KnowledgeLibrary } from './knowledge-library';
import type { KnowledgeSourceDocument } from '../../shared/knowledge-workspace-contracts';

const folders: string[] = [];
function folder() { const value = mkdtempSync(path.join(os.tmpdir(), 'lingxu-kb-test-')); folders.push(value); return value; }
afterEach(() => { vi.restoreAllMocks(); for (const value of folders.splice(0)) rmSync(value, { recursive: true, force: true }); });

describe('KnowledgeLibrary', () => {
  const managed: KnowledgeSourceDocument = { id: 'c933ae5b-0a9f-48b1-99d4-bcd7ea0f1569', revision: 2, title: '本机费用口径', body: '服务费用项目以公司书面合同为准。', expiry: null };

  it('indexes approved local snapshots without an external folder using the same citation shape', async () => {
    const library = new KnowledgeLibrary();
    expect(library.getStatus()).toMatchObject({ state: 'idle', documents: 0, chunks: 0 });
    const status = await library.index('', [managed]);
    expect(status).toMatchObject({ state: 'ready', folderPath: '', documents: 1, chunks: 1 });
    const [hit] = library.search('服务费用');
    expect(hit.id).toMatch(/^kb:[a-f0-9]{24}$/u);
    expect(hit.sourcePath).toBe(`本机资料/${managed.id}/v2`);
    expect(hit.title).toContain(managed.title);
    expect(hit.text).toContain(managed.body);
    expect(() => library.assertReferencesCurrent([hit])).not.toThrow();
  });

  it('combines and replaces external and managed sources in a single snapshot', async () => {
    const root = folder(); writeFileSync(path.join(root, 'appointment.md'), '# 到店预约\n到店预约需要确认接待安排。');
    const library = new KnowledgeLibrary();
    expect((await library.index(root, [managed])).documents).toBe(2);
    expect(library.search('到店预约')[0].sourcePath).toBe('appointment.md');
    const previous = library.search('服务费用');
    await library.index(root, []);
    expect(library.search('服务费用')).toEqual([]);
    expect(() => library.assertReferencesCurrent(previous)).toThrow('失效');
    await library.index('', [managed]);
    expect(library.search('到店预约')).toEqual([]);
  });

  it('invalidates a managed citation even when only its approved revision changes', async () => {
    const library = new KnowledgeLibrary(); await library.index('', [managed]);
    const previous = library.search('服务费用');
    await library.index('', [{ ...managed, revision: 4 }]);
    expect(library.search('服务费用')[0].id).not.toBe(previous[0].id);
    expect(() => library.assertReferencesCurrent(previous)).toThrow('失效');
  });

  it('reports no available documents while repository updates hold the rebuild guard', async () => {
    const library = new KnowledgeLibrary(); await library.index('', [managed]);
    const indexedAt = library.getStatus().indexedAt;
    const previous = library.search('服务费用');
    library.invalidate();
    expect(library.getStatus()).toMatchObject({ state: 'indexing', documents: 0, chunks: 0, indexedAt });
    expect(library.getStatus().warnings.join('')).toContain('正在重新');
    expect(() => library.search('服务费用')).toThrow('正在重新');
    expect(() => library.assertReferencesCurrent(previous)).toThrow('正在重新');
    expect(() => library.assertReferencesCurrent([{ id: 'chat:1', title: '聊天', text: '你好' }])).not.toThrow();
    await library.index('', []);
    expect(library.search('服务费用')).toEqual([]);
    expect(() => library.assertReferencesCurrent(previous)).toThrow('失效');
  });

  it('does not publish managed sources if the selected external directory fails to rebuild', async () => {
    const root = folder(); const library = new KnowledgeLibrary(); await library.index('', [managed]);
    const references = library.search('服务费用');
    await expect(library.index(path.join(root, 'missing'), [managed])).rejects.toThrow();
    expect(library.getStatus()).toMatchObject({ state: 'error', documents: 0, chunks: 0 });
    expect(() => library.search('服务费用')).toThrow('整理失败');
    expect(() => library.assertReferencesCurrent(references)).toThrow('整理失败');
    await library.index('', [managed]);
    expect(library.search('服务费用')).toHaveLength(1);
  });

  it('marks a repository-update failure as unavailable rather than permanently rebuilding', async () => {
    const library = new KnowledgeLibrary(); await library.index('', [managed]);
    const references = library.search('服务费用');
    library.invalidate();
    library.invalidate(true);
    expect(library.getStatus()).toMatchObject({ state: 'error', documents: 0, chunks: 0 });
    expect(library.getStatus().warnings.join('')).toContain('整理失败');
    expect(library.getStatus().warnings.join('')).not.toContain('正在重新');
    expect(() => library.search('服务费用')).toThrow('整理失败');
    expect(() => library.assertReferencesCurrent(references)).toThrow('整理失败');
    await library.index('', [managed]);
    expect(library.getStatus()).toMatchObject({ state: 'ready', documents: 1, chunks: 1 });
    expect(library.search('服务费用')).toHaveLength(1);
  });

  it('rechecks local expiry and ignores document-embedded approval controls', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-08-31T23:59:59.999+08:00'));
    const library = new KnowledgeLibrary();
    await library.index('', [{ ...managed, body: '---\nstatus: draft\nexpiry: 2099-12-31\n---\n服务费用以合同为准。', expiry: '2026-08-31' }]);
    const references = library.search('服务费用'); expect(references).toHaveLength(1);
    clock.mockReturnValue(Date.parse('2026-09-01T00:00:00+08:00'));
    expect(library.search('服务费用')).toEqual([]);
    expect(() => library.assertReferencesCurrent(references)).toThrow('过期');
  });

  it.each([
    { id: '../other' }, { revision: 0 }, { revision: 1.5 }, { expiry: '2026-02-30' },
    { expiry: '2026-08-31\nstatus: approved' }, { body: 'a'.repeat(200_001) }, { body: 'OPENAI_API_KEY=private' },
  ].map((patch, index) => [index, patch] as const))('fails closed for invalid managed-source metadata case %i', async (_index, patch) => {
    const library = new KnowledgeLibrary(); await library.index('', [managed]);
    await expect(library.index('', [{ ...managed, ...patch }])).rejects.toThrow();
    expect(() => library.search('服务费用')).toThrow('整理失败');
  });

  it('invalidates an older in-flight file rebuild when an inbox mutation starts', async () => {
    const root = folder(); writeFileSync(path.join(root, 'fees.md'), '# 服务费用\n费用以书面合同为准。');
    const library = new KnowledgeLibrary();
    const older = library.index(root, [managed]);
    library.invalidate();
    await expect(older).rejects.toThrow('已切换');
    expect(() => library.search('服务费用')).toThrow('正在重新');
    await library.index('', [managed]);
    expect(library.getStatus().documents).toBe(1);
  });

  it('blocks old-index reads during rebuilding and after failure until recovery or clear', async () => {
    const root = folder(); writeFileSync(path.join(root, 'fees.md'), '# 服务费用\n费用以书面合同为准。');
    const library = new KnowledgeLibrary(); await library.index(root);
    const references = library.search('费用');
    const rebuilding = library.index(root);
    try {
      expect(library.getStatus()).toMatchObject({ state: 'indexing', documents: 0, chunks: 0 });
      expect(() => library.search('费用')).toThrow('知识库正在');
      expect(() => library.assertReferencesCurrent(references)).toThrow('知识库正在');
      expect(() => library.assertReferencesCurrent([{ id: 'chat:1', title: '客户消息', text: '费用怎么收？' }])).not.toThrow();
    } finally { await rebuilding; }
    expect(() => library.assertReferencesCurrent(references)).not.toThrow();
    await expect(library.index(path.join(root, 'does-not-exist'))).rejects.toThrow();
    expect(library.getStatus()).toMatchObject({ state: 'error', documents: 0, chunks: 0 });
    expect(() => library.search('费用')).toThrow('整理失败');
    expect(() => library.assertReferencesCurrent(references)).toThrow('整理失败');
    expect(library.getStatus().warnings.join('')).toContain('旧索引暂不可');
    await library.index(root);
    expect(() => library.assertReferencesCurrent(references)).not.toThrow();
    library.clear();
    expect(library.getStatus()).toMatchObject({ state: 'idle', documents: 0, chunks: 0 });
    expect(library.search('费用')).toEqual([]);
    expect(() => library.assertReferencesCurrent(references)).toThrow('失效');
  });

  it('checks current expiry rather than trusting an unchanged content id', async () => {
    const root = folder(); const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-08-31T12:00:00+08:00'));
    const file = path.join(root, 'fees.md');
    const body = '# 服务费用\n费用以书面合同为准。';
    writeFileSync(file, `---\nstatus: approved\nexpiry: 2026-09-01\n---\n${body}`);
    const library = new KnowledgeLibrary(); await library.index(root);
    const references = library.search('费用');
    writeFileSync(file, `---\nstatus: approved\nexpiry: 2026-08-31\n---\n${body}`);
    await library.index(root);
    expect(library.search('费用')[0].id).toBe(references[0].id);
    clock.mockReturnValue(Date.parse('2026-09-01T00:00:00+08:00'));
    expect(() => library.assertReferencesCurrent(references)).toThrow('过期');
  });

  it('rejects removed or changed evidence and a modified cached excerpt', async () => {
    const root = folder(); const file = path.join(root, 'fees.md');
    writeFileSync(file, '# 服务费用\n费用以书面合同为准。');
    const library = new KnowledgeLibrary(); await library.index(root);
    const references = library.search('费用');
    expect(() => library.assertReferencesCurrent([{ ...references[0], text: '不是索引中的正文' }])).toThrow('失效');
    writeFileSync(file, '# 服务费用\n费用条款已更新，需要重新核实。'); await library.index(root);
    expect(() => library.assertReferencesCurrent(references)).toThrow('失效');
    const current = library.search('费用');
    writeFileSync(file, '---\nstatus: disabled\n---\n# 服务费用\n费用条款已更新，需要重新核实。'); await library.index(root);
    expect(() => library.assertReferencesCurrent(current)).toThrow('失效');
  });

  it('does not let an older concurrent index clear the current rebuild guard', async () => {
    const first = folder(); const second = folder();
    writeFileSync(path.join(first, 'old.md'), '# 旧版费用\n旧版费用说明。');
    writeFileSync(path.join(second, 'new.md'), '# 新版费用\n新版费用说明。');
    const library = new KnowledgeLibrary();
    const results = await Promise.allSettled([library.index(first), library.index(second)]);
    expect(results.map((result) => result.status)).toEqual(['rejected', 'fulfilled']);
    expect(library.search('新版费用')[0].sourcePath).toBe('new.md');
    expect(library.getStatus().warnings.join('')).not.toMatch(/正在重新|整理失败/);
  });

  it('indexes actual Markdown and text with relative-path citations', async () => {
    const root = folder();
    writeFileSync(path.join(root, '邀约.md'), '# 到店邀约\n先解答客户的问题，再询问方便到店的时间。');
    writeFileSync(path.join(root, '费用.txt'), '服务费用以书面合同为准。');
    const library = new KnowledgeLibrary();
    const status = await library.index(root);
    expect(status.documents).toBe(2);
    const hits = library.search('客户想知道到店邀约流程');
    expect(hits[0].title).toBe('到店邀约');
    expect(hits[0].sourcePath).toBe('邀约.md');
    expect(hits[0].id).toMatch(/^kb:[a-f0-9]{24}$/);
    expect(hits[0].sourcePath).not.toContain(root);
  });

  it('skips hidden, credential, binary and unsupported files', async () => {
    const root = folder();
    mkdirSync(path.join(root, '.obsidian'));
    writeFileSync(path.join(root, '.obsidian', 'private.md'), 'private marker');
    writeFileSync(path.join(root, 'credentials.txt'), 'token=private');
    writeFileSync(path.join(root, 'normal.md'), 'OPENAI_API_KEY=not-a-real-key');
    writeFileSync(path.join(root, 'binary.txt'), Buffer.from([0, 1, 2]));
    writeFileSync(path.join(root, 'training.pdf'), 'pdf is not parsed');
    writeFileSync(path.join(root, 'good.md'), '真实培训知识');
    const library = new KnowledgeLibrary();
    const status = await library.index(root);
    expect(status.documents).toBe(1);
    expect(status.skipped).toBe(5);
    expect(status.supportedExtensions).toEqual(['.md', '.txt']);
    expect(library.search('private marker')).toEqual([]);
  });

  it('replaces instead of mixing knowledge folders', async () => {
    const first = folder();
    const second = folder();
    writeFileSync(path.join(first, 'old.md'), '旧客户秘密内容');
    writeFileSync(path.join(second, 'new.md'), '新的培训知识');
    const library = new KnowledgeLibrary();
    await library.index(first);
    const before = library.search('旧客户')[0].id;
    await library.index(second);
    expect(library.search('旧客户')).toEqual([]);
    expect(library.search('新的培训')[0].id).not.toBe(before);
    library.clear();
    expect(library.getStatus().documents).toBe(0);
    expect(library.search('培训')).toEqual([]);
  });

  it('does not return unrelated demo content on no-match or empty queries', async () => {
    const root = folder();
    writeFileSync(path.join(root, 'one.md'), '贷款流程需要先核实资格');
    const library = new KnowledgeLibrary();
    await library.index(root);
    expect(library.search('')).toEqual([]);
    expect(library.search('火星')).toEqual([]);
  });

  it('bounds files and marks truncation', async () => {
    const root = folder();
    for (let index = 0; index < 503; index += 1) writeFileSync(path.join(root, `${index}.txt`), '培训知识');
    const library = new KnowledgeLibrary();
    const status = await library.index(root);
    expect(status.documents).toBe(500);
    expect(status.warnings.some((warning) => warning.includes('上限'))).toBe(true);
  });

  it('skips files over the individual size cap', async () => {
    const root = folder();
    writeFileSync(path.join(root, 'large.md'), 'a'.repeat(2 * 1024 * 1024 + 1));
    const status = await new KnowledgeLibrary().index(root);
    expect(status.documents).toBe(0);
    expect(status.skipped).toBe(1);
    expect(status.warnings.join('')).toContain('2MB');
  });

  it('excludes draft, disabled and archived material but keeps approved and unmarked legacy files', async () => {
    const root = folder();
    for (const state of ['draft', 'disabled', 'archived', 'approved', 'active', 'published']) {
      writeFileSync(path.join(root, `${state}.md`), `---\nstatus: ${state}\n---\n# 费用说明\n${state}费用原文`);
    }
    writeFileSync(path.join(root, 'legacy.md'), '# 旧版费用资料\nlegacy费用原文');
    const library = new KnowledgeLibrary(); const status = await library.index(root);
    expect(status.documents).toBe(4); expect(status.skipped).toBe(3);
    expect(library.search('费用', 12).map((hit) => hit.sourcePath).sort()).toEqual(['active.md', 'approved.md', 'legacy.md', 'published.md']);
    expect(status.warnings.join('')).toContain('未标记');
    expect(status.warnings.join('')).toContain('草稿');
  });

  it('uses the end of the Beijing expiry day, rechecking on search without reindexing', async () => {
    const root = folder(); const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-08-31T23:59:59.999+08:00'));
    writeFileSync(path.join(root, 'time.md'), '---\nstatus: approved\nexpiry: "2026-08-31"\n---\n# 服务费用\n到期费用口径');
    const library = new KnowledgeLibrary(); await library.index(root);
    expect(library.search('费用')).toHaveLength(1);
    clock.mockReturnValue(Date.parse('2026-09-01T00:00:00+08:00'));
    expect(library.search('费用')).toEqual([]);
    const status = await library.index(root); expect(status.documents).toBe(0); expect(status.warnings.join('')).toContain('过期');
  });

  it.each([
    'status: maybe', 'status: [approved]', 'status: true', 'status: approved\nstatus: draft',
    'status approved', 'status: approved\nexpiry: 2026-02-30', 'status: approved\nexpiry: tomorrow',
    'status: approved\nexpiry:', 'status: approved\nexpiry: 2027-01-01\nexpiry: 2028-01-01',
    '{ status: draft }', '"status": approved\nstatus: draft',
  ])('skips ambiguous or malformed control metadata instead of silently enabling it: %s', async (metadata) => {
    const root = folder(); writeFileSync(path.join(root, 'bad.md'), `---\n${metadata}\n---\n# 费用资料\n不应入库的费用口径`);
    const library = new KnowledgeLibrary(); const status = await library.index(root);
    expect(status.documents).toBe(0); expect(status.skipped).toBe(1); expect(library.search('费用')).toEqual([]);
    expect(status.warnings.join('')).toContain('元数据');
  });

  it('does not index an unclosed frontmatter or leak its fields into citations', async () => {
    const root = folder();
    writeFileSync(path.join(root, 'unclosed.md'), '---\nstatus: approved\n# 费用资料\n没有结束的元数据');
    writeFileSync(path.join(root, 'good.md'), '---\nstatus: "approved" # 已审核\nexpiry: 2099-12-31\nauthor: metadata-only-marker\ntags:\n  - 公司培训\n---\n# 服务费用\n按书面合同核实费用。');
    const library = new KnowledgeLibrary(); const status = await library.index(root);
    expect(status.documents).toBe(1); expect(library.search('metadata-only-marker')).toEqual([]);
    const [hit] = library.search('服务费用'); expect(hit.text).not.toContain('status:'); expect(hit.text).not.toContain('2099');
  });

  it('supports an unmarked Obsidian frontmatter without treating it as reviewed knowledge', async () => {
    const root = folder(); writeFileSync(path.join(root, 'old.md'), '---\ntags:\n  - 培训\naliases: [费用口径]\n---\n# 费用说明\n费用按合同核对。');
    const library = new KnowledgeLibrary(); const status = await library.index(root);
    expect(status.documents).toBe(1); expect(status.warnings.join('')).toContain('未标记');
    expect(library.search('费用')[0].text).not.toContain('aliases');
  });

  it('preserves section heading paths and keeps a short condition and exception in one piece', async () => {
    const root = folder(); writeFileSync(path.join(root, 'policy.md'), '# 公司服务\n\n## 收费条件\n满足合同约定条件后收取费用。\n\n例外：特殊委托须另行书面确认。\n\n## 接待预约\n预约需要先核对接待安排。');
    const library = new KnowledgeLibrary(); const status = await library.index(root);
    expect(status.chunks).toBe(2);
    const [hit] = library.search('收费条件');
    expect(hit.title).toContain('公司服务'); expect(hit.title).toContain('收费条件');
    expect(hit.text).toContain('满足合同约定条件'); expect(hit.text).toContain('特殊委托'); expect(hit.text).not.toContain('预约需要');
  });

  it('packs paragraphs without cutting normal paragraphs or repeating overlapping slices', async () => {
    const root = folder(); const paragraphs = Array.from({ length: 4 }, (_, index) => `费用条件${index}：${'甲'.repeat(400)}。`);
    writeFileSync(path.join(root, 'long.md'), '# 费用条件\n\n' + paragraphs.join('\n\n'));
    const library = new KnowledgeLibrary(); await library.index(root); const hits = library.search('费用条件', 12);
    expect(hits).toHaveLength(2);
    for (const paragraph of paragraphs) expect(hits.filter((hit) => hit.text.includes(paragraph))).toHaveLength(1);
    expect(hits.every((hit) => hit.text.length <= 1200)).toBe(true);
  });

  it('bounds very long paragraphs and does not treat fenced examples as new headings', async () => {
    const root = folder(); writeFileSync(path.join(root, 'fence.md'), '# 费用说明\n\n```text\n# 示例不是章节\n```\n\n' + '费用需核实合同。'.repeat(350));
    const library = new KnowledgeLibrary(); await library.index(root); const hits = library.search('费用', 12);
    expect(hits.length).toBeGreaterThan(1); expect(hits.every((hit) => hit.text.length <= 1200)).toBe(true);
    expect(hits.every((hit) => !hit.title.includes('示例不是章节'))).toBe(true);
  });

  it('does not return greetings or a single weak incidental word as an answer source', async () => {
    const root = folder();
    writeFileSync(path.join(root, 'one.md'), '# 公司介绍\n您好，欢迎咨询。谢谢您的信任，我们会解答客户的问题。');
    writeFileSync(path.join(root, 'two.md'), '# 到店安排\n请先确认预约。客户可携带问题来访。');
    const library = new KnowledgeLibrary(); await library.index(root);
    for (const query of ['你好', '您好，谢谢', '好的，了解一下', '谢谢你们', '客户想了解火星农业的种植气候']) expect(library.search(query)).toEqual([]);
  });

  it('retains Chinese business recall for fees, loans, appointments and a genuine no-answer case', async () => {
    const root = folder();
    writeFileSync(path.join(root, 'fees.md'), '# 服务费用\n收费项目与退款条件需要核对书面合同。');
    writeFileSync(path.join(root, 'loan.md'), '# 贷款资格\n贷款申请需要先核实资格与银行要求。');
    writeFileSync(path.join(root, 'visit.md'), '# 到店预约\n到店前需要先确认预约与接待安排。');
    const library = new KnowledgeLibrary(); await library.index(root);
    expect(library.search('你好，请问服务费怎么收？')[0]?.sourcePath).toBe('fees.md');
    expect(library.search('我想了解贷款资格需要哪些条件')[0]?.sourcePath).toBe('loan.md');
    expect(library.search('请问怎么预约到店？')[0]?.sourcePath).toBe('visit.md');
    expect(library.search('公司地址的门牌号是多少')).toEqual([]);
  });

  it('deduplicates identical evidence while keeping its relative source reference and score as a rank', async () => {
    const root = folder(); const text = '# 贷款资格\n贷款申请需核实资格与银行要求。';
    writeFileSync(path.join(root, 'a.md'), text); writeFileSync(path.join(root, 'b.md'), text);
    const library = new KnowledgeLibrary(); await library.index(root); const hits = library.search('贷款资格');
    expect(hits).toHaveLength(1); expect(hits[0].score).toBeGreaterThan(1); expect(hits[0].sourcePath).toBe('a.md');
    expect(Object.keys(hits[0]).sort()).toEqual(['id', 'score', 'sourcePath', 'text', 'title']);
  });
});
