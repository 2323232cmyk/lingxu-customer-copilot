import { describe, expect, it } from 'vitest';
import { crmCustomerListInput, crmTaskQueryInput, loginInput, publicFeatureError, scopeInput, settingsInput } from './feature-input';

describe('feature input boundary', () => {
  it.each([null, [], { accountKey: '../private', contactKey: 'ok' }, { accountKey: 'ok', contactKey: 'ok', path: 'C:/private' }])('rejects malformed scope %j', (input) => {
    expect(() => scopeInput(input)).toThrow();
  });
  it('rejects credential-shaped unexpected settings and invalid flags', () => {
    expect(() => settingsInput({ token: 'secret' })).toThrow();
    expect(() => settingsInput({ crm: { password: 'secret' } })).toThrow();
    expect(() => settingsInput({ ai: { allowRemote: 'yes' } })).toThrow();
    expect(() => settingsInput({ ai: { apiKey: 'x'.repeat(4097) } })).toThrow();
    expect(settingsInput({ ai: { model: 'example', allowRemote: false } })).toEqual({ ai: { model: 'example', allowRemote: false } });
  });
  it('requires a bounded explicit CRM login shape', () => {
    expect(() => loginInput({ username: 'a', password: '', token: 'injected' })).toThrow();
    expect(loginInput({ username: 'a', password: 'secret' })).toEqual({ username: 'a', password: 'secret' });
  });
  it('does not expose raw filesystem or key-bearing exceptions', () => {
    expect(publicFeatureError(new Error('ENOENT: C:\\Users\\private'))).not.toContain('private');
    expect(publicFeatureError(new Error('连接失败 Bearer secret'))).not.toContain('secret');
    expect(publicFeatureError(new Error('请选择有效的客户'))).toBe('请选择有效的客户');
  });
  it('preserves known CRM login errors beginning with Latin letters but not arbitrary server text', () => {
    for (const message of ['CRM连接失败或超时，请检查地址、网络和证书', 'CRM登录失败，请核对账号或设备验证状态', 'CRM用户响应格式不正确']) {
      expect(publicFeatureError(new Error(message))).toBe(message);
    }
    expect(publicFeatureError(new Error('CRM private server secret'))).not.toContain('secret');
    expect(publicFeatureError(new Error('CRM连接失败 Bearer secret'))).not.toContain('secret');
  });
  it('defaults to a bounded permitted CRM list without any cross-account override', () => {
    expect(crmCustomerListInput({})).toEqual({ search: '', stage: 'active', page: 1, limit: 50, level: '', sort: 'updated', order: 'desc' });
    expect(crmCustomerListInput({ page: 1_000_000, limit: 200 }).limit).toBe(200);
  });
  it.each([null, [], { page: 0 }, { page: 1.5 }, { page: 1_000_001 }, { limit: 201 }, { limit: -1 }, { limit: '50' }, { stage: 'public' },
    { sort: 'owner_id' }, { search: 'x'.repeat(201) }, { accountId: 5 }, { all: 1 }, { export: 1 }, { token: 'secret' }, { order: 'sideways' }, { level: 'x'.repeat(101) }])('rejects invalid CRM pagination or hidden overrides %#', (input) => {
    expect(() => crmCustomerListInput(input)).toThrow();
  });
  it('validates the existing read-only task filters', () => {
    expect(crmTaskQueryInput({})).toEqual({ scope: 'all', done: 'open', ownOnly: false });
    expect(crmTaskQueryInput({ scope: 'overdue', done: 'done', ownOnly: true })).toEqual({ scope: 'overdue', done: 'done', ownOnly: true });
  });
  it.each([null, { scope: 'private' }, { done: 0 }, { ownOnly: '1' }, { accountId: 7 }, { method: 'POST' }])('rejects invalid task filters %#', (input) => {
    expect(() => crmTaskQueryInput(input)).toThrow();
  });
});
