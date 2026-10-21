// Read-only public authentication probe. Never sends an account or password.
const { app, net } = require('electron');
const { mkdtempSync } = require('node:fs');
const path = require('node:path');
app.setPath('userData', mkdtempSync(path.join(require('node:os').tmpdir(), 'copilot-connectivity-')));
app.whenReady().then(async () => {
  try {
    const cloud = process.argv.includes('--cloud');
    const response = await net.fetch(cloud ? 'https://knowledge.example.com/health' : 'https://crm.example.com/api/auth/me', { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(20000) });
    console.log(JSON.stringify({ probe: 'crm-public-auth', status: response.status }));
    await response.body?.cancel();
    app.exit(response.status === (cloud ? 200 : 401) ? 0 : 1);
  } catch (error) {
    console.log(JSON.stringify({ probe: 'crm-public-auth', error: String(error.message).slice(0, 200) }));
    app.exit(1);
  }
});
