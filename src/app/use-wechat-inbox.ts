import { useCallback, useEffect, useRef, useState } from 'react';
import type { RuntimeStatus, WechatLiveConversation, WechatLiveMessage, WechatLiveSnapshot } from '../shared/contracts';
import { mergeLiveMessages, mergeWechatConversationActivity } from './wechat-inbox';
import { isSalesWechatConversation } from '../shared/wechat-conversation-policy';

const emptySnapshot: WechatLiveSnapshot = {
  revision: 0, conversations: [],
  status: { state: 'stopped', detail: '正在读取本机微信配置', monitoring: false, updatedAt: new Date(0).toISOString() },
};

export function useWechatInbox() {
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [wechat, setWechat] = useState(emptySnapshot);
  const [busy, setBusy] = useState(false);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string>();
  const [selected, setSelected] = useState<WechatLiveConversation | null>(null);
  const [messages, setMessages] = useState<WechatLiveMessage[]>([]);
  const [messageLoading, setMessageLoading] = useState(false);
  const [messageError, setMessageError] = useState<string>();
  const [messageSource, setMessageSource] = useState<'empty' | 'cached' | 'fresh'>('empty');
  const [messagesUpdatedAt, setMessagesUpdatedAt] = useState<string>();
  const [messageRevision, setMessageRevision] = useState(0);
  const [historyLimit, setHistoryLimit] = useState(200);
  const operation = useRef(0);
  const pageOperation = useRef(0);
  const selection = useRef<string | undefined>(undefined);
  const selectionVersion = useRef(0);
  const account = useRef<string | undefined>(undefined);
  const listRevision = useRef(-1);
  const cache = useRef(new Map<string, { messages: WechatLiveMessage[]; updatedAt: string }>());
  const watched = useRef<{ accountKey: string | undefined; contactKey: string } | undefined>(undefined);
  const pendingWatch = useRef<{ accountKey: string | undefined; contactKey: string; promise: Promise<void> } | undefined>(undefined);

  const clearContext = () => {
    selectionVersion.current += 1;
    selection.current = undefined;
    cache.current.clear();
    watched.current = undefined; pendingWatch.current = undefined;
    setSelected(null); setMessages([]); setMessageError(undefined); setMessageLoading(false);
    setMessageSource('empty'); setMessagesUpdatedAt(undefined);
  };
  const rememberMessages = useCallback((key: string, next: WechatLiveMessage[]) => {
    const updatedAt = new Date().toISOString();
    cache.current.delete(key); cache.current.set(key, { messages: next, updatedAt });
    while (cache.current.size > 8) cache.current.delete(cache.current.keys().next().value as string);
    setMessages(next); setMessageSource('fresh'); setMessagesUpdatedAt(updatedAt);
  }, []);
  const applySnapshot = useCallback((snapshot: WechatLiveSnapshot) => {
    if (account.current !== snapshot.accountKey) {
      account.current = snapshot.accountKey;
      listRevision.current = -1;
      clearContext();
    }
    const staleList = snapshot.revision < listRevision.current;
    if (!staleList) listRevision.current = snapshot.revision;
    setWechat((current) => ({ ...snapshot, conversations: snapshot.conversations.filter(isSalesWechatConversation),
      ...(staleList ? { conversations: current.conversations, nextConversationCursor: current.nextConversationCursor } : {}),
      ...(current.accountKey === snapshot.accountKey && current.revision > snapshot.revision
        ? { revision: current.revision, status: current.status } : {}),
    }));
    if (!staleList) setSelected((current) => current
      ? snapshot.conversations.find((item) => item.contactKey === current.contactKey) ?? current : null);
  }, []);
  const loadRemainingPages = useCallback(async (first: WechatLiveSnapshot, token: number) => {
    const paging = ++pageOperation.current;
    setListLoading(true); setListError(undefined);
    let cursor = first.nextConversationCursor;
    const visited = new Set<string>();
    try {
      while (cursor && token === operation.current && paging === pageOperation.current) {
        if (visited.has(cursor)) throw new Error('会话分页未继续前进，请刷新重试');
        visited.add(cursor);
        const result = await window.salesCopilot.getWechatConversations(cursor);
        if (token !== operation.current || paging !== pageOperation.current) return;
        if (!result.ok) throw new Error(result.error);
        applySnapshot(result.snapshot);
        cursor = result.snapshot.nextConversationCursor;
      }
    } catch (error) {
      if (token === operation.current && paging === pageOperation.current) {
        setListError(error instanceof Error ? error.message : '部分会话尚未加载，请刷新重试');
      }
    } finally {
      if (paging === pageOperation.current) setListLoading(false);
    }
  }, [applySnapshot]);

  const start = useCallback(async () => {
    const token = ++operation.current;
    setBusy(true); setListError(undefined);
    try {
      const result = await window.salesCopilot.startWechatLive();
      if (token !== operation.current) return;
      if (result.ok) { applySnapshot(result.snapshot); await loadRemainingPages(result.snapshot, token); }
      else { setWechat((current) => ({ ...current, status: result.status })); setListError(result.error); }
      void window.salesCopilot.getRuntimeStatus().then((status) => {
        if (token === operation.current) setRuntime(status);
      }).catch(() => undefined);
    } catch {
      if (token === operation.current) setListError('微信连接未完成，请在数据连接中检查账号目录后重试');
    } finally { if (token === operation.current) setBusy(false); }
  }, [applySnapshot, loadRemainingPages]);

  const refresh = useCallback(async () => {
    const token = operation.current;
    const paging = ++pageOperation.current;
    setListLoading(true); setListError(undefined);
    try {
      const result = await window.salesCopilot.getWechatConversations();
      if (token !== operation.current || paging !== pageOperation.current) return;
      if (!result.ok) throw new Error(result.error);
      applySnapshot(result.snapshot);
      await loadRemainingPages(result.snapshot, token);
    } catch (error) {
      if (token === operation.current && paging === pageOperation.current) { setListError(error instanceof Error ? error.message : '刷新会话失败'); setListLoading(false); }
    }
  }, [applySnapshot, loadRemainingPages]);

  const stop = async () => {
    const token = ++operation.current;
    ++pageOperation.current;
    setBusy(true); setListLoading(false); clearContext(); account.current = undefined; listRevision.current = -1;
    try { const snapshot = await window.salesCopilot.stopWechatLive(); if (token === operation.current) applySnapshot(snapshot); }
    catch { if (token === operation.current) setListError('停止读取未完成，请重试'); }
    finally { if (token === operation.current) setBusy(false); }
  };

  const selectAccount = async () => {
    const token = ++operation.current;
    ++pageOperation.current;
    setBusy(true); setListLoading(false);
    try {
      const result = await window.salesCopilot.selectWechatAccountRoot();
      if (token !== operation.current) return;
      if (result.ok) {
        clearContext(); account.current = undefined; listRevision.current = -1; setWechat(emptySnapshot);
        await start();
      } else if (!result.cancelled) setListError(result.error ?? '无法使用所选微信目录');
    } catch { if (token === operation.current) setListError('选择微信目录失败，请重试'); }
    finally { if (token === operation.current) setBusy(false); }
  };

  useEffect(() => {
    let cancelled = false;
    const token = operation.current;
    const unsubscribe = window.salesCopilot.onWechatDelta((delta) => {
      if (cancelled || delta.accountKey !== account.current) return;
      setWechat((current) => delta.revision <= current.revision ? current : { ...current, revision: delta.revision, status: delta.status,
        conversations: mergeWechatConversationActivity(current.conversations, delta.messages) });
      const key = selection.current;
      if (!key || !delta.messages.some((message) => message.contactKey === key) || !delta.accountKey || delta.accountKey !== account.current) return;
      rememberMessages(key, mergeLiveMessages(cache.current.get(key)?.messages ?? [], delta.messages, key));
    });
    // Runtime resource hashing must not delay the lightweight current snapshot.
    void window.salesCopilot.getRuntimeStatus().then((status) => {
      if (!cancelled && token === operation.current) setRuntime(status);
    }).catch(() => undefined);
    void window.salesCopilot.getWechatSnapshot().then((snapshot) => {
      if (cancelled || token !== operation.current) return;
      applySnapshot(snapshot);
      if (snapshot.status.state === 'stopped') void start();
      else if (['ready', 'streaming'].includes(snapshot.status.state)) void loadRemainingPages(snapshot, token);
    }).catch(() => { if (!cancelled) setListError('无法读取本机运行状态'); });
    return () => { cancelled = true; unsubscribe(); ++operation.current; ++pageOperation.current; };
  }, [applySnapshot, loadRemainingPages, rememberMessages, start]);

  // Refresh only session metadata. Do not subscribe to or read every chat body.
  const online = ['ready', 'streaming'].includes(wechat.status.state);
  useEffect(() => {
    if (!online) return;
    const timer = window.setInterval(() => { if (!document.hidden && !listLoading) void refresh(); }, 30_000);
    return () => window.clearInterval(timer);
  }, [online, refresh, listLoading]);

  useEffect(() => {
    const key = selected?.contactKey;
    if (!key || !online) {
      watched.current = undefined; pendingWatch.current = undefined;
      setMessageLoading(false);
      if (key) {
        setMessageSource(cache.current.has(key) ? 'cached' : 'empty');
        setMessageError('微信读取已中断，连接恢复后会重新读取最新消息');
      }
      return;
    }
    let cancelled = false;
    const selectedAccount = account.current;
    const selectedOperation = operation.current;
    const selectedVersion = selectionVersion.current;
    const stillCurrent = () => !cancelled && selection.current === key && account.current === selectedAccount
      && operation.current === selectedOperation && selectionVersion.current === selectedVersion;
    setMessageLoading(true); setMessageError(undefined);
    if (cache.current.has(key)) setMessageSource('cached');
    void (async () => {
      try {
        const result = await window.salesCopilot.getWechatMessages(key, historyLimit);
        if (!stillCurrent()) return;
        if (!result.ok) throw new Error(result.error);
        rememberMessages(key, mergeLiveMessages(cache.current.get(key)?.messages ?? [], result.messages, key));
        // Render this snapshot first. The main process reuses its exact cursor
        // when subscribing, so messages arriving in between are not missed.
        if (watched.current?.contactKey !== key || watched.current.accountKey !== selectedAccount) {
          let attempt = pendingWatch.current;
          if (attempt?.contactKey !== key || attempt.accountKey !== selectedAccount) {
            attempt = { contactKey: key, accountKey: selectedAccount, promise: window.salesCopilot.watchWechatConversation(key) };
            pendingWatch.current = attempt;
          }
          try {
            await attempt.promise;
            if (stillCurrent()) watched.current = { accountKey: selectedAccount, contactKey: key };
          } finally { if (pendingWatch.current === attempt) pendingWatch.current = undefined; }
        }
      } catch (error) {
        if (stillCurrent()) setMessageError(error instanceof Error ? error.message : '会话读取失败，请重试');
      } finally { if (stillCurrent()) setMessageLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [selected?.contactKey, online, messageRevision, historyLimit, rememberMessages]);

  const select = (conversation: WechatLiveConversation) => {
    if (!isSalesWechatConversation(conversation)) return;
    selectionVersion.current += 1;
    if (selection.current !== conversation.contactKey) watched.current = undefined;
    selection.current = conversation.contactKey;
    setSelected(conversation); setHistoryLimit(200);
    const existing = cache.current.get(conversation.contactKey);
    setMessages(existing?.messages ?? []); setMessageLoading(true); setMessageError(undefined);
    setMessageSource(existing ? 'cached' : 'empty'); setMessagesUpdatedAt(existing?.updatedAt);
    setMessageRevision((value) => value + 1);
  };
  const clearSelection = async () => {
    selectionVersion.current += 1;
    const key = selection.current;
    selection.current = undefined; watched.current = undefined; pendingWatch.current = undefined;
    if (key) cache.current.delete(key);
    setSelected(null); setMessages([]); setMessageError(undefined); setMessageLoading(false);
    setMessageSource('empty'); setMessagesUpdatedAt(undefined);
    await window.salesCopilot.unwatchWechatConversation();
  };
  return { runtime, wechat, busy, listLoading, listError, selected, messages, messageLoading, messageError, messageSource, messagesUpdatedAt,
    start, stop, selectAccount, refresh, select, clearSelection,
    retryMessages: () => setMessageRevision((value) => value + 1),
    loadEarlier: () => { setHistoryLimit(500); setMessageRevision((value) => value + 1); },
  };
}
