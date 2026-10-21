const { app, utilityProcess } = require('electron');
const { readFileSync } = require('node:fs');
const path = require('node:path');
app.whenReady().then(() => {
  const runtime = path.resolve(process.argv[2]);
  const input = readFileSync(path.resolve(process.argv[3]));
  const child = utilityProcess.fork(process.argv[4] || path.join(runtime, 'app.asar', '.vite', 'build', 'voice-transcription-worker.js'), [], {
    stdio: 'pipe', env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot,
      PATH: [path.join(runtime, 'sherpa-onnx-win-x64'), path.join(process.env.SystemRoot, 'System32')].join(path.delimiter),
      LINGXU_VOICE_RUNTIME_ROOT: runtime,
      LINGXU_VOICE_MODEL_ROOT: process.argv[5] || path.join(app.getPath('userData'), 'offline-models', 'sensevoice-int8') },
  });
  let done = false;
  const finish = (result) => { if (done) return; done = true; console.log(JSON.stringify(result)); input.fill(0); child.kill(); app.exit(result.ok ? 0 : 1); };
  child.stdout?.resume(); child.stderr?.resume();
  child.once('exit', code => finish({ ok: false, phase: 'worker-exit', code }));
  child.on('message', value => {
    if (value.kind === 'ready') child.postMessage({ kind: 'transcribe', bytes: input, format: 'wav' });
    else if (value.kind === 'result') finish({ ok: value.ok, reason: value.reason, phase: value.phase, characters: value.text?.length ?? 0 });
  });
  setTimeout(() => finish({ ok: false, phase: 'timeout' }), 60000);
}).catch(() => app.exit(1));
