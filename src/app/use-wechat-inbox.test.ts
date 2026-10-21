import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SalesCopilotBridge, WechatLiveConversation, WechatLiveDelta, WechatLiveMessage, WechatLiveSnapshot, WechatMessagesResult } from '../shared/contracts';
import { useWechatInbox } from './use-wechat-inbox';

type HookSlot = { value?: unknown; deps?: readonly unknown[]; effect?: () => void | (() => void); cleanup?: () => void };
const hooks = vi.hoisted(() => ({ index: 0, dirty: false, slots: [] as HookSlot[], effects: new Set<number>() }));
vi.mock('react', () => {
  const same = (left: readonly unknown[] | undefined, right: readonly unknown[] | undefined) =>
    left !== undefined && right !== undefined && left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
  return {
    useState: (initial: unknown) => {
      const index = hooks.index++;
      hooks.slots[index] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [hooks.slots[index].value, (next: unknown) => {
        const value = typeof next === 'function' ? next(hooks.slots[index].value) : next;
        if (!Object.is(value, hooks.slots[index].value)) { hooks.slots[index].value = value; hooks.dirty = true; }
      }];
    },
    useRef: (initial: unknown) => {
      const index = hooks.index++;
      hooks.slots[index] ??= { value: { current: initial } };
      return hooks.slots[index].value;
    },
    useCallback: (callback: unknown, deps: readonly unknown[]) => {
      const index = hooks.index++;
      if (!same(hooks.slots[index]?.deps, deps)) hooks.slots[index] = { value: callback, deps };
      return hooks.slots[index].value;
    },
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
      const index = hooks.index++, previous = hooks.slots[index];
      if (!same(previous?.deps, deps)) {
        hooks.slots[index] = { ...previous, effect, deps };
        hooks.effects.add(index);
      }
    },
  };
});

// Deterministic hook lifecycle/IPC fixture, not a browser or a real WeChat session.
let inbox: ReturnType<typeof useWechatInbox>;
function render() {
  hooks.index = 0; hooks.dirty = false;
  inbox = useWechatInbox();
  const effects = [...hooks.effects]; hooks.effects.clear();
  for (const index of effects) {
    const slot = hooks.slots[index]; slot.cleanup?.(); slot.cleanup = slot.effect?.() || undefined;
  }
  return inbox;
}
async function settle() {
  for (let index = 0; index < 32; index += 1) { await Promise.resolve(); if (hooks.dirty) render(); }
  return inbox;
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}
const first: WechatLiveConversation = { contactKey: 'contact-1', displayName: '合成客户一', kind: 'contact', unreadCount: 3 };
const second: WechatLiveConversation = { contactKey: 'contact-2', displayName: '合成群聊', kind: 'group' };
const snapshot: WechatLiveSnapshot = { revision: 1, accountKey: 'account-synthetic', conversations: [first, second],
  status: { state: 'ready', monitoring: false, detail: '合成状态', updatedAt: '2026-08-31T00:00:00.000Z' } };
const message = (contactKey = first.contactKey, id = 'one'): WechatLiveMessage => ({
  id, contactKey, direction: 'incoming', sender: '合成客户', text: `合成消息${id}`, messageType: 'text',
  sentAt: '2026-08-31T00:01:00.000Z', observedAt: '2026-08-31T00:01:01.000Z',
});
const success = (contactKey = first.contactKey, id = 'one'): WechatMessagesResult => ({ ok: true, contactKey, messages: [message(contactKey, id)] });
function install(overrides: Partial<SalesCopilotBridge> = {}) {
  let listener: ((delta: WechatLiveDelta) => void) | undefined;
  const bridge = {
    getRuntimeStatus: vi.fn().mockResolvedValue({ version: 'synthetic', sources: [], mode: 'manual-assist' }),
    getWechatSnapshot: vi.fn().mockResolvedValue(snapshot),
    getWechatConversations: vi.fn().mockResolvedValue({ ok: true, snapshot }),
    getWechatMessages: vi.fn().mockImplementation(async (contactKey: string) => success(contactKey)),
    watchWechatConversation: vi.fn().mockResolvedValue(undefined),
    unwatchWechatConversation: vi.fn().mockResolvedValue(undefined),
    startWechatLive: vi.fn().mockResolvedValue({ ok: true, snapshot }),
    stopWechatLive: vi.fn().mockResolvedValue({ ...snapshot, accountKey: undefined, conversations: [], status: { ...snapshot.status, state: 'stopped' } }),
    selectWechatAccountRoot: vi.fn().mockResolvedValue({ ok: true }),
    onWechatDelta: vi.fn().mockImplementation((next: (delta: WechatLiveDelta) => void) => { listener = next; return () => { listener = undefined; }; }),
    ...overrides,
  };
  vi.stubGlobal('window', { salesCopilot: bridge, setInterval, clearInterval });
  vi.stubGlobal('document', { hidden: false });
  return { bridge, emit: (delta: WechatLiveDelta) => listener?.(delta) };
}

beforeEach(() => { hooks.index = 0; hooks.dirty = false; hooks.slots = []; hooks.effects.clear(); });
afterEach(() => { for (const slot of hooks.slots) slot.cleanup?.(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('WeChat inbox request scheduling and scope', () => {
  it('shows the current sessions without waiting for slower runtime resource verification', async () => {
    const status = deferred<Awaited<ReturnType<SalesCopilotBridge['getRuntimeStatus']>>>();
    install({ getRuntimeStatus: () => status.promise }); render(); await settle();
    expect(inbox.wechat.accountKey).toBe(snapshot.accountKey);
    expect(inbox.runtime).toBeNull();
    status.resolve({ version: 'synthetic', mode: 'manual-assist', sources: [] }); await settle();
    expect(inbox.runtime?.version).toBe('synthetic');
  });

  it('reads and displays one initial snapshot before waiting for subscription completion', async () => {
    const read = deferred<WechatMessagesResult>(), watch = deferred<void>();
    const { bridge } = install({ getWechatMessages: vi.fn(() => read.promise), watchWechatConversation: vi.fn(() => watch.promise) });
    render(); await settle(); inbox.select(first); await settle();
    expect(bridge.getWechatMessages).toHaveBeenCalledOnce();
    expect(bridge.getWechatMessages).toHaveBeenCalledWith(first.contactKey, 200);
    expect(bridge.watchWechatConversation).not.toHaveBeenCalled();
    read.resolve(success()); await settle();
    expect(inbox.messages).toEqual([message()]); expect(inbox.messageSource).toBe('fresh');
    expect(bridge.watchWechatConversation).toHaveBeenCalledOnce();
    expect(bridge.watchWechatConversation).toHaveBeenCalledWith(first.contactKey);
    watch.resolve(); await settle(); expect(inbox.messageLoading).toBe(false);
  });

  it('refreshes and loads earlier messages without recreating the live subscription', async () => {
    const { bridge } = install(); render(); await settle(); inbox.select(first); await settle();
    inbox.retryMessages(); await settle(); inbox.loadEarlier(); await settle();
    expect(bridge.getWechatMessages).toHaveBeenCalledTimes(3);
    expect(bridge.getWechatMessages).toHaveBeenLastCalledWith(first.contactKey, 500);
    expect(bridge.watchWechatConversation).toHaveBeenCalledTimes(1);
  });

  it('discards a delayed result from the previous selected conversation', async () => {
    const old = deferred<WechatMessagesResult>();
    const { bridge } = install({ getWechatMessages: vi.fn((key) => key === first.contactKey ? old.promise : Promise.resolve(success(key))) });
    render(); await settle(); inbox.select(first); await settle(); inbox.select(second); await settle();
    old.resolve(success()); await settle();
    expect(inbox.selected?.contactKey).toBe(second.contactKey);
    expect(inbox.messages.every((row) => row.contactKey === second.contactKey)).toBe(true);
    expect(bridge.watchWechatConversation).toHaveBeenCalledOnce();
    expect(bridge.watchWechatConversation).toHaveBeenCalledWith(second.contactKey);
  });

  it('clears the selected context and unsubscribes before a hidden chat snapshot can finish', async () => {
    const read = deferred<WechatMessagesResult>();
    const { bridge } = install({ getWechatMessages: vi.fn(() => read.promise) });
    render(); await settle(); inbox.select(first); await settle();
    await inbox.clearSelection(); await settle(); read.resolve(success()); await settle();
    expect(inbox.selected).toBeNull(); expect(inbox.messages).toEqual([]);
    expect(bridge.unwatchWechatConversation).toHaveBeenCalledOnce();
    expect(bridge.watchWechatConversation).not.toHaveBeenCalled();
  });

  it('does not resurrect a hidden chat when an already-started watch resolves late', async () => {
    const watch = deferred<void>();
    const { bridge } = install({ watchWechatConversation: vi.fn(() => watch.promise) });
    render(); await settle(); inbox.select(first); await settle();
    expect(bridge.watchWechatConversation).toHaveBeenCalledOnce();
    await inbox.clearSelection(); await settle(); watch.resolve(); await settle();
    expect(inbox.selected).toBeNull(); expect(inbox.messages).toEqual([]); expect(inbox.messageSource).toBe('empty');
    expect(bridge.unwatchWechatConversation).toHaveBeenCalledOnce();
  });

  it('keeps a delayed read and an old account delta out of a newly selected account', async () => {
    const old = deferred<WechatMessagesResult>();
    const { emit } = install({ getWechatMessages: vi.fn(() => old.promise),
      startWechatLive: vi.fn().mockResolvedValue({ ok: true, snapshot: { ...snapshot, accountKey: 'other-account' } }) });
    render(); await settle(); inbox.select(first); await settle();
    await inbox.selectAccount(); await settle(); old.resolve(success());
    emit({ accountKey: snapshot.accountKey, revision: 99, status: snapshot.status, messages: [message()] }); await settle();
    expect(inbox.wechat.accountKey).toBe('other-account'); expect(inbox.wechat.revision).not.toBe(99);
    expect(inbox.selected).toBeNull(); expect(inbox.messages).toEqual([]);
  });

  it('labels reused local messages as cached while a fresh read is pending', async () => {
    const { bridge } = install(); render(); await settle(); inbox.select(first); await settle();
    inbox.select(second); await settle();
    const latest = deferred<WechatMessagesResult>();
    vi.mocked(bridge.getWechatMessages).mockImplementationOnce(() => latest.promise);
    inbox.select(first); await settle();
    expect(inbox.messageSource).toBe('cached'); expect(inbox.messageLoading).toBe(true);
    expect(inbox.messages).toEqual([message()]); expect(inbox.messagesUpdatedAt).toBeTruthy();
    latest.resolve(success(first.contactKey, 'two')); await settle();
    expect(inbox.messageSource).toBe('fresh'); expect(inbox.messages).toHaveLength(2);
  });

  it('does not label retained messages as fresh when connection or refresh fails', async () => {
    const { bridge, emit } = install(); render(); await settle(); inbox.select(first); await settle();
    const lastRead = inbox.messagesUpdatedAt;
    vi.mocked(bridge.getWechatMessages).mockResolvedValueOnce({ ok: false, error: '合成只读失败' });
    inbox.retryMessages(); await settle();
    expect(inbox.messageSource).toBe('cached'); expect(inbox.messageError).toBe('合成只读失败');
    expect(inbox.messagesUpdatedAt).toBe(lastRead);
    emit({ accountKey: snapshot.accountKey, revision: 2, status: { ...snapshot.status, state: 'backoff' }, messages: [] }); await settle();
    expect(inbox.messageSource).toBe('cached'); expect(inbox.messageError).toContain('已中断');
    expect(inbox.messages).toEqual([message()]);
  });

  it('ignores a late old-account delta after an explicit stop', async () => {
    const { emit } = install(); render(); await settle(); inbox.select(first); await settle();
    await inbox.stop(); await settle();
    emit({ accountKey: snapshot.accountKey, revision: 999, status: { ...snapshot.status, state: 'streaming' }, messages: [message()] }); await settle();
    expect(inbox.wechat.status.state).toBe('stopped'); expect(inbox.wechat.accountKey).toBeUndefined();
    expect(inbox.messages).toEqual([]); expect(inbox.messageSource).toBe('empty');
  });

  it('updates actual conversation activity immediately without extra metadata reads or invented unread counts', async () => {
    const { bridge, emit } = install(); render(); await settle(); inbox.select(first); await settle();
    const latest = { ...message(first.contactKey, 'new'), sentAt: '2026-08-31T00:02:00.000Z' };
    emit({ accountKey: snapshot.accountKey, revision: 2, status: snapshot.status, messages: [latest] }); await settle();
    expect(inbox.wechat.conversations[0]).toMatchObject({ preview: latest.text, lastMessageAt: latest.sentAt, unreadCount: 3 });
    expect(bridge.getWechatConversations).not.toHaveBeenCalled();
    expect(bridge.getWechatMessages).toHaveBeenCalledOnce();
  });

  it('does not select or read an official account even if supplied by a stale UI', async () => {
    const { bridge } = install(); render(); await settle(); inbox.select({ ...first, kind: 'official' }); await settle();
    expect(inbox.selected).toBeNull(); expect(bridge.getWechatMessages).not.toHaveBeenCalled();
  });

  it('retains at most eight conversation caches without reading other bodies in the background', async () => {
    const { bridge } = install(); render(); await settle();
    for (let index = 0; index < 9; index += 1) { inbox.select({ ...first, contactKey: `contact-${index}` }); await settle(); }
    expect(bridge.getWechatMessages).toHaveBeenCalledTimes(9);
    const latest = deferred<WechatMessagesResult>();
    vi.mocked(bridge.getWechatMessages).mockImplementationOnce(() => latest.promise);
    inbox.select({ ...first, contactKey: 'contact-0' }); await settle();
    expect(inbox.messageSource).toBe('empty'); expect(inbox.messages).toEqual([]);
    latest.resolve(success('contact-0')); await settle();
  });
});
