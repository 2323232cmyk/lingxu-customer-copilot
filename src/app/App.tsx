import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, FluentProvider } from '@fluentui/react-components';
import { Chat24Regular, CheckmarkCircle20Filled, Info20Regular } from '@fluentui/react-icons';
import symbol from '../assets/brand/symbol-dark.svg';
import type { WechatLiveConversation } from '../shared/contracts';
import { isSalesWechatConversation } from '../shared/wechat-conversation-policy';
import { NavigationRail, type PageId } from './NavigationRail';
import { ConversationWorkspace } from './ConversationWorkspace';
import { ExportView, KnowledgeView, SettingsView, type SettingsSection } from './FeatureViews';
import { CrmWorkspace } from './CrmWorkspace';
import { LocalPlanPanel } from './LocalPlanPanel';
import { WechatConversationQueue } from './WechatConversationQueue';
import { useWechatInbox } from './use-wechat-inbox';
import { readNavigationLayout, saveNavigationLayout, readWorkspaceDesign, saveWorkspaceDesign, type NavigationLayout, type WorkspaceDesign } from './layout-preferences';
import { emptyConversationPreferences, readConversationPreferences, saveConversationPreferences, toggleConversationPreference, type ConversationPreferences } from './conversation-preferences';
import { appearanceTheme, readAppearance, saveAppearance, skins, type Appearance } from './appearance';
import { WorkspaceResizeHandles } from './WorkspaceResizeHandles';

const DashboardView = lazy(() => import('./DashboardView').then((module) => ({ default: module.DashboardView })));

export function App() {
  const [page, setPage] = useState<PageId>('conversation');
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('connections');
  const [settingsNavigationRevision, setSettingsNavigationRevision] = useState(0);
  const [layout, setLayout] = useState<NavigationLayout>(() => {
    try { return readNavigationLayout(window.localStorage); } catch { return 'labelled'; }
  });
  const [design, setDesign] = useState<WorkspaceDesign>(() => {
    try { return readWorkspaceDesign(window.localStorage); } catch { return 'A'; }
  });
  const [appearance, setAppearance] = useState<Appearance>(() => {
    try { return readAppearance(window.localStorage, design); } catch { return { skin: design === 'B' ? 'graphite' : 'warm', accent: 'gold' }; }
  });
  const theme = useMemo(() => appearanceTheme(appearance), [appearance]);
  const colorMode = skins.find((skin) => skin.id === appearance.skin)?.mode || 'light';
  const [notice, setNotice] = useState<{ message: string; kind: 'success' | 'error' } | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [settingsRevision, setSettingsRevision] = useState(0);
  const [crmRevision, setCrmRevision] = useState(0);
  const [todayVisited, setTodayVisited] = useState(false);
  const [crmVisited, setCrmVisited] = useState(false);
  const [exportVisited, setExportVisited] = useState(false);
  const [exportContactKey, setExportContactKey] = useState<string>();
  const [exportNavigationRevision, setExportNavigationRevision] = useState(0);
  const [crmCustomerId, setCrmCustomerId] = useState<number>();
  const [crmNavigationRevision, setCrmNavigationRevision] = useState(0);
  const [savedPreferences, setSavedPreferences] = useState<{ accountKey?: string; value: ConversationPreferences }>({ value: emptyConversationPreferences() });
  const [knowledgeVisited, setKnowledgeVisited] = useState(false);
  const preferencesRef = useRef(savedPreferences);
  preferencesRef.current = savedPreferences;
  const inbox = useWechatInbox();
  const preferences = useMemo(() => {
    if (savedPreferences.accountKey === inbox.wechat.accountKey) return savedPreferences.value;
    try { return readConversationPreferences(window.localStorage, inbox.wechat.accountKey); } catch { return emptyConversationPreferences(); }
  }, [savedPreferences, inbox.wechat.accountKey]);
  useEffect(() => {
    let value = emptyConversationPreferences();
    try { value = readConversationPreferences(window.localStorage, inbox.wechat.accountKey); } catch { /* Preferences are optional. */ }
    setSavedPreferences({ accountKey: inbox.wechat.accountKey, value });
  }, [inbox.wechat.accountKey]);
  useEffect(() => () => clearTimeout(noticeTimer.current), []);
  const showNotice = useCallback((message: string, kind: 'success' | 'error' = 'success') => {
    clearTimeout(noticeTimer.current); setNotice({ message, kind });
    noticeTimer.current = setTimeout(() => setNotice(null), 4500);
  }, []);
  const changeLayout = useCallback((value: NavigationLayout) => {
    setLayout(value);
    try { if (!saveNavigationLayout(window.localStorage, value)) showNotice('导航已切换，但暂时无法记住设置。', 'error'); }
    catch { showNotice('导航已切换，但暂时无法记住设置。', 'error'); }
  }, [showNotice]);
  const changeDesign = useCallback((value: WorkspaceDesign) => {
    setDesign(value);
    try { if (!saveWorkspaceDesign(window.localStorage, value)) showNotice('界面方案已切换，但暂时无法记住设置。', 'error'); }
    catch { showNotice('界面方案已切换，但暂时无法记住设置。', 'error'); }
  }, [showNotice]);
  const changeAppearance = useCallback((value: Appearance) => {
    setAppearance(value);
    try { if (!saveAppearance(window.localStorage, value)) showNotice('配色已切换，但暂时无法记住设置。', 'error'); }
    catch { showNotice('配色已切换，但暂时无法记住设置。', 'error'); }
  }, [showNotice]);
  const changePreference = (kind: keyof ConversationPreferences, conversation: WechatLiveConversation) => {
    const accountKey = inbox.wechat.accountKey;
    if (!accountKey) return;
    try {
      const previous = preferencesRef.current.accountKey === accountKey ? preferencesRef.current.value : emptyConversationPreferences();
      const value = toggleConversationPreference(previous, kind, conversation.contactKey);
      const next = { accountKey, value };
      preferencesRef.current = next; setSavedPreferences(next);
      const persisted = saveConversationPreferences(window.localStorage, accountKey, value);
      if (kind === 'hidden') {
        const hidden = value.hidden.includes(conversation.contactKey);
        if (hidden && inbox.selected?.contactKey === conversation.contactKey) void inbox.clearSelection().catch(() => showNotice('会话已隐藏，停止监听未完成，请检查微信连接。', 'error'));
        showNotice(hidden ? '已隐藏。可在会话显示选项 → 已隐藏中恢复，微信记录未删除。' : '已恢复显示。');
      }
      if (!persisted) showNotice('本次操作已生效，但本机偏好未能保存。', 'error');
    } catch (error) { showNotice(error instanceof Error ? error.message : '会话设置未保存，请重试。', 'error'); }
  };
  const changePage = (value: PageId) => {
    if (value === 'today') setTodayVisited(true);
    if (value === 'customers') setCrmVisited(true);
    if (value === 'export') { setExportVisited(true); setExportContactKey(inbox.selected?.contactKey); setExportNavigationRevision((revision) => revision + 1); }
    if (value === 'knowledge') setKnowledgeVisited(true);
    if (value === 'settings') { setSettingsSection('connections'); setSettingsNavigationRevision((revision) => revision + 1); }
    setPage(value);
  };
  const openSettings = (section: SettingsSection = 'connections') => { setSettingsSection(section); setSettingsNavigationRevision((revision) => revision + 1); setPage('settings'); };
  const settingsChanged = useCallback((area: 'crm' | 'ai' | 'knowledge') => {
    setSettingsRevision((value) => value + 1);
    if (area === 'crm') setCrmRevision((value) => value + 1);
  }, []);
  const dashboardSnapshot = useMemo(() => ({ ...inbox.wechat,
    conversations: inbox.wechat.conversations.filter((item) => isSalesWechatConversation(item) && !preferences.hidden.includes(item.contactKey)),
  }), [inbox.wechat, preferences.hidden]);
  const selected = inbox.selected && isSalesWechatConversation(inbox.selected) && !preferences.hidden.includes(inbox.selected.contactKey) ? inbox.selected : null;
  const selectConversation = (conversation: WechatLiveConversation) => {
    if (!isSalesWechatConversation(conversation) || preferences.hidden.includes(conversation.contactKey)) return;
    inbox.select(conversation); setPage('conversation');
  };
  const conversationContainer = useRef<HTMLDivElement>(null);
  return <FluentProvider theme={theme} className={`fluent-root appearance-${colorMode}`}>
    <div className={`app-shell layout-${layout} design-${design}`}>
      <header className="window-drag-region"><div className="window-brand" title={`领序·客户参谋${inbox.runtime?.version ? ` v${inbox.runtime.version}` : ''}`}>
        <img src={symbol} alt="" className="window-brand-symbol" /><span className="window-title"><span className="window-brand-name">领序</span><span className="window-product-name">客户参谋</span></span>
      </div>
        {design === 'C' && <NavigationRail orientation="horizontal" active={page} layout={layout} onChange={changePage} onLayoutChange={changeLayout} />}
      </header>
      <div className="app-body">
        {design !== 'C' && <NavigationRail active={page} layout={layout} onChange={changePage} onLayoutChange={changeLayout} />}
        <div ref={conversationContainer} className="conversation-layout" hidden={page !== 'conversation'}>
          <WechatConversationQueue key={inbox.wechat.accountKey || 'no-account'} snapshot={inbox.wechat} activeKey={selected?.contactKey} active={page === 'conversation'} loading={inbox.busy || inbox.listLoading} listError={inbox.listError}
            preferences={preferences} onPreference={changePreference} onCopyName={(name) => void window.salesCopilot.copyText(name).then(() => showNotice('已复制微信昵称。')).catch(() => showNotice('复制未完成，请重试。', 'error'))}
            onSelect={selectConversation} onRefresh={() => void inbox.refresh()} onStart={() => void inbox.start()} />
          {selected && inbox.wechat.accountKey ? <ConversationWorkspace key={`${inbox.wechat.accountKey}:${selected.contactKey}`}
            design={design} active={page === 'conversation'} scope={{ accountKey: inbox.wechat.accountKey, contactKey: selected.contactKey }} conversation={selected} messages={inbox.messages}
            status={inbox.wechat.status} selfAvatarMediaKey={inbox.wechat.selfAvatarMediaKey} loading={inbox.messageLoading} readError={inbox.messageError}
            messageSource={inbox.messageSource} messagesUpdatedAt={inbox.messagesUpdatedAt}
            settingsRevision={settingsRevision} onReload={inbox.retryMessages} onLoadEarlier={inbox.loadEarlier}
            onOpenSettings={openSettings} onExport={() => changePage('export')} onNotice={showNotice} />
            : <main className="inbox-welcome"><Chat24Regular /><h1>从一段对话开始</h1><p>选中左侧会话，结合客户档案和公司知识准备回复。</p>
              <span>起草、编辑、复制，由你在微信发送。</span><div className="welcome-actions">{!['ready', 'streaming'].includes(inbox.wechat.status.state) && <Button appearance="primary" disabled={inbox.busy} onClick={() => void inbox.start()}>{inbox.busy ? '连接中…' : '连接微信'}</Button>}<Button onClick={() => openSettings('ai')}>配置回复模型</Button></div></main>}
          <WorkspaceResizeHandles containerRef={conversationContainer} design={design} hasConversation={Boolean(selected && inbox.wechat.accountKey)} />
        </div>
        {todayVisited && <section className="auxiliary-page" hidden={page !== 'today'}><Suspense fallback={<main className="page-view" role="status">正在打开今日工作台…</main>}><DashboardView key={crmRevision} snapshot={dashboardSnapshot} onNotice={showNotice} onOpenSettings={() => openSettings()}
          localPlans={<LocalPlanPanel accountKey={inbox.wechat.accountKey} onNotice={showNotice} />}
          onOpenCustomer={(id) => { setCrmVisited(true); setCrmCustomerId(id); setCrmNavigationRevision((revision) => revision + 1); setPage('customers'); }} onOpenConversation={(key) => { const conversation = dashboardSnapshot.conversations.find((item) => item.contactKey === key); if (conversation) selectConversation(conversation); }} /></Suspense></section>}
        {page === 'settings' && <SettingsView initialSection={settingsSection} navigationRevision={settingsNavigationRevision} design={design} onDesignChange={changeDesign} appearance={appearance} onAppearanceChange={changeAppearance} layout={layout} onLayoutChange={changeLayout} wechat={inbox.wechat} wechatBusy={inbox.busy}
          onStartWechat={() => void inbox.start()} onStopWechat={() => void inbox.stop()} onSelectWechatRoot={() => void inbox.selectAccount()}
          onNotice={showNotice} onSettingsChanged={settingsChanged} onOpenKnowledge={() => changePage('knowledge')} />}
        {knowledgeVisited && <section className="auxiliary-page" hidden={page !== 'knowledge'}><KnowledgeView active={page === 'knowledge'} onNotice={showNotice} onSettingsChanged={() => settingsChanged('knowledge')} /></section>}
        {crmVisited && <section className="auxiliary-page" hidden={page !== 'customers'}><CrmWorkspace key={crmRevision} initialCustomerId={crmCustomerId} navigationRevision={crmNavigationRevision} onNotice={showNotice} onOpenSettings={() => openSettings()} /></section>}
        {exportVisited && <section className="auxiliary-page" hidden={page !== 'export'}><ExportView key={inbox.wechat.accountKey || 'no-account'} snapshot={dashboardSnapshot} initialContactKey={exportContactKey} navigationRevision={exportNavigationRevision} hiddenContactKeys={preferences.hidden} onNotice={showNotice} /></section>}
      </div>
      {notice && <div className={`toast toast-${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>{notice.kind === 'success' ? <CheckmarkCircle20Filled /> : <Info20Regular />}{notice.message}</div>}
    </div>
  </FluentProvider>;
}
