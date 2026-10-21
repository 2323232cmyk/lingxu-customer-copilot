/* Explicitly invoked, no-window read-only check of this app's already saved CRM session. */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const argument = (name) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function electronHost() {
  const { app, BrowserWindow, safeStorage, session } = require('electron');
  const runRoot = fs.realpathSync(argument('--run-root'));
  const settingsPath = fs.realpathSync(argument('--settings'));
  const profile = path.join(runRoot, 'isolated-profile');
  fs.mkdirSync(profile);
  app.setPath('userData', profile);
  app.setPath('sessionData', profile);
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-background-networking');
  await app.whenReady();
  session.defaultSession.webRequest.onBeforeRequest((_request, callback) => callback({ cancel: true }));
  const { IntegrationSettingsStore, ReadOnlyCrmConnector, CrmHttpError } = require(argument('--bundle'));
  const before = fs.readFileSync(settingsPath);
  const settingsHash = sha256(before);
  const saved = JSON.parse(before.toString('utf8'));
  before.fill(0);
  const crmCiphertext = typeof saved.crmToken === 'string' ? saved.crmToken : '';
  const credentialCheck = { secureStorageAvailable: safeStorage.isEncryptionAvailable(), storedCiphertextPresent: Boolean(crmCiphertext),
    encryptedBytes: Buffer.from(crmCiphertext, 'base64').length, decryptAttempted: false, decryptSucceeded: false };
  // Do not decrypt an AI-provider key while inspecting only the CRM integration.
  const crmOnlyStorage = {
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    encryptString: () => { throw new Error('Writes are forbidden in this read-only check'); },
    decryptString: (bytes) => {
      if (!crmCiphertext || bytes.toString('base64') !== crmCiphertext) throw new Error('Not a CRM credential');
      credentialCheck.decryptAttempted = true;
      const value = safeStorage.decryptString(bytes);
      credentialCheck.decryptSucceeded = Boolean(value);
      return value;
    },
  };
  const store = new IntegrationSettingsStore(settingsPath, crmOnlyStorage);
  const configured = store.getCrmSettings();
  const token = store.getCrmToken();
  const proof = { ok: false, checkedAt: new Date().toISOString(), baseUrl: configured.baseUrl,
    hasSession: Boolean(token), credentialCheck, checks: {}, requests: [],
    privacy: { appMainLoaded: false, browserWindowsCreated: 0, wechatRead: false,
      loginAttempted: false, credentialsPrinted: false, customerRecordsPrinted: false, sourceSettingsUnchanged: false } };
  let exitCode = 1;
  try {
    if (!configured.baseUrl || !token) {
      proof.reason = configured.baseUrl ? 'saved-session-unavailable' : 'not-configured';
    } else {
      const origin = new URL(configured.baseUrl).origin;
      const fetcher = async (url, options) => {
        const target = new URL(String(url));
        if (target.origin !== origin || !['/api/auth/me', '/api/customers', '/api/dashboard', '/api/tasks'].includes(target.pathname)
          || options?.method !== 'GET' || target.searchParams.has('export')) throw new Error('Non-read-only diagnostic request');
        const started = performance.now();
        const response = await fetch(url, { ...options, redirect: 'error' });
        proof.requests.push({ endpoint: target.pathname, method: 'GET', status: response.status, elapsedMs: Math.round(performance.now() - started) });
        return response;
      };
      // No onToken callback: a 401 must not rewrite the user's persisted session.
      const crm = new ReadOnlyCrmConnector(configured.baseUrl, { token, fetch: fetcher, allowInsecureHttp: configured.allowInsecureHttp, timeoutMs: 8000 });
      const check = async (name, read, summarize) => {
        const started = performance.now();
        try {
          const result = await read();
          proof.checks[name] = { ok: true, elapsedMs: Math.round(performance.now() - started), ...summarize(result) };
          return result;
        } catch (error) {
          proof.checks[name] = { ok: false, elapsedMs: Math.round(performance.now() - started),
            ...(error instanceof CrmHttpError ? { httpStatus: error.status } : {}), reason: 'request-or-contract-failed' };
          throw error;
        }
      };
      await check('session', () => crm.getCurrentUser(), () => ({}));
      await check('customers', () => crm.listCustomers({ page: 1, limit: 50 }), (page) => ({ count: page.customers.length, total: page.total, page: page.page, hasMore: page.hasMore }));
      await check('dashboard', () => crm.getWorkspaceOverview(), (overview) => ({ scope: overview.scopeLabel, stats: overview.stats,
        todayCount: overview.today.length, overdueCount: overview.overdue.length, futureCount: overview.future.length, trendDays: overview.workTrend.length }));
      await check('tasks', () => crm.listTasks({ scope: 'all', done: 'open', ownOnly: true }), (tasks) => ({ count: tasks.tasks.length, ownOnly: tasks.ownOnly }));
      proof.ok = true;
      exitCode = 0;
    }
  } catch (error) {
    proof.reason = error instanceof CrmHttpError && error.status === 401 ? 'session-expired-no-login-attempted' : 'read-only-check-failed';
  } finally {
    proof.privacy.browserWindowsCreated = BrowserWindow.getAllWindows().length;
    proof.privacy.sourceSettingsUnchanged = sha256(fs.readFileSync(settingsPath)) === settingsHash;
    if (!proof.privacy.sourceSettingsUnchanged || proof.privacy.browserWindowsCreated !== 0) { proof.ok = false; exitCode = 1; }
    const proofPath = path.join(runRoot, 'proof.json');
    await fsp.writeFile(proofPath, JSON.stringify(proof, null, 2), { flag: 'wx' });
    process.stdout.write(`${JSON.stringify({ ...proof, proofPath })}\n`);
    app.exit(exitCode);
  }
}

async function launch() {
  const { spawn } = require('node:child_process');
  const project = path.resolve(__dirname, '..');
  const requestedSettings = argument('--settings');
  if (!requestedSettings) throw new Error('Pass the explicit path to this app\'s integrations.json');
  const settingsPath = fs.realpathSync(requestedSettings);
  if (path.basename(settingsPath) !== 'integrations.json' || fs.statSync(settingsPath).size > 64 * 1024) throw new Error('Invalid integration settings source');
  const output = path.join(project, 'outputs', 'crm-workspace-check');
  await fsp.mkdir(output, { recursive: true });
  const runRoot = await fsp.mkdtemp(path.join(output, 'readonly-'));
  const bundle = path.join(runRoot, 'crm-readonly.cjs');
  await require('esbuild').build({
    stdin: { contents: "export { IntegrationSettingsStore } from './src/main/services/integration-settings'; export { ReadOnlyCrmConnector, CrmHttpError } from './src/main/connectors/crm-connector';", resolveDir: project, loader: 'ts' },
    bundle: true, platform: 'node', format: 'cjs', outfile: bundle, logLevel: 'silent',
  });
  const electron = path.join(project, 'node_modules', 'electron', 'dist', 'electron.exe');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [__filename, '--run-root', runRoot, '--bundle', bundle, '--settings', settingsPath], {
    cwd: project, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const timer = setTimeout(() => child.kill(), 60_000);
  child.stdout.on('data', (chunk) => process.stdout.write(chunk));
  // Chromium diagnostics are not evidence and must not accidentally print customer material.
  child.stderr.resume();
  child.once('error', () => { clearTimeout(timer); process.stderr.write('Could not start isolated CRM verification\n'); process.exitCode = 1; });
  child.once('exit', (code) => { clearTimeout(timer); process.exitCode = code === 0 ? 0 : 1; });
}

if (process.versions.electron && process.type === 'browser') {
  electronHost().catch(() => { process.stdout.write('{"ok":false,"reason":"isolated-probe-startup-failed"}\n'); require('electron').app.exit(1); });
} else {
  launch().catch(() => { process.stderr.write('Could not prepare read-only CRM verification\n'); process.exitCode = 1; });
}
