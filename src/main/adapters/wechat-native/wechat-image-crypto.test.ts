import { createCipheriv, createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  clearWechatV2Probe,
  createWechatV2Probe,
  decodeWechatV2Image,
  scanWechatImageKey,
  WechatImageCryptoProvider,
  type WechatV2Probe,
} from './wechat-image-crypto';
import type { ReadableWechatProcess } from './wechat-readonly-memory';

// Entirely synthetic data. Nothing in this suite opens WeChat, a DLL, or an account directory.
const KEY = Buffer.from('0123456789abcdef', 'ascii');
const OTHER_KEY = Buffer.from('fedcba9876543210', 'ascii');
const SIGNATURE = Buffer.from([7, 8, 86, 50, 8, 7]);
const HEADERS = {
  'image/jpeg': Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  'image/png': Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  'image/gif': Buffer.from('GIF89a', 'ascii'),
  'image/webp': Buffer.from('RIFF\x40\x00\x00\x00WEBP', 'ascii'),
  wxgf: Buffer.from('wxgf', 'ascii'),
};

function fixture(options: {
  key?: Buffer; format?: keyof typeof HEADERS; plainLength?: number; middleLength?: number;
  tailLength?: number; xor?: number;
} = {}) {
  const head = Buffer.alloc(options.plainLength ?? 32, 0x5a);
  HEADERS[options.format ?? 'image/jpeg'].copy(head);
  const middle = Buffer.alloc(options.middleLength ?? 19, 0x28);
  const tail = Buffer.alloc(options.tailLength ?? 8, 0x2a);
  if (tail.length >= 2) { tail[tail.length - 2] = 0xff; tail[tail.length - 1] = 0xd9; }
  const encodedTail = Buffer.from(tail.map((byte) => byte ^ (options.xor ?? 0x47)));
  const cipher = createCipheriv('aes-128-ecb', options.key ?? KEY, null);
  const encryptedHead = Buffer.concat([cipher.update(head), cipher.final()]);
  const header = Buffer.alloc(15);
  SIGNATURE.copy(header);
  header.writeUInt32LE(head.length, 6);
  header.writeUInt32LE(tail.length, 10);
  return { file: Buffer.concat([header, encryptedHead, middle, encodedTail]),
    plaintext: Buffer.concat([head, middle, tail]), head, encryptedHead, xor: options.xor ?? 0x47 };
}

function probe(file: Buffer): WechatV2Probe {
  const result = createWechatV2Probe(file);
  if (!result) throw new Error('Synthetic fixture must have a valid V2 layout');
  return result;
}

const pause = async (): Promise<void> => undefined;
const zeroed = (bytes: Buffer): boolean => bytes.every((byte) => byte === 0);

function configMemory(account = 'wxid_synthetic', back = 0x138) {
  const data = Buffer.alloc(8192);
  const address = 0x10000;
  const landmark = 0x300;
  const owner = 0x800;
  const config = 0x1000;
  const dword = 1234567890;
  data.write('global_config', landmark, 'ascii');
  data.writeBigUInt64LE(13n, landmark + 16);
  data.writeBigUInt64LE(15n, landmark + 24);
  data.writeBigUInt64LE(BigInt(address + owner), landmark + 16 - back);
  data.writeBigUInt64LE(BigInt(address + config), owner + 0x68);
  data.writeUInt32LE(dword, config + 0x40);
  const accountBytes = Buffer.from(account);
  data.writeBigUInt64LE(BigInt(accountBytes.length), config + 0x48 + 16);
  data.writeBigUInt64LE(BigInt(accountBytes.length <= 15 ? 15 : 127), config + 0x48 + 24);
  if (accountBytes.length <= 15) accountBytes.copy(data, config + 0x48);
  else { data.writeBigUInt64LE(BigInt(address + 0x1800), config + 0x48); accountBytes.copy(data, 0x1800); }
  return { ...memory(data, address), data, account, dword, landmark, config };
}

function memory(data: Buffer, address = 0x10000) {
  const copies: Buffer[] = [];
  const reader: ReadableWechatProcess = {
    regions: () => [{ address, size: data.length }],
    read: vi.fn((requestedAddress: number, length: number) => {
      const offset = requestedAddress - address;
      if (offset < 0 || offset + length > data.length) return null;
      const result = Buffer.from(data.subarray(offset, offset + length));
      copies.push(result);
      return result;
    }),
    close: vi.fn(),
  };
  return { reader, copies };
}

function providerFixture(data = Buffer.concat([Buffer.from('!'), KEY, Buffer.from('!')]), extra: {
  now?: () => number; yieldControl?: () => Promise<void>; onReady?: () => void;
  discoverProcessIds?: () => Promise<readonly number[]>;
} = {}) {
  const readers: ReturnType<typeof memory>[] = [];
  const open = vi.fn(() => {
    const result = memory(data);
    readers.push(result);
    return result.reader;
  });
  const discover = vi.fn(extra.discoverProcessIds ?? (async () => [123]));
  return { provider: new WechatImageCryptoProvider({ open, discoverProcessIds: discover, yieldControl: pause, ...extra }),
    open, discover, readers };
}

describe('strict V2 layout and segmented decryption', () => {
  it.each(['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const)(
    'roundtrips %s bytes without modifying the source or credential', (format) => {
      const sample = fixture({ format });
      const before = Buffer.from(sample.file);
      const credential = Buffer.from(KEY);
      const result = decodeWechatV2Image(sample.file, credential, sample.xor);
      expect(result.status).toBe('ready');
      if (result.status === 'ready') {
        expect(result.mimeType).toBe(format);
        expect(result.bytes).toEqual(sample.plaintext);
        expect(result.bytes.buffer).not.toBe(sample.file.buffer);
        result.bytes.fill(0);
      }
      expect(sample.file).toEqual(before);
      expect(credential).toEqual(KEY);
    },
  );

  it.each([16, 17, 31, 32, 65536])('requires a full PKCS7 block for aligned AES length %i', (plainLength) => {
    const sample = fixture({ plainLength, tailLength: 0, middleLength: 0 });
    const selected = probe(sample.file);
    try {
      expect(selected.cipher.length).toBe(plainLength + 16 - plainLength % 16);
      const result = decodeWechatV2Image(sample.file, KEY);
      expect(result.status).toBe('ready');
      if (result.status === 'ready') { expect(result.bytes).toEqual(sample.plaintext); result.bytes.fill(0); }
    } finally { clearWechatV2Probe(selected); }
  });

  it('does not relabel a validated wxgf container as JPEG or return its plaintext', () => {
    const sample = fixture({ format: 'wxgf' });
    expect(decodeWechatV2Image(sample.file, KEY, sample.xor)).toEqual({ status: 'unsupported' });
  });

  it('does not guess an XOR default, and accepts zero as a real XOR byte', () => {
    const sample = fixture({ xor: 0 });
    for (const xor of [undefined, -1, 256, NaN, 0.5]) {
      expect(decodeWechatV2Image(sample.file, KEY, xor)).toEqual({ status: 'encrypted' });
    }
    const result = decodeWechatV2Image(sample.file, KEY, 0);
    expect(result.status).toBe('ready');
    if (result.status === 'ready') { expect(result.bytes).toEqual(sample.plaintext); result.bytes.fill(0); }
  });

  it('rejects a wrong key, a wrong length, and a plausible first block with invalid padding', () => {
    const sample = fixture();
    expect(decodeWechatV2Image(sample.file, OTHER_KEY, sample.xor)).toEqual({ status: 'encrypted' });
    expect(decodeWechatV2Image(sample.file, Buffer.alloc(32), sample.xor)).toEqual({ status: 'encrypted' });
    const invalidPadding = Buffer.concat([sample.head, Buffer.alloc(16)]);
    const cipher = createCipheriv('aes-128-ecb', KEY, null).setAutoPadding(false);
    const bad = Buffer.from(sample.file);
    Buffer.concat([cipher.update(invalidPadding), cipher.final()]).copy(bad, 15);
    expect(decodeWechatV2Image(bad, KEY, sample.xor)).toEqual({ status: 'encrypted' });
    const wrongLength = Buffer.from(sample.file);
    wrongLength.writeUInt32LE(33, 6); // Same ciphertext size, but decrypted length must equal the header.
    expect(decodeWechatV2Image(wrongLength, KEY, sample.xor)).toEqual({ status: 'encrypted' });
  });

  it.each(['signature', 'short-header', 'short-cipher', 'overlap', 'zero-aes', 'oversize-aes', 'oversize-file'])(
    'rejects malformed %s without returning an allocated probe', (mutation) => {
      const sample = fixture();
      let bytes = Buffer.from(sample.file);
      if (mutation === 'signature') bytes[0] ^= 1;
      if (mutation === 'short-header') bytes = bytes.subarray(0, 14);
      if (mutation === 'short-cipher') bytes = bytes.subarray(0, 40);
      if (mutation === 'overlap') bytes.writeUInt32LE(bytes.length, 10);
      if (mutation === 'zero-aes') bytes.writeUInt32LE(0, 6);
      if (mutation === 'oversize-aes') bytes.writeUInt32LE(65537, 6);
      if (mutation === 'oversize-file') bytes = Buffer.concat([bytes, Buffer.alloc(12 * 1024 * 1024)]);
      expect(createWechatV2Probe(bytes)).toBeUndefined();
      expect(decodeWechatV2Image(bytes, KEY, sample.xor)).toEqual({ status: 'unsupported' });
    },
  );

  it('leaves the reserved header byte uninterpreted and owns erasable probe copies', () => {
    const sample = fixture();
    sample.file[14] = 0x7f;
    const selected = probe(sample.file);
    const savedCipher = Buffer.from(selected.cipher);
    sample.file.fill(0);
    expect(selected.cipher).toEqual(savedCipher);
    clearWechatV2Probe(selected);
    expect(zeroed(selected.cipher)).toBe(true);
    expect(zeroed(selected.tail)).toBe(true);
  });
});

describe('bounded read-only image candidate scan', () => {
  it.each([
    ['ASCII16', 'ascii', ''], ['ASCII32', 'ascii', 'ABCDEFGHIJKLMNOP'],
    ['UTF16LE16', 'utf16le', ''], ['UTF16LE32', 'utf16le', 'ABCDEFGHIJKLMNOP'],
  ] as const)('finds %s as the first sixteen ASCII characters, not a hex-decoded key', async (_label, encoding, suffix) => {
    const material = Buffer.from(KEY.toString('ascii') + suffix, encoding);
    const sample = fixture();
    const selected = probe(sample.file);
    const source = memory(Buffer.concat([Buffer.from([0xff]), material, Buffer.from([0xff, 0xff])]));
    try {
      const result = await scanWechatImageKey(() => source.reader, [123], selected, { yieldControl: pause });
      expect(result).toEqual(KEY);
      result?.fill(0);
      expect(source.reader.close).toHaveBeenCalledOnce();
      expect(source.copies.every(zeroed)).toBe(true);
      expect(selected.cipher).toEqual(sample.encryptedHead);
    } finally { clearWechatV2Probe(selected); }
  });

  it('accepts a complete candidate at the end of a readable region', async () => {
    const selected = probe(fixture().file);
    const source = memory(Buffer.from(KEY));
    try {
      const result = await scanWechatImageKey(() => source.reader, [123], selected, { yieldControl: pause });
      expect(result).toEqual(KEY);
      result?.fill(0);
    } finally { clearWechatV2Probe(selected); }
  });

  it('keeps enough overlap for a UTF16LE key crossing a two-MiB chunk boundary', async () => {
    const data = Buffer.alloc(2 * 1024 * 1024 + 100, 0xff);
    Buffer.from(KEY.toString('ascii') + 'ABCDEFGHIJKLMNOP', 'utf16le').copy(data, 2 * 1024 * 1024 - 5);
    const source = memory(data);
    const selected = probe(fixture().file);
    try {
      const result = await scanWechatImageKey(() => source.reader, [123], selected, { yieldControl: pause });
      expect(result).toEqual(KEY);
      result?.fill(0);
      expect(source.copies.every(zeroed)).toBe(true);
    } finally { clearWechatV2Probe(selected); }
  });

  it('rejects arbitrary substrings in a longer alphanumeric run', async () => {
    const source = memory(Buffer.concat([KEY, Buffer.from('Z')]));
    const selected = probe(fixture().file);
    try {
      expect(await scanWechatImageKey(() => source.reader, [123], selected, { yieldControl: pause })).toBeUndefined();
    } finally { clearWechatV2Probe(selected); }
  });

  it('validates against the actual requested image instead of accepting another epoch key', async () => {
    const source = memory(Buffer.concat([KEY, Buffer.from('!'), OTHER_KEY, Buffer.from('!')]));
    const selected = probe(fixture({ key: OTHER_KEY }).file);
    try {
      const result = await scanWechatImageKey(() => source.reader, [123], selected, { yieldControl: pause });
      expect(result).toEqual(OTHER_KEY);
      result?.fill(0);
    } finally { clearWechatV2Probe(selected); }
  });

  it('does not open any process before the initial yield or after cancellation', async () => {
    let resume!: () => void;
    let cancelled = false;
    const open = vi.fn();
    const selected = probe(fixture().file);
    const waiting = scanWechatImageKey(open, [123], selected, {
      cancelled: () => cancelled, yieldControl: () => new Promise<void>((resolve) => { resume = resolve; }),
    });
    expect(open).not.toHaveBeenCalled();
    cancelled = true;
    resume();
    try { expect(await waiting).toBeUndefined(); expect(open).not.toHaveBeenCalled(); }
    finally { clearWechatV2Probe(selected); }
  });

  it('wipes a candidate read just as cancellation arrives without returning its key', async () => {
    const source = memory(Buffer.from(KEY));
    const selected = probe(fixture().file);
    let cancelled = false;
    const read = source.reader.read;
    source.reader.read = (address, length) => { cancelled = true; return read(address, length); };
    try {
      expect(await scanWechatImageKey(() => source.reader, [123], selected, {
        cancelled: () => cancelled, yieldControl: pause,
      })).toBeUndefined();
      expect(source.reader.close).toHaveBeenCalledOnce();
      expect(source.copies.every(zeroed)).toBe(true);
    } finally { clearWechatV2Probe(selected); }
  });

  it('enforces time from a zero-based test clock and closes the reader', async () => {
    let now = 0;
    const source = memory(Buffer.from(KEY));
    const selected = probe(fixture().file);
    const read = source.reader.read;
    source.reader.read = (address, length) => { now = 20; return read(address, length); };
    try {
      expect(await scanWechatImageKey(() => source.reader, [123], selected, {
        now: () => now, timeoutMs: 20, yieldControl: pause,
      })).toBeUndefined();
      expect(source.reader.close).toHaveBeenCalledOnce();
      expect(source.copies.every(zeroed)).toBe(true);
    } finally { clearWechatV2Probe(selected); }
  });

  it('enforces scan byte and candidate budgets rather than visiting the next process', async () => {
    const selected = probe(fixture({ key: OTHER_KEY }).file);
    try {
      const bytesSource = memory(Buffer.alloc(2000));
      const open = vi.fn(() => bytesSource.reader);
      expect(await scanWechatImageKey(open, [123, 456], selected, {
        maxScannedBytes: 100, yieldControl: pause,
      })).toBeUndefined();
      expect(bytesSource.reader.read).toHaveBeenCalledWith(0x10000, 100);
      expect(open).toHaveBeenCalledOnce();
      const candidateSource = memory(Buffer.concat([KEY, Buffer.from('!'), OTHER_KEY, Buffer.from('!')]));
      expect(await scanWechatImageKey(() => candidateSource.reader, [123], selected, {
        maxCandidates: 1, yieldControl: pause,
      })).toBeUndefined();
      const atLimit = await scanWechatImageKey(() => candidateSource.reader, [123], selected, {
        maxCandidates: 2, yieldControl: pause,
      });
      expect(atLimit).toEqual(OTHER_KEY);
      atLimit?.fill(0);
    } finally { clearWechatV2Probe(selected); }
  });

  it('never allows an option to raise the two-GiB or thirty-second hard limits', async () => {
    const selected = probe(fixture().file);
    let bytesRead = 0;
    const reader: ReadableWechatProcess = {
      regions: () => [{ address: 0x10000, size: 4 * 1024 * 1024 * 1024 }],
      read: (_address, length) => { bytesRead += length; return null; },
      close: vi.fn(),
    };
    try {
      expect(await scanWechatImageKey(() => reader, [123], selected, {
        maxScannedBytes: Number.MAX_SAFE_INTEGER, yieldControl: pause,
      })).toBeUndefined();
      expect(bytesRead).toBe(2 * 1024 * 1024 * 1024);
      let now = 0;
      const open = vi.fn();
      expect(await scanWechatImageKey(open, [123], selected, {
        timeoutMs: Number.MAX_SAFE_INTEGER, now: () => now,
        yieldControl: async () => { now = 30000; },
      })).toBeUndefined();
      expect(open).not.toHaveBeenCalled();
    } finally { clearWechatV2Probe(selected); }
  });

  it('deduplicates overlapping candidate material before applying the candidate budget', async () => {
    const selected = probe(fixture({ key: OTHER_KEY }).file);
    const source = memory(Buffer.concat([KEY, Buffer.from('!'), KEY, Buffer.from('!'), OTHER_KEY]));
    try {
      const result = await scanWechatImageKey(() => source.reader, [123], selected, {
        maxCandidates: 2, yieldControl: pause,
      });
      expect(result).toEqual(OTHER_KEY);
      result?.fill(0);
    } finally { clearWechatV2Probe(selected); }
  });

  it('continues after a process disappears, deduplicates PIDs, and limits attempts to eight', async () => {
    const selected = probe(fixture().file);
    const source = memory(Buffer.from(KEY));
    const open = vi.fn((pid: number) => {
      if (pid === 123) throw new Error('PRIVATE_PATH_OR_CREDENTIAL');
      return source.reader;
    });
    try {
      const result = await scanWechatImageKey(open, [-1, 0, 1.5, 123, 123, 456], selected, { yieldControl: pause });
      expect(result).toEqual(KEY);
      result?.fill(0);
      expect(open.mock.calls.map(([pid]) => pid)).toEqual([123, 456]);
      const denied = vi.fn(() => { throw new Error('PRIVATE'); });
      expect(await scanWechatImageKey(denied, Array.from({ length: 20 }, (_, index) => index + 1), selected,
        { yieldControl: pause })).toBeUndefined();
      expect(denied).toHaveBeenCalledTimes(8);
    } finally { clearWechatV2Probe(selected); }
  });

  it('yields during a candidate-heavy chunk so cancellation does not wait for a whole region', async () => {
    const strings = Array.from({ length: 600 }, (_, index) => index.toString(16).padStart(16, '0'));
    const source = memory(Buffer.from(strings.join('!')));
    const selected = probe(fixture().file);
    let cancelled = false;
    const yielding = vi.fn(async () => { if (yielding.mock.calls.length === 2) cancelled = true; });
    try {
      expect(await scanWechatImageKey(() => source.reader, [123], selected, {
        cancelled: () => cancelled, yieldControl: yielding,
      })).toBeUndefined();
      expect(yielding).toHaveBeenCalledTimes(2);
      expect(source.reader.close).toHaveBeenCalledOnce();
      expect(source.copies.every(zeroed)).toBe(true);
    } finally { clearWechatV2Probe(selected); }
  });
});

describe('account-verified config image material', () => {
  it.each([
    ['wxid_synthetic', 0x138], ['wxid_synthetic_long_account', 0x130],
  ] as const)('derives a verified key without a resident ASCII key: %s', async (account, back) => {
    const source = configMemory(account, back);
    const key = Buffer.from(createHash('md5').update(`${source.dword}${account}`).digest('hex').slice(0, 16));
    const sample = probe(fixture({ key }).file);
    try {
      expect(source.data.includes(key)).toBe(false);
      const result = await scanWechatImageKey(() => source.reader, [123], sample, { accountName: account, yieldControl: pause });
      expect(result).toEqual(key);
      result?.fill(0);
      expect(source.copies.every(zeroed)).toBe(true);
      expect(source.reader.close).toHaveBeenCalledOnce();
    } finally { key.fill(0); clearWechatV2Probe(sample); }
  });

  it.each(['wrong-account', 'bad-size', 'bad-capacity', 'bad-pointer', 'wrong-cipher', 'no-account'])(
    'rejects %s config material rather than trusting the landmark', async (mutation) => {
      const source = configMemory();
      const key = Buffer.from(createHash('md5').update(`${source.dword}${source.account}`).digest('hex').slice(0, 16));
      if (mutation === 'bad-size') source.data.writeBigUInt64LE(14n, source.landmark + 16);
      if (mutation === 'bad-capacity') source.data.writeBigUInt64LE(0xffffffffffffffffn, source.config + 0x48 + 24);
      if (mutation === 'bad-pointer') source.data.writeBigUInt64LE(0xffffffffffffffffn, source.landmark + 16 - 0x138);
      const sample = probe(fixture({ key: mutation === 'wrong-cipher' ? OTHER_KEY : key }).file);
      try {
        const accountName = mutation === 'no-account' ? undefined : mutation === 'wrong-account' ? 'wxid_somebody_else' : source.account;
        expect(await scanWechatImageKey(() => source.reader, [123], sample, { accountName, yieldControl: pause })).toBeUndefined();
        expect(source.copies.every(zeroed)).toBe(true);
      } finally { key.fill(0); clearWechatV2Probe(sample); }
    },
  );

  it('counts pointer reads in the scan byte budget', async () => {
    const source = configMemory();
    const key = Buffer.from(createHash('md5').update(`${source.dword}${source.account}`).digest('hex').slice(0, 16));
    const sample = probe(fixture({ key }).file);
    try {
      expect(await scanWechatImageKey(() => source.reader, [123], sample, {
        accountName: source.account, yieldControl: pause, maxScannedBytes: source.data.length,
      })).toBeUndefined();
      expect(source.reader.read).toHaveBeenCalledOnce();
    } finally { key.fill(0); clearWechatV2Probe(sample); }
  });
});

describe('config preparation lifecycle', () => {
  it('cancels during config reads and erases every returned buffer', async () => {
    const source = configMemory();
    const key = Buffer.from(createHash('md5').update(`${source.dword}${source.account}`).digest('hex').slice(0, 16));
    const sample = probe(fixture({ key }).file);
    let cancelled = false;
    const read = source.reader.read;
    source.reader.read = (address, length) => {
      const bytes = read(address, length);
      if (length === source.account.length + 1) cancelled = true;
      return bytes;
    };
    try {
      expect(await scanWechatImageKey(() => source.reader, [123], sample, {
        accountName: source.account, yieldControl: pause, cancelled: () => cancelled,
      })).toBeUndefined();
      expect(cancelled).toBe(true);
      expect(source.copies.every(zeroed)).toBe(true);
      expect(source.reader.close).toHaveBeenCalledOnce();
    } finally { key.fill(0); clearWechatV2Probe(sample); }
  });

  it('passes the selected account through the provider and caches the verified material', async () => {
    const source = configMemory();
    const key = Buffer.from(createHash('md5').update(`${source.dword}${source.account}`).digest('hex').slice(0, 16));
    const file = fixture({ key, tailLength: 0 });
    const open = vi.fn(() => source.reader);
    const provider = new WechatImageCryptoProvider({
      open, discoverProcessIds: async () => [123], accountName: source.account, yieldControl: pause,
    });
    try {
      expect(provider.decode(file.file)).toEqual({ status: 'pending' });
      await provider.waitForIdle();
      const result = provider.decode(file.file);
      expect(result.status).toBe('ready');
      if (result.status === 'ready') { expect(result.bytes).toEqual(file.plaintext); result.bytes.fill(0); }
      expect(open).toHaveBeenCalledOnce();
    } finally { key.fill(0); provider.dispose(); }
  });
});

describe('single-flight account-lifetime image key provider', () => {
  it('returns pending immediately, copies probes, caches success and notifies once', async () => {
    const source = fixture();
    const thumbnail = probe(source.file);
    const onReady = vi.fn();
    const { provider, open, discover, readers } = providerFixture(undefined, { onReady });
    const disposableFile = Buffer.from(source.file);
    try {
      expect(provider.decode(disposableFile, [thumbnail])).toEqual({ status: 'pending' });
      expect(provider.decode(source.file, [thumbnail])).toEqual({ status: 'pending' });
      expect(open).not.toHaveBeenCalled();
      expect(discover).not.toHaveBeenCalled();
      disposableFile.fill(0);
      clearWechatV2Probe(thumbnail);
      await provider.waitForIdle();
      const result = provider.decode(source.file);
      expect(result.status).toBe('ready');
      if (result.status === 'ready') { expect(result.bytes).toEqual(source.plaintext); result.bytes.fill(0); }
      expect(open).toHaveBeenCalledOnce();
      expect(discover).toHaveBeenCalledOnce();
      expect(onReady).toHaveBeenCalledOnce();
      expect(readers.every((reader) => reader.copies.every(zeroed))).toBe(true);
    } finally { provider.dispose(); clearWechatV2Probe(thumbnail); }
  });

  it('derives XOR only from JPEG thumbnails matching the requested key, not all account images', async () => {
    const requested = fixture({ format: 'image/png', xor: 0x12 });
    const correct = probe(fixture({ xor: 0x12 }).file);
    const otherEpoch = probe(fixture({ key: OTHER_KEY, xor: 0x71 }).file);
    const notJpeg = probe(fixture({ format: 'image/png', xor: 0x72 }).file);
    const { provider } = providerFixture();
    try {
      expect(provider.decode(requested.file, [otherEpoch, notJpeg, correct])).toEqual({ status: 'pending' });
      await provider.waitForIdle();
      const result = provider.decode(requested.file);
      expect(result.status).toBe('ready');
      if (result.status === 'ready') { expect(result.bytes).toEqual(requested.plaintext); result.bytes.fill(0); }
    } finally { provider.dispose(); [correct, otherEpoch, notJpeg].forEach(clearWechatV2Probe); }
  });

  it('keeps a verified key but does not guess XOR when no suitable thumbnail is available', async () => {
    const requested = fixture();
    const correct = probe(requested.file);
    const otherEpoch = probe(fixture({ key: OTHER_KEY }).file);
    const { provider, open } = providerFixture();
    try {
      provider.decode(requested.file);
      await provider.waitForIdle();
      expect(provider.decode(requested.file, [otherEpoch])).toEqual({ status: 'encrypted' });
      const result = provider.decode(requested.file, [correct]);
      expect(result.status).toBe('ready');
      if (result.status === 'ready') { expect(result.bytes).toEqual(requested.plaintext); result.bytes.fill(0); }
      expect(open).toHaveBeenCalledOnce();
    } finally { provider.dispose(); [correct, otherEpoch].forEach(clearWechatV2Probe); }
  });

  it('does not guess between equally supported incompatible JPEG XOR tails', async () => {
    const requested = fixture();
    const a = probe(fixture({ xor: 0x47 }).file);
    const b = probe(fixture({ xor: 0x70 }).file);
    const { provider } = providerFixture();
    try {
      provider.decode(requested.file, [a, b]);
      await provider.waitForIdle();
      expect(provider.decode(requested.file)).toEqual({ status: 'encrypted' });
    } finally { provider.dispose(); [a, b].forEach(clearWechatV2Probe); }
  });

  it('validates a wxgf probe for key discovery but returns unsupported, allowing same-key JPEG fallback', async () => {
    const requested = fixture({ format: 'wxgf' });
    const jpeg = fixture();
    const thumbnail = probe(jpeg.file);
    const { provider, open } = providerFixture();
    try {
      provider.decode(requested.file, [thumbnail]);
      await provider.waitForIdle();
      expect(provider.decode(requested.file)).toEqual({ status: 'unsupported' });
      const fallback = provider.decode(jpeg.file);
      expect(fallback.status).toBe('ready');
      if (fallback.status === 'ready') { expect(fallback.bytes).toEqual(jpeg.plaintext); fallback.bytes.fill(0); }
      expect(open).toHaveBeenCalledOnce();
    } finally { provider.dispose(); clearWechatV2Probe(thumbnail); }
  });

  it('keeps failures in a 30-second cooldown, including a clock starting at zero', async () => {
    let now = 0;
    const sample = fixture();
    const { provider, open } = providerFixture(Buffer.from('no-credential'), { now: () => now });
    try {
      expect(provider.decode(sample.file)).toEqual({ status: 'pending' });
      await provider.waitForIdle();
      expect(provider.decode(sample.file)).toEqual({ status: 'encrypted' });
      now = 29999;
      expect(provider.decode(sample.file)).toEqual({ status: 'encrypted' });
      expect(open).toHaveBeenCalledOnce();
      now = 30000;
      expect(provider.decode(sample.file)).toEqual({ status: 'pending' });
      await provider.waitForIdle();
      expect(open).toHaveBeenCalledTimes(2);
    } finally { provider.dispose(); }
  });

  it('cancels pending discovery, erases snapshots immediately, and ignores late process IDs', async () => {
    let discovered!: (value: number[]) => void;
    let discoveryStarted!: () => void;
    const started = new Promise<void>((resolve) => { discoveryStarted = resolve; });
    const { provider, open } = providerFixture(undefined, {
      discoverProcessIds: () => new Promise<number[]>((resolve) => { discovered = resolve; discoveryStarted(); }),
    });
    const sample = fixture();
    const thumbnail = probe(sample.file);
    provider.decode(sample.file, [thumbnail]);
    const pending = (provider as unknown as { pending: { requested: WechatV2Probe; thumbnails: WechatV2Probe[] } }).pending;
    await started;
    provider.dispose();
    expect(zeroed(pending.requested.cipher)).toBe(true);
    expect(pending.thumbnails.every((item) => zeroed(item.cipher) && zeroed(item.tail))).toBe(true);
    await provider.waitForIdle();
    discovered([123]);
    await Promise.resolve();
    expect(open).not.toHaveBeenCalled();
    expect(provider.decode(sample.file)).toEqual({ status: 'encrypted' });
    clearWechatV2Probe(thumbnail);
  });

  it('erases cached keys on dispose and remains disposed on repeat calls', async () => {
    const { provider } = providerFixture();
    const sample = fixture({ tailLength: 0 });
    provider.decode(sample.file);
    await provider.waitForIdle();
    const cached = (provider as unknown as { keys: { key: Buffer }[] }).keys[0].key;
    expect(cached).toEqual(KEY);
    provider.dispose();
    provider.dispose();
    expect(zeroed(cached)).toBe(true);
    expect(provider.decode(sample.file)).toEqual({ status: 'encrypted' });
  });

  it('does not cache or notify a result when disposed during the final native read', async () => {
    const source = memory(Buffer.from(KEY));
    const read = source.reader.read;
    const onReady = vi.fn();
    const provider = new WechatImageCryptoProvider({
      open: () => source.reader, discoverProcessIds: async () => [123], yieldControl: pause, onReady,
    });
    source.reader.read = (address, length) => { const bytes = read(address, length); provider.dispose(); return bytes; };
    provider.decode(fixture().file);
    await provider.waitForIdle();
    expect(onReady).not.toHaveBeenCalled();
    expect(source.copies.every(zeroed)).toBe(true);
    expect(source.reader.close).toHaveBeenCalledOnce();
  });

  it('keeps a small per-account multi-key cache and wipes evicted material', async () => {
    const keys = Array.from({ length: 5 }, (_, index) => Buffer.from(`key000000000000${index}`, 'ascii'));
    const { provider, open } = providerFixture(Buffer.from(keys.map((item) => item.toString('ascii')).join('!')));
    let oldest: Buffer | undefined;
    try {
      for (let index = 0; index < keys.length; index += 1) {
        const sample = fixture({ key: keys[index], tailLength: 0 });
        provider.decode(sample.file);
        await provider.waitForIdle();
        if (index === 0) oldest = (provider as unknown as { keys: { key: Buffer }[] }).keys[0].key;
        const result = provider.decode(sample.file);
        expect(result.status).toBe('ready');
        if (result.status === 'ready') result.bytes.fill(0);
      }
      expect(open).toHaveBeenCalledTimes(5);
      expect(oldest && zeroed(oldest)).toBe(true);
      expect((provider as unknown as { keys: unknown[] }).keys).toHaveLength(4);
    } finally { provider.dispose(); }
  });

  it('contains discovery and notification exceptions without exposing their text', async () => {
    const sample = fixture({ tailLength: 0 });
    const failing = providerFixture(undefined, { discoverProcessIds: async () => { throw new Error('PRIVATE_CONTENT'); } });
    try {
      expect(failing.provider.decode(sample.file)).toEqual({ status: 'pending' });
      await expect(failing.provider.waitForIdle()).resolves.toBeUndefined();
      expect(failing.provider.decode(sample.file)).toEqual({ status: 'encrypted' });
      expect(failing.open).not.toHaveBeenCalled();
    } finally { failing.provider.dispose(); }
    const notifying = providerFixture(undefined, { onReady: () => { throw new Error('PRIVATE'); } });
    try {
      notifying.provider.decode(sample.file);
      await expect(notifying.provider.waitForIdle()).resolves.toBeUndefined();
      const result = notifying.provider.decode(sample.file);
      expect(result.status).toBe('ready');
      if (result.status === 'ready') result.bytes.fill(0);
    } finally { notifying.provider.dispose(); }
  });

  it('times out a discovery promise that never settles without opening any process', async () => {
    vi.useFakeTimers();
    const open = vi.fn();
    const provider = new WechatImageCryptoProvider({
      open, discoverProcessIds: () => new Promise(() => undefined), timeoutMs: 20, yieldControl: pause,
    });
    try {
      provider.decode(fixture().file);
      const waiting = provider.waitForIdle();
      await vi.advanceTimersByTimeAsync(21);
      await expect(waiting).resolves.toBeUndefined();
      expect(open).not.toHaveBeenCalled();
    } finally { provider.dispose(); vi.useRealTimers(); }
  });
});
