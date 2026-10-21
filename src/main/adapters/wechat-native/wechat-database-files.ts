import { open, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export interface WechatDatabaseFile {
  readonly id: string;
  readonly path: string;
  readonly kind: 'session' | 'contact' | 'message' | 'resource' | 'avatar' | 'emoji' | 'voice';
  readonly pageOne: Buffer;
}

export class WechatDatabaseFileError extends Error {
  constructor(readonly code: 'account.invalid' | 'database.missing' | 'database.validationFailed') {
    super('微信数据库目录或文件尚未通过检查');
    this.name = 'WechatDatabaseFileError';
  }
}

export const findWechatDatabaseFiles = async (accountRoot: string): Promise<WechatDatabaseFile[]> => {
  const files: WechatDatabaseFile[] = [];
  let pendingPage: Buffer | undefined;
  try {
    if (!path.isAbsolute(accountRoot)) throw new WechatDatabaseFileError('account.invalid');
    const root = await realpath(accountRoot);
    const storage = await realpath(path.join(root, 'db_storage'));
    const inside = (candidate: string, parent: string): boolean =>
      candidate.toLowerCase().startsWith(`${parent.toLowerCase()}${path.sep}`);
    if (!inside(storage, root)) throw new WechatDatabaseFileError('account.invalid');
    const queue = [{ directory: storage, depth: 0 }];
    let visited = 0;
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      for (const entry of await readdir(item.directory, { withFileTypes: true })) {
        if (++visited > 4000) throw new WechatDatabaseFileError('account.invalid');
        if (entry.isSymbolicLink()) continue;
        const target = path.join(item.directory, entry.name);
        if (entry.isDirectory() && item.depth < 2) {
          if (entry.name !== 'migrate') queue.push({ directory: target, depth: item.depth + 1 });
          continue;
        }
        if (!entry.isFile()) continue;
        const name = entry.name.toLowerCase();
        const kind = name === 'session.db' ? 'session' : name === 'contact.db' ? 'contact'
          : name === 'message_resource.db' ? 'resource' : /^message_\d+\.db$/u.test(name) ? 'message'
            : name === 'head_image.db' ? 'avatar' : name === 'emoticon.db' ? 'emoji'
              : /^media_\d+\.db$/u.test(name) ? 'voice' : null;
        if (!kind) continue;
        const canonical = await realpath(target);
        if (!inside(canonical, storage)) throw new WechatDatabaseFileError('account.invalid');
        if ((await stat(canonical)).size < 4096) {
          if (kind === 'message' || kind === 'resource' || kind === 'avatar' || kind === 'emoji' || kind === 'voice') continue;
          throw new WechatDatabaseFileError('database.validationFailed');
        }
        if (files.length >= 256) throw new WechatDatabaseFileError('account.invalid');
        const pageOne = Buffer.alloc(4096);
        pendingPage = pageOne;
        const handle = await open(canonical, 'r');
        try {
          if ((await handle.read(pageOne, 0, pageOne.length, 0)).bytesRead !== pageOne.length) {
            throw new WechatDatabaseFileError('database.validationFailed');
          }
          files.push({ id: path.relative(storage, canonical).replaceAll('\\', '/'), path: canonical, kind, pageOne });
        } finally {
          await handle.close();
        }
        pendingPage = undefined;
      }
    }
    if (!files.some((file) => file.kind === 'session') || !files.some((file) => file.kind === 'contact')) {
      throw new WechatDatabaseFileError('database.missing');
    }
    return files.sort((left, right) => left.id.localeCompare(right.id));
  } catch (error) {
    pendingPage?.fill(0);
    for (const file of files) file.pageOne.fill(0);
    // Filesystem exceptions include account paths. Only the fixed public code may leave this boundary.
    throw error instanceof WechatDatabaseFileError ? error : new WechatDatabaseFileError('database.validationFailed');
  }
};
