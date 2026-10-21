import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { KnowledgeHit, KnowledgeIndexStatus } from '../../shared/integration-contracts';
import { KNOWLEDGE_BODY_MAX_LENGTH, KNOWLEDGE_TITLE_MAX_LENGTH, type KnowledgeSourceDocument } from '../../shared/knowledge-workspace-contracts';

const MAX_FILES = 500;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_CHUNKS = 12_000;
const SKIP_NAMES = /^(?:node_modules|vendor|dist|out|cache|exports?)$/i;
const SECRET_NAME = /(?:^|[-_.])(?:secrets?|credentials?|passwords?|tokens?|private[-_]?keys?)(?:[-_.]|$)|密码|密钥/i;
const SECRET_TEXT = /(?:OPENAI_API_KEY|DEEPSEEK_API_KEY|API_SECRET|ACCESS_TOKEN)\s*[:=]\s*\S+|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i;
const COMMON_TERMS = new Set(['你好', '您好', '谢谢', '好的', '收到', '了解', '一下', '请问', '麻烦', '我们', '你们', '我的', '您的', '客户', '公司', '问题', '咨询', '可以', '需要', '是否', '怎么', '如何', '什么', '多少', '哪里', '哪个', '知道', '现在', '今天', '明天', '时候', '这个', '那个', '一些', '一般', '这样', '那样', '没有', '已经', '还是', '所以', '因为', 'the', 'and', 'you', 'your', 'please', 'hello', 'thanks', 'thank']);

export const EMPTY_KNOWLEDGE_STATUS: KnowledgeIndexStatus = {
  state: 'idle', folderPath: '', documents: 0, chunks: 0, indexedAt: null, skipped: 0, warnings: [], supportedExtensions: ['.md', '.txt'],
};

function within(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function terms(text: string): string[] {
  const normalized = searchableText(text).replace(/谢谢你们|谢谢您|谢谢你|请问一下|我想了解|我想知道|想了解|想知道|了解一下|你好|您好|谢谢|好的|收到|嗯嗯|打扰了|请问|麻烦|怎么|如何|什么|多少|哪里|哪个|一般|是否|能不能|可不可以/g, ' ');
  const result = normalized.match(/[a-z0-9]{2,}|[\u3400-\u9fff]+/g) ?? [];
  const tokens = new Set<string>();
  for (const term of result) {
    if (/^[a-z0-9]/.test(term)) tokens.add(term);
    else for (let offset = 0; offset < term.length - 1; offset += 1) tokens.add(term.slice(offset, offset + 2));
  }
  return [...tokens].filter((term) => !COMMON_TERMS.has(term)).slice(0, 100);
}

function searchableText(text: string): string {
  return text.toLowerCase().replace(/服务费(?!用)|收费/g, '费用');
}

function hasControlCharacters(text: string, multiline = false): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 127 || (code < 32 && !(multiline && (code === 9 || code === 10 || code === 13)))) return true;
  }
  return false;
}

type DocumentPolicy = { allowed: true; body: string; expiresAt: number | null; legacy: boolean }
  | { allowed: false; reason: 'metadata' | 'disabled' | 'expired' };

/** Only these two top-level scalar controls are interpreted, not a general YAML/CMS schema. */
function documentPolicy(text: string, now: number): DocumentPolicy {
  if (!text.startsWith('---\n')) return { allowed: true, body: text, expiresAt: null, legacy: true };
  const lines = text.split('\n');
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (end < 0 || lines.slice(0, end).join('\n').length > 8192) return { allowed: false, reason: 'metadata' };
  const controls = new Map<string, string>();
  for (const line of lines.slice(1, end)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const control = line.match(/^(['"]?)(status|expiry)\1\s*:\s*(.*?)\s*$/i);
    if (!control) {
      if (/\b(?:status|expiry)\b\s*[:=]|^\s*['"]?(?:status|expiry)\b/i.test(line)) return { allowed: false, reason: 'metadata' };
      continue;
    }
    const key = control[2].toLowerCase();
    const scalar = control[3].match(/^(?:"([^"]*)"|'([^']*)'|([a-z0-9_-]+))(?:\s+#.*)?$/i);
    if (controls.has(key) || !scalar) return { allowed: false, reason: 'metadata' };
    controls.set(key, scalar[1] ?? scalar[2] ?? scalar[3]);
  }
  const status = controls.get('status')?.toLowerCase();
  if (status !== undefined && !['approved', 'active', 'published', 'draft', 'disabled', 'archived'].includes(status)) return { allowed: false, reason: 'metadata' };
  let expiresAt: number | null = null;
  const expiry = controls.get('expiry');
  if (expiry !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry)) return { allowed: false, reason: 'metadata' };
    const parsed = Date.parse(`${expiry}T00:00:00Z`);
    if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== expiry) return { allowed: false, reason: 'metadata' };
    expiresAt = parsed + 16 * 60 * 60 * 1000 - 1;
  }
  if (['draft', 'disabled', 'archived'].includes(status || '')) return { allowed: false, reason: 'disabled' };
  if (expiresAt !== null && expiresAt < now) return { allowed: false, reason: 'expired' };
  return { allowed: true, body: lines.slice(end + 1).join('\n').trim(), expiresAt, legacy: status === undefined };
}

function paragraphPieces(paragraph: string, limit: number): string[] {
  const pieces: string[] = [];
  let remaining = paragraph;
  while (remaining.length > limit) {
    const prefix = remaining.slice(0, limit);
    const stops = [...prefix.matchAll(/[。！？.!?；;]\s*|\n|\s+/g)];
    const lastStop = stops.at(-1);
    let end = lastStop && lastStop.index + lastStop[0].length >= limit / 2 ? lastStop.index + lastStop[0].length : limit;
    if (/[\uD800-\uDBFF]/.test(remaining[end - 1])) end -= 1;
    pieces.push(remaining.slice(0, end).trim()); remaining = remaining.slice(end).trimStart();
  }
  if (remaining.trim()) pieces.push(remaining.trim());
  return pieces;
}

function documentChunks(text: string, fallbackTitle: string): Array<{ title: string; text: string }> {
  const chunks: Array<{ title: string; text: string }> = [];
  let headings: Array<{ depth: number; title: string }> = [];
  let section: string[] = [];
  let fence = '';
  const flush = () => {
    const title = (headings.map((item) => item.title).join(' / ') || fallbackTitle).slice(0, 180);
    const headingText = headings.map((item) => `${'#'.repeat(item.depth)} ${item.title}`).join('\n').slice(0, 240);
    const prefix = headingText ? headingText + '\n\n' : '';
    const limit = 1200 - prefix.length;
    let body = '';
    const emit = () => { if (body) chunks.push({ title, text: prefix + body }); body = ''; };
    for (const paragraph of section.join('\n').trim().split(/\n\s*\n/)) {
      for (const piece of paragraphPieces(paragraph, limit)) {
        if (body && body.length + 2 + piece.length > limit) emit();
        body += (body ? '\n\n' : '') + piece;
      }
    }
    emit(); section = [];
  };
  for (const line of text.split('\n')) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = '';
      section.push(line); continue;
    }
    const heading = !fence && line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      flush(); const depth = heading[1].length;
      headings = [...headings.filter((item) => item.depth < depth), { depth, title: heading[2] }];
    } else section.push(line);
  }
  flush(); return chunks;
}

export class KnowledgeLibrary {
  private chunks: Array<{ hit: KnowledgeHit; expiresAt: number | null }> = [];
  private currentStatus: KnowledgeIndexStatus = { ...EMPTY_KNOWLEDGE_STATUS };
  private generation = 0;
  private indexing = false;
  private indexError = false;

  getStatus(): KnowledgeIndexStatus {
    const state = this.indexing ? 'indexing' : this.indexError ? 'error' : this.currentStatus.indexedAt ? 'ready' : 'idle';
    return { ...this.currentStatus, state,
      ...(this.indexing || this.indexError ? { documents: 0, chunks: 0 } : {}), warnings: [...this.currentStatus.warnings,
      ...(this.indexing ? ['知识库正在重新整理，完成前暂停知识检索'] : []),
      ...(this.indexError ? ['知识库整理失败，旧索引暂不可用于回复；请重新整理或移除此索引'] : [])],
    supportedExtensions: [...this.currentStatus.supportedExtensions] };
  }

  /** Suspend stale references before an asynchronous local repository operation starts. */
  invalidate(failed = false): void {
    this.generation += 1;
    this.indexing = !failed;
    this.indexError = failed;
  }

  async index(folderPath: string, managedDocuments: readonly KnowledgeSourceDocument[] = []): Promise<KnowledgeIndexStatus> {
    const generation = ++this.generation;
    this.indexing = true;
    this.indexError = false;
    try {
      if (typeof folderPath !== 'string' || folderPath.length > 4096 || !Array.isArray(managedDocuments)) throw new Error('知识库快照格式无效');
      await this.buildIndex(folderPath, generation, managedDocuments.map((document) => ({ ...document })));
    } catch (error) {
      if (generation === this.generation) this.indexError = true;
      throw error;
    } finally {
      if (generation === this.generation) this.indexing = false;
    }
    if (generation !== this.generation) throw new Error('知识库已切换，本次旧索引结果已丢弃');
    return this.getStatus();
  }

  private async buildIndex(folderPath: string, generation: number, managedDocuments: KnowledgeSourceDocument[]): Promise<void> {
    const root = folderPath ? await realpath(folderPath) : '';
    if (root && !(await lstat(root)).isDirectory()) throw new Error('请选择知识库文件夹');
    const nextChunks: Array<{ hit: KnowledgeHit; expiresAt: number | null }> = [];
    let documents = 0;
    let consideredFiles = 0;
    let scannedEntries = 0;
    let bytes = 0;
    let skipped = 0;
    const warnings = new Set<string>();
    const managedIds = new Set<string>();
    // Local approvals take priority within the existing global indexing limits.
    // These are main-process snapshots, not arbitrary Markdown approval headers.
    for (const document of managedDocuments) {
      if (consideredFiles >= MAX_FILES || bytes >= MAX_TOTAL_BYTES || nextChunks.length >= MAX_CHUNKS) {
        warnings.add('已达到本地索引上限：500 份资料、20MB 或 12000 个片段；请拆分资料目录'); break;
      }
      if (typeof document.id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(document.id)
        || managedIds.has(document.id) || !Number.isSafeInteger(document.revision) || document.revision < 1
        || typeof document.title !== 'string' || !document.title.trim() || document.title.length > KNOWLEDGE_TITLE_MAX_LENGTH || hasControlCharacters(document.title)
        || typeof document.body !== 'string' || !document.body.trim() || document.body.length > KNOWLEDGE_BODY_MAX_LENGTH
        || hasControlCharacters(document.body, true) || SECRET_TEXT.test(document.body)
        || (document.expiry !== null && (typeof document.expiry !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(document.expiry)))) throw new Error('本机资料身份、版本或正文无效，未发布本次知识索引');
      managedIds.add(document.id);
      const size = Buffer.byteLength(document.body, 'utf8');
      if (size > MAX_FILE_BYTES) throw new Error('本机资料超过单份 2MB 上限，未发布本次知识索引');
      if (bytes + size > MAX_TOTAL_BYTES) { warnings.add('已达到本地索引 20MB 上限，部分资料未进入检索'); break; }
      consideredFiles += 1;
      bytes += size;
      const policy = documentPolicy(`---\nstatus: approved\n${document.expiry === null ? '' : `expiry: ${document.expiry}\n`}---\n${document.body}`, Date.now());
      if (!policy.allowed) {
        if (policy.reason !== 'expired') throw new Error('本机资料有效日期无效，未发布本次知识索引');
        skipped += 1; warnings.add('已跳过明确过期的资料；不会作为当前回复依据'); continue;
      }
      const parts = documentChunks(`# ${document.title}\n\n${policy.body}`, document.title);
      if (!parts.length) { skipped += 1; continue; }
      documents += 1;
      const sourcePath = `本机资料/${document.id}/v${document.revision}`;
      for (const [index, chunk] of parts.entries()) {
        if (nextChunks.length >= MAX_CHUNKS) { warnings.add('已达到 12000 个片段的索引上限'); break; }
        const id = `kb:${createHash('sha256').update(`managed\0${sourcePath}\0${index}\0${chunk.title}\0${chunk.text}`).digest('hex').slice(0, 24)}`;
        nextChunks.push({ hit: { id, ...chunk, sourcePath, score: 0 }, expiresAt: policy.expiresAt });
      }
    }
    const walk = async (directory: string, depth: number): Promise<void> => {
      if (depth > 8) { warnings.add('已跳过超过 8 层的子目录'); return; }
      const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        scannedEntries += 1;
        if (consideredFiles >= MAX_FILES || bytes >= MAX_TOTAL_BYTES || nextChunks.length >= MAX_CHUNKS || scannedEntries > 10_000) {
          warnings.add('已达到本地索引上限：500 份资料、20MB 或 12000 个片段；请拆分资料目录');
          return;
        }
        if (entry.name.startsWith('.') || SKIP_NAMES.test(entry.name) || SECRET_NAME.test(entry.name) || entry.isSymbolicLink()) { skipped += 1; continue; }
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) { await walk(file, depth + 1); continue; }
        if (!entry.isFile()) continue;
        if (!['.md', '.txt'].includes(path.extname(entry.name).toLowerCase())) { skipped += 1; continue; }
        consideredFiles += 1;
        try {
          const resolved = await realpath(file);
          if (!within(root, resolved)) { skipped += 1; continue; }
          const metadata = await lstat(resolved);
          if (!metadata.isFile() || metadata.size > MAX_FILE_BYTES || metadata.size + bytes > MAX_TOTAL_BYTES) { skipped += 1; warnings.add('已跳过过大文件；单份资料上限为 2MB'); continue; }
          const buffer = await readFile(resolved);
          if (buffer.length > MAX_FILE_BYTES || buffer.length + bytes > MAX_TOTAL_BYTES) { skipped += 1; continue; }
          const text = buffer.toString('utf8').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
          if (!text || text.includes('\u0000') || SECRET_TEXT.test(text)) { skipped += 1; continue; }
          bytes += buffer.length;
          const policy = documentPolicy(text, Date.now());
          if (!policy.allowed) {
            skipped += 1;
            warnings.add(policy.reason === 'metadata' ? '已跳过控制元数据不完整或非法的资料；请核对 status / expiry'
              : policy.reason === 'expired' ? '已跳过明确过期的资料；不会作为当前回复依据'
                : '已跳过草稿、停用或归档资料（draft / disabled / archived）');
            continue;
          }
          const parts = documentChunks(policy.body, path.basename(entry.name, path.extname(entry.name)));
          if (!parts.length) { skipped += 1; continue; }
          if (policy.legacy) warnings.add('未标记 status 的旧资料按兼容规则参与检索，不代表已经审核；可用 status: approved 明确标记');
          documents += 1;
          const relative = path.relative(root, resolved).split(path.sep).join('/');
          for (const [index, chunk] of parts.entries()) {
            if (nextChunks.length >= MAX_CHUNKS) { warnings.add('已达到 12000 个片段的索引上限'); break; }
            const id = `kb:${createHash('sha256').update(`${relative}\0${index}\0${chunk.title}\0${chunk.text}`).digest('hex').slice(0, 24)}`;
            nextChunks.push({ hit: { id, ...chunk, sourcePath: relative, score: 0 }, expiresAt: policy.expiresAt });
          }
        } catch {
          skipped += 1;
          warnings.add('部分资料无法读取，已跳过；请检查文件是否正在同步或无访问权限');
        }
      }
    };
    if (root) await walk(root, 0);
    if (generation !== this.generation) throw new Error('知识库已切换，本次旧索引结果已丢弃');
    this.chunks = nextChunks;
    this.currentStatus = { folderPath: root, documents, chunks: nextChunks.length, indexedAt: new Date().toISOString(), skipped, warnings: [...warnings], supportedExtensions: ['.md', '.txt'] };
  }

  search(query: string, limit = 6): KnowledgeHit[] {
    if (typeof query !== 'string' || query.length > 4000) throw new Error('知识库搜索内容过长');
    this.assertReadable();
    const queryTerms = terms(query);
    if (queryTerms.length === 0) return [];
    const now = Date.now();
    const seen = new Set<string>();
    return this.chunks.filter((chunk) => chunk.expiresAt === null || chunk.expiresAt >= now).map(({ hit }) => {
      const body = searchableText(hit.text); const title = searchableText(hit.title);
      const matches = queryTerms.filter((term) => body.includes(term));
      const titleMatches = matches.filter((term) => title.includes(term)).length;
      const enough = matches.length / queryTerms.length >= .35 && (matches.length >= 2 || queryTerms.length <= 2 || titleMatches > 0);
      // A lexical ranking weight, not a probability that the passage answers the question.
      return { ...hit, score: enough ? matches.length + titleMatches * 3 : 0 };
    }).filter((chunk) => chunk.score > 0).sort((a, b) => b.score - a.score || a.sourcePath.localeCompare(b.sourcePath) || a.id.localeCompare(b.id))
      .filter((chunk) => { const key = chunk.text.toLowerCase().replace(/\s+/g, ' ').trim(); if (seen.has(key)) return false; seen.add(key); return true; })
      .slice(0, Math.max(1, Math.min(12, Math.floor(limit) || 6)));
  }

  /** Synchronous dispatch guard: ids omit expiry, so always check the current chunk too. */
  assertReferencesCurrent(sources: readonly { id: string; title: string; text: string; sourcePath?: string }[]): void {
    const references = sources.filter((source) => source.id.startsWith('kb:'));
    if (!references.length) return;
    this.assertReadable();
    const now = Date.now();
    const current = new Map(this.chunks.map((chunk) => [chunk.hit.id, chunk]));
    for (const source of references) {
      const chunk = current.get(source.id);
      if (!chunk || (chunk.expiresAt !== null && chunk.expiresAt < now)
        || chunk.hit.text !== source.text || chunk.hit.title !== source.title || chunk.hit.sourcePath !== source.sourcePath) {
        throw new Error('知识库引用已过期或失效，请重新预览后再起草');
      }
    }
  }

  private assertReadable(): void {
    if (this.indexing) throw new Error('知识库正在重新整理，请完成后重新预览；本次不会使用旧索引');
    if (this.indexError) throw new Error('知识库整理失败，旧索引暂不可用；请重新整理或关闭本次知识检索');
  }

  clear(): void {
    this.generation += 1;
    this.indexing = false;
    this.indexError = false;
    this.chunks = [];
    this.currentStatus = { ...EMPTY_KNOWLEDGE_STATUS };
  }
}
