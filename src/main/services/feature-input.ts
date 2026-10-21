import type { WechatFeatureScope } from '../../shared/feature-bridge-contracts';
import type { CrmCustomerListQuery, CrmLoginRequest, CrmTaskQuery, IntegrationSettingsUpdate } from '../../shared/integration-contracts';

export const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export const opaqueKey = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9._:@-]{1,256}$/u.test(value);
export const mediaAlias = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
export const positiveId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
export const taskId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9-]{36}$/u.test(value);

export function scopeInput(value: unknown): WechatFeatureScope {
  if (!isRecord(value) || !opaqueKey(value.accountKey) || !opaqueKey(value.contactKey) || Object.keys(value).some((key) => !['accountKey', 'contactKey'].includes(key))) throw new Error('微信会话范围无效');
  return { accountKey: value.accountKey, contactKey: value.contactKey };
}

export function searchInput(value: unknown, maximum = 200): string {
  if (typeof value !== 'string' || value.length > maximum) throw new Error('搜索内容无效或过长');
  return value.trim();
}

export function crmCustomerListInput(value: unknown): Required<CrmCustomerListQuery> {
  if (!isRecord(value) || Object.keys(value).some((key) => !['search', 'stage', 'page', 'limit', 'level', 'sort', 'order'].includes(key))) throw new Error('CRM 客户列表参数无效');
  const { stage = 'active', page = 1, limit = 50, sort = 'updated', order = 'desc' } = value;
  if (!['active', 'visited', 'deal'].includes(String(stage)) || typeof stage !== 'string'
    || !positiveId(page) || page > 1_000_000 || !positiveId(limit) || limit > 200
    || !['updated', 'next', 'last'].includes(String(sort)) || typeof sort !== 'string'
    || !['asc', 'desc'].includes(String(order)) || typeof order !== 'string') throw new Error('CRM 客户分页或筛选条件无效');
  return { search: searchInput(value.search ?? ''), stage: stage as Required<CrmCustomerListQuery>['stage'], page, limit,
    level: searchInput(value.level ?? '', 100), sort: sort as Required<CrmCustomerListQuery>['sort'], order: order as Required<CrmCustomerListQuery>['order'] };
}

export function crmTaskQueryInput(value: unknown): Required<CrmTaskQuery> {
  if (!isRecord(value) || Object.keys(value).some((key) => !['scope', 'done', 'ownOnly'].includes(key))) throw new Error('CRM 任务查询参数无效');
  const { scope = 'all', done = 'open', ownOnly = false } = value;
  if (typeof scope !== 'string' || !['all', 'today', 'overdue', 'future'].includes(scope)
    || typeof done !== 'string' || !['open', 'done', 'all'].includes(done) || typeof ownOnly !== 'boolean') throw new Error('CRM 任务筛选条件无效');
  return { scope: scope as Required<CrmTaskQuery>['scope'], done: done as Required<CrmTaskQuery>['done'], ownOnly };
}

export function loginInput(value: unknown): CrmLoginRequest {
  if (!isRecord(value) || typeof value.username !== 'string' || !value.username.trim() || value.username.length > 254
    || typeof value.password !== 'string' || !value.password || value.password.length > 4096
    || (value.rememberSession !== undefined && typeof value.rememberSession !== 'boolean')
    || Object.keys(value).some((key) => !['username', 'password', 'rememberSession'].includes(key))) throw new Error('CRM 登录参数无效');
  return { username: value.username, password: value.password, ...(value.rememberSession === undefined ? {} : { rememberSession: value.rememberSession }) };
}

export function settingsInput(value: unknown): IntegrationSettingsUpdate {
  if (!isRecord(value) || Object.keys(value).some((key) => !['crm', 'ai'].includes(key))) throw new Error('连接配置无效');
  const result: IntegrationSettingsUpdate = {};
  for (const group of ['crm', 'ai'] as const) {
    const data = value[group];
    if (data === undefined) continue;
    if (!isRecord(data)) throw new Error('连接配置分组无效');
    const strings = group === 'crm' ? ['baseUrl', 'username'] : ['provider', 'baseUrl', 'model', 'apiKey'];
    const booleans = group === 'crm' ? ['rememberSession', 'allowInsecureHttp'] : ['rememberKey', 'allowRemote', 'clearApiKey'];
    for (const [key, item] of Object.entries(data)) {
      if (strings.includes(key) ? typeof item !== 'string' || item.length > 4096 : booleans.includes(key) ? typeof item !== 'boolean' : true) throw new Error('连接配置字段无效');
    }
    if (group === 'crm') result.crm = { ...data };
    else result.ai = { ...data };
  }
  return result;
}

export function publicFeatureError(error: unknown, fallback = '操作未完成，请检查设置后重试'): string {
  const safeCrmErrors = new Set(['CRM连接失败或超时，请检查地址、网络和证书', 'CRM登录失败，请核对账号或设备验证状态',
    'CRM设备标识无效，请重新启动软件', 'CRM用户响应格式不正确', 'CRM返回了空响应', 'CRM返回的内容不是有效 JSON', 'CRM响应格式不正确', 'CRM 登录参数无效']);
  return error instanceof Error && (/^[\u3400-\u9fff]/u.test(error.message) || safeCrmErrors.has(error.message)) && error.message.length <= 500
    && !/[a-z]:[\\/]|Bearer\s|sk-[a-z0-9]/iu.test(error.message) ? error.message : fallback;
}
