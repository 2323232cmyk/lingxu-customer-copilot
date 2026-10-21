import { readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

interface StoredWechatSource {
  version: 1;
  accountRoot: string;
  source: 'selected' | 'migrated' | 'detected';
}

const isDirectory = async (target: string): Promise<boolean> => {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
};

export const isWechatAccountRoot = async (target: string): Promise<boolean> => {
  if (!target || !path.isAbsolute(target)) return false;
  return isDirectory(path.join(path.resolve(target), 'db_storage'));
};

const parseStoredSource = async (filePath: string): Promise<StoredWechatSource | null> => {
  try {
    const value = JSON.parse(await readFile(filePath, 'utf8')) as Partial<StoredWechatSource>;
    if (
      value.version !== 1
      || typeof value.accountRoot !== 'string'
      || !['selected', 'migrated', 'detected'].includes(value.source ?? '')
      || !await isWechatAccountRoot(value.accountRoot)
    ) {
      return null;
    }
    return value as StoredWechatSource;
  } catch {
    return null;
  }
};

const detectStandardRoot = async (homePath: string): Promise<string | null> => {
  const candidates = [
    path.join(homePath, 'Documents', 'xwechat_files'),
    path.join(homePath, 'AppData', 'Roaming', 'Tencent', 'xwechat_files'),
  ];
  for (const candidate of candidates) {
    if (await isWechatAccountRoot(candidate)) return path.resolve(candidate);
  }
  return null;
};

export interface ResolveWechatRootOptions {
  userDataPath: string;
  homePath?: string;
}

export const resolveWechatAccountRootHint = async (
  options: ResolveWechatRootOptions,
): Promise<{ accountRoot: string | null; source: StoredWechatSource['source'] | null }> => {
  const configPath = path.join(options.userDataPath, 'wechat-source.json');
  const stored = await parseStoredSource(configPath);
  if (stored) return { accountRoot: stored.accountRoot, source: stored.source };

  const detected = await detectStandardRoot(options.homePath ?? os.homedir());
  if (!detected) return { accountRoot: null, source: null };

  const source = 'detected';
  await mkdir(options.userDataPath, { recursive: true });
  await writeFile(
    configPath,
    JSON.stringify({ version: 1, accountRoot: detected, source } satisfies StoredWechatSource),
    { encoding: 'utf8', mode: 0o600 },
  );
  return { accountRoot: detected, source };
};

export const saveWechatAccountRoot = async (
  userDataPath: string,
  accountRoot: string,
): Promise<void> => {
  if (!await isWechatAccountRoot(accountRoot)) {
    throw new Error('所选目录不是有效的微信 4.x 账号目录');
  }
  await mkdir(userDataPath, { recursive: true });
  await writeFile(
    path.join(userDataPath, 'wechat-source.json'),
    JSON.stringify({
      version: 1,
      accountRoot: path.resolve(accountRoot),
      source: 'selected',
    } satisfies StoredWechatSource),
    { encoding: 'utf8', mode: 0o600 },
  );
};
