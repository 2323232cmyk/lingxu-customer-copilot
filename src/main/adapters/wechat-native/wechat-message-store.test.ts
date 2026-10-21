import { createHash } from 'node:crypto';
import { zstdCompressSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import {
  WechatMessageStore,
  WechatMessageStoreError,
  type WechatMessageDatabase,
  type WechatHistoryPosition,
  type WechatQueryRow,
  type WechatQueryValue,
} from './wechat-message-store';

const SELF = 'wxid_synthetic_self';
const CLIENT = 'wxid_synthetic_client';
const NOW = 1788105600;
const tableFor = (username: string) => `Msg_${createHash('md5').update(username).digest('hex')}`;
const MESSAGE_COLUMNS = ['local_id', 'server_id', 'local_type', 'sort_seq', 'real_sender_id', 'create_time', 'message_content'];
interface FixtureTable { columns: string[]; rows: WechatQueryRow[] }

// Only in-memory mock records are used. No SQLite engine, filesystem or WeChat is opened.
function fixtureDatabase(id: string, kind: WechatMessageDatabase['kind'], tables: Record<string, FixtureTable>) {
  const descending = (left: WechatQueryValue | undefined, right: WechatQueryValue | undefined) => {
    const a = BigInt(String(left ?? 0));
    const b = BigInt(String(right ?? 0));
    return a > b ? -1 : a < b ? 1 : 0;
  };
  const query = vi.fn((sql: string, params: readonly WechatQueryValue[] = []): readonly WechatQueryRow[] => {
    const metadata = /^PRAGMA table_info\("([^"]+)"\)$/u.exec(sql);
    if (metadata) return (tables[metadata[1]]?.columns ?? []).map((name) => ({ name }));
    if (sql.includes('FROM sqlite_master')) {
      return Object.keys(tables).filter((name) => name.startsWith('Msg_')).sort().slice(0, 1).map((name) => ({ name }));
    }
    if (sql.includes('FROM contact WHERE username = ?')) {
      return tables.contact.rows.filter((row) => row.username === params[0]).slice(0, 1).map((row) => ({ username: row.username }));
    }
    if (sql.includes('FROM contact WHERE username IN')) {
      return tables.contact.rows.filter((row) => params.includes(row.username));
    }
    if (sql.includes('FROM SessionTable')) {
      const after = typeof params[0] === 'string' ? params[0] : undefined;
      const limit = Number(params.at(-1) ?? 500);
      return tables.SessionTable.rows
        .filter((row) => !sql.includes('WHERE is_hidden = 0') || Number(row.is_hidden) === 0)
        .filter((row) => after === undefined || String(row.username) > after)
        .sort((a, b) => sql.includes('ORDER BY username')
          ? String(a.username).localeCompare(String(b.username)) : descending(a.sort_timestamp, b.sort_timestamp))
        .slice(0, limit)
        .map((row) => ({ ...row, username: row.username, sequence: String(row.sort_timestamp ?? 0) }));
    }
    const mapping = /FROM "(Name2Id|SenderName2Id)"/u.exec(sql);
    if (mapping) {
      return tables[mapping[1]].rows.filter((row) => params.includes(String(row.rowid)))
        .map((row) => ({ sender_id: String(row.rowid), user_name: row.user_name }));
    }
    const messageTable = /FROM "(Msg_[a-f0-9]{32})"/u.exec(sql);
    if (messageTable) {
      const ascending = sql.includes('ORDER BY m.create_time ASC');
      const compare = (a: WechatQueryRow, b: WechatQueryRow) => descending(a.create_time, b.create_time)
        || descending(a.sort_seq, b.sort_seq) || descending(a.local_id, b.local_id);
      return [...tables[messageTable[1]].rows]
        .filter((row) => !ascending || Number(row.create_time) >= Number(params[0]) && Number(row.create_time) <= Number(params[1]))
        .filter((row) => {
          if (!ascending || params.length < 6) return true;
          const direction = compare(row, { create_time: params[2], sort_seq: params[3], local_id: params[4] });
          return direction < 0 || direction === 0 && sql.includes('m.local_id) >=');
        })
        .sort((a, b) => ascending ? -compare(a, b) : compare(a, b))
        .slice(0, Number(ascending ? params.at(-1) : params[0]))
        .map((row) => Object.fromEntries(Object.entries(row)
          .filter(([name]) => name !== 'packed_info_data' || sql.includes('m.packed_info_data'))
          .map(([name, value]) => [name, ['message_content', 'packed_info_data'].includes(name) || value === null ? value : String(value)])));
    }
    throw new Error('Unsupported synthetic query');
  });
  return { id, kind, db: { query }, tables };
}

function contacts(rows: WechatQueryRow[] = [
  { username: SELF, nick_name: '同名演示', remark: null },
  { username: CLIENT, nick_name: '同名演示', remark: '模拟客户备注' },
]) {
  return fixtureDatabase('contact', 'contact', { contact: { columns: ['username', 'nick_name', 'remark'], rows } });
}

function sessions(rows: WechatQueryRow[] = [{ username: CLIENT, is_hidden: 0, sort_timestamp: NOW }]) {
  return fixtureDatabase('session', 'session', { SessionTable: { columns: ['username', 'is_hidden', 'sort_timestamp'], rows } });
}

function message(index: number, patch: WechatQueryRow = {}): WechatQueryRow {
  return {
    local_id: String(index), server_id: String(9007199254740992n + BigInt(index)),
    real_sender_id: '7', create_time: NOW + index, sort_seq: String(BigInt(NOW) * 1000n + BigInt(index)),
    local_type: '1', message_content: `模拟消息${index}`, ...patch,
  };
}

function messages(id: string, rows: WechatQueryRow[], names: WechatQueryRow[] | null = [
  { rowid: '7', user_name: SELF }, { rowid: '2', user_name: CLIENT },
], username = CLIENT) {
  return fixtureDatabase(id, 'message', {
    [tableFor(username)]: { columns: [...MESSAGE_COLUMNS], rows },
    ...(names === null ? {} : { Name2Id: { columns: ['user_name'], rows: names } }),
  });
}

function resources(id = 'resource', rows: WechatQueryRow[] = [{ rowid: '7', user_name: SELF }]) {
  return fixtureDatabase(id, 'resource', { SenderName2Id: { columns: ['user_name'], rows } });
}

function store(sources: readonly WechatMessageDatabase[], contact = contacts()) {
  return new WechatMessageStore({ databases: [contact, ...sources], accountName: SELF, accountKey: 'a:synthetic-account' });
}

function expectCode(action: () => unknown, code: WechatMessageStoreError['code']): void {
  try {
    action();
    expect.fail(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(WechatMessageStoreError);
    expect((error as WechatMessageStoreError).code).toBe(code);
  }
}

describe('message-store account identity and conversations', () => {
  it('exports over 10,000 records through bounded ascending keyset pages without a snapshot cap', () => {
    const source = messages('message0', Array.from({ length: 10_005 }, (_, index) => message(index + 1)));
    const reader = store([source]);
    const actual: string[] = [];
    let after: WechatHistoryPosition | undefined;
    for (let page = 0; page < 100; page += 1) {
      const result = reader.readHistoryPage(CLIENT, 200, { from: NOW, to: NOW + 20_000, after });
      expect(result.messages.length).toBeLessThanOrEqual(200);
      actual.push(...result.messages.map((item) => item.text ?? ''));
      if (result.done) break;
      expect(result.after).toBeDefined(); after = result.after;
    }
    expect(actual).toEqual(Array.from({ length: 10_005 }, (_, index) => `模拟消息${index + 1}`));
    const queries = source.db.query.mock.calls.filter(([sql]) => sql.includes('m.create_time ASC'));
    expect(queries).toHaveLength(51);
    expect(queries.every(([sql, params]) => sql.includes('LIMIT ?') && params?.at(-1) === 201 && !sql.includes('OFFSET'))).toBe(true);
    expect(queries[1][0]).toContain('(m.create_time, m.sort_seq, m.local_id) >');
  });

  it('does not skip same-time int64 tuples across message shards and respects the exact date range', () => {
    const first = messages('a-shard', [message(1, { create_time: NOW, sort_seq: '9007199254740993' }),
      message(2, { create_time: NOW, sort_seq: '9007199254740994' }), message(3, { create_time: NOW - 1 })]);
    const second = messages('z-shard', [message(1, { create_time: NOW, sort_seq: '9007199254740993', server_id: '77', message_content: '同时间的另一分片' }),
      message(4, { create_time: NOW + 1 })]);
    const reader = store([second, first]);
    const result: string[] = [];
    let after: WechatHistoryPosition | undefined;
    for (let index = 0; index < 5; index += 1) {
      const page = reader.readHistoryPage(CLIENT, 1, { from: NOW, to: NOW, after });
      result.push(...page.messages.map((item) => item.text ?? ''));
      if (page.done) break;
      after = page.after;
    }
    expect(result).toEqual(['模拟消息1', '同时间的另一分片', '模拟消息2']);
    expect(second.db.query.mock.calls.some(([sql]) => sql.includes('m.local_id) >='))).toBe(true);
  });

  it('advances a history cursor using raw rows even when replicas within a page deduplicate', () => {
    const reader = store([messages('a', [message(1), message(2), message(3)]), messages('z', [message(1), message(2)])]);
    const page = reader.readHistoryPage(CLIENT, 2, { from: NOW, to: NOW + 100 });
    expect(page.messages.map((item) => item.text)).toEqual(['模拟消息1']);
    expect(page).toMatchObject({ done: false, after: { sourceId: 'z', localId: '1' } });
    const next = reader.readHistoryPage(CLIENT, 2, { from: NOW, to: NOW + 100, after: page.after });
    expect(next.messages.map((item) => item.text)).toEqual(['模拟消息2']);
    const last = reader.readHistoryPage(CLIENT, 2, { from: NOW, to: NOW + 100, after: next.after });
    expect(last).toMatchObject({ done: true }); expect(last.messages.map((item) => item.text)).toEqual(['模拟消息3']);
  });

  it('exports full supported text and errors instead of silently cutting oversized records', () => {
    const text = '合成历史文字'.repeat(2000);
    const source = messages('history', [message(1, { message_content: text })]);
    const reader = store([source]);
    expect(reader.readMessages(CLIENT, 1)[0].text?.length).toBeLessThan(text.length);
    expect(reader.readHistoryPage(CLIENT, 100, { from: NOW, to: NOW + 100 }).messages[0].text).toBe(text);
    source.tables[tableFor(CLIENT)].rows = [message(1, { message_content: 'x'.repeat(64 * 1024 + 1) })];
    expectCode(() => reader.readHistoryPage(CLIENT, 100, { from: NOW, to: NOW + 100 }), 'database.content');
  });

  it('distinguishes a real empty history from unsupported schema or invalid cursors', () => {
    const reader = store([messages('history', [])]);
    expect(reader.readHistoryPage(CLIENT, 100, { from: NOW, to: NOW + 100 })).toEqual({ messages: [], done: true });
    expectCode(() => reader.readHistoryPage(CLIENT, 201, { from: NOW, to: NOW + 100 }), 'database.pagination');
    expectCode(() => reader.readHistoryPage(CLIENT, 1, { from: NOW + 2, to: NOW + 1 }), 'database.pagination');
    expectCode(() => reader.readHistoryPage(CLIENT, 1, { from: NOW, to: NOW + 100,
      after: { sourceId: 'missing', timestamp: String(NOW), sequence: '0', localId: '1' } }), 'database.pagination');
    const invalid = messages('history', []); invalid.tables[tableFor(CLIENT)].columns = ['message_content'];
    expectCode(() => store([invalid]).readHistoryPage(CLIENT, 100, { from: NOW, to: NOW + 100 }), 'database.schema');
  });

  it('skips a known unrelated history shard using the same legacy compatibility rule as snapshots', () => {
    const unrelated = messages('unrelated', [message(1)], null, 'synthetic-other');
    expect(store([unrelated]).readHistoryPage(CLIENT, 10, { from: NOW, to: NOW + 100 })).toEqual({ messages: [], done: true });
  });
  it('adds actual self and group-member avatars without leaking raw usernames', () => {
    const group = 'synthetic_group@chatroom';
    const source = messages('message0', [message(1), message(2, { real_sender_id: '2' })], undefined, group);
    const avatars = vi.fn((name: string) => `media_${(name === SELF ? 'a' : 'b').repeat(64)}`);
    const reader = new WechatMessageStore({ databases: [contacts(), source], accountName: SELF, accountKey: 'a:synthetic', registerAvatar: avatars });
    const result = reader.readMessages(group, 10);
    expect(result[0]).toMatchObject({ direction: 'outgoing', senderDisplayName: '我', senderAvatarMediaKey: `media_${'a'.repeat(64)}` });
    expect(result[1]).toMatchObject({ direction: 'incoming', senderDisplayName: '模拟客户备注', senderAvatarMediaKey: `media_${'b'.repeat(64)}` });
    expect(avatars).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result)).not.toContain(SELF);
    expect(JSON.stringify(result)).not.toContain(CLIENT);
  });

  it('registers the exact voice message identity and does not infer its words', () => {
    const source = messages('message0', [message(1, { local_type: 34, message_content: 'untrusted encoded voice' })]);
    const voice = vi.fn(() => `media_${'c'.repeat(64)}`);
    const reader = new WechatMessageStore({ databases: [contacts(), source], accountName: SELF, accountKey: 'a:synthetic', registerVoice: voice });
    const result = reader.readMessages(CLIENT, 10);
    expect(voice).toHaveBeenCalledWith(CLIENT, { localId: '1', serverId: '9007199254740993', createTime: String(NOW + 1) });
    expect(result[0]).toMatchObject({ messageType: 'voice', voiceMediaKey: `media_${'c'.repeat(64)}` });
    expect(result[0].text).toBeUndefined();
  });

  it('keeps readable text when optional avatar enrichment throws', () => {
    const source = messages('message0', [message(1)]);
    const reader = new WechatMessageStore({ databases: [contacts(), source], accountName: SELF, accountKey: 'a:synthetic', registerAvatar: () => { throw new Error('private/path'); } });
    const result = reader.readMessages(CLIENT, 10);
    expect(result[0].text).toBe('模拟消息1');
    expect(result[0].senderAvatarMediaKey).toBeUndefined();
  });

  it('requires an exact contact username, not a matching nickname', () => {
    expectCode(() => store([], contacts([{ username: CLIENT, nick_name: SELF, remark: SELF }])), 'database.identity');
  });

  it('does not accept an empty contact database as a confirmed account', () => {
    expectCode(() => store([], contacts([])), 'database.identity');
  });

  it('reports a missing contact database or unsupported contact schema', () => {
    expectCode(() => new WechatMessageStore({ databases: [], accountName: SELF, accountKey: 'a:test' }), 'database.schema');
    const contact = contacts();
    contact.tables.contact.columns = ['username', 'nickname'];
    expectCode(() => store([], contact), 'database.schema');
  });

  it('lists sessions with remarks, hides hidden sessions and preserves opaque contact IDs', () => {
    const source = sessions([
      { username: CLIENT, is_hidden: 0, sort_timestamp: NOW },
      { username: SELF, is_hidden: 1, sort_timestamp: NOW + 1 },
    ]);
    const result = store([source]).listConversations();
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ username: CLIENT, displayName: '模拟客户备注', remark: '模拟客户备注', kind: 'contact' });
    expect(result[0].contactKey).toBe(`c:${createHash('sha256').update(CLIENT).digest('hex')}`);
  });

  it('supports the evidenced minimum SessionTable.username schema', () => {
    const source = sessions([{ username: CLIENT }]);
    source.tables.SessionTable.columns = ['username'];
    expect(store([source]).listConversations()).toHaveLength(1);
  });

  it('returns [] only for a real empty session table', () => {
    expect(store([sessions([])]).listConversations()).toEqual([]);
    const unknown = fixtureDatabase('session', 'session', { OtherSession: { columns: ['username'], rows: [] } });
    expectCode(() => store([unknown]).listConversations(), 'database.schema');
    expectCode(() => store([]).listConversations(), 'database.schema');
  });

  it('lists more than 500 conversations using bounded metadata queries without reading message bodies', () => {
    const source = sessions(Array.from({ length: 601 }, (_, index) => ({
      username: `wxid_fixture_${String(index).padStart(4, '0')}`, is_hidden: 0, sort_timestamp: NOW - index,
    })));
    const result = store([source]).listConversations();
    expect(result).toHaveLength(601);
    expect(result[0].username).toBe('wxid_fixture_0000');
    expect(result[600].username).toBe('wxid_fixture_0600');
    const reads = source.db.query.mock.calls.filter(([sql]) => sql.includes('FROM SessionTable'));
    expect(reads).toHaveLength(4);
    expect(reads.every(([sql, params]) => sql.includes('LIMIT ?') && params?.at(-1) === 200)).toBe(true);
    expect(source.db.query.mock.calls.some(([sql]) => sql.includes('message_content') || sql.includes('FROM "Msg_'))).toBe(false);
  });

  it('deduplicates sessions and prefers the latest session order across sources', () => {
    const source1 = sessions([{ username: CLIENT, is_hidden: 0, sort_timestamp: 9 }]);
    const source2 = sessions([
      { username: SELF, is_hidden: 0, sort_timestamp: 10 },
      { username: CLIENT, is_hidden: 0, sort_timestamp: 8 },
    ]);
    source2.id = 'session-2';
    expect(store([source1, source2]).listConversations().map((row) => row.username)).toEqual([SELF, CLIENT]);
    expect(source1.db.query.mock.calls.some(([sql]) => sql.includes('ORDER BY username COLLATE BINARY'))).toBe(true);
  });

  it('uses real unread, summary and last-message seconds while keeping sort priority separate', () => {
    const source = sessions([
      { username: CLIENT, is_hidden: 0, sort_timestamp: '9007199254740993', unread_count: 4, last_timestamp: NOW, summary: '合成摘要'.repeat(400) },
      { username: SELF, is_hidden: 0, sort_timestamp: NOW + 1, unread_count: 0, last_timestamp: 0, summary: null },
    ]);
    source.tables.SessionTable.columns.push('unread_count', 'summary', 'last_timestamp');
    const result = store([source]).listConversations();
    expect(result.map((item) => item.username)).toEqual([CLIENT, SELF]);
    expect(result[0]).toMatchObject({ unreadCount: 4, lastMessageAt: new Date(NOW * 1000).toISOString() });
    expect(result[0].preview).toHaveLength(1024);
    expect(result[1]).toMatchObject({ unreadCount: 0 });
    expect(result[1]).not.toHaveProperty('lastMessageAt');
    expect(result[1]).not.toHaveProperty('preview');
    const query = source.db.query.mock.calls.find(([sql]) => sql.includes('FROM SessionTable'))?.[0] ?? '';
    expect(query).toContain('substr(summary, 1, 1024)');
    expect(query).not.toContain('message_content');
  });

  it('does not invent missing metadata and safely rejects unsupported metadata formats', () => {
    const minimal = store([sessions()]).listConversations()[0];
    expect(minimal).not.toHaveProperty('lastMessageAt');
    expect(minimal).not.toHaveProperty('preview');
    expect(minimal).not.toHaveProperty('unreadCount');
    for (const patch of [{ unread_count: -1 }, { unread_count: '1.5' }, { summary: Buffer.from('synthetic blob') }]) {
      const source = sessions([{ username: CLIENT, is_hidden: 0, sort_timestamp: NOW,
        unread_count: 1, summary: '合成摘要', last_timestamp: NOW, ...patch }]);
      source.tables.SessionTable.columns.push('unread_count', 'summary', 'last_timestamp');
      expectCode(() => store([source]).listConversations(), 'database.schema');
    }
  });

  it('redacts the original query exception and does not retain a cause', () => {
    const source = sessions();
    const reader = store([source]);
    source.db.query.mockImplementation(() => { throw new Error('synthetic-private-account chat payload secret=DO_NOT_FORWARD'); });
    try {
      reader.listConversations();
      expect.fail('Expected query failure');
    } catch (error) {
      expect(error).toBeInstanceOf(WechatMessageStoreError);
      expect(error).toMatchObject({ code: 'database.query', retryable: true });
      expect(String(error)).not.toContain('DO_NOT_FORWARD');
      expect(error).not.toHaveProperty('cause');
    }
  });
});

describe('global message pagination and exact identifiers', () => {
  it('selects the newest messages globally and returns the selected page chronologically', () => {
    const reader = store([messages('one', [message(1), message(3)]), messages('two', [message(2), message(4)])]);
    expect(reader.readMessages(CLIENT, 3).map((row) => row.text)).toEqual(['模拟消息2', '模拟消息3', '模拟消息4']);
    expect(reader.readMessages(CLIENT, 2, 2).map((row) => row.text)).toEqual(['模拟消息1', '模拟消息2']);
    expect(reader.readMessages(CLIENT, 2, 4)).toEqual([]);
  });

  it('orders large integer sort sequences and local IDs without Number rounding or lexical SQL aliases', () => {
    const one = messages('one', [message(1, { create_time: NOW, sort_seq: '9007199254740992', local_id: '9' })]);
    const two = messages('two', [message(2, { create_time: NOW, sort_seq: '9007199254740993', local_id: '10' })]);
    expect(store([one, two]).readMessages(CLIENT, 1)[0].text).toBe('模拟消息2');
    const ordered = store([two, one]).readMessages(CLIENT, 2);
    expect(ordered.map((row) => row.text)).toEqual(['模拟消息1', '模拟消息2']);
    expect(ordered.map((row) => row.sortSequence)).toEqual(['9007199254740992', '9007199254740993']);
    const sql = one.db.query.mock.calls.find(([query]) => query.includes('CAST(m.local_id AS TEXT)'))?.[0];
    expect(sql).toContain('CAST(m.server_id AS TEXT)');
    expect(sql).toContain('ORDER BY m.create_time DESC, m.sort_seq DESC, m.local_id DESC');
  });

  it('keeps same-second order across normalization chunks and message shards', () => {
    const rows = Array.from({ length: 201 }, (_, index) => message(index + 1, {
      create_time: NOW, sort_seq: String(9007199254740992n + BigInt(index)),
    }));
    const reader = store([
      messages('second', rows.filter((_row, index) => index % 2 === 1)),
      messages('first', rows.filter((_row, index) => index % 2 === 0)),
    ]);
    const result = reader.readMessages(CLIENT, 500);
    expect(result.map((row) => row.text)).toEqual(rows.map((row) => row.message_content));
    expect(result.map((row) => row.sortSequence)).toEqual(rows.map((row) => row.sort_seq));
    expect(reader.readMessages(CLIENT, 100, 100).map((row) => row.text))
      .toEqual(rows.slice(1, 101).map((row) => row.message_content));
  });

  it('hashes distinct 64-bit server IDs without losing precision or exposing identifiers', () => {
    const reader = store([messages('one', [message(1), message(2)])]);
    const result = reader.readMessages(CLIENT, 2);
    expect(result.map((row) => row.messageId)).toEqual([1n, 2n].map((index) =>
      `m:${createHash('sha256').update(`${CLIENT}:server:${9007199254740992n + index}`).digest('hex')}`));
    expect(new Set(result.map((row) => row.messageId)).size).toBe(2);
    expect(result.every((row) => row.accountKey === 'a:synthetic-account' && /^c:[0-9a-f]{64}$/u.test(row.contactKey))).toBe(true);
    expect(JSON.stringify(result)).not.toContain(CLIENT);
    expect(JSON.stringify(result)).not.toContain('9007199254740993');
  });

  it('deduplicates replicated server messages before applying the global offset', () => {
    const reader = store([
      messages('one', [message(1), message(3)]),
      messages('two', [message(2), message(3, { local_id: '31' })]),
    ]);
    expect(reader.readMessages(CLIENT, 2, 1).map((row) => row.text)).toEqual(['模拟消息1', '模拟消息2']);
  });

  it('does not collide local IDs from different shards when server IDs are absent', () => {
    const row = message(1, { server_id: null });
    const result = store([messages('one', [row]), messages('two', [{ ...row, message_content: '另一分库的模拟消息' }])])
      .readMessages(CLIENT, 10);
    expect(result).toHaveLength(2);
    expect(new Set(result.map((item) => item.messageId)).size).toBe(2);
  });

  it('supports 500 messages despite the existing normalizer limit of 100', () => {
    const rows = Array.from({ length: 510 }, (_unused, index) => message(index + 1));
    const result = store([messages('one', rows)]).readMessages(CLIENT, 900);
    expect(result).toHaveLength(500);
    expect(result[0].text).toBe('模拟消息11');
    expect(result[499].text).toBe('模拟消息510');
  });

  it('rejects a scan upper bound above 10000 before loading any message rows', () => {
    const shards = Array.from({ length: 21 }, (_unused, index) => messages(`shard-${index}`, [message(index + 1)]));
    const reader = store(shards);
    expectCode(() => reader.readMessages(CLIENT, 500), 'database.scanLimit');
    expect(shards.every((shard) => !shard.db.query.mock.calls.some(([sql]) => sql.includes('CAST(m.local_id AS TEXT)')))).toBe(true);
    expectCode(() => reader.readMessages(CLIENT, 2, 9999), 'database.scanLimit');
  });

  it.each([[0, 0], [-1, 0], [1.5, 0], [NaN, 0], [Infinity, 0], [10, -1], [10, 0.5]])('rejects invalid limit/offset %s/%s', (limit, offset) => {
      expectCode(() => store([messages('one', [])]).readMessages(CLIENT, limit, offset), 'database.pagination');
    });

  it('never inserts an arbitrary username into SQL text', () => {
    const unusualName = 'synthetic\'; DROP TABLE contact; --';
    const source = messages('one', [message(1)], undefined, unusualName);
    expect(store([source]).readMessages(unusualName, 1)).toHaveLength(1);
    expect(source.db.query.mock.calls.every(([sql]) => !sql.includes(unusualName))).toBe(true);
    expect(source.db.query.mock.calls.every(([sql]) => /^(?:SELECT|PRAGMA)\b/u.test(sql))).toBe(true);
  });
});

describe('per-shard sender identity and unsupported schema', () => {
  it('maps each shard separately, never treating sender number 2 or matching nicknames as self', () => {
    const result = store([
      messages('one', [message(1, { real_sender_id: '2' })]),
      messages('two', [message(2, { real_sender_id: '2' })], [{ rowid: '2', user_name: SELF }]),
    ]).readMessages(CLIENT, 10);
    expect(result.map((row) => row.direction)).toEqual(['incoming', 'outgoing']);
  });

  it('recognizes a group sender via a large Name2Id rowid, not the conversation name', () => {
    const group = 'synthetic-room@chatroom';
    const source = messages('one', [message(1, { real_sender_id: '9007199254740993' })],
      [{ rowid: '9007199254740993', user_name: 'wxid_synthetic_member' }], group);
    expect(store([source]).readMessages(group, 1)[0].direction).toBe('incoming');
  });

  it.each([10000, 10002])('preserves system type %s with a blank sender without querying its identity', (type) => {
    const source = messages('one', [
      message(1, { local_type: type, real_sender_id: '99', message_content: '合成系统提示' }),
      message(2, { real_sender_id: '2' }),
    ], [{ rowid: '99', user_name: '' }, { rowid: '2', user_name: CLIENT }]);
    const result = store([source]).readMessages(CLIENT, 2);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ messageType: 'system', direction: 'system', text: '合成系统提示' });
    expect(result[1].direction).toBe('incoming');
    const lookups = source.db.query.mock.calls.filter(([sql]) => sql.includes('FROM "Name2Id"'));
    expect(lookups).toHaveLength(1);
    expect(lookups[0][1]).toEqual(['2']);
  });

  it('reads a system-only page with no sender table or sender ID instead of dropping its rows', () => {
    const source = messages('one', [message(1, { local_type: 10000, real_sender_id: null })], null);
    const result = store([source]).readMessages(CLIENT, 1);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ direction: 'system', messageType: 'system' });
    expect(source.db.query.mock.calls.some(([sql]) => sql.includes('FROM "Name2Id"') || sql.includes('FROM "SenderName2Id"'))).toBe(false);
  });

  it('still rejects an ordinary participant message with a blank or absent sender', () => {
    expectCode(() => store([messages('one', [message(1)], [{ rowid: '7', user_name: '' }])])
      .readMessages(CLIENT, 1), 'database.schema');
    expectCode(() => store([messages('one', [message(1)], [])]).readMessages(CLIENT, 1), 'database.direction');
  });

  it('counts system rows in global cross-shard pagination so later messages cannot be skipped', () => {
    const reader = store([
      messages('one', [message(1), message(3, { local_type: 10000, real_sender_id: null })]),
      messages('two', [message(2, { local_type: 10002, real_sender_id: null }), message(4)]),
    ]);
    const newest = reader.readMessages(CLIENT, 2);
    const older = reader.readMessages(CLIENT, 2, 2);
    expect(newest.map((row) => row.text)).toEqual(['模拟消息3', '模拟消息4']);
    expect(older.map((row) => row.text)).toEqual(['模拟消息1', '模拟消息2']);
    expect(newest.map((row) => row.direction)).toEqual(['system', 'outgoing']);
    expect(older.map((row) => row.direction)).toEqual(['outgoing', 'system']);
    expect(new Set([...newest, ...older].map((row) => row.messageId)).size).toBe(4);
  });

  it('uses the evidenced resource mapping only when the shard has no Name2Id table', () => {
    expect(store([messages('one', [message(1)], null), resources()]).readMessages(CLIENT, 1)[0].direction).toBe('outgoing');
  });

  it('does not mask a missing local sender mapping by consulting the resource table', () => {
    const resource = resources();
    const reader = store([messages('one', [message(1)], []), resource]);
    expectCode(() => reader.readMessages(CLIENT, 1), 'database.direction');
    expect(resource.db.query).not.toHaveBeenCalled();
  });

  it('rejects missing or conflicting resource mappings', () => {
    expectCode(() => store([messages('one', [message(1)], null)]).readMessages(CLIENT, 1), 'database.direction');
    expectCode(() => store([
      messages('one', [message(1)], null), resources(), resources('resource-two', [{ rowid: '7', user_name: CLIENT }]),
    ]).readMessages(CLIENT, 1), 'database.direction');
  });

  it('returns [] for a genuine empty message table or absent conversation in an established schema', () => {
    expect(store([messages('one', [])]).readMessages(CLIENT, 1)).toEqual([]);
    const noConversation = messages('one', []);
    delete noConversation.tables[tableFor(CLIENT)];
    expect(store([noConversation]).readMessages(CLIENT, 1)).toEqual([]);
  });

  it('does not disguise a missing database or an unsupported schema as empty messages', () => {
    expectCode(() => store([]).readMessages(CLIENT, 1), 'database.schema');
    expectCode(() => store([fixtureDatabase('unknown', 'message', { MSG: { columns: ['StrContent'], rows: [] } })])
      .readMessages(CLIENT, 1), 'database.schema');
    const unknown = messages('one', []);
    unknown.tables[tableFor(CLIENT)].columns = ['message_content'];
    expectCode(() => store([unknown]).readMessages(CLIENT, 1), 'database.schema');
  });

  it('rejects an unknown Name2Id schema even when there are no messages', () => {
    const unknown = messages('one', []);
    unknown.tables.Name2Id.columns = ['nickname'];
    expectCode(() => store([unknown]).readMessages(CLIENT, 1), 'database.schema');
  });

  it.each<WechatQueryRow>([
    { create_time: '0' }, { create_time: 'not-time' }, { local_id: '0' },
    { server_id: '1.25' }, { server_id: '9223372036854775808' }, { sort_seq: 'NaN' },
  ])('rejects malformed message identifiers or timestamps instead of dropping the row', (patch) => {
    expectCode(() => store([messages('one', [message(1, patch)])]).readMessages(CLIENT, 1), 'database.message');
  });
});

describe('bounded message decoding and low-16-bit types', () => {
  it('reads plain UTF8 Buffer content and genuine Zstandard text', () => {
    const content = '这是合成的中文消息，支持换行\n以及 emoji 🏡';
    const compressed = zstdCompressSync(Buffer.from(content));
    const before = Buffer.from(compressed);
    const result = store([messages('one', [message(1, { message_content: Buffer.from(content) }), message(2, { message_content: compressed })])])
      .readMessages(CLIENT, 2);
    expect(result.map((row) => row.text)).toEqual([content, content]);
    expect(compressed).toEqual(before);
  });

  it('retains image and voice placeholders without attempting to decode their binary media', () => {
    const result = store([messages('one', [
      message(1, { local_type: String((7n << 16n) | 3n), message_content: Buffer.from([0xff]) }),
      message(2, { local_type: String((8n << 16n) | 34n), message_content: Buffer.from([0xff]) }),
    ])]).readMessages(CLIENT, 2);
    expect(result.map((row) => row.messageType)).toEqual(['image', 'voice']);
    expect(result.every((row) => row.text === undefined)).toBe(true);
  });

  it('normalizes wrapped text/system types through their low 16 bits', () => {
    const result = store([messages('one', [
      message(1, { local_type: String((1n << 40n) | 1n) }),
      message(2, { local_type: String((3n << 32n) | 10002n) }),
      message(3, { local_type: '49' }),
    ])]).readMessages(CLIENT, 3);
    expect(result.map((row) => row.messageType)).toEqual(['text', 'system', 'other']);
    expect(result[0].text).toBe('模拟消息1');
    expect(result[1].text).toBe('模拟消息2');
    expect(result[2].text).toBeUndefined();
  });

  it('shows file metadata while retaining attachment evidence without exposing raw XML', () => {
    const result = store([messages('one', [
      message(1, { local_type: '43', message_content: '' }),
      message(2, { local_type: '49', message_content: '<msg><appmsg><type>6</type><title>合成文件</title></appmsg></msg>' }),
      message(3, { local_type: '49', message_content: '<msg><appmsg><type>33</type></appmsg></msg>' }),
    ])]).readMessages(CLIENT, 3);

    expect(result.map((row) => row.attachmentKind)).toEqual(['video', 'file', 'unknown']);
    expect(result[1].text).toBe('[文件]\n合成文件');
    expect(result[0].text).toBeUndefined();
    expect(result[2].text).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('<appmsg>');
  });

  it.each([Buffer.from([0xff, 0xfe, 0x80]), Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00])])('rejects undecodable or corrupt compressed text %#', (content) => {
      expectCode(() => store([messages('one', [message(1, { message_content: content })])]).readMessages(CLIENT, 1), 'database.content');
    });

  it('rejects truncated frame tails and checksums rather than accepting partial text', () => {
    const compressed = zstdCompressSync(Buffer.from('合成的长消息'.repeat(1000)));
    for (const end of [4, 5, 7, compressed.length - 1]) {
      expectCode(() => store([messages('one', [message(1, { message_content: compressed.subarray(0, end) })])])
        .readMessages(CLIENT, 1), 'database.content');
    }
  });

  it('accepts a complete compressed empty text without mistaking it for a missing conversation', () => {
    const result = store([messages('one', [message(1, { message_content: zstdCompressSync(Buffer.alloc(0)) })])])
      .readMessages(CLIENT, 1);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBeUndefined();
  });

  it('bounds decompression to 1 MiB before the existing display-length truncation', () => {
    const content = zstdCompressSync(Buffer.alloc(1024 * 1024, 0x61));
    const result = store([messages('one', [message(1, { message_content: content })])]).readMessages(CLIENT, 1);
    expect(result[0].text).toHaveLength(8192);
    const oversized = zstdCompressSync(Buffer.alloc(1024 * 1024 + 1, 0x61));
    expectCode(() => store([messages('one', [message(1, { message_content: oversized })])]).readMessages(CLIENT, 1), 'database.content');
  });

  it('also rejects oversized uncompressed strings and buffers', () => {
    for (const content of ['a'.repeat(1024 * 1024 + 1), Buffer.alloc(1024 * 1024 + 1, 0x61)]) {
      expectCode(() => store([messages('one', [message(1, { message_content: content })])]).readMessages(CLIENT, 1), 'database.content');
    }
  });
});

describe('optional lazy media registration', () => {
  type RegisterMedia = NonNullable<ConstructorParameters<typeof WechatMessageStore>[0]['registerMedia']>;
  const imageKey = `media_${'a'.repeat(64)}`;
  const stickerKey = `media_${'b'.repeat(64)}`;
  const secret = 'c3'.repeat(16);
  const xml = `<msg><img md5="${'d4'.repeat(16)}" aeskey="${secret}" cdnurl="https://example.invalid/private-token"/></msg>`;
  const packed = Buffer.concat([Buffer.from([26, 34, 34, 32]), Buffer.from('e5'.repeat(16), 'ascii')]);
  const mediaStore = (source: WechatMessageDatabase, registerMedia: RegisterMedia) =>
    new WechatMessageStore({ databases: [contacts(), source], accountName: SELF, accountKey: 'a:synthetic-account', registerMedia });

  it('selects an available packed column and passes its complete Buffer with decoded XML and low-16-bit type', () => {
    const content = zstdCompressSync(Buffer.from(xml));
    const before = Buffer.from(packed);
    const source = messages('with-media', [message(1, {
      local_type: String((9n << 16n) | 3n), real_sender_id: '2', message_content: content, packed_info_data: packed,
    })]);
    source.tables[tableFor(CLIENT)].columns.push('packed_info_data');
    const registerMedia = vi.fn<RegisterMedia>(() => ({ mediaKey: imageKey, mediaKind: 'image', mediaStatus: 'pending' }));
    const result = mediaStore(source, registerMedia).readMessages(CLIENT, 10);
    expect(registerMedia).toHaveBeenCalledTimes(1);
    expect(registerMedia).toHaveBeenCalledWith(CLIENT, 3, xml, packed);
    expect(Buffer.isBuffer(registerMedia.mock.calls[0][3])).toBe(true);
    expect(registerMedia.mock.calls[0][3]).toBe(packed);
    expect(packed).toEqual(before);
    expect(result[0]).toMatchObject({ direction: 'incoming', messageType: 'image', mediaKey: imageKey, mediaKind: 'image', mediaStatus: 'pending' });
    expect(result[0]).not.toHaveProperty('text');
    expect(source.db.query.mock.calls.find(([sql]) => sql.includes('CAST(m.local_id AS TEXT)'))?.[0]).toContain('m.packed_info_data');
  });

  it('keeps older message schemas readable and supplies undefined when the optional column is absent', () => {
    const source = messages('without-media-column', [message(1, { local_type: 3, message_content: xml })]);
    const registerMedia = vi.fn(() => ({ mediaKey: imageKey, mediaStatus: 'pending' as const }));
    const result = mediaStore(source, registerMedia).readMessages(CLIENT, 1);
    expect(registerMedia).toHaveBeenCalledTimes(1);
    expect(registerMedia).toHaveBeenCalledWith(CLIENT, 3, xml, undefined);
    expect(result[0]).toMatchObject({ direction: 'outgoing', mediaKey: imageKey });
    expect(source.db.query.mock.calls.find(([sql]) => sql.includes('CAST(m.local_id AS TEXT)'))?.[0]).not.toContain('packed_info_data');
  });

  it('does not load packed media BLOBs when no media callback was enabled', () => {
    const source = messages('disabled-media', [message(1, { local_type: 3, message_content: xml, packed_info_data: packed })]);
    source.tables[tableFor(CLIENT)].columns.push('packed_info_data');
    const result = store([source]).readMessages(CLIENT, 1);
    expect(result[0]).toMatchObject({ direction: 'outgoing', messageType: 'image' });
    expect(result[0]).not.toHaveProperty('mediaKey');
    expect(result[0]).not.toHaveProperty('text');
    expect(source.db.query.mock.calls.find(([sql]) => sql.includes('CAST(m.local_id AS TEXT)'))?.[0]).not.toContain('packed_info_data');
  });

  it('preserves every message and its direction when media registration throws', () => {
    const source = messages('media-failure', [
      message(1, { local_type: 3, real_sender_id: '2', message_content: xml }),
      message(2, { local_type: 47, message_content: xml.replaceAll('img', 'emoji') }),
      message(3, { real_sender_id: '2', message_content: '正常文字继续读取' }),
      message(4, { local_type: 10000, real_sender_id: null, message_content: '合成系统提示' }),
    ]);
    const registerMedia = vi.fn(() => { throw new Error(`PRIVATE_MEDIA_PATH ${secret}`); });
    const result = mediaStore(source, registerMedia).readMessages(CLIENT, 4);
    expect(registerMedia).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(4);
    expect(new Set(result.map((item) => item.messageId)).size).toBe(4);
    expect(result.map((item) => item.direction)).toEqual(['incoming', 'outgoing', 'incoming', 'system']);
    expect(result.slice(0, 2).map((item) => item.mediaStatus)).toEqual(['unsupported', 'unsupported']);
    expect(result[2].text).toBe('正常文字继续读取');
    expect(result[3].text).toBe('合成系统提示');
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_MEDIA_PATH');
  });

  it('keeps an image row and following text when its optional XML cannot be decoded', () => {
    const source = messages('bad-media-xml', [
      message(1, { local_type: 3, real_sender_id: '2', message_content: Buffer.from([0xff, 0xfe, 0x80]) }),
      message(2, { message_content: '合成正常文字' }),
    ]);
    const registerMedia = vi.fn(() => undefined);
    const result = mediaStore(source, registerMedia).readMessages(CLIENT, 2);
    expect(registerMedia).not.toHaveBeenCalled();
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ direction: 'incoming', messageType: 'image', mediaStatus: 'unsupported' });
    expect(result[1]).toMatchObject({ direction: 'outgoing', text: '合成正常文字' });
  });

  it('forwards only opaque media fields, never callback extras, XML, keys, paths or Buffers', () => {
    const source = messages('private-media', [message(1, { local_type: 47, real_sender_id: '2', message_content: xml.replaceAll('img', 'emoji') })]);
    const registerMedia = vi.fn(() => ({
      mediaKey: stickerKey, mediaKind: 'sticker' as const, mediaStatus: 'ready' as const,
      message_content: xml, text: xml, aeskey: secret, packed_info_data: packed,
      imagePath: 'C:\\synthetic-private\\image.dat', url: 'https://example.invalid/private-token', computed_is_send: 1,
    }));
    const result = mediaStore(source, registerMedia).readMessages(CLIENT, 1)[0];
    expect(result).toMatchObject({ direction: 'incoming', messageType: 'other', mediaKey: stickerKey, mediaKind: 'sticker', mediaStatus: 'ready' });
    expect(Object.keys(result).sort()).toEqual([
      'accountKey', 'contactKey', 'direction', 'mediaKey', 'mediaKind', 'mediaStatus', 'messageId', 'messageType', 'occurredAt', 'sortSequence',
    ].sort());
    expect(Object.values(result).some(Buffer.isBuffer)).toBe(false);
    for (const privateValue of [secret, 'aeskey', 'private-token', 'synthetic-private', '<msg>']) {
      expect(JSON.stringify(result)).not.toContain(privateValue);
    }
  });

  it('rejects a callback path masquerading as an opaque media key', () => {
    const source = messages('invalid-media-key', [message(1, { local_type: 3, message_content: xml })]);
    const registerMedia = vi.fn(() => ({ mediaKey: 'C:\\synthetic-private\\image.dat', mediaStatus: 'ready' as const }));
    const result = mediaStore(source, registerMedia).readMessages(CLIENT, 1)[0];
    expect(result).not.toHaveProperty('mediaKey');
    expect(result).toMatchObject({ direction: 'outgoing', messageType: 'image' });
    expect(JSON.stringify(result)).not.toContain('synthetic-private');
  });
});
