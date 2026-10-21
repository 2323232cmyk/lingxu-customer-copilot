// Uses the production network adapter with a deliberately invalid, non-user token.
const { buildSync } = require('esbuild');
const Module = require('node:module');
const path = require('node:path');
const output = buildSync({ entryPoints: ['src/main/services/cloud-transport.ts'], bundle: true, platform: 'node', format: 'cjs', write: false });
const compiled = new Module(path.resolve('scripts/cloud-network-runtime.cjs'));
compiled._compile(output.outputFiles[0].text, path.resolve('scripts/cloud-network-runtime.cjs'));
compiled.exports.cloudTransport(fetch)('https://knowledge.example.com/v1/knowledge/status', {
  headers: { Authorization: 'Bearer synthetic-invalid-token' }, redirect: 'error', signal: AbortSignal.timeout(20000),
}).then(async response => {
  console.log(JSON.stringify({ network: 'cloud-production-adapter', httpStatus: response.status, tlsVerification: 'enabled', expected: 401 }));
  await response.body?.cancel();
  process.exitCode = response.status === 401 ? 0 : 1;
}).catch(error => { console.error(error.message); process.exitCode = 1; });
