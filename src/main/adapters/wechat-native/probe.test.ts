import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type { WechatNativeResourceManifest } from './manifest';
import { probeWechatNativeResources } from './probe';

const createdDirectories: string[] = [];

function digest(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function fixtureManifest(
  contents: readonly (readonly [string, string])[],
): WechatNativeResourceManifest {
  return {
    sourceProduct: 'SQLite3 Multiple Ciphers',
    sourceVersion: '2.5.1',
    platform: 'win32',
    architecture: 'x64',
    resources: contents.map(([relativePath, content], index) => ({
      relativePath,
      size: Buffer.byteLength(content),
      sha256: digest(content),
      purpose: index === 0 ? 'sqlite-reader' : 'license',
    })),
  };
}

async function temporaryResourceRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'wechat-native-probe-'));
  createdDirectories.push(root);
  return root;
}

async function addResource(root: string, relativePath: string, content: string): Promise<void> {
  const filePath = join(root, relativePath);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
}

afterEach(async () => {
  await Promise.all(createdDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

describe('probeWechatNativeResources', () => {
  const resources = [
    ['sqlite3mc.dll', 'dll-resource'],
    ['LICENSE', 'license-text'],
    ['wcdb-key-tool-LICENSE', 'wcdb-license'],
  ] as const;
  const manifest = fixtureManifest(resources);

  it('reports an exact resource set as available and version-matched', async () => {
    const root = await temporaryResourceRoot();
    await Promise.all(resources.map(([path, content]) => addResource(root, path, content)));

    const result = await probeWechatNativeResources(root, manifest);

    expect(result.available).toBe(true);
    expect(result.versionStatus).toBe('match');
    expect(result.missingFiles).toEqual([]);
    expect(result.mismatchedFiles).toEqual([]);
    expect(result.checkedFiles).toBe(3);
  });

  it('reports missing files without claiming a version match', async () => {
    const root = await temporaryResourceRoot();
    await addResource(root, resources[0][0], resources[0][1]);

    const result = await probeWechatNativeResources(root, manifest);

    expect(result.available).toBe(false);
    expect(result.versionStatus).toBe('unverified');
    expect(result.missingFiles).toEqual([resources[1][0], resources[2][0]]);
    expect(result.checkedFiles).toBe(1);
  });

  it('reports a same-size hash mismatch as a version mismatch', async () => {
    const root = await temporaryResourceRoot();
    await addResource(root, resources[0][0], 'xxxxresource');
    await Promise.all(resources.slice(1).map(([path, content]) => addResource(root, path, content)));

    const result = await probeWechatNativeResources(root, manifest);

    expect(result.available).toBe(false);
    expect(result.versionStatus).toBe('mismatch');
    expect(result.mismatchedFiles).toHaveLength(1);
    expect(result.mismatchedFiles[0]).toMatchObject({
      relativePath: resources[0][0],
      reason: 'sha256',
    });
  });

  it('reports a size mismatch before hashing the file', async () => {
    const root = await temporaryResourceRoot();
    await addResource(root, resources[0][0], 'short');
    await Promise.all(resources.slice(1).map(([path, content]) => addResource(root, path, content)));

    const result = await probeWechatNativeResources(root, manifest);

    expect(result.available).toBe(false);
    expect(result.versionStatus).toBe('mismatch');
    expect(result.mismatchedFiles[0]).toMatchObject({
      relativePath: resources[0][0],
      reason: 'size',
      actual: 5,
    });
  });

  it('requires the wcdb-key-tool license even when the reader and SQLite license match', async () => {
    const root = await temporaryResourceRoot();
    await Promise.all(resources.slice(0, 2).map(([path, content]) => addResource(root, path, content)));

    const result = await probeWechatNativeResources(root, manifest);

    expect(result.available).toBe(false);
    expect(result.versionStatus).toBe('unverified');
    expect(result.missingFiles).toEqual(['wcdb-key-tool-LICENSE']);
    expect(result.checkedFiles).toBe(2);
  });

  it('rejects a changed wcdb-key-tool license with an unchanged size', async () => {
    const root = await temporaryResourceRoot();
    await Promise.all(resources.map(([path, content]) => addResource(root, path, content)));
    await addResource(root, resources[2][0], 'x'.repeat(resources[2][1].length));

    const result = await probeWechatNativeResources(root, manifest);

    expect(result.available).toBe(false);
    expect(result.versionStatus).toBe('mismatch');
    expect(result.missingFiles).toEqual([]);
    expect(result.mismatchedFiles).toEqual([expect.objectContaining({
      relativePath: 'wcdb-key-tool-LICENSE', reason: 'sha256',
    })]);
  });
});
