const { app, BrowserWindow } = require('electron');
const { mkdtempSync, writeFileSync } = require('node:fs');
const path = require('node:path');
app.setPath('userData', mkdtempSync(path.join(require('node:os').tmpdir(), 'copilot-cloud-ui-')));
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  for (const width of [1280, 390]) {
    const win = new BrowserWindow({ show: false, width, height: 900, webPreferences: { sandbox: true, contextIsolation: true } });
    const prefix = process.argv.includes('--message-cards') ? 'message-card' : 'cloud-ui';
    await win.loadFile(path.resolve(`outputs/${prefix}-synthetic.html`));
    const metrics = await win.webContents.executeJavaScript('({width:innerWidth,scroll:document.documentElement.scrollWidth,inputs:[...document.querySelectorAll("input")].map(x=>x.type)})');
    writeFileSync(`outputs/${prefix}-${width}.png`, (await win.webContents.capturePage()).toPNG());
    console.log(JSON.stringify(metrics));
    win.destroy();
  }
  app.exit(0);
}).catch(error => { console.error(error.message); app.exit(1); });
