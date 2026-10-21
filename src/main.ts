import { app, autoUpdater, BrowserWindow, dialog, shell } from 'electron';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import started from 'electron-squirrel-startup';
import { registerIpcHandlers } from './main/ipc';
import { isTrustedRendererUrl } from './main/renderer-trust';
import { runWechatNativePreflight } from './main/services/native-preflight';
import { runWechatConnectionCheck } from './main/services/wechat-connection-check';
import { updateWindowsDesktopBranding } from './main/services/desktop-branding';
import { startWindowsAutoUpdates } from './main/services/app-updater';

if (started) {
  app.quit();
} else if (process.argv.includes('--wechat-native-preflight')) {
  void runWechatNativePreflight();
} else if (process.argv.includes('--wechat-readonly-check')) {
  void runWechatConnectionCheck();
} else {

// Public distribution uses a separate profile and does not migrate internal credentials.
const requestedUserData = app.commandLine.getSwitchValue('user-data-dir');
const persistentUserData = requestedUserData ? path.resolve(requestedUserData) : path.join(app.getPath('appData'), 'LingxuCopilotPublic');
mkdirSync(persistentUserData, { recursive: true });
app.setPath('userData', persistentUserData);
app.setName('领序·客户参谋（公开版）');

const packagedRendererPath = path.join(
  __dirname,
  `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`,
);
const expectedRendererUrl = MAIN_WINDOW_VITE_DEV_SERVER_URL
  ? new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL).href
  : pathToFileURL(packagedRendererPath).href;
let disposeIpc = (): void => undefined;
let disposeAutoUpdates = (): void => undefined;
let desktopBrandingScheduled = false;

const createWindow = (): void => {
  const mainWindow = new BrowserWindow({
    width: 1540,
    height: 960,
    minWidth: 1180,
    minHeight: 720,
    show: false,
    backgroundColor: '#ffffff',
    title: '领序·客户参谋',
    icon: app.isPackaged ? path.join(process.resourcesPath, 'brand', 'lingxu.ico') : path.join(app.getAppPath(), 'native-resources', 'brand', 'lingxu.ico'),
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#ffffff',
      symbolColor: '#1d1d1f',
      height: 52,
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (app.isPackaged && process.platform === 'win32' && !desktopBrandingScheduled) {
      desktopBrandingScheduled = true;
      setImmediate(() => {
        void Promise.resolve().then(() => updateWindowsDesktopBranding({
          isPackaged: app.isPackaged, platform: process.platform, executablePath: process.execPath,
          resourcesPath: process.resourcesPath, desktopPath: app.getPath('desktop'),
        }, shell)).catch(() => undefined);
      });
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url === 'https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE'
      && isTrustedRendererUrl(mainWindow.webContents.getURL(), expectedRendererUrl)) {
      void shell.openExternal(url).catch(() => undefined);
    }
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    if (!isTrustedRendererUrl(targetUrl, expectedRendererUrl)) {
      event.preventDefault();
    }
  });
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(expectedRendererUrl);
  } else {
    void mainWindow.loadFile(packagedRendererPath);
  }
};

app.whenReady().then(() => {
  const registration = registerIpcHandlers(expectedRendererUrl);
  disposeIpc = registration.dispose;
  createWindow();
  const updateSession = startWindowsAutoUpdates({
    // Public source has no vendor update service.
    isPackaged: false,
    platform: process.platform,
    executablePath: process.execPath,
    updater: autoUpdater,
    confirmRestart: async (version) => {
      const messageOptions = {
        type: 'info' as const,
        title: '领序·客户参谋更新',
        message: `${version} 已下载完成`,
        detail: '现在重启即可完成更新。若正在编辑资料，请先保存，再选择“稍后”。',
        buttons: ['重启并安装', '稍后'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      };
      const parent = BrowserWindow.getAllWindows().find((window) => !window.isDestroyed());
      const result = parent ? await dialog.showMessageBox(parent, messageOptions) : await dialog.showMessageBox(messageOptions);
      return result.response === 0;
    },
  });
  disposeAutoUpdates = updateSession.dispose;
});

app.once('before-quit', () => { disposeAutoUpdates(); disposeIpc(); });

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
}
