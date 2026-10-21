import { describe, expect, it } from 'vitest';
import {
  createAccountKey,
  normalizeNativeConversations,
  normalizeNativeMessages,
  normalizeWechatAccountName,
  parseWechatTasklistPids,
} from './native-normalize';

describe('native WeChat normalization', () => {
  it.each(['weixin', 'filehelper', 'fmessage', 'brandsessionholder', 'notifymessage'])(
    'classifies the exact built-in account %s as a service, never a customer', (username) => {
    expect(normalizeNativeConversations([{ username, nickname: '合成服务消息' }])[0].kind).toBe('other');
  });

  it('keeps a person with a service-like nickname and a group with a service-like prefix', () => {
    const rows = normalizeNativeConversations([
      { username: 'wxid_human', nickname: '微信团队' },
      { username: 'my_filehelper', nickname: '文件传输助手' },
      { username: 'gh_group@chatroom', nickname: '公司群' },
      { username: 'gh_synthetic', nickname: '合成公众号' },
    ]);
    expect(rows.map((row) => row.kind)).toEqual(['contact', 'contact', 'group', 'official']);
  });

  it('uses the account identity without the local directory suffix for message direction', () => {
    expect(normalizeWechatAccountName('wxid_example_ab12')).toBe('wxid_example');
    expect(normalizeWechatAccountName('seller_name_X1y2')).toBe('seller_name');
    expect(normalizeWechatAccountName('seller_fullname')).toBe('seller_fullname');
    expect(normalizeWechatAccountName(' seller ')).toBe('seller');
    expect(normalizeWechatAccountName('')).toBe('');
  });

  it('extracts only WeChat process IDs from unfiltered tasklist CSV', () => {
    expect(parseWechatTasklistPids([
      '"System","4","Services","0","1 K"',
      '"Weixin.exe","10332","Console","1","20 K"',
      '"WeChat.exe","2048","Console","1","20 K"',
      '"Other.exe","4096","Console","1","20 K"',
      '"Weixin.exe","10332","Console","1","20 K"',
    ].join('\r\n'))).toEqual([10332, 2048]);
  });

  it('keeps raw usernames behind opaque contact keys', () => {
    const conversations = normalizeNativeConversations([{
      user_name: 'wxid_private@chatroom',
      nickname: '  测试会话  ',
      remark_name: '备注',
    }]);

    expect(conversations).toHaveLength(1);
    expect(conversations[0]).toMatchObject({
      displayName: '备注',
      remark: '备注',
      kind: 'group',
    });
    expect(conversations[0].contactKey).toMatch(/^c:[a-f0-9]{64}$/u);
    expect(conversations[0].contactKey).not.toContain('wxid_private');
  });

  it('normalizes direction, type, time and stable deduplication', () => {
    const accountKey = createAccountKey('D:\\wechat\\account');
    const context = {
      accountKey,
      contactKey: 'c:contact',
      username: 'wxid_private',
    };
    const messages = normalizeNativeMessages([
      {
        server_id: '42',
        local_id: '1',
        create_time: 1_788_067_200,
        local_type: 1,
        is_send: 0,
        message_content: '你好',
      },
      {
        serverId: '42',
        localId: '99',
        createTime: 1_788_067_200,
        messageType: 1,
        computedIsSend: false,
        messageContent: '重复',
      },
      {
        localId: '2',
        createTime: 1_788_067_201_000,
        messageType: 34,
        mesDes: 0,
        messageContent: '语音数据',
      },
      {
        localId: '2',
        createTime: 1_788_067_201_000,
        messageType: 34,
        mesDes: 0,
        messageContent: '来自另一分片的重复行',
      },
    ], context, 100);

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      direction: 'incoming',
      messageType: 'text',
      text: '你好',
    });
    expect(messages[1]).toMatchObject({
      direction: 'outgoing',
      messageType: 'voice',
    });
    expect(messages[1]).not.toHaveProperty('text');
    expect(messages.every((message) => /^m:[a-f0-9]{64}$/u.test(message.messageId))).toBe(true);
  });

  it('marks native video, file and generic app messages as unsupported attachments', () => {
    const context = { accountKey: 'a:synthetic', contactKey: 'c:synthetic', username: 'synthetic-peer' };
    const row = { create_time: 1_788_067_200, is_send: 0 };
    const messages = normalizeNativeMessages([
      { ...row, local_id: 'video', local_type: 43 },
      { ...row, local_id: 'file', local_type: 49, message_content: '<msg><appmsg><type>6</type></appmsg></msg>' },
      { ...row, local_id: 'app', local_type: 49, message_content: '<msg><appmsg><type>33</type></appmsg></msg>' },
    ], context);

    expect(messages.map((message) => message.attachmentKind)).toEqual(['video', 'file', 'unknown']);
    expect(messages.every((message) => message.messageType === 'other')).toBe(true);
    expect(messages.every((message) => message.text === undefined)).toBe(true);
  });

  it('preserves bounded session metadata without inventing missing fields', () => {
    const [known, unknown] = normalizeNativeConversations([
      { username: 'synthetic_group@chatroom', nickname: '合成群', unreadCount: 0,
        lastMessageAt: '2026-08-31T00:00:00.000Z', preview: '合成摘要'.repeat(400) },
      { username: 'gh_synthetic', nickname: '合成公众号' },
    ]);
    expect(known).toMatchObject({ kind: 'group', unreadCount: 0, lastMessageAt: '2026-08-31T00:00:00.000Z' });
    expect(known.preview).toHaveLength(1024);
    expect(unknown.kind).toBe('official');
    expect(unknown).not.toHaveProperty('unreadCount');
    expect(unknown).not.toHaveProperty('lastMessageAt');
    expect(unknown).not.toHaveProperty('preview');
  });

  it('retains exact source sequences and uses them to order messages within the same second', () => {
    const context = { accountKey: 'a:synthetic', contactKey: 'c:synthetic', username: 'synthetic-peer' };
    const row = { create_time: 1_788_067_200, local_type: 1, is_send: 0 };
    const normalized = normalizeNativeMessages([
      { ...row, local_id: 'newer', sort_seq: '9007199254740993', message_content: '后发送' },
      { ...row, local_id: 'older', sort_seq: 9007199254740992n, message_content: '先发送' },
      { ...row, local_id: 'first', sortSequence: 7, message_content: '最早发送' },
    ], context);
    expect(normalized.map((message) => message.text)).toEqual(['最早发送', '先发送', '后发送']);
    expect(normalized.map((message) => message.sortSequence)).toEqual(['7', '9007199254740992', '9007199254740993']);
  });

  it('keeps original order for legacy same-time rows and rejects lossy or malformed sequence values', () => {
    const context = { accountKey: 'a:synthetic', contactKey: 'c:synthetic', username: 'synthetic-peer' };
    const row = { create_time: 1_788_067_200, local_type: 1, is_send: 0 };
    const rows = ['first', 'second'].map((text) => ({ ...row, local_id: text, message_content: text }));
    const normalized = normalizeNativeMessages(rows, context);
    expect(normalized.map((message) => message.text)).toEqual(['first', 'second']);
    expect(normalized.every((message) => message.sortSequence === undefined)).toBe(true);
    for (const sort_seq of [9007199254740992, '9223372036854775808', '-9223372036854775809',
      1.5, '1e4', {}, 'C:\\synthetic-private\\message.db key=DO_NOT_FORWARD']) {
      expect(normalizeNativeMessages([{ ...row, local_id: 'invalid', sort_seq }], context)).toEqual([]);
    }
  });

  it('drops messages whose direction or timestamp is ambiguous and caps output', () => {
    const context = {
      accountKey: 'a:account',
      contactKey: 'c:contact',
      username: 'wxid_private',
    };
    const rows = [
      { create_time: 1_788_067_200, local_type: 1, message_content: 'missing direction' },
      { is_send: 0, local_type: 1, message_content: 'missing timestamp' },
      ...Array.from({ length: 120 }, (_, index) => ({
        local_id: String(index),
        create_time: 1_788_067_200 + index,
        local_type: 1,
        is_send: 0,
        message_content: `message-${index}`,
      })),
    ];

    const messages = normalizeNativeMessages(rows, context, 500);
    expect(messages).toHaveLength(100);
    expect(messages[0].text).toBe('message-20');
  });

  it.each([10000, 10002])('keeps system type %s without attributing it to either participant', (type) => {
    const context = { accountKey: 'a:synthetic', contactKey: 'c:synthetic', username: 'synthetic-peer' };
    const messages = normalizeNativeMessages([
      { local_id: '1', create_time: 1_788_067_200, local_type: type, message_content: '合成系统提示' },
      { local_id: '2', create_time: 1_788_067_201, local_type: type, computed_is_send: 1, message_content: '另一条合成系统提示' },
      { local_id: '3', create_time: 1_788_067_202, local_type: 1, message_content: '缺少可靠发言人的普通消息' },
    ], context);

    expect(messages).toHaveLength(2);
    expect(messages.every((item) => item.direction === 'system' && item.messageType === 'system')).toBe(true);
    expect(messages.map((item) => item.text)).toEqual(['合成系统提示', '另一条合成系统提示']);
  });
});
