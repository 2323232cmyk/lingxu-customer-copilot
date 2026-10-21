import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LocalPlan, LocalPlanCreateInput, LocalPlanUpdateInput } from '../../shared/local-plan-contracts';
import { LocalPlanStore } from './local-plan-store';

const folders: string[] = [];
const accountKey = 'account-one';
const dueAt = '2026-09-01T10:00:00+08:00';
function setup() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'lingxu-local-plan-test-')); folders.push(directory);
  const file = path.join(directory, 'local-plans.enc.json');
  const key = randomBytes(32);
  const secrets = {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((text: string) => {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const bytes = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), bytes]);
    }),
    decryptString: vi.fn((bytes: Buffer) => {
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
    }),
  };
  return { directory, file, secrets, store: new LocalPlanStore(file, secrets) };
}
afterEach(() => {
  vi.useRealTimers();
  for (const folder of folders.splice(0)) {
    const resolved = path.resolve(folder);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('lingxu-local-plan-test-')) throw new Error('Unsafe test cleanup');
    rmSync(resolved, { recursive: true, force: true });
  }
});

describe('encrypted local plans', () => {
  it('does not create data on construction or listing', () => {
    const test = setup();
    expect(test.store.list(accountKey)).toEqual([]);
    expect(existsSync(test.file)).toBe(false);
    expect(test.secrets.encryptString).not.toHaveBeenCalled();
  });

  it('persists only encrypted data and restores plans after restart', () => {
    const test = setup();
    const plan = test.store.create({ accountKey, title: '  联系客户确认时间  ', dueAt });
    expect(plan).toMatchObject({ title: '联系客户确认时间', dueAt: '2026-09-01T02:00:00.000Z', done: false });
    const stored = readFileSync(test.file, 'utf8');
    expect(stored).not.toContain(accountKey);
    expect(stored).not.toContain('联系客户确认时间');
    expect(stored).not.toContain(plan.id);
    expect(new LocalPlanStore(test.file, test.secrets).list(accountKey)).toEqual([plan]);
    expect(readdirSync(test.directory)).toEqual(['local-plans.enc.json']);
  });

  it('isolates listing, completion, editing and removal by account', () => {
    const test = setup();
    const first = test.store.create({ accountKey, title: '测试计划一', dueAt });
    const second = test.store.create({ accountKey: 'account-two', title: '测试计划二', dueAt });
    expect(test.store.list('account-two')).toEqual([second]);
    expect(() => test.store.update({ accountKey: 'account-two', id: first.id, done: true })).toThrow('没有这项');
    expect(() => test.store.delete({ accountKey: 'account-two', id: first.id })).toThrow('没有这项');
    expect(test.store.list(accountKey)).toEqual([first]);
  });

  it('handles completion/restoration idempotently without creating duplicate plans', () => {
    const test = setup();
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-08-31T10:00:00Z'));
    const first = test.store.create({ accountKey, title: '测试计划', dueAt });
    vi.setSystemTime(new Date('2026-08-31T11:00:00Z'));
    const done = test.store.update({ accountKey, id: first.id, done: true });
    const before = readFileSync(test.file);
    expect(done.updatedAt).not.toBe(first.updatedAt);
    vi.setSystemTime(new Date('2026-08-31T12:00:00Z'));
    expect(test.store.update({ accountKey, id: first.id, done: true })).toEqual(done);
    expect(readFileSync(test.file).equals(before)).toBe(true);
    const restored = test.store.update({ accountKey, id: first.id, done: false, title: '修改标题' });
    expect(restored).toMatchObject({ done: false, title: '修改标题', createdAt: first.createdAt });
    expect(test.store.list(accountKey)).toHaveLength(1);
    test.store.delete({ accountKey, id: first.id });
    expect(new LocalPlanStore(test.file, test.secrets).list(accountKey)).toEqual([]);
  });

  it('does not expose internal mutable references', () => {
    const test = setup();
    const plan = test.store.create({ accountKey, title: '不可外部修改', dueAt });
    plan.title = 'external';
    const listed = test.store.list(accountKey); listed[0].title = 'mutated';
    expect(test.store.list(accountKey)[0].title).toBe('不可外部修改');
  });

  it('rejects reads and writes without available OS encryption', () => {
    const test = setup();
    test.secrets.isEncryptionAvailable.mockReturnValue(false);
    expect(() => test.store.list(accountKey)).toThrow('安全存储不可用');
    expect(() => test.store.create({ accountKey, title: '不能明文保存', dueAt })).toThrow('安全存储不可用');
    expect(existsSync(test.file)).toBe(false);
  });

  it.each(['broken-json', 'undecryptable', 'invalid-payload'])('preserves a %s existing file rather than silently overwriting it', (kind) => {
    const test = setup();
    const original = kind === 'broken-json' ? '{invalid' : JSON.stringify({ version: 1, encrypted: kind === 'undecryptable' ? Buffer.from('wrong-key').toString('base64')
      : test.secrets.encryptString(JSON.stringify({ version: 1, accounts: [{ accountKey, plans: [{ id: 'not-a-plan' }] }] })).toString('base64') });
    writeFileSync(test.file, original);
    const store = new LocalPlanStore(test.file, test.secrets);
    expect(() => store.list(accountKey)).toThrow('未覆盖原文件');
    expect(() => store.create({ accountKey, title: '不能覆盖', dueAt })).toThrow('未覆盖原文件');
    expect(readFileSync(test.file, 'utf8')).toBe(original);
  });

  it('does not overwrite changes made by another process after opening', () => {
    const test = setup();
    const plan = test.store.create({ accountKey, title: '原计划', dueAt });
    writeFileSync(test.file, '{externally-changed');
    expect(() => test.store.update({ accountKey, id: plan.id, done: true })).toThrow('其他进程修改');
    expect(readFileSync(test.file, 'utf8')).toBe('{externally-changed');
  });

  it('keeps disk and in-memory plans unchanged if encryption fails', () => {
    const test = setup();
    const first = test.store.create({ accountKey, title: '原计划', dueAt });
    const before = readFileSync(test.file);
    test.secrets.encryptString.mockImplementation(() => { throw new Error('unavailable'); });
    expect(() => test.store.update({ accountKey, id: first.id, done: true })).toThrow('加密失败');
    expect(readFileSync(test.file).equals(before)).toBe(true);
    expect(test.store.list(accountKey)).toEqual([first]);
  });

  it.each([{ accountKey: '' }, { accountKey: '../../elsewhere' }, { title: '' }, { title: 'x'.repeat(201) }, { title: 'two\nlines' },
    { dueAt: 'tomorrow' }, { dueAt: '2026-09-01T10:00' }, { dueAt: '2026-02-30T10:00:00Z' }, { filePath: 'C:/unrelated' }])('rejects invalid create input %#', (patch) => {
    const test = setup();
    expect(() => test.store.create({ accountKey, title: 'test', dueAt, ...patch } as LocalPlanCreateInput)).toThrow();
    expect(existsSync(test.file)).toBe(false);
  });

  it.each([{ done: 'yes' }, { title: '' }, { dueAt: 'bad' }, { customerId: 8 }])('rejects invalid update input %#', (patch) => {
    const test = setup();
    const plan = test.store.create({ accountKey, title: 'test', dueAt });
    expect(() => test.store.update({ accountKey, id: plan.id, ...patch } as LocalPlanUpdateInput)).toThrow();
    expect(test.store.list(accountKey)).toEqual([plan]);
  });

  it.each(['per-account', 'total'] as const)('bounds %s storage without dropping existing plans', (limit) => {
    const test = setup();
    const now = new Date().toISOString();
    const entries = Array.from({ length: limit === 'total' ? 10 : 1 }, (_, accountIndex) => ({ accountKey: `account-${accountIndex}`, plans: Array.from({ length: 500 }, (): LocalPlan => ({
      id: randomUUID(), title: '测试历史计划', dueAt: new Date(dueAt).toISOString(), done: false, createdAt: now, updatedAt: now,
    })) }));
    writeFileSync(test.file, JSON.stringify({ version: 1, encrypted: test.secrets.encryptString(JSON.stringify({ version: 1, accounts: entries })).toString('base64') }));
    const store = new LocalPlanStore(test.file, test.secrets);
    const before = readFileSync(test.file);
    expect(() => store.create({ accountKey: limit === 'total' ? 'another-account' : 'account-0', title: '不能超过容量', dueAt })).toThrow(limit === 'total' ? '容量上限' : '500');
    expect(readFileSync(test.file).equals(before)).toBe(true);
  });
});
