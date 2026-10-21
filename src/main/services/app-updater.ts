import type { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import path from 'node:path';

export const WINDOWS_UPDATE_FEED_URL = 'https://crm.example.com/updates/customer-copilot/win32/x64/';
export const UPDATE_INITIAL_DELAY_MS = 30_000;
export const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface UpdateEngine extends EventEmitter {
  setFeedURL(options: { url: string }): void;
  checkForUpdates(): void;
  quitAndInstall(): void;
}

export interface WindowsAutoUpdateOptions {
  isPackaged: boolean;
  platform: NodeJS.Platform;
  executablePath: string;
  updater: UpdateEngine;
  confirmRestart(version: string): Promise<boolean>;
  fileExists?: (filename: string) => boolean;
  log?: (message: string) => void;
  initialDelayMs?: number;
  intervalMs?: number;
}

export interface AutoUpdateSession {
  enabled: boolean;
  checkNow(): boolean;
  dispose(): void;
}

const disabledSession = (): AutoUpdateSession => ({ enabled: false, checkNow: () => false, dispose: () => undefined });

export function squirrelUpdateExecutable(executablePath: string): string | null {
  const executable = path.win32.resolve(executablePath);
  const versionDirectory = path.win32.dirname(executable);
  if (!/^app-\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(path.win32.basename(versionDirectory))) return null;
  return path.win32.join(path.win32.dirname(versionDirectory), 'Update.exe');
}

export function isTrustedWindowsUpdateFeed(value: string): boolean {
  try {
    return new URL(value).href === new URL(WINDOWS_UPDATE_FEED_URL).href;
  } catch {
    return false;
  }
}

function displayVersion(value: unknown): string {
  return typeof value === 'string' && /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/u.test(value) ? value : '新版本';
}

export function startWindowsAutoUpdates(options: WindowsAutoUpdateOptions): AutoUpdateSession {
  const fileExists = options.fileExists ?? existsSync;
  const log = options.log ?? ((message: string) => console.warn(message));
  if (!options.isPackaged || options.platform !== 'win32' || !isTrustedWindowsUpdateFeed(WINDOWS_UPDATE_FEED_URL)) return disabledSession();
  const updateExecutable = squirrelUpdateExecutable(options.executablePath);
  if (!updateExecutable || !fileExists(updateExecutable)) return disabledSession();

  let disposed = false;
  let checking = false;
  let notified = false;
  const onChecking = (): void => { checking = true; };
  const onAvailable = (): void => { checking = true; };
  const onIdle = (): void => { checking = false; };
  const onError = (): void => { checking = false; log('自动更新暂时不可用，软件会在稍后重新检查。'); };
  const onDownloaded = (_event: unknown, _releaseNotes: unknown, releaseName: unknown): void => {
    checking = false;
    if (disposed || notified) return;
    notified = true;
    void options.confirmRestart(displayVersion(releaseName)).then((restart) => {
      if (restart && !disposed) options.updater.quitAndInstall();
    }).catch(() => log('更新已经下载，但暂时无法显示重启确认；下次启动软件前请先保存工作。'));
  };

  try {
    options.updater.setFeedURL({ url: WINDOWS_UPDATE_FEED_URL });
  } catch {
    log('自动更新配置暂时不可用，本次启动不会检查更新。');
    return disabledSession();
  }

  options.updater.on('checking-for-update', onChecking);
  options.updater.on('update-available', onAvailable);
  options.updater.on('update-not-available', onIdle);
  options.updater.on('update-downloaded', onDownloaded);
  options.updater.on('error', onError);

  const checkNow = (): boolean => {
    if (disposed || checking || notified) return false;
    checking = true;
    try {
      options.updater.checkForUpdates();
      return true;
    } catch {
      checking = false;
      log('自动更新暂时不可用，软件会在稍后重新检查。');
      return false;
    }
  };
  const initialTimer = setTimeout(checkNow, options.initialDelayMs ?? UPDATE_INITIAL_DELAY_MS);
  const intervalTimer = setInterval(checkNow, options.intervalMs ?? UPDATE_INTERVAL_MS);
  initialTimer.unref();
  intervalTimer.unref();

  return {
    enabled: true,
    checkNow,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      clearTimeout(initialTimer);
      clearInterval(intervalTimer);
      options.updater.removeListener('checking-for-update', onChecking);
      options.updater.removeListener('update-available', onAvailable);
      options.updater.removeListener('update-not-available', onIdle);
      options.updater.removeListener('update-downloaded', onDownloaded);
      options.updater.removeListener('error', onError);
    },
  };
}
