import { createHash } from 'node:crypto';
import { constants, readFileSync } from 'node:fs';
import path from 'node:path';
import type { ShortcutDetails } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import {
  type DesktopBrandingIo, type DesktopBrandingOptions,
  isOwnedDesktopShortcutTarget, resolveDesktopBrandingPaths, updateWindowsDesktopBranding,
} from './desktop-branding';

// Only the public, repository-owned brand asset is read. All desktop / install IO
// below is synthetic; these tests never touch a user's shortcuts or app install.
const icon = readFileSync(path.resolve('native-resources/brand/lingxu.ico'));
const win = path.win32;
const root = 'C:\\Test\\Apps\\LingxuCopilotPublic';
const options: DesktopBrandingOptions = {
  isPackaged: true, platform: 'win32',
  executablePath: win.join(root, 'app-0.6.0', 'LingxuCopilotPublic.exe'),
  resourcesPath: win.join(root, 'app-0.6.0', 'resources'),
  desktopPath: 'C:\\Test\\Desktop',
};
const paths = resolveDesktopBrandingPaths(options) ?? (() => { throw new Error('Invalid synthetic paths'); })();
const canonical = (value: string) => win.normalize(value).toLowerCase();
const fail = (code: string) => Object.assign(new Error('synthetic failure'), { code });
interface SyntheticFile { kind: 'file' | 'directory' | 'link'; data: Buffer; realpath?: string }
type ExistingShortcut = ShortcutDetails & { hotkey: string };

function fixture() {
  const files = new Map<string, SyntheticFile>();
  const shortcutState = new Map<string, ExistingShortcut>();
  const putFile = (file: string, data: Buffer | string = '') => {
    files.set(canonical(file), { kind: 'file', data: Buffer.from(data) });
  };
  const putDirectory = (directory: string) => {
    files.set(canonical(directory), { kind: 'directory', data: Buffer.alloc(0) });
  };
  const get = (file: string) => {
    const entry = files.get(canonical(file));
    if (!entry) throw fail('ENOENT');
    return entry;
  };
  const addShortcut = (file = paths.shortcuts[0], details: Partial<ExistingShortcut> = {}) => {
    putFile(file, `original shortcut ${win.basename(file)}`);
    shortcutState.set(canonical(file), {
      target: win.join(root, 'LingxuCopilotPublic.exe'),
      cwd: 'C:\\Test\\Working directory', args: '--example "keep this exact argument"',
      description: 'User description', appUserModelId: 'original.user.app.id',
      toastActivatorClsid: '{00000000-0000-0000-0000-000000000001}', hotkey: 'Ctrl+Alt+L',
      icon: win.join(root, 'LingxuCopilotPublic.exe'), iconIndex: 0,
      ...details,
    });
  };
  putDirectory(root);
  putFile(win.join(root, 'Update.exe'));
  putFile(win.join(root, 'LingxuCopilotPublic.exe'));
  putFile(options.executablePath);
  putFile(paths.sourceIcon, icon);
  addShortcut();
  const io = {
    lstat: vi.fn(async (file: string) => {
      const entry = get(file);
      return {
        size: entry.data.byteLength,
        isFile: () => entry.kind === 'file', isDirectory: () => entry.kind === 'directory',
        isSymbolicLink: () => entry.kind === 'link',
      };
    }),
    realpath: vi.fn(async (file: string) => get(file).realpath ?? win.normalize(file)),
    readFile: vi.fn(async (file: string) => Buffer.from(get(file).data)),
    mkdir: vi.fn(async (directory: string) => { putDirectory(directory); }),
    copyFile: vi.fn(async (source: string, destination: string, flags?: number) => {
      if (flags === constants.COPYFILE_EXCL && files.has(canonical(destination))) throw fail('EEXIST');
      putFile(destination, get(source).data);
    }),
  } satisfies DesktopBrandingIo;
  const shortcuts = {
    readShortcutLink: vi.fn((file: string): ShortcutDetails => {
      const value = shortcutState.get(canonical(file));
      if (!value) throw fail('ENOENT');
      return { ...value };
    }),
    writeShortcutLink: vi.fn((file: string, operation: 'update', details: ShortcutDetails): boolean => {
      if (operation !== 'update') throw new Error('Only update is allowed');
      const previous = shortcutState.get(canonical(file));
      if (!previous) return false;
      shortcutState.set(canonical(file), { ...previous, ...details });
      putFile(file, 'updated shortcut');
      return true;
    }),
  };
  return { files, shortcutState, putFile, putDirectory, get, addShortcut, io, shortcuts };
}

describe('desktop branding path ownership', () => {
  it('uses an install-root icon and backup, independent of the Squirrel version', () => {
    expect(paths.installRoot).toBe(root);
    expect(paths.stableIcon).toBe(win.join(root, 'brand', 'lingxu.ico'));
    expect(paths.backupDirectory).toBe(win.join(root, 'brand', 'shortcut-backups'));
    const later = resolveDesktopBrandingPaths({
      ...options, executablePath: win.join(root, 'app-0.7.1', 'LingxuCopilotPublic.exe'),
      resourcesPath: win.join(root, 'app-0.7.1', 'resources'),
    });
    expect(later?.stableIcon).toBe(paths.stableIcon);
    expect(later?.shortcuts).toEqual(paths.shortcuts);
  });

  it.each([
    { isPackaged: false }, { platform: 'darwin' },
    { executablePath: win.join(root, 'LingxuCopilotPublic.exe') },
    { executablePath: win.join(root, 'app-0.6.0', 'OtherApp.exe') },
    { executablePath: 'C:\\OtherApp\\app-0.6.0\\LingxuCopilotPublic.exe' },
    { executablePath: '\\\\server\\share\\app-0.6.0\\LingxuCopilotPublic.exe' },
    { desktopPath: '\\\\server\\desktop' }, { desktopPath: 'C:Desktop' },
    { desktopPath: '\\\\?\\C:\\Test\\Desktop' },
    { resourcesPath: 'C:\\OtherApp\\resources' },
  ])('skips unsupported, development or nonlocal paths: %j', (change) => {
    expect(resolveDesktopBrandingPaths({ ...options, ...change })).toBeUndefined();
  });

  it.each([
    win.join(root, 'LingxuCopilotPublic.exe'),
    win.join(root, 'app-0.5.0', 'LingxuCopilotPublic.exe'),
    win.join(root, 'app-0.6.0-beta.1', 'LingxuCopilotPublic.exe'),
    win.join(root, 'LingxuCopilotPublic.exe').toLowerCase().replaceAll('\\', '/'),
  ])('accepts only a root launcher or its versioned executable: %s', (target) => {
    expect(isOwnedDesktopShortcutTarget(root, target)).toBe(true);
  });

  it.each([
    'C:\\OtherApp\\LingxuCopilotPublic.exe', win.join(`${root}-Other`, 'LingxuCopilotPublic.exe'),
    win.join(root, 'extras', 'LingxuCopilotPublic.exe'), win.join(root, 'Other.exe'),
    win.join(root, '..', 'OtherApp', 'LingxuCopilotPublic.exe'),
    `${win.join(root, 'LingxuCopilotPublic.exe')}:other`, 'LingxuCopilotPublic.exe',
    '\\\\server\\share\\LingxuCopilotPublic.exe',
    '\\\\?\\C:\\Test\\Apps\\LingxuCopilotPublic\\LingxuCopilotPublic.exe',
  ])('rejects unrelated, escaping or network shortcut targets: %s', (target) => {
    expect(isOwnedDesktopShortcutTarget(root, target)).toBe(false);
  });
});

describe('Windows desktop branding (synthetic IO only)', () => {
  it('uses the exact supplied ICO and preserves every other shortcut field', async () => {
    const f = fixture();
    const before = f.shortcutState.get(canonical(paths.shortcuts[0]));
    if (!before) throw new Error('Synthetic shortcut missing');
    const originalLink = Buffer.from(f.get(paths.shortcuts[0]).data);
    expect(icon.byteLength).toBe(14606);
    expect(createHash('sha256').update(icon).digest('hex')).toBe('a783766a6f8cd44c3132425268853bdc11bd00988c2d71fc29c0fedc3672f06b');

    expect(await updateWindowsDesktopBranding(options, f.shortcuts, f.io)).toEqual({ status: 'updated', updatedShortcuts: 1 });
    expect(f.get(paths.stableIcon).data).toEqual(icon);
    expect(f.shortcutState.get(canonical(paths.shortcuts[0]))).toEqual({ ...before, icon: paths.stableIcon, iconIndex: 0 });
    expect(f.shortcuts.writeShortcutLink).toHaveBeenCalledTimes(1);
    expect(f.shortcuts.writeShortcutLink).toHaveBeenCalledWith(paths.shortcuts[0], 'update', {
      target: before.target, icon: paths.stableIcon, iconIndex: 0,
    });
    expect(f.get(win.join(paths.backupDirectory, '领序·客户参谋.lnk.before-branding')).data).toEqual(originalLink);
    expect(f.io.copyFile).toHaveBeenCalledWith(paths.shortcuts[0], win.join(paths.backupDirectory, '领序·客户参谋.lnk.before-branding'), constants.COPYFILE_EXCL);
  });

  it('is a no-op when the stable icon and shortcut icon already match', async () => {
    const f = fixture();
    f.putDirectory(paths.brandDirectory); f.putFile(paths.stableIcon, icon);
    f.addShortcut(paths.shortcuts[0], { icon: paths.stableIcon, iconIndex: 0 });
    expect(await updateWindowsDesktopBranding(options, f.shortcuts, f.io)).toEqual({ status: 'unchanged', updatedShortcuts: 0 });
    expect(f.io.copyFile).not.toHaveBeenCalled();
    expect(f.shortcuts.writeShortcutLink).not.toHaveBeenCalled();
    expect(f.io.mkdir).not.toHaveBeenCalled();
  });

  it('normalizes the icon index even when the icon path already matches', async () => {
    const f = fixture();
    f.putDirectory(paths.brandDirectory); f.putFile(paths.stableIcon, icon);
    f.addShortcut(paths.shortcuts[0], { icon: paths.stableIcon, iconIndex: 1 });
    expect(await updateWindowsDesktopBranding(options, f.shortcuts, f.io)).toEqual({ status: 'updated', updatedShortcuts: 1 });
    expect(f.shortcutState.get(canonical(paths.shortcuts[0]))?.iconIndex).toBe(0);
  });

  it('repairs a stale stable asset without rewriting an already correct shortcut', async () => {
    const f = fixture();
    f.putDirectory(paths.brandDirectory); f.putFile(paths.stableIcon, 'old icon');
    f.addShortcut(paths.shortcuts[0], { icon: paths.stableIcon, iconIndex: 0 });
    expect(await updateWindowsDesktopBranding(options, f.shortcuts, f.io)).toEqual({ status: 'updated', updatedShortcuts: 0 });
    expect(f.get(paths.stableIcon).data).toEqual(icon);
    expect(f.shortcuts.writeShortcutLink).not.toHaveBeenCalled();
  });

  it('keeps the first recoverable shortcut backup on a later retry', async () => {
    const f = fixture();
    const backup = win.join(paths.backupDirectory, '领序·客户参谋.lnk.before-branding');
    f.putDirectory(paths.brandDirectory); f.putDirectory(paths.backupDirectory);
    f.putFile(backup, 'first original shortcut');
    expect(await updateWindowsDesktopBranding(options, f.shortcuts, f.io)).toEqual({ status: 'updated', updatedShortcuts: 1 });
    expect(f.get(backup).data.toString()).toBe('first original shortcut');
  });

  it('handles the two approved existing shortcut names but never creates or enumerates other links', async () => {
    const f = fixture();
    f.addShortcut(paths.shortcuts[1], { target: options.executablePath });
    const unrelatedLink = win.join(options.desktopPath, 'Other application.lnk');
    f.addShortcut(unrelatedLink, { target: 'C:\\OtherApp\\Other.exe' });
    expect(await updateWindowsDesktopBranding(options, f.shortcuts, f.io)).toEqual({ status: 'updated', updatedShortcuts: 2 });
    expect(f.shortcuts.writeShortcutLink.mock.calls.map(([file]) => file)).toEqual(paths.shortcuts);
    expect(f.get(unrelatedLink).data.toString()).toBe('original shortcut Other application.lnk');
    expect(f.io.copyFile.mock.calls.filter(([, destination]) => destination.endsWith('.lnk'))).toHaveLength(0);
  });

  it('does no writes or shortcut creation when approved shortcuts do not exist', async () => {
    const f = fixture();
    f.files.delete(canonical(paths.shortcuts[0]));
    expect(await updateWindowsDesktopBranding(options, f.shortcuts, f.io)).toEqual({ status: 'skipped', updatedShortcuts: 0 });
    expect(f.io.copyFile).not.toHaveBeenCalled(); expect(f.io.mkdir).not.toHaveBeenCalled();
    expect(f.shortcuts.writeShortcutLink).not.toHaveBeenCalled();
  });

  it('does no writes when the named shortcut belongs to another application', async () => {
    const f = fixture();
    f.addShortcut(paths.shortcuts[0], { target: 'C:\\OtherApp\\LingxuCopilotPublic.exe' });
    expect(await updateWindowsDesktopBranding(options, f.shortcuts, f.io)).toEqual({ status: 'skipped', updatedShortcuts: 0 });
    expect(f.io.copyFile).not.toHaveBeenCalled(); expect(f.io.mkdir).not.toHaveBeenCalled();
    expect(f.shortcuts.writeShortcutLink).not.toHaveBeenCalled();
  });

  it('does no IO at all in development', async () => {
    const f = fixture();
    expect(await updateWindowsDesktopBranding({ ...options, isPackaged: false }, f.shortcuts, f.io)).toEqual({ status: 'skipped', updatedShortcuts: 0 });
    expect(f.io.lstat).not.toHaveBeenCalled(); expect(f.shortcuts.readShortcutLink).not.toHaveBeenCalled();
  });

  it('requires the real Squirrel installation marker and an existing launcher', async () => {
    const f = fixture();
    f.files.delete(canonical(win.join(root, 'Update.exe')));
    expect(await updateWindowsDesktopBranding(options, f.shortcuts, f.io)).toEqual({ status: 'skipped', updatedShortcuts: 0 });
    expect(f.io.copyFile).not.toHaveBeenCalled();
    f.putFile(win.join(root, 'Update.exe')); f.files.delete(canonical(win.join(root, 'LingxuCopilotPublic.exe')));
    expect(await updateWindowsDesktopBranding(options, f.shortcuts, f.io)).toEqual({ status: 'skipped', updatedShortcuts: 0 });
    expect(f.io.copyFile).not.toHaveBeenCalled();
  });

  it.each(['sourceIcon', 'stableIcon', 'installRoot', 'brandDirectory'] as const)('refuses redirected or symbolic %s paths', async (key) => {
    const f = fixture();
    f.putDirectory(paths.brandDirectory); f.putFile(paths.stableIcon, 'old icon');
    const entry = f.get(paths[key]);
    entry.realpath = 'C:\\Unrelated\\redirected';
    expect(await updateWindowsDesktopBranding(options, f.shortcuts, f.io)).toEqual({ status: 'failed', updatedShortcuts: 0 });
    expect(f.io.copyFile).not.toHaveBeenCalled(); expect(f.shortcuts.writeShortcutLink).not.toHaveBeenCalled();
    delete entry.realpath; entry.kind = 'link';
    expect(await updateWindowsDesktopBranding(options, f.shortcuts, f.io)).toEqual({ status: 'failed', updatedShortcuts: 0 });
  });

  it('does not follow a redirected launcher target', async () => {
    const f = fixture();
    f.get(win.join(root, 'LingxuCopilotPublic.exe')).realpath = 'C:\\OtherApp\\LingxuCopilotPublic.exe';
    expect(await updateWindowsDesktopBranding(options, f.shortcuts, f.io)).toEqual({ status: 'failed', updatedShortcuts: 0 });
    expect(f.io.copyFile).not.toHaveBeenCalled();
  });

  it.each(['Update.exe', 'LingxuCopilotPublic.exe'])('refuses a mixed physical/version tree and virtualized %s stub', async (filename) => {
    const f = fixture();
    f.get(win.join(root, filename)).realpath = win.join('C:\\Test\\Packages\\DesktopHost\\LocalCache\\Local\\LingxuCopilotPublic', filename);
    // The containing directory and actual versioned executable still resolve
    // normally; a per-file projection must not be treated as an install alias.
    expect(await f.io.realpath(root)).toBe(root);
    expect(await f.io.realpath(options.executablePath)).toBe(options.executablePath);
    expect(await updateWindowsDesktopBranding(options, f.shortcuts, f.io)).toEqual({ status: 'failed', updatedShortcuts: 0 });
    expect(f.io.mkdir).not.toHaveBeenCalled(); expect(f.io.copyFile).not.toHaveBeenCalled();
    expect(f.shortcuts.writeShortcutLink).not.toHaveBeenCalled();
  });

  it('rejects a redirected shortcut before making any writes', async () => {
    const f = fixture();
    f.get(paths.shortcuts[0]).kind = 'link';
    expect(await updateWindowsDesktopBranding(options, f.shortcuts, f.io)).toEqual({ status: 'failed', updatedShortcuts: 0 });
    expect(f.io.copyFile).not.toHaveBeenCalled(); expect(f.shortcuts.writeShortcutLink).not.toHaveBeenCalled();
  });

  it('rejects a redirected existing backup without editing the shortcut', async () => {
    const f = fixture();
    const backup = win.join(paths.backupDirectory, '领序·客户参谋.lnk.before-branding');
    f.putDirectory(paths.brandDirectory); f.putFile(paths.stableIcon, icon);
    f.putDirectory(paths.backupDirectory); f.putFile(backup, 'existing backup');
    f.get(backup).realpath = 'C:\\OtherApp\\unrelated-backup';
    expect(await updateWindowsDesktopBranding(options, f.shortcuts, f.io)).toEqual({ status: 'failed', updatedShortcuts: 0 });
    expect(f.shortcuts.writeShortcutLink).not.toHaveBeenCalled();
  });

  it('does not overwrite a shortcut whose target changed while IO was pending', async () => {
    const f = fixture();
    const first = f.shortcuts.readShortcutLink(paths.shortcuts[0]);
    f.shortcuts.readShortcutLink.mockReturnValueOnce(first).mockReturnValueOnce({ ...first, target: 'C:\\OtherApp\\Other.exe' });
    await updateWindowsDesktopBranding(options, f.shortcuts, f.io);
    expect(f.shortcuts.writeShortcutLink).not.toHaveBeenCalled();
  });

  it('preserves argument and hotkey edits made while the asset copy is pending', async () => {
    const f = fixture();
    f.io.copyFile.mockImplementationOnce(async (source, destination) => {
      f.putFile(destination, f.get(source).data);
      const latest = f.shortcutState.get(canonical(paths.shortcuts[0]));
      if (!latest) throw new Error('Synthetic shortcut missing');
      latest.args = '--new-user-argument'; latest.hotkey = 'Ctrl+Alt+M';
    });
    expect(await updateWindowsDesktopBranding(options, f.shortcuts, f.io)).toEqual({ status: 'updated', updatedShortcuts: 1 });
    expect(f.shortcutState.get(canonical(paths.shortcuts[0]))).toMatchObject({
      args: '--new-user-argument', hotkey: 'Ctrl+Alt+M', icon: paths.stableIcon,
    });
  });

  it.each(['missing', 'bad-size', 'bad-hash'] as const)('does not write if the original icon is %s', async (kind) => {
    const f = fixture();
    if (kind === 'missing') f.files.delete(canonical(paths.sourceIcon));
    else f.putFile(paths.sourceIcon, kind === 'bad-size' ? Buffer.alloc(12) : Buffer.alloc(14606));
    expect(await updateWindowsDesktopBranding(options, f.shortcuts, f.io)).toEqual({ status: 'failed', updatedShortcuts: 0 });
    expect(f.io.copyFile).not.toHaveBeenCalled(); expect(f.shortcuts.writeShortcutLink).not.toHaveBeenCalled();
  });

  it('does not read an unexpectedly large destination file', async () => {
    const f = fixture();
    f.putDirectory(paths.brandDirectory); f.putFile(paths.stableIcon, Buffer.alloc(1024 * 1024 + 1));
    expect(await updateWindowsDesktopBranding(options, f.shortcuts, f.io)).toEqual({ status: 'failed', updatedShortcuts: 0 });
    expect(f.io.readFile).not.toHaveBeenCalledWith(paths.stableIcon);
    expect(f.io.copyFile).not.toHaveBeenCalled();
  });

  it('safely skips unreadable shortcuts', async () => {
    const f = fixture();
    f.shortcuts.readShortcutLink.mockImplementation(() => { throw new Error('synthetic unreadable link'); });
    expect(await updateWindowsDesktopBranding(options, f.shortcuts, f.io)).toEqual({ status: 'skipped', updatedShortcuts: 0 });
    expect(f.io.copyFile).not.toHaveBeenCalled();
  });

  it.each(['return-false', 'throw'] as const)('does not crash or lose the backup when the shell operation fails: %s', async (mode) => {
    const f = fixture();
    if (mode === 'return-false') f.shortcuts.writeShortcutLink.mockReturnValue(false);
    else f.shortcuts.writeShortcutLink.mockImplementation(() => { throw new Error('synthetic shell failure'); });
    expect(await updateWindowsDesktopBranding(options, f.shortcuts, f.io)).toEqual({ status: 'failed', updatedShortcuts: 0 });
    expect(f.get(win.join(paths.backupDirectory, '领序·客户参谋.lnk.before-branding')).data.toString()).toContain('original shortcut');
  });

  it('requires the original shortcut backup to succeed before editing a link', async () => {
    const f = fixture();
    f.putDirectory(paths.brandDirectory); f.putFile(paths.stableIcon, icon);
    f.io.copyFile.mockRejectedValueOnce(fail('EACCES'));
    expect(await updateWindowsDesktopBranding(options, f.shortcuts, f.io)).toEqual({ status: 'failed', updatedShortcuts: 0 });
    expect(f.shortcuts.writeShortcutLink).not.toHaveBeenCalled();
  });

  it('does not edit links if copying the source icon fails', async () => {
    const f = fixture();
    f.io.copyFile.mockRejectedValueOnce(fail('EACCES'));
    expect(await updateWindowsDesktopBranding(options, f.shortcuts, f.io)).toEqual({ status: 'failed', updatedShortcuts: 0 });
    expect(f.shortcuts.writeShortcutLink).not.toHaveBeenCalled();
  });

  it('reports a partial failure accurately and keeps the original backups', async () => {
    const f = fixture();
    f.addShortcut(paths.shortcuts[1]);
    f.shortcuts.writeShortcutLink.mockReturnValueOnce(false);
    expect(await updateWindowsDesktopBranding(options, f.shortcuts, f.io)).toEqual({ status: 'failed', updatedShortcuts: 1 });
    expect(f.get(paths.shortcuts[0]).data.toString()).toContain('original shortcut');
    expect(f.get(paths.shortcuts[1]).data.toString()).toBe('updated shortcut');
    for (const file of paths.shortcuts) {
      expect(f.get(win.join(paths.backupDirectory, `${win.basename(file)}.before-branding`)).data.toString()).toContain('original shortcut');
    }
  });

  it('contains filesystem errors and does not log the private failing paths', async () => {
    const f = fixture();
    f.io.lstat.mockRejectedValueOnce(fail('EACCES'));
    expect(await updateWindowsDesktopBranding(options, f.shortcuts, f.io)).toEqual({ status: 'failed', updatedShortcuts: 0 });
    expect(f.shortcuts.writeShortcutLink).not.toHaveBeenCalled();
    expect(f.io.copyFile).not.toHaveBeenCalled();
  });
});
