import { describe, expect, it } from 'vitest';
import { OPEN_WECHAT_READER_MANIFEST } from './manifest';

describe('OPEN_WECHAT_READER_MANIFEST', () => {
  it('locks only the open-source reader and required licenses, excluding TraceMemo binaries', () => {
    expect(OPEN_WECHAT_READER_MANIFEST).toMatchObject({
      sourceProduct: 'SQLite3 Multiple Ciphers',
      sourceVersion: '2.5.1',
      platform: 'win32',
      architecture: 'x64',
    });
    expect(OPEN_WECHAT_READER_MANIFEST.resources.map(
      (resource) => resource.relativePath,
    )).toEqual([
      'sqlite3mc.dll',
      'LICENSE',
      'wcdb-key-tool-LICENSE',
      'wechatauto-replica-LICENSE',
    ]);
    expect(OPEN_WECHAT_READER_MANIFEST.resources[0]).toEqual({
      relativePath: 'sqlite3mc.dll',
      size: 2442576,
      sha256: '5030decc6d914539e3b9b7e28aa4f6de1e7161dac6fd4b21eb02e6754d9b175e',
      purpose: 'sqlite-reader',
    });
    expect(OPEN_WECHAT_READER_MANIFEST.resources[1]).toEqual({
      relativePath: 'LICENSE',
      size: 1095,
      sha256: '54b6f21239a5eddb9f12bb47b91b9d36ea5a16e86b1c324a13bf943b875a7449',
      purpose: 'license',
    });
    expect(OPEN_WECHAT_READER_MANIFEST.resources[2]).toEqual({
      relativePath: 'wcdb-key-tool-LICENSE',
      size: 1080,
      sha256: 'c9e2f8dbaf8361e6bdb1b1952d38908f1265b775f0292a9d3c81d066d131c695',
      purpose: 'license',
    });
    expect(OPEN_WECHAT_READER_MANIFEST.resources[3]).toEqual({
      relativePath: 'wechatauto-replica-LICENSE',
      size: 11357,
      sha256: 'c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4',
      purpose: 'license',
    });
  });
});
