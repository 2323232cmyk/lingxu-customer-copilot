import type { CrmCustomerCandidate, CrmCustomerContext, CrmCustomerListQuery, CrmCustomerPage, CrmCustomerSummary, CrmTask, CrmTaskList, CrmTaskQuery, CrmWorkspaceOverview } from '../../shared/integration-contracts';
import { crmCustomerListInput, crmTaskQueryInput, isRecord, positiveId } from '../services/feature-input';
import { validateEndpoint } from '../services/integration-settings';

export type { CrmCustomerCandidate } from '../../shared/integration-contracts';

export interface CrmLoginInput {
  username: string;
  password: string;
  deviceId: string;
  deviceName: string;
}

export type CrmLoginResult =
  | { kind: 'authenticated' }
  | { kind: 'verification-required'; challengeId: number; expiresAt: string };

export interface CrmConnector {
  login(input: CrmLoginInput): Promise<CrmLoginResult>;
  verifyDevice(challengeId: number, code: string): Promise<void>;
  getCurrentUser(): Promise<Record<string, unknown>>;
  searchCustomers(query: string): Promise<CrmCustomerCandidate[]>;
  listCustomers(query: CrmCustomerListQuery): Promise<CrmCustomerPage>;
  getWorkspaceOverview(): Promise<CrmWorkspaceOverview>;
  listTasks(query: CrmTaskQuery): Promise<CrmTaskList>;
  getCustomerContext(customerId: number, options?: { forExport?: boolean }): Promise<CrmCustomerContext>;
  searchApprovedKnowledge(query: string): Promise<Record<string, unknown>[]>;
}

interface CrmConnectorOptions {
  fetch?: typeof fetch;
  token?: string | null;
  allowInsecureHttp?: boolean;
  onToken?: (token: string | null) => void;
  timeoutMs?: number;
}

export class CrmHttpError extends Error {
  constructor(readonly status: number, detail?: string) { super('读取 CRM 失败：' + status + (detail ? '，' + detail : status === 401 ? '，请重新登录' : status === 403 ? '，当前账号无权读取这项资料' : '')); }
}

const crmCount = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('CRM统计响应格式不正确，未显示不完整统计');
  return value;
};
const crmText = (value: unknown): string => {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new Error('CRM文字字段响应格式不正确');
  return value;
};
const crmRows = (value: unknown): Record<string, unknown>[] => {
  if (!Array.isArray(value) || value.some((row) => !isRecord(row))) throw new Error('CRM列表响应格式不正确，未将错误当作空列表');
  return value as Record<string, unknown>[];
};
const crmFlag = (value: unknown): boolean => {
  if (value === true || value === 1) return true;
  if (value === false || value === 0 || value == null) return false;
  throw new Error('CRM状态字段响应格式不正确');
};
const crmProfile = (value: unknown): 'full' | 'masked' => {
  if (value !== 'full' && value !== 'masked') throw new Error('CRM未返回有效的客户访问范围');
  return value;
};
const customerSummary = (row: Record<string, unknown>): CrmCustomerSummary => {
  if (!positiveId(row.id) || (row.ownerId != null && !positiveId(row.ownerId))) throw new Error('CRM客户身份响应格式不正确');
  const accessProfile = crmProfile(row.accessProfile);
  const masked = accessProfile === 'masked';
  return {
    id: row.id, name: masked ? '已隐藏' : crmText(row.name), phone: masked ? '' : crmText(row.phone),
    level: crmText(row.level), ownerName: crmText(row.ownerName), ownerId: row.ownerId == null ? null : row.ownerId as number, accessProfile,
    area: crmText(row.area), budget: crmText(row.budget), location: masked ? '' : crmText(row.location),
    firstContact: masked ? '' : crmText(row.firstContact), customerType: crmText(row.customerType),
    lastFollowupAt: crmText(row.lastFollowupAt), lastFollowupContent: masked ? '' : crmText(row.lastFollowupContent), nextFollowupAt: crmText(row.nextFollowupAt),
    followupCount: row.followupCount == null ? null : crmCount(row.followupCount), isVisited: crmFlag(row.isVisited), isDeal: crmFlag(row.isDeal),
    visitAt: crmText(row.visitAt), dealSignedAt: crmText(row.dealSignedAt), updatedAt: crmText(row.updatedAt), isFavorite: crmFlag(row.isFavorite), tags: crmText(row.tags),
  };
};
const taskSummary = (row: Record<string, unknown>): CrmTask => {
  if (!positiveId(row.id) || !positiveId(row.customerId)) throw new Error('CRM任务身份响应格式不正确');
  const accessProfile = crmProfile(row.accessProfile);
  return { id: row.id, customerId: row.customerId, title: accessProfile === 'masked' ? '已隐藏' : crmText(row.title),
    dueAt: crmText(row.dueAt), done: crmFlag(row.done), doneAt: row.doneAt == null ? null : crmText(row.doneAt), source: crmText(row.source),
    customerName: accessProfile === 'masked' ? '已隐藏' : crmText(row.customerName), customerLevel: crmText(row.customerLevel), accessProfile };
};

export class ReadOnlyCrmConnector implements CrmConnector {
  private token: string | null;
  private pendingDevice?: { id: string; challengeId: number };
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;

  constructor(baseUrl: string, private readonly options: CrmConnectorOptions = {}) {
    this.baseUrl = validateEndpoint(baseUrl, options.allowInsecureHttp).replace(/\/api$/, '');
    this.fetcher = options.fetch ?? fetch;
    this.token = options.token ?? null;
  }

  async login(input: CrmLoginInput): Promise<CrmLoginResult> {
    if (!input.username.trim() || !input.password || input.username.length > 254 || input.password.length > 4096) throw new Error('请填写正确的 CRM 用户名和密码');
    this.setToken(null);
    this.pendingDevice = undefined;
    if (!/^[a-zA-Z0-9._:-]{8,128}$/.test(input.deviceId)) throw new Error('CRM设备标识无效，请重新启动软件');
    const response = await this.authRequest('/api/auth/login', input);
    if (typeof response.token === 'string' && response.token.length <= 8192 && response.token) {
      this.setToken(response.token);
      return { kind: 'authenticated' };
    }
    if (response.code === 'DEVICE_VERIFICATION_REQUIRED' && Number.isInteger(response.challengeId)
      && Number(response.challengeId) > 0 && typeof response.expiresAt === 'string') {
      this.pendingDevice = { id: input.deviceId, challengeId: Number(response.challengeId) };
      return { kind: 'verification-required', challengeId: Number(response.challengeId), expiresAt: response.expiresAt };
    }
    throw new Error('CRM登录失败，请核对账号或设备验证状态');
  }

  async verifyDevice(challengeId: number, code: string): Promise<void> {
    if (!Number.isInteger(challengeId) || challengeId <= 0 || !/^\d{6}$/.test(code)) throw new Error('请输入 6 位设备验证码');
    if (this.pendingDevice?.challengeId !== challengeId) throw new Error('本次设备验证已失效，请重新登录 CRM');
    const response = await this.authRequest('/api/auth/device/verify', { challengeId, code });
    if (typeof response.token !== 'string' || !response.token || response.token.length > 8192) throw new Error('设备验证失败，请重新登录');
    this.setToken(response.token);
    this.pendingDevice = undefined;
  }

  async getCurrentUser(): Promise<Record<string, unknown>> {
    const payload = await this.request<{ user?: Record<string, unknown> }>('/api/auth/me');
    if (!payload.user || typeof payload.user !== 'object') throw new Error('CRM用户响应格式不正确');
    return payload.user;
  }

  async searchCustomers(query: string): Promise<CrmCustomerCandidate[]> {
    if (typeof query !== 'string' || query.length > 200) throw new Error('搜索内容过长');
    const params = new URLSearchParams({ search: query.trim(), page: '1', limit: '30' });
    const payload = await this.request<{ customers?: Record<string, unknown>[] }>('/api/customers?' + params);
    return (Array.isArray(payload.customers) ? payload.customers : []).filter((row) => Number.isInteger(row.id) && Number(row.id) > 0).map((row) => ({
      id: Number(row.id), name: String(row.name ?? ''), phone: String(row.phone ?? ''),
      level: String(row.level ?? ''), ownerName: String(row.ownerName ?? ''),
    }));
  }

  async listCustomers(input: CrmCustomerListQuery): Promise<CrmCustomerPage> {
    const query = crmCustomerListInput(input);
    const params = new URLSearchParams({ search: query.search, page: String(query.page), limit: String(query.limit), sort: query.sort, order: query.order });
    if (query.stage === 'visited') params.set('stage', 'visited');
    if (query.stage === 'deal') params.set('deal', '1');
    if (query.level) params.set('level', query.level);
    const payload = await this.request<Record<string, unknown>>('/api/customers?' + params);
    const total = crmCount(payload.total);
    if (payload.page !== query.page || payload.limit !== query.limit) throw new Error('CRM分页响应与请求不一致，请刷新后重试');
    const customers = crmRows(payload.customers).map(customerSummary);
    if (customers.length > Math.min(query.limit, Math.max(0, total - (query.page - 1) * query.limit))
      || new Set(customers.map((customer) => customer.id)).size !== customers.length) throw new Error('CRM客户分页响应格式不正确');
    return { customers, total, page: query.page, limit: query.limit, hasMore: query.page * query.limit < total,
      fetchedAt: new Date().toISOString(), sourceBaseUrl: this.baseUrl };
  }

  async listTasks(input: CrmTaskQuery): Promise<CrmTaskList> {
    const query = crmTaskQueryInput(input);
    const params = new URLSearchParams({ scope: query.scope, done: query.done === 'open' ? '0' : query.done === 'done' ? '1' : 'all' });
    if (query.ownOnly) params.set('own', '1');
    const payload = await this.request<Record<string, unknown>>('/api/tasks?' + params);
    return { tasks: crmRows(payload.tasks).map(taskSummary), scope: query.scope, ownOnly: query.ownOnly,
      fetchedAt: new Date().toISOString(), sourceBaseUrl: this.baseUrl };
  }

  async getWorkspaceOverview(): Promise<CrmWorkspaceOverview> {
    // The CRM dashboard route only requires authentication; enforce its customer permission before requesting statistics.
    const user = await this.getCurrentUser();
    const permissions = Array.isArray(user.permissions) ? user.permissions : [];
    if (user.role !== 'admin' && !permissions.includes('*') && !permissions.includes('customers.view')) throw new Error('当前 CRM 账号没有客户工作台查看权限');
    const payload = await this.request<Record<string, unknown>>('/api/dashboard');
    if (!isRecord(payload.stats)) throw new Error('CRM工作台未返回有效统计');
    const stats: CrmWorkspaceOverview['stats'] = {
      totalCustomers: crmCount(payload.stats.totalCustomers), todayTasks: crmCount(payload.stats.todayTasks), overdueTasks: crmCount(payload.stats.overdueTasks),
      monthNew: crmCount(payload.stats.monthNew), todayNew: crmCount(payload.stats.todayNew), weekVisited: crmCount(payload.stats.weekVisited),
      monthVisited: crmCount(payload.stats.monthVisited), monthDeal: crmCount(payload.stats.monthDeal),
    };
    return {
      stats, today: crmRows(payload.today).map(taskSummary), overdue: crmRows(payload.overdue).map(taskSummary), future: crmRows(payload.future).map(taskSummary),
      priorityCustomers: crmRows(payload.priorityCustomers).map(customerSummary), staleCustomers: crmRows(payload.staleCustomers).map(customerSummary), staleCount: crmCount(payload.staleCount),
      levelStats: crmRows(payload.levelStats).map((row) => ({ level: crmText(row.level), count: crmCount(row.count) })),
      workTrend: crmRows(payload.workTrend).map((row) => ({ date: crmText(row.date), label: crmText(row.label), phone: crmCount(row.phone), acquired: crmCount(row.acquired),
        interview: crmCount(row.interview), visited: crmCount(row.visited), deal: crmCount(row.deal) })),
      scopeLabel: user.role === 'admin' || user.dataScope === 'self' || user.bindingStatus === 'pending' ? '本人 CRM 工作台' : 'CRM 授权范围工作台',
      metricNotes: ['客户总数为非公海、未成交客户，包含到访客户；今日新增与本月新增包含转交客户。',
        '到访数按当前仍处于到访且未成交的客户统计；本月成交按签约日期统计。',
        '趋势来自 CRM 工作日报，不是根据微信消息推算；未来任务最多展示 8 条。',
        '未完成任务列表沿用 CRM 工作台口径，可能包含成交客户任务；统计卡的今日及逾期任务仅统计未成交客户。'],
      fetchedAt: new Date().toISOString(), sourceBaseUrl: this.baseUrl,
    };
  }

  async getCustomerContext(customerId: number, options: { forExport?: boolean } = {}): Promise<CrmCustomerContext> {
    if (!Number.isInteger(customerId) || customerId <= 0) throw new Error('请选择有效的 CRM 客户');
    const endpoint = '/api/customers/' + customerId;
    const payload = await this.request<{ customer?: Record<string, unknown>; tasks?: unknown[]; houseTargets?: unknown[] }>(endpoint);
    if (!payload.customer || typeof payload.customer !== 'object') throw new Error('CRM客户响应格式不正确');
    if (Number(payload.customer.id) !== customerId) throw new Error('CRM返回的客户身份不一致，未读取资料');
    if (options.forExport) {
      const user = await this.getCurrentUser();
      const permission = Number(payload.customer.inPublic) === 1 ? 'public.export' : 'customers.export';
      const permissions = Array.isArray(user.permissions) ? user.permissions : [];
      if (!permissions.includes('*') && !permissions.includes(permission)) throw new Error('当前 CRM 账号没有此客户的导出权限');
    }
    const masked = payload.customer.accessProfile === 'masked';
    const readRecords = async (kind: 'followups' | 'calls') => {
      if (masked) return { records: [], state: 'forbidden' as const };
      try {
        const response = await this.request<Record<string, unknown>>(endpoint + '/' + kind);
        if (!Array.isArray(response[kind])) throw new Error('CRM ' + kind + ' 响应格式不正确');
        return { records: response[kind] as unknown[], state: 'available' as const };
      } catch (error) {
        if (error instanceof CrmHttpError && error.status === 403) return { records: [], state: 'forbidden' as const };
        throw error;
      }
    };
    const [followups, calls] = await Promise.all([readRecords('followups'), readRecords('calls')]);
    return {
      customer: payload.customer,
      followups: followups.records,
      calls: calls.records,
      tasks: Array.isArray(payload.tasks) ? payload.tasks : [],
      houseTargets: Array.isArray(payload.houseTargets) ? payload.houseTargets : [],
      fetchedAt: new Date().toISOString(),
      sourceBaseUrl: this.baseUrl,
      availability: { followups: followups.state, calls: calls.state },
    };
  }

  async searchApprovedKnowledge(query: string): Promise<Record<string, unknown>[]> {
    const params = new URLSearchParams({ q: query.slice(0, 200), status: 'approved' });
    const payload = await this.request<{ entries?: Record<string, unknown>[] }>('/api/kb/entries?' + params);
    return (Array.isArray(payload.entries) ? payload.entries : []).filter((entry) => entry.status === 'approved');
  }

  private setToken(token: string | null): void {
    this.token = token;
    this.options.onToken?.(token);
  }

  private async authRequest(pathName: string, body: object): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    // Only our own login device identity, never cookies from the user's browser session.
    if (pathName === '/api/auth/device/verify' && this.pendingDevice) headers.Cookie = `fafuzx_device_id=${encodeURIComponent(this.pendingDevice.id)}`;
    return this.fetchJson(pathName, { method: 'POST', headers, body: JSON.stringify(body) }, true);
  }

  private async request<T>(pathName: string): Promise<T> {
    if (!this.token) throw new Error('请先登录 CRM');
    return this.fetchJson(pathName, { method: 'GET', headers: { Authorization: 'Bearer ' + this.token } }) as Promise<T>;
  }

  private async fetchJson(pathName: string, init: RequestInit, allowChallenge = false): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.fetcher(this.baseUrl + pathName, {
        ...init, redirect: 'error', signal: AbortSignal.timeout(this.options.timeoutMs ?? 20_000),
      });
    } catch { throw new Error('CRM连接失败或超时，请检查地址、网络和证书'); }
    if (response.status === 401) this.setToken(null);
    if (!response.ok && !(allowChallenge && [400, 403, 429].includes(response.status))) throw new CrmHttpError(response.status);
    const bytes: Uint8Array[] = [];
    let size = 0;
    const reader = response.body?.getReader();
    if (!reader) throw new Error('CRM返回了空响应');
    try {
      while (size <= 32 * 1024 * 1024) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > 32 * 1024 * 1024) throw new Error('CRM响应过大，未将不完整记录作为完整资料返回');
        bytes.push(next.value);
      }
    } finally { await reader.cancel().catch(() => undefined); }
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(Buffer.concat(bytes).toString('utf8')) as Record<string, unknown>; }
    catch { throw new Error('CRM返回的内容不是有效 JSON'); }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('CRM响应格式不正确');
    if (!response.ok && !(response.status === 403 && payload.code === 'DEVICE_VERIFICATION_REQUIRED')) {
      const safeErrors = new Set(['请输入 6 位验证码', '验证码已失效，请重新登录获取', '验证码已过期，请重新登录获取',
        '验证请求与发起登录的设备不一致，请在原设备重新登录', '验证码尝试次数过多，请重新登录获取',
        '无法识别当前设备，请刷新页面；手机应用请更新到最新版', '登录尝试过于频繁，请稍后再试']);
      const detail = typeof payload.error === 'string' && (safeErrors.has(payload.error) || /^验证码不正确，还可尝试 [0-5] 次$/.test(payload.error)) ? payload.error : undefined;
      throw new CrmHttpError(response.status, detail);
    }
    return payload;
  }
}
