import { createHmac, pbkdf2Sync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { CONFIG_CIPHER_NAME, CIPHER_CONFIG_XOR_MASK } from './wechat-key-material';
import * as keyMaterial from './wechat-key-material';
import {
  openReadonlyWechatProcess,
  scanWechatDatabaseKeys,
  WechatMemoryReadError,
  type ReadableWechatProcess,
} from './wechat-readonly-memory';

describe.skipIf(process.platform !== 'win32' || process.arch !== 'x64')('read-only Win32 buffer lifecycle', () => {
  const nativeFixture = (read: (output: Buffer, count: unknown[]) => number) => {
    let captured: Buffer | undefined;
    const closeHandle = vi.fn(() => 1);
    const readMemory = vi.fn((_handle: unknown, _address: unknown, output: Buffer, _size: unknown, count: unknown[]) => {
      captured = output;
      return read(output, count);
    });
    const functions: Record<string, (...args: never[]) => unknown> = {
      OpenProcess: vi.fn(() => 1n),
      CloseHandle: closeHandle,
      QueryFullProcessImageNameW: (_handle: unknown, _flags: unknown, output: Buffer, count: unknown[]) => {
        const name = 'C:\\synthetic\\Weixin.exe';
        output.write(name, 'utf16le');
        count[0] = name.length;
        return 1;
      },
      ProcessIdToSessionId: (_pid: unknown, session: unknown[]) => { session[0] = 1; return 1; },
      VirtualQueryEx: () => 0,
      ReadProcessMemory: readMemory,
    };
    const koffi = {
      load: () => ({ func: (definition: string) => {
        const name = /__stdcall\s+(\w+)\(/u.exec(definition)?.[1] ?? '';
        return functions[name];
      } }),
    } as unknown as typeof import('koffi');
    return { reader: openReadonlyWechatProcess(koffi, 123), closeHandle, readMemory, captured: () => captured };
  };

  it('erases partial output and returns a fixed safe error when the FFI call throws', () => {
    const fixture = nativeFixture((output) => {
      output.fill(0x71);
      throw new Error('PRIVATE_PATH PRIVATE_MEMORY');
    });
    try {
      expect(() => fixture.reader.read(0x10000, 32)).toThrow(WechatMemoryReadError);
      expect(fixture.captured()).toEqual(Buffer.alloc(32));
    } finally { fixture.reader.close(); }
    expect(fixture.closeHandle).toHaveBeenCalledOnce();
  });

  it('erases partial output on a native short read without returning it', () => {
    const fixture = nativeFixture((output, count) => { output.fill(0x72); count[0] = 20; return 0; });
    try {
      expect(fixture.reader.read(0x10000, 32)).toBeNull();
      expect(fixture.captured()).toEqual(Buffer.alloc(32));
    } finally { fixture.reader.close(); }
  });

  it('rejects invalid ranges without calling native memory reads and closes once', () => {
    const fixture = nativeFixture(() => 1);
    expect(fixture.reader.read(-1, 32)).toBeNull();
    expect(fixture.reader.read(0x10000, 0)).toBeNull();
    expect(fixture.reader.read(0x10000, 2 * 1024 * 1024 + 257)).toBeNull();
    expect(fixture.readMemory).not.toHaveBeenCalled();
    fixture.reader.close();
    fixture.reader.close();
    expect(fixture.reader.read(0x10000, 32)).toBeNull();
    expect(fixture.closeHandle).toHaveBeenCalledOnce();
  });
});

const key = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1));
const salt = Buffer.alloc(16, 0x31);
const page = (): Buffer => {
  const result = Buffer.alloc(4096, 0x71);
  salt.copy(result);
  const macSalt = Buffer.from(salt.map((byte) => byte ^ 0x3a));
  const macKey = pbkdf2Sync(key, macSalt, 2, 32, 'sha512');
  createHmac('sha512', macKey).update(result.subarray(16, 4032))
    .update(Buffer.from([1, 0, 0, 0])).digest().copy(result, 4032);
  return result;
};
const target = () => ({ id: 'session', pageOne: page() });
const literal = (candidate = key, embeddedSalt?: Buffer): Buffer =>
  Buffer.from(`x'${candidate.toString('hex')}${embeddedSalt?.toString('hex') ?? ''}'`, 'ascii');

const memory = (segments: { address: number; data: Buffer; scan?: boolean }[]) => {
  const copies: Buffer[] = [];
  const reader: ReadableWechatProcess = {
    regions: () => segments.filter((segment) => segment.scan !== false)
      .map((segment) => ({ address: segment.address, size: segment.data.length })),
    read: (address, length) => {
      const segment = segments.find((item) => address >= item.address
        && address + length <= item.address + item.data.length);
      if (!segment) return null;
      const copy = Buffer.from(segment.data.subarray(address - segment.address, address - segment.address + length));
      copies.push(copy);
      return copy;
    },
    close: vi.fn(),
  };
  return { reader, copies };
};

describe('bounded read-only WeChat key scan', () => {
  it('authenticates the selected database before returning material and clears scan buffers', async () => {
    const fixture = memory([{ address: 0x10000, data: literal(key, salt) }]);
    const result = await scanWechatDatabaseKeys(() => fixture.reader, [123], [target()]);
    expect(result.get('session')).toEqual(key);
    expect(fixture.reader.close).toHaveBeenCalledOnce();
    expect(fixture.copies.every((copy) => copy.every((byte) => byte === 0))).toBe(true);
    result.get('session')?.fill(0);
  });

  it('does not use attached salt from another database or suppress a later correct candidate', async () => {
    const fixture = memory([{ address: 0x10000,
      data: Buffer.concat([literal(key, Buffer.alloc(16, 0xee)), literal(key, salt)]) }]);
    const result = await scanWechatDatabaseKeys(() => fixture.reader, [123], [target()]);
    expect(result.get('session')).toEqual(key);
  });

  it('does not pretend a plausible but unauthenticated key proves an account mismatch', async () => {
    const fixture = memory([{ address: 0x10000, data: literal(Buffer.alloc(32, 0xee)) }]);
    await expect(scanWechatDatabaseKeys(() => fixture.reader, [123], [target()]))
      .rejects.toMatchObject({ code: 'key.notFound' });
    expect(fixture.reader.close).toHaveBeenCalledOnce();
  });

  it('erases every candidate in a batch when verification fails before later candidates are visited', async () => {
    const fixture = memory([{ address: 0x10000, data: literal(key, salt) }]);
    const candidates = [
      { key: Buffer.from(key), salt: Buffer.from(salt) },
      { key: Buffer.alloc(32, 0x73), salt: Buffer.from(salt) },
    ];
    const extract = vi.spyOn(keyMaterial, 'extractSqlCipherHexCandidates').mockReturnValueOnce(candidates);
    const verify = vi.spyOn(keyMaterial, 'verifySqlCipherPageKey').mockImplementationOnce(() => {
      throw new Error('PRIVATE_PATH PRIVATE_CREDENTIAL');
    });
    try {
      await expect(scanWechatDatabaseKeys(() => fixture.reader, [123], [target()]))
        .rejects.toMatchObject({ code: 'key.adapter', message: '微信只读连接尚未完成' });
      expect(verify).toHaveBeenCalledOnce();
      expect(fixture.reader.close).toHaveBeenCalledOnce();
      expect(fixture.copies.every((copy) => copy.every((byte) => byte === 0))).toBe(true);
      for (const candidate of candidates) {
        expect(candidate.key).toEqual(Buffer.alloc(32));
        expect(candidate.salt).toEqual(Buffer.alloc(16));
      }
    } finally {
      extract.mockRestore();
      verify.mockRestore();
      for (const candidate of candidates) {
        candidate.key.fill(0);
        candidate.salt.fill(0);
      }
    }
  });

  it('resolves and authenticates a runtime Config.Cipher object without invoking any write API', async () => {
    const nameData = Buffer.alloc(512);
    CONFIG_CIPHER_NAME.copy(nameData, 40);
    const nodes = Buffer.alloc(512);
    nodes.writeBigUInt64LE(0x10028n, 0x90);
    nodes.writeBigUInt64LE(BigInt(CONFIG_CIPHER_NAME.length), 0x98);
    nodes.writeBigUInt64LE(0x30000n, 0xa8);
    const descriptor = Buffer.alloc(0x28);
    descriptor.writeBigUInt64LE(0x40000n, 8);
    const blob = literal(key, salt);
    descriptor.writeBigUInt64LE(BigInt(blob.length), 0x10);
    for (let index = 0; index < blob.length; index += 1) {
      blob[index] ^= CIPHER_CONFIG_XOR_MASK[index % CIPHER_CONFIG_XOR_MASK.length];
    }
    const fixture = memory([
      { address: 0x10000, data: nameData }, { address: 0x20000, data: nodes },
      { address: 0x30088, data: descriptor, scan: false },
      { address: 0x40000, data: blob, scan: false },
    ]);
    const result = await scanWechatDatabaseKeys(() => fixture.reader, [123], [target()]);
    expect(result.get('session')).toEqual(key);
    expect(fixture.copies.every((copy) => copy.every((byte) => byte === 0))).toBe(true);
  });

  it('reports no process separately from read permission denial', async () => {
    await expect(scanWechatDatabaseKeys(() => { throw new Error('should not open'); }, [], [target()]))
      .rejects.toMatchObject({ code: 'wechat.notRunning' });
    await expect(scanWechatDatabaseKeys(() => { throw new WechatMemoryReadError('key.accessDenied'); }, [123], [target()]))
      .rejects.toMatchObject({ code: 'key.accessDenied' });
    await expect(scanWechatDatabaseKeys(() => { throw new WechatMemoryReadError('wechat.notRunning'); }, [123], [target()]))
      .rejects.toMatchObject({ code: 'wechat.notRunning' });
  });

  it('does not turn a binding exception into an access or account claim or expose its text', async () => {
    await expect(scanWechatDatabaseKeys(() => { throw new Error('private-account secret'); }, [123], [target()]))
      .rejects.toMatchObject({ code: 'key.adapter', message: '微信只读连接尚未完成' });
  });

  it('closes readers on unexpected scan failure without exposing original exceptions', async () => {
    const reader: ReadableWechatProcess = {
      regions: () => { throw new Error('private account'); }, read: () => null, close: vi.fn(),
    };
    await expect(scanWechatDatabaseKeys(() => reader, [123], [target()]))
      .rejects.toMatchObject({ code: 'key.adapter' });
    expect(reader.close).toHaveBeenCalledOnce();
  });

  it('does not open any process after cancellation', async () => {
    const open = vi.fn();
    await expect(scanWechatDatabaseKeys(open, [123], [target()], { cancelled: () => true }))
      .rejects.toMatchObject({ code: 'key.notFound' });
    expect(open).not.toHaveBeenCalled();
  });

  it('stops before another chunk or process after timeout and closes the active reader', async () => {
    const fixture = memory([
      { address: 0x10000, data: Buffer.alloc(100) },
      { address: 0x20000, data: Buffer.alloc(100) },
    ]);
    let now = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const read = fixture.reader.read;
    const readSpy = vi.fn((address: number, length: number) => { now = 2; return read(address, length); });
    fixture.reader.read = readSpy;
    const open = vi.fn(() => fixture.reader);
    try {
      await expect(scanWechatDatabaseKeys(open, [123, 456], [target()], { timeoutMs: 1 }))
        .rejects.toMatchObject({ code: 'key.scanTimeout' });
      expect(readSpy).toHaveBeenCalledOnce();
      expect(open).toHaveBeenCalledOnce();
      expect(fixture.reader.close).toHaveBeenCalledOnce();
      expect(fixture.copies.every((copy) => copy.every((byte) => byte === 0))).toBe(true);
    } finally { clock.mockRestore(); }
  });

  it('does not publish a result if cancellation arrives while reading its candidate chunk', async () => {
    const fixture = memory([{ address: 0x10000, data: literal(key, salt) }]);
    let cancelled = false;
    const read = fixture.reader.read;
    fixture.reader.read = (address, length) => { cancelled = true; return read(address, length); };
    await expect(scanWechatDatabaseKeys(() => fixture.reader, [123], [target()], { cancelled: () => cancelled }))
      .rejects.toMatchObject({ code: 'key.notFound' });
    expect(fixture.reader.close).toHaveBeenCalledOnce();
    expect(fixture.copies.every((copy) => copy.every((byte) => byte === 0))).toBe(true);
  });

  it('caps process attempts and never writes an unverified credential', async () => {
    const open = vi.fn(() => memory([{ address: 0x10000, data: Buffer.alloc(128) }]).reader);
    await expect(scanWechatDatabaseKeys(open, Array.from({ length: 50 }, (_, index) => index + 1), [target()]))
      .rejects.toMatchObject({ code: 'key.notFound' });
    expect(open).toHaveBeenCalledTimes(8);
  });
});
