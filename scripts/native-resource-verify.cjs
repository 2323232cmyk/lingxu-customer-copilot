const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const manifest = require('../src/main/adapters/wechat-native/manifest-data.json');
const koffiRuntime = require('../src/main/adapters/wechat-native/adapter-runtime-data.json');

const defaultResourceRoot = path.resolve(__dirname, '..', 'native-resources', 'wechat-reader');

function verifyNativeResources(resourceRoot = defaultResourceRoot) {
  const resolvedRoot = path.resolve(resourceRoot);
  for (const resource of manifest.resources) {
    const filePath = path.join(resolvedRoot, ...resource.relativePath.split('/'));
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      throw new Error(`Native resource is missing: ${resource.relativePath}`);
    }
    if (!stat.isFile() || stat.size !== resource.size) {
      throw new Error(`Native resource size mismatch: ${resource.relativePath}`);
    }
    const actualHash = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
    if (actualHash !== resource.sha256) {
      throw new Error(`Native resource hash mismatch: ${resource.relativePath}`);
    }
  }

  const koffiPath = path.join(path.dirname(resolvedRoot), ...koffiRuntime.relativePath.split('/'));
  let koffiStat;
  try {
    koffiStat = fs.statSync(koffiPath);
  } catch {
    throw new Error(`Native adapter runtime is missing: ${koffiRuntime.relativePath}`);
  }
  if (!koffiStat.isFile() || koffiStat.size !== koffiRuntime.size) {
    throw new Error(`Native adapter runtime size mismatch: ${koffiRuntime.relativePath}`);
  }
  const koffiHash = crypto.createHash('sha256').update(fs.readFileSync(koffiPath)).digest('hex');
  if (koffiHash !== koffiRuntime.sha256) {
    throw new Error(`Native adapter runtime hash mismatch: ${koffiRuntime.relativePath}`);
  }
  for (const relativePath of [
    'koffi/LICENSE.txt',
    'koffi/vendor/node-api-headers/LICENSE',
    'koffi/vendor/node-addon-api/LICENSE.md',
  ]) {
    const licensePath = path.join(path.dirname(resolvedRoot), relativePath);
    if (!fs.existsSync(licensePath) || !fs.statSync(licensePath).isFile()
        || fs.statSync(licensePath).size === 0) {
      throw new Error(`Native adapter license is missing: ${relativePath}`);
    }
  }

  return {
    resourceRoot: resolvedRoot,
    sourceProduct: manifest.sourceProduct,
    version: manifest.sourceVersion,
    platform: manifest.platform,
    architecture: manifest.architecture,
    verifiedResources: manifest.resources.length,
    verifiedAdapterRuntimes: 1,
  };
}

if (require.main === module) {
  const resourceRoot = process.env.WECHAT_NATIVE_RESOURCE_ROOT
    ? path.resolve(process.env.WECHAT_NATIVE_RESOURCE_ROOT)
    : defaultResourceRoot;
  process.stdout.write(JSON.stringify({ ok: true, ...verifyNativeResources(resourceRoot) }));
}

module.exports = { koffiRuntime, manifest, verifyNativeResources };
