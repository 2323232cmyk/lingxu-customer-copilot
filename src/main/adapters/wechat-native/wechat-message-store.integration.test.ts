import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { loadSqliteReader, type SqliteReadOnlyDatabase } from './sqlite-reader';
import { WechatMessageStore, type WechatMessageDatabase } from './wechat-message-store';

const nativeDll = resolve('native-resources/wechat-reader/sqlite3mc.dll');
const DLL_SHA256 = '5030decc6d914539e3b9b7e28aa4f6de1e7161dac6fd4b21eb02e6754d9b175e';
const TEMP_PREFIX = 'copilot-message-integration-';
const SELF = 'wxid_integration_self';
const PEER = 'wxid_integration_peer';
const BASE_TIME = 1788105600;

// Real native engine, but every database, key, name and message is created by this test.
describe.skipIf(process.platform !== 'win32' || process.arch !== 'x64' || !existsSync(nativeDll))(
  'official SQLCipher DLL and message-store integration', () => {
    it('reads cross-shard conversations and new WAL commits without changing any source DB/WAL bytes', async () => {
      // Refuse to execute a different binary silently if the fixture dependency changes.
      expect(createHash('sha256').update(readFileSync(nativeDll)).digest('hex')).toBe(DLL_SHA256);
      const koffi = await import('koffi');
      const library = koffi.load(nativeDll);
      const native = {
        open: library.func('int sqlite3_open_v2(const char *, _Out_ void **, int, const char *)'),
        close: library.func('int sqlite3_close_v2(void *)'),
        config: library.func('int sqlite3mc_config(void *, const char *, int)'),
        cipherConfig: library.func('int sqlite3mc_config_cipher(void *, const char *, const char *, int)'),
        cipherIndex: library.func('int sqlite3mc_cipher_index(const char *)'),
        key: library.func('int sqlite3_key(void *, const void *, int)'),
        exec: library.func('int sqlite3_exec(void *, const char *, void *, void *, void *)'),
      };
      const directory = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
      const keys = Array.from({ length: 4 }, (_unused, index) => Buffer.alloc(32, 0x31 + index));
      const writers: [bigint | null][] = [];
      const readers: SqliteReadOnlyDatabase[] = [];
      const paths: string[] = [];
      const table = `Msg_${createHash('md5').update(PEER).digest('hex')}`;
      const reader = loadSqliteReader(koffi, nativeDll);

      const createFixture = (filename: string, keyIndex: number, ddl: string): string => {
        const path = join(directory, filename);
        expect(dirname(resolve(path))).toBe(resolve(directory));
        const writer: [bigint | null] = [null];
        writers.push(writer);
        const rawKey = Buffer.alloc(36);
        try {
          expect(native.open(path, writer, 2 | 4, null)).toBe(0);
          expect(native.config(writer[0], 'cipher', native.cipherIndex('sqlcipher'))).toBeGreaterThan(0);
          expect(native.config(writer[0], 'mc_legacy_wal', 0)).toBe(0);
          expect(native.cipherConfig(writer[0], 'sqlcipher', 'legacy', 4)).toBe(4);
          rawKey.write('raw:', 'ascii');
          keys[keyIndex].copy(rawKey, 4);
          expect(native.key(writer[0], rawKey, rawKey.length)).toBe(0);
          expect(native.exec(writer[0], `PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; ${ddl}`, null, null, null)).toBe(0);
        } finally {
          rawKey.fill(0);
        }
        paths.push(path);
        return path;
      };
      const snapshot = () => paths.flatMap((path) => [path, `${path}-wal`])
        .map((path) => ({ path, bytes: readFileSync(path) }));
      const unchanged = (before: ReturnType<typeof snapshot>) => {
        for (const file of before) expect(readFileSync(file.path).equals(file.bytes)).toBe(true);
      };
      const messageSchema = `CREATE TABLE Name2Id (user_name TEXT NOT NULL); CREATE TABLE "${table}" (`
        + 'local_id INTEGER PRIMARY KEY, server_id INTEGER, local_type INTEGER, sort_seq INTEGER, '
        + 'real_sender_id INTEGER, create_time INTEGER, message_content TEXT);';
      const compressedText = '合成收到消息2（ZSTD）';
      const compressed = zstdCompressSync(Buffer.from(compressedText, 'utf8'));
      let cleanupFailed = false;
      try {
        expect(reader.version()).toBe('2.5.1');
        const contactPath = createFixture('合成联系人.db', 0,
          'CREATE TABLE contact (username TEXT PRIMARY KEY, nick_name TEXT, remark TEXT); '
          + `INSERT INTO contact VALUES ('${SELF}', '同名演示', ''), ('${PEER}', '同名演示', '合成客户备注');`);
        createFixture('合成会话.db', 1,
          'CREATE TABLE SessionTable (username TEXT, is_hidden INTEGER, sort_timestamp INTEGER, unread_count INTEGER, summary TEXT, last_timestamp INTEGER); '
          + `INSERT INTO SessionTable VALUES ('${PEER}', 0, ${BASE_TIME + 4}, 3, '合成会话摘要', ${BASE_TIME + 4}), ('${SELF}', 1, ${BASE_TIME + 5}, 0, NULL, 0);`);
        createFixture('合成消息0.db', 2, messageSchema
          + `INSERT INTO Name2Id(rowid, user_name) VALUES (7, '${SELF}'), (2, '${PEER}'); `
          + `INSERT INTO "${table}" VALUES `
          + `(1, 9007199254740993, 1, 1001, 7, ${BASE_TIME + 1}, '合成发出消息1'), `
          + `(2, 9007199254740995, 1, 1003, 2, ${BASE_TIME + 3}, '合成收到消息3');`);
        const secondShardPath = createFixture('合成消息1.db', 3, messageSchema
          + `INSERT INTO Name2Id(rowid, user_name) VALUES (2, '${SELF}'), (7, '${PEER}'); `
          + `INSERT INTO "${table}" VALUES `
          + `(1, 9007199254740994, 1, 1002, 7, ${BASE_TIME + 2}, x'${compressed.toString('hex')}'), `
          + `(2, 9007199254740996, 1, 1004, 2, ${BASE_TIME + 4}, '合成发出消息4');`);
        for (const path of paths) {
          expect(readFileSync(path).subarray(0, 16).toString('ascii')).not.toBe('SQLite format 3\0');
          expect(readFileSync(`${path}-wal`).length).toBeGreaterThan(32);
        }
        const beforeFirstRead = snapshot();
        const kinds = ['contact', 'session', 'message', 'message'] as const;
        const databases: WechatMessageDatabase[] = paths.map((path, index) => {
          const db = reader.openReadOnly(path, keys[index]);
          readers.push(db);
          return { id: `synthetic-${index}`, kind: kinds[index], db };
        });
        const store = new WechatMessageStore({ databases, accountName: SELF, accountKey: 'a:synthetic-integration' });
        expect(store.listConversations()).toEqual([{
          username: PEER, displayName: '合成客户备注', remark: '合成客户备注', kind: 'contact',
          contactKey: `c:${createHash('sha256').update(PEER).digest('hex')}`,
          unreadCount: 3, preview: '合成会话摘要', lastMessageAt: new Date((BASE_TIME + 4) * 1000).toISOString(),
        }]);
        const latest = store.readMessages(PEER, 3);
        expect(latest.map((row) => row.text)).toEqual([compressedText, '合成收到消息3', '合成发出消息4']);
        expect(latest.map((row) => row.direction)).toEqual(['incoming', 'incoming', 'outgoing']);
        expect(store.readMessages(PEER, 2, 2).map((row) => row.text)).toEqual(['合成发出消息1', compressedText]);
        expect(store.readMessages(PEER, 2, 4)).toEqual([]);
        expect(latest.map((row) => row.messageId)).toEqual([9007199254740994n, 9007199254740995n, 9007199254740996n]
          .map((id) => `m:${createHash('sha256').update(`${PEER}:server:${id}`).digest('hex')}`));
        expect(readers[2].query(`PRAGMA table_info("${table}")`).map((row) => row.name))
          .toEqual(['local_id', 'server_id', 'local_type', 'sort_seq', 'real_sender_id', 'create_time', 'message_content']);
        const parameter = "合成参数 '; DROP TABLE contact; --";
        expect(readers[0].query('SELECT ? AS literal, ? AS large_id', [parameter, 9223372036854775807n]))
          .toEqual([{ literal: parameter, large_id: '9223372036854775807' }]);
        expect(readers.every((db) => db.query('PRAGMA query_only')[0]?.query_only === '1')).toBe(true);
        expect(() => reader.openReadOnly(contactPath, keys[2])).toThrow('database.validationFailed');
        unchanged(beforeFirstRead);

        expect(native.exec(writers[1][0], 'UPDATE SessionTable SET unread_count=7, summary=\'合成更新摘要\' WHERE is_hidden=0;', null, null, null)).toBe(0);
        const beforeMetadataRefresh = snapshot();
        expect(store.listConversations()[0]).toMatchObject({ unreadCount: 7, preview: '合成更新摘要' });
        unchanged(beforeMetadataRefresh);

        // Keep both the store and all original read handles alive while the writer commits.
        expect(native.exec(writers[3][0], `INSERT INTO "${table}" VALUES `
          + `(3, 9007199254740997, 1, 1005, 7, ${BASE_TIME + 5}, '合成新增WAL消息5');`, null, null, null)).toBe(0);
        const beforeSecondRead = snapshot();
        const oldWal = beforeFirstRead.find((file) => file.path === `${secondShardPath}-wal`);
        expect(readFileSync(`${secondShardPath}-wal`).equals(oldWal?.bytes ?? Buffer.alloc(0))).toBe(false);
        expect(store.readMessages(PEER, 1)[0]).toMatchObject({ text: '合成新增WAL消息5', direction: 'incoming' });
        expect(store.readMessages(PEER, 5)).toHaveLength(5);
        unchanged(beforeSecondRead);

        // System notifications may refer to a blank Name2Id entry or have no sender.
        expect(native.exec(writers[3][0], "INSERT INTO Name2Id(rowid, user_name) VALUES (99, ''); "
          + `INSERT INTO "${table}" VALUES `
          + `(4, 9007199254740998, 10000, 1006, 99, ${BASE_TIME + 6}, '合成系统提示6'), `
          + `(5, 9007199254740999, 10002, 1007, NULL, ${BASE_TIME + 7}, '合成系统提示7');`, null, null, null)).toBe(0);
        const beforeSystemRead = snapshot();
        const withSystem = store.readMessages(PEER, 3);
        expect(withSystem.map((row) => row.direction)).toEqual(['incoming', 'system', 'system']);
        expect(withSystem.map((row) => row.text)).toEqual(['合成新增WAL消息5', '合成系统提示6', '合成系统提示7']);
        expect(store.readMessages(PEER, 2, 2).map((row) => row.text)).toEqual(['合成发出消息4', '合成新增WAL消息5']);
        expect(store.readMessages(PEER, 10)).toHaveLength(7);
        unchanged(beforeSystemRead);
      } finally {
        compressed.fill(0);
        keys.forEach((key) => key.fill(0));
        for (const db of readers) {
          try { db.close(); } catch { cleanupFailed = true; }
        }
        for (const writer of writers) {
          try {
            if (writer[0] && native.close(writer[0]) !== 0) cleanupFailed = true;
          } catch { cleanupFailed = true; }
        }
        const target = resolve(directory);
        if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith(TEMP_PREFIX)) {
          cleanupFailed = true; // Refuse to remove anything outside the exact test-created temp directory.
        } else {
          try { rmSync(target, { recursive: true, force: true }); } catch { cleanupFailed = true; }
        }
      }
      expect(cleanupFailed).toBe(false);
    }, 15_000);
  },
);
