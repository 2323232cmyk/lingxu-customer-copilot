/* Download only the fixed, redistributable SQLite dependency from upstream. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { unzipSync } = require('fflate');
const manifest = require('../src/main/adapters/wechat-native/manifest-data.json');
const URL = 'https://github.com/utelle/SQLite3MultipleCiphers/releases/download/v2.5.1/sqlite3mc-2.5.1-sqlite-3.53.4-win64.zip';
const ARCHIVE_SHA256 = '858c4f2e9e262caca06e6c4fafee62d13dd90c21b649b047f17992bf0402981e';
const root = path.resolve(__dirname, '..', 'native-resources', 'wechat-reader');
const expected = manifest.resources.find((item) => item.relativePath === 'sqlite3mc.dll');
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const valid = (bytes) => bytes.length === expected.size && hash(bytes) === expected.sha256;

async function main() {
  const destination = path.join(root, 'sqlite3mc.dll');
  if (fs.existsSync(destination)) {
    if (!valid(fs.readFileSync(destination))) throw new Error('Existing SQLite resource does not match; inspect it before replacing');
    console.log(JSON.stringify({ ok: true, reused: true, version: manifest.sourceVersion }));
    return;
  }
  const response = await fetch(URL, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`Upstream download failed (${response.status})`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length !== 6496573 || hash(bytes) !== ARCHIVE_SHA256) throw new Error('Upstream archive checksum mismatch');
  const archive = unzipSync(bytes);
  const candidates = Object.keys(archive).filter((name) => /(?:^|\/)dll\/sqlite3mc_x64\.dll$/i.test(name.replaceAll('\\', '/')));
  if (candidates.length !== 1 || !valid(archive[candidates[0]])) throw new Error('Expected SQLite DLL not found or checksum mismatch');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(destination, archive[candidates[0]], { flag: 'wx' });
  console.log(JSON.stringify({ ok: true, reused: false, version: manifest.sourceVersion, sha256: expected.sha256 }));
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
