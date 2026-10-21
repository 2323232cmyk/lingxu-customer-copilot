import { describe, expect, it, vi } from 'vitest';
import { CrmHttpError, ReadOnlyCrmConnector } from './crm-connector';

const response = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
const input = { username: 'tester', password: 'private-password', deviceId: 'stable-device-id', deviceName: 'test device' };
const customerRow = { id: 7, ownerId: 1, name: '测试客户', phone: 'test-phone', accessProfile: 'full', level: 'A类·高意向',
  firstContact: '先了解服务流程', lastFollowupContent: '周末沟通', nextFollowupAt: '2026-09-01 10:00', followupCount: 4,
  isVisited: 1, isDeal: 0, budget: '待确认' };
const taskRow = { id: 1, customerId: 7, title: '确认到访时间', dueAt: '2026-09-01 10:00', done: 0, doneAt: null, source: 'followup', customerName: '测试客户', accessProfile: 'full' };
const dashboard = {
  stats: { totalCustomers: 17, todayTasks: 1, overdueTasks: 2, monthNew: 7, todayNew: 1, weekVisited: 2, monthVisited: 4, monthDeal: 3 },
  today: [taskRow], overdue: [], future: [], priorityCustomers: [customerRow], staleCustomers: [], staleCount: 2,
  levelStats: [{ level: 'A类·高意向', count: 6 }], workTrend: [{ date: '2026-08-31', label: '8/31', phone: 12, acquired: 2, interview: 1, visited: 1, deal: 0 }],
};

describe('ReadOnlyCrmConnector', () => {
  it('logs in and retains bearer only inside connector', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response({ token: 'private-token' })).mockResolvedValueOnce(response({ user: { id: 1, displayName: 'tester' } }));
    const onToken = vi.fn();
    const crm = new ReadOnlyCrmConnector('https://crm.example/api', { fetch: fetcher, onToken });
    expect(await crm.login(input)).toEqual({ kind: 'authenticated' });
    expect(await crm.getCurrentUser()).toEqual({ id: 1, displayName: 'tester' });
    expect(fetcher.mock.calls[0][0]).toBe('https://crm.example/api/auth/login');
    expect(fetcher.mock.calls[0][1]?.redirect).toBe('error');
    expect(fetcher.mock.calls[1][1]?.headers).toEqual({ Authorization: 'Bearer private-token' });
    expect(onToken).toHaveBeenLastCalledWith('private-token');
  });

  it('supports the real first-device challenge contract', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ code: 'DEVICE_VERIFICATION_REQUIRED', challengeId: 12, expiresAt: '2026-08-31 16:00' }, 403))
      .mockResolvedValueOnce(response({ token: 'verified' }));
    const crm = new ReadOnlyCrmConnector('https://crm.example', { fetch: fetcher });
    expect(await crm.login(input)).toMatchObject({ kind: 'verification-required', challengeId: 12 });
    await expect(crm.verifyDevice(12, '123456')).resolves.toBeUndefined();
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual({ challengeId: 12, code: '123456' });
    expect(fetcher.mock.calls[1][1]?.headers).toMatchObject({ Cookie: 'fafuzx_device_id=stable-device-id' });
    await expect(crm.verifyDevice(12, '123456')).rejects.toThrow('已失效');
  });

  it('retains the device on a wrong code and reports only approved error text', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ code: 'DEVICE_VERIFICATION_REQUIRED', challengeId: 12, expiresAt: '2026-08-31' }, 403))
      .mockResolvedValueOnce(response({ error: '验证码不正确，还可尝试 4 次' }, 400))
      .mockResolvedValueOnce(response({ error: 'private server secret' }, 400));
    const crm = new ReadOnlyCrmConnector('https://crm.example', { fetch: fetcher });
    await crm.login(input);
    await expect(crm.verifyDevice(12, '123456')).rejects.toThrow('还可尝试 4 次');
    await expect(crm.verifyDevice(12, '123456')).rejects.toThrow(/^读取 CRM 失败：400$/);
    expect(fetcher.mock.calls[2][1]?.headers).toMatchObject({ Cookie: 'fafuzx_device_id=stable-device-id' });
  });

  it('returns full followups and calls, flattening the real customer envelope', async () => {
    const followups = Array.from({ length: 24 }, (_, id) => ({ id, content: `followup ${id}` }));
    const calls = Array.from({ length: 18 }, (_, id) => ({ id, transcript: `call ${id}` }));
    const fetcher = vi.fn<typeof fetch>(async (url) => String(url).endsWith('/followups') ? response({ followups })
      : String(url).endsWith('/calls') ? response({ calls })
        : response({ customer: { id: 7, name: '客户' }, tasks: [{ id: 2 }], houseTargets: [{ id: 3 }] }));
    const crm = new ReadOnlyCrmConnector('https://crm.example', { fetch: fetcher, token: 'token' });
    const context = await crm.getCustomerContext(7);
    expect(context.customer).toEqual({ id: 7, name: '客户' });
    expect(context.followups).toHaveLength(24);
    expect(context.calls).toHaveLength(18);
    expect(context.tasks).toHaveLength(1);
    expect(fetcher.mock.calls.every(([, options]) => options?.method === 'GET')).toBe(true);
  });

  it('labels permission-denied context instead of pretending full history', async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) => String(url).endsWith('/followups') ? response({}, 403)
      : String(url).endsWith('/calls') ? response({ calls: [] }) : response({ customer: { id: 1 } }));
    const context = await new ReadOnlyCrmConnector('https://crm.example', { fetch: fetcher, token: 'token' }).getCustomerContext(1);
    expect(context.availability).toEqual({ followups: 'forbidden', calls: 'available' });
  });

  it('does not request or report private histories as empty for a masked customer', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ customer: { id: 1, accessProfile: 'masked' }, tasks: [], houseTargets: [] }));
    const context = await new ReadOnlyCrmConnector('https://crm.example', { fetch: fetcher, token: 'token' }).getCustomerContext(1);
    expect(context.followups).toEqual([]); expect(context.calls).toEqual([]);
    expect(context.availability).toEqual({ followups: 'forbidden', calls: 'forbidden' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not hide server failures as an empty record set', async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) => String(url).endsWith('/1') ? response({ customer: { id: 1 } }) : response({}, 500));
    await expect(new ReadOnlyCrmConnector('https://crm.example', { fetch: fetcher, token: 'token' }).getCustomerContext(1)).rejects.toThrow(CrmHttpError);
  });

  it('checks current CRM export permission before fetching export histories', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response({ customer: { id: 1 } })).mockResolvedValueOnce(response({ user: { permissions: ['customers.view'] } }));
    await expect(new ReadOnlyCrmConnector('https://crm.example', { fetch: fetcher, token: 'token' }).getCustomerContext(1, { forExport: true })).rejects.toThrow('导出权限');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('uses public.export for public-pool records', async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) => String(url).endsWith('/me') ? response({ user: { permissions: ['customers.export'] } }) : response({ customer: { id: 1, inPublic: 1 } }));
    await expect(new ReadOnlyCrmConnector('https://crm.example', { fetch: fetcher, token: 'token' }).getCustomerContext(1, { forExport: true })).rejects.toThrow('导出权限');
  });

  it('allows a current authorized export', async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) => String(url).endsWith('/me') ? response({ user: { permissions: ['*'] } })
      : String(url).endsWith('/calls') ? response({ calls: [] }) : String(url).endsWith('/followups') ? response({ followups: [] }) : response({ customer: { id: 1 } }));
    await expect(new ReadOnlyCrmConnector('https://crm.example', { fetch: fetcher, token: 'token' }).getCustomerContext(1, { forExport: true })).resolves.toMatchObject({ customer: { id: 1 } });
  });

  it('clears expired sessions and never echoes backend secret text', async () => {
    const onToken = vi.fn();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ error: 'secret-token' }, 401));
    const crm = new ReadOnlyCrmConnector('https://crm.example', { fetch: fetcher, token: 'old', onToken });
    await expect(crm.getCurrentUser()).rejects.toThrow('401');
    expect(onToken).toHaveBeenCalledWith(null);
    await expect(crm.getCurrentUser()).rejects.toThrow('请先登录');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('requests only approved knowledge even with admin credentials', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ entries: [{ status: 'pending' }, { status: 'approved', answer: 'ok' }] }));
    const crm = new ReadOnlyCrmConnector('https://crm.example', { fetch: fetcher, token: 'token' });
    expect(await crm.searchApprovedKnowledge('费用')).toEqual([{ status: 'approved', answer: 'ok' }]);
    expect(String(fetcher.mock.calls[0][0])).toContain('status=approved');
  });

  it('rejects invalid customer ids without network traffic', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const crm = new ReadOnlyCrmConnector('https://crm.example', { fetch: fetcher, token: 'token' });
    await expect(crm.getCustomerContext(-1)).rejects.toThrow('有效');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects a mismatched customer returned by the server', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ customer: { id: 9, name: 'other' } }));
    const crm = new ReadOnlyCrmConnector('https://crm.example', { fetch: fetcher, token: 'token' });
    await expect(crm.getCustomerContext(1)).rejects.toThrow('身份不一致');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('loads real paginated followup summaries without a search or export request', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ customers: [customerRow], page: 2, limit: 1, total: 3 }));
    const crm = new ReadOnlyCrmConnector('https://crm.example/api', { fetch: fetcher, token: 'token' });
    const page = await crm.listCustomers({ page: 2, limit: 1, sort: 'next', order: 'asc' });
    expect(page).toMatchObject({ page: 2, limit: 1, total: 3, hasMore: true, sourceBaseUrl: 'https://crm.example' });
    expect(page.customers[0]).toMatchObject({ id: 7, firstContact: '先了解服务流程', lastFollowupContent: '周末沟通', nextFollowupAt: '2026-09-01 10:00', followupCount: 4, isVisited: true, isDeal: false });
    const url = new URL(String(fetcher.mock.calls[0][0]));
    expect(url.searchParams.get('page')).toBe('2');
    expect(url.searchParams.get('sort')).toBe('next');
    expect(url.searchParams.has('all')).toBe(false);
    expect(url.searchParams.has('export')).toBe(false);
    expect(fetcher.mock.calls[0][1]?.method).toBe('GET');
  });

  it.each([['visited', 'stage', 'visited'], ['deal', 'deal', '1']] as const)('maps %s to the existing CRM stage contract', async (stage, key, expected) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ customers: [], page: 1, limit: 50, total: 0 }));
    const crm = new ReadOnlyCrmConnector('https://crm.example', { fetch: fetcher, token: 'token' });
    expect((await crm.listCustomers({ stage, search: ' name & phone ', level: 'B类·意向待明确' })).hasMore).toBe(false);
    const url = new URL(String(fetcher.mock.calls[0][0]));
    expect(url.searchParams.get(key)).toBe(expected);
    expect(url.searchParams.get('search')).toBe('name & phone');
    expect(url.searchParams.get('level')).toBe('B类·意向待明确');
  });

  it('keeps a permitted masked customer masked, including followup previews', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ customers: [{ ...customerRow, accessProfile: 'masked' }], page: 1, limit: 50, total: 1 }));
    const page = await new ReadOnlyCrmConnector('https://crm.example', { fetch: fetcher, token: 'token' }).listCustomers({});
    expect(page.customers[0]).toMatchObject({ name: '已隐藏', phone: '', firstContact: '', lastFollowupContent: '', accessProfile: 'masked' });
    expect(JSON.stringify(page)).not.toContain('test-phone');
  });

  it('returns a genuine empty out-of-range page without changing its count or page', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ customers: [], page: 3, limit: 50, total: 72 }));
    expect(await new ReadOnlyCrmConnector('https://crm.example', { fetch: fetcher, token: 'token' }).listCustomers({ page: 3 })).toMatchObject({ customers: [], total: 72, page: 3, hasMore: false });
  });

  it.each([
    { customers: [], page: 1, limit: 50 },
    { customers: [], page: 1, limit: 50, total: '0' },
    { customers: [], page: 2, limit: 50, total: 0 },
    { customers: [customerRow], page: 1, limit: 50, total: 0 },
    { customers: [customerRow, customerRow], page: 1, limit: 50, total: 2 },
    { customers: [{ ...customerRow, accessProfile: 'none' }], page: 1, limit: 50, total: 1 },
    { error: 'private-backend-error' },
  ])('rejects malformed lists instead of fabricating an empty successful view %#', async (payload) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(payload));
    await expect(new ReadOnlyCrmConnector('https://crm.example', { fetch: fetcher, token: 'token' }).listCustomers({})).rejects.toThrow('CRM');
  });

  it.each([401, 403, 500])('preserves HTTP %s failures for lists and never returns empty success', async (status) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ error: 'private-error' }, status));
    await expect(new ReadOnlyCrmConnector('https://crm.example', { fetch: fetcher, token: 'token' }).listCustomers({})).rejects.toThrow(String(status));
  });

  it('reads scoped CRM tasks without adding completion or editing endpoints', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ tasks: [taskRow, { ...taskRow, id: 2, accessProfile: 'masked', done: 1 }] }));
    const tasks = await new ReadOnlyCrmConnector('https://crm.example', { fetch: fetcher, token: 'token' }).listTasks({ scope: 'today', done: 'all', ownOnly: true });
    expect(tasks.tasks).toMatchObject([{ title: '确认到访时间', done: false }, { title: '已隐藏', customerName: '已隐藏', done: true }]);
    expect(String(fetcher.mock.calls[0][0])).toBe('https://crm.example/api/tasks?scope=today&done=all&own=1');
    expect(fetcher.mock.calls[0][1]?.method).toBe('GET');
  });

  it('does not hide missing or unauthorized task interfaces', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({}, 404));
    await expect(new ReadOnlyCrmConnector('https://crm.example', { fetch: fetcher, token: 'token' }).listTasks({})).rejects.toThrow('404');
  });

  it('uses the full dashboard and makes the own-account admin statistics explicit', async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) => String(url).endsWith('/me') ? response({ user: { id: 1, role: 'admin', permissions: ['*'] } }) : response(dashboard));
    const summary = await new ReadOnlyCrmConnector('https://crm.example', { fetch: fetcher, token: 'token' }).getWorkspaceOverview();
    expect(summary).toMatchObject({ stats: dashboard.stats, scopeLabel: '本人 CRM 工作台', staleCount: 2 });
    expect(summary.workTrend).toEqual(dashboard.workTrend);
    expect(summary.metricNotes.join('')).toContain('工作日报');
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual(['https://crm.example/api/auth/me', 'https://crm.example/api/dashboard']);
  });

  it('labels manager-scoped statistics without claiming they are the entire company', async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) => String(url).endsWith('/me') ? response({ user: { id: 2, role: 'agent', dataScope: 'department', permissions: ['customers.view'] } }) : response(dashboard));
    const summary = await new ReadOnlyCrmConnector('https://crm.example', { fetch: fetcher, token: 'token' }).getWorkspaceOverview();
    expect(summary.scopeLabel).toBe('CRM 授权范围工作台');
  });

  it('checks dashboard permission before an endpoint that otherwise only checks login', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ user: { id: 4, permissions: ['houses.view'] } }));
    await expect(new ReadOnlyCrmConnector('https://crm.example', { fetch: fetcher, token: 'token' }).getWorkspaceOverview()).rejects.toThrow('查看权限');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not turn a missing statistics field into zero', async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) => String(url).endsWith('/me') ? response({ user: { permissions: ['*'] } }) : response({ ...dashboard, stats: { totalCustomers: 1 } }));
    await expect(new ReadOnlyCrmConnector('https://crm.example', { fetch: fetcher, token: 'token' }).getWorkspaceOverview()).rejects.toThrow('不完整统计');
  });
});
