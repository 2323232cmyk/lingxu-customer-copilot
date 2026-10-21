import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  CIPHER_CONFIG_XOR_MASK as CONFIG_MASK,
  CONFIG_CIPHER_NAME as CONFIG_NAME,
  extractSqlCipherHexCandidates,
  verifySqlCipherPageKey,
} from './wechat-key-material';

type KoffiModule = typeof import('koffi');
const MAX_ADDRESS = 0x0000_8000_0000_0000;
const CHUNK_BYTES = 2 * 1024 * 1024;

export class WechatMemoryReadError extends Error {
  constructor(readonly code: 'key.accessDenied' | 'key.notFound' | 'key.scanTimeout'
    | 'key.adapter' | 'wechat.notRunning') {
    super('微信只读连接尚未完成');
    this.name = 'WechatMemoryReadError';
  }
}

export interface ReadableWechatProcess {
  regions(): readonly { address: number; size: number }[];
  read(address: number, length: number): Buffer | null;
  close(): void;
}

export interface WechatDatabaseKeyTarget {
  readonly id: string;
  readonly pageOne: Buffer;
}

const pointerAt = (data: Buffer, offset: number): number => {
  if (offset < 0 || offset + 8 > data.length) return 0;
  const value = data.readBigUInt64LE(offset);
  return value >= 0x10000n && value < BigInt(MAX_ADDRESS) ? Number(value) : 0;
};

/** No write, injection, debugger, privilege escalation, or handle to another session. */
export const openReadonlyWechatProcess = (
  koffi: KoffiModule,
  pid: number,
): ReadableWechatProcess => {
  if (process.platform !== 'win32' || process.arch !== 'x64'
    || !Number.isSafeInteger(pid) || pid <= 0 || pid > 0xffff_ffff) {
    throw new WechatMemoryReadError('key.adapter');
  }
  const kernel = koffi.load(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'kernel32.dll'));
  const openProcess = kernel.func('void* __stdcall OpenProcess(uint32 access, int32 inherit, uint32 pid)');
  const closeHandle = kernel.func('int32 __stdcall CloseHandle(void* handle)');
  const queryImage = kernel.func('int32 __stdcall QueryFullProcessImageNameW(void* handle, uint32 flags, _Out_ uint8* name, _Inout_ uint32* size)');
  const sessionForPid = kernel.func('int32 __stdcall ProcessIdToSessionId(uint32 pid, _Out_ uint32* session)');
  const queryMemory = kernel.func('size_t __stdcall VirtualQueryEx(void* handle, uintptr_t address, _Out_ uint8* info, size_t size)');
  const readMemory = kernel.func('int32 __stdcall ReadProcessMemory(void* handle, uintptr_t address, _Out_ uint8* output, size_t size, _Out_ size_t* read)');
  const currentSession: [unknown] = [0];
  const targetSession: [unknown] = [0];
  if (!sessionForPid(process.pid, currentSession) || !sessionForPid(pid, targetSession)
    || currentSession[0] !== targetSession[0]) {
    throw new WechatMemoryReadError('key.accessDenied');
  }
  const handle = openProcess(0x0400 | 0x0010, 0, pid); // QUERY_INFORMATION | VM_READ only
  if (!handle) throw new WechatMemoryReadError('key.accessDenied');
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    closeHandle(handle);
  };
  try {
    const imageName = Buffer.alloc(2048);
    const imageLength: [unknown] = [1024];
    try {
      if (!queryImage(handle, 0, imageName, imageLength)
        || !['weixin.exe', 'wechat.exe'].includes(path.win32.basename(
          imageName.toString('utf16le', 0, Math.min(1024, Number(imageLength[0])) * 2),
        ).toLowerCase())) throw new WechatMemoryReadError('wechat.notRunning');
    } finally {
      imageName.fill(0);
    }
    return {
      regions: () => {
        if (closed) return [];
        const regions: { address: number; size: number }[] = [];
        const info = Buffer.alloc(48); // Windows MEMORY_BASIC_INFORMATION64
        let address = 0;
        for (let count = 0; count < 50_000 && address < MAX_ADDRESS; count += 1) {
          if (Number(queryMemory(handle, address, info, info.length)) !== info.length) break;
          const base = Number(info.readBigUInt64LE(0));
          const size = Number(info.readBigUInt64LE(24));
          if (!Number.isSafeInteger(base) || !Number.isSafeInteger(size)
            || size <= 0 || base + size <= address || base + size > MAX_ADDRESS) break;
          const protection = info.readUInt32LE(36);
          if (info.readUInt32LE(32) === 0x1000 && (protection & 0x101) === 0
            && [0x02, 0x04, 0x08, 0x20, 0x40, 0x80].includes(protection & 0xff)) {
            regions.push({ address: base, size });
          }
          address = base + size;
        }
        info.fill(0);
        return regions;
      },
      read: (address, length) => {
        if (closed || !Number.isSafeInteger(address) || address < 0x10000
          || address + length >= MAX_ADDRESS || !Number.isSafeInteger(length)
          || length < 1 || length > CHUNK_BYTES + 256) return null;
        const buffer = Buffer.alloc(length);
        const count: [unknown] = [0];
        let complete = false;
        try {
          const ok = readMemory(handle, address, buffer, length, count);
          const received = Number(count[0]);
          if (!ok || received !== length) return null;
          complete = true;
          return buffer;
        } catch {
          throw new WechatMemoryReadError('key.adapter');
        } finally {
          if (!complete) buffer.fill(0);
        }
      },
      close,
    };
  } catch (error) {
    close();
    throw error instanceof WechatMemoryReadError ? error : new WechatMemoryReadError('key.adapter');
  }
};

/** Bounded two-pass scan. Credentials never leave this worker or get persisted. */
export const scanWechatDatabaseKeys = async (
  open: (pid: number) => ReadableWechatProcess,
  pids: readonly number[],
  targets: readonly WechatDatabaseKeyTarget[],
  options: { readonly timeoutMs?: number; readonly cancelled?: () => boolean } = {},
): Promise<Map<string, Buffer>> => {
  const deadline = Date.now() + Math.min(55_000, Math.max(1, options.timeoutMs ?? 40_000));
  const keys = new Map<string, Buffer>();
  const pending = new Map(targets.map((target) => [target.id, target]));
  const seenCandidates = new Set<string>();
  let readAnyProcess = false;
  let accessDenied = false;
  let timedOut = false;
  let scannedBytes = 0;
  const done = (): boolean => {
    timedOut = Date.now() >= deadline || scannedBytes >= 3 * 1024 * 1024 * 1024;
    return timedOut || options.cancelled?.() === true || pending.size === 0;
  };
  const consider = (bytes: Buffer): void => {
    const candidates = extractSqlCipherHexCandidates(bytes);
    try {
      for (const candidate of candidates) {
        if (seenCandidates.size >= 1024) continue;
        const fingerprint = createHash('sha256').update(candidate.key)
          .update(candidate.salt ?? Buffer.alloc(0)).digest('hex');
        if (seenCandidates.has(fingerprint)) continue;
        seenCandidates.add(fingerprint);
        for (const [id, target] of pending) {
          if (candidate.salt && !candidate.salt.equals(target.pageOne.subarray(0, 16))) continue;
          if (verifySqlCipherPageKey(candidate.key, target.pageOne)) {
            keys.set(id, Buffer.from(candidate.key));
            pending.delete(id);
          }
        }
      }
    } finally {
      for (const candidate of candidates) {
        candidate.key.fill(0);
        candidate.salt?.fill(0);
      }
    }
  };

  try {
    for (const pid of [...new Set(pids)].slice(0, 8)) {
      if (done()) break;
      let reader: ReadableWechatProcess;
      try {
        reader = open(pid);
      } catch (error) {
        if (!(error instanceof WechatMemoryReadError) || error.code === 'key.adapter') {
          throw new WechatMemoryReadError('key.adapter');
        }
        accessDenied ||= error.code === 'key.accessDenied';
        continue;
      }
      readAnyProcess = true;
      try {
        const regions = reader.regions();
        const nameAddresses = new Set<number>();
        const scanChunks = async (visit: (address: number, data: Buffer) => void): Promise<void> => {
          for (const region of regions) {
            for (let offset = 0; offset < region.size; offset += CHUNK_BYTES) {
              if (done()) return;
              const length = Math.min(CHUNK_BYTES + 256, region.size - offset);
              const data = reader.read(region.address + offset, length);
              scannedBytes += length;
              if (data) {
                try { visit(region.address + offset, data); } finally { data.fill(0); }
              }
              // Yield regularly to allow cancellation and keep the desktop responsive.
              await new Promise<void>((resolve) => setImmediate(resolve));
            }
          }
        };
        await scanChunks((address, data) => {
          if (nameAddresses.size < 64) {
            for (let position = data.indexOf(CONFIG_NAME); position >= 0;
              position = data.indexOf(CONFIG_NAME, position + 1)) {
              nameAddresses.add(address + position);
              if (nameAddresses.size >= 64) break;
            }
          }
          if (data.includes(Buffer.from("x'")) || data.includes(Buffer.from("X'"))) consider(data);
        });
        if (done() || nameAddresses.size === 0) continue;
        const patterns = [...nameAddresses].map((address) => {
          const pattern = Buffer.alloc(16);
          pattern.writeBigUInt64LE(BigInt(address), 0);
          pattern.writeBigUInt64LE(BigInt(CONFIG_NAME.length), 8);
          return pattern;
        });
        const visitedConfigs = new Set<number>();
        await scanChunks((address, data) => {
          for (const pattern of patterns) {
            for (let position = data.indexOf(pattern); position >= 0;
              position = data.indexOf(pattern, position + 1)) {
              if (done() || visitedConfigs.size >= 512) return;
              const node = reader.read(address + position - 0x10, 0x50);
              if (!node || node.length < 0x30) { node?.fill(0); continue; }
              let config = 0;
              try {
                if (!nameAddresses.has(pointerAt(node, 0x10))
                  || node.readBigUInt64LE(0x18) !== BigInt(CONFIG_NAME.length)) continue;
                config = pointerAt(node, 0x28);
              } finally { node.fill(0); }
              if (!config || visitedConfigs.has(config)) continue;
              visitedConfigs.add(config);
              const descriptor = reader.read(config + 0x88, 0x28);
              if (!descriptor) continue;
              let pointer = 0;
              let length = 0;
              try {
                if (descriptor.length >= 0x18) {
                  pointer = pointerAt(descriptor, 8);
                  length = Number(descriptor.readBigUInt64LE(0x10));
                }
              } finally { descriptor.fill(0); }
              if (!pointer || !Number.isSafeInteger(length) || length < 1 || length > 1024) continue;
              const blob = reader.read(pointer, length);
              if (!blob || blob.length !== length) { blob?.fill(0); continue; }
              try {
                for (let index = 0; index < blob.length; index += 1) blob[index] ^= CONFIG_MASK[index % CONFIG_MASK.length];
                consider(blob);
              } finally { blob.fill(0); }
            }
          }
        });
      } finally {
        reader.close();
      }
    }
    if (options.cancelled?.()) throw new WechatMemoryReadError('key.notFound');
    if (keys.size === 0) {
      throw new WechatMemoryReadError(pids.length === 0 ? 'wechat.notRunning'
        : !readAnyProcess ? accessDenied ? 'key.accessDenied' : 'wechat.notRunning'
          : timedOut ? 'key.scanTimeout' : 'key.notFound');
    }
    return keys;
  } catch (error) {
    for (const key of keys.values()) key.fill(0);
    throw error instanceof WechatMemoryReadError ? error : new WechatMemoryReadError('key.adapter');
  }
};
