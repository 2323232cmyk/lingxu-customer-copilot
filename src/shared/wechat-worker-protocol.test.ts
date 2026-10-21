import { describe, expect, it } from 'vitest';
import {
  createWechatWorkerRequest,
  isWechatEngineStartResult,
  isWechatWorkerIncomingMessage,
  isWechatWorkerRequest,
  unwrapWechatWorkerMessageEvent,
  WECHAT_WORKER_PROTOCOL_VERSION,
} from './wechat-worker-protocol';

const generation = 'generation-1';
const orderedMessage = {
  messageId: 'message-1', accountKey: 'account-1', contactKey: 'contact-1',
  direction: 'incoming', messageType: 'image', occurredAt: '2026-08-31T01:00:00.000Z',
  text: '[图片]', sortSequence: '9007199254740993',
  mediaKey: `media_${'a'.repeat(64)}`, mediaKind: 'image', mediaStatus: 'ready',
};
const snapshotResponse = (result: unknown) => ({
  protocolVersion: WECHAT_WORKER_PROTOCOL_VERSION, kind: 'response', generation,
  requestId: 'snapshot-1', ok: true, result,
});

describe('wechat worker protocol', () => {
  it('accepts only account-scoped voice offsets and bounded history date/cursor requests', () => {
    const voice = createWechatWorkerRequest(generation, 'voice-1', 'voice.read', {
      accountKey: 'account-1', mediaKey: `media_${'a'.repeat(64)}`, offset: 0,
    });
    expect(isWechatWorkerRequest(voice)).toBe(true);
    for (const patch of [{ offset: -1 }, { offset: 1 }, { offset: 4 * 1024 * 1024 },
      { mediaKey: 'C:\\synthetic\\audio.silk' }, { filename: 'audio.silk' }, { voiceData: 'private bytes' }]) {
      expect(isWechatWorkerRequest({ ...voice, payload: { ...voice.payload, ...patch } })).toBe(false);
    }
    const history = createWechatWorkerRequest(generation, 'history-1', 'messages.history', {
      accountKey: 'account-1', contactKey: 'contact-1', from: 946684800, to: 1893456000, limit: 200,
    });
    expect(isWechatWorkerRequest(history)).toBe(true);
    expect(isWechatWorkerRequest({ ...history, payload: { ...history.payload, cursor: 'history:synthetic' } })).toBe(true);
    for (const patch of [{ limit: 201 }, { from: 946684799 }, { to: 4102444801 }, { from: 1893456001 },
      { cursor: 'C:\\private\\message.db' }, { sql: 'SELECT *' }]) {
      expect(isWechatWorkerRequest({ ...history, payload: { ...history.payload, ...patch } })).toBe(false);
    }
  });

  it('validates explicit history completion and avatar/voice references instead of native paths', () => {
    const voice = { ...orderedMessage, messageType: 'voice', mediaKey: undefined, mediaKind: undefined,
      senderAvatarMediaKey: `media_${'b'.repeat(64)}`, senderDisplayName: '合成发送者', voiceMediaKey: `media_${'c'.repeat(64)}` };
    const result = { contactKey: 'contact-1', messages: [voice], done: false, nextCursor: 'history:synthetic' };
    expect(isWechatWorkerIncomingMessage(snapshotResponse(result))).toBe(true);
    expect(isWechatWorkerIncomingMessage(snapshotResponse({ ...result, done: true, nextCursor: undefined }))).toBe(true);
    for (const patch of [{ done: true }, { nextCursor: undefined }, { done: 'yes' }, { databasePath: 'private/path' }]) {
      expect(isWechatWorkerIncomingMessage(snapshotResponse({ ...result, ...patch }))).toBe(false);
    }
    for (const patch of [{ senderAvatarMediaKey: 'raw/avatar/path' }, { voiceMediaKey: 'raw/voice/path' },
      { senderDisplayName: 'x'.repeat(257) }, { messageType: 'text' }, { direction: 'system', messageType: 'system' }]) {
      expect(isWechatWorkerIncomingMessage(snapshotResponse({ ...result, messages: [{ ...voice, ...patch }] }))).toBe(false);
    }
    const account = { accountKey: 'a:synthetic', conversations: [], selfAvatarMediaKey: `media_${'d'.repeat(64)}` };
    expect(isWechatEngineStartResult(account)).toBe(true);
    expect(isWechatEngineStartResult({ ...account, selfAvatarMediaKey: 'C:\\private\\avatar.jpg' })).toBe(false);
  });
  it('preserves exact int64 sequence strings in delta messages and rejects malformed values', () => {
    const event = (sortSequence: unknown) => ({
      protocolVersion: WECHAT_WORKER_PROTOCOL_VERSION, kind: 'event', generation, sequence: 1,
      event: 'messages.delta', payload: {
        subscriptionId: 'subscription-1', batchId: 'batch-1', nextCursor: 'cursor-1',
        messages: [{ ...orderedMessage, sortSequence }],
      },
    });
    for (const sequence of [undefined, '0', '9007199254740993', '-9223372036854775808', '9223372036854775807']) {
      expect(isWechatWorkerIncomingMessage(event(sequence))).toBe(true);
    }
    for (const sequence of [null, 7, 9007199254740992, '1.5', '9223372036854775808', '-9223372036854775809', 'private/path']) {
      expect(isWechatWorkerIncomingMessage(event(sequence))).toBe(false);
    }
  });

  it('accepts a fully populated 500-message snapshot without loosening unrelated response limits', () => {
    const messages = Array.from({ length: 500 }, (_, index) => ({ ...orderedMessage, messageId: `message-${index}` }));
    expect(isWechatWorkerIncomingMessage(snapshotResponse({ contactKey: 'contact-1', cursor: 'cursor-1', messages }))).toBe(true);
    expect(isWechatWorkerIncomingMessage(snapshotResponse({ unrelated: messages }))).toBe(false);
    expect(isWechatWorkerIncomingMessage(snapshotResponse({
      contactKey: 'contact-1', messages: [...messages, { ...orderedMessage, messageId: 'message-500' }],
    }))).toBe(false);
  });

  it('strictly checks snapshot fields, message limits and nested values rather than falling back to generic validation', () => {
    const result = { contactKey: 'contact-1', cursor: 'cursor-1', messages: [orderedMessage] };
    expect(isWechatWorkerIncomingMessage(snapshotResponse({ contactKey: 'contact-1', messages: [] }))).toBe(true);
    for (const patch of [{ privatePath: 'C:\\synthetic-private\\message.db' }, { contactKey: 'private/path' },
      { cursor: '' }, { messages: undefined }, { messages: null }]) {
      expect(isWechatWorkerIncomingMessage(snapshotResponse({ ...result, ...patch }))).toBe(false);
    }
    expect(isWechatWorkerIncomingMessage(snapshotResponse({ messages: [orderedMessage] }))).toBe(false);
    for (const patch of [{ sortSequence: 9007199254740992 }, { sortSequence: '9223372036854775808' },
      { text: 'x'.repeat(64 * 1024 + 1) }, { privatePath: 'C:\\synthetic-private\\message.db' },
      { direction: 'unknown' }, { mediaKey: 'private-key' }, { mediaStatus: { nested: true } }]) {
      expect(isWechatWorkerIncomingMessage(snapshotResponse({ ...result, messages: [{ ...orderedMessage, ...patch }] }))).toBe(false);
    }
  });

  it('unwraps Electron utility-process MessageEvent data before request validation', () => {
    const request = createWechatWorkerRequest(
      generation,
      'request-event',
      'engine.start',
      { processIds: [10332, 10612] },
    );

    expect(unwrapWechatWorkerMessageEvent({ data: request, ports: [] })).toBe(request);
    expect(unwrapWechatWorkerMessageEvent(request)).toBe(request);
    expect(isWechatWorkerRequest(unwrapWechatWorkerMessageEvent({
      data: request,
      ports: [],
    }))).toBe(true);
    expect(() => createWechatWorkerRequest(
      generation,
      'request-duplicate-pids',
      'engine.start',
      { processIds: [10332, 10332] },
    )).toThrow('Invalid WeChat worker request');
  });

  it('accepts a bounded domain request and rejects path or PID smuggling', () => {
    const request = createWechatWorkerRequest(
      generation,
      'request-1',
      'messages.snapshot',
      { accountKey: 'account-1', contactKey: 'contact-1', limit: 100 },
    );

    expect(isWechatWorkerRequest(request)).toBe(true);
    expect(isWechatWorkerRequest({
      ...request,
      payload: {
        accountKey: 'account-1',
        contactKey: 'contact-1',
        limit: 100,
        databasePath: 'C:\\Users\\Public\\foreign.db',
      },
    })).toBe(false);
    expect(() => createWechatWorkerRequest(
      generation,
      'request-2',
      'account.connect',
      { accountKey: 'account-1', targetPid: 1234 },
    )).toThrow('Invalid WeChat worker request');

    expect(isWechatWorkerRequest(createWechatWorkerRequest(
      generation,
      'request-3',
      'stream.subscribe',
      { accountKey: 'account-1', contactKeys: ['contact-1', 'group-1@chatroom'] },
    ))).toBe(true);
    expect(() => createWechatWorkerRequest(
      generation,
      'request-4',
      'stream.subscribe',
      { accountKey: 'account-1', contactKeys: [] },
    )).toThrow('Invalid WeChat worker request');
  });

  it('strictly validates hello, response, and delta envelopes', () => {
    const hello = {
      protocolVersion: WECHAT_WORKER_PROTOCOL_VERSION,
      kind: 'hello',
      generation,
      engineVersion: '0.1.0',
      resourceFingerprint: 'a'.repeat(64),
      capabilities: ['engine.start', 'messages.snapshot'],
    };
    expect(isWechatWorkerIncomingMessage(hello)).toBe(true);
    expect(isWechatWorkerIncomingMessage({ ...hello, protocolVersion: 2 })).toBe(false);
    expect(isWechatWorkerIncomingMessage({ ...hello, extra: true })).toBe(false);

    expect(isWechatWorkerIncomingMessage({
      protocolVersion: WECHAT_WORKER_PROTOCOL_VERSION,
      kind: 'response',
      generation,
      requestId: 'request-1',
      ok: false,
      error: { code: 'account.offline', message: 'Account is offline', retryable: true },
    })).toBe(true);

    expect(isWechatWorkerIncomingMessage({
      protocolVersion: WECHAT_WORKER_PROTOCOL_VERSION,
      kind: 'event',
      generation,
      sequence: 1,
      event: 'engine.state',
      payload: { state: 'waiting-login', detailCode: 'wechat.login-required' },
    })).toBe(true);

    const delta = {
      protocolVersion: WECHAT_WORKER_PROTOCOL_VERSION,
      kind: 'event',
      generation,
      sequence: 1,
      event: 'messages.delta',
      payload: {
        subscriptionId: 'subscription-1',
        batchId: 'batch-1',
        nextCursor: 'cursor-2',
        messages: [{
          messageId: 'message-1',
          accountKey: 'account-1',
          contactKey: 'contact-1',
          direction: 'incoming',
          messageType: 'text',
          occurredAt: '2026-08-30T10:00:00+08:00',
          text: '你好',
        }],
      },
    };
    expect(isWechatWorkerIncomingMessage(delta)).toBe(true);
    expect(isWechatWorkerIncomingMessage({
      ...delta,
      payload: { ...delta.payload, messages: new Array(201).fill(delta.payload.messages[0]) },
    })).toBe(false);
  });

  it('bounds conversation page requests and accepts only safe real metadata fields', () => {
    const request = createWechatWorkerRequest(generation, 'list-1', 'conversations.list', {
      accountKey: 'a:synthetic', limit: 100, cursor: 'conversation-page:synthetic:100',
    });
    expect(isWechatWorkerRequest(request)).toBe(true);
    for (const limit of [0, -1, 201, 0.5, NaN]) {
      expect(isWechatWorkerRequest({ ...request, payload: { accountKey: 'a:synthetic', limit } })).toBe(false);
    }
    expect(isWechatWorkerRequest({ ...request, payload: { ...request.payload, cursor: 'C:\\private\\session.db' } })).toBe(false);
    const item = { contactKey: 'c:synthetic', displayName: '合成会话', kind: 'group',
      lastMessageAt: '2026-08-31T00:00:00.000Z', unreadCount: 0, preview: '合成摘要' };
    const result = { accountKey: 'a:synthetic', conversations: [item], nextConversationCursor: 'conversation-page:synthetic:1' };
    expect(isWechatEngineStartResult(result)).toBe(true);
    for (const patch of [{ unreadCount: -1 }, { unreadCount: 0.5 }, { lastMessageAt: 'unknown' },
      { preview: 'x'.repeat(1025) }, { username: 'wxid_private' }, { privatePath: 'C:\\private\\session.db' }]) {
      expect(isWechatEngineStartResult({ ...result, conversations: [{ ...item, ...patch }] })).toBe(false);
    }
    expect(isWechatEngineStartResult({ ...result, conversations: [] })).toBe(false);
    expect(isWechatEngineStartResult({ ...result, conversations: Array.from({ length: 201 }, (_, index) => ({ ...item, contactKey: `c:${index}` })) })).toBe(false);
  });

  it.each([
    ['incoming', 'text', true],
    ['outgoing', 'image', true],
    ['system', 'system', true],
    ['incoming', 'system', false],
    ['outgoing', 'system', false],
    ['system', 'text', false],
    ['system', 'other', false],
    ['unknown', 'text', false],
    [undefined, 'text', false],
  ] as const)('validates direction %s and message type %s without guessing a sender', (direction, messageType, accepted) => {
    expect(isWechatWorkerIncomingMessage({
      protocolVersion: WECHAT_WORKER_PROTOCOL_VERSION,
      kind: 'event',
      generation,
      sequence: 1,
      event: 'messages.delta',
      payload: {
        subscriptionId: 'subscription-1',
        batchId: 'batch-1',
        nextCursor: 'cursor-1',
        messages: [{
          messageId: 'message-1', accountKey: 'account-1', contactKey: 'contact-1',
          direction, messageType, occurredAt: '2026-08-30T10:00:00+08:00',
          text: '周六可以来，预算300万',
        }],
      },
    })).toBe(accepted);
  });

  it('rejects oversized and structurally ambiguous responses', () => {
    expect(isWechatEngineStartResult({
      accountKey: 'account-1',
      conversations: [{
        contactKey: 'contact-1',
        displayName: '林先生',
        remark: '杭州客户',
        kind: 'contact',
      }],
    })).toBe(true);
    expect(isWechatEngineStartResult({
      accountKey: 'account-1',
      conversations: [{ contactKey: 'contact-1', displayName: '林先生' }],
    })).toBe(false);

    expect(isWechatWorkerIncomingMessage({
      protocolVersion: WECHAT_WORKER_PROTOCOL_VERSION,
      kind: 'response',
      generation,
      requestId: 'request-1',
      ok: true,
      result: 'x'.repeat(64 * 1024 + 1),
    })).toBe(false);
    expect(isWechatWorkerIncomingMessage({
      protocolVersion: WECHAT_WORKER_PROTOCOL_VERSION,
      kind: 'response',
      generation,
      requestId: 'request-1',
      ok: true,
      result: {},
      error: { code: 'unexpected', message: 'must not coexist', retryable: false },
    })).toBe(false);
  });
});
