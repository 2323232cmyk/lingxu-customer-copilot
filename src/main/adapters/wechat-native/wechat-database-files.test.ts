import { mkdir, mkdtemp, open, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { findWechatDatabaseFiles } from './wechat-database-files';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => {
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('copilot-account-fixture-')) {
      throw new Error('Refusing to remove an unexpected fixture directory');
    }
    return rm(root, { recursive: true, force: true });
  }));
  vi.clearAllMocks();
});
const fixture = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'copilot-account-fixture-'));
  roots.push(root);
  const account = path.join(root, '测试 account');
  for (const folder of ['session', 'contact', 'message', 'migrate']) {
    await mkdir(path.join(account, 'db_storage', folder), { recursive: true });
  }
  await writeFile(path.join(account, 'db_storage/session/session.db'), Buffer.alloc(4096, 0x31));
  await writeFile(path.join(account, 'db_storage/contact/contact.db'), Buffer.alloc(8192, 0x32));
  return account;
};

describe('selected WeChat database discovery', () => {
  it('limits reads to selected account databases and one encrypted page per file', async () => {
    const account = await fixture();
    await writeFile(path.join(account, 'db_storage/message/message_0.db'), Buffer.alloc(8192, 0x33));
    await writeFile(path.join(account, 'db_storage/message/message_resource.db'), Buffer.alloc(4096, 0x34));
    await writeFile(path.join(account, 'db_storage/message/other.db'), Buffer.alloc(4096));
    await writeFile(path.join(account, 'db_storage/migrate/message_4.db'), Buffer.alloc(4096));
    const files = await findWechatDatabaseFiles(account);
    expect(files.map((file) => file.id)).toEqual([
      'contact/contact.db', 'message/message_0.db', 'message/message_resource.db', 'session/session.db',
    ]);
    expect(files.every((file) => file.pageOne.length === 4096)).toBe(true);
  });

  it('rejects missing core databases without claiming a different account', async () => {
    const account = await fixture();
    await rm(path.join(account, 'db_storage/session/session.db'));
    await expect(findWechatDatabaseFiles(account)).rejects.toMatchObject({ code: 'database.missing' });
  });

  it('discovers confirmed optional avatar and emoji databases without requiring them', async () => {
    const account = await fixture();
    expect((await findWechatDatabaseFiles(account)).map((file) => file.kind)).toEqual(['contact', 'session']);
    await mkdir(path.join(account, 'db_storage/head_image'));
    await mkdir(path.join(account, 'db_storage/emoticon'));
    await writeFile(path.join(account, 'db_storage/head_image/head_image.db'), Buffer.alloc(4096, 0x35));
    await writeFile(path.join(account, 'db_storage/emoticon/emoticon.db'), Buffer.alloc(8192, 0x36));
    const files = await findWechatDatabaseFiles(account);
    expect(files.filter((file) => ['avatar', 'emoji'].includes(file.kind)).map((file) => ({ id: file.id, kind: file.kind })))
      .toEqual([{ id: 'emoticon/emoticon.db', kind: 'emoji' }, { id: 'head_image/head_image.db', kind: 'avatar' }]);
    expect(files.every((file) => file.pageOne.length === 4096)).toBe(true);
  });

  it('does not block core discovery on not-yet-created optional media databases', async () => {
    const account = await fixture();
    await writeFile(path.join(account, 'db_storage/message/head_image.db'), Buffer.alloc(0));
    await writeFile(path.join(account, 'db_storage/message/emoticon.db'), Buffer.alloc(20));
    await writeFile(path.join(account, 'db_storage/message/media_1.db'), Buffer.alloc(0));
    expect((await findWechatDatabaseFiles(account)).map((file) => file.kind)).toEqual(['contact', 'session']);
  });

  it('ignores a not-yet-created message shard but rejects a truncated core database', async () => {
    const account = await fixture();
    await writeFile(path.join(account, 'db_storage/message/message_1.db'), Buffer.alloc(0));
    expect((await findWechatDatabaseFiles(account)).length).toBe(2);
    await writeFile(path.join(account, 'db_storage/contact/contact.db'), Buffer.alloc(20));
    await expect(findWechatDatabaseFiles(account)).rejects.toMatchObject({ code: 'database.validationFailed' });
  });

  it('discovers numbered voice shards only inside the selected account', async () => {
    const account = await fixture();
    await writeFile(path.join(account, 'db_storage/message/media_0.db'), Buffer.alloc(4096, 0x37));
    await writeFile(path.join(account, 'db_storage/message/media_backup.db'), Buffer.alloc(4096));
    await writeFile(path.join(account, 'db_storage/migrate/media_2.db'), Buffer.alloc(4096));
    const files = await findWechatDatabaseFiles(account);
    expect(files.filter((file) => file.kind === 'voice').map((file) => file.id)).toEqual(['message/media_0.db']);
  });

  it('does not resolve a relative caller-controlled account path', async () => {
    await expect(findWechatDatabaseFiles('relative')).rejects.toMatchObject({ code: 'account.invalid' });
  });

  it('does not expose native filesystem messages or the selected path for a missing directory', async () => {
    const account = await fixture();
    const missing = path.join(account, 'private-missing-directory');
    let caught: unknown;
    try { await findWechatDatabaseFiles(missing); } catch (error) { caught = error; }
    expect(caught).toMatchObject({ code: 'database.validationFailed', name: 'WechatDatabaseFileError' });
    expect(String(caught)).not.toContain(account);
    expect(String(caught)).not.toContain('private-missing-directory');
  });

  it('rejects a db_storage junction targeting another account before opening any database', async () => {
    const other = await fixture();
    const account = path.join(roots[0], 'selected junction account');
    await mkdir(account);
    await symlink(path.join(other, 'db_storage'), path.join(account, 'db_storage'), 'junction');
    vi.mocked(open).mockClear();
    await expect(findWechatDatabaseFiles(account)).rejects.toMatchObject({ code: 'account.invalid' });
    expect(open).not.toHaveBeenCalled();
  });

  it('does not descend into nested account junctions', async () => {
    const account = await fixture();
    const other = await fixture();
    await symlink(path.join(other, 'db_storage'), path.join(account, 'db_storage/linked'), 'junction');
    const files = await findWechatDatabaseFiles(account);
    expect(files).toHaveLength(2);
    const storage = await realpath(path.join(account, 'db_storage'));
    expect(files.map((file) => path.relative(storage, file.path).replaceAll('\\', '/')))
      .toEqual(['contact/contact.db', 'session/session.db']);
  });

  it('returns the same canonical databases through a selected account directory alias', async () => {
    const account = await fixture();
    const alias = path.join(roots[0], 'selected-account-alias');
    await symlink(account, alias, 'junction');
    const direct = await findWechatDatabaseFiles(account);
    const aliased = await findWechatDatabaseFiles(alias);
    expect(aliased.map(({ id, path: filename }) => ({ id, filename })))
      .toEqual(direct.map(({ id, path: filename }) => ({ id, filename })));
    expect(aliased).toHaveLength(2);
  });

  it('erases collected and partial pages and closes every handle when a later read throws', async () => {
    const account = await fixture();
    const pages: Buffer[] = [];
    const firstClose = vi.fn(async () => undefined);
    const secondClose = vi.fn(async () => undefined);
    const first = {
      read: async (buffer: Buffer) => { buffer.fill(0x61); pages.push(buffer); return { bytesRead: 4096, buffer }; },
      close: firstClose,
    };
    const second = {
      read: async (buffer: Buffer) => { buffer.fill(0x62); pages.push(buffer); throw new Error('PRIVATE_PATH PRIVATE_PAGE'); },
      close: secondClose,
    };
    vi.mocked(open)
      .mockResolvedValueOnce(first as unknown as Awaited<ReturnType<typeof open>>)
      .mockResolvedValueOnce(second as unknown as Awaited<ReturnType<typeof open>>);
    await expect(findWechatDatabaseFiles(account)).rejects.toMatchObject({ code: 'database.validationFailed' });
    expect(firstClose).toHaveBeenCalledOnce();
    expect(secondClose).toHaveBeenCalledOnce();
    expect(pages).toHaveLength(2);
    expect(pages.every((buffer) => buffer.every((value) => value === 0))).toBe(true);
  });

  it('erases a page if closing its source handle fails after reading it', async () => {
    const account = await fixture();
    let page: Buffer | undefined;
    const close = vi.fn(async () => { throw new Error('PRIVATE_PATH'); });
    vi.mocked(open).mockResolvedValueOnce({
      read: async (buffer: Buffer) => { buffer.fill(0x63); page = buffer; return { bytesRead: 4096, buffer }; },
      close,
    } as unknown as Awaited<ReturnType<typeof open>>);
    await expect(findWechatDatabaseFiles(account)).rejects.toMatchObject({ code: 'database.validationFailed' });
    expect(page).toEqual(Buffer.alloc(4096));
    expect(close).toHaveBeenCalledOnce();
  });
});
