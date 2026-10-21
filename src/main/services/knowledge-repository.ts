import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { KNOWLEDGE_BODY_MAX_LENGTH, KNOWLEDGE_IMPORT_MAX_FILES, KNOWLEDGE_TITLE_MAX_LENGTH, type KnowledgeDocument, type KnowledgeDocumentSaveInput, type KnowledgeDocumentStatusInput, type KnowledgeDocumentSummary, type KnowledgeDraftInput, type KnowledgeImportResult, type KnowledgeSourceDocument, type KnowledgeWorkspace } from '../../shared/knowledge-workspace-contracts';
import { isRecord } from './feature-input';
import type { SecretStorage } from './integration-settings';

const MAX_DOCUMENTS = 500;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_SERIALIZED_BYTES = MAX_TOTAL_BYTES + 1024 * 1024;
const MAX_ENVELOPE_BYTES = 64 * 1024 * 1024;
const SECRET_NAME = /(?:^|[-_.])(?:secrets?|credentials?|passwords?|tokens?|private[-_]?keys?)(?:[-_.]|$)|密码|密钥/i;
const SECRET_TEXT = /(?:OPENAI_API_KEY|DEEPSEEK_API_KEY|API_SECRET|ACCESS_TOKEN)\s*[:=]\s*\S+|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i;
const validId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(value);
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const summary = ({ body, ...document }: KnowledgeDocument): KnowledgeDocumentSummary => ({ ...document, characters: body.length });
const shape = (value: unknown, keys: string[]): Record<string, unknown> => {
  if (!isRecord(value) || Object.keys(value).some((key) => !keys.includes(key))) throw new Error('本机资料参数无效');
  return value;
};

function hasControlCharacters(text: string, multiline = false): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 127 || (code < 32 && !(multiline && (code === 9 || code === 10 || code === 13)))) return true;
  }
  return false;
}

function expiryTime(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw new Error('资料有效日期需为 YYYY-MM-DD 或不设日期');
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) throw new Error('资料有效日期不是有效的日历日期');
  return timestamp + 16 * 60 * 60 * 1000 - 1;
}

function draftInput(value: Record<string, unknown>): KnowledgeDraftInput {
  if (typeof value.title !== 'string' || !value.title.trim() || value.title.length > KNOWLEDGE_TITLE_MAX_LENGTH
    || hasControlCharacters(value.title)) throw new Error(`资料标题需为 1 至 ${KNOWLEDGE_TITLE_MAX_LENGTH} 字的单行文字`);
  if (typeof value.body !== 'string' || !value.body.trim() || value.body.length > KNOWLEDGE_BODY_MAX_LENGTH
    || hasControlCharacters(value.body, true)) throw new Error(`资料正文需为 1 至 ${KNOWLEDGE_BODY_MAX_LENGTH} 字的纯文字，不会自动截断`);
  if (Buffer.byteLength(value.body, 'utf8') > MAX_FILE_BYTES) throw new Error('单份资料不得超过 2MB，不会自动截断正文');
  if (SECRET_TEXT.test(value.body)) throw new Error('资料中疑似包含密钥等敏感凭据，请移除后重新导入');
  expiryTime(value.expiry);
  return { title: value.title.trim(), body: value.body.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n').trim(), expiry: value.expiry as string | null };
}

function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error('资料时间无效');
  return value;
}

function assertSerializedCapacity(plaintext: string): void {
  if (Buffer.byteLength(plaintext, 'utf8') > MAX_SERIALIZED_BYTES) throw new Error('本机资料序列化后超过 21MB 安全上限（含文字转义和元数据），未写入；请减少资料内容');
}

/** One encrypted, fixed-path inbox. Original files and external knowledge folders are never written. */
export class KnowledgeRepository {
  private documents: KnowledgeDocument[] = [];
  private fileDigest: string | null = null;
  private loadError: string | null = null;

  constructor(private readonly filePath: string, private readonly secrets: SecretStorage) {
    try {
      this.assertPath();
      if (!existsSync(filePath)) return;
      if (!secrets.isEncryptionAvailable()) throw new Error('encryption unavailable');
      const bytes = this.readEnvelope();
      if (!bytes) return;
      const envelope = JSON.parse(bytes.toString('utf8')) as unknown;
      if (!isRecord(envelope) || envelope.version !== 1 || typeof envelope.encrypted !== 'string'
        || !/^[A-Za-z0-9+/]+={0,2}$/u.test(envelope.encrypted)) throw new Error('invalid envelope');
      const plaintext = secrets.decryptString(Buffer.from(envelope.encrypted, 'base64'));
      assertSerializedCapacity(plaintext);
      const payload = JSON.parse(plaintext) as unknown;
      if (!isRecord(payload) || payload.version !== 1 || !Array.isArray(payload.documents)) throw new Error('invalid payload');
      const ids = new Set<string>();
      const loaded = payload.documents.map((item): KnowledgeDocument => {
        if (!isRecord(item) || !validId(item.id) || ids.has(item.id) || !Number.isSafeInteger(item.revision) || Number(item.revision) < 1
          || !['draft', 'approved', 'disabled'].includes(String(item.status)) || typeof item.status !== 'string'
          || !['manual', 'file'].includes(String(item.sourceKind)) || typeof item.sourceKind !== 'string'
          || (item.sourceName !== null && (typeof item.sourceName !== 'string' || item.sourceName.length > 255 || /[\\/]/u.test(item.sourceName) || hasControlCharacters(item.sourceName)))
          || (item.sourceKind === 'manual' && item.sourceName !== null) || (item.sourceKind === 'file' && !item.sourceName)
          || (item.status === 'approved' ? item.approvedAt === null : item.approvedAt !== null)) throw new Error('invalid document');
        ids.add(item.id);
        const content = draftInput(item);
        return { ...content, id: item.id, revision: item.revision as number, status: item.status as KnowledgeDocument['status'],
          sourceKind: item.sourceKind as KnowledgeDocument['sourceKind'], sourceName: item.sourceName as string | null,
          createdAt: timestamp(item.createdAt), updatedAt: timestamp(item.updatedAt), approvedAt: item.approvedAt === null ? null : timestamp(item.approvedAt) };
      });
      this.assertCapacity(loaded);
      this.documents = loaded;
      this.fileDigest = digest(bytes);
    } catch { this.loadError = '已有本机知识资料无法安全读取，未覆盖原文件；请保留文件并检查系统安全存储'; }
  }

  list(): KnowledgeWorkspace {
    this.assertAvailable();
    const counts = { total: this.documents.length, draft: 0, approved: 0, disabled: 0, expired: 0 };
    for (const document of this.documents) {
      const end = expiryTime(document.expiry);
      if (document.status === 'approved' && end !== null && end < Date.now()) counts.expired += 1;
      else counts[document.status] += 1;
    }
    return { documents: this.documents.map(summary).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)), counts };
  }

  get(id: string): KnowledgeDocument {
    this.assertAvailable();
    if (!validId(id)) throw new Error('请选择有效的本机资料');
    const document = this.documents.find((item) => item.id === id);
    if (!document) throw new Error('本机资料不存在，请刷新列表');
    return { ...document };
  }

  createDraft(input: KnowledgeDraftInput): KnowledgeDocument {
    const value = draftInput(shape(input, ['title', 'body', 'expiry']));
    return this.create(value, 'manual', null);
  }

  saveDraft(input: KnowledgeDocumentSaveInput): KnowledgeDocument {
    const value = shape(input, ['id', 'expectedRevision', 'title', 'body', 'expiry']);
    const content = draftInput(value);
    const previous = this.currentRevision(value);
    const next: KnowledgeDocument = { ...previous, ...content, revision: previous.revision + 1, status: 'draft', approvedAt: null, updatedAt: new Date(Date.now()).toISOString() };
    this.persist(this.documents.map((item) => item.id === next.id ? next : item));
    return { ...next };
  }

  setStatus(input: KnowledgeDocumentStatusInput): KnowledgeDocument {
    const value = shape(input, ['id', 'expectedRevision', 'status']);
    if (typeof value.status !== 'string' || !['draft', 'approved', 'disabled'].includes(value.status)) throw new Error('资料审核状态无效');
    const previous = this.currentRevision(value);
    if (previous.status === value.status) return { ...previous };
    if (value.status === 'approved' && previous.status !== 'draft') throw new Error('停用资料需先恢复为待审核，再人工批准');
    const end = expiryTime(previous.expiry);
    if (value.status === 'approved' && end !== null && end < Date.now()) throw new Error('资料已过期，请先修订有效日期再审核');
    const now = new Date(Date.now()).toISOString();
    const next: KnowledgeDocument = { ...previous, status: value.status as KnowledgeDocument['status'], revision: previous.revision + 1,
      updatedAt: now, approvedAt: value.status === 'approved' ? now : null };
    this.persist(this.documents.map((item) => item.id === next.id ? next : item));
    return { ...next };
  }

  async importFiles(paths: string[], options: { signal?: AbortSignal } = {}): Promise<KnowledgeImportResult> {
    if (!Array.isArray(paths) || !paths.length || paths.length > KNOWLEDGE_IMPORT_MAX_FILES) throw new Error(`每批请选择 1 至 ${KNOWLEDGE_IMPORT_MAX_FILES} 份资料`);
    if (paths.some((file) => typeof file !== 'string' || file.length > 4096 || !path.isAbsolute(file))) throw new Error('导入资料路径无效，请使用文件选择窗口');
    this.assertAvailable();
    const result: KnowledgeImportResult = { imported: [], skipped: [] };
    for (const file of paths) {
      if (options.signal?.aborted) throw new Error('资料导入已取消，已经保存的待审核资料会保留');
      const name = path.basename(file);
      try {
        if (!['.md', '.txt'].includes(path.extname(name).toLowerCase())) throw new Error('仅支持 Markdown 或 TXT，其他格式请先转为纯文字');
        if (SECRET_NAME.test(name)) throw new Error('文件名疑似包含敏感凭据，不会导入公司知识');
        const stat = await lstat(file);
        if (options.signal?.aborted) throw new Error('资料导入已取消，已经保存的待审核资料会保留');
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('请选择实际的文字文件，不支持符号链接或文件夹');
        if (stat.size > MAX_FILE_BYTES) throw new Error('单份资料不得超过 2MB，不会自动截断正文');
        const bytes = await readFile(file);
        if (options.signal?.aborted) throw new Error('资料导入已取消，已经保存的待审核资料会保留');
        if (bytes.length > MAX_FILE_BYTES) throw new Error('单份资料不得超过 2MB，不会自动截断正文');
        let body: string;
        try { body = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
        catch { throw new Error('文件不是有效 UTF-8 文字，请另存为 UTF-8 后重试'); }
        const title = body.match(/^#\s+(.+?)\s*#*\s*$/mu)?.[1] ?? path.basename(name, path.extname(name));
        const content = draftInput({ title, body, expiry: null });
        const saved = this.create(content, 'file', name);
        result.imported.push(summary(saved));
      } catch (error) {
        if (options.signal?.aborted) throw new Error('资料导入已取消，已经保存的待审核资料会保留');
        const message = error instanceof Error && /^[\u3400-\u9fff]/u.test(error.message) && !/[a-z]:[\\/]/iu.test(error.message)
          ? error.message : '文件无法读取，请检查文件是否可用';
        result.skipped.push({ name, error: message });
      }
    }
    return result;
  }

  approvedDocuments(): KnowledgeSourceDocument[] {
    this.assertAvailable();
    return this.documents.filter((document) => {
      const end = expiryTime(document.expiry);
      return document.status === 'approved' && (end === null || end >= Date.now());
    }).map(({ id, revision, title, body, expiry }) => ({ id, revision, title, body, expiry }));
  }

  private create(content: KnowledgeDraftInput, sourceKind: KnowledgeDocument['sourceKind'], sourceName: string | null): KnowledgeDocument {
    this.assertAvailable();
    if (this.documents.some((item) => digest(item.body) === digest(content.body))) throw new Error('相同正文资料已存在，已跳过重复导入；请在原资料中修订或恢复审核');
    const now = new Date(Date.now()).toISOString();
    const document: KnowledgeDocument = { ...content, id: randomUUID(), revision: 1, status: 'draft', sourceKind, sourceName, createdAt: now, updatedAt: now, approvedAt: null };
    this.persist([...this.documents, document]);
    return { ...document };
  }

  private currentRevision(value: Record<string, unknown>): KnowledgeDocument {
    if (!validId(value.id) || !Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 1) throw new Error('资料身份或版本无效，请刷新列表');
    const current = this.get(value.id);
    if (current.revision !== value.expectedRevision || current.revision >= Number.MAX_SAFE_INTEGER) throw new Error('资料版本已变化，未覆盖新内容；请刷新后重新修改');
    return current;
  }

  private assertPath(): void {
    if (!path.isAbsolute(this.filePath)) throw new Error('本机资料存储路径无效');
    let parent = path.dirname(this.filePath);
    while (!existsSync(parent) && path.dirname(parent) !== parent) parent = path.dirname(parent);
    if (existsSync(parent) && path.resolve(realpathSync(parent)).toLowerCase() !== path.resolve(parent).toLowerCase()) throw new Error('本机资料存储目录已被重定向');
    if (existsSync(this.filePath) && (lstatSync(this.filePath).isSymbolicLink() || !lstatSync(this.filePath).isFile())) throw new Error('本机资料存储文件不安全');
  }

  private readEnvelope(): Buffer | null {
    this.assertPath();
    if (!existsSync(this.filePath)) return null;
    if (lstatSync(this.filePath).size > MAX_ENVELOPE_BYTES) throw new Error('本机资料文件超过安全读取上限，未覆盖');
    const bytes = readFileSync(this.filePath);
    if (bytes.length > MAX_ENVELOPE_BYTES) throw new Error('本机资料文件超过安全读取上限，未覆盖');
    return bytes;
  }

  private assertAvailable(): void {
    if (this.loadError) throw new Error(this.loadError);
    const bytes = this.readEnvelope();
    if ((bytes === null ? null : digest(bytes)) !== this.fileDigest) throw new Error('本机资料文件已被其他进程修改，未覆盖；请重新打开软件后查看');
    if (bytes !== null && !this.secrets.isEncryptionAvailable()) throw new Error('本机安全存储不可用，暂不能读取已有资料');
  }

  private assertCapacity(documents: KnowledgeDocument[]): void {
    if (documents.length > MAX_DOCUMENTS) throw new Error('本机知识库最多保存 500 份资料，未新增或裁切任何正文');
    if (documents.reduce((size, document) => size + Buffer.byteLength(document.body, 'utf8'), 0) > MAX_TOTAL_BYTES) throw new Error('本机知识资料正文总量不得超过 20MB，未自动裁切资料');
  }

  private persist(documents: KnowledgeDocument[]): void {
    this.assertAvailable();
    if (!this.secrets.isEncryptionAvailable()) throw new Error('本机安全存储不可用，暂不能保存公司资料');
    this.assertCapacity(documents);
    const plaintext = JSON.stringify({ version: 1, documents });
    assertSerializedCapacity(plaintext);
    let serialized: string;
    try { serialized = JSON.stringify({ version: 1, encrypted: this.secrets.encryptString(plaintext).toString('base64') }); }
    catch { throw new Error('本机资料加密失败，未写入文件'); }
    if (Buffer.byteLength(serialized, 'utf8') > MAX_ENVELOPE_BYTES) throw new Error('本机资料加密文件超过容量上限，未写入');
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    const lockPath = `${this.filePath}.lock`;
    let lock: number | undefined;
    let temporaryCreated = false;
    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true });
      this.assertPath();
      try { lock = openSync(lockPath, 'wx', 0o600); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('本机资料正在保存或上次保存未正常结束，请稍后重试或检查保存锁；未覆盖资料'); throw error; }
      this.assertAvailable();
      const output = openSync(temporary, 'wx', 0o600);
      temporaryCreated = true;
      try { writeFileSync(output, serialized, 'utf8'); fsyncSync(output); }
      finally { closeSync(output); }
      renameSync(temporary, this.filePath);
      this.documents = documents;
      this.fileDigest = digest(serialized);
    } catch (error) {
      if (error instanceof Error && /^[\u3400-\u9fff]/u.test(error.message)) throw error;
      throw new Error('本机资料保存失败，原资料未被覆盖');
    } finally {
      if (temporaryCreated && existsSync(temporary)) { try { unlinkSync(temporary); } catch { /* Preserve original data on cleanup failure. */ } }
      if (lock !== undefined) {
        closeSync(lock);
        try { unlinkSync(lockPath); } catch { /* A leftover lock blocks later saves rather than overwriting another writer. */ }
      }
    }
  }
}
