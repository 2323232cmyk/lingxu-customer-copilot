const { createHash } = require('node:crypto');
const { copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = String(pkg.version || '');
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('package.json 版本号无效');

const source = path.join(root, 'out', 'make', 'squirrel.windows', 'x64');
const names = ['LingxuCopilotPublic-Setup.exe', `LingxuCopilotPublic-${version}-full.nupkg`, 'RELEASES'];
for (const name of names) statSync(path.join(source, name));
const releases = readFileSync(path.join(source, 'RELEASES'), 'utf8');
if (!releases.includes(`LingxuCopilotPublic-${version}-full.nupkg`)) throw new Error('RELEASES 与当前版本不一致');

const releaseRoot = path.join(root, 'outputs', 'releases');
const destination = path.join(releaseRoot, version);
const staging = path.join(releaseRoot, `.${version}-staging-${process.pid}`);
mkdirSync(releaseRoot, { recursive: true });
try {
  statSync(destination);
  throw new Error(`发布目录已存在，禁止覆盖不可变版本：${destination}`);
} catch (error) {
  if (error && error.code !== 'ENOENT') throw error;
}
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });

const sha256 = (filename) => createHash('sha256').update(readFileSync(filename)).digest('hex');
const files = names.map((name) => {
  const from = path.join(source, name);
  const to = path.join(staging, name);
  copyFileSync(from, to);
  return { name, bytes: statSync(to).size, sha256: sha256(to) };
});
const manifest = {
  productName: pkg.productName,
  version,
  createdAt: new Date().toISOString(),
  channel: 'stable',
  architecture: 'x64',
  updateFeed: 'https://crm.example.com/updates/customer-copilot/win32/x64/',
  updateFeedStatus: 'not-deployed',
  codeSigning: 'not-signed',
  firstInstallRequiresManualSetup: true,
  files,
  publishOrder: ['*.nupkg', 'LingxuCopilotPublic-Setup.exe', 'RELEASES-last'],
};
writeFileSync(path.join(staging, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
renameSync(staging, destination);
process.stdout.write(`${JSON.stringify({ ok: true, destination, version, files })}\n`);
