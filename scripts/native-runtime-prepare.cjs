const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const runtime = require('../src/main/adapters/wechat-native/adapter-runtime-data.json');

const sourcePath = path.resolve(
  __dirname,
  '..',
  'node_modules',
  '@koromix',
  'koffi-win32-x64',
  'win32_x64',
  'koffi.node',
);
const destinationPath = path.resolve(
  __dirname,
  '..',
  'native-resources',
  'koffi',
  'win32_x64',
  'koffi.node',
);
const koffiPackageRoot = path.resolve(__dirname, '..', 'node_modules', 'koffi');
const koffiResourceRoot = path.dirname(path.dirname(destinationPath));
const licenseFiles = [
  'LICENSE.txt',
  'vendor/node-api-headers/LICENSE',
  'vendor/node-addon-api/LICENSE.md',
];

function assertKoffiNode(filePath) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size !== runtime.size) {
    throw new Error('Koffi native runtime size mismatch');
  }
  const actualHash = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  if (actualHash !== runtime.sha256) {
    throw new Error('Koffi native runtime hash mismatch');
  }
}

assertKoffiNode(sourcePath);
fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
fs.copyFileSync(sourcePath, destinationPath);
assertKoffiNode(destinationPath);
for (const relativePath of licenseFiles) {
  const sourceLicense = path.join(koffiPackageRoot, relativePath);
  const destinationLicense = path.join(koffiResourceRoot, relativePath);
  fs.mkdirSync(path.dirname(destinationLicense), { recursive: true });
  fs.copyFileSync(sourceLicense, destinationLicense);
}

process.stdout.write(JSON.stringify({
  ok: true,
  version: runtime.sourceVersion,
  destinationPath,
  size: runtime.size,
  sha256: runtime.sha256,
  bundledLicenses: licenseFiles.length,
}));
