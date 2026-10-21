import { createHmac, randomBytes } from 'node:crypto';
import type { WechatMessageDatabase } from './wechat-message-store';

export const MAX_WECHAT_VOICE_BYTES = 4 * 1024 * 1024;
export interface NativeWechatVoiceRef {
  readonly mediaKey: string;
  readonly status: 'pending' | 'ready' | 'missing' | 'unsupported';
}
interface VoiceIdentity { localId: string; serverId: string; createTime: string }
interface VoiceEntry { username: string; identity: VoiceIdentity; ref: NativeWechatVoiceRef }
const integer = (value: string): boolean => /^\d{1,20}$/u.test(value) && BigInt(value) <= 9223372036854775807n;

export function voiceFormat(bytes: Buffer): 'silk' | 'wav' | undefined {
  const start = bytes[0] === 2 ? 1 : 0;
  if (bytes.length >= start + 9 && bytes.toString('ascii', start, start + 9) === '#!SILK_V3') return 'silk';
  if (bytes.length >= 44 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE') return 'wav';
  return undefined;
}

/** Reads only a registered message's exact local account/chat/id/time tuple. */
export class NativeWechatVoiceStore {
  private readonly secret = randomBytes(32);
  private readonly entries = new Map<string, VoiceEntry>();
  private disposed = false;
  constructor(private readonly databases: readonly WechatMessageDatabase[]) {}

  registerMessageVoice(username: string, identity: VoiceIdentity): NativeWechatVoiceRef | undefined {
    if (this.disposed || !username || username.length > 512 || username.trim() !== username || username.includes('\0')
      || !integer(identity.localId) || BigInt(identity.localId) < 1n || !integer(identity.serverId)
      || !integer(identity.createTime) || BigInt(identity.createTime) < 946684800n || BigInt(identity.createTime) > 4102444800n) return undefined;
    const mediaKey = `media_${createHmac('sha256', this.secret).update(JSON.stringify([username, identity.localId, identity.serverId, identity.createTime])).digest('hex')}`;
    const old = this.entries.get(mediaKey);
    if (old) { this.entries.delete(mediaKey); this.entries.set(mediaKey, old); return old.ref; }
    const ref: NativeWechatVoiceRef = { mediaKey, status: 'pending' };
    this.entries.set(mediaKey, { username, identity: { ...identity }, ref });
    if (this.entries.size > 4096) this.entries.delete(this.entries.keys().next().value as string);
    return ref;
  }

  getVoiceRef(mediaKey: string): NativeWechatVoiceRef | undefined { return this.disposed ? undefined : this.entries.get(mediaKey)?.ref; }

  /** Caller owns the returned buffer and must erase it after bounded IPC transfer. */
  readVoice(mediaKey: string): { bytes: Buffer; format: 'silk' | 'wav' } | undefined {
    const entry = this.entries.get(mediaKey);
    if (this.disposed || !entry) return undefined;
    let owned: Buffer | undefined;
    let format: 'silk' | 'wav' | undefined;
    try {
      for (const source of this.databases.filter((item) => item.kind === 'voice')) {
        const columns = new Set(source.db.query('PRAGMA table_info("VoiceInfo")', []).map((row) => row.name));
        if (!['chat_name_id', 'local_id', 'svr_id', 'create_time', 'voice_data'].every((column) => columns.has(column))) continue;
        const names = new Set(source.db.query('PRAGMA table_info("Name2Id")', []).map((row) => row.name));
        if (!names.has('user_name')) continue;
        // WeChat 4.x schema reference: kclx/WeChatDecrypted docs/WeChat 语音恢复流程总结.md.
        // No guessed path, global server-id-only match, or message body is used.
        const rows = source.db.query('SELECT v.voice_data FROM VoiceInfo AS v '
          + 'JOIN Name2Id AS n ON n.rowid = v.chat_name_id '
          + 'WHERE n.user_name = ? AND v.local_id = ? AND v.svr_id = ? AND v.create_time = ? '
          + 'AND length(v.voice_data) BETWEEN 1 AND ? LIMIT 2',
        [entry.username, entry.identity.localId, entry.identity.serverId, entry.identity.createTime, MAX_WECHAT_VOICE_BYTES]);
        for (const row of rows) {
          const bytes = Buffer.isBuffer(row.voice_data) ? row.voice_data : undefined;
          const detected = bytes && bytes.length <= MAX_WECHAT_VOICE_BYTES ? voiceFormat(bytes) : undefined;
          if (!bytes || !detected || owned && (!owned.equals(bytes) || detected !== format)) {
            bytes?.fill(0); throw new Error('Unsupported or ambiguous voice record');
          }
          if (owned) bytes.fill(0);
          else { owned = bytes; format = detected; }
        }
      }
      entry.ref = { mediaKey, status: owned ? 'ready' : 'missing' };
      if (owned && format) { const bytes = owned; owned = undefined; return { bytes, format }; }
    } catch { entry.ref = { mediaKey, status: 'unsupported' }; }
    finally { owned?.fill(0); }
    return undefined;
  }

  dispose(): void { this.disposed = true; this.entries.clear(); this.secret.fill(0); }
}
