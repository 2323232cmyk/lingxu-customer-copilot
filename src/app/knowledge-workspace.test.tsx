import { Children, isValidElement, type ComponentProps, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Button } from '@fluentui/react-components';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeatureBridge } from '../shared/feature-bridge-contracts';
import type { KnowledgeDocument, KnowledgeWorkspace } from '../shared/knowledge-workspace-contracts';
import { KnowledgeWorkspaceView } from './KnowledgeWorkspaceView';
import { knowledgeDraftFrom } from './knowledge-workspace-model';

const hooks = vi.hoisted(() => ({ useState: vi.fn(), useRef: vi.fn(), useEffect: vi.fn() }));
vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(), ...hooks }));
vi.mock('@fluentui/react-components', async () => {
  const { createElement } = await import('react');
  const group = (tag: string) => (props: { children?: ReactNode }) => createElement(tag, null, props.children);
  return {
    Button: (props: ComponentProps<'button'>) => createElement('button', { disabled: props.disabled, onClick: props.onClick, type: props.type, 'aria-label': props['aria-label'] }, props.children),
    Dialog: (props: { open: boolean; children?: ReactNode }) => props.open ? createElement('section', { role: 'dialog' }, props.children) : null,
    DialogSurface: group('div'), DialogBody: group('div'), DialogTitle: group('h2'), DialogContent: group('div'), DialogActions: group('div'),
  };
});

const record: KnowledgeDocument = { id: '37c93bc6-dd58-44f8-8336-26555fd7c218', title: '合成资料', body: '仅用于自动化测试。', expiry: null, status: 'draft', revision: 3, sourceKind: 'manual', sourceName: null, approvedAt: null, createdAt: '2030-01-01T00:00:00Z', updatedAt: '2030-01-01T00:00:00Z' };
const empty: KnowledgeWorkspace = { documents: [], counts: { total: 0, draft: 0, approved: 0, expired: 0, disabled: 0 } };
const props = () => ({ active: true, onNotice: vi.fn(), onChanged: vi.fn(), onOpenSearch: vi.fn() });

beforeEach(() => {
  vi.clearAllMocks();
  hooks.useState.mockImplementation((initial: unknown) => [typeof initial === 'function' ? initial() : initial, vi.fn()]);
  hooks.useRef.mockImplementation((initial: unknown) => ({ current: initial }));
  hooks.useEffect.mockImplementation(() => undefined);
  vi.stubGlobal('document', { activeElement: null });
  vi.stubGlobal('HTMLElement', class {});
  vi.stubGlobal('requestAnimationFrame', vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

function overrides(values: Record<number, unknown>) {
  const setters: Array<ReturnType<typeof vi.fn>> = [];
  let index = 0;
  hooks.useState.mockImplementation((initial: unknown) => {
    const current = index++; const setter = vi.fn(); setters[current] = setter;
    return [current in values ? values[current] : typeof initial === 'function' ? initial() : initial, setter];
  });
  return setters;
}
function elements<T extends { children?: ReactNode }>(node: ReactNode, predicate: (element: ReactElement<T>) => boolean): Array<ReactElement<T>> {
  if (!isValidElement<T>(node)) return [];
  return [...(predicate(node) ? [node] : []), ...Children.toArray(node.props.children).flatMap((child) => elements(child, predicate))];
}
function button(tree: ReactNode, label: string) {
  const result = elements<ComponentProps<typeof Button>>(tree, (item) => item.type === Button && (item.props.children === label || item.props['aria-label'] === label))[0];
  if (!result) throw new Error(`Missing button: ${label}`);
  return result;
}
function click(tree: ReactNode, label: string) { button(tree, label).props.onClick?.({} as never); }
function submit(tree: ReactNode) { elements<ComponentProps<'form'>>(tree, (item) => item.type === 'form')[0].props.onSubmit?.({ preventDefault: vi.fn() } as never); }
async function flush() { for (let index = 0; index < 24; index += 1) await Promise.resolve(); }
function api(overrides: Partial<FeatureBridge> = {}) {
  const value = { getKnowledgeWorkspace: vi.fn().mockResolvedValue({ ok: true, value: empty }), createKnowledgeDocument: vi.fn(), setKnowledgeDocumentStatus: vi.fn(), generateConversationReply: vi.fn(), ...overrides };
  vi.stubGlobal('window', { salesCopilot: value });
  return value;
}

describe('knowledge workspace review boundaries', () => {
  it('starts with a truthful empty inbox and no invented business content or automatic mutations', () => {
    overrides({ 0: empty }); const bridge = api();
    const html = renderToStaticMarkup(KnowledgeWorkspaceView(props()));
    expect(html).toContain('还没有本机资料'); expect(html).toContain('待审核');
    expect(html).not.toContain('合成资料');
    expect(bridge.createKnowledgeDocument).not.toHaveBeenCalled();
    expect(bridge.setKnowledgeDocumentStatus).not.toHaveBeenCalled(); expect(bridge.generateConversationReply).not.toHaveBeenCalled();
  });

  it('imports only through the main-process file dialog without page-supplied paths or automatic approval', async () => {
    overrides({ 0: empty });
    const imported = vi.fn().mockResolvedValue({ ok: true, value: { imported: [], skipped: [{ name: 'example.pdf', error: '格式不支持' }] } });
    const bridge = api({ importKnowledgeDocuments: imported }); const viewProps = props();
    click(KnowledgeWorkspaceView(viewProps), '导入 MD / TXT'); await flush();
    expect(imported).toHaveBeenCalledWith(); expect(imported).toHaveBeenCalledTimes(1);
    expect(bridge.setKnowledgeDocumentStatus).not.toHaveBeenCalled(); expect(bridge.generateConversationReply).not.toHaveBeenCalled();
    expect(viewProps.onChanged).toHaveBeenCalledTimes(2);
  });

  it('saves a manual entry as a draft without sending status or approval metadata', async () => {
    const draft = knowledgeDraftFrom(record); const create = vi.fn().mockResolvedValue({ ok: true, value: record });
    const setters = overrides({ 0: empty, 2: true, 3: draft }); const bridge = api({ createKnowledgeDocument: create });
    submit(KnowledgeWorkspaceView(props())); await flush();
    expect(create).toHaveBeenCalledWith(draft); expect(create).toHaveBeenCalledTimes(1);
    expect(setters[1]).toHaveBeenCalledWith(record); expect(setters[9]).toHaveBeenCalledWith(false);
    expect(bridge.setKnowledgeDocumentStatus).not.toHaveBeenCalled();
  });

  it('sends the selected revision when saving and does not reapprove an edited approved document', async () => {
    const selected = { ...record, status: 'approved' as const };
    const draft = { ...knowledgeDraftFrom(record), body: '合成修订内容' };
    const save = vi.fn().mockResolvedValue({ ok: true, value: { ...record, ...draft, revision: 4 } });
    overrides({ 0: empty, 1: selected, 3: draft, 9: true }); const bridge = api({ saveKnowledgeDocument: save });
    const tree = KnowledgeWorkspaceView(props());
    expect(renderToStaticMarkup(tree)).toContain('立即退出回复依据');
    submit(tree); await flush();
    expect(save).toHaveBeenCalledWith({ ...draft, id: record.id, expectedRevision: 3 });
    expect(bridge.setKnowledgeDocumentStatus).not.toHaveBeenCalled();
  });

  it.each([false, true])('requires the review check and a separate confirmation before approval (reviewed=%s)', async (reviewed) => {
    const changeStatus = vi.fn().mockResolvedValue({ ok: true, value: { ...record, status: 'approved', revision: 4 } });
    const setters = overrides({ 0: empty, 1: record, 3: knowledgeDraftFrom(record), 9: reviewed }); api({ setKnowledgeDocumentStatus: changeStatus });
    const tree = KnowledgeWorkspaceView(props());
    expect(button(tree, '审核并启用').props.disabled).toBe(!reviewed);
    if (reviewed) { click(tree, '审核并启用'); expect(setters[10]).toHaveBeenCalledWith({ kind: 'approve' }); }
    expect(changeStatus).not.toHaveBeenCalled();
    overrides({ 0: empty, 1: record, 3: knowledgeDraftFrom(record), 9: reviewed, 10: { kind: 'approve' } });
    const confirmation = KnowledgeWorkspaceView(props());
    click(confirmation, '确认启用'); await flush();
    if (reviewed) expect(changeStatus).toHaveBeenCalledWith({ id: record.id, expectedRevision: 3, status: 'approved' });
    else expect(changeStatus).not.toHaveBeenCalled();
  });

  it('blocks approval of dirty text even if the confirmation dialog was already open', async () => {
    overrides({ 0: empty, 1: record, 3: { ...knowledgeDraftFrom(record), body: '还没有保存' }, 9: true, 10: { kind: 'approve' } });
    const bridge = api(); const tree = KnowledgeWorkspaceView(props());
    expect(button(tree, '确认启用').props.disabled).toBe(true);
    click(tree, '确认启用'); await flush(); expect(bridge.setKnowledgeDocumentStatus).not.toHaveBeenCalled();
  });

  it('prompts before replacing unsaved content and reads only the explicitly selected document', async () => {
    const get = vi.fn().mockResolvedValue({ ok: true, value: record });
    const setters = overrides({ 0: empty, 1: record, 3: { ...knowledgeDraftFrom(record), body: '未保存' } }); api({ getKnowledgeDocument: get });
    click(KnowledgeWorkspaceView(props()), '重新读取此资料');
    expect(get).not.toHaveBeenCalled(); expect(setters[10]).toHaveBeenCalledWith({ kind: 'open', id: record.id });
    overrides({ 0: empty, 1: record, 3: { ...knowledgeDraftFrom(record), body: '未保存' }, 10: { kind: 'open', id: record.id } });
    click(KnowledgeWorkspaceView(props()), '放弃修改并继续'); await flush();
    expect(get).toHaveBeenCalledWith(record.id); expect(get).toHaveBeenCalledTimes(1);
  });

  it('keeps unsaved text when a saved-but-index-failed response requires reloading the result', async () => {
    const save = vi.fn().mockResolvedValue({ ok: false, error: '资料已保存，但索引未完成；请重新整理后再使用，不要重复新建。' });
    const setters = overrides({ 0: empty, 2: true, 3: knowledgeDraftFrom(record) }); api({ createKnowledgeDocument: save });
    submit(KnowledgeWorkspaceView(props())); await flush();
    expect(setters[7]).toHaveBeenCalledWith(expect.stringContaining('资料已保存'));
    expect(setters[11]).toHaveBeenCalledWith(true); expect(setters[3]).not.toHaveBeenCalled();
    overrides({ 0: empty, 2: true, 3: knowledgeDraftFrom(record), 11: true });
    const blocked = KnowledgeWorkspaceView(props()); expect(button(blocked, '保存为待审核').props.disabled).toBe(true);
    submit(blocked); await flush(); expect(save).toHaveBeenCalledTimes(1);
  });

  it('does not misreport a cancelled file selection as a failure or enable any material', async () => {
    const setters = overrides({ 0: empty });
    const bridge = api({ importKnowledgeDocuments: vi.fn().mockResolvedValue({ ok: false, cancelled: true, error: '已取消' }) });
    const viewProps = props(); click(KnowledgeWorkspaceView(viewProps), '导入 MD / TXT'); await flush();
    expect(setters[7]).toHaveBeenCalledWith(''); expect(setters[7]).not.toHaveBeenCalledWith('已取消');
    expect(setters[11]).not.toHaveBeenCalled(); expect(viewProps.onNotice).not.toHaveBeenCalled(); expect(bridge.setKnowledgeDocumentStatus).not.toHaveBeenCalled();
  });

  it('rejects double submit while a save is still pending', async () => {
    overrides({ 0: empty, 2: true, 3: knowledgeDraftFrom(record) });
    let complete!: (value: unknown) => void;
    const create = vi.fn().mockReturnValue(new Promise((resolve) => { complete = resolve; })); api({ createKnowledgeDocument: create });
    const tree = KnowledgeWorkspaceView(props()); submit(tree); submit(tree);
    expect(create).toHaveBeenCalledTimes(1); complete({ ok: true, value: record }); await flush();
  });

  it('renders source text as text, not HTML, and reports skipped imports honestly', () => {
    overrides({ 0: empty, 1: { ...record, title: '<script>unsafe()</script>' }, 3: { ...knowledgeDraftFrom(record), title: '<script>unsafe()</script>', body: '<img src=x onerror=unsafe()>' }, 8: { imported: [], skipped: [{ name: '资料.pdf', error: '仅支持 MD / TXT' }] } });
    api(); const html = renderToStaticMarkup(KnowledgeWorkspaceView(props()));
    expect(html).not.toContain('<script>unsafe()'); expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img'); expect(html).toContain('未导入 1 份'); expect(html).toContain('仅支持 MD / TXT');
  });

  it('does not read the knowledge list when its retained page is hidden', () => {
    const bridge = api(); KnowledgeWorkspaceView({ ...props(), active: false });
    for (const call of hooks.useEffect.mock.calls) call[0]();
    expect(bridge.getKnowledgeWorkspace).not.toHaveBeenCalled();
  });
});
