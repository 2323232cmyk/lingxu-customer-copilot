import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Input, Menu, MenuItem, MenuList, MenuPopover, MenuTrigger } from '@fluentui/react-components';
import { ArrowSync20Regular, ArrowUndo20Regular, Chat24Regular, Copy20Regular, EyeOff20Regular, Filter20Regular, Pin20Regular, PinOff20Regular, Play20Regular, Search20Regular } from '@fluentui/react-icons';
import type { WechatLiveConversation, WechatLiveSnapshot } from '../shared/contracts';
import { isSalesWechatConversation } from '../shared/wechat-conversation-policy';
import { filterWechatConversations, formatWechatTime, type WechatInboxFilter } from './wechat-inbox';
import { conversationWindow, CONVERSATION_ROW_HEIGHT, orderVisibleConversations, type ConversationPreferences } from './conversation-preferences';
import { PrivateImage } from './wechat-media';

export function WechatConversationQueue({ snapshot, activeKey, active = true, loading, listError, preferences, onSelect, onRefresh, onStart, onPreference, onCopyName }: {
  snapshot: WechatLiveSnapshot; activeKey?: string; loading: boolean; listError?: string; preferences: ConversationPreferences;
  active?: boolean;
  onSelect: (conversation: WechatLiveConversation) => void; onRefresh: () => void; onStart: () => void;
  onPreference: (kind: keyof ConversationPreferences, conversation: WechatLiveConversation) => void;
  onCopyName: (name: string) => void;
}) {
  const [filter, setFilter] = useState<WechatInboxFilter>('单聊');
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [onlyUnread, setOnlyUnread] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(650);
  const [focusKey, setFocusKey] = useState<string>();
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!active) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key.toLowerCase() === 'k') { event.preventDefault(); search.current?.focus(); }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [active]);
  useEffect(() => {
    const element = list.current;
    if (!element) return;
    const update = () => setHeight(element.clientHeight || 650);
    update();
    const observer = new ResizeObserver(update); observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const eligible = useMemo(() => snapshot.conversations.filter(isSalesWechatConversation), [snapshot.conversations]);
  const ordered = useMemo(() => orderVisibleConversations(eligible, preferences, showHidden), [eligible, preferences, showHidden]);
  const conversations = useMemo(() => filterWechatConversations(ordered, filter, deferredQuery)
    .filter((item) => !onlyUnread || Number(item.unreadCount) > 0), [ordered, filter, deferredQuery, onlyUnread]);
  const hiddenCount = useMemo(() => eligible.filter((item) => preferences.hidden.includes(item.contactKey)).length, [eligible, preferences.hidden]);
  const range = conversationWindow(conversations.length, scrollTop, height);
  const online = ['ready', 'streaming'].includes(snapshot.status.state);
  useEffect(() => {
    setScrollTop(0); if (list.current) list.current.scrollTop = 0;
  }, [filter, deferredQuery, onlyUnread, showHidden, snapshot.accountKey]);
  useEffect(() => {
    if (!focusKey) return;
    const element = list.current?.querySelector<HTMLButtonElement>(`[data-contact-key="${CSS.escape(focusKey)}"]`);
    if (element) { element.focus({ preventScroll: true }); setFocusKey(undefined); }
  }, [focusKey, range.start, range.end]);
  const moveFocus = (event: React.KeyboardEvent, index: number) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? conversations.length - 1
      : Math.max(0, Math.min(conversations.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
    const row = conversations[next]; if (!row) return;
    setFocusKey(row.contactKey);
    const top = next * CONVERSATION_ROW_HEIGHT;
    if (list.current && (top < scrollTop || top + CONVERSATION_ROW_HEIGHT > scrollTop + height)) {
      const offset = Math.max(0, top - height / 2);
      list.current.scrollTop = offset; setScrollTop(offset);
    }
  };
  return <aside className="queue-panel wechat-inbox-queue" aria-label="微信会话列表" aria-busy={loading}>
    <header className="queue-header"><h1>客户会话</h1>
      <Button appearance="subtle" icon={<ArrowSync20Regular />} aria-label="刷新微信会话" onClick={onRefresh} disabled={loading || !online} />
    </header>
    <div className="queue-search-row"><Input ref={search} className="queue-search" contentBefore={<Search20Regular />} placeholder="搜索会话"
      contentAfter={<kbd className="queue-search-shortcut" aria-hidden="true">Ctrl K</kbd>}
      aria-label="搜索微信会话" value={query} onChange={(_, data) => setQuery(data.value)} />
      <Button appearance="subtle" icon={<Filter20Regular />} aria-label="会话显示选项" aria-expanded={filtersOpen} aria-controls="queue-options"
        className={showHidden ? 'queue-filter-selected' : ''} onClick={() => setFiltersOpen(!filtersOpen)} /></div>
    <div className="queue-tabs queue-kind-tabs" aria-label="选择单聊或群聊">
      {(['单聊', '群聊', '全部'] as WechatInboxFilter[]).map((item) => <button type="button" key={item}
        aria-pressed={filter === item} className={filter === item ? 'queue-tab-active' : ''} onClick={() => setFilter(item)}>{item}</button>)}
      <button type="button" className="queue-unread-filter" aria-label="仅未读" aria-pressed={onlyUnread} onClick={() => setOnlyUnread(!onlyUnread)}>未读</button>
    </div>
    <div id="queue-options" className="queue-options" hidden={!filtersOpen}>
      <button type="button" aria-pressed={showHidden} onClick={() => setShowHidden(!showHidden)}>已隐藏 {hiddenCount}</button>
    </div>
    <div className="queue-summary" role="status"><span>{conversations.length} 个{showHidden ? '已隐藏' : ''}会话{loading ? ' · 更新中' : ''}</span><span>{showHidden ? '点击恢复显示' : '右键置顶 / 隐藏'}</span></div>
    {listError && <div className="inbox-inline-error" role="alert">{listError}<button type="button" onClick={onRefresh}>重试</button></div>}
    {!online && !loading && <div className="inbox-connection-note"><span>{snapshot.status.detail}</span>
      <Button icon={<Play20Regular />} appearance="primary" onClick={onStart}>连接微信</Button></div>}
    <div className="queue-list queue-list-windowed" ref={list} onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}>
      <div style={{ height: range.before }} aria-hidden="true" />
      {conversations.slice(range.start, range.end).map((conversation, index) => {
        const pinned = preferences.pinned.includes(conversation.contactKey);
        const name = conversation.remark || conversation.displayName;
        return <Menu key={conversation.contactKey} openOnContext>
          <MenuTrigger disableButtonEnhancement><button type="button" data-contact-key={conversation.contactKey}
            className={`queue-row wechat-queue-row ${activeKey === conversation.contactKey && !showHidden ? 'queue-row-active' : ''}`}
            aria-pressed={activeKey === conversation.contactKey && !showHidden} aria-label={`${name}${pinned ? '，已置顶' : ''}${showHidden ? '，已隐藏，点击恢复显示' : ''}`}
            onKeyDown={(event) => moveFocus(event, range.start + index)}
            onClick={() => { if (showHidden) onPreference('hidden', conversation); else if (online) onSelect(conversation); }}>
            <PrivateImage mediaKey={conversation.avatarMediaKey} className="queue-avatar" alt={`${name}的头像`} fallback={Array.from(name)[0] || '聊'} />
            <span className="queue-row-body"><span className="queue-row-top"><strong>{name}</strong><time dateTime={conversation.lastMessageAt}>{formatWechatTime(conversation.lastMessageAt)}</time></span>
              <span className="queue-preview">{conversation.preview || '点击读取最近消息'}</span>
              <span className="queue-meta">{pinned && <Pin20Regular aria-label="已置顶" />}{showHidden ? '点击恢复，不删除微信记录' : conversation.kind === 'group' ? '群聊' : '单聊'}</span>
            </span>
            {!showHidden && Number(conversation.unreadCount) > 0 && <span className="unread-count" aria-label={`${conversation.unreadCount}条微信未读消息`}>{Number(conversation.unreadCount) > 99 ? '99+' : conversation.unreadCount}</span>}
          </button></MenuTrigger>
          <MenuPopover><MenuList>
            {!showHidden && <MenuItem icon={pinned ? <PinOff20Regular /> : <Pin20Regular />} onClick={() => onPreference('pinned', conversation)}>{pinned ? '取消置顶' : '置顶此会话'}</MenuItem>}
            <MenuItem icon={<Copy20Regular />} onClick={() => onCopyName(name)}>复制微信昵称</MenuItem>
            <MenuItem icon={showHidden ? <ArrowUndo20Regular /> : <EyeOff20Regular />} onClick={() => onPreference('hidden', conversation)}>{showHidden ? '恢复显示此会话' : '不显示此会话'}</MenuItem>
          </MenuList></MenuPopover>
        </Menu>;
      })}
      <div style={{ height: range.after }} aria-hidden="true" />
      {conversations.length === 0 && <div className="empty-state"><Chat24Regular /><strong>{loading ? '正在读取微信会话' : showHidden ? '没有隐藏的会话' : online ? '没有匹配的会话' : '连接后显示微信会话'}</strong>
        <span>{showHidden ? '隐藏仅影响本软件，不删除微信数据' : loading ? '先显示最近会话，图片按需读取' : online ? '可以切换单聊、群聊或清除搜索' : '无需先关联 CRM 客户'}</span></div>}
    </div>
  </aside>;
}
