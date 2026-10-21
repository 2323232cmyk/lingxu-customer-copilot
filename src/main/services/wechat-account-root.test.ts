import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isWechatAccountRoot,
  resolveWechatAccountRootHint,
  saveWechatAccountRoot,
} from './wechat-account-root';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

const temporaryRoots: string[] = [];

const temporaryRoot = async (): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sales-copilot-wechat-'));
  temporaryRoots.push(root);
  return root;
};

beforeEach(() => vi.clearAllMocks());

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('wechat account root', () => {
  it('accepts only an absolute account directory containing db_storage', async () => {
    const root = await temporaryRoot();
    const account = path.join(root, 'wxid_test_1234');
    await mkdir(path.join(account, 'db_storage'), { recursive: true });
    expect(await isWechatAccountRoot(account)).toBe(true);
    expect(await isWechatAccountRoot(root)).toBe(false);
    expect(await isWechatAccountRoot('relative')).toBe(false);
  });

  it('does not read or migrate other applications settings even when they exist', async () => {
    const root = await temporaryRoot();
    const appData = path.join(root, 'AppData');
    const userData = path.join(root, 'CopilotData');
    const account = path.join(root, 'xwechat_files', 'wxid_test_1234');
    await mkdir(path.join(account, 'db_storage'), { recursive: true });
    await mkdir(path.join(appData, 'TraceMemo'), { recursive: true });
    await writeFile(
      path.join(appData, 'TraceMemo', 'settings.json'),
      JSON.stringify({ dbRoot: account, unrelated: 'ignored' }),
    );
    vi.stubEnv('APPDATA', appData);

    const result = await resolveWechatAccountRootHint({
      userDataPath: userData, homePath: path.join(root, 'Home'),
    });

    expect(result).toEqual({ accountRoot: null, source: null });
    expect(vi.mocked(readFile).mock.calls.map(([filePath]) => filePath))
      .toEqual([path.join(userData, 'wechat-source.json')]);
    await expect(stat(path.join(userData, 'wechat-source.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves a previously migrated selection saved by this application', async () => {
    const root = await temporaryRoot();
    const userData = path.join(root, 'CopilotData');
    const account = path.join(root, 'xwechat_files', 'wxid_test_1234');
    await mkdir(path.join(account, 'db_storage'), { recursive: true });
    await mkdir(userData, { recursive: true });
    const configPath = path.join(userData, 'wechat-source.json');
    const config = JSON.stringify({ version: 1, accountRoot: account, source: 'migrated' });
    await writeFile(configPath, config);

    await expect(resolveWechatAccountRootHint({ userDataPath: userData, homePath: root }))
      .resolves.toEqual({ accountRoot: account, source: 'migrated' });
    expect(vi.mocked(readFile).mock.calls.map(([filePath]) => filePath)).toEqual([configPath]);
    await expect(readFile(configPath, 'utf8')).resolves.toBe(config);
  });

  it.each([
    ['Documents', 'xwechat_files'],
    ['AppData', 'Roaming', 'Tencent', 'xwechat_files'],
  ])('still detects a standard account directory under %s', async (...parts) => {
    const root = await temporaryRoot();
    const userData = path.join(root, 'CopilotData');
    const account = path.join(root, ...parts);
    await mkdir(path.join(account, 'db_storage'), { recursive: true });

    await expect(resolveWechatAccountRootHint({ userDataPath: userData, homePath: root }))
      .resolves.toEqual({ accountRoot: path.resolve(account), source: 'detected' });
    await expect(resolveWechatAccountRootHint({ userDataPath: userData, homePath: root }))
      .resolves.toEqual({ accountRoot: path.resolve(account), source: 'detected' });
  });

  it('persists a manually selected account after validation', async () => {
    const root = await temporaryRoot();
    const userData = path.join(root, 'CopilotData');
    const account = path.join(root, 'wxid_test_1234');
    await mkdir(path.join(account, 'db_storage'), { recursive: true });

    await saveWechatAccountRoot(userData, account);
    await expect(resolveWechatAccountRootHint({ userDataPath: userData, homePath: root }))
      .resolves.toEqual({ accountRoot: path.resolve(account), source: 'selected' });
  });
});
