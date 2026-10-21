import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  loadSqliteReader,
  SqliteReaderError,
  type SqliteKoffi,
  type SqliteParameter,
} from './sqlite-reader';

type NativeFunction = (...args: unknown[]) => unknown;
interface QueryPlan {
  readonly columns?: string[];
  readonly rows?: unknown[][];
  readonly tail?: string;
  readonly readonly?: number;
  readonly prepareCode?: number;
  readonly stepCode?: number;
  readonly actions?: [number, string | null, string | null][];
}
interface MockStatement {
  readonly plan: QueryPlan;
  readonly sql: string;
  row: number;
}

const mockNative = () => {
  let nextPointer = 10n;
  let authorizer: NativeFunction | undefined;
  const callbacks = new Map<bigint, NativeFunction>();
  const statements = new Map<bigint, MockStatement>();
  const plans = new Map<string, QueryPlan>();
  plans.set('SELECT 1 AS ready', { columns: ['ready'], rows: [[1]] });
  plans.set('PRAGMA query_only', { columns: ['query_only'], rows: [[1]], actions: [[19, 'query_only', null]] });
  plans.set("SELECT sqlite3mc_config('hmac_check', 0)", { actions: [[31, null, 'sqlite3mc_config']] });
  const config = new Map<string, number>();
  const preparedSql: string[] = [];
  const functions: Record<string, ReturnType<typeof vi.fn<NativeFunction>>> = {};
  const bind = (name: string, implementation: NativeFunction = () => 0) => {
    functions[name] = vi.fn(implementation);
  };
  const statement = (pointer: unknown) => {
    const value = statements.get(pointer as bigint);
    if (!value) throw new Error('Invalid synthetic statement');
    return value;
  };
  const cell = (pointer: unknown, column: unknown) => {
    const current = statement(pointer);
    const row = current.plan.rows?.[current.row];
    if (!row) throw new Error('Invalid synthetic row');
    return row[column as number];
  };
  bind('sqlite3mc_version', () => 'SQLite3 Multiple Ciphers 2.5.1');
  bind('sqlite3_open_v2', (_path, output) => { (output as unknown[])[0] = nextPointer++; return 0; });
  bind('sqlite3_close_v2');
  bind('sqlite3_db_readonly', () => 1);
  bind('sqlite3_busy_timeout');
  bind('sqlite3_enable_load_extension');
  bind('sqlite3mc_cipher_index', () => 4);
  bind('sqlite3mc_config', (_db, name, value) => {
    if (value !== -1) config.set(String(name), Number(value));
    return config.get(String(name)) ?? 0;
  });
  bind('sqlite3mc_config_cipher', (_db, _cipher, name, value) => {
    if (value !== -1) config.set(String(name), Number(value));
    return config.get(String(name)) ?? 0;
  });
  bind('sqlite3_key');
  bind('sqlite3_set_authorizer', (_db, callback) => {
    authorizer = callback === null ? undefined : callbacks.get(callback as bigint);
    return 0;
  });
  bind('sqlite3_prepare_v2', (_db, bytes, _length, output, tail) => {
    const sql = (bytes as Buffer).toString('utf8').replace(/\0$/u, '');
    preparedSql.push(sql);
    const plan = plans.get(sql) ?? {};
    if (plan.actions?.some(([action, first, second]) =>
      authorizer?.(null, action, first, second, 'main', null) !== 0)) return 23;
    if (plan.prepareCode) return plan.prepareCode;
    const pointer = nextPointer++;
    statements.set(pointer, { plan, sql, row: -1 });
    (output as unknown[])[0] = pointer;
    (tail as unknown[])[0] = plan.tail ?? '';
    return 0;
  });
  bind('sqlite3_stmt_readonly', (pointer) => statement(pointer).plan.readonly ?? 1);
  bind('sqlite3_bind_parameter_count', (pointer) =>
    (statement(pointer).sql.match(/\?/gu) ?? []).length);
  for (const name of ['null', 'int64', 'double', 'text', 'blob']) bind(`sqlite3_bind_${name}`);
  bind('sqlite3_step', (pointer) => {
    const current = statement(pointer);
    current.row += 1;
    return current.plan.stepCode ?? (current.row < (current.plan.rows?.length ?? 0) ? 100 : 101);
  });
  bind('sqlite3_column_count', (pointer) => statement(pointer).plan.columns?.length ?? 0);
  bind('sqlite3_column_name', (pointer, column) => statement(pointer).plan.columns?.[column as number]);
  bind('sqlite3_column_type', (pointer, column) => {
    const value = cell(pointer, column);
    if (value === null) return 5;
    if (Buffer.isBuffer(value)) return 4;
    if (typeof value === 'string') return 3;
    if (typeof value === 'bigint' || Number.isInteger(value)) return 1;
    return 2;
  });
  bind('sqlite3_column_int64', cell);
  bind('sqlite3_column_double', cell);
  bind('sqlite3_column_text', (pointer, column) => Buffer.from(String(cell(pointer, column)), 'utf8'));
  bind('sqlite3_column_blob', cell);
  bind('sqlite3_column_bytes', (pointer, column) => {
    const value = cell(pointer, column);
    return Buffer.isBuffer(value) ? value.length : Buffer.byteLength(String(value), 'utf8');
  });
  bind('sqlite3_finalize', (pointer) => { statements.delete(pointer as bigint); return 0; });
  const koffi = {
    load: vi.fn(() => ({
      func: (definition: string) => {
        const name = /\b(sqlite3\w*)\s*\(/u.exec(definition)?.[1] ?? '';
        if (!functions[name]) throw new Error(`Unknown fixture function: ${name}`);
        return functions[name];
      },
    })),
    decode: vi.fn((pointer: unknown, type: string, length?: number) => {
      if (type === 'char *') {
        if (typeof pointer === 'string') throw new Error('Native strings are already decoded');
        return (pointer as Buffer).toString();
      }
      return (pointer as Buffer).subarray(0, length);
    }),
    proto: vi.fn(() => ({})),
    pointer: vi.fn((value: unknown) => value),
    register: vi.fn((callback: NativeFunction) => {
      const pointer = nextPointer++;
      callbacks.set(pointer, callback);
      return pointer;
    }),
    unregister: vi.fn((pointer: bigint) => callbacks.delete(pointer)),
  };
  return { koffi: koffi as unknown as SqliteKoffi, functions, plans, preparedSql, config, statements, callbacks };
};

const fixtureKey = () => Buffer.from(Array.from({ length: 32 }, (_, index) => index));
const fixturePath = resolve('synthetic-account.db');
const openMock = () => {
  const native = mockNative();
  const reader = loadSqliteReader(native.koffi, 'synthetic-sqlite3mc.dll');
  const db = reader.openReadOnly(fixturePath, fixtureKey());
  return { ...native, reader, db };
};

describe('thin read-only SQLCipher reader', () => {
  it('uses the verified C API, SQLCipher 4, authenticated pages and compatible WAL mode', () => {
    const { functions, config, preparedSql, reader, db } = openMock();
    expect(reader.version()).toBe('2.5.1');
    const [path, , flags] = functions.sqlite3_open_v2.mock.calls[0];
    expect(path).toBe(fixturePath);
    expect(Number(flags) & 1).toBe(1);
    expect(Number(flags) & (2 | 4 | 64)).toBe(0); // No read-write/create/URI flags.
    expect(config.get('cipher')).toBe(4);
    expect(config.get('legacy')).toBe(4);
    expect(config.get('legacy_page_size')).toBe(4096);
    expect(config.get('hmac_use')).toBe(1);
    expect(config.get('hmac_check')).toBe(1);
    expect(config.get('hmac_algorithm')).toBe(2);
    expect(config.get('kdf_algorithm')).toBe(2);
    expect(config.get('mc_legacy_wal')).toBe(0);
    expect(preparedSql).toContain('PRAGMA query_only = ON');
    expect(preparedSql.some((sql) => /journal|rekey|wal_checkpoint/iu.test(sql))).toBe(false);
    db.close();
  });

  it('encodes a binary key only in the temporary C buffer, then wipes that buffer', () => {
    const native = mockNative();
    const key = fixtureKey();
    let captured: Buffer | undefined;
    native.functions.sqlite3_key.mockImplementation((_db, value, length) => {
      captured = value as Buffer;
      expect(length).toBe(67);
      expect(captured.toString('ascii')).toBe(`x'${key.toString('hex')}'`);
      return 0;
    });
    const db = loadSqliteReader(native.koffi, 'fixture.dll').openReadOnly(fixturePath, key);
    expect(captured).toEqual(Buffer.alloc(67));
    expect(key).toEqual(fixtureKey()); // The caller still owns the input key.
    expect(native.preparedSql.join('\n')).not.toContain(key.toString('hex'));
    db.close();
  });

  it('wipes the temporary key and closes an opened handle when sqlite3_key throws', () => {
    const native = mockNative();
    let captured: Buffer | undefined;
    native.functions.sqlite3_key.mockImplementation((_db, value) => {
      captured = value as Buffer;
      throw new Error('PRIVATE_PATH PRIVATE_KEY');
    });
    expect(() => loadSqliteReader(native.koffi, 'fixture.dll').openReadOnly(fixturePath, fixtureKey()))
      .toThrow('database.key');
    expect(captured).toEqual(Buffer.alloc(67));
    expect(native.functions.sqlite3_close_v2).toHaveBeenCalledOnce();
  });

  it('preflights in memory without any account path or key acquisition', () => {
    const native = mockNative();
    const reader = loadSqliteReader(native.koffi, 'fixture.dll');
    reader.preflight();
    expect(native.functions.sqlite3_open_v2.mock.calls[0][0]).toBe(':memory:');
    expect(native.functions.sqlite3_key).not.toHaveBeenCalled();
    expect(native.functions.sqlite3_close_v2).toHaveBeenCalledOnce();
    expect(native.preparedSql).toContain('PRAGMA query_only = ON');
    expect(native.callbacks.size).toBe(0);
  });

  it('does not claim preflight success when query_only is not enabled', () => {
    const native = mockNative();
    native.plans.set('PRAGMA query_only', { columns: ['query_only'], rows: [[0]] });
    expect(() => loadSqliteReader(native.koffi, 'fixture.dll').preflight()).toThrow('database.initialize');
    expect(native.functions.sqlite3_close_v2).toHaveBeenCalledOnce();
    expect(native.callbacks.size).toBe(0);
  });

  it.each([
    ['sqlite3_open_v2', 14, 'database.open'],
    ['sqlite3_db_readonly', 0, 'database.open'],
    ['sqlite3mc_cipher_index', -1, 'database.configure'],
    ['sqlite3mc_config', -1, 'database.configure'],
    ['sqlite3mc_config_cipher', -1, 'database.configure'],
    ['sqlite3_busy_timeout', 1, 'database.configure'],
    ['sqlite3_enable_load_extension', 1, 'database.configure'],
    ['sqlite3_set_authorizer', 1, 'database.configure'],
  ] as const)('cleans startup handles when %s fails safely', (name, value, code) => {
    const native = mockNative();
    if (name === 'sqlite3_open_v2') {
      native.functions[name].mockImplementation((_path, output) => { (output as unknown[])[0] = 5n; return value; });
    } else native.functions[name].mockReturnValueOnce(value);
    expect(() => loadSqliteReader(native.koffi, 'fixture.dll').openReadOnly(fixturePath, fixtureKey())).toThrow(code);
    expect(native.functions.sqlite3_close_v2).toHaveBeenCalledOnce();
    expect(native.callbacks.size).toBe(0);
  });

  it('never returns a DLL load exception or malformed version string', () => {
    const native = mockNative();
    native.functions.sqlite3mc_version.mockReturnValueOnce('PRIVATE_PATH PRIVATE_KEY');
    const reader = loadSqliteReader(native.koffi, 'fixture.dll');
    expect(() => reader.version()).toThrow('database.initialize');
    vi.mocked(native.koffi.load).mockImplementationOnce(() => { throw new Error('PRIVATE_PATH PRIVATE_KEY'); });
    expect(() => loadSqliteReader(native.koffi, 'PRIVATE_PATH')).toThrow('database.initialize');
  });

  it.each(['', ':memory:', 'file:account.db?key=private', 'C:\\private\0account.db'])(
    'rejects non-file or NUL paths before opening: %s', (path) => {
      const native = mockNative();
      expect(() => loadSqliteReader(native.koffi, 'fixture.dll').openReadOnly(path, fixtureKey()))
        .toThrow('database.open');
      expect(native.functions.sqlite3_open_v2).not.toHaveBeenCalled();
    });

  it.each([0, 31, 33, 64])('rejects a %s-byte key before opening', (length) => {
    const native = mockNative();
    expect(() => loadSqliteReader(native.koffi, 'fixture.dll').openReadOnly(fixturePath, Buffer.alloc(length)))
      .toThrow('database.keyInvalid');
    expect(native.functions.sqlite3_open_v2).not.toHaveBeenCalled();
  });

  it('binds every parameter without interpolating private values into SQL', () => {
    const { db, functions, preparedSql } = openMock();
    const sql = 'SELECT ?, ?, ?, ?, ?, ?, ?';
    const values: SqliteParameter[] = [null, 7, 2.5, 9223372036854775807n, "PRIVATE '; DROP TABLE x; --", Buffer.from([0, 255]), Buffer.alloc(0)];
    db.query(sql, values);
    expect(preparedSql.at(-1)).toBe(sql);
    expect(functions.sqlite3_bind_null).toHaveBeenCalledWith(expect.anything(), 1);
    expect(functions.sqlite3_bind_int64).toHaveBeenCalledWith(expect.anything(), 2, 7n);
    expect(functions.sqlite3_bind_int64).toHaveBeenCalledWith(expect.anything(), 4, 9223372036854775807n);
    expect(functions.sqlite3_bind_double).toHaveBeenCalledWith(expect.anything(), 3, 2.5);
    expect(functions.sqlite3_bind_text.mock.calls[0][3]).toBe(Buffer.byteLength(String(values[4])));
    expect(functions.sqlite3_bind_text.mock.calls[0][4]).toBe(-1n);
    expect(functions.sqlite3_bind_blob.mock.calls[1][3]).toBe(0);
    expect((functions.sqlite3_bind_blob.mock.calls[1][2] as Buffer).length).toBeGreaterThan(0);
    expect(preparedSql.join('\n')).not.toContain('PRIVATE');
    db.close();
  });

  it('copies BLOB/text before finalize and returns every integer losslessly as a string', () => {
    const { db, plans, functions } = openMock();
    const blob = Buffer.from([0, 128, 255]);
    plans.set('SELECT fixture', {
      columns: ['large', 'small', 'negative', 'floating', 'text', 'blob', 'empty', 'none', '__proto__'],
      rows: [[9223372036854775807n, 7, -9223372036854775808n, 2.5, '中文\0text', blob, Buffer.alloc(0), null, 'safe']],
    });
    const finalize = functions.sqlite3_finalize.getMockImplementation();
    if (!finalize) throw new Error('Missing synthetic finalizer');
    functions.sqlite3_finalize.mockImplementation((pointer) => { blob.fill(0); return finalize(pointer); });
    const rows = db.query('SELECT fixture');
    expect(rows[0]).toMatchObject({
      large: '9223372036854775807', small: '7', negative: '-9223372036854775808', floating: 2.5,
      text: '中文\0text', blob: Buffer.from([0, 128, 255]), empty: Buffer.alloc(0), none: null,
    });
    expect(Object.getPrototypeOf(rows[0])).toBeNull();
    expect(rows[0].__proto__).toBe('safe');
    db.close();
  });

  it.each(['INSERT INTO x VALUES (1)', 'UPDATE x SET x=1', 'DELETE FROM x', 'DROP TABLE x', 'ATTACH DATABASE ? AS x', 'BEGIN', 'VACUUM', ''])(
    'rejects non-read SQL before preparation: %s', (sql) => {
      const { db, functions } = openMock();
      functions.sqlite3_prepare_v2.mockClear();
      expect(() => db.query(sql)).toThrow('database.queryDenied');
      expect(functions.sqlite3_prepare_v2).not.toHaveBeenCalled();
      db.close();
    });

  it('rejects a second statement before stepping the first and always finalizes it', () => {
    const { db, functions, plans } = openMock();
    const sql = 'SELECT 1; DELETE FROM private_messages';
    plans.set(sql, { tail: ' DELETE FROM private_messages' });
    functions.sqlite3_step.mockClear();
    functions.sqlite3_finalize.mockClear();
    expect(() => db.query(sql)).toThrow('database.queryDenied');
    expect(functions.sqlite3_step).not.toHaveBeenCalled();
    expect(functions.sqlite3_finalize).toHaveBeenCalledOnce();
    db.close();
  });

  it('accepts one SELECT with leading/trailing comments and literal semicolons', () => {
    const { db, plans } = openMock();
    const sql = "/* fixture */ -- comment\n SELECT ';literal'; /* done */ -- eof";
    plans.set(sql, { tail: ' /* done */ -- eof' });
    expect(db.query(sql)).toEqual([]);
    db.close();
  });

  it('rejects a native non-readonly statement even if its prefix is SELECT', () => {
    const { db, plans } = openMock();
    plans.set('SELECT fixture', { readonly: 0 });
    expect(() => db.query('SELECT fixture')).toThrow('database.queryDenied');
    db.close();
  });

  it.each([
    ['PRAGMA query_only=OFF', 19, 'query_only', 'OFF'],
    ['PRAGMA journal_mode=DELETE', 19, 'journal_mode', 'DELETE'],
    ['PRAGMA wal_checkpoint(TRUNCATE)', 19, 'wal_checkpoint', 'TRUNCATE'],
    ['PRAGMA rekey=private', 19, 'rekey', 'private'],
    ["SELECT load_extension('private')", 31, null, 'load_extension'],
    ["SELECT writefile('private', 'secret')", 31, null, 'writefile'],
    ["SELECT sqlite3mc_config('hmac_check',0)", 31, null, 'sqlite3mc_config'],
    ['SELECT * FROM pragma_rekey(?)', 20, 'pragma_rekey', 'rekey'],
  ] as const)('denies side effects at prepare time: %s', (sql, action, first, second) => {
    const { db, functions, plans } = openMock();
    plans.set(sql, { actions: [[action, first, second]] });
    functions.sqlite3_step.mockClear();
    expect(() => db.query(sql)).toThrow('database.queryDenied');
    expect(functions.sqlite3_step).not.toHaveBeenCalled();
    db.close();
  });

  it.each([
    ['PRAGMA data_version', 19, 'data_version', null],
    ['PRAGMA table_info(messages)', 19, 'table_info', 'messages'],
    ['SELECT count(*) FROM messages', 31, null, 'count'],
  ] as const)('permits read-only metadata/functions: %s', (sql, action, first, second) => {
    const { db, plans } = openMock();
    plans.set(sql, { actions: [[action, first, second]] });
    expect(db.query(sql)).toEqual([]);
    db.close();
  });

  it.each([NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 9223372036854775808n, -9223372036854775809n])(
    'rejects invalid or lossy parameter %s and finalizes', (value) => {
      const { db, functions } = openMock();
      functions.sqlite3_finalize.mockClear();
      expect(() => db.query('SELECT ?', [value])).toThrow('database.bind');
      expect(functions.sqlite3_finalize).toHaveBeenCalledOnce();
      db.close();
    });

  it('rejects missing/extra parameters instead of implicitly binding NULL', () => {
    const { db } = openMock();
    expect(() => db.query('SELECT ?')).toThrow('database.bind');
    expect(() => db.query('SELECT 1', [1])).toThrow('database.bind');
    expect(() => db.query('SELECT ?', new Array<SqliteParameter>(1))).toThrow('database.bind');
    db.close();
  });

  it('rejects NUL SQL before preparation rather than silently truncating it', () => {
    const { db, functions } = openMock();
    functions.sqlite3_prepare_v2.mockClear();
    expect(() => db.query('SELECT 1\0; DELETE FROM messages')).toThrow('database.queryDenied');
    expect(functions.sqlite3_prepare_v2).not.toHaveBeenCalled();
    db.close();
  });

  it('finalizes a statement even when preparation throws after assigning its pointer', () => {
    const { db, functions } = openMock();
    const prepare = functions.sqlite3_prepare_v2.getMockImplementation();
    if (!prepare) throw new Error('Missing synthetic prepare');
    functions.sqlite3_prepare_v2.mockImplementationOnce((...args) => {
      prepare(...args);
      throw new Error('PRIVATE_PATH PRIVATE_SQL');
    });
    functions.sqlite3_finalize.mockClear();
    expect(() => db.query('SELECT 1')).toThrow('database.prepare');
    expect(functions.sqlite3_finalize).toHaveBeenCalledOnce();
    db.close();
  });

  it('fails rather than returning a rounded int64 or a failed text conversion as empty text', () => {
    const { db, plans, functions } = openMock();
    plans.set('SELECT bad_int', { columns: ['id'], rows: [[Number.MAX_SAFE_INTEGER + 1]] });
    expect(() => db.query('SELECT bad_int')).toThrow('database.query');
    plans.set('SELECT bad_text', { columns: ['text'], rows: [['text']] });
    functions.sqlite3_column_text.mockReturnValueOnce(null);
    functions.sqlite3_column_bytes.mockReturnValueOnce(0);
    expect(() => db.query('SELECT bad_text')).toThrow('database.query');
    db.close();
  });

  it.each([
    ['sqlite3_prepare_v2', 'database.prepare'],
    ['sqlite3_bind_int64', 'database.bind'],
    ['sqlite3_step', 'database.query'],
    ['sqlite3_finalize', 'database.finalize'],
  ])('sanitizes %s failure and releases statements', (name, code) => {
    const { db, functions } = openMock();
    functions[name].mockImplementationOnce(() => { throw new Error('PRIVATE_SQL PRIVATE_PATH PRIVATE_KEY'); });
    let caught: unknown;
    try { db.query('SELECT ?', [1]); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(SqliteReaderError);
    expect((caught as SqliteReaderError).code).toBe(code);
    expect(String(caught)).not.toMatch(/PRIVATE/u);
    db.close();
  });

  it('reports unreadable encrypted schemas neutrally and closes startup handles', () => {
    const native = mockNative();
    native.functions.sqlite3_step.mockReturnValueOnce(101).mockReturnValueOnce(101).mockReturnValueOnce(101).mockReturnValueOnce(26);
    expect(() => loadSqliteReader(native.koffi, 'fixture.dll').openReadOnly(fixturePath, fixtureKey()))
      .toThrow('database.validationFailed');
    expect(native.functions.sqlite3_close_v2).toHaveBeenCalledOnce();
    expect(native.callbacks.size).toBe(0);
  });

  it('retains the original query error when finalize repeats that error', () => {
    const { db, plans, functions } = openMock();
    plans.set('SELECT fixture', { stepCode: 5 });
    functions.sqlite3_finalize.mockReturnValueOnce(5);
    expect(() => db.query('SELECT fixture')).toThrow('database.busy');
    db.close();
  });

  it('closes once, unregisters its callback, and rejects use after close', () => {
    const { db, functions, callbacks } = openMock();
    db.close();
    db.close();
    expect(functions.sqlite3_close_v2).toHaveBeenCalledOnce();
    expect(callbacks.size).toBe(0);
    expect(() => db.query('SELECT 1')).toThrow('database.closed');
  });
});

// Optional integration fixture: the only files it opens are generated under this task's temp directory.
const nativeDll = resolve('native-resources/wechat-reader/sqlite3mc.dll');
describe.skipIf(process.platform !== 'win32' || !existsSync(nativeDll))('official DLL synthetic database integration', () => {
  it('reads encrypted WAL commits losslessly without changing the database or journal', async () => {
    const koffi = await import('koffi');
    const library = koffi.load(nativeDll);
    const open = library.func('int sqlite3_open_v2(const char *, _Out_ void **, int, const char *)');
    const close = library.func('int sqlite3_close_v2(void *)');
    const config = library.func('int sqlite3mc_config(void *, const char *, int)');
    const cipherConfig = library.func('int sqlite3mc_config_cipher(void *, const char *, const char *, int)');
    const cipherIndex = library.func('int sqlite3mc_cipher_index(const char *)');
    const key = library.func('int sqlite3_key(void *, const void *, int)');
    const exec = library.func('int sqlite3_exec(void *, const char *, void *, void *, void *)');
    const directory = mkdtempSync(join(tmpdir(), 'copilot-sqlite-fixture-'));
    const path = join(directory, '合成 database.db');
    const writer: [bigint | null] = [null];
    const rawKey = Buffer.alloc(36);
    rawKey.write('raw:', 'ascii');
    fixtureKey().copy(rawKey, 4);
    let readerDb: ReturnType<ReturnType<typeof loadSqliteReader>['openReadOnly']> | undefined;
    try {
      expect(open(path, writer, 2 | 4, null)).toBe(0);
      expect(config(writer[0], 'cipher', cipherIndex('sqlcipher'))).toBeGreaterThan(0);
      expect(cipherConfig(writer[0], 'sqlcipher', 'legacy', 4)).toBe(4);
      expect(key(writer[0], rawKey, rawKey.length)).toBe(0);
      rawKey.fill(0);
      expect(exec(writer[0], 'PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE fixture (id INTEGER, text TEXT, blob BLOB); INSERT INTO fixture VALUES (9223372036854775807, \'中文\', x\'00ff\');', null, null, null)).toBe(0);
      const reader = loadSqliteReader(koffi, nativeDll);
      expect(reader.version()).toBe('2.5.1');
      reader.preflight();
      readerDb = reader.openReadOnly(path, fixtureKey());
      const db = readerDb;
      const databaseBefore = readFileSync(path);
      const walBefore = readFileSync(`${path}-wal`);
      expect(readerDb.query('SELECT * FROM fixture')).toEqual([{ id: '9223372036854775807', text: '中文', blob: Buffer.from([0, 255]) }]);
      expect(readerDb.query('PRAGMA table_info(fixture)').map((row) => row.name)).toEqual(['id', 'text', 'blob']);
      expect(readerDb.query('SELECT name FROM pragma_table_info(?)', ['fixture']).map((row) => row.name)).toEqual(['id', 'text', 'blob']);
      expect(readerDb.query("SELECT ';literal' AS value; /* trailing comment */")).toEqual([{ value: ';literal' }]);
      expect(readerDb.query('SELECT ? AS empty_text, ? AS smallest', ['', -9223372036854775808n]))
        .toEqual([{ empty_text: '', smallest: '-9223372036854775808' }]);
      expect(readerDb.query('SELECT ? AS text, ? AS empty', ["literal '; DROP TABLE fixture; --", Buffer.alloc(0)]))
        .toEqual([{ text: "literal '; DROP TABLE fixture; --", empty: Buffer.alloc(0) }]);
      for (const sql of ['DELETE FROM fixture', 'SELECT 1; DELETE FROM fixture', 'PRAGMA query_only=OFF', 'PRAGMA journal_mode=DELETE', "SELECT sqlite3mc_config('hmac_check',0)", "SELECT load_extension('not-a-file')"]) {
        expect(() => db.query(sql)).toThrow(SqliteReaderError);
      }
      expect(readFileSync(path)).toEqual(databaseBefore);
      expect(readFileSync(`${path}-wal`)).toEqual(walBefore);
      expect(exec(writer[0], "INSERT INTO fixture VALUES (2, 'new WAL message', x'01');", null, null, null)).toBe(0);
      expect(readerDb.query('SELECT id FROM fixture ORDER BY id')).toEqual([{ id: '2' }, { id: '9223372036854775807' }]);
      readerDb.close();
      readerDb = undefined;
      expect(() => reader.openReadOnly(path, Buffer.alloc(32, 123))).toThrow('database.validationFailed');
    } finally {
      rawKey.fill(0);
      readerDb?.close();
      if (writer[0]) close(writer[0]);
      // Only remove the exact test-created directory, never an account or workspace directory.
      if (dirname(resolve(directory)) === resolve(tmpdir()) && basename(directory).startsWith('copilot-sqlite-fixture-')) {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });
});
