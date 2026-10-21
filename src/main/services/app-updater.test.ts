import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isTrustedWindowsUpdateFeed,
  squirrelUpdateExecutable,
  startWindowsAutoUpdates,
  WINDOWS_UPDATE_FEED_URL,
} from './app-updater';

class TestUpdater extends EventEmitter {
  setFeedURL = vi.fn();
  checkForUpdates = vi.fn();
  quitAndInstall = vi.fn();
}

const installedExecutable = 'C:\\Users\\test\\AppData\\Local\\LingxuCopilotPublic\\app-0.9.0\\LingxuCopilotPublic.exe';

describe('Windows auto updates', () => {
  beforeEach(() => { vi.useFakeTimers(); });

  it('recognizes only a versioned Squirrel installation and the fixed HTTPS feed', () => {
    expect(squirrelUpdateExecutable(installedExecutable)).toBe('C:\\Users\\test\\AppData\\Local\\LingxuCopilotPublic\\Update.exe');
    expect(squirrelUpdateExecutable('C:\\portable\\LingxuCopilotPublic.exe')).toBeNull();
    expect(isTrustedWindowsUpdateFeed(WINDOWS_UPDATE_FEED_URL)).toBe(true);
    expect(isTrustedWindowsUpdateFeed('http://crm.example.com/updates/customer-copilot/win32/x64/')).toBe(false);
    expect(isTrustedWindowsUpdateFeed('https://crm.example.com.evil.test/updates/customer-copilot/win32/x64/')).toBe(false);
  });

  it.each([
    { isPackaged: false, platform: 'win32' as const, exists: true },
    { isPackaged: true, platform: 'linux' as const, exists: true },
    { isPackaged: true, platform: 'win32' as const, exists: false },
  ])('does not enable outside an installed Windows package: %o', ({ isPackaged, platform, exists }) => {
    const updater = new TestUpdater();
    const session = startWindowsAutoUpdates({
      isPackaged, platform, executablePath: installedExecutable, updater,
      confirmRestart: vi.fn(), fileExists: () => exists,
    });
    expect(session.enabled).toBe(false);
    expect(updater.setFeedURL).not.toHaveBeenCalled();
  });

  it('checks after the delay, prevents duplicate checks and retries on the interval', () => {
    const updater = new TestUpdater();
    const session = startWindowsAutoUpdates({
      isPackaged: true, platform: 'win32', executablePath: installedExecutable, updater,
      confirmRestart: vi.fn(), fileExists: () => true, initialDelayMs: 50, intervalMs: 200,
    });
    expect(session.enabled).toBe(true);
    expect(updater.setFeedURL).toHaveBeenCalledWith({ url: WINDOWS_UPDATE_FEED_URL });
    vi.advanceTimersByTime(50);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(session.checkNow()).toBe(false);
    updater.emit('update-not-available');
    vi.advanceTimersByTime(150);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
    session.dispose();
    updater.emit('update-not-available');
    vi.advanceTimersByTime(1_000);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it('installs only after a downloaded update and explicit confirmation', async () => {
    const updater = new TestUpdater();
    const confirmRestart = vi.fn().mockResolvedValue(true);
    const session = startWindowsAutoUpdates({
      isPackaged: true, platform: 'win32', executablePath: installedExecutable, updater,
      confirmRestart, fileExists: () => true,
    });
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    updater.emit('update-downloaded', {}, '<b>untrusted</b>', '0.9.1');
    await Promise.resolve();
    expect(confirmRestart).toHaveBeenCalledWith('0.9.1');
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
    session.dispose();
  });

  it('does not expose raw update errors and does not force restart when deferred', async () => {
    const updater = new TestUpdater();
    const log = vi.fn();
    const confirmRestart = vi.fn().mockResolvedValue(false);
    const session = startWindowsAutoUpdates({
      isPackaged: true, platform: 'win32', executablePath: installedExecutable, updater,
      confirmRestart, fileExists: () => true, log,
    });
    updater.emit('error', new Error('private feed path and token'));
    expect(JSON.stringify(log.mock.calls)).not.toContain('private');
    updater.emit('update-downloaded', {}, 'remote notes', '<script>bad</script>');
    await Promise.resolve();
    expect(confirmRestart).toHaveBeenCalledWith('新版本');
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    session.dispose();
  });
});
