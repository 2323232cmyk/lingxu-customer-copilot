import { Children, isValidElement, type ComponentProps, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeatureBridge } from '../shared/feature-bridge-contracts';
import type { LocalPlan } from '../shared/local-plan-contracts';
import { LocalPlanPanel, localPlanTimeToIso } from './LocalPlanPanel';

const hooks = vi.hoisted(() => ({ useState: vi.fn(), useRef: vi.fn(), useEffect: vi.fn() }));
vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(), ...hooks }));
vi.mock('@fluentui/react-components', async () => {
  const { createElement } = await import('react');
  return { Button: (props: ComponentProps<'button'> & { icon?: ReactNode }) => createElement('button', { disabled: props.disabled, type: props.type, onClick: props.onClick, 'aria-label': props['aria-label'], 'aria-expanded': props['aria-expanded'] }, props.icon, props.children) };
});
const plan: LocalPlan = { id: 'c8ab34c8-e7f3-4a89-92bd-15c7df37809b', title: '合成本机待办', dueAt: '2026-08-31T09:00:00Z', done: false, createdAt: '2026-08-30T00:00:00Z', updatedAt: '2026-08-30T00:00:00Z' };
const props = (accountKey: string | undefined = 'account-test') => ({ accountKey, onNotice: vi.fn() });
function states(overrides: Record<number, unknown> = {}) {
  const setters: Array<ReturnType<typeof vi.fn>> = []; let index = 0;
  hooks.useState.mockImplementation((initial: unknown) => {
    const current = index++; const setter = vi.fn(); setters[current] = setter;
    return [current in overrides ? overrides[current] : typeof initial === 'function' ? initial() : initial, setter];
  });
  return setters;
}
function bridge(value: Partial<FeatureBridge> = {}) {
  const methods = { listLocalPlans: vi.fn().mockResolvedValue({ ok: true, value: [] }), createLocalPlan: vi.fn().mockResolvedValue({ ok: true, value: plan }), updateLocalPlan: vi.fn().mockResolvedValue({ ok: true, value: { ...plan, done: true } }), deleteLocalPlan: vi.fn().mockResolvedValue({ ok: true, value: undefined }), ...value };
  vi.stubGlobal('window', { salesCopilot: methods }); return methods;
}
function elements<T extends { children?: ReactNode }>(node: ReactNode, predicate: (item: ReactElement<T>) => boolean): Array<ReactElement<T>> {
  if (!isValidElement<T>(node)) return [];
  return [...(predicate(node) ? [node] : []), ...Children.toArray(node.props.children).flatMap((child) => elements(child, predicate))];
}
function accountElement(value = props()) {
  const tree = LocalPlanPanel(value);
  const account = elements<{ accountKey: string; onNotice: (message: string) => void; children?: ReactNode }>(tree, (element) => typeof element.type === 'function' && element.props.accountKey !== undefined)[0];
  if (!account) throw new Error('Expected keyed account plan component');
  return account;
}
function accountTree(value = props()): ReactNode {
  const account = accountElement(value); const render = account.type as (properties: typeof account.props) => ReactNode;
  return render(account.props);
}
function click(tree: ReactNode, label: string) {
  const button = elements<ComponentProps<'button'>>(tree, (element) => element.props.children === label)[0];
  if (!button) throw new Error(`Button not found: ${label}`);
  button.props.onClick?.({} as never);
}
function submit(tree: ReactNode) {
  const form = elements<ComponentProps<'form'>>(tree, (element) => element.type === 'form')[0];
  if (!form) throw new Error('Expected create form');
  form.props.onSubmit?.({ preventDefault: vi.fn() } as never);
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
async function flush() { for (let i = 0; i < 12; i += 1) await Promise.resolve(); }

beforeEach(() => {
  vi.clearAllMocks(); states(); hooks.useRef.mockImplementation((value: unknown) => ({ current: value })); hooks.useEffect.mockImplementation(() => undefined);
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('local plan datetime conversion', () => {
  it('interprets a real local datetime in the computer timezone before producing an explicit ISO timestamp', () => {
    const iso = localPlanTimeToIso('2026-08-31T16:25');
    expect(iso).toBe(new Date(2026, 7, 31, 16, 25).toISOString()); expect(iso.endsWith('Z')).toBe(true);
  });
  it.each(['', '2026-02-30T16:25', '2026-13-01T10:00', '2026-08-31T25:00', '2026-08-31T10:72', '2026-08-31', 'not-a-time', '2026-08-31T10:00Z'])('rejects an invalid local input %s without sending it', (input) => {
    expect(() => localPlanTimeToIso(input)).toThrow('有效的计划');
  });
});

describe('account-isolated local plans UI', () => {
  it('does not load or write without a selected account and explains the disabled control', () => {
    const methods = bridge(); const html = renderToStaticMarkup(LocalPlanPanel({ accountKey: undefined, onNotice: vi.fn() }));
    expect(html).toContain('先选择并连接微信账号'); expect(html).toContain('disabled');
    expect(hooks.useEffect).not.toHaveBeenCalled(); expect(methods.listLocalPlans).not.toHaveBeenCalled(); expect(methods.createLocalPlan).not.toHaveBeenCalled();
  });
  it('keys the entire stateful plan surface by account, so drafts and rows cannot survive an account switch', () => {
    expect(accountElement(props('first-account')).key).toContain('first-account');
    expect(accountElement(props('second-account')).key).toContain('second-account');
    expect(accountElement(props('first-account')).key).not.toBe(accountElement(props('second-account')).key);
  });
  it('loads only the selected account and does not perform a write on entry', async () => {
    const methods = bridge({ listLocalPlans: vi.fn().mockResolvedValue({ ok: true, value: [plan] }) }); const setters = states(); accountTree();
    hooks.useEffect.mock.calls[0][0](); await flush();
    expect(methods.listLocalPlans).toHaveBeenCalledWith('account-test'); expect(setters[0]).toHaveBeenCalledWith([plan]);
    expect(methods.createLocalPlan).not.toHaveBeenCalled(); expect(methods.updateLocalPlan).not.toHaveBeenCalled(); expect(methods.deleteLocalPlan).not.toHaveBeenCalled();
  });
  it('reports a missing bridge without throwing or presenting an empty list as success', async () => {
    vi.stubGlobal('window', {}); const setters = states(); accountTree(); hooks.useEffect.mock.calls[0][0](); await flush();
    expect(setters[2]).toHaveBeenCalledWith(expect.stringContaining('服务尚未连接'));
    expect(setters[0]).not.toHaveBeenCalledWith([]);
  });
  it('discards a late account list response after unmount', async () => {
    const pending = deferred<{ ok: true; value: LocalPlan[] }>(); bridge({ listLocalPlans: vi.fn().mockReturnValue(pending.promise) });
    const setters = states(); accountTree(); const cleanup = hooks.useEffect.mock.calls[0][0](); cleanup(); pending.resolve({ ok: true, value: [plan] }); await flush();
    expect(setters[0]).not.toHaveBeenCalledWith([plan]);
  });
  it('never describes a security-storage read failure as zero plans', () => {
    bridge(); states({ 1: false, 2: '本机安全存储不可用' }); const html = renderToStaticMarkup(accountTree());
    expect(html).toContain('本机安全存储不可用'); expect(html).toContain('不代表没有计划'); expect(html).not.toContain('当前没有未完成'); expect(html).toContain('—');
  });
  it('saves only on explicit submit and clears inputs only after the bridge confirms success', async () => {
    const pending = deferred<{ ok: true; value: LocalPlan }>(); const methods = bridge({ createLocalPlan: vi.fn().mockReturnValue(pending.promise) });
    const properties = props(); const setters = states({ 0: [], 1: false, 3: '  合成新计划  ', 4: '2026-09-01T09:15', 5: true }); const tree = accountTree(properties);
    expect(methods.createLocalPlan).not.toHaveBeenCalled(); submit(tree);
    expect(methods.createLocalPlan).toHaveBeenCalledWith({ accountKey: 'account-test', title: '合成新计划', dueAt: localPlanTimeToIso('2026-09-01T09:15') });
    expect(setters[3]).not.toHaveBeenCalled(); expect(setters[0]).not.toHaveBeenCalled();
    pending.resolve({ ok: true, value: plan }); await flush();
    expect(setters[3]).toHaveBeenCalledWith(''); expect(setters[4]).toHaveBeenCalledWith('');
    expect(setters[0].mock.calls[0][0]([])).toEqual([plan]); expect(properties.onNotice).toHaveBeenCalledWith(expect.stringContaining('不会写入 CRM'));
  });
  it('keeps title, date and old records when encryption fails', async () => {
    const methods = bridge({ createLocalPlan: vi.fn().mockResolvedValue({ ok: false, error: '本机计划加密失败，未写入文件' }) });
    const setters = states({ 0: [plan], 1: false, 3: '保留这段输入', 4: '2026-09-01T09:15', 5: true }); submit(accountTree()); await flush();
    expect(methods.createLocalPlan).toHaveBeenCalledOnce(); expect(setters[3]).not.toHaveBeenCalled(); expect(setters[4]).not.toHaveBeenCalled(); expect(setters[0]).not.toHaveBeenCalled();
    expect(setters[7]).toHaveBeenCalledWith('本机计划加密失败，未写入文件');
  });
  it.each(['', 'x'.repeat(201), 'contains\nnewline'])('rejects invalid titles before IPC', async (title) => {
    const methods = bridge(); const setters = states({ 0: [], 1: false, 3: title, 4: '2026-09-01T09:15', 5: true }); submit(accountTree()); await flush();
    expect(methods.createLocalPlan).not.toHaveBeenCalled(); expect(setters[7]).toHaveBeenCalledWith(expect.stringContaining('1 至 200'));
  });
  it('rejects invalid dates before IPC and retains the form', () => {
    const methods = bridge(); const setters = states({ 0: [], 1: false, 3: '合成任务', 4: '2026-02-30T10:00', 5: true }); submit(accountTree());
    expect(methods.createLocalPlan).not.toHaveBeenCalled(); expect(setters[7]).toHaveBeenCalledWith(expect.stringContaining('有效的计划')); expect(setters[3]).not.toHaveBeenCalled();
  });
  it('prevents a double submit before React can redraw the disabled button', () => {
    const pending = deferred<{ ok: true; value: LocalPlan }>(); const methods = bridge({ createLocalPlan: vi.fn().mockReturnValue(pending.promise) });
    states({ 0: [], 1: false, 3: '合成任务', 4: '2026-09-01T09:15', 5: true }); const tree = accountTree(); submit(tree); submit(tree);
    expect(methods.createLocalPlan).toHaveBeenCalledOnce();
  });
  it('does not update a finished old-account request or emit a success notice after unmount', async () => {
    const pending = deferred<{ ok: true; value: LocalPlan }>(); bridge({ createLocalPlan: vi.fn().mockReturnValue(pending.promise) });
    const properties = props(); const setters = states({ 0: [], 1: false, 3: '合成任务', 4: '2026-09-01T09:15', 5: true }); const tree = accountTree(properties);
    const cleanup = hooks.useEffect.mock.calls[0][0](); setters[0].mockClear(); submit(tree); cleanup(); pending.resolve({ ok: true, value: plan }); await flush();
    expect(setters[3]).not.toHaveBeenCalled(); expect(properties.onNotice).not.toHaveBeenCalled();
    expect(setters[0].mock.calls.every(([value]) => typeof value !== 'function')).toBe(true);
  });
  it('completes a plan only after a successful update', async () => {
    const pending = deferred<{ ok: true; value: LocalPlan }>(); const methods = bridge({ updateLocalPlan: vi.fn().mockReturnValue(pending.promise) }); const setters = states({ 0: [plan], 1: false });
    click(accountTree(), '完成'); expect(methods.updateLocalPlan).toHaveBeenCalledWith({ accountKey: 'account-test', id: plan.id, done: true }); expect(setters[0]).not.toHaveBeenCalled();
    pending.resolve({ ok: true, value: { ...plan, done: true } }); await flush(); expect(setters[0].mock.calls[0][0]([plan])[0].done).toBe(true);
  });
  it('restores a completed plan through the real update bridge', async () => {
    const done = { ...plan, done: true }; const methods = bridge({ updateLocalPlan: vi.fn().mockResolvedValue({ ok: true, value: plan }) });
    const setters = states({ 0: [done], 1: false, 6: 'done' }); click(accountTree(), '恢复'); await flush();
    expect(methods.updateLocalPlan).toHaveBeenCalledWith({ accountKey: 'account-test', id: plan.id, done: false }); expect(setters[0].mock.calls[0][0]([done])[0].done).toBe(false);
  });
  it('keeps an existing plan unchanged after an update failure', async () => {
    bridge({ updateLocalPlan: vi.fn().mockResolvedValue({ ok: false, error: '保存失败' }) }); const setters = states({ 0: [plan], 1: false }); click(accountTree(), '完成'); await flush();
    expect(setters[0]).not.toHaveBeenCalled(); expect(setters[7]).toHaveBeenCalledWith('保存失败');
  });
  it('requires an inline second confirmation before delete and supports cancellation', () => {
    const methods = bridge(); const setters = states({ 0: [plan], 1: false }); click(accountTree(), '删除');
    expect(setters[9]).toHaveBeenCalledWith(plan.id); expect(methods.deleteLocalPlan).not.toHaveBeenCalled();
    const cancelSetters = states({ 0: [plan], 1: false, 9: plan.id }); const tree = accountTree(); expect(renderToStaticMarkup(tree)).toContain('删除后无法恢复'); click(tree, '取消');
    expect(cancelSetters[9]).toHaveBeenCalledWith(null); expect(methods.deleteLocalPlan).not.toHaveBeenCalled();
  });
  it('removes only the confirmed plan after successful deletion', async () => {
    const pending = deferred<{ ok: true; value: void }>(); const methods = bridge({ deleteLocalPlan: vi.fn().mockReturnValue(pending.promise) }); const properties = props();
    const setters = states({ 0: [plan], 1: false, 9: plan.id }); click(accountTree(properties), '确认删除');
    expect(methods.deleteLocalPlan).toHaveBeenCalledWith({ accountKey: 'account-test', id: plan.id }); expect(setters[0]).not.toHaveBeenCalled();
    pending.resolve({ ok: true, value: undefined }); await flush(); expect(setters[0].mock.calls[0][0]([plan])).toEqual([]); expect(properties.onNotice).toHaveBeenCalledWith(expect.stringContaining('无法撤销'));
  });
  it('keeps a plan and its inline confirmation visible after a delete failure', async () => {
    bridge({ deleteLocalPlan: vi.fn().mockResolvedValue({ ok: false, error: '无法写入' }) }); const setters = states({ 0: [plan], 1: false, 9: plan.id }); click(accountTree(), '确认删除'); await flush();
    expect(setters[0]).not.toHaveBeenCalled(); expect(setters[9]).not.toHaveBeenCalledWith(null); expect(setters[7]).toHaveBeenCalledWith('无法写入');
  });
  it('sorts visible plans by due time, identifies overdue items and separates the completed filter', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-01T09:00:00Z'));
    const next = { ...plan, id: 'plan-later', title: '之后的计划', dueAt: '2026-09-02T10:00:00Z' };
    const done = { ...plan, id: 'plan-done', title: '已经完成的计划', done: true };
    bridge(); states({ 0: [next, done, plan], 1: false }); const html = renderToStaticMarkup(accountTree());
    expect(html.indexOf(plan.title)).toBeLessThan(html.indexOf(next.title)); expect(html).toContain('逾期'); expect(html).not.toContain(done.title);
    states({ 0: [next, done, plan], 1: false, 6: 'done' }); const completed = renderToStaticMarkup(accountTree()); expect(completed).toContain(done.title); expect(completed).not.toContain(next.title);
  });
});
