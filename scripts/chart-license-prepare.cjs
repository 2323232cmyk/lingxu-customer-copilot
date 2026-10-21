const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const projectRoot = path.resolve(__dirname, '..');
const resourceDirectory = 'native-resources/chart-licenses';
const sourceFile = 'scripts/chart-license-sources.json';
const generatedBy = 'scripts/chart-license-prepare.cjs';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function validateRelativePath(relativePath) {
  assert(typeof relativePath === 'string' && relativePath.length > 0,
    'Expected a nonempty relative path');
  assert(relativePath.split('/').every((part) =>
    part !== '.' && part !== '..' && /^[A-Za-z0-9@_.+-]+$/.test(part)),
  'Unsafe relative path: ' + relativePath);
  return relativePath;
}

function existingStat(absolutePath) {
  try {
    return fs.lstatSync(absolutePath);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

// Check every ancestor, including Windows junctions, before reading or writing.
function checkedPath(relativePath, allowMissing = false) {
  const parts = validateRelativePath(relativePath).split('/');
  let absolutePath = projectRoot;
  for (let index = 0; index < parts.length; index += 1) {
    absolutePath = path.join(absolutePath, parts[index]);
    const stat = existingStat(absolutePath);
    if (!stat) {
      assert(allowMissing, 'Missing file or directory: ' + relativePath);
      continue;
    }
    assert(!stat.isSymbolicLink(), 'Link paths are not allowed: ' + relativePath);
    if (index < parts.length - 1) {
      assert(stat.isDirectory(), 'Expected directory: ' + relativePath);
    }
  }
  return absolutePath;
}

function readFile(relativePath) {
  const absolutePath = checkedPath(relativePath);
  assert(fs.lstatSync(absolutePath).isFile(), 'Expected file: ' + relativePath);
  return fs.readFileSync(absolutePath);
}

function verifyBytes(content, expected, description) {
  assert(Number.isSafeInteger(expected.bytes) && expected.bytes > 0,
    'Invalid expected size: ' + description);
  assert(typeof expected.sha256 === 'string' && /^[a-f0-9]{64}$/.test(expected.sha256),
    'Invalid expected hash: ' + description);
  assert(content.length === expected.bytes && sha256(content) === expected.sha256,
    'Content hash or size mismatch: ' + description);
}

function buildOutputs() {
  const sourceBytes = readFile(sourceFile);
  const source = JSON.parse(sourceBytes.toString('utf8'));
  const lock = JSON.parse(readFile('package-lock.json').toString('utf8'));
  const project = JSON.parse(readFile('package.json').toString('utf8'));
  assert(source.schemaVersion === 1, 'Unsupported chart license source schema');
  assert(source.rootDependency?.name === 'recharts'
    && source.rootDependency.version === '3.10.1', 'Unexpected chart dependency');
  assert(project.dependencies?.recharts === source.rootDependency.version
    && lock.packages?.['']?.dependencies?.recharts === source.rootDependency.version,
  'Recharts must remain pinned to the reviewed version');
  assert(Array.isArray(source.packages) && source.packages.length === source.packageCount,
    'Package inventory count mismatch');
  assert(Array.isArray(source.upstreamLicenses), 'Missing upstream license inventory');

  const outputs = new Map();
  const caseInsensitivePaths = new Set();
  const packageNames = new Set();
  const packages = [];
  const fileRecords = [];
  const noticeParts = [Buffer.from(
    'Third-party notices for Recharts 3.10.1\n\n'
    + 'This directory retains a conservative installed dependency license set, including\n'
    + 'shared peer and type packages. It does not assert that every package is present\n'
    + 'in the tree-shaken runtime bundle. All original notices and license text are\n'
    + 'retained in separate files; vendored components may have additional licenses.\n'
    + 'Prepared offline from pinned local sources. No local absolute paths are included.\n',
  )];

  function addOutput(relativePath, content) {
    validateRelativePath(relativePath);
    const normalized = relativePath.toLowerCase();
    assert(!caseInsensitivePaths.has(normalized), 'Duplicate output: ' + relativePath);
    caseInsensitivePaths.add(normalized);
    outputs.set(relativePath, content);
    return { path: relativePath, bytes: content.length, sha256: sha256(content) };
  }

  function addLicense(pkg, relativePath, content, origin) {
    const outputPath = 'packages/' + pkg.name + '@' + pkg.version + '/' + relativePath;
    const record = { ...addOutput(outputPath, content), ...origin };
    fileRecords.push(record);
    pkg.licenseFiles.push(record);
    noticeParts.push(
      Buffer.from('\n\n--- ' + pkg.name + '@' + pkg.version + ' / ' + relativePath
        + ' ---\nDeclared package license: ' + pkg.declaredLicense
        + '\nSource: ' + origin.source + '\n\n'),
      content,
    );
  }

  let localLicenseFileCount = 0;
  for (const expected of source.packages) {
    assert(typeof expected.name === 'string'
      && /^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/.test(expected.name),
    'Invalid package name');
    assert(typeof expected.version === 'string' && /^[0-9A-Za-z.+-]+$/.test(expected.version),
      'Invalid package version: ' + expected.name);
    assert(typeof expected.declaredLicense === 'string'
      && /^[A-Za-z0-9(). +_-]+$/.test(expected.declaredLicense),
    'Invalid license identifier: ' + expected.name);
    assert(!packageNames.has(expected.name), 'Duplicate package: ' + expected.name);
    packageNames.add(expected.name);
    assert(expected.packagePath === 'node_modules/' + expected.name,
      'Unexpected package source path: ' + expected.name);

    const packageBytes = readFile(expected.packagePath + '/package.json');
    const installed = JSON.parse(packageBytes.toString('utf8'));
    assert(installed.name === expected.name && installed.version === expected.version,
      'Installed package version mismatch: ' + expected.name);
    assert(lock.packages?.[expected.packagePath]?.version === expected.version,
      'Lockfile package version mismatch: ' + expected.name);
    assert(sha256(packageBytes) === expected.packageJsonSha256,
      'Installed package metadata mismatch: ' + expected.name);
    assert(Array.isArray(expected.licenseFiles) && expected.licenseFiles.length > 0,
      'Missing license inventory: ' + expected.name);

    const pkg = {
      name: expected.name,
      version: expected.version,
      declaredLicense: expected.declaredLicense,
      licenseFiles: [],
    };
    for (const license of expected.licenseFiles) {
      const licensePath = expected.packagePath + '/' + validateRelativePath(license.path);
      const content = readFile(licensePath);
      verifyBytes(content, license, licensePath);
      addLicense(pkg, license.path, content, { kind: 'installed', source: licensePath });
      localLicenseFileCount += 1;
    }
    for (const license of source.upstreamLicenses.filter((item) =>
      item.packageName === expected.name)) {
      assert(license.packageVersion === expected.version, 'Upstream license version mismatch');
      assert(license.sourceUrl ===
        'https://raw.githubusercontent.com/FormidableLabs/victory/v37.3.6/LICENSE.txt'
        && expected.name === 'victory-vendor' && license.license === 'MIT',
      'Unreviewed upstream license source');
      assert(typeof license.text === 'string', 'Missing local upstream license text');
      const content = Buffer.from(license.text, 'utf8');
      verifyBytes(content, license, license.sourceUrl);
      addLicense(pkg, validateRelativePath(license.path), content,
        { kind: 'upstream', source: license.sourceUrl, license: license.license });
    }
    packages.push(pkg);
  }
  assert(localLicenseFileCount === source.localLicenseFileCount,
    'Local license file count mismatch');
  assert(fileRecords.length === localLicenseFileCount + source.upstreamLicenses.length,
    'Unmatched upstream license source');
  assert(packageNames.has('recharts'), 'Recharts license is missing');

  const notice = Buffer.concat([...noticeParts, Buffer.from('\n')]);
  const noticeRecord = addOutput('NOTICE.txt', notice);
  const manifest = {
    schemaVersion: 1,
    generatedBy,
    rootDependency: 'recharts@3.10.1',
    // Formatting and checkout line endings must not change generated resources.
    sourceManifestSha256: sha256(Buffer.from(JSON.stringify(source))),
    packageCount: packages.length,
    localLicenseFileCount,
    upstreamLicenseFileCount: source.upstreamLicenses.length,
    packages,
    files: [...fileRecords, noticeRecord],
  };
  addOutput('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
  return { outputs, packageCount: packages.length, licenseFileCount: fileRecords.length };
}

function preflightOutputs(outputs, checkOnly) {
  const allowedDirectories = new Set(['']);
  for (const relativePath of outputs.keys()) {
    const parts = relativePath.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      allowedDirectories.add(parts.slice(0, index).join('/'));
    }
  }

  const rootPath = checkedPath(resourceDirectory, true);
  const rootStat = existingStat(rootPath);
  const existing = new Set();
  if (rootStat) {
    assert(rootStat.isDirectory(), 'Chart resource path is not a directory');
    function visit(relativeDirectory) {
      const directory = checkedPath(resourceDirectory
        + (relativeDirectory ? '/' + relativeDirectory : ''));
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const relativePath = relativeDirectory
          ? relativeDirectory + '/' + entry.name : entry.name;
        const absolutePath = checkedPath(resourceDirectory + '/' + relativePath);
        const stat = fs.lstatSync(absolutePath);
        if (stat.isDirectory()) {
          assert(allowedDirectories.has(relativePath),
            'Unrecognized output directory; preserving it: ' + relativePath);
          visit(relativePath);
        } else {
          assert(stat.isFile() && outputs.has(relativePath),
            'Unrecognized output file; preserving it: ' + relativePath);
          assert(fs.readFileSync(absolutePath).equals(outputs.get(relativePath)),
            'Existing output differs; refusing to overwrite: ' + relativePath);
          existing.add(relativePath);
        }
      }
    }
    visit('');
  }
  if (checkOnly) {
    for (const relativePath of outputs.keys()) {
      assert(existing.has(relativePath), 'Prepared resource is missing: ' + relativePath);
    }
  }
  return existing;
}

function ensureOutputDirectory(relativeFile) {
  const folders = relativeFile.split('/').slice(0, -1);
  let relativeDirectory = resourceDirectory;
  for (let index = 0; index <= folders.length; index += 1) {
    if (index > 0) relativeDirectory += '/' + folders[index - 1];
    const absolutePath = checkedPath(relativeDirectory, true);
    const stat = existingStat(absolutePath);
    if (!stat) fs.mkdirSync(absolutePath);
    else assert(stat.isDirectory(), 'Expected output directory: ' + relativeDirectory);
  }
}

function prepareChartLicenses({ checkOnly = false } = {}) {
  assert(fs.lstatSync(checkedPath('native-resources')).isDirectory(),
    'Native resource directory must already exist');
  const { outputs, packageCount, licenseFileCount } = buildOutputs();
  // Validate every source and existing output before any filesystem mutation.
  const existing = preflightOutputs(outputs, checkOnly);
  let createdFiles = 0;
  if (!checkOnly) {
    for (const [relativePath, content] of outputs) {
      if (existing.has(relativePath)) continue;
      ensureOutputDirectory(relativePath);
      const absolutePath = checkedPath(resourceDirectory + '/' + relativePath, true);
      // Never truncate an existing file, including a concurrent writer's output.
      fs.writeFileSync(absolutePath, content, { flag: 'wx' });
      createdFiles += 1;
    }
    preflightOutputs(outputs, true);
  }
  return {
    ok: true,
    mode: checkOnly ? 'verify' : 'prepare',
    resourceDirectory,
    packageCount,
    licenseFileCount,
    verifiedFiles: outputs.size,
    createdFiles,
  };
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    assert(args.length === 0 || (args.length === 1 && args[0] === '--check'),
      'Usage: node scripts/chart-license-prepare.cjs [--check]');
    process.stdout.write(JSON.stringify(
      prepareChartLicenses({ checkOnly: args[0] === '--check' }), null, 2,
    ) + '\n');
  } catch (error) {
    process.stderr.write('Chart license preparation failed: ' + error.message + '\n');
    process.exitCode = 1;
  }
}

module.exports = { prepareChartLicenses };
