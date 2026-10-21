// No real account, credentials or CRM server are used in this transport check.
const { app, net } = require('electron');
const http = require('node:http');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
app.setPath('userData', mkdtempSync(path.join(tmpdir(), 'copilot-device-transport-')));
app.whenReady().then(async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(req.headers.cookie === 'fafuzx_device_id=synthetic-device' ? 200 : 400);
    res.end('{}');
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const response = await net.fetch(`http://127.0.0.1:${server.address().port}/verify`, {
      method: 'POST', credentials: 'omit', redirect: 'error',
      headers: { Cookie: 'fafuzx_device_id=synthetic-device', 'Content-Type': 'application/json' }, body: '{}',
    });
    await response.text();
    if (response.status !== 200) throw new Error('Device cookie was not transmitted');
    console.log('CRM_DEVICE_TRANSPORT=PASS');
    server.close(() => app.exit(0));
  } catch (error) {
    console.error(error.message);
    server.close(() => app.exit(1));
  }
});
