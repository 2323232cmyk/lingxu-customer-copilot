import { readFileSync, writeFileSync } from 'node:fs';
import { Children, isValidElement, type ComponentProps, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeatureBridge } from '../shared/feature-bridge-contracts';
import type { IntegrationSettingsPublic } from '../shared/integration-contracts';
import type { OfflineVoiceStatus } from '../shared/voice-contracts';
import type { WechatLiveSnapshot } from '../shared/contracts';
import { CrmBindingDialog, CrmContextDetails, ExportView, KnowledgeView, SettingsView } from './FeatureViews';
import { editableAiSettings, editableCrmSettings } from './feature-views-model';
import { AppearanceSettings } from './AppearanceSettings';

const hooks = vi.hoisted(() => ({
  useState: vi.fn(), useRef: vi.fn(), useEffect: vi.fn(), useMemo: vi.fn(), useCallback: vi.fn(),
}));
vi.mock('react', async (importOriginal) => ({ ...await importOriginal<typeof import('react')>(), ...hooks }));
// These tests exercise form/IPC boundaries in Node. Fluent focus trapping is checked in the renderer, not emulated here.
vi.mock('@fluentui/react-components', async () => {
  const { createElement } = await import('react');
  const group = (tag: string) => (props: { children?: ReactNode }) => createElement(tag, null, props.children);
  return {
    Button: (props: ComponentProps<'button'> & { icon?: ReactNode }) => createElement('button', { disabled: props.disabled, type: props.type, onClick: props.onClick, 'aria-label': props['aria-label'] }, props.icon, props.children),
    Dialog: (props: { open: boolean; children?: ReactNode }) => props.open ? createElement('section', { role: 'dialog' }, props.children) : null,
    DialogSurface: group('div'), DialogBody: group('div'), DialogContent: group('div'), DialogActions: group('div'), DialogTitle: group('h2'),
  };
});
vi.mock('./wechat-media', async () => {
  const { createElement } = await import('react');
  return { PrivateImage: ({ mediaKey, alt }: { mediaKey?: string; alt: string }) => createElement('span', { role: 'img', 'aria-label': alt, 'data-media-key': mediaKey }) };
});

const settings: IntegrationSettingsPublic = {
  crm: { baseUrl: 'https://crm.example.test', username: 'test-user', rememberSession: false, allowInsecureHttp: false, hasSession: false },
  ai: { provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'test-model', rememberKey: false, allowRemote: false, hasApiKey: false, isLocal: false },
  knowledge: { folderPath: '', documents: 0, chunks: 0, indexedAt: null, skipped: 0, warnings: [], supportedExtensions: ['.md', '.txt'] },
  secureStorageAvailable: true,
};
const voice: OfflineVoiceStatus = { engine: 'SenseVoice', state: 'missing', detail: '请下载模型', downloadedBytes: 0, totalBytes: 240_000_000, queued: 0, active: false };
const snapshot: WechatLiveSnapshot = { revision: 1, accountKey: 'account-test', conversations: [
  { contactKey: 'contact-test', displayName: '合成测试客户', kind: 'contact', avatarMediaKey: 'peer-avatar' },
  { contactKey: 'group-test', displayName: '合成测试群聊', kind: 'group' },
  { contactKey: 'official-test', displayName: '不应导出的公众号', kind: 'official' },
], status: { state: 'ready', monitoring: true, detail: '测试读取状态', updatedAt: '2026-08-31T00:00:00Z' } };
const settingsProps = () => ({ design: 'A' as const, onDesignChange: vi.fn(), appearance: { skin: 'warm' as const, accent: 'gold' as const }, onAppearanceChange: vi.fn(), layout: 'labelled' as const, onLayoutChange: vi.fn(), wechat: snapshot, wechatBusy: false, onStartWechat: vi.fn(), onStopWechat: vi.fn(), onSelectWechatRoot: vi.fn(), onNotice: vi.fn(), onSettingsChanged: vi.fn(), onOpenKnowledge: vi.fn() });

beforeEach(() => {
  vi.clearAllMocks();
  hooks.useRef.mockImplementation((value: unknown) => ({ current: value }));
  hooks.useMemo.mockImplementation((factory: () => unknown) => factory());
  hooks.useCallback.mockImplementation((callback: unknown) => callback);
  hooks.useEffect.mockImplementation(() => undefined);
  hooks.useState.mockImplementation((value: unknown) => [typeof value === 'function' ? value() : value, vi.fn()]);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function stateOverrides(values: Record<number, unknown>) {
  const setters: Array<ReturnType<typeof vi.fn>> = [];
  let index = 0;
  hooks.useState.mockImplementation((initial: unknown) => {
    const stateIndex = index++;
    const setter = vi.fn(); setters[stateIndex] = setter;
    return [stateIndex in values ? values[stateIndex] : typeof initial === 'function' ? initial() : initial, setter];
  });
  return setters;
}

function findElements<T extends { children?: ReactNode }>(node: ReactNode, predicate: (element: ReactElement<T>) => boolean): Array<ReactElement<T>> {
  if (!isValidElement<T>(node)) return [];
  return [...(predicate(node) ? [node] : []), ...Children.toArray(node.props.children).flatMap((child) => findElements(child, predicate))];
}

function requireForm(tree: ReactNode, index = 0): ReactElement<ComponentProps<'form'>> {
  const value = findElements<ComponentProps<'form'>>(tree, (element) => element.type === 'form')[index];
  if (!value) throw new Error('Expected form');
  return value;
}

async function flush() { for (let i = 0; i < 12; i += 1) await Promise.resolve(); }
function installBridge(value: Partial<FeatureBridge>) { vi.stubGlobal('window', { salesCopilot: { getIntegrationSettings: vi.fn().mockResolvedValue({ ok: true, value: settings }), ...value } }); }

describe('feature view IPC boundaries', () => {
  it('shows cloud status without local folder or key configuration', () => {
    const cloud = { ...settings.knowledge, source: 'cloud' as const, state: 'ready' as const, documents: 6, chunks: 6, version: 'a'.repeat(64) };
    stateOverrides({ 1: { ...settings, knowledge: cloud }, 2: settings.crm, 3: settings.ai, 8: voice });
    const html = renderToStaticMarkup(SettingsView(settingsProps()));
    expect(html).toContain('公司云端知识库');
    expect(html).not.toContain('连接已有笔记目录');
    stateOverrides({ 0: cloud });
    const knowledge = renderToStaticMarkup(KnowledgeView({ onNotice: vi.fn(), onSettingsChanged: vi.fn() }));
    expect(knowledge).toContain('查找业务知识');
    expect(knowledge).not.toContain('资料审核');
    expect(knowledge).not.toContain('移除外部目录');
    if (process.env.CLOUD_UI_SNAPSHOT === '1') writeFileSync('outputs/cloud-ui-synthetic.html', `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;font-family:"Microsoft YaHei UI",sans-serif}button,input{font:inherit;padding:8px 12px}button{cursor:pointer}svg{width:20px;height:20px}${readFileSync('src/app/feature-views.css', 'utf8')}</style><body><p>合成界面验收，不代表真实账号已连接。</p>${knowledge}</body></html>`);
  });
  it('shows index errors as unavailable rather than reporting the previous successful document count', () => {
    const failedSettings = { ...settings, knowledge: { ...settings.knowledge, state: 'error' as const, indexedAt: '2030-01-01T00:00:00Z', documents: 0, warnings: ['合成索引错误'] } };
    stateOverrides({ 1: failedSettings, 2: settings.crm, 3: settings.ai, 8: voice });
    const html = renderToStaticMarkup(SettingsView(settingsProps()));
    expect(html).toContain('索引整理失败'); expect(html).toContain('知识引用已停用');
    expect(html).not.toContain('当前可检索');
  });

  it('rebuilds approved local knowledge without requiring an external folder', async () => {
    const reindex = vi.fn().mockResolvedValue({ ok: true, value: { ...settings.knowledge, state: 'ready', documents: 1, chunks: 1 } });
    installBridge({ reindexKnowledge: reindex });
    stateOverrides({ 0: settings.knowledge, 7: 'search' });
    const tree = KnowledgeView({ onNotice: vi.fn(), onSettingsChanged: vi.fn() });
    const action = findElements<{ children?: ReactNode; disabled?: boolean; onClick: () => void }>(tree, (element) => element.props.children === '重新整理')[0];
    expect(action.props.disabled).toBe(false); action.props.onClick(); await flush(); expect(reindex).toHaveBeenCalledTimes(1);
  });

  it('describes removal as external-only and preserves the local managed-knowledge boundary', () => {
    stateOverrides({ 0: { ...settings.knowledge, folderPath: 'synthetic-notes' }, 3: true, 7: 'search' });
    const tree = KnowledgeView({ onNotice: vi.fn(), onSettingsChanged: vi.fn() });
    const dialogs = findElements<{ children?: ReactNode; title?: string }>(tree, (element) => element.props.title === '移除外部目录索引？');
    const html = renderToStaticMarkup(<>{dialogs.map((item, index) => <div key={index}>{item.props.children}</div>)}</>);
    expect(html).toContain('原文件不会删除'); expect(html).toContain('本机资料不受影响');
    expect(html).not.toContain('清空本软件');
  });

  it('clears trial search results when the question changes and disables editing during a search', () => {
    const setters = stateOverrides({ 0: { ...settings.knowledge, documents: 1 }, 1: '旧问题', 2: [{ id: 'kb:old', title: '旧结果', text: '旧正文', sourcePath: '本机资料/test/v1', score: 1 }], 7: 'search' });
    let tree = KnowledgeView({ onNotice: vi.fn(), onSettingsChanged: vi.fn() });
    const field = findElements<ComponentProps<'input'>>(tree, (element) => element.type === 'input' && element.props.type === 'search')[0];
    field.props.onChange?.({ target: { value: '新问题' } } as never);
    expect(setters[2]).toHaveBeenCalledWith(null);
    stateOverrides({ 0: settings.knowledge, 5: 'knowledge-search', 7: 'search' });
    tree = KnowledgeView({ onNotice: vi.fn(), onSettingsChanged: vi.fn() });
    expect(findElements<ComponentProps<'input'>>(tree, (element) => element.type === 'input' && element.props.type === 'search')[0].props.disabled).toBe(true);
  });

  it('does not refresh settings for an inactive retained knowledge page', () => {
    const load = vi.fn(); installBridge({ getIntegrationSettings: load });
    KnowledgeView({ active: false, onNotice: vi.fn(), onSettingsChanged: vi.fn() });
    for (const [effect] of hooks.useEffect.mock.calls) effect();
    expect(load).not.toHaveBeenCalled();
  });

  it.each([
    ['ai', '回复模型与 API', 'CRM 服务地址'],
    ['voice', '离线语音转文字', 'API 密钥'],
    ['connections', 'CRM 服务地址', 'API 密钥'],
  ] as const)('opens the requested %s settings section directly', (initialSection, visible, absent) => {
    stateOverrides({ 1: settings, 2: settings.crm, 3: settings.ai, 8: voice });
    const html = renderToStaticMarkup(SettingsView({ ...settingsProps(), initialSection }));
    expect(html).toContain(visible);
    expect(html).not.toContain(absent);
  });

  it('saves an API key only on explicit submit, clears the input, and does not test or upload chats automatically', async () => {
    const update = vi.fn().mockResolvedValue({ ok: true, value: { ...settings, ai: { ...settings.ai, hasApiKey: true } } });
    const test = vi.fn(); const generate = vi.fn();
    installBridge({ updateIntegrationSettings: update, testAi: test, generateConversationReply: generate });
    const setters = stateOverrides({ 0: 'ai', 1: settings, 2: settings.crm, 3: settings.ai, 5: 'synthetic-api-key', 8: voice });
    const props = settingsProps();
    const tree = SettingsView(props);
    expect(update).not.toHaveBeenCalled();
    requireForm(tree).props.onSubmit?.({ preventDefault: vi.fn() } as unknown as Parameters<NonNullable<ComponentProps<'form'>['onSubmit']>>[0]);
    await flush();
    expect(update).toHaveBeenCalledWith({ ai: { ...editableAiSettings(settings.ai), apiKey: 'synthetic-api-key' } });
    expect(setters[5]).toHaveBeenCalledWith('');
    expect(test).not.toHaveBeenCalled(); expect(generate).not.toHaveBeenCalled();
    expect(props.onSettingsChanged).toHaveBeenCalledOnce();
    expect(props.onSettingsChanged).toHaveBeenCalledWith('ai');
  });

  it('saves CRM endpoint before login, clears the password, and keeps unrelated model edits intact', async () => {
    const update = vi.fn().mockResolvedValue({ ok: true, value: settings });
    const login = vi.fn().mockResolvedValue({ ok: true, value: { kind: 'authenticated', user: { id: 1 } } });
    installBridge({ updateIntegrationSettings: update, loginCrm: login });
    const setters = stateOverrides({ 1: settings, 2: settings.crm, 3: { ...settings.ai, model: 'unsaved-model' }, 4: 'synthetic-password', 8: voice });
    const tree = SettingsView(settingsProps());
    requireForm(tree).props.onSubmit?.({ preventDefault: vi.fn() } as unknown as Parameters<NonNullable<ComponentProps<'form'>['onSubmit']>>[0]);
    await flush();
    expect(update).toHaveBeenCalledWith({ crm: editableCrmSettings(settings.crm) });
    expect(login).toHaveBeenCalledWith({ username: settings.crm.username, password: 'synthetic-password', rememberSession: false });
    expect(update.mock.invocationCallOrder[0]).toBeLessThan(login.mock.invocationCallOrder[0]);
    expect(setters[4]).toHaveBeenCalledWith('');
    expect(setters[3]).not.toHaveBeenCalled();
  });

  it('polls voice progress while a download is pending without refreshing or erasing form drafts', async () => {
    vi.useFakeTimers();
    const nextVoice = { ...voice, state: 'downloading', downloadedBytes: 1024 };
    const getVoiceStatus = vi.fn().mockResolvedValue(nextVoice);
    const getSettings = vi.fn();
    installBridge({ getVoiceStatus, getIntegrationSettings: getSettings });
    const setters = stateOverrides({ 0: 'voice', 1: settings, 2: settings.crm, 3: { ...settings.ai, model: 'unsaved' }, 8: voice, 13: 'voice-download' });
    SettingsView(settingsProps());
    const cleanup = hooks.useEffect.mock.calls[2][0]();
    await vi.advanceTimersByTimeAsync(1200);
    expect(getVoiceStatus).toHaveBeenCalledOnce();
    expect(setters[8]).toHaveBeenCalledWith(nextVoice);
    expect(getSettings).not.toHaveBeenCalled();
    expect(setters[2]).not.toHaveBeenCalled(); expect(setters[3]).not.toHaveBeenCalled();
    cleanup();
  });

  it('does not download a model merely by opening the voice settings', () => {
    const download = vi.fn(); installBridge({ downloadVoiceModel: download });
    stateOverrides({ 0: 'voice', 1: settings, 2: settings.crm, 3: settings.ai, 8: voice });
    const html = renderToStaticMarkup(SettingsView(settingsProps()));
    expect(html).toContain('下载离线模型'); expect(html).toContain('FunASR');
    expect(download).not.toHaveBeenCalled();
  });

  it('offers full A/B/C designs separately from navigation width and delegates persistence', () => {
    stateOverrides({ 0: 'layout', 1: settings, 2: settings.crm, 3: settings.ai, 8: voice });
    const props = settingsProps();
    const settingsTree = SettingsView(props);
    const appearancePanel = findElements<ComponentProps<typeof AppearanceSettings> & { children?: ReactNode }>(settingsTree, (element) => element.type === AppearanceSettings)[0];
    expect(appearancePanel.props.appearance).toEqual(props.appearance);
    const tree = AppearanceSettings(appearancePanel.props);
    const designs = findElements<ComponentProps<'input'>>(tree, (element) => element.type === 'input' && element.props.name === 'workspace-design');
    expect(designs).toHaveLength(3);
    designs[1].props.onChange?.({} as Parameters<NonNullable<ComponentProps<'input'>['onChange']>>[0]);
    expect(props.onDesignChange).toHaveBeenCalledWith('B');
    designs[2].props.onChange?.({} as Parameters<NonNullable<ComponentProps<'input'>['onChange']>>[0]);
    expect(props.onDesignChange).toHaveBeenCalledWith('C');
    expect(props.onLayoutChange).not.toHaveBeenCalled();
    expect(props.onAppearanceChange).not.toHaveBeenCalled();
    const radios = findElements<ComponentProps<'input'>>(tree, (element) => element.type === 'input' && element.props.name === 'navigation-layout');
    expect(radios).toHaveLength(2);
    radios[1].props.onChange?.({} as Parameters<NonNullable<ComponentProps<'input'>['onChange']>>[0]);
    expect(props.onLayoutChange).toHaveBeenCalledWith('compact');
    expect(renderToStaticMarkup(tree)).toContain('76 px');
    expect(renderToStaticMarkup(tree)).toContain('56 px');
  });

  it('honors a new settings navigation request while mounted without clearing unsaved connection/model fields', () => {
    const setters = stateOverrides({ 0: 'ai', 1: settings, 2: settings.crm, 3: settings.ai, 8: voice });
    SettingsView({ ...settingsProps(), initialSection: 'layout', navigationRevision: 7 });
    const navigation = hooks.useEffect.mock.calls.find((call) => Array.isArray(call[1]) && call[1][0] === 'layout' && call[1][1] === 7);
    expect(navigation).toBeDefined(); navigation?.[0]();
    expect(setters[0]).toHaveBeenCalledWith('layout');
    expect(setters[2]).not.toHaveBeenCalled(); expect(setters[3]).not.toHaveBeenCalled();
  });

  it('does not equate denied CRM access with no records or display arbitrary private fields', () => {
    const html = renderToStaticMarkup(<CrmContextDetails context={{ customer: { id: 1, name: '合成测试', password: 'do-not-display' }, followups: [], calls: [], tasks: [], houseTargets: [], fetchedAt: '2026-08-31T00:00:00Z', sourceBaseUrl: 'https://crm.example.test', availability: { followups: 'forbidden', calls: 'available' } }} />);
    expect(html).toContain('无权读取'); expect(html).toContain('CRM 暂无电话记录');
    expect(html).not.toContain('do-not-display');
  });

  it('drops a late CRM search result after the binding dialog scope closes', async () => {
    let finishSearch: ((value: unknown) => void) | undefined;
    installBridge({ getConversationCrmBinding: vi.fn().mockResolvedValue({ ok: true, value: null }), searchCrmCustomers: vi.fn().mockImplementation(() => new Promise((resolve) => { finishSearch = resolve; })) });
    const setters = stateOverrides({ 0: '测试电话' });
    const tree = CrmBindingDialog({ scope: { accountKey: 'test-account', contactKey: 'test-chat' }, open: true, onOpenChange: vi.fn(), onBound: vi.fn(), onNotice: vi.fn() });
    const cleanup = hooks.useEffect.mock.calls[0][0]();
    await flush(); setters[1].mockClear();
    requireForm(tree).props.onSubmit?.({ preventDefault: vi.fn() } as unknown as Parameters<NonNullable<ComponentProps<'form'>['onSubmit']>>[0]);
    cleanup();
    if (!finishSearch) throw new Error('Search did not start');
    finishSearch({ ok: true, value: [{ id: 2, name: '旧会话资料', phone: '000' }] });
    await flush();
    expect(setters[1]).not.toHaveBeenCalled();
  });

  it('labels partial exports without claiming all resources were saved', () => {
    installBridge({});
    stateOverrides({ 3: { id: 'task', state: 'complete', result: { ok: true, completeness: 'partial', fileName: 'conversation.html', messageCount: 12, mediaCount: 1, warnings: ['附件缺失'] } } });
    const html = renderToStaticMarkup(ExportView({ snapshot, onNotice: vi.fn() }));
    expect(html).toContain('部分导出完成，请核对缺失项');
    expect(html).not.toContain('所选范围导出完成');
    expect(html).toContain('附件缺失');
  });

  it('offers five export formats, defaults to single chats and shows their avatars', () => {
    const start = vi.fn(); installBridge({ startConversationExport: start });
    const html = renderToStaticMarkup(ExportView({ snapshot, initialContactKey: 'contact-test', onNotice: vi.fn() }));
    expect(html).toContain('关联 CRM 不是前置条件'); expect(html).toContain('全部日期与全部消息类型');
    expect(html).toContain('peer-avatar'); expect(html).toContain('合成测试客户');
    expect(html).toContain('aria-pressed="true"'); expect(html).toContain('单聊'); expect(html).toContain('群聊');
    expect(html).not.toContain('合成测试群聊'); expect(html).not.toContain('不应导出的公众号');
    expect(html).toContain('文件格式'); expect(html).toContain('HTML · 网页聊天档案'); expect(html).toContain('Markdown · 知识整理');
    expect(html).toContain('CSV · 表格'); expect(html).toContain('JSON · 结构化数据'); expect(html).toContain('TXT · 纯文字');
    expect(html).not.toContain('开始日期'); expect(html).not.toContain('消息类型</legend>');
    expect(html).toContain('缺失清单');
    expect(html).toContain('选择保存位置并导出');
    expect(start).not.toHaveBeenCalled();
  });

  it('forwards the selected non-HTML format with its supported export preset', async () => {
    const start = vi.fn().mockResolvedValue({ ok: true, value: { id: 'export-task', state: 'running' } });
    installBridge({ startConversationExport: start });
    stateOverrides({ 9: 'csv' });
    const tree = ExportView({ snapshot, initialContactKey: 'contact-test', onNotice: vi.fn() });
    requireForm(tree).props.onSubmit?.({ preventDefault: vi.fn() } as never);
    await flush();
    expect(start).toHaveBeenCalledWith({ accountKey: 'account-test', request: expect.objectContaining({ format: 'csv', includeAvatars: false, media: 'none', zip: false }) });
  });

  it('keeps a visible selected state for the single/group conversation control', () => {
    const css = readFileSync('src/app/feature-views.css', 'utf8');
    expect(css).toContain('.fv-export-kind-tabs button[aria-pressed="true"]');
    expect(css).not.toContain('.fv-export-kind-tabs button[aria-selected=true]');
  });

  it('reapplies a repeated export navigation target and synchronizes its conversation kind', () => {
    const applied = { current: '8:contact-test' };
    hooks.useRef.mockImplementationOnce(() => applied);
    const setters = stateOverrides({ 0: ['group-test'], 1: 'group' });
    ExportView({ snapshot, initialContactKey: 'contact-test', navigationRevision: 9, onNotice: vi.fn() });
    const navigation = hooks.useEffect.mock.calls.find((call) => Array.isArray(call[1]) && call[1][0] === '9:contact-test');
    expect(navigation?.[1]).toEqual(['9:contact-test', false, 'contact-test', 'contact']); navigation?.[0]();
    expect(applied.current).toBe('9:contact-test');
    expect(setters[0]).toHaveBeenCalledWith(['contact-test']);
    expect(setters[1]).toHaveBeenCalledWith('contact');
  });

  it('does not replay an already applied navigation when an export task completes', () => {
    const applied = { current: '9:contact-test' };
    hooks.useRef.mockImplementationOnce(() => applied);
    const setters = stateOverrides({ 0: ['contact-test', 'group-test'], 1: 'group', 3: { id: 'task', state: 'complete' } });
    ExportView({ snapshot, initialContactKey: 'contact-test', navigationRevision: 9, onNotice: vi.fn() });
    const navigation = hooks.useEffect.mock.calls.find((call) => Array.isArray(call[1]) && call[1][0] === '9:contact-test');
    expect(navigation?.[1]).toEqual(['9:contact-test', false, 'contact-test', 'contact']); navigation?.[0]();
    expect(setters[0]).not.toHaveBeenCalled();
    expect(setters[1]).not.toHaveBeenCalled();
  });

  it('does not restore a locally hidden contact when more raw WeChat conversations are loaded', () => {
    stateOverrides({ 6: [{ contactKey: 'hidden-test', displayName: '已隐藏测试客户', kind: 'contact' }] });
    const html = renderToStaticMarkup(ExportView({ snapshot, hiddenContactKeys: ['hidden-test'], onNotice: vi.fn() }));
    expect(html).not.toContain('已隐藏测试客户');
  });
});
