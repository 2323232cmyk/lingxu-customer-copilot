import { describe, expect, it, vi } from 'vitest';
import { MAX_WECHAT_VOICE_BYTES, NativeWechatVoiceStore, voiceFormat } from './wechat-voice-store';
import type { WechatMessageDatabase } from './wechat-message-store';

const identity = { localId: '7', serverId: '9007199254740993', createTime: '1788105600' };
const silk = () => Buffer.from('\x02#!SILK_V3\x01\x00\x00');
const required = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error('Expected the voice fixture to be available');
  return value;
};
function source(bytes: () => Buffer[] = () => [silk()]) {
  const query = vi.fn((sql: string) => {
    if (sql.startsWith('PRAGMA table_info("VoiceInfo")')) return ['chat_name_id', 'local_id', 'svr_id', 'create_time', 'voice_data'].map((name) => ({ name }));
    if (sql.startsWith('PRAGMA table_info("Name2Id")')) return [{ name: 'user_name' }];
    return bytes().map((voice_data) => ({ voice_data }));
  });
  return { id: 'media0', kind: 'voice' as const, db: { query } };
}

describe('account-scoped exact voice reads', () => {
  it('registers lazily and reads by account chat plus all message identity fields', () => {
    const database = source(); const store = new NativeWechatVoiceStore([database]);
    const ref = required(store.registerMessageVoice('wxid_fixture', identity));
    expect(database.db.query).not.toHaveBeenCalled();
    expect(ref.mediaKey).toMatch(/^media_[a-f0-9]{64}$/u);
    const result = required(store.readVoice(ref.mediaKey));
    expect(result.format).toBe('silk'); expect(result.bytes).toEqual(silk());
    expect(database.db.query).toHaveBeenLastCalledWith(expect.stringContaining('JOIN Name2Id'), ['wxid_fixture', '7', '9007199254740993', '1788105600', MAX_WECHAT_VOICE_BYTES]);
    expect(store.getVoiceRef(ref.mediaKey)?.status).toBe('ready');
  });

  it('does not fall back to a voice from a different chat or timestamp', () => {
    const database = source(() => []); const store = new NativeWechatVoiceStore([database]);
    const ref = required(store.registerMessageVoice('wxid_fixture', identity));
    expect(store.readVoice(ref.mediaKey)).toBeUndefined();
    expect(store.getVoiceRef(ref.mediaKey)?.status).toBe('missing');
    expect(database.db.query).toHaveBeenCalledTimes(3);
  });

  it('fails closed on conflicting duplicate records and clears owned audio', () => {
    const first = silk(), second = Buffer.concat([silk(), Buffer.from([5])]);
    const store = new NativeWechatVoiceStore([source(() => [first, second])]);
    const ref = required(store.registerMessageVoice('wxid_fixture', identity));
    expect(store.readVoice(ref.mediaKey)).toBeUndefined();
    expect(store.getVoiceRef(ref.mediaKey)?.status).toBe('unsupported');
    expect(first.every((byte) => byte === 0)).toBe(true); expect(second.every((byte) => byte === 0)).toBe(true);
  });

  it('treats exact duplicate shards as one voice and wipes duplicate bytes', () => {
    const duplicate = silk(); const store = new NativeWechatVoiceStore([source(), { ...source(() => [duplicate]), id: 'media1' }]);
    const ref = required(store.registerMessageVoice('wxid_fixture', identity));
    expect(store.readVoice(ref.mediaKey)?.bytes).toEqual(silk());
    expect(duplicate.every((byte) => byte === 0)).toBe(true);
  });

  it('does not query unsupported or nonvoice shards', () => {
    const query = vi.fn(() => []);
    const store = new NativeWechatVoiceStore([{ id: 'other', kind: 'message', db: { query } }]);
    const ref = required(store.registerMessageVoice('wxid_fixture', identity));
    expect(store.readVoice(ref.mediaKey)).toBeUndefined(); expect(query).not.toHaveBeenCalled();
  });

  it('rejects unknown aliases, invalid IDs and oversize blobs', () => {
    const bytes = Buffer.alloc(MAX_WECHAT_VOICE_BYTES + 1); silk().copy(bytes);
    const store = new NativeWechatVoiceStore([source(() => [bytes])]);
    expect(store.readVoice('media_bad')).toBeUndefined();
    expect(store.registerMessageVoice('wxid_fixture', { ...identity, serverId: '1 OR 1=1' })).toBeUndefined();
    expect(store.registerMessageVoice('wxid_fixture', { ...identity, localId: '0' })).toBeUndefined();
    const ref = required(store.registerMessageVoice('wxid_fixture', identity));
    expect(store.readVoice(ref.mediaKey)).toBeUndefined(); expect(bytes.every((byte) => byte === 0)).toBe(true);
  });

  it('resets media aliases between accounts and disposal', () => {
    const store = new NativeWechatVoiceStore([]); const other = new NativeWechatVoiceStore([]);
    const key = required(store.registerMessageVoice('fixture', identity)).mediaKey;
    expect(other.registerMessageVoice('fixture', identity)?.mediaKey).not.toBe(key);
    store.dispose(); expect(store.getVoiceRef(key)).toBeUndefined(); expect(store.registerMessageVoice('fixture', identity)).toBeUndefined();
  });

  it('contains no database error details in its public result', () => {
    const db: WechatMessageDatabase = { id: 'media0', kind: 'voice', db: { query: () => { throw new Error('secret/path'); } } };
    const store = new NativeWechatVoiceStore([db]); const ref = required(store.registerMessageVoice('fixture', identity));
    expect(store.readVoice(ref.mediaKey)).toBeUndefined(); expect(JSON.stringify(store.getVoiceRef(ref.mediaKey))).not.toContain('secret');
  });

  it('detects the two known SILK headers without treating generic bytes as voice', () => {
    expect(voiceFormat(silk())).toBe('silk'); expect(voiceFormat(Buffer.from('#!SILK_V3data'))).toBe('silk');
    expect(voiceFormat(Buffer.from('unknown'))).toBeUndefined();
  });
});
