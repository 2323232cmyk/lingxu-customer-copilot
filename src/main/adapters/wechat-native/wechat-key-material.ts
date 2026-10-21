import { createHmac, pbkdf2Sync, timingSafeEqual } from 'node:crypto';

// SQLCipher 4 page authentication; Config.Cipher constants reference the MIT project
// TANGandXUE/wcdb-key-tool, commit 79f1b5b92e12c66aa281b4a60a3c478b5f547dfa.
// Copyright (c) 2025 CloudDreamAI / TANGandXUE.
export const CONFIG_CIPHER_NAME = Buffer.from('com.Tencent.WCDB.Config.Cipher', 'ascii');
export const CIPHER_CONFIG_XOR_MASK = Buffer.from(
  'd2c7442458020000004889442450488b450048844c2448488944254048584c24',
  'hex',
);

const PAGE_SIZE = 4096;
const SALT_SIZE = 16;
const KEY_SIZE = 32;
const MAC_OFFSET = 4032;
const FIRST_PAGE_NUMBER = Buffer.from([1, 0, 0, 0]);
const MAX_CHUNK_SIZE = 8 * 1024 * 1024;
const MAX_CANDIDATES = 64;

export interface SqlCipherHexCandidate {
  readonly key: Buffer;
  readonly salt?: Buffer;
}

/** Authenticate one SQLCipher 4 page with an already-derived 32-byte page key. */
export function verifySqlCipherPageKey(key: Buffer, pageOne: Buffer): boolean {
  if (!Buffer.isBuffer(key) || key.length !== KEY_SIZE
    || !Buffer.isBuffer(pageOne) || pageOne.length !== PAGE_SIZE) return false;

  const hmacSalt = Buffer.alloc(SALT_SIZE);
  let hmacKey: Buffer | undefined;
  let digest: Buffer | undefined;
  try {
    for (let index = 0; index < SALT_SIZE; index += 1) {
      hmacSalt[index] = pageOne[index] ^ 0x3a;
    }
    hmacKey = pbkdf2Sync(key, hmacSalt, 2, KEY_SIZE, 'sha512');
    digest = createHmac('sha512', hmacKey)
      .update(pageOne.subarray(SALT_SIZE, MAC_OFFSET))
      .update(FIRST_PAGE_NUMBER)
      .digest();
    return timingSafeEqual(digest, pageOne.subarray(MAC_OFFSET));
  } finally {
    hmacSalt.fill(0);
    hmacKey?.fill(0);
    digest?.fill(0);
  }
}

/** The successful returned key belongs to the caller and must be cleared after use. */
export function deriveSqlCipherPageKey(passphrase: Buffer, pageOne: Buffer): Buffer | undefined {
  if (!Buffer.isBuffer(passphrase) || passphrase.length === 0
    || !Buffer.isBuffer(pageOne) || pageOne.length !== PAGE_SIZE) return undefined;

  let key: Buffer | undefined;
  let verified = false;
  try {
    key = pbkdf2Sync(passphrase, pageOne.subarray(0, SALT_SIZE), 256000, KEY_SIZE, 'sha512');
    verified = verifySqlCipherPageKey(key, pageOne);
    return verified ? key : undefined;
  } finally {
    if (!verified) key?.fill(0);
  }
}

function hexNibble(byte: number): number {
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30;
  if (byte >= 0x41 && byte <= 0x46) return byte - 0x41 + 10;
  if (byte >= 0x61 && byte <= 0x66) return byte - 0x61 + 10;
  return -1;
}

function decodeHex(chunk: Buffer, start: number, size: number): Buffer {
  const decoded = Buffer.alloc(size);
  for (let index = 0; index < size; index += 1) {
    decoded[index] = (hexNibble(chunk[start + index * 2]) << 4)
      | hexNibble(chunk[start + index * 2 + 1]);
  }
  return decoded;
}

/**
 * Extract only bounded ASCII SQLCipher raw-key literals; never stringify memory.
 * A supplied salt must match the selected database before its key is tried.
 * Callers own (and must clear) each independent key/salt buffer returned here.
 */
export function extractSqlCipherHexCandidates(chunk: Buffer): readonly SqlCipherHexCandidate[] {
  if (!Buffer.isBuffer(chunk) || chunk.length > MAX_CHUNK_SIZE) return [];

  const candidates: SqlCipherHexCandidate[] = [];
  for (let index = 0; index + 67 <= chunk.length && candidates.length < MAX_CANDIDATES; index += 1) {
    if ((chunk[index] !== 0x78 && chunk[index] !== 0x58) || chunk[index + 1] !== 0x27) continue;

    const start = index + 2;
    let end = start;
    while (end < chunk.length && end - start <= 96 && hexNibble(chunk[end]) !== -1) end += 1;
    const digits = end - start;
    if ((digits !== 64 && digits !== 96) || chunk[end] !== 0x27) continue;

    const key = decodeHex(chunk, start, KEY_SIZE);
    candidates.push(digits === 96
      ? { key, salt: decodeHex(chunk, start + KEY_SIZE * 2, SALT_SIZE) }
      : { key });
    index = end;
  }
  return candidates;
}
