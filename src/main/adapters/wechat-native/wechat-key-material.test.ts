import { createCipheriv, createHmac, pbkdf2Sync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CIPHER_CONFIG_XOR_MASK,
  CONFIG_CIPHER_NAME,
  deriveSqlCipherPageKey,
  extractSqlCipherHexCandidates,
  verifySqlCipherPageKey,
} from './wechat-key-material';

const TEST_KEY = Buffer.from('0123456789abcdef'.repeat(4), 'hex');
const TEST_SALT = Buffer.from('fedcba9876543210'.repeat(2), 'hex');

// Build ciphertext and its MAC independently of the production helpers.
function encryptedPage(key = TEST_KEY, salt = TEST_SALT, pageNumber = Buffer.from([1, 0, 0, 0])): Buffer {
  const page = Buffer.alloc(4096);
  const iv = Buffer.alloc(16, 0x45);
  const cipher = createCipheriv('aes-256-cbc', key, iv).setAutoPadding(false);
  salt.copy(page);
  Buffer.concat([cipher.update(Buffer.alloc(4000, 0x7b)), cipher.final()]).copy(page, 16);
  iv.copy(page, 4016);
  const macSalt = Buffer.from(salt.map((byte) => byte ^ 0x3a));
  const macKey = pbkdf2Sync(key, macSalt, 2, 32, 'sha512');
  const mac = createHmac('sha512', macKey)
    .update(Buffer.concat([page.subarray(16, 4032), pageNumber]))
    .digest();
  mac.copy(page, 4032);
  macKey.fill(0);
  macSalt.fill(0);
  mac.fill(0);
  return page;
}

describe('SQLCipher page key verification', () => {
  it('authenticates a synthetic SQLCipher 4 page without changing either input', () => {
    const key = Buffer.from(TEST_KEY);
    const page = encryptedPage();
    const originalPage = Buffer.from(page);

    expect(verifySqlCipherPageKey(key, page)).toBe(true);
    expect(key).toEqual(TEST_KEY);
    expect(page).toEqual(originalPage);
  });

  it('rejects the wrong raw key', () => {
    expect(verifySqlCipherPageKey(Buffer.alloc(32, 0x22), encryptedPage())).toBe(false);
  });

  it.each([
    ['salt', 0],
    ['first ciphertext byte', 16],
    ['last ciphertext byte', 4015],
    ['IV', 4016],
    ['last IV byte', 4031],
    ['HMAC', 4032],
    ['last HMAC byte', 4095],
  ])('rejects tampering with the %s', (_name, offset) => {
    const page = encryptedPage();
    page[offset as number] ^= 1;
    expect(verifySqlCipherPageKey(TEST_KEY, page)).toBe(false);
  });

  it('rejects an authenticator for a different page number', () => {
    expect(verifySqlCipherPageKey(TEST_KEY, encryptedPage(TEST_KEY, TEST_SALT, Buffer.from([2, 0, 0, 0])))).toBe(false);
  });

  it('requires a little-endian page number', () => {
    expect(verifySqlCipherPageKey(TEST_KEY, encryptedPage(TEST_KEY, TEST_SALT, Buffer.from([0, 0, 0, 1])))).toBe(false);
  });

  it.each([0, 16, 31, 33, 48, 64])('rejects a %i-byte raw key', (length) => {
    expect(verifySqlCipherPageKey(Buffer.alloc(length), encryptedPage())).toBe(false);
  });

  it.each([0, 16, 1024, 4095, 4097, 8192])('rejects a %i-byte page', (length) => {
    expect(verifySqlCipherPageKey(TEST_KEY, Buffer.alloc(length))).toBe(false);
  });

  it('does not reinterpret hex text as a raw key', () => {
    expect(verifySqlCipherPageKey(Buffer.from(TEST_KEY.toString('hex'), 'ascii'), encryptedPage())).toBe(false);
  });
});

describe('SQLCipher passphrase derivation', () => {
  const passphrase = Buffer.from([0x00, 0xff, 0x61, 0x80, 0x62, 0x00, 0xfe]);
  const expectedKey = pbkdf2Sync(passphrase, TEST_SALT, 256000, 32, 'sha512');
  const page = encryptedPage(expectedKey);

  it('derives and validates a binary passphrase including NUL and non-UTF8 bytes', () => {
    const originalPage = Buffer.from(page);
    const originalPassphrase = Buffer.from(passphrase);
    const key = deriveSqlCipherPageKey(passphrase, page);
    expect(key).toEqual(expectedKey);
    expect(key).not.toBe(expectedKey);
    expect(passphrase).toEqual(originalPassphrase);
    expect(page).toEqual(originalPage);
    key?.fill(0);
  });

  it('returns nothing for the wrong passphrase', () => {
    expect(deriveSqlCipherPageKey(Buffer.from('wrong synthetic passphrase'), page)).toBeUndefined();
  });

  it('does not accept a derived key as if it were the original passphrase', () => {
    expect(deriveSqlCipherPageKey(expectedKey, page)).toBeUndefined();
  });

  it('returns nothing when the selected page salt was changed', () => {
    const changedPage = Buffer.from(page);
    changedPage[0] ^= 1;
    expect(deriveSqlCipherPageKey(passphrase, changedPage)).toBeUndefined();
  });

  it('rejects an empty passphrase', () => {
    expect(deriveSqlCipherPageKey(Buffer.alloc(0), page)).toBeUndefined();
  });

  it.each([0, 4095, 4097, 8192])('rejects a %i-byte page before deriving', (length) => {
    expect(deriveSqlCipherPageKey(passphrase, Buffer.alloc(length))).toBeUndefined();
  });
});

describe('bounded SQLCipher literal extraction', () => {
  const keyHex = TEST_KEY.toString('hex');
  const saltHex = TEST_SALT.toString('hex');

  it('extracts a 64-hex ASCII raw-key literal surrounded by arbitrary bytes', () => {
    const chunk = Buffer.concat([Buffer.from([0xff, 0, 0x80]), Buffer.from(`x'${keyHex}'`), Buffer.from([0, 0xff])]);
    expect(extractSqlCipherHexCandidates(chunk)).toEqual([{ key: TEST_KEY }]);
  });

  it('extracts a 96-hex raw key plus its explicit salt without combining them', () => {
    expect(extractSqlCipherHexCandidates(Buffer.from(`x'${keyHex}${saltHex}'`)))
      .toEqual([{ key: TEST_KEY, salt: TEST_SALT }]);
  });

  it('accepts uppercase hex and an uppercase SQL literal prefix', () => {
    expect(extractSqlCipherHexCandidates(Buffer.from(`X'${keyHex.toUpperCase()}${saltHex.toUpperCase()}'`)))
      .toEqual([{ key: TEST_KEY, salt: TEST_SALT }]);
  });

  it('returns independent buffers and leaves the input untouched', () => {
    const chunk = Buffer.from(`x'${keyHex}${saltHex}'x'${keyHex}${saltHex}'`);
    const before = Buffer.from(chunk);
    const candidates = extractSqlCipherHexCandidates(chunk);
    expect(chunk).toEqual(before);
    expect(candidates).toHaveLength(2);
    chunk.fill(0);
    expect(candidates[0]).toEqual({ key: TEST_KEY, salt: TEST_SALT });
    candidates[0].key.fill(0);
    candidates[0].salt?.fill(0);
    expect(candidates[1]).toEqual({ key: TEST_KEY, salt: TEST_SALT });
  });

  it.each([0, 2, 32, 63, 65, 95, 97, 128, 160, 192])('rejects a %i-hex-digit literal', (length) => {
    expect(extractSqlCipherHexCandidates(Buffer.from(`x'${'a'.repeat(length)}'`))).toEqual([]);
  });

  it.each([
    ['bare hex', keyHex],
    ['ordinary decimal digits', '1'.repeat(64)],
    ['no prefix', `'${keyHex}'`],
    ['no closing quote', `x'${keyHex}`],
    ['wrong quotes', `x"${keyHex}"`],
    ['whitespace in literal', `x'${keyHex.slice(0, 32)} ${keyHex.slice(32)}'`],
    ['non-hex byte', `x'${keyHex.slice(0, 63)}g'`],
    ['backslash escape', `x'${keyHex.slice(0, 32)}\\${keyHex.slice(32)}'`],
  ])('rejects %s', (_name, text) => {
    expect(extractSqlCipherHexCandidates(Buffer.from(text))).toEqual([]);
  });

  it('does not claim to support UTF16-LE or UTF16-BE literals', () => {
    const utf16le = Buffer.from(`x'${keyHex}${saltHex}'`, 'utf16le');
    const utf16be = Buffer.from(utf16le).swap16();
    expect(extractSqlCipherHexCandidates(utf16le)).toEqual([]);
    expect(extractSqlCipherHexCandidates(utf16be)).toEqual([]);
  });

  it('can continue past malformed literals to find a valid one', () => {
    expect(extractSqlCipherHexCandidates(Buffer.from(`x'${'a'.repeat(97)}' x'invalid' x'${keyHex}'`)))
      .toEqual([{ key: TEST_KEY }]);
  });

  it('does not turn an unverified candidate or unrelated salt into an account verdict', () => {
    const differentSalt = Buffer.alloc(16, 0x66);
    const candidates = extractSqlCipherHexCandidates(Buffer.from(`x'${keyHex}${differentSalt.toString('hex')}'`));
    expect(candidates[0].salt?.equals(TEST_SALT)).toBe(false);
    expect(candidates[0].key).toEqual(TEST_KEY);
    expect(verifySqlCipherPageKey(Buffer.alloc(32, 0x44), encryptedPage())).toBe(false);
  });

  it('accepts at most 64 candidates in source order', () => {
    const chunk = Buffer.from(Array.from({ length: 70 }, (_unused, index) =>
      `x'${Buffer.alloc(32, index).toString('hex')}'`).join(' '));
    const candidates = extractSqlCipherHexCandidates(chunk);
    expect(candidates).toHaveLength(64);
    candidates.forEach((candidate, index) => {
      expect(candidate).toEqual({ key: Buffer.alloc(32, index) });
    });
  });

  it('accepts a chunk of exactly 8 MiB with a literal ending at its last byte', () => {
    const chunk = Buffer.alloc(8 * 1024 * 1024);
    const literal = Buffer.from(`x'${keyHex}'`);
    literal.copy(chunk, chunk.length - literal.length);
    expect(extractSqlCipherHexCandidates(chunk)).toEqual([{ key: TEST_KEY }]);
  });

  it('rejects an oversized chunk entirely, including a valid prefix literal', () => {
    const chunk = Buffer.alloc(8 * 1024 * 1024 + 1);
    chunk.write(`x'${keyHex}'`);
    expect(extractSqlCipherHexCandidates(chunk)).toEqual([]);
  });

  it('returns no candidates for an empty chunk', () => {
    expect(extractSqlCipherHexCandidates(Buffer.alloc(0))).toEqual([]);
  });

  it('exports only the pinned public Config.Cipher lookup constants', () => {
    expect(CONFIG_CIPHER_NAME.toString('ascii')).toBe('com.Tencent.WCDB.Config.Cipher');
    expect(CIPHER_CONFIG_XOR_MASK).toEqual(Buffer.from(
      'd2c7442458020000004889442450488b450048844c2448488944254048584c24', 'hex',
    ));
    expect(CIPHER_CONFIG_XOR_MASK).toHaveLength(32);
  });
});
