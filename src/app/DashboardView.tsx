import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button } from '@fluentui/react-components';
import { ArrowSync20Regular, ChevronRight20Regular } from '@fluentui/react-icons';
import type { WechatLiveSnapshot } from '../shared/contracts';
import type { CrmTask, CrmWorkspaceOverview } from '../shared/integration-contracts';
import { featureValue } from './feature-views-model';
import { customerGrade, sourceHost, taskState, taskStateLabels, unreadPeople, workbenchTime } from './workbench-model';
import { PrivateImage } from './wechat-media';
import { CustomerGradeChart, WorkTrendChart } from './dashboard-charts';
import './workbench.css';

export interface DashboardViewProps {
  snapshot: WechatLiveSnapshot;
  onNotice: (message: string, kind?: 'success' | 'error') => void;
  onOpenSettings: () => void;
  onOpenCustomer: (customerId: number) => void;
  onOpenConversation: (contactKey: string) => void;
  hiddenContactKeys?: readonly string[];
  localPlans?: ReactNode;
}

function TaskRow({ task, onOpenCustomer }: { task: CrmTask; onOpenCustomer: (id: number) => void }) {
  const state = taskState(task);
  return <li><button type="button" className="wb-task-row" onClick={() => onOpenCustomer(task.customerId)}>
    <span className={`wb-status wb-status-${state}`}>{taskStateLabels[state]}</span>
    <span className="wb-task-body"><strong>{task.title || '未填写任务标题'}</strong><span>{task.customerName || 'CRM 客户'}<span className="wb-grade">{customerGrade(task.customerLevel)}</span>{task.accessProfile === 'masked' && <small>脱敏资料</small>}</span></span>
    <time>{workbenchTime(task.dueAt, '未设时间')}</time><ChevronRight20Regular aria-hidden="true" />
  </button></li>;
}

export function DashboardView({ snapshot, onNotice, onOpenSettings, onOpenCustomer, onOpenConversation, hiddenContactKeys, localPlans }: DashboardViewProps) {
  const [overview, setOverview] = useState<CrmWorkspaceOverview | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [taskTab, setTaskTab] = useState<'today' | 'overdue' | 'future'>('today');
  const [visibleTasks, setVisibleTasks] = useState(16);
  const [visibleChats, setVisibleChats] = useState(8);
  const taskSection = useRef<HTMLElement>(null);
  const unread = useMemo(() => unreadPeople(snapshot.conversations, hiddenContactKeys), [snapshot.conversations, hiddenContactKeys]);
  const wechatOnline = Boolean(snapshot.accountKey) && ['ready', 'streaming'].includes(snapshot.status.state);
  useEffect(() => {
    let cancelled = false;
    setBusy(true); setError(''); setOverview(null);
    void window.salesCopilot.getCrmWorkspaceOverview().then(featureValue).then((value) => {
      if (!cancelled) { setOverview(value); setTaskTab(value.overdue.length ? 'overdue' : 'today'); }
    }).catch((failure) => { if (!cancelled) setError(failure instanceof Error ? failure.message : 'CRM 工作数据读取失败。'); })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [revision]);
  const tasks = overview?.[taskTab] || [];
  const stats = overview?.stats;
  function chooseTaskTab(value: 'today' | 'overdue' | 'future') {
    setTaskTab(value); setVisibleTasks(16);
    taskSection.current?.scrollIntoView({ block: 'start', behavior: 'auto' });
  }
  return <main className="wb-page wb-dashboard">
    <header className="wb-page-heading"><div><div className="wb-dashboard-title"><h1>今日工作台</h1><time>{new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })}</time></div>
      <div className="wb-dashboard-meta"><span>{overview?.scopeLabel || 'CRM 跟进计划与微信新消息'}</span>{overview && <><span>{sourceHost(overview.sourceBaseUrl)}</span><time dateTime={overview.fetchedAt}>{workbenchTime(overview.fetchedAt)} 更新</time></>}</div></div>
      <Button appearance="subtle" icon={<ArrowSync20Regular />} disabled={busy} onClick={() => { setRevision((value) => value + 1); onNotice('正在刷新 CRM 工作台。'); }}>刷新统计</Button>
    </header>
    <div className="wb-metrics wb-dashboard-metrics" aria-label="CRM 工作数据统计" aria-busy={busy}>
      <div><span>跟进中客户</span><strong>{stats?.totalCustomers ?? '—'}</strong><small>未成交 · 非公海</small></div>
      <button type="button" disabled={!overview} onClick={() => chooseTaskTab('today')}><span>今日待办</span><strong>{stats?.todayTasks ?? '—'}</strong><small>CRM 未完成任务</small></button>
      <button type="button" className={stats?.overdueTasks ? 'wb-metric-attention' : ''} disabled={!overview} onClick={() => chooseTaskTab('overdue')}><span>逾期待办</span><strong>{stats?.overdueTasks ?? '—'}</strong><small>CRM 未完成任务</small></button>
      <div><span>本月新增</span><strong>{stats?.monthNew ?? '—'}</strong><small>含转交客户</small></div>
      <div><span>本月到访</span><strong>{stats?.monthVisited ?? '—'}</strong><small>当前到访未成交</small></div>
      <div><span>本月成交</span><strong>{stats?.monthDeal ?? '—'}</strong><small>按签约时间</small></div>
    </div>
    {error && <div className="wb-error" role="alert"><strong>CRM 统计暂时不可用</strong><p>{error}。未知数据以“—”显示，不会当作 0。</p><Button onClick={() => setRevision((value) => value + 1)}>重试读取</Button><Button appearance="subtle" onClick={onOpenSettings}>配置 CRM / 检查权限</Button></div>}
    <div className="wb-dashboard-charts">
      <WorkTrendChart rows={overview?.workTrend || []} fetchedAt={overview?.fetchedAt || ''} busy={busy} available={Boolean(overview)} />
      <CustomerGradeChart rows={overview?.levelStats || []} busy={busy} available={Boolean(overview)} />
    </div>
    <div className="wb-dashboard-content"><div className="wb-dashboard-main">
      <section className="wb-section wb-task-section" aria-label="CRM 任务计划" ref={taskSection}>
        <div className="wb-section-heading"><h2>任务计划</h2><span className="wb-muted">CRM 已有计划 · 只读</span></div>
        <div className="wb-task-filter"><div className="wb-segments" role="group" aria-label="计划时间">
          {([{ id: 'today', label: '今天' }, { id: 'overdue', label: '逾期' }, { id: 'future', label: '未来' }] as const).map((tab) => <button type="button" key={tab.id} aria-pressed={taskTab === tab.id} onClick={() => chooseTaskTab(tab.id)}>{tab.label}<span>{overview ? overview[tab.id].length : '—'}</span></button>)}
        </div><span className="wb-muted">点击任务查看客户跟进</span></div>
        {busy ? <div className="wb-loading" role="status"><span>正在读取 CRM 任务与统计…</span><div /><div /><div /></div> : !overview ? <div className="wb-empty"><strong>CRM 计划暂时读取失败</strong><p>请根据上方提示检查连接或权限。已有任务不会因为本次读取失败而被清空。</p><Button onClick={onOpenSettings}>检查 CRM 连接</Button></div> : tasks.length ? <><ul className="wb-tasks">{tasks.slice(0, visibleTasks).map((task) => <TaskRow task={task} key={task.id} onOpenCustomer={onOpenCustomer} />)}</ul>
          {tasks.length > visibleTasks && <Button appearance="subtle" onClick={() => setVisibleTasks((value) => value + 16)}>再显示 {Math.min(16, tasks.length - visibleTasks)} 项计划</Button>}
        </> : <div className="wb-empty wb-empty-short"><strong>{taskTab === 'today' ? 'CRM 今天没有未完成任务' : taskTab === 'overdue' ? '当前没有逾期任务' : 'CRM 尚未安排未来任务'}</strong><p>这里按 CRM 的任务记录统计，不会把微信未读自动变成任务。</p></div>}
      </section>
      {localPlans && <div className="wb-local-plans">{localPlans}</div>}
      <section className="wb-section wb-priority-section" aria-label="CRM 优先跟进客户"><div className="wb-section-heading"><h2>优先跟进</h2><span className="wb-muted">CRM 推荐顺序</span></div>
        {!overview ? <p className="wb-muted">{busy ? '正在读取…' : '连接 CRM 后显示高优先级客户。'}</p> : overview.priorityCustomers.length ? <div className="wb-priority-list">{overview.priorityCustomers.slice(0, 8).map((customer) => <button type="button" key={customer.id} onClick={() => onOpenCustomer(customer.id)}>
          <span><strong>{customer.name || 'CRM 客户'}</strong><span className="wb-grade">{customerGrade(customer.level)}</span></span>
          <span>{customer.accessProfile === 'masked' ? '当前权限仅显示脱敏资料' : customer.lastFollowupContent || '尚无文字跟进'}</span>
          <small>下次跟进 {workbenchTime(customer.nextFollowupAt, '未安排')}</small><ChevronRight20Regular aria-hidden="true" />
        </button>)}</div> : <p className="wb-muted">CRM 当前没有列出优先跟进客户。</p>}
        {overview && overview.staleCount > 0 && <details className="wb-stale-list"><summary>CRM 标记长期未跟进 {overview.staleCount} 位</summary><p className="wb-muted">按 CRM 返回范围展示，不根据未读标记推断。</p>{overview.staleCustomers.map((customer) => <button type="button" key={customer.id} onClick={() => onOpenCustomer(customer.id)}><strong>{customer.name || 'CRM 客户'}</strong><span>最近 {workbenchTime(customer.lastFollowupAt, '尚无跟进记录')}</span><ChevronRight20Regular aria-hidden="true" /></button>)}</details>}
      </section>
    </div><aside className="wb-dashboard-side">
      <section className="wb-section wb-unread-section" aria-label="微信单聊未读"><div className="wb-section-heading"><h2>单聊新消息</h2><span className="wb-count">{wechatOnline ? unread.length : '—'}</span></div>
        <p className="wb-section-note">仅微信未读标记，不代表待办、已邀约或已成交。公众号、系统消息和已隐藏会话不列入。</p>
        {!wechatOnline ? <div className="wb-empty wb-empty-short"><strong>微信当前未在实时读取</strong><p>{snapshot.status.detail}</p><Button onClick={onOpenSettings}>检查微信连接</Button></div> : unread.length ? <><div className="wb-unread-list">{unread.slice(0, visibleChats).map((conversation) => <button type="button" key={conversation.contactKey} onClick={() => onOpenConversation(conversation.contactKey)}>
          <PrivateImage mediaKey={conversation.avatarMediaKey} className="wb-chat-avatar" alt={`${conversation.remark || conversation.displayName}的头像`} fallback={Array.from(conversation.remark || conversation.displayName)[0] || '聊'} />
          <span><span className="wb-unread-heading"><strong>{conversation.remark || conversation.displayName || '微信会话'}</strong><small>{conversation.unreadCount} 条未读</small></span><span className="wb-unread-preview">{conversation.preview || '点击读取最新消息'}</span><time>{workbenchTime(conversation.lastMessageAt)}</time></span>
        </button>)}</div>{unread.length > visibleChats && <Button appearance="subtle" onClick={() => setVisibleChats((value) => value + 8)}>再显示 {Math.min(8, unread.length - visibleChats)} 个会话</Button>}</> : <div className="wb-empty wb-empty-short"><strong>当前单聊没有未读标记</strong><p>仍可到会话页查看其他聊天，这里不会自动标记客户已跟进。</p></div>}
        {wechatOnline && <p className="wb-source-footnote">微信读取状态更新于 {workbenchTime(snapshot.status.updatedAt)}</p>}
      </section>
    </aside>
    {overview && <details className="wb-metric-notes"><summary>查看统计口径与来源</summary><p>{overview.scopeLabel} · {sourceHost(overview.sourceBaseUrl)} · {workbenchTime(overview.fetchedAt)} 读取</p><ul>{overview.metricNotes.map((note, index) => <li key={index}>{note}</li>)}</ul></details>}
    </div>
  </main>;
}
