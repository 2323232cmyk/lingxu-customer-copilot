/* Build production source bundles without launching the app, reading user data,
 * preparing native payloads, making an installer, or publishing a release. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const project = path.resolve(__dirname, '..');

async function main() {
  process.chdir(project);
  const { loadConfigFromFile } = await import('vite');
  const { Listr } = require('listr2');
  const loaded = await loadConfigFromFile({ command: 'build', mode: 'production' }, path.join(project, 'forge.config.ts'));
  assert.ok(loaded, 'Forge configuration could not be loaded');
  const config = loaded.config;
  const plugin = config.plugins.find(item => item.name === 'vite');
  assert.ok(plugin, 'The configured Vite plugin is missing');
  plugin.init(project);
  const hook = plugin.getHooks().prePackage[0];
  await new Listr([{ title: 'Build the configured production bundles', task: (_context, task) => hook.call(task, config) }], { renderer: 'silent' }).run();
  const expected = ['main.js', 'preload.js', 'wechat-native-worker.js', 'voice-transcription-worker.js'];
  for (const name of expected) assert.ok(fs.statSync(path.join(project, '.vite', 'build', name)).size > 0, `Missing bundle: ${name}`);
  assert.ok(fs.statSync(path.join(project, '.vite', 'renderer', 'main_window', 'index.html')).size > 0, 'Missing renderer entry');

  // Exercise Forge's real child-process loading of the rebuilder on an empty
  // fixture. This verifies the override's API; it is NOT native-module acceptance.
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-build-check-'));
  try {
    fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ name: 'synthetic-build-check', version: '1.0.0', private: true }));
    fs.mkdirSync(path.join(fixture, 'node_modules'));
    const { listrCompatibleRebuildHook } = require('@electron-forge/core-utils/dist/rebuild.js');
    const version = require('../package.json').devDependencies.electron;
    await listrCompatibleRebuildHook(fixture, version, process.platform, process.arch, {}, { title: '', output: '', task: {} });
  } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
  const { ExternalEditor } = require('external-editor');
  const editor = new ExternalEditor('synthetic temporary-file check');
  try { assert.equal(editor.text, 'synthetic temporary-file check'); }
  finally { editor.cleanup(); }
  process.stdout.write(JSON.stringify({ ok: true, mainBundles: expected.length, renderer: true, forgeRebuildLoader: true, temporaryFileApi: true,
    appLaunched: false, nativeModulesRebuilt: false, installerCreated: false }) + '\n');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
