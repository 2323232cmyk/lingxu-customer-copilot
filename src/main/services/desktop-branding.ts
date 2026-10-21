import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import type { ShortcutDetails } from 'electron';

const APP_DIRECTORY = 'LingxuCopilotPublic';
const APP_EXECUTABLE = `${APP_DIRECTORY}.exe`;
const ICON_SHA256 = 'a783766a6f8cd44c3132425268853bdc11bd00988c2d71fc29c0fedc3672f06b';
const SHORTCUT_NAMES = ['领序·客户参谋.lnk', 'LingxuCopilotPublic.lnk'];
const VERSION_DIRECTORY = /^app-\d+(?:\.\d+){1,3}(?:-[a-z0-9.-]+)?$/iu;
const win = path.win32;

interface FileInfo { size: number; isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }
export interface DesktopBrandingIo {
  lstat(file: string): Promise<FileInfo>;
  realpath(file: string): Promise<string>;
  readFile(file: string): Promise<Buffer>;
  mkdir(directory: string, options: { recursive: true }): Promise<unknown>;
  copyFile(source: string, destination: string, flags?: number): Promise<void>;
}
export interface DesktopBrandingOptions {
  isPackaged: boolean;
  platform: string;
  executablePath: string;
  resourcesPath: string;
  desktopPath: string;
}
interface ShortcutApi {
  readShortcutLink(file: string): ShortcutDetails;
  writeShortcutLink(file: string, operation: 'update', details: ShortcutDetails): boolean;
}
export interface DesktopBrandingResult { status: 'updated' | 'unchanged' | 'skipped' | 'failed'; updatedShortcuts: number }

const localPath = (value: string): string | undefined => /^[a-z]:[\\/]/iu.test(value)
  && !/[\0:*?"<>|]/u.test(value.slice(2)) ? win.normalize(value) : undefined;
const samePath = (left: string, right: string): boolean => {
  const a = localPath(left), b = localPath(right);
  return a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();
};
const missing = (error: unknown) => error !== null && typeof error === 'object'
  && 'code' in error && error.code === 'ENOENT';
const exists = (error: unknown) => error !== null && typeof error === 'object'
  && 'code' in error && error.code === 'EEXIST';

/** Only the running Squirrel install owns this stable directory, not unpacked builds. */
export function resolveDesktopBrandingPaths(options: DesktopBrandingOptions) {
  if (!options.isPackaged || options.platform !== 'win32') return undefined;
  const executable = localPath(options.executablePath), desktop = localPath(options.desktopPath);
  if (!executable || !desktop || win.basename(executable).toLowerCase() !== APP_EXECUTABLE.toLowerCase()) return undefined;
  const versionDirectory = win.dirname(executable), installRoot = win.dirname(versionDirectory);
  if (!VERSION_DIRECTORY.test(win.basename(versionDirectory))
    || win.basename(installRoot).toLowerCase() !== APP_DIRECTORY.toLowerCase()
    || !samePath(options.resourcesPath, win.join(versionDirectory, 'resources'))) return undefined;
  const brandDirectory = win.join(installRoot, 'brand');
  return {
    installRoot, brandDirectory,
    sourceIcon: win.join(options.resourcesPath, 'brand', 'lingxu.ico'),
    stableIcon: win.join(brandDirectory, 'lingxu.ico'),
    backupDirectory: win.join(brandDirectory, 'shortcut-backups'),
    shortcuts: SHORTCUT_NAMES.map((name) => win.join(desktop, name)),
  };
}

export function isOwnedDesktopShortcutTarget(installRoot: string, target: string): boolean {
  const value = localPath(target);
  if (!value || win.basename(value).toLowerCase() !== APP_EXECUTABLE.toLowerCase()) return false;
  const directory = win.dirname(value);
  return samePath(directory, installRoot)
    || VERSION_DIRECTORY.test(win.basename(directory)) && samePath(win.dirname(directory), installRoot);
}

/** Bounded to two existing links; never creates links, clears Explorer caches or logs paths. */
export async function updateWindowsDesktopBranding(
  options: DesktopBrandingOptions, shortcuts: ShortcutApi, io: DesktopBrandingIo = fs,
): Promise<DesktopBrandingResult> {
  let updatedShortcuts = 0;
  const paths = resolveDesktopBrandingPaths(options);
  if (!paths) return { status: 'skipped', updatedShortcuts };
  const checked = async (file: string, directory = false): Promise<FileInfo | undefined> => {
    try {
      const info = await io.lstat(file);
      if (info.isSymbolicLink() || !(directory ? info.isDirectory() : info.isFile())
        || !samePath(await io.realpath(file), file)) throw new Error('Unsafe branding path');
      return info;
    } catch (error) { if (missing(error)) return undefined; throw error; }
  };
  const ensureDirectory = async (directory: string) => {
    if (!await checked(directory, true)) await io.mkdir(directory, { recursive: true });
    if (!await checked(directory, true)) throw new Error('Branding directory unavailable');
  };
  try {
    if (!await checked(paths.installRoot, true)
      || !await checked(win.join(paths.installRoot, 'Update.exe'))) return { status: 'skipped', updatedShortcuts };
    const eligible: { file: string; details: ShortcutDetails }[] = [];
    for (const file of paths.shortcuts) {
      if (!await checked(file)) continue;
      let details: ShortcutDetails;
      try { details = shortcuts.readShortcutLink(file); } catch { continue; }
      if (isOwnedDesktopShortcutTarget(paths.installRoot, details.target) && await checked(details.target)) eligible.push({ file, details });
    }
    if (!eligible.length) return { status: 'skipped', updatedShortcuts };
    const source = await checked(paths.sourceIcon);
    if (source?.size !== 14606 || createHash('sha256').update(await io.readFile(paths.sourceIcon)).digest('hex') !== ICON_SHA256) {
      return { status: 'failed', updatedShortcuts };
    }
    await ensureDirectory(paths.brandDirectory);
    const currentIcon = await checked(paths.stableIcon);
    if (currentIcon && currentIcon.size > 1024 * 1024) return { status: 'failed', updatedShortcuts };
    const iconMatches = currentIcon !== undefined
      && createHash('sha256').update(await io.readFile(paths.stableIcon)).digest('hex') === ICON_SHA256;
    if (!iconMatches) await io.copyFile(paths.sourceIcon, paths.stableIcon);
    let failed = false;
    for (const { file, details } of eligible) {
      if (samePath(details.icon ?? '', paths.stableIcon) && details.iconIndex === 0) continue;
      try {
        await ensureDirectory(paths.backupDirectory);
        const backup = win.join(paths.backupDirectory, `${win.basename(file)}.before-branding`);
        try { await io.copyFile(file, backup, constants.COPYFILE_EXCL); }
        catch (error) { if (!exists(error) || !await checked(backup)) throw error; }
        if (!await checked(file)) continue;
        const latest = shortcuts.readShortcutLink(file);
        if (!samePath(latest.target, details.target) || !isOwnedDesktopShortcutTarget(paths.installRoot, latest.target)) continue;
        // Electron 'update' keeps unspecified fields, including hotkeys absent
        // from ShortcutDetails. Repeating target satisfies its TypeScript contract.
        if (shortcuts.writeShortcutLink(file, 'update', { target: latest.target, icon: paths.stableIcon, iconIndex: 0 })) updatedShortcuts += 1;
        else failed = true;
      } catch { failed = true; }
    }
    return { status: failed ? 'failed' : updatedShortcuts || !iconMatches ? 'updated' : 'unchanged', updatedShortcuts };
  } catch { return { status: 'failed', updatedShortcuts }; }
}
