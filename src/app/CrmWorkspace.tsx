import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Button } from '@fluentui/react-components';
import { ArrowSync20Regular, Call20Regular, Chat20Regular, ChevronLeft20Regular, ChevronRight20Regular, Search20Regular } from '@fluentui/react-icons';
import type { CrmCustomerContext, CrmCustomerListQuery, CrmCustomerPage, CrmCustomerSummary } from '../shared/integration-contracts';
import { crmProfileRows, featureValue, fieldText } from './feature-views-model';
import { crmContextTasks, crmTimeline, customerGrade, nextCustomerIndex, pageCustomerFacts, sourceHost, taskState, taskStateLabels, workbenchTime } from './workbench-model';
import { PanelResizeHandle, useSavedPanelSizes } from './WorkspaceResizeHandles';
import { clampPanelSize } from './panel-sizing';
import './workbench.css';
import './feature-panel-sizing.css';

type Notice = (message: string, kind?: 'success' | 'error') => void;
export interface CrmWorkspaceProps {
  onNotice: Notice;
  onOpenSettings: () => void;
  initialCustomerId?: number;
  navigationRevision?: number;
}
type ContextState = { id: number | null; value: CrmCustomerContext | null; busy: boolean; error: string };
const stages = [{ id: 'active', label: '跟进中' }, { id: 'visited', label: '已到访' }, { id: 'deal', label: '已成交' }] as const;
const failureMessage = (failure: unknown) => failure instanceof Error ? failure.message : 'CRM 读取失败，请重试。';
const crmPanelDefaults = { list: 340 };

function CrmColumns({ children }: { children: ReactNode }) {
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1000);
  const { sizes, setSizes, commit, reset } = useSavedPanelSizes('lingxu.crm-panels.v1', crmPanelDefaults);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const measure = () => { if (element.clientWidth > 0) setWidth(element.clientWidth); };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const scale = Math.min(1, width / 590);
  const min = Math.floor(250 * scale);
  const max = Math.max(min, Math.min(640, width - Math.floor(340 * scale)));
  const list = clampPanelSize(sizes.list, min, max);
  return <div ref={container} className="wb-crm-columns feature-resizable-columns" style={{ '--feature-list-size': `${list}px` } as CSSProperties}>
    {children}
    <PanelResizeHandle axis="x" label="调整 CRM 客户列表宽度" value={list} min={min} max={max}
      onChange={(value) => setSizes({ list: value })} onCommit={(value) => commit({ list: value })} onReset={reset} style={{ left: list }} />
  </div>;
}

function CustomerDetail({ context }: { context: CrmCustomerContext }) {
  const [tab, setTab] = useState<'all' | 'followup' | 'call'>('all');
  const [visible, setVisible] = useState(30);
  const entries = crmTimeline(context).filter((entry) => tab === 'all' || entry.kind === tab);
  const tasks = crmContextTasks(context);
  const name = fieldText(context.customer, 'name') || 'CRM 客户';
  const level = customerGrade(fieldText(context.customer, 'level'));
  const profile = crmProfileRows(context.customer).filter(([label]) => !['姓名', '客户等级'].includes(label));
  const houseTargets = context.houseTargets.filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value));
  const masked = fieldText(context.customer, 'accessProfile', 'access_profile') === 'masked';
  return <>
    <header className="wb-customer-heading"><div><h2>{name}</h2><span className="wb-grade">{level}</span></div><span className="wb-muted">{masked ? '受限资料' : 'CRM 只读档案'}</span></header>
    <section className="wb-profile-section" aria-label="客户需求与资料">
      <dl className="wb-profile-grid">{profile.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      {!profile.length && <p className="wb-muted">CRM 尚未填写可显示的需求资料。</p>}
      {masked && <p className="wb-permission">当前账号仅能查看脱敏资料，不会尝试补全姓名或电话。</p>}
    </section>
    <section className="wb-customer-targets" aria-label="客户参拍标的">
      <div className="wb-section-heading"><h3>参拍标的</h3><span className="wb-muted">CRM 已关联房源 · 只读</span></div>
      {houseTargets.length ? <ul className="wb-target-list">{houseTargets.map((target, index) => {
        const title = fieldText(target, 'name', 'houseNameSnapshot', 'house_name_snapshot') || '未命名参拍标的';
        const details = [fieldText(target, 'auctionStatus', 'auction_status'), fieldText(target, 'auctionEndTime', 'auction_end_time', 'auctionDate', 'auction_date'), fieldText(target, 'houseItemId', 'house_item_id')].filter(Boolean);
        return <li key={fieldText(target, 'id') || `${title}-${index}`}><strong>{title}</strong><span>{details.length ? details.join(' · ') : 'CRM 暂未记录开拍状态或时间'}</span></li>;
      })}</ul> : <p className={masked ? 'wb-permission' : 'wb-muted'}>{masked ? '当前受限资料不包含参拍标的，不能据此判断客户没有参拍记录。' : 'CRM 当前没有返回可显示的参拍标的。'}</p>}
    </section>
    <section className="wb-customer-plans" aria-label="此客户的 CRM 计划">
      <div className="wb-section-heading"><h3>跟进计划</h3><span className="wb-muted">CRM 已有任务 · 只读</span></div>
      {tasks.length ? <ul className="wb-plan-list">{tasks.map((task) => {
        const state = taskState(task);
        return <li key={task.id}><span className={`wb-status wb-status-${state}`}>{taskStateLabels[state]}</span><strong>{task.title}</strong><time>{workbenchTime(task.dueAt, '未设置时间')}</time></li>;
      })}</ul> : <p className={masked ? 'wb-permission' : 'wb-muted'}>{masked ? '当前受限资料不包含跟进计划，不能据此判断没有计划。' : '此客户暂未设置 CRM 跟进计划。'}</p>}
    </section>
    <section className="wb-timeline-section" aria-label="客户跟进时间线">
      <div className="wb-section-heading"><h3>跟进时间线</h3><div className="wb-segments" role="group" aria-label="记录类型">
        {([{ id: 'all', label: '全部记录' }, { id: 'followup', label: '跟进' }, { id: 'call', label: '电话' }] as const).map((option) => <button type="button" key={option.id} aria-pressed={tab === option.id} onClick={() => { setTab(option.id); setVisible(30); }}>{option.label}</button>)}
      </div></div>
      {context.availability.followups === 'forbidden' && <p className="wb-permission" role="note">当前 CRM 账号没有跟进记录权限；不能据此判断“没有跟进”。</p>}
      {context.availability.calls === 'forbidden' && <p className="wb-permission" role="note">当前 CRM 账号没有电话记录权限；不能据此判断“没有电话”。</p>}
      <ol className="wb-timeline">{entries.slice(0, visible).map((entry) => <li key={entry.key}>
        <span className="wb-timeline-icon" aria-hidden="true">{entry.kind === 'call' ? <Call20Regular /> : <Chat20Regular />}</span>
        <div><header><strong>{entry.kind === 'call' ? '电话沟通' : '客户跟进'}</strong><time>{workbenchTime(entry.stamp)}</time>{entry.author && <span>{entry.author}</span>}</header>
          {entry.detail && <small>{entry.detail}</small>}<p>{entry.text || (entry.transcript ? '已附通话转写。' : '本条记录未填写文字备注。')}</p>
          {entry.transcript && entry.transcript !== entry.text && <details><summary>查看通话转写</summary><p>{entry.transcript}</p></details>}
        </div>
      </li>)}</ol>
      {!entries.length && <p className="wb-muted">当前分类没有可显示的记录。</p>}
      {entries.length > visible && <Button appearance="subtle" onClick={() => setVisible((value) => value + 30)}>继续显示 {Math.min(30, entries.length - visible)} 条</Button>}
    </section>
    <footer className="wb-source-footnote">来源 {sourceHost(context.sourceBaseUrl)} · 读取于 {workbenchTime(context.fetchedAt)}。不会凭微信昵称自动关联客户。</footer>
  </>;
}

export function CrmWorkspace({ onNotice, onOpenSettings, initialCustomerId, navigationRevision }: CrmWorkspaceProps) {
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState<CrmCustomerListQuery>({ stage: 'active', page: 1, limit: 50, sort: 'next', order: 'asc' });
  const [result, setResult] = useState<CrmCustomerPage | null>(null);
  const [listBusy, setListBusy] = useState(true);
  const [listError, setListError] = useState('');
  const [selectedId, setSelectedId] = useState<number | null>(initialCustomerId || null);
  const [detail, setDetail] = useState<ContextState>({ id: null, value: null, busy: false, error: '' });
  const [revision, setRevision] = useState(0);
  const listGeneration = useRef(0);
  const detailGeneration = useRef(0);
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => { if (initialCustomerId) setSelectedId(initialCustomerId); }, [initialCustomerId, navigationRevision]);
  useEffect(() => {
    const ticket = ++listGeneration.current;
    setListBusy(true); setListError(''); setResult(null);
    void window.salesCopilot.listCrmCustomers(query).then(featureValue).then((page) => {
      if (ticket !== listGeneration.current) return;
      setResult(page); setSelectedId((current) => current ?? page.customers[0]?.id ?? null);
    }).catch((failure) => { if (ticket === listGeneration.current) setListError(failureMessage(failure)); })
      .finally(() => { if (ticket === listGeneration.current) setListBusy(false); });
    return () => { listGeneration.current += 1; };
  }, [query, revision]);
  useEffect(() => {
    const ticket = ++detailGeneration.current;
    if (!selectedId) { setDetail({ id: null, value: null, busy: false, error: '' }); return; }
    setDetail({ id: selectedId, value: null, busy: true, error: '' });
    void window.salesCopilot.getCrmCustomerContext(selectedId).then(featureValue).then((context) => {
      if (ticket !== detailGeneration.current) return;
      if (Number(fieldText(context.customer, 'id')) !== selectedId) throw new Error('CRM 返回的客户身份不一致，已停止显示。');
      setDetail({ id: selectedId, value: context, busy: false, error: '' });
    }).catch((failure) => { if (ticket === detailGeneration.current) setDetail({ id: selectedId, value: null, busy: false, error: failureMessage(failure) }); });
    return () => { detailGeneration.current += 1; };
  }, [selectedId, revision]);

  function changeQuery(next: Partial<CrmCustomerListQuery>) {
    listGeneration.current += 1; detailGeneration.current += 1;
    setSelectedId(null); setDetail({ id: null, value: null, busy: false, error: '' });
    setQuery((current) => ({ ...current, ...next }));
  }
  function selectCustomer(customer: CrmCustomerSummary) {
    if (selectedId === customer.id) return;
    detailGeneration.current += 1;
    setDetail({ id: customer.id, value: null, busy: true, error: '' }); setSelectedId(customer.id);
  }
  const facts = result ? pageCustomerFacts(result.customers) : null;
  const selectedContext = detail.id === selectedId ? detail.value : null;
  const busy = detail.busy || (selectedId !== null && detail.id !== selectedId);
  const pageCount = result ? Math.max(1, Math.ceil(result.total / result.limit)) : null;
  return <main className="wb-page wb-crm-page">
    <header className="wb-page-heading"><div><h1>客户跟进</h1><p>当前 CRM 账号可见客户 · {result ? `${sourceHost(result.sourceBaseUrl)} · ${workbenchTime(result.fetchedAt)} 更新` : '直接读取 CRM，保留原有账号权限'}</p></div>
      <Button appearance="subtle" icon={<ArrowSync20Regular />} disabled={listBusy} onClick={() => { setRevision((value) => value + 1); onNotice('正在重新读取 CRM 客户和记录。'); }}>刷新</Button>
    </header>
    <div className="wb-metrics wb-crm-metrics" aria-label="客户列表统计">
      <div><span>筛选客户</span><strong>{result?.total ?? '—'}</strong><small>当前分类</small></div>
      <div><span>待跟进</span><strong>{facts?.due ?? '—'}</strong><small>本页 · 今天与逾期</small></div>
      <div><span>下次时间待定</span><strong>{facts?.unscheduled ?? '—'}</strong><small>本页 · 未设或待确认</small></div>
    </div>
    <div className="wb-crm-toolbar"><div className="wb-segments" role="group" aria-label="客户阶段">{stages.map((stage) => <button type="button" key={stage.id} aria-pressed={query.stage === stage.id} onClick={() => changeQuery({ stage: stage.id, page: 1 })}>{stage.label}</button>)}</div>
      <form className="wb-search" onSubmit={(event) => { event.preventDefault(); changeQuery({ search: search.trim(), page: 1 }); }}>
        <label><span className="wb-sr-only">搜索客户姓名或电话</span><Search20Regular aria-hidden="true" /><input type="search" maxLength={200} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索姓名或电话" /></label><Button type="submit" disabled={listBusy}>搜索</Button>
      </form>
      <label className="wb-sort"><span>排序</span><select value={query.sort || 'next'} onChange={(event) => { const sort = event.target.value as CrmCustomerListQuery['sort']; changeQuery({ sort, order: sort === 'next' ? 'asc' : 'desc', page: 1 }); }}><option value="next">下次跟进</option><option value="last">最近跟进</option><option value="updated">最近更新</option></select></label>
    </div>
    {listError && <div className="wb-error" role="alert"><strong>CRM 客户暂时读取失败</strong><p>{listError}</p><Button onClick={() => setRevision((value) => value + 1)}>重试</Button><Button appearance="subtle" onClick={onOpenSettings}>检查 CRM 连接与权限</Button></div>}
    <CrmColumns><section className="wb-customer-list" aria-label="CRM 客户列表">
      <div className="wb-list-summary" role="status">{listBusy ? '正在读取客户…' : result ? `${result.total} 位客户 · 第 ${result.page} / ${pageCount} 页` : '尚未读取客户'}</div>
      <div className="wb-customer-scroll" role="listbox" aria-label="选择客户查看跟进" aria-busy={listBusy}>
        {listBusy && <div className="wb-loading" role="status"><span>正在读取当前账号的客户列表…</span><div /><div /><div /><div /></div>}
        {result?.customers.map((customer, index) => <button type="button" role="option" aria-selected={selectedId === customer.id} tabIndex={selectedId === customer.id || (!result.customers.some((item) => item.id === selectedId) && index === 0) ? 0 : -1}
          key={customer.id} ref={(node) => { rowRefs.current[index] = node; }} className="wb-customer-row" onClick={() => selectCustomer(customer)} onKeyDown={(event) => {
            const next = nextCustomerIndex(result.customers.length, index, event.key);
            if (next !== null) { event.preventDefault(); rowRefs.current[next]?.focus(); selectCustomer(result.customers[next]); }
          }}>
          <span className="wb-customer-row-heading"><strong>{customer.name || 'CRM 客户'}</strong><span className="wb-grade">{customerGrade(customer.level)}</span></span>
          <span className="wb-customer-contact">{customer.phone || '未填写电话'}{customer.ownerName && ` · ${customer.ownerName}`}</span>
          <span className="wb-customer-excerpt">{customer.accessProfile === 'masked' ? '当前权限仅可查看脱敏信息' : customer.lastFollowupContent || '尚无文字跟进'}</span>
          <span className="wb-customer-dates"><span>最近 {workbenchTime(customer.lastFollowupAt, '未跟进')}</span><span className={taskState({ dueAt: customer.nextFollowupAt, done: false }) === 'overdue' ? 'wb-overdue' : ''}>下次 {workbenchTime(customer.nextFollowupAt, '未安排')}</span></span>
        </button>)}
        {!listBusy && result && !result.customers.length && <div className="wb-empty"><strong>当前分类没有客户</strong><p>可更换阶段或清空搜索；这里只显示 CRM 允许当前账号读取的资料。</p><Button onClick={() => { setSearch(''); changeQuery({ search: '', stage: 'active', page: 1 }); }}>查看跟进中客户</Button></div>}
        {!listBusy && !result && <div className="wb-empty"><strong>CRM 客户暂时不可用</strong><p>上方会显示实际失败原因。检查连接后重新读取，不会将读取失败当作没有客户。</p><Button onClick={onOpenSettings}>检查 CRM 连接</Button></div>}
      </div>
      <footer className="wb-pagination"><Button appearance="subtle" icon={<ChevronLeft20Regular />} disabled={listBusy || !result || result.page <= 1} onClick={() => changeQuery({ page: Math.max(1, (result?.page || 1) - 1) })}>上一页</Button><span>{result ? `${result.customers.length} / ${result.total}` : '—'}</span><Button appearance="subtle" icon={<ChevronRight20Regular />} iconPosition="after" disabled={listBusy || !result?.hasMore} onClick={() => changeQuery({ page: (result?.page || 1) + 1 })}>下一页</Button></footer>
    </section><section className="wb-customer-detail" aria-label="客户跟进详情" aria-busy={busy}>
      {busy ? <div className="wb-loading" role="status"><span>正在读取客户需求、电话与跟进记录…</span><div /><div /><div /></div> : detail.error && detail.id === selectedId ? <div className="wb-error" role="alert"><strong>这位客户的记录暂时不可用</strong><p>{detail.error}</p><Button onClick={() => setRevision((value) => value + 1)}>重新读取</Button><Button appearance="subtle" onClick={onOpenSettings}>检查连接与权限</Button></div> : selectedContext ? <CustomerDetail key={selectedId} context={selectedContext} /> : <div className="wb-empty"><h2>先选一位客户</h2><p>在左侧查看最近跟进与下次计划。选择后，这里会汇总真实 CRM 需求、电话及跟进时间线。</p><small>方向键切换客户 · Enter 确认 · 不会自动修改 CRM</small></div>}
    </section></CrmColumns>
  </main>;
}
