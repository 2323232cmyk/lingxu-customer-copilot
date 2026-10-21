import manifestData from './manifest-data.json';

export interface WechatNativeResourceEntry {
  readonly relativePath: string;
  readonly size: number;
  readonly sha256: string;
  readonly purpose: 'sqlite-reader' | 'license';
}

export interface WechatNativeResourceManifest {
  readonly sourceProduct: 'SQLite3 Multiple Ciphers';
  readonly sourceVersion: string;
  readonly platform: 'win32';
  readonly architecture: 'x64';
  readonly resources: readonly WechatNativeResourceEntry[];
}

/**
 * Fingerprints of the official SQLite3 Multiple Ciphers 2.5.1 Windows x64
 * release (SQLite 3.53.4, no ICU), its MIT license, and the MIT notice for
 * the wcdb-key-tool Config.Cipher reference implementation.
 *
 * The source-controlled manifest contains no binaries and executes no native code.
 * Local builds stage matching resources outside Git.
 */
export const OPEN_WECHAT_READER_MANIFEST =
  manifestData as WechatNativeResourceManifest;
