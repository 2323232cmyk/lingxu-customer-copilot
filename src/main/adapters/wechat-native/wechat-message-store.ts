import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { constants as zlibConstants, zstdDecompressSync } from 'node:zlib';
import { compareWechatMessageOrder } from '../../../shared/wechat-message-order';
import {
  createContactKey,
  normalizeNativeConversations,
  normalizeNativeMessages,
  type NativeConversation,
  type NativeMessage,
} from './native-normalize';

export type WechatQueryValue = string | number | Buffer | null;
export type WechatQueryRow = Record<string, WechatQueryValue>;
export interface WechatQueryDatabase {
  query(sql: string, params: readonly WechatQueryValue[]): readonly WechatQueryRow[];
}
export interface WechatMessageDatabase {
  readonly id: string;
  readonly kind: 'session' | 'contact' | 'message' | 'resource' | 'avatar' | 'emoji' | 'voice';
  readonly db: WechatQueryDatabase;
}

const ERROR_MESSAGES = {
  'database.schema': '当前微信数据库结构尚不支持，不能确认读取结果。',
  'database.identity': '无法在联系人数据库中确认当前账号身份，已停止读取消息。',
  'database.direction': '无法确认消息发送者，已停止读取以避免混淆收发方向。',
  'database.content': '微信消息内容无法解码或超过安全大小限制。',
  'database.message': '微信消息标识或时间格式不受支持。',
  'database.pagination': '消息分页参数无效。',
  'database.scanLimit': '本次消息读取超过安全扫描范围，请减小分页范围。',
  'database.query': '微信数据库查询未完成，请稍后重试。',
} as const;

export class WechatMessageStoreError extends Error {
  readonly retryable: boolean;
  constructor(readonly code: keyof typeof ERROR_MESSAGES) {
    super(ERROR_MESSAGES[code]);
    this.name = 'WechatMessageStoreError';
    this.retryable = code === 'database.query';
  }
}

const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_SCAN_ROWS = 10_000;
const CONVERSATION_QUERY_PAGE_SIZE = 200;
const MESSAGE_COLUMNS = [
  'local_id', 'server_id', 'local_type', 'sort_seq',
  'real_sender_id', 'create_time', 'message_content',
] as const;
const utf8 = new TextDecoder('utf-8', { fatal: true });

function usernameOf(value: WechatQueryValue | undefined): string {
  if (typeof value !== 'string' || !value || value.trim() !== value
    || value.length > 512 || value.includes('\0')) throw new WechatMessageStoreError('database.schema');
  return value;
}

function integerOf(value: WechatQueryValue | undefined): bigint {
  if ((typeof value !== 'string' || !/^-?\d{1,20}$/u.test(value))
    && (typeof value !== 'number' || !Number.isSafeInteger(value))) {
    throw new WechatMessageStoreError('database.message');
  }
  const integer = BigInt(value as string | number);
  if (integer < -9223372036854775808n || integer > 9223372036854775807n) {
    throw new WechatMessageStoreError('database.message');
  }
  return integer;
}

function requireCompleteZstdFrame(value: Buffer): void {
  // RFC 8878 section 3.1.1: bound/check one frame's envelope only, not its codec.
  // Node's synchronous decoder can otherwise accept an incomplete frame as empty.
  if (value.length < 6 || (value[4] & 0x08)) throw new WechatMessageStoreError('database.content');
  const descriptor = value[4];
  const singleSegment = (descriptor & 0x20) !== 0;
  const contentSizeBytes = [singleSegment ? 1 : 0, 2, 4, 8][descriptor >>> 6];
  const dictionaryBytes = [0, 1, 2, 4][descriptor & 3];
  let position = 5 + (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
  while (position + 3 <= value.length) {
    const header = value.readUIntLE(position, 3);
    const type = (header >>> 1) & 3;
    const size = header >>> 3;
    if (type === 3 || size > 128 * 1024) throw new WechatMessageStoreError('database.content');
    position += 3 + (type === 1 ? 1 : size);
    if (position > value.length) break;
    if (header & 1) {
      if (position + ((descriptor & 4) ? 4 : 0) === value.length) return;
      break;
    }
  }
  throw new WechatMessageStoreError('database.content');
}

function messageText(value: WechatQueryValue | undefined): string {
  if (value === null) return '';
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > MAX_TEXT_BYTES) throw new WechatMessageStoreError('database.content');
    return value;
  }
  if (!Buffer.isBuffer(value) || value.length > MAX_TEXT_BYTES) {
    throw new WechatMessageStoreError('database.content');
  }
  let decoded: Buffer | undefined;
  try {
    // Standard Zstandard frame magic; do not strip guessed container headers.
    if (value.length >= 4 && value.readUInt32LE(0) === 0xfd2fb528) {
      requireCompleteZstdFrame(value);
      decoded = zstdDecompressSync(value, {
        maxOutputLength: MAX_TEXT_BYTES,
        params: { [zlibConstants.ZSTD_d_windowLogMax]: 23 },
      });
    }
    return utf8.decode(decoded ?? value);
  } catch {
    throw new WechatMessageStoreError('database.content');
  } finally {
    decoded?.fill(0);
  }
}

interface StoredMessage {
  readonly source: WechatMessageDatabase;
  readonly hasLocalNames: boolean;
  readonly localId: bigint;
  readonly serverId: bigint;
  readonly senderId: bigint | null;
  readonly timestamp: bigint;
  readonly sequence: bigint;
  readonly type: number;
  readonly content: WechatQueryValue;
  readonly packedInfo?: Buffer;
}

export interface WechatHistoryPosition {
  readonly timestamp: string;
  readonly sequence: string;
  readonly localId: string;
  readonly sourceId: string;
}

const compareDescending = (left: bigint, right: bigint): number => left > right ? -1 : left < right ? 1 : 0;
const isSystemMessage = (type: number): boolean => type === 10000 || type === 10002;

// Schema evidence (not upstream fallback/direction or cache implementations):
// SensLiao/Wechat-Archive-Analyzer@9dade2a68a66a33b779d083739732d195472f988 db_reader.py:60-75.
// fanyuantaier/wechatauto-replica@22ee7adf875414da5bb8984860565930ecb31d7a wechatauto/db.py:1049-1088,1224-1238,1484-1503.
export class WechatMessageStore {
  private readonly databases: readonly WechatMessageDatabase[];
  private readonly accountName: string;
  private readonly accountKey: string;
  private readonly registerMedia?: (username: string, type: number, xml: string, packedInfo?: Buffer) => Pick<NativeMessage, 'mediaKey' | 'mediaKind' | 'mediaStatus'> | undefined;
  private readonly registerAvatar?: (username: string) => string | undefined;
  private readonly registerVoice?: (username: string, identity: { localId: string; serverId: string; createTime: string }) => string | undefined;

  constructor(options: {
    readonly databases: readonly WechatMessageDatabase[];
    readonly accountName: string;
    readonly accountKey: string;
    readonly registerMedia?: (username: string, type: number, xml: string, packedInfo?: Buffer) => Pick<NativeMessage, 'mediaKey' | 'mediaKind' | 'mediaStatus'> | undefined;
    readonly registerAvatar?: (username: string) => string | undefined;
    readonly registerVoice?: (username: string, identity: { localId: string; serverId: string; createTime: string }) => string | undefined;
  }) {
    this.databases = [...options.databases];
    this.accountName = options.accountName;
    this.accountKey = options.accountKey;
    this.registerMedia = options.registerMedia;
    this.registerAvatar = options.registerAvatar;
    this.registerVoice = options.registerVoice;
    if (!this.accountName || !this.accountKey) throw new WechatMessageStoreError('database.identity');
    if (new Set(this.databases.map((source) => source.id)).size !== this.databases.length) {
      throw new WechatMessageStoreError('database.schema');
    }
    const contacts = this.ofKind('contact');
    if (!contacts.length) throw new WechatMessageStoreError('database.schema');
    let identityConfirmed = false;
    for (const source of contacts) {
      this.requireColumns(this.columns(source, 'contact'), ['username', 'nick_name', 'remark']);
      const rows = this.query(source, 'SELECT username FROM contact WHERE username = ? LIMIT 1', [this.accountName]);
      if (rows.some((row) => usernameOf(row.username) === this.accountName)) identityConfirmed = true;
    }
    if (!identityConfirmed) throw new WechatMessageStoreError('database.identity');
  }

  listConversations(): NativeConversation[] {
    const sources = this.ofKind('session');
    if (!sources.length) throw new WechatMessageStoreError('database.schema');
    const sessions: ({ username: string; sequence: bigint }
      & Pick<NativeConversation, 'lastMessageAt' | 'unreadCount' | 'preview'>)[] = [];
    for (const source of sources) {
      const columns = this.columns(source, 'SessionTable');
      this.requireColumns(columns, ['username']);
      const sort = columns.has('sort_timestamp') ? 'CAST(COALESCE(sort_timestamp, 0) AS TEXT)' : "'0'";
      const selected = ['username', `${sort} AS sequence`,
        ...(columns.has('unread_count') ? ['CAST(unread_count AS TEXT) AS unread_count'] : []),
        ...(columns.has('last_timestamp') ? ['CAST(last_timestamp AS TEXT) AS last_timestamp'] : []),
        ...(columns.has('summary') ? ["CASE WHEN typeof(summary) = 'text' THEN substr(summary, 1, 1024) ELSE summary END AS summary"] : []),
      ];
      let after: string | undefined;
      for (;;) {
        const conditions = columns.has('is_hidden') ? ['is_hidden = 0'] : [];
        if (after !== undefined) conditions.push('username > ? COLLATE BINARY');
        const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
        const rows = this.query(source,
          `SELECT ${selected.join(', ')} FROM SessionTable${where} ORDER BY username COLLATE BINARY LIMIT ?`,
          [...(after === undefined ? [] : [after]), CONVERSATION_QUERY_PAGE_SIZE]);
        if (rows.length > CONVERSATION_QUERY_PAGE_SIZE) throw new WechatMessageStoreError('database.schema');
        for (const row of rows) {
          const username = usernameOf(row.username);
          if (after !== undefined && Buffer.compare(Buffer.from(username), Buffer.from(after)) <= 0) {
            throw new WechatMessageStoreError('database.schema');
          }
          const metadata: Pick<NativeConversation, 'lastMessageAt' | 'unreadCount' | 'preview'> = {};
          try {
            if (columns.has('unread_count') && row.unread_count !== null) {
              const count = integerOf(row.unread_count);
              if (count < 0n || count > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Invalid unread count');
              Object.assign(metadata, { unreadCount: Number(count) });
            }
            if (columns.has('last_timestamp') && row.last_timestamp !== null) {
              // Evidenced SessionTable.last_timestamp uses Unix seconds; sort_timestamp is not a message date.
              const seconds = integerOf(row.last_timestamp);
              if (seconds >= 946684800n && seconds <= 4102444800n) {
                Object.assign(metadata, { lastMessageAt: new Date(Number(seconds) * 1000).toISOString() });
              }
            }
            if (columns.has('summary') && row.summary !== null) {
              if (typeof row.summary !== 'string') throw new Error('Unsupported session summary');
              Object.assign(metadata, { preview: row.summary.replaceAll('\0', '').trim().slice(0, 1024) });
            }
          } catch { throw new WechatMessageStoreError('database.schema'); }
          sessions.push({ username, sequence: integerOf(row.sequence), ...metadata });
          after = username;
        }
        if (rows.length < CONVERSATION_QUERY_PAGE_SIZE) break;
      }
    }
    sessions.sort((left, right) => compareDescending(left.sequence, right.sequence) || left.username.localeCompare(right.username));
    const usernames = [...new Set(sessions.map((session) => session.username))];
    const metadata = new Map<string, Pick<NativeConversation, 'lastMessageAt' | 'unreadCount' | 'preview'>>();
    for (const { username, lastMessageAt, unreadCount, preview } of sessions) {
      if (!metadata.has(username)) metadata.set(username, { lastMessageAt, unreadCount, preview });
    }
    if (!usernames.length) return [];
    const details = new Map<string, { nickname: string; remark: string }>();
    for (const source of this.ofKind('contact')) {
      for (let start = 0; start < usernames.length; start += CONVERSATION_QUERY_PAGE_SIZE) {
        const page = usernames.slice(start, start + CONVERSATION_QUERY_PAGE_SIZE);
        const placeholders = page.map(() => '?').join(',');
        for (const row of this.query(source,
          `SELECT username, nick_name, remark FROM contact WHERE username IN (${placeholders})`, page)) {
          if ((row.nick_name !== null && typeof row.nick_name !== 'string')
            || (row.remark !== null && typeof row.remark !== 'string')) throw new WechatMessageStoreError('database.schema');
          details.set(usernameOf(row.username), { nickname: row.nick_name as string ?? '', remark: row.remark as string ?? '' });
        }
      }
    }
    const result: NativeConversation[] = [];
    for (let start = 0; start < usernames.length; start += CONVERSATION_QUERY_PAGE_SIZE) {
      const page = usernames.slice(start, start + CONVERSATION_QUERY_PAGE_SIZE);
      result.push(...normalizeNativeConversations(page.map((username) => ({
        username, ...details.get(username), ...metadata.get(username),
      })), page.length));
    }
    return result;
  }

  readMessages(username: string, limit: number, offset = 0): NativeMessage[] {
    usernameOf(username);
    if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(offset) || offset < 0) {
      throw new WechatMessageStoreError('database.pagination');
    }
    const pageSize = Math.min(500, limit);
    const take = offset + pageSize;
    if (take > MAX_SCAN_ROWS) throw new WechatMessageStoreError('database.scanLimit');
    const sources = this.ofKind('message');
    if (!sources.length) throw new WechatMessageStoreError('database.schema');
    const table = `Msg_${createHash('md5').update(username, 'utf8').digest('hex')}`;
    const shards: { source: WechatMessageDatabase; hasLocalNames: boolean; hasPackedInfo: boolean }[] = [];
    for (const source of sources) {
      const names = this.columns(source, 'Name2Id');
      if (names.size) this.requireColumns(names, ['user_name']);
      const columns = this.columns(source, table);
      if (columns.size) {
        this.requireColumns(columns, MESSAGE_COLUMNS);
        shards.push({ source, hasLocalNames: names.size > 0, hasPackedInfo: columns.has('packed_info_data') });
      } else if (!names.size) {
        const other = this.query(source,
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'Msg_*' ORDER BY name LIMIT 1")[0]?.name;
        if (typeof other !== 'string' || !/^Msg_[a-f0-9]{32}$/iu.test(other)) {
          throw new WechatMessageStoreError('database.schema');
        }
        this.requireColumns(this.columns(source, other), MESSAGE_COLUMNS);
      }
    }
    // Reject an excessive worst-case scan before materializing any message rows.
    if (shards.length * take > MAX_SCAN_ROWS) throw new WechatMessageStoreError('database.scanLimit');
    const rows: StoredMessage[] = [];
    for (const shard of shards) {
      const selected = this.query(shard.source,
        `SELECT CAST(m.local_id AS TEXT) AS local_id, CAST(m.server_id AS TEXT) AS server_id, `
        + 'CAST(m.local_type AS TEXT) AS local_type, CAST(m.sort_seq AS TEXT) AS sort_seq, '
        + 'CAST(m.real_sender_id AS TEXT) AS real_sender_id, CAST(m.create_time AS TEXT) AS create_time, '
        + `m.message_content${shard.hasPackedInfo && this.registerMedia ? ', m.packed_info_data' : ''} FROM "${table}" AS m ORDER BY m.create_time DESC, m.sort_seq DESC, m.local_id DESC LIMIT ?`, [take]);
      if (selected.length > take) throw new WechatMessageStoreError('database.scanLimit');
      for (const row of selected) {
        const timestamp = integerOf(row.create_time);
        const localId = integerOf(row.local_id);
        if (timestamp < 946684800n || timestamp > 4102444800n || localId < 1n) {
          throw new WechatMessageStoreError('database.message');
        }
        const type = Number(integerOf(row.local_type) & 0xffffn);
        rows.push({
          ...shard, localId, timestamp,
          serverId: integerOf(row.server_id ?? 0),
          senderId: isSystemMessage(type) ? null : integerOf(row.real_sender_id),
          sequence: integerOf(row.sort_seq),
          type,
          content: row.message_content,
          ...(Buffer.isBuffer(row.packed_info_data) ? { packedInfo: row.packed_info_data } : {}),
        });
      }
    }
    rows.sort((left, right) => compareDescending(left.timestamp, right.timestamp)
      || compareDescending(left.sequence, right.sequence) || compareDescending(left.localId, right.localId)
      || left.source.id.localeCompare(right.source.id));
    const unique = new Map<string, StoredMessage>();
    for (const row of rows) {
      const identity = row.serverId !== 0n ? `server:${row.serverId}` : `local:${row.source.id}:${row.localId}:${row.timestamp}`;
      if (!unique.has(identity)) unique.set(identity, row);
    }
    const page = [...unique.values()].slice(offset, take);
    return this.normalizeStoredMessages(username, page);
  }

  /** Ascending keyset pagination; the 10k per-query bound does not cap total history. */
  readHistoryPage(username: string, limit: number, range: {
    readonly from: number; readonly to: number; readonly after?: WechatHistoryPosition;
  }): { messages: NativeMessage[]; done: boolean; after?: WechatHistoryPosition } {
    usernameOf(username);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || !Number.isSafeInteger(range.from)
      || !Number.isSafeInteger(range.to) || range.from < 946684800 || range.to > 4102444800 || range.from > range.to) {
      throw new WechatMessageStoreError('database.pagination');
    }
    const sources = this.ofKind('message');
    if (!sources.length) throw new WechatMessageStoreError('database.schema');
    const table = `Msg_${createHash('md5').update(username, 'utf8').digest('hex')}`;
    const shards = sources.flatMap((source) => {
      const names = this.columns(source, 'Name2Id');
      if (names.size) this.requireColumns(names, ['user_name']);
      const columns = this.columns(source, table);
      if (!columns.size) {
        if (!names.size) {
          const other = this.query(source,
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'Msg_*' ORDER BY name LIMIT 1")[0]?.name;
          if (typeof other !== 'string' || !/^Msg_[a-f0-9]{32}$/iu.test(other)) throw new WechatMessageStoreError('database.schema');
          this.requireColumns(this.columns(source, other), MESSAGE_COLUMNS);
        }
        return [];
      }
      this.requireColumns(columns, MESSAGE_COLUMNS);
      return [{ source, hasLocalNames: names.size > 0, hasPackedInfo: columns.has('packed_info_data') }];
    });
    const take = Math.min(limit, Math.floor(MAX_SCAN_ROWS / Math.max(1, shards.length)) - 1);
    if (take < 1) throw new WechatMessageStoreError('database.scanLimit');
    const after = range.after;
    if (after) {
      integerOf(after.timestamp); integerOf(after.sequence); integerOf(after.localId);
      if (!shards.some((shard) => shard.source.id === after.sourceId)) throw new WechatMessageStoreError('database.pagination');
    }
    const rows: StoredMessage[] = [];
    for (const shard of shards) {
      const params: WechatQueryValue[] = [range.from, range.to];
      let keyset = '';
      if (after) {
        // Include equal tuple only in shards sorted after the cursor's source.
        const compare = shard.source.id.localeCompare(after.sourceId) > 0 ? '>=' : '>';
        keyset = ` AND (m.create_time, m.sort_seq, m.local_id) ${compare} (CAST(? AS INTEGER), CAST(? AS INTEGER), CAST(? AS INTEGER))`;
        params.push(after.timestamp, after.sequence, after.localId);
      }
      params.push(take + 1);
      const selected = this.query(shard.source,
        'SELECT CAST(m.local_id AS TEXT) AS local_id, CAST(m.server_id AS TEXT) AS server_id, '
        + 'CAST(m.local_type AS TEXT) AS local_type, CAST(m.sort_seq AS TEXT) AS sort_seq, '
        + 'CAST(m.real_sender_id AS TEXT) AS real_sender_id, CAST(m.create_time AS TEXT) AS create_time, '
        + `m.message_content${shard.hasPackedInfo && this.registerMedia ? ', m.packed_info_data' : ''} FROM "${table}" AS m `
        + `WHERE m.create_time >= ? AND m.create_time <= ?${keyset} ORDER BY m.create_time ASC, m.sort_seq ASC, m.local_id ASC LIMIT ?`, params);
      if (selected.length > take + 1) throw new WechatMessageStoreError('database.scanLimit');
      for (const row of selected) {
        const timestamp = integerOf(row.create_time), localId = integerOf(row.local_id);
        if (timestamp < BigInt(range.from) || timestamp > BigInt(range.to) || localId < 1n) throw new WechatMessageStoreError('database.message');
        const type = Number(integerOf(row.local_type) & 0xffffn);
        rows.push({ ...shard, localId, timestamp, serverId: integerOf(row.server_id ?? 0),
          senderId: isSystemMessage(type) ? null : integerOf(row.real_sender_id), sequence: integerOf(row.sort_seq), type,
          content: row.message_content, ...(Buffer.isBuffer(row.packed_info_data) ? { packedInfo: row.packed_info_data } : {}) });
      }
    }
    rows.sort((left, right) => -compareDescending(left.timestamp, right.timestamp)
      || -compareDescending(left.sequence, right.sequence) || -compareDescending(left.localId, right.localId)
      || left.source.id.localeCompare(right.source.id));
    const page = rows.slice(0, take);
    const last = page.at(-1);
    const done = rows.length <= take;
    const unique = new Map<string, StoredMessage>();
    for (const row of page) {
      const identity = row.serverId !== 0n ? `server:${row.serverId}` : `local:${row.source.id}:${row.localId}:${row.timestamp}`;
      if (!unique.has(identity)) unique.set(identity, row);
    }
    return { messages: this.normalizeStoredMessages(username, [...unique.values()], true), done,
      ...(!done && last ? { after: { timestamp: String(last.timestamp), sequence: String(last.sequence), localId: String(last.localId), sourceId: last.source.id } } : {}) };
  }

  private normalizeStoredMessages(username: string, page: readonly StoredMessage[], fullText = false): NativeMessage[] {
    const senders = new Map<string, Map<string, string>>();
    const shards = [...new Map(page.map((row) => [row.source.id, { source: row.source, hasLocalNames: row.hasLocalNames }])).values()];
    for (const shard of shards) {
      const senderIds = [...new Set(page.filter((row) => row.source.id === shard.source.id && row.senderId !== null)
        .map((row) => String(row.senderId)))];
      if (senderIds.length) senders.set(shard.source.id, this.senderNames(shard.source, shard.hasLocalNames, senderIds));
    }
    // Resolve each actual sender once per page, including ourselves and group members.
    // Avatar/display-name enrichment is optional and never changes verified direction.
    const senderProfiles = new Map<string, { senderAvatarMediaKey?: string; senderDisplayName?: string }>();
    if (this.registerAvatar) {
      const usernames = [...new Set([...senders.values()].flatMap((mapping) => [...mapping.values()]))];
      for (const name of usernames) {
        let senderAvatarMediaKey: string | undefined;
        try { senderAvatarMediaKey = this.registerAvatar(name); } catch { /* Optional avatar unavailable. */ }
        senderProfiles.set(name, { ...(senderAvatarMediaKey ? { senderAvatarMediaKey } : {}),
          ...(name === this.accountName ? { senderDisplayName: '我' } : {}) });
      }
      for (const source of this.ofKind('contact')) {
        try {
          if (!usernames.length) continue;
          for (const row of this.query(source,
            `SELECT username, nick_name, remark FROM contact WHERE username IN (${usernames.map(() => '?').join(',')})`, usernames)) {
            if (typeof row.username !== 'string' || row.username === this.accountName || !senderProfiles.has(row.username)) continue;
            const label = typeof row.remark === 'string' && row.remark.trim() ? row.remark
              : typeof row.nick_name === 'string' ? row.nick_name : '';
            const profile = senderProfiles.get(row.username);
            if (profile && label.trim()) profile.senderDisplayName = label.replaceAll('\0', '').trim().slice(0, 256);
          }
        } catch { /* A missing profile must not hide an otherwise readable message. */ }
      }
    }
    const normalizedRows = page.map((row) => {
      const system = isSystemMessage(row.type);
      const sender = system ? undefined : senders.get(row.source.id)?.get(String(row.senderId));
      if (!system && !sender) throw new WechatMessageStoreError('database.direction');
      let media: Pick<NativeMessage, 'mediaKey' | 'mediaKind' | 'mediaStatus'> | undefined;
      if (this.registerMedia && [3, 47].includes(row.type)) {
        try { media = this.registerMedia(username, row.type, messageText(row.content), row.packedInfo); }
        catch { media = { mediaStatus: 'unsupported' }; }
      }
      let voiceMediaKey: string | undefined;
      if (row.type === 34 && this.registerVoice) {
        try { voiceMediaKey = this.registerVoice(username, { localId: String(row.localId), serverId: String(row.serverId), createTime: String(row.timestamp) }); }
        catch { /* Voice data is optional; never replace it with invented text. */ }
      }
      let content = '';
      if ([1, 10000, 10002].includes(row.type)) content = messageText(row.content);
      else if ([42, 48, 49].includes(row.type)) {
        try { content = messageText(row.content); } catch { /* Keep the app message as an unknown unsupported attachment. */ }
      }
      if (fullText && content.length > 64 * 1024) throw new WechatMessageStoreError('database.content');
      return {
        ...media,
        ...(sender ? senderProfiles.get(sender) : {}),
        ...(voiceMediaKey ? { voiceMediaKey } : {}),
        server_id: String(row.serverId),
        local_id: `${createHash('sha256').update(row.source.id).digest('hex')}:${row.localId}`,
        create_time: String(row.timestamp),
        sort_seq: String(row.sequence),
        local_type: row.type,
        ...(system ? {} : { computed_is_send: sender === this.accountName ? 1 : 0 }),
        message_content: content,
      };
    });
    const context = { username, accountKey: this.accountKey, contactKey: createContactKey(username) };
    const messages: NativeMessage[] = [];
    for (let start = 0; start < normalizedRows.length; start += 100) {
      messages.push(...normalizeNativeMessages(normalizedRows.slice(start, start + 100), context, 100, fullText ? 64 * 1024 : undefined));
    }
    if (messages.length !== page.length) throw new WechatMessageStoreError('database.message');
    return messages.sort((left, right) =>
      compareWechatMessageOrder(left.occurredAt, right.occurredAt, left.sortSequence, right.sortSequence));
  }

  private ofKind(kind: WechatMessageDatabase['kind']): readonly WechatMessageDatabase[] {
    return this.databases.filter((source) => source.kind === kind);
  }

  private query(source: WechatMessageDatabase, sql: string, params: readonly WechatQueryValue[] = []): readonly WechatQueryRow[] {
    try {
      return source.db.query(sql, params);
    } catch {
      // Do not propagate native SQL, paths, account identifiers, content or causes.
      throw new WechatMessageStoreError('database.query');
    }
  }

  private columns(source: WechatMessageDatabase, table: string): Set<string> {
    return new Set(this.query(source, `PRAGMA table_info("${table}")`).map((row) => {
      if (typeof row.name !== 'string') throw new WechatMessageStoreError('database.schema');
      return row.name.toLowerCase();
    }));
  }

  private requireColumns(columns: ReadonlySet<string>, required: readonly string[]): void {
    if (required.some((name) => !columns.has(name))) throw new WechatMessageStoreError('database.schema');
  }

  private senderNames(source: WechatMessageDatabase, hasLocalNames: boolean, senderIds: readonly string[]): Map<string, string> {
    const sources = hasLocalNames ? [source] : this.ofKind('resource').filter((resource) => {
      const columns = this.columns(resource, 'SenderName2Id');
      if (columns.size) this.requireColumns(columns, ['user_name']);
      return columns.size > 0;
    });
    const table = hasLocalNames ? 'Name2Id' : 'SenderName2Id';
    const names = new Map<string, string>();
    for (const mapping of sources) {
      const placeholders = senderIds.map(() => '?').join(',');
      for (const row of this.query(mapping,
        `SELECT CAST(rowid AS TEXT) AS sender_id, user_name FROM "${table}" WHERE rowid IN (${placeholders})`, senderIds)) {
        const id = String(integerOf(row.sender_id));
        const username = usernameOf(row.user_name);
        if (names.has(id) && names.get(id) !== username) throw new WechatMessageStoreError('database.direction');
        names.set(id, username);
      }
    }
    if (senderIds.some((id) => !names.has(id))) throw new WechatMessageStoreError('database.direction');
    return names;
  }
}
