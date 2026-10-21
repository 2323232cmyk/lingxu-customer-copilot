/* Synthetic packaged-resource check only. No application main, WeChat, CRM or model is opened. */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const argument = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const requireCheck = (condition, message) => { if (!condition) throw new Error(message); };

async function runtimeChild() {
  const resources = fs.realpathSync(argument('--resources'));
  // This synthetic runtime probe explicitly refuses Node HTTP/fetch operations.
  global.fetch = async () => { throw new Error('Network disabled in synthetic runtime probe'); };
  for (const protocol of ['node:http', 'node:https']) {
    const api = require(protocol);
    api.request = api.get = () => { throw new Error('Network disabled in synthetic runtime probe'); };
  }
  const silk = require(path.join(resources, 'silk-wasm'));
  const pcm = Buffer.alloc(6400);
  for (let index = 0; index < 3200; index += 1) pcm.writeInt16LE(Math.round(Math.sin(index * 2 * Math.PI * 440 / 16000) * 8192), index * 2);
  const encoded = await silk.encode(pcm, 16000);
  pcm.fill(0);
  const sherpa = require(path.join(resources, 'sherpa-onnx-node'));
  const binary = require(path.join(resources, 'sherpa-onnx-win-x64'));
  const version = (module) => typeof module.version === 'function' ? module.version() : module.version;
  const nativeFiles = Object.keys(require.cache).filter((file) => file.endsWith('.node'));
  requireCheck(nativeFiles.length > 0 && nativeFiles.every((file) => inside(resources, file)), 'Native module escaped packaged resource root');
  requireCheck(typeof sherpa.OfflineRecognizer?.createAsync === 'function', 'Offline recognizer API unavailable');
  process.parentPort.postMessage({ kind: 'runtime-proof', ok: true, silkBytes: encoded.data,
    proof: { silkPackage: require(path.join(resources, 'silk-wasm', 'package.json')).version,
      sherpaPackage: require(path.join(resources, 'sherpa-onnx-node', 'package.json')).version,
      nativePackage: require(path.join(resources, 'sherpa-onnx-win-x64', 'package.json')).version,
      sherpaVersion: version(sherpa), nativeVersion: version(binary),
      createAsyncAvailable: true, modelCreated: false, syntheticInput: '200 ms 440 Hz sine, PCM16 mono 16 kHz',
      syntheticSilkBytes: encoded.data.byteLength, syntheticSilkSha256: sha256(encoded.data),
      nativeModules: nativeFiles.map((file) => ({ file: path.relative(resources, file), sha256: sha256(fs.readFileSync(file)) })) } });
  encoded.data.fill(0);
}

function utility(env, filename, args, onReady) {
  const { utilityProcess } = require('electron');
  return new Promise((resolve, reject) => {
    const child = utilityProcess.fork(filename, args, { env, cwd: path.dirname(filename),
      serviceName: 'Lingxu synthetic packaged voice verification', stdio: 'pipe' });
    let finished = false;
    let stderr = '';
    const timer = setTimeout(() => done(new Error('Utility process did not finish within 25 seconds')), 25_000);
    const done = (error, value) => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      try { child.kill(); } catch { /* Exit already observed. */ }
      if (error) reject(new Error(`${error.message}${stderr ? `; stderr: ${stderr}` : ''}`));
      else resolve(value);
    };
    child.stdout?.resume();
    child.stderr?.on('data', (data) => { if (stderr.length < 2000) stderr += String(data).slice(0, 2000 - stderr.length); });
    child.once('exit', (code) => done(new Error(`Utility process exited before result: ${code}`)));
    child.on('message', (value) => {
      if (!value || typeof value !== 'object') return;
      if (value.kind === 'ready') { onReady?.(child); return; }
      if (value.ok === true && ['runtime-proof', 'decoded'].includes(value.kind)) done(null, value);
      else done(new Error(`Utility process returned failure: ${String(value.reason ?? value.kind)}`));
    });
  });
}

async function electronHost() {
  const { app, BrowserWindow, session } = require('electron');
  const resources = fs.realpathSync(argument('--resources'));
  const runRoot = fs.realpathSync(argument('--run-root'));
  const profile = path.join(runRoot, 'isolated-electron-profile');
  const emptyModel = path.join(runRoot, 'empty-model');
  fs.mkdirSync(profile); fs.mkdirSync(emptyModel);
  app.setPath('userData', profile); app.setPath('sessionData', profile);
  app.disableHardwareAcceleration(); app.commandLine.appendSwitch('disable-background-networking');
  await app.whenReady();
  session.defaultSession.webRequest.onBeforeRequest((_details, callback) => callback({ cancel: true }));
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const env = { SystemRoot: systemRoot, WINDIR: systemRoot,
    PATH: [path.join(resources, 'sherpa-onnx-win-x64'), path.join(systemRoot, 'System32')].join(path.delimiter),
    LINGXU_VOICE_RUNTIME_ROOT: resources, LINGXU_VOICE_MODEL_ROOT: emptyModel };
  try {
    const runtime = await utility(env, __filename, ['--runtime-child', '--resources', resources]);
    const workerPath = path.join(resources, 'voice-transcription-worker.js');
    const workerHash = sha256(await fsp.readFile(workerPath));
    const decoded = await utility(env, workerPath, [], (child) => child.postMessage({ kind: 'decode', bytes: runtime.silkBytes, format: 'silk' }));
    runtime.silkBytes.fill(0);
    const wav = Buffer.from(decoded.bytes); decoded.bytes.fill(0);
    requireCheck(wav.length >= 46 && wav.length <= 24 * 1024 * 1024, 'WAV length failed');
    requireCheck(wav.toString('ascii', 0, 4) === 'RIFF' && wav.toString('ascii', 8, 16) === 'WAVEfmt ', 'Not a canonical WAV');
    requireCheck(wav.readUInt32LE(4) + 8 === wav.length && wav.readUInt16LE(20) === 1 && wav.readUInt16LE(22) === 1
      && wav.readUInt16LE(34) === 16 && wav.readUInt32LE(24) === 16000, 'WAV format mismatch');
    requireCheck(wav.toString('ascii', 36, 40) === 'data' && wav.readUInt32LE(40) + 44 === wav.length, 'Incomplete WAV data');
    const sampleCount = wav.readUInt32LE(40) / 2;
    let squares = 0;
    for (let offset = 44; offset < wav.length; offset += 2) squares += wav.readInt16LE(offset) ** 2;
    const rms = Math.sqrt(squares / sampleCount);
    requireCheck(sampleCount >= 2880 && sampleCount <= 3520 && rms > 100, 'Synthetic tone not recovered');
    requireCheck((await fsp.readdir(emptyModel)).length === 0, 'Model directory was modified');
    requireCheck(BrowserWindow.getAllWindows().length === 0, 'Verification created a browser window');
    const proof = { ok: true, checkedAt: new Date().toISOString(), resources,
      electron: process.versions.electron, node: process.versions.node, chromium: process.versions.chrome,
      host: 'development Electron of the same configured version; production worker and dependencies loaded from packaged resources',
      worker: { path: workerPath, bytes: (await fsp.stat(workerPath)).size, sha256: workerHash }, runtime: runtime.proof,
      decoded: { format: 'PCM16 mono WAV', sampleRate: 16000, sampleCount, durationMs: sampleCount / 16,
        bytes: wav.length, rms: Math.round(rms * 100) / 100, sha256: sha256(wav) },
      privacy: { input: 'synthetic only', modelDirectoryEmpty: true, browserWindowsCreated: 0,
        appMainLoaded: false, wechatOrCrmRead: false, networkDownloads: false, realSpeechRecognitionVerified: false },
      note: 'Proves packaged codec and native runtime loading plus actual utility-process audio decode; does not prove real speech recognition or live customer audio.' };
    wav.fill(0);
    await fsp.writeFile(path.join(runRoot, 'proof.json'), JSON.stringify(proof, null, 2), { flag: 'wx' });
    process.stdout.write(`${JSON.stringify({ ok: true, proof: path.join(runRoot, 'proof.json'), electron: proof.electron,
      runtimeVersion: proof.runtime.sherpaVersion, decoded: proof.decoded })}\n`);
    app.exit(0);
  } catch (error) {
    const failure = { ok: false, checkedAt: new Date().toISOString(), error: String(error?.message ?? error) };
    await fsp.writeFile(path.join(runRoot, 'failure.json'), JSON.stringify(failure, null, 2));
    process.stdout.write(`${JSON.stringify(failure)}\n`); app.exit(1);
  }
}

async function launch() {
  const { spawn } = require('node:child_process');
  const project = path.resolve(__dirname, '..');
  const resources = fs.realpathSync(argument('--resources') ?? path.join(project, 'out', '领序·客户参谋-win32-x64', 'resources'));
  for (const file of ['voice-transcription-worker.js', 'silk-wasm/package.json', 'sherpa-onnx-node/package.json', 'sherpa-onnx-win-x64/sherpa-onnx.node']) {
    requireCheck(fs.statSync(path.join(resources, file)).isFile(), `Missing packaged file: ${file}`);
  }
  const output = path.join(project, 'outputs', 'ui-brand-check');
  await fsp.mkdir(output, { recursive: true });
  const runRoot = await fsp.mkdtemp(path.join(output, 'packaged-voice-'));
  const electron = path.join(project, 'node_modules', 'electron', 'dist', 'electron.exe');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [__filename, '--resources', resources, '--run-root', runRoot], {
    cwd: project, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const timer = setTimeout(() => child.kill(), 60_000);
  child.stdout.on('data', (chunk) => process.stdout.write(chunk));
  child.stderr.resume();
  child.once('error', (error) => { clearTimeout(timer); process.stderr.write(String(error.message)); process.exitCode = 1; });
  child.once('exit', (code) => { clearTimeout(timer); process.exitCode = code === 0 ? 0 : 1; });
}

if (process.parentPort && process.argv.includes('--runtime-child')) {
  runtimeChild().catch((error) => process.parentPort.postMessage({ kind: 'runtime-proof', ok: false, reason: String(error?.message ?? error) }));
} else if (process.versions.electron && process.type === 'browser') {
  electronHost().catch((error) => { process.stderr.write(String(error?.message ?? error)); require('electron').app.exit(1); });
} else {
  launch().catch((error) => { process.stderr.write(String(error?.message ?? error)); process.exitCode = 1; });
}
