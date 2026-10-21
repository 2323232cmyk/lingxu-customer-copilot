import { isAbsolute } from 'node:path';

export type SqliteKoffi = Pick<typeof import('koffi'), 'load' | 'decode' | 'proto' | 'pointer' | 'register' | 'unregister'>;
export type SqliteParameter = string | number | bigint | Buffer | null;
export type SqliteValue = string | number | Buffer | null;
export type SqliteRow = Record<string, SqliteValue>;

export interface SqliteReadOnlyDatabase {
  query(sql: string, params?: readonly SqliteParameter[]): SqliteRow[];
  close(): void;
}

export interface SqliteReader {
  version(): string;
  /** Component-only check. Does not open an account or acquire a key. */
  preflight(): void;
  openReadOnly(dbPath: string, key: Buffer): SqliteReadOnlyDatabase;
}

export type SqliteReaderErrorCode =
  | 'database.initialize' | 'database.open' | 'database.configure' | 'database.keyInvalid'
  | 'database.key' | 'database.validationFailed' | 'database.queryDenied' | 'database.prepare'
  | 'database.bind' | 'database.query' | 'database.busy' | 'database.finalize'
  | 'database.close' | 'database.closed';

export class SqliteReaderError extends Error {
  constructor(readonly code: SqliteReaderErrorCode) {
    super(code);
    this.name = 'SqliteReaderError';
  }
}

const safe = <T>(code: SqliteReaderErrorCode, action: () => T): T => {
  try {
    return action();
  } catch (error) {
    // Do not retain native exception text, SQL, paths, or a cause containing key material.
    throw error instanceof SqliteReaderError ? error : new SqliteReaderError(code);
  }
};

const check = (result: unknown, code: SqliteReaderErrorCode): void => {
  if (result === 0) return;
  const primary = typeof result === 'number' ? result & 0xff : -1;
  if (primary === 5 || primary === 6) throw new SqliteReaderError('database.busy');
  if (primary === 11 || primary === 26) throw new SqliteReaderError('database.validationFailed');
  if (primary === 23) throw new SqliteReaderError('database.queryDenied');
  throw new SqliteReaderError(code);
};

const skipComments = (sql: string): string =>
  sql.replace(/^(?:\s+|--[^\r\n]*(?:\r?\n|$)|\/\*[\s\S]*?\*\/)*/u, '');

const READ_PRAGMAS = new Set(['data_version', 'schema_version', 'user_version', 'page_count', 'page_size', 'query_only', 'encoding']);
const METADATA_PRAGMAS = new Set(['table_info', 'table_xinfo', 'index_list', 'index_info', 'index_xinfo', 'foreign_key_list']);
const READ_FUNCTIONS = new Set([
  'count', 'min', 'max', 'avg', 'sum', 'total', 'coalesce', 'ifnull', 'nullif', 'iif',
  'lower', 'upper', 'trim', 'ltrim', 'rtrim', 'length', 'octet_length', 'substr', 'substring',
  'replace', 'instr', 'typeof', 'hex', 'unhex', 'abs', 'round', 'char', 'unicode',
  'date', 'time', 'datetime', 'strftime', 'julianday', 'unixepoch', 'like', 'glob',
  'likely', 'unlikely', 'likelihood', 'sqlite_version',
]);
const SQLITE_TRANSIENT = -1n;
const MAX_COLUMN_BYTES = 16 * 1024 * 1024;
const MAX_QUERY_BYTES = 64 * 1024;

/** Only this worker-facing wrapper receives the native module; it never imports Koffi in the renderer. */
export const loadSqliteReader = (koffi: SqliteKoffi, dllPath: string): SqliteReader => safe('database.initialize', () => {
  const library = koffi.load(dllPath);
  const native = {
    version: library.func('const char *sqlite3mc_version(void)'),
    open: library.func('int sqlite3_open_v2(const char *, _Out_ void **, int, const char *)'),
    close: library.func('int sqlite3_close_v2(void *)'),
    readonly: library.func('int sqlite3_db_readonly(void *, const char *)'),
    busyTimeout: library.func('int sqlite3_busy_timeout(void *, int)'),
    enableExtension: library.func('int sqlite3_enable_load_extension(void *, int)'),
    cipherIndex: library.func('int sqlite3mc_cipher_index(const char *)'),
    config: library.func('int sqlite3mc_config(void *, const char *, int)'),
    cipherConfig: library.func('int sqlite3mc_config_cipher(void *, const char *, const char *, int)'),
    key: library.func('int sqlite3_key(void *, const void *, int)'),
    authorize: library.func('int sqlite3_set_authorizer(void *, void *, void *)'),
    prepare: library.func('int sqlite3_prepare_v2(void *, const void *, int, _Out_ void **, _Out_ const char **)'),
    statementReadonly: library.func('int sqlite3_stmt_readonly(void *)'),
    parameterCount: library.func('int sqlite3_bind_parameter_count(void *)'),
    bindNull: library.func('int sqlite3_bind_null(void *, int)'),
    bindInteger: library.func('int sqlite3_bind_int64(void *, int, int64_t)'),
    bindDouble: library.func('int sqlite3_bind_double(void *, int, double)'),
    bindText: library.func('int sqlite3_bind_text(void *, int, const void *, int, void *)'),
    bindBlob: library.func('int sqlite3_bind_blob(void *, int, const void *, int, void *)'),
    step: library.func('int sqlite3_step(void *)'),
    columnCount: library.func('int sqlite3_column_count(void *)'),
    columnName: library.func('const char *sqlite3_column_name(void *, int)'),
    columnType: library.func('int sqlite3_column_type(void *, int)'),
    columnInteger: library.func('int64_t sqlite3_column_int64(void *, int)'),
    columnDouble: library.func('double sqlite3_column_double(void *, int)'),
    columnText: library.func('const void *sqlite3_column_text(void *, int)'),
    columnBlob: library.func('const void *sqlite3_column_blob(void *, int)'),
    columnBytes: library.func('int sqlite3_column_bytes(void *, int)'),
    finalize: library.func('int sqlite3_finalize(void *)'),
  };
  const authorizerType = koffi.pointer(koffi.proto('int', ['void *', 'int', 'const char *', 'const char *', 'const char *', 'const char *']));

  const configureCipher = (db: bigint): void => safe('database.configure', () => {
    const cipher = native.cipherIndex('sqlcipher');
    if (!Number.isInteger(cipher) || cipher < 1) throw new SqliteReaderError('database.configure');
    for (const [name, value] of [['cipher', cipher], ['hmac_check', 1], ['mc_legacy_wal', 0]] as const) {
      if (native.config(db, name, value) !== value) throw new SqliteReaderError('database.configure');
    }
    // legacy=4 selects SQLCipher 4 defaults. mc_legacy_wal=1 instead selects pre-1.3 MC WAL, NOT SQLCipher WAL.
    // https://utelle.github.io/SQLite3MultipleCiphers/docs/configuration/config_capi/
    for (const [name, value] of [
      ['legacy', 4], ['legacy_page_size', 4096], ['kdf_iter', 256000], ['fast_kdf_iter', 2],
      ['hmac_use', 1], ['hmac_pgno', 1], ['hmac_salt_mask', 0x3a],
      ['kdf_algorithm', 2], ['hmac_algorithm', 2], ['plaintext_header_size', 0],
    ] as const) {
      if (native.cipherConfig(db, 'sqlcipher', name, value) !== value) throw new SqliteReaderError('database.configure');
    }
  });

  const open = (path: string, key?: Buffer): SqliteReadOnlyDatabase => {
    const handle: [bigint | null] = [null];
    let authorizer: bigint | undefined;
    let denied = false;

    const close = (): void => safe('database.close', () => {
      if (!handle[0]) return;
      check(native.close(handle[0]), 'database.close');
      handle[0] = null;
      if (authorizer !== undefined) {
        const callback = authorizer;
        authorizer = undefined;
        koffi.unregister(callback);
      }
    });

    const column = (statement: bigint, index: number): SqliteValue => {
      const type = native.columnType(statement, index);
      if (type === 5) return null;
      if (type === 1) {
        const value: unknown = native.columnInteger(statement, index);
        if (typeof value === 'bigint' || (typeof value === 'number' && Number.isSafeInteger(value))) return String(value);
        throw new SqliteReaderError('database.query');
      }
      if (type === 2) return native.columnDouble(statement, index) as number;
      if (type !== 3 && type !== 4) throw new SqliteReaderError('database.query');
      const pointer = type === 3 ? native.columnText(statement, index) : native.columnBlob(statement, index);
      const length: number = native.columnBytes(statement, index);
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_COLUMN_BYTES || (!pointer && (type === 3 || length > 0))) {
        throw new SqliteReaderError('database.query');
      }
      // Native column pointers expire on step/finalize. Copy even if the FFI decoder returns a view.
      const value = length === 0 ? Buffer.alloc(0) : Buffer.from(koffi.decode(pointer, 'uint8_t', length) as Uint8Array);
      return type === 3 ? value.toString('utf8') : value;
    };

    const bindParameter = (statement: bigint, index: number, value: SqliteParameter): void => {
      let result: unknown;
      if (value === null) {
        result = native.bindNull(statement, index);
      } else if (typeof value === 'bigint') {
        if (value < -9223372036854775808n || value > 9223372036854775807n) throw new SqliteReaderError('database.bind');
        result = native.bindInteger(statement, index, value);
      } else if (typeof value === 'number') {
        if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) throw new SqliteReaderError('database.bind');
        result = Number.isInteger(value) ? native.bindInteger(statement, index, BigInt(value)) : native.bindDouble(statement, index, value);
      } else if (typeof value === 'string' || Buffer.isBuffer(value)) {
        const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
        const bind = typeof value === 'string' ? native.bindText : native.bindBlob;
        // SQLITE_TRANSIENT copies during the call; no pointer to a temporary JS string can outlive it.
        result = bind(statement, index, bytes.length ? bytes : Buffer.alloc(1), bytes.length, SQLITE_TRANSIENT);
      } else {
        throw new SqliteReaderError('database.bind');
      }
      check(result, 'database.bind');
    };

    const query = (sql: string, params: readonly SqliteParameter[] = [], setup = false): SqliteRow[] => {
      if (!handle[0]) throw new SqliteReaderError('database.closed');
      if (typeof sql !== 'string' || sql.includes('\0') || Buffer.byteLength(sql, 'utf8') > MAX_QUERY_BYTES
        || (!setup && !/^(SELECT|PRAGMA)\b/iu.test(skipComments(sql)))) {
        throw new SqliteReaderError('database.queryDenied');
      }
      const statement: [bigint | null] = [null];
      const tail: [string | null] = [null];
      const bytes = Buffer.from(`${sql}\0`, 'utf8');
      let phase: SqliteReaderErrorCode = 'database.prepare';
      let failure: SqliteReaderError | undefined;
      const rows: SqliteRow[] = [];
      denied = false;
      try {
        const prepared = native.prepare(handle[0], bytes, bytes.length, statement, tail);
        if (denied) throw new SqliteReaderError('database.queryDenied');
        check(prepared, 'database.prepare');
        if (!statement[0] || typeof tail[0] !== 'string' || skipComments(tail[0]) !== ''
          || (!setup && native.statementReadonly(statement[0]) !== 1)) {
          throw new SqliteReaderError('database.queryDenied');
        }
        const pointer = statement[0];
        phase = 'database.bind';
        if (!Array.isArray(params) || native.parameterCount(pointer) !== params.length) throw new SqliteReaderError('database.bind');
        for (let index = 0; index < params.length; index += 1) bindParameter(pointer, index + 1, params[index]);
        phase = 'database.query';
        for (;;) {
          const result = native.step(pointer);
          if (denied) throw new SqliteReaderError('database.queryDenied');
          if (result === 101) break;
          if (result !== 100) {
            check(result, 'database.query');
            throw new SqliteReaderError('database.query');
          }
          const row: SqliteRow = Object.create(null) as SqliteRow;
          const count: number = native.columnCount(pointer);
          for (let index = 0; index < count; index += 1) row[native.columnName(pointer, index) as string] = column(pointer, index);
          rows.push(row);
        }
      } catch (error) {
        failure = error instanceof SqliteReaderError ? error : new SqliteReaderError(phase);
      } finally {
        if (statement[0]) {
          try {
            check(native.finalize(statement[0]), 'database.finalize');
          } catch (error) {
            failure ??= error instanceof SqliteReaderError ? error : new SqliteReaderError('database.finalize');
          }
        }
      }
      if (failure) throw failure;
      return rows;
    };

    try {
      safe('database.open', () => {
        // Memory is internal to preflight. Account files are never opened with CREATE/READWRITE/URI/immutable.
        const flags = (key ? 0x00000001 : 0x00000002 | 0x00000004) | 0x00010000 | 0x00040000;
        check(native.open(path, handle, flags, null), 'database.open');
        if (!handle[0] || (key && native.readonly(handle[0], 'main') !== 1)) throw new SqliteReaderError('database.open');
      });
      const database = handle[0];
      if (database === null) throw new SqliteReaderError('database.open');
      configureCipher(database);
      if (key) {
        // v2.5.1 sqlite3mcExtractRawKey accepts x'<64 hex>' (67 bytes), bypassing passphrase KDF.
        // Encode into erasable memory directly: never put this credential in a JS string, URI, SQL, or log.
        const raw = Buffer.alloc(67);
        try {
          raw[0] = 120;
          raw[1] = raw[66] = 39;
          const digit = (value: number): number => value < 10 ? 48 + value : 87 + value;
          for (let index = 0; index < key.length; index += 1) {
            raw[2 + index * 2] = digit(key[index] >>> 4);
            raw[3 + index * 2] = digit(key[index] & 15);
          }
          safe('database.key', () => check(native.key(handle[0], raw, raw.length), 'database.key'));
        } finally {
          raw.fill(0);
        }
      }
      safe('database.configure', () => {
        check(native.busyTimeout(handle[0], 1000), 'database.configure');
        check(native.enableExtension(handle[0], 0), 'database.configure');
      });
      for (const sql of ['PRAGMA query_only = ON', 'PRAGMA trusted_schema = OFF', 'PRAGMA temp_store = MEMORY']) query(sql, [], true);
      safe('database.configure', () => {
        // Koffi 3 decodes callback const-char pointers as strings; opaque-pointer adapters may not.
        const name = (pointer: unknown): string => pointer === null ? ''
          : (typeof pointer === 'string' ? pointer : String(koffi.decode(pointer, 'char *'))).toLowerCase();
        authorizer = koffi.register((_context: unknown, action: number, first: unknown, second: unknown): number => {
          try {
            if (action === 21 || action === 33) return 0; // SELECT / recursive SELECT.
            const firstName = name(first);
            if (action === 20 && (!firstName.startsWith('pragma_')
              || READ_PRAGMAS.has(firstName.slice(7)) || METADATA_PRAGMAS.has(firstName.slice(7)))) return 0;
            if (action === 31 && READ_FUNCTIONS.has(name(second))) return 0;
            if (action === 19 && (METADATA_PRAGMAS.has(firstName) || (READ_PRAGMAS.has(firstName) && second === null))) return 0;
          } catch {
            // A failing authorizer is always a denial, not an exception crossing the C boundary.
          }
          denied = true;
          return 1; // SQLITE_DENY, including ATTACH, writes, rekey, load_extension and configuration functions.
        }, authorizerType);
        check(native.authorize(handle[0], authorizer, null), 'database.configure');
      });
      // sqlite3_key success alone does not validate a credential. Force an authenticated schema read.
      query('SELECT count(*) AS schema_count FROM sqlite_master');
      return { query: (sql, params) => query(sql, params), close };
    } catch (error) {
      try { close(); } catch { /* Preserve the first safe error; the enclosing worker is disposable. */ }
      throw error instanceof SqliteReaderError ? error : new SqliteReaderError('database.initialize');
    }
  };

  return {
    version: () => safe('database.initialize', () => {
      const value: unknown = native.version();
      const match = typeof value === 'string' ? /^(?:SQLite3 Multiple Ciphers )?(\d{1,6}\.\d{1,6}\.\d{1,6}(?:[\w.+-]{0,32})?)$/u.exec(value) : null;
      if (!match) throw new SqliteReaderError('database.initialize');
      return match[1];
    }),
    preflight: () => {
      const db = open(':memory:');
      try {
        if (db.query('SELECT 1 AS ready')[0]?.ready !== '1'
          || db.query('PRAGMA query_only')[0]?.query_only !== '1') throw new SqliteReaderError('database.initialize');
        for (const sql of ['CREATE TABLE forbidden (value)', "SELECT sqlite3mc_config('hmac_check', 0)"]) {
          let refused = false;
          try { db.query(sql); } catch (error) {
            if (!(error instanceof SqliteReaderError) || error.code !== 'database.queryDenied') throw error;
            refused = true;
          }
          if (!refused) throw new SqliteReaderError('database.initialize');
        }
      } finally { db.close(); }
    },
    openReadOnly: (dbPath, key) => {
      if (typeof dbPath !== 'string' || !isAbsolute(dbPath) || dbPath.includes('\0') || /^file:/iu.test(dbPath)) throw new SqliteReaderError('database.open');
      if (!Buffer.isBuffer(key) || key.length !== 32) throw new SqliteReaderError('database.keyInvalid');
      return open(dbPath, key);
    },
  };
});
