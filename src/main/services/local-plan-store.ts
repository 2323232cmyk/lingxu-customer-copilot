import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { LocalPlan, LocalPlanCreateInput, LocalPlanDeleteInput, LocalPlanUpdateInput } from '../../shared/local-plan-contracts';
import { isRecord, opaqueKey } from './feature-input';
import type { SecretStorage } from './integration-settings';

const MAX_PER_ACCOUNT = 500;
const MAX_TOTAL = 5000;
const MAX_ACCOUNTS = 50;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const planId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(value);
const accountInput = (value: unknown): string => { if (!opaqueKey(value)) throw new Error('请选择有效的微信账号后再管理本机计划'); return value; };
const titleInput = (value: unknown): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new Error('计划标题需为 1 至 200 字的单行文字');
  return value.trim();
};
const dateInput = (value: unknown): string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('请选择有效的计划时间');
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) throw new Error('请选择有效的计划日期');
  return new Date(value).toISOString();
};
const shape = (value: unknown, keys: string[]): Record<string, unknown> => {
  if (!isRecord(value) || Object.keys(value).some((key) => !keys.includes(key))) throw new Error('本机计划参数无效');
  return value;
};

/** Encrypted, fixed-path, account-scoped local plans. Never writes to the CRM. */
export class LocalPlanStore {
  private accounts = new Map<string, LocalPlan[]>();
  private fileDigest: string | null = null;
  private loadError: string | null = null;

  constructor(private readonly filePath: string, private readonly secrets: SecretStorage) {
    if (!existsSync(filePath)) return;
    try {
      if (!secrets.isEncryptionAvailable() || statSync(filePath).size > MAX_FILE_BYTES) throw new Error('unreadable');
      const bytes = readFileSync(filePath);
      const envelope = JSON.parse(bytes.toString('utf8')) as unknown;
      if (!isRecord(envelope) || envelope.version !== 1 || typeof envelope.encrypted !== 'string'
        || !/^[A-Za-z0-9+/]+={0,2}$/u.test(envelope.encrypted)) throw new Error('invalid envelope');
      const plaintext = secrets.decryptString(Buffer.from(envelope.encrypted, 'base64'));
      if (Buffer.byteLength(plaintext, 'utf8') > MAX_FILE_BYTES) throw new Error('oversized');
      const payload = JSON.parse(plaintext) as unknown;
      if (!isRecord(payload) || payload.version !== 1 || !Array.isArray(payload.accounts) || payload.accounts.length > MAX_ACCOUNTS) throw new Error('invalid payload');
      const loaded = new Map<string, LocalPlan[]>();
      const ids = new Set<string>();
      let count = 0;
      for (const account of payload.accounts) {
        if (!isRecord(account) || !opaqueKey(account.accountKey) || loaded.has(account.accountKey) || !Array.isArray(account.plans) || account.plans.length > MAX_PER_ACCOUNT) throw new Error('invalid account');
        const plans = account.plans.map((item): LocalPlan => {
          if (!isRecord(item) || !planId(item.id) || ids.has(item.id) || typeof item.done !== 'boolean') throw new Error('invalid plan');
          ids.add(item.id);
          return { id: item.id, title: titleInput(item.title), dueAt: dateInput(item.dueAt), done: item.done,
            createdAt: dateInput(item.createdAt), updatedAt: dateInput(item.updatedAt) };
        });
        count += plans.length;
        if (count > MAX_TOTAL) throw new Error('too many plans');
        loaded.set(account.accountKey, plans);
      }
      this.accounts = loaded;
      this.fileDigest = digest(bytes);
    } catch { this.loadError = '已有本机计划无法安全读取，未覆盖原文件；请保留文件并检查系统安全存储'; }
  }

  list(accountKey: string): LocalPlan[] {
    const account = accountInput(accountKey);
    this.assertAvailable();
    return (this.accounts.get(account) ?? []).map((plan) => ({ ...plan })).sort((a, b) => Number(a.done) - Number(b.done) || a.dueAt.localeCompare(b.dueAt) || a.id.localeCompare(b.id));
  }

  create(input: LocalPlanCreateInput): LocalPlan {
    const value = shape(input, ['accountKey', 'title', 'dueAt']);
    const account = accountInput(value.accountKey);
    const title = titleInput(value.title);
    const dueAt = dateInput(value.dueAt);
    this.assertAvailable();
    const plans = this.accounts.get(account) ?? [];
    if (plans.length >= MAX_PER_ACCOUNT) throw new Error('当前账号最多保留 500 项本机计划，请清理已完成计划');
    if ([...this.accounts.values()].reduce((sum, rows) => sum + rows.length, 0) >= MAX_TOTAL
      || (!this.accounts.has(account) && this.accounts.size >= MAX_ACCOUNTS)) throw new Error('本机计划存储已达到容量上限，请先清理历史计划');
    const now = new Date().toISOString();
    const plan: LocalPlan = { id: randomUUID(), title, dueAt, done: false, createdAt: now, updatedAt: now };
    this.persist(account, [...plans, plan]);
    return { ...plan };
  }

  update(input: LocalPlanUpdateInput): LocalPlan {
    const value = shape(input, ['accountKey', 'id', 'title', 'dueAt', 'done']);
    const account = accountInput(value.accountKey);
    if (!planId(value.id) || !['title', 'dueAt', 'done'].some((key) => value[key] !== undefined)
      || (value.done !== undefined && typeof value.done !== 'boolean')) throw new Error('请选择有效的本机计划修改内容');
    const patch = { ...(value.title === undefined ? {} : { title: titleInput(value.title) }), ...(value.dueAt === undefined ? {} : { dueAt: dateInput(value.dueAt) }),
      ...(value.done === undefined ? {} : { done: value.done as boolean }) };
    this.assertAvailable();
    const plans = this.accounts.get(account) ?? [];
    const previous = plans.find((plan) => plan.id === value.id);
    if (!previous) throw new Error('当前微信账号没有这项本机计划');
    const next = { ...previous, ...patch };
    if (next.title === previous.title && next.dueAt === previous.dueAt && next.done === previous.done) return { ...previous };
    next.updatedAt = new Date().toISOString();
    this.persist(account, plans.map((plan) => plan.id === next.id ? next : plan));
    return { ...next };
  }

  delete(input: LocalPlanDeleteInput): void {
    const value = shape(input, ['accountKey', 'id']);
    const account = accountInput(value.accountKey);
    if (!planId(value.id)) throw new Error('请选择有效的本机计划');
    this.assertAvailable();
    const plans = this.accounts.get(account) ?? [];
    if (!plans.some((plan) => plan.id === value.id)) throw new Error('当前微信账号没有这项本机计划');
    this.persist(account, plans.filter((plan) => plan.id !== value.id));
  }

  private assertAvailable(): void {
    if (this.loadError) throw new Error(this.loadError);
    if (!this.secrets.isEncryptionAvailable()) throw new Error('本机安全存储不可用，暂不能读取或保存计划');
    if (existsSync(this.filePath) && statSync(this.filePath).size > MAX_FILE_BYTES) throw new Error('本机计划文件过大，未读取或覆盖');
    const current = existsSync(this.filePath) ? digest(readFileSync(this.filePath)) : null;
    if (current !== this.fileDigest) throw new Error('本机计划文件已被其他进程修改，未覆盖；请重新打开软件后查看');
  }

  private persist(accountKey: string, plans: LocalPlan[]): void {
    const next = new Map(this.accounts);
    if (plans.length) next.set(accountKey, plans); else next.delete(accountKey);
    const plaintext = JSON.stringify({ version: 1, accounts: [...next].map(([accountKey, plans]) => ({ accountKey, plans })) });
    let serialized: string;
    try { serialized = JSON.stringify({ version: 1, encrypted: this.secrets.encryptString(plaintext).toString('base64') }); }
    catch { throw new Error('本机计划加密失败，未写入文件'); }
    if (Buffer.byteLength(serialized, 'utf8') > MAX_FILE_BYTES) throw new Error('本机计划文件过大，未写入');
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true });
      writeFileSync(temporary, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      renameSync(temporary, this.filePath);
    } catch {
      try { if (existsSync(temporary)) unlinkSync(temporary); } catch { /* Preserve the original file on write failure. */ }
      throw new Error('本机计划保存失败，原计划未被覆盖');
    }
    this.accounts = next;
    this.fileDigest = digest(Buffer.from(serialized, 'utf8'));
  }
}
