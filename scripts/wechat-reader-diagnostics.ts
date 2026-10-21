import { app } from 'electron';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { findWechatDatabaseFiles } from '../src/main/adapters/wechat-native/wechat-database-files';
import { openReadonlyWechatProcess, scanWechatDatabaseKeys } from '../src/main/adapters/wechat-native/wechat-readonly-memory';
import { loadSqliteReader, type SqliteReadOnlyDatabase } from '../src/main/adapters/wechat-native/sqlite-reader';
import { WechatMessageStore } from '../src/main/adapters/wechat-native/wechat-message-store';
import { createAccountKey, normalizeWechatAccountName } from '../src/main/adapters/wechat-native/native-normalize';
import { probeWechatNativeResources } from '../src/main/adapters/wechat-native/probe';
import runtime from '../src/main/adapters/wechat-native/adapter-runtime-data.json';
import { findWechatProcessIds } from '../src/main/services/wechat-processes';

// Explicit local, read-only diagnostic. Output contains only aggregate counts,
// fixed schema-field names and codes, never SQL, account identity, content or keys.
const root = process.cwd();
const temporaryData = path.join(root, 'outputs', 'wechat-reader-diagnostics', 'user-data');
mkdirSync(temporaryData, { recursive: true });
app.setName('Fapai Reader Diagnostics');
app.setPath('userData', temporaryData);
app.disableHardwareAcceleration();

void app.whenReady().then(async () => {
  const opened: SqliteReadOnlyDatabase[] = [];
  let keys: Map<string, Buffer> | undefined;
  const headerBuffers: Buffer[] = [];
  let exitCode = 1;
  try {
    const config = JSON.parse(await readFile(path.join(app.getPath('appData'), 'LingxuCopilotPublic', 'wechat-source.json'), 'utf8'));
    if (typeof config.accountRoot !== 'string' || !path.isAbsolute(config.accountRoot)) throw new Error('configuration');
    const resourceRoot = path.join(root, 'native-resources', 'wechat-reader');
    if (!(await probeWechatNativeResources(resourceRoot)).available) throw new Error('resources');
    const koffiPath = path.join(root, 'native-resources', 'koffi', 'win32_x64', 'koffi.node');
    const moduleBytes = await readFile(koffiPath);
    if (moduleBytes.length !== runtime.size || createHash('sha256').update(moduleBytes).digest('hex') !== runtime.sha256) throw new Error('runtime');
    const koffi = createRequire(__filename)(koffiPath) as typeof import('koffi');
    const reader = loadSqliteReader(koffi, path.join(resourceRoot, 'sqlite3mc.dll'));
    reader.preflight();
    const files = await findWechatDatabaseFiles(config.accountRoot);
    headerBuffers.push(...files.map((file) => file.pageOne));
    keys = await scanWechatDatabaseKeys((pid) => openReadonlyWechatProcess(koffi, pid), await findWechatProcessIds(), files);
    console.log(JSON.stringify({ phase: 'databases', databaseCount: files.length, verifiedCount: keys.size }));
    const metadata: { category: string; missing?: string[]; blankSenderNames?: number; otherSenderTypes?: number; blankSenderMessageTypes?: number[] }[] = [];
    const sources = files.filter((file) => keys?.has(file.id)).map((file) => {
      const key = keys?.get(file.id);
      if (!key) throw new Error('credentials');
      const database = reader.openReadOnly(file.path, key);
      key.fill(0);
      opened.push(database);
      const messageTypes = new Map<string, Set<number>>();
      return {
        id: file.id, kind: file.kind,
        db: {
          query: (sql: string, parameters: readonly (string | number | Buffer | null)[]) => {
            const rows = database.query(sql, parameters);
            if (sql.includes('AS real_sender_id')) {
              messageTypes.clear();
              for (const row of rows) {
                if (typeof row.real_sender_id === 'string' && typeof row.local_type === 'string' && /^\d{1,20}$/u.test(row.local_type)) {
                  const types = messageTypes.get(row.real_sender_id) ?? new Set<number>();
                  types.add(Number(BigInt(row.local_type) & 0xffffn));
                  messageTypes.set(row.real_sender_id, types);
                }
              }
            }
            if (sql.startsWith('PRAGMA table_info') && rows.length) {
              const category = sql.includes('Msg_') ? 'message' : sql.includes('Name2Id') ? 'senderMap' : 'core';
              const expected = category === 'message'
                ? ['local_id', 'server_id', 'local_type', 'sort_seq', 'real_sender_id', 'create_time', 'message_content']
                : category === 'senderMap' ? ['user_name'] : [];
              const present = new Set(rows.map((row) => row.name));
              const missing = expected.filter((name) => !present.has(name));
              if (missing.length) metadata.push({ category, missing });
            }
            if (sql.includes('AS sender_id, user_name')) {
              const blank = rows.filter((row) => typeof row.user_name === 'string' && !row.user_name.trim()).length;
              const other = rows.filter((row) => typeof row.user_name !== 'string').length;
              if (blank || other) metadata.push({ category: 'senderMap', blankSenderNames: blank, otherSenderTypes: other,
                blankSenderMessageTypes: [...new Set(rows.filter((row) => typeof row.user_name === 'string' && !row.user_name.trim())
                  .flatMap((row) => [...(messageTypes.get(String(row.sender_id)) ?? [])]))].sort((left, right) => left - right) });
            }
            return rows;
          },
        },
      };
    });
    const store = new WechatMessageStore({
      databases: sources, accountName: normalizeWechatAccountName(path.basename(config.accountRoot)),
      accountKey: createAccountKey(config.accountRoot),
    });
    const conversations = store.listConversations();
    const contacts = [...conversations.filter((item) => item.kind === 'contact').slice(0, 8),
      ...conversations.filter((item) => item.kind === 'group').slice(0, 2)];
    for (let index = 0; index < contacts.length; index += 1) {
      metadata.length = 0;
      try {
        const messages = store.readMessages(contacts[index].username, 100);
        console.log(JSON.stringify({ phase: 'sample', index, kind: contacts[index].kind, count: messages.length,
          incoming: messages.filter((item) => item.direction === 'incoming').length,
          outgoing: messages.filter((item) => item.direction === 'outgoing').length }));
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'check.unknown';
        const stack = error instanceof Error ? error.stack ?? '' : '';
        const locations = ['usernameOf', 'requireColumns', 'readMessages', 'senderNames', 'columns', 'messageText', 'integerOf']
          .filter((name) => stack.includes(` ${name} (`) || stack.includes(`.${name} (`));
        console.log(JSON.stringify({ phase: 'sample', index, kind: contacts[index].kind, code: /^[a-zA-Z.]{1,64}$/u.test(code) ? code : 'check.unknown', locations, metadata }));
      }
    }
    exitCode = 0;
  } catch {
    console.log(JSON.stringify({ phase: 'diagnostics', code: 'check.failed' }));
  } finally {
    for (const key of keys?.values() ?? []) key.fill(0);
    for (const header of headerBuffers) header.fill(0);
    for (const database of opened) { try { database.close(); } catch { /* Close the remaining handles. */ } }
    app.exit(exitCode);
  }
});
