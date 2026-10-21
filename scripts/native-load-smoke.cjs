const path = require('node:path');
const koffi = require('koffi');
const { manifest, verifyNativeResources } = require('./native-resource-verify.cjs');

const resourceRoot = process.env.WECHAT_NATIVE_RESOURCE_ROOT
  ? path.resolve(process.env.WECHAT_NATIVE_RESOURCE_ROOT)
  : path.resolve(__dirname, '..', 'native-resources', 'wechat-reader');

if (process.platform !== manifest.platform || process.arch !== manifest.architecture) {
  throw new Error(`Native smoke test requires ${manifest.platform}/${manifest.architecture}`);
}
verifyNativeResources(resourceRoot);

const readerLib = koffi.load(path.join(resourceRoot, 'sqlite3mc.dll'));
// Resolve only: no exported function is called and no database is opened.
readerLib.func('const char* sqlite3_libversion()');
readerLib.func('const char* sqlite3mc_version()');
readerLib.func('int sqlite3_open_v2(const char* filename, _Out_ void** db, int flags, const char* vfs)');
readerLib.func('int sqlite3_key_v2(void* db, const char* dbName, const void* key, int length)');
readerLib.func('int sqlite3mc_config(void* db, const char* parameter, int newValue)');
readerLib.func('int sqlite3mc_cipher_index(const char* cipherName)');
readerLib.func('int sqlite3_close_v2(void* db)');
readerLib.func('int sqlite3_prepare_v2(void* db, const char* sql, int length, _Out_ void** statement, _Out_ void** tail)');
readerLib.func('int sqlite3_step(void* statement)');
readerLib.func('int sqlite3_finalize(void* statement)');
readerLib.func('const char* sqlite3_errmsg(void* db)');
readerLib.func('int sqlite3_busy_timeout(void* db, int milliseconds)');
readerLib.func('int sqlite3_column_count(void* statement)');
readerLib.func('const char* sqlite3_column_name(void* statement, int column)');
readerLib.func('int sqlite3_column_type(void* statement, int column)');
readerLib.func('const char* sqlite3_column_text(void* statement, int column)');
readerLib.func('const void* sqlite3_column_blob(void* statement, int column)');
readerLib.func('int sqlite3_column_bytes(void* statement, int column)');
readerLib.func('int64_t sqlite3_column_int64(void* statement, int column)');
readerLib.unload();

process.stdout.write(JSON.stringify({
  ok: true,
  sourceProduct: manifest.sourceProduct,
  version: manifest.sourceVersion,
  platform: process.platform,
  architecture: process.arch,
  verifiedResources: manifest.resources.length,
  loadedLibraries: ['sqlite3mc.dll'],
  dllEntryPointsMayHaveRun: true,
  calledExportedFunctions: false,
}));
