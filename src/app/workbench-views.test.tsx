import { Children, isValidElement, type ComponentProps, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeatureBridge } from '../shared/feature-bridge-contracts';
import type { CrmCustomerContext, CrmCustomerPage, CrmCustomerSummary, CrmTask, CrmWorkspaceOverview } from '../shared/integration-contracts';
import type { WechatLiveSnapshot } from '../shared/contracts';
import { CrmWorkspace } from './CrmWorkspace';
import { DashboardView } from './DashboardView';
import { WorkTrendChart } from './dashboard-charts';

const hooks = vi.hoisted(() => ({ useState: vi.fn(), useRef: vi.fn(), useEffect: vi.fn(), useMemo: vi.fn() }));
vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(), ...hooks }));
vi.mock('@fluentui/react-components', async () => {
  const { createElement } = await import('react');
  return { Button: (props: ComponentProps<'button'> & { icon?: ReactNode }) => createElement('button', { disabled: props.disabled, type: props.type, onClick: props.onClick, 'aria-label': props['aria-label'] }, props.icon, props.children) };
});
vi.mock('./wechat-media', async () => { const { createElement } = await import('react'); return { PrivateImage: ({ alt }: { alt: string }) => createElement('span', { role: 'img', 'aria-label': alt }) }; });

const customer: CrmCustomerSummary = { id: 11, name: '合成测试客户甲', phone: 'masked-phone', ownerId: 1, ownerName: '本人', accessProfile: 'full', level: 'A类', area: '购房区域原文', budget: '预算原文', location: '位置补充原文', firstContact: '', customerType: '', lastFollowupAt: '2026-08-31T09:00:00+08:00', lastFollowupContent: '跟进原文', nextFollowupAt: '', followupCount: 1, isVisited: false, isDeal: false, visitAt: '', dealSignedAt: '', updatedAt: '', isFavorite: false, tags: '' };
const page: CrmCustomerPage = { customers: [customer], total: 83, page: 1, limit: 50, hasMore: true, fetchedAt: '2026-08-31T10:00:00+08:00', sourceBaseUrl: 'https://crm.example.test' };
const context: CrmCustomerContext = { customer: { id: 11, name: '合成测试客户甲', phone: 'masked-phone', budget: '预算原文', customerType: '改善自住', targetProperty: '上城区住宅', source: '视频号' }, followups: [{ id: 1, content: '客户的真实字段测试', followupAt: '2026-08-31T09:00:00+08:00' }], calls: [], tasks: [{ id: 4, title: '合成跟进任务', dueAt: '2026-09-01T09:00:00+08:00', done: 0 }], houseTargets: [{ id: 9, name: '合成参拍标的', auctionStatus: '待拍', auctionEndTime: '2026-09-09 10:00', houseItemId: 'FA-TEST' }], fetchedAt: page.fetchedAt, sourceBaseUrl: page.sourceBaseUrl, availability: { followups: 'available', calls: 'available' } };
const snapshot: WechatLiveSnapshot = { revision: 1, accountKey: 'test-account', status: { state: 'ready', monitoring: true, detail: '测试就绪', updatedAt: page.fetchedAt }, conversations: [{ contactKey: 'contact-a', displayName: '合成单聊', kind: 'contact', unreadCount: 2 }, { contactKey: 'official', displayName: '不显示的公众号', kind: 'official', unreadCount: 5 }] };
const overview: CrmWorkspaceOverview = { stats: { totalCustomers: 83, todayTasks: 1, overdueTasks: 0, monthNew: 3, todayNew: 0, weekVisited: 0, monthVisited: 0, monthDeal: 0 }, today: [{ id: 4, customerId: 11, title: '合成工作计划', dueAt: page.fetchedAt, done: false, doneAt: null, source: 'manual', customerName: customer.name, customerLevel: 'A类', accessProfile: 'full' }], overdue: [], future: [], priorityCustomers: [customer], staleCustomers: [], staleCount: 0, levelStats: [{ level: 'A', count: 1 }], workTrend: [{ date: '2026-08-31', label: '8/31', phone: 2, acquired: 0, interview: 0, visited: 0, deal: 0 }], scopeLabel: '当前测试账号', metricNotes: ['合成统计口径'], fetchedAt: page.fetchedAt, sourceBaseUrl: page.sourceBaseUrl };

const crmProps = () => ({ onNotice: vi.fn(), onOpenSettings: vi.fn() });
const dashboardProps = () => ({ ...crmProps(), snapshot, onOpenCustomer: vi.fn(), onOpenConversation: vi.fn() });
function states(overrides: Record<number, unknown> = {}) {
  let index = 0; const setters: Array<ReturnType<typeof vi.fn>> = [];
  hooks.useState.mockImplementation((initial: unknown) => {
    const current = index++; const setter = vi.fn(); setters[current] = setter;
    return [current in overrides ? overrides[current] : typeof initial === 'function' ? initial() : initial, setter];
  });
  return setters;
}
function elements<T extends { children?: ReactNode }>(node: ReactNode, predicate: (item: ReactElement<T>) => boolean): Array<ReactElement<T>> {
  if (!isValidElement<T>(node)) return [];
  return [...(predicate(node) ? [node] : []), ...Children.toArray(node.props.children).flatMap((child) => elements(child, predicate))];
}
async function flush() { for (let i = 0; i < 12; i += 1) await Promise.resolve(); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
function bridge(value: Partial<FeatureBridge>) { vi.stubGlobal('window', { salesCopilot: value }); }

beforeEach(() => {
  vi.clearAllMocks(); states();
  hooks.useRef.mockImplementation((value: unknown) => ({ current: value }));
  hooks.useEffect.mockImplementation(() => undefined); hooks.useMemo.mockImplementation((factory: () => unknown) => factory());
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('CRM follow-up workspace', () => {
  it('reapplies a dashboard customer target on every direct navigation request', () => {
    const setters = states({ 5: 22 });
    CrmWorkspace({ ...crmProps(), initialCustomerId: 11, navigationRevision: 4 });
    expect(hooks.useEffect.mock.calls[0][1]).toEqual([11, 4]);
    hooks.useEffect.mock.calls[0][0]();
    expect(setters[5]).toHaveBeenCalledWith(11);
  });
  it('automatically loads the first page without login or a search click', async () => {
    const list = vi.fn().mockResolvedValue({ ok: true, value: page }); const login = vi.fn();
    bridge({ listCrmCustomers: list, loginCrm: login }); const setters = states();
    CrmWorkspace(crmProps()); hooks.useEffect.mock.calls[1][0](); await flush();
    expect(list).toHaveBeenCalledWith({ stage: 'active', page: 1, limit: 50, sort: 'next', order: 'asc' });
    expect(setters[2]).toHaveBeenCalledWith(page); expect(login).not.toHaveBeenCalled();
  });
  it('ignores a list response after the query is abandoned', async () => {
    const pending = deferred<{ ok: true; value: CrmCustomerPage }>(); bridge({ listCrmCustomers: vi.fn().mockReturnValue(pending.promise) });
    const setters = states(); CrmWorkspace(crmProps()); const cleanup = hooks.useEffect.mock.calls[1][0](); cleanup();
    pending.resolve({ ok: true, value: page }); await flush();
    expect(setters[2]).not.toHaveBeenCalledWith(page);
  });
  it('discards late customer details on selection cleanup', async () => {
    const pending = deferred<{ ok: true; value: CrmCustomerContext }>(); bridge({ getCrmCustomerContext: vi.fn().mockReturnValue(pending.promise) });
    const setters = states({ 5: 11 }); CrmWorkspace(crmProps()); const cleanup = hooks.useEffect.mock.calls[2][0](); cleanup();
    pending.resolve({ ok: true, value: context }); await flush();
    expect(setters[6]).not.toHaveBeenCalledWith(expect.objectContaining({ value: context }));
  });
  it('rejects a response with another customer id', async () => {
    bridge({ getCrmCustomerContext: vi.fn().mockResolvedValue({ ok: true, value: { ...context, customer: { id: 22, name: '另一客户' } } }) });
    const setters = states({ 5: 11 }); CrmWorkspace(crmProps()); hooks.useEffect.mock.calls[2][0](); await flush();
    expect(setters[6]).toHaveBeenLastCalledWith(expect.objectContaining({ id: 11, value: null, error: expect.stringContaining('身份不一致') }));
  });
  it('never renders previous details while a different customer is selected', () => {
    states({ 2: page, 3: false, 5: 22, 6: { id: 11, value: context, busy: false, error: '' } });
    const html = renderToStaticMarkup(CrmWorkspace(crmProps()));
    expect(html).not.toContain('客户的真实字段测试'); expect(html).toContain('正在读取客户需求');
  });
  it('shows real timeline, existing tasks and an explicitly page-scoped count', () => {
    states({ 2: page, 3: false, 5: 11, 6: { id: 11, value: context, busy: false, error: '' } });
    const html = renderToStaticMarkup(CrmWorkspace(crmProps()));
    expect(html).toContain('客户的真实字段测试'); expect(html).toContain('合成跟进任务'); expect(html).toContain('本页 · 未设或待确认');
    expect(html).toContain('改善自住'); expect(html).toContain('上城区住宅'); expect(html).toContain('合成参拍标的'); expect(html).toContain('FA-TEST');
    expect(html).toContain('role="listbox"'); expect(html).toContain('aria-selected="true"'); expect(html).toContain('tabindex="0"');
  });
  it('shows permission-denied records as unknown rather than empty', () => {
    states({ 2: page, 3: false, 5: 11, 6: { id: 11, value: { ...context, followups: [{ content: 'forbidden-content' }], availability: { followups: 'forbidden', calls: 'forbidden' } }, busy: false, error: '' } });
    const html = renderToStaticMarkup(CrmWorkspace(crmProps()));
    expect(html).toContain('没有跟进记录权限'); expect(html).toContain('没有电话记录权限'); expect(html).not.toContain('forbidden-content');
  });
  it('supports actual visited and deal filters and invalidates old detail immediately', () => {
    const setters = states({ 2: page, 3: false }); const tree = CrmWorkspace(crmProps());
    const buttons = elements<ComponentProps<'button'>>(tree, (item) => item.type === 'button');
    buttons.find((button) => button.props.children === '已成交')?.props.onClick?.({} as never);
    const updater = setters[1].mock.calls[0][0];
    expect(updater({ stage: 'active', page: 2, limit: 50 })).toEqual({ stage: 'deal', page: 1, limit: 50 });
    expect(setters[5]).toHaveBeenCalledWith(null);
  });
  it('does not claim a network error means no customers or no configuration', () => {
    states({ 3: false, 4: '网络超时' }); const html = renderToStaticMarkup(CrmWorkspace(crmProps()));
    expect(html).toContain('网络超时'); expect(html).toContain('—'); expect(html).not.toContain('先连接你的 CRM'); expect(html).not.toContain('0 位客户');
  });
  it('changes selection using the keyboard while preventing page scrolling', () => {
    const second = { ...customer, id: 22, name: '合成测试客户乙' };
    const setters = states({ 2: { ...page, customers: [customer, second] }, 3: false, 5: 11 });
    const tree = CrmWorkspace(crmProps()); const rows = elements<ComponentProps<'button'>>(tree, (item) => item.props.role === 'option');
    const preventDefault = vi.fn(); rows[0].props.onKeyDown?.({ key: 'ArrowDown', preventDefault } as never);
    expect(preventDefault).toHaveBeenCalledOnce(); expect(setters[5]).toHaveBeenCalledWith(22);
  });
});

describe('task-first dashboard', () => {
  it('loads CRM once on entry and cancels the stale callback on unmount', async () => {
    const pending = deferred<{ ok: true; value: CrmWorkspaceOverview }>(); const get = vi.fn().mockReturnValue(pending.promise);
    bridge({ getCrmWorkspaceOverview: get }); const setters = states(); DashboardView(dashboardProps());
    const cleanup = hooks.useEffect.mock.calls[0][0](); cleanup(); pending.resolve({ ok: true, value: overview }); await flush();
    expect(get).toHaveBeenCalledOnce(); expect(setters[0]).not.toHaveBeenCalledWith(overview);
  });
  it('keeps unknown CRM statistics visibly different from a real zero', () => {
    states({ 1: false, 2: '请先登录 CRM' }); const unknown = renderToStaticMarkup(DashboardView(dashboardProps()));
    expect(unknown).toContain('未知数据以“—”显示');
    states({ 0: overview, 1: false }); const actual = renderToStaticMarkup(DashboardView(dashboardProps()));
    expect(actual).toContain('>0</strong>'); expect(actual).toContain('>83</strong>');
  });
  it('excludes official and hidden unread chats and distinguishes metadata from CRM tasks', () => {
    states({ 0: overview, 1: false }); const html = renderToStaticMarkup(DashboardView({ ...dashboardProps(), hiddenContactKeys: ['contact-a'] }));
    expect(html).not.toContain('不显示的公众号'); expect(html).not.toContain('合成单聊'); expect(html).toContain('仅微信未读标记'); expect(html).toContain('合成工作计划');
  });
  it('renders daily report charts with source scope and an exact-value table', () => {
    states({ 0: overview, 1: false }); const html = renderToStaticMarkup(DashboardView(dashboardProps()));
    expect(html).toContain('来源：CRM 工作日报'); expect(html).toContain('合成统计口径'); expect(html).toContain('scope="col"'); expect(html).toContain('8/31');
    expect(html).toContain('查看日报原数值'); expect(html).toContain('未填日报'); expect(html).not.toContain('转化率');
  });
  it('supports an explicit local-plan slot without turning it into CRM data', () => {
    states({ 0: overview, 1: false }); const html = renderToStaticMarkup(DashboardView({ ...dashboardProps(), localPlans: <section>仅本机计划测试</section> }));
    expect(html).toContain('仅本机计划测试'); expect(html).toContain('CRM 已有计划');
  });
  it('passes the unchanged CRM report and fetch time to the chart, separate from chat counts', () => {
    states({ 0: overview, 1: false }); const before = structuredClone(overview); const tree = DashboardView(dashboardProps());
    const chart = elements<{ children?: ReactNode; rows?: unknown; fetchedAt?: string; available?: boolean; busy?: boolean }>(tree, (item) => item.type === WorkTrendChart)[0];
    expect(chart.props).toMatchObject({ rows: overview.workTrend, fetchedAt: overview.fetchedAt, available: true, busy: false });
    expect(chart.props.rows).toBe(overview.workTrend); expect(overview).toEqual(before);
  });
  it('does not expose old rows or fabricate chart values after CRM access fails', () => {
    states({ 0: null, 1: false, 2: '当前 CRM 账号没有客户工作台查看权限' });
    const html = renderToStaticMarkup(DashboardView(dashboardProps()));
    expect(html).toContain('没有客户工作台查看权限'); expect(html).toContain('工作日报暂不可用'); expect(html).toContain('等级分布暂不可用');
    expect(html).not.toContain('合成工作计划'); expect(html).not.toContain('当前没有逾期任务');
    expect(html).toContain('合成单聊');
  });
  it('opens the exact linked CRM customer when a task is clicked, without a CRM write', () => {
    states({ 0: overview, 1: false }); const props = dashboardProps(); const tree = DashboardView(props);
    type TaskProps = { children?: ReactNode; task: CrmTask; onOpenCustomer: (id: number) => void };
    const row = elements<TaskProps>(tree, (item) => item.props.task?.id === 4)[0];
    const rendered = (row.type as (value: TaskProps) => ReactNode)(row.props);
    const button = elements<ComponentProps<'button'>>(rendered, (item) => item.type === 'button')[0];
    button.props.onClick?.({} as never); expect(props.onOpenCustomer).toHaveBeenCalledWith(11); expect(props.onOpenConversation).not.toHaveBeenCalled();
  });
  it('makes task metrics jump to the corresponding task group rather than pretending to complete tasks', () => {
    const scrollIntoView = vi.fn(); hooks.useRef.mockReturnValue({ current: { scrollIntoView } });
    const setters = states({ 0: overview, 1: false }); const tree = DashboardView(dashboardProps());
    const row = elements<ComponentProps<'div'>>(tree, (item) => item.props.className === 'wb-metrics wb-dashboard-metrics')[0];
    const buttons = elements<ComponentProps<'button'>>(row, (item) => item.type === 'button');
    buttons[1].props.onClick?.({} as never);
    expect(setters[4]).toHaveBeenCalledWith('overdue'); expect(setters[5]).toHaveBeenCalledWith(16);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start', behavior: 'auto' });
  });
  it('keeps masked priority text private and does not use it as chart data', () => {
    states({ 0: { ...overview, priorityCustomers: [{ ...customer, accessProfile: 'masked', lastFollowupContent: 'masked-text-do-not-show' }] }, 1: false });
    const html = renderToStaticMarkup(DashboardView(dashboardProps()));
    expect(html).toContain('当前权限仅显示脱敏资料'); expect(html).not.toContain('masked-text-do-not-show');
  });
});
