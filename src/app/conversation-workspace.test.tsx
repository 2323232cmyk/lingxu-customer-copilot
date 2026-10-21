import { Children, isValidElement, type ComponentProps, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WechatLiveMessage, WechatLiveSnapshot } from '../shared/contracts';
import { ConversationWorkspace } from './ConversationWorkspace';
import { WechatConversationQueue } from './WechatConversationQueue';
import { ReplyComposer } from './ReplyComposer';
import { VoiceMessage } from './VoiceMessage';

const hooks = vi.hoisted(() => ({ useState: vi.fn(), useRef: vi.fn(), useEffect: vi.fn(), useMemo: vi.fn(), useCallback: vi.fn(), useDeferredValue: vi.fn() }));
vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(), ...hooks }));
vi.mock('@fluentui/react-components', async () => {
  const { createElement } = await import('react');
  const group = (tag: string) => (props: { children?: ReactNode }) => createElement(tag, null, props.children);
  return {
    Button: (props: ComponentProps<'button'> & { icon?: ReactNode }) => createElement('button', { disabled: props.disabled, type: props.type, onClick: props.onClick, 'aria-label': props['aria-label'] }, props.children),
    Input: (props: ComponentProps<'input'>) => createElement('input', { value: props.value, 'aria-label': props['aria-label'], readOnly: true }),
    Dialog: () => null, DialogActions: group('div'), DialogBody: group('div'), DialogContent: group('div'), DialogSurface: group('div'), DialogTitle: group('h2'), Tooltip: group('div'),
    Menu: group('div'), MenuTrigger: group('div'), MenuPopover: group('div'), MenuList: group('div'), MenuItem: group('button'),
  };
});
vi.mock('./FeatureViews', () => ({ CrmBindingDialog: () => null }));
vi.mock('./VoiceMessage', () => ({ VoiceMessage: () => null }));
vi.mock('./wechat-media', async () => {
  const { createElement } = await import('react');
  return {
    PrivateImage: (props: { alt: string; mediaKey?: string }) => createElement('span', { role: 'img', 'aria-label': props.alt, 'data-media-key': props.mediaKey }),
    WechatMessageBody: (props: { message: WechatLiveMessage }) => createElement('p', null, props.message.text),
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  hooks.useState.mockImplementation((initial: unknown) => [typeof initial === 'function' ? initial() : initial, vi.fn()]);
  hooks.useRef.mockImplementation((initial: unknown) => ({ current: initial }));
  hooks.useMemo.mockImplementation((factory: () => unknown) => factory());
  hooks.useCallback.mockImplementation((callback: unknown) => callback);
  hooks.useDeferredValue.mockImplementation((value: unknown) => value);
  hooks.useEffect.mockImplementation(() => undefined);
});
afterEach(() => vi.unstubAllGlobals());

function state(values: Record<number, unknown>) {
  let index = 0;
  hooks.useState.mockImplementation((initial: unknown) => {
    const current = index++;
    return [current in values ? values[current] : typeof initial === 'function' ? initial() : initial, vi.fn()];
  });
}
function elements<T extends { children?: ReactNode }>(node: ReactNode, test: (element: ReactElement<T>) => boolean): ReactElement<T>[] {
  if (!isValidElement<T>(node)) return [];
  return [...(test(node) ? [node] : []), ...Children.toArray(node.props.children).flatMap((child) => elements(child, test))];
}
const message: WechatLiveMessage = { id: 'message-test', contactKey: 'contact-test', direction: 'incoming', sender: '测试客户', text: '周末有空，想了解流程', messageType: 'text', sentAt: '2026-08-31T00:00:00Z', observedAt: '2026-08-31T00:00:01Z' };
const snapshot: WechatLiveSnapshot = { revision: 1, accountKey: 'account-test', conversations: [{ contactKey: 'contact-test', kind: 'contact', displayName: '测试客户', avatarMediaKey: 'peer-avatar' }], status: { state: 'streaming', detail: '读取中', monitoring: true, updatedAt: '2026-08-31T00:00:01Z' } };
const workspaceProps = (): ComponentProps<typeof ConversationWorkspace> => ({ scope: { accountKey: 'account-test', contactKey: 'contact-test' }, conversation: snapshot.conversations[0], messages: [message], status: snapshot.status, selfAvatarMediaKey: 'self-avatar', loading: false, settingsRevision: 0, design: 'A', messageSource: 'fresh', onReload: vi.fn(), onLoadEarlier: vi.fn(), onOpenSettings: vi.fn(), onNotice: vi.fn() });
const queueProps = (): ComponentProps<typeof WechatConversationQueue> => ({ snapshot, loading: false, preferences: { hidden: [], pinned: [] }, onSelect: vi.fn(), onRefresh: vi.fn(), onStart: vi.fn(), onPreference: vi.fn(), onCopyName: vi.fn() });
type ComposerProps = ComponentProps<typeof ReplyComposer> & { children?: ReactNode };
const composers = (node: ReactNode) => elements<ComposerProps>(node, (element) => element.type === ReplyComposer);

describe('conversation layout and preserved editor contracts (synthetic Node rendering)', () => {
  it('shows only the selected draft knowledge references and labels edited drafts accurately', () => {
    const props: ComposerProps = {
      drafts: [{ id: 'one', text: '核实费用', reason: '', sourceIds: ['kb:fee'] }, { id: 'two', text: '核实安排', reason: '', sourceIds: ['chat:1'] }],
      sources: [{ id: 'kb:fee', title: '费用依据' }, { id: 'kb:unused', title: '未引用资料' }],
      knowledgeStatus: 'included', disabled: false, generating: false, generated: true,
      onCopy: async () => true, onGenerate: () => undefined,
    };
    const initial = renderToStaticMarkup(ReplyComposer(props));
    expect(initial).toContain('本条知识来源：费用依据');
    expect(initial).not.toContain('未引用资料');
    state({ 0: 1 });
    expect(renderToStaticMarkup(ReplyComposer(props))).toContain('本条草稿未引用知识片段');
    state({ 0: 0, 1: { 0: '修改后的答复' } });
    expect(renderToStaticMarkup(ReplyComposer(props))).toContain('原草稿知识来源（编辑后请核对）');
  });

  it('keeps message times visible for older messages inside the same date group', () => {
    const sentAt = '2026-08-30T02:03:00Z';
    const tree = ConversationWorkspace({ ...workspaceProps(), messages: [{ ...message, sentAt }] });
    const bubble = elements<ComponentProps<'div'>>(tree, (element) => element.props.className === 'message-bubble')[0];
    const time = elements<ComponentProps<'time'>>(bubble, (element) => element.type === 'time')[0];
    expect(time.props.children).toBe(new Date(sentAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }));
  });
  it('protects the editor from new typing during generation and makes it editable afterwards', () => {
    const props = { drafts: [], disabled: false, generated: false, onCopy: vi.fn(), onGenerate: vi.fn() };
    const pending = elements<ComponentProps<'textarea'>>(ReplyComposer({ ...props, generating: true }), (element) => element.type === 'textarea')[0];
    expect(pending.props.readOnly).toBe(true);
    const ready = elements<ComponentProps<'textarea'>>(ReplyComposer({ ...props, generating: false }), (element) => element.type === 'textarea')[0];
    expect(ready.props.readOnly).toBe(false);
  });
  it.each(['A', 'B', 'C'] as const)('%s retains both avatars and one editor without a duplicate composer', (design) => {
    const html = renderToStaticMarkup(ConversationWorkspace({ ...workspaceProps(), design, messages: [message, { ...message, id: 'outgoing', direction: 'outgoing', text: '测试回复' }] }));
    expect(html).not.toContain('导出聊天 + CRM');
    expect(html).toContain('peer-avatar'); expect(html).toContain('self-avatar');
    expect(html).not.toContain('chat-manual-footer'); expect(html).not.toContain('dossier-composer'); expect(html).not.toContain('dossier-profile');
    expect((html.match(/<textarea/g) || [])).toHaveLength(1);
    expect(html.includes('客户资料与跟进履历')).toBe(design === 'B');
    expect(html.includes('conversation-crm-panel')).toBe(design === 'B');
  });
  it('keeps the same editor identity during refreshes and across all three layouts', () => {
    const props = workspaceProps();
    const initial = composers(ConversationWorkspace(props));
    const loading = composers(ConversationWorkspace({ ...props, loading: true, messageSource: 'cached', design: 'B' }));
    expect(initial).toHaveLength(1);
    expect(loading.map((item) => item.key)).toEqual(initial.map((item) => item.key));
    expect(loading[0].props.disabled).toBe(true); expect(initial[0].props.disabled).toBe(false);
    expect(composers(ConversationWorkspace({ ...props, design: 'C' })).map((item) => item.key)).toEqual(initial.map((item) => item.key));
  });
  it.each(['A', 'B', 'C'] as const)('%s starts empty without preselecting local sales scripts', (design) => {
    const copy = vi.fn(); vi.stubGlobal('window', { salesCopilot: { copyText: copy } });
    const editor = composers(ConversationWorkspace({ ...workspaceProps(), design }))[0];
    expect(editor.props.drafts).toEqual([]); expect(editor.props.generated).toBe(false); expect(copy).not.toHaveBeenCalled();
  });
  it('blocks manual copying when current conversation data is unavailable', async () => {
    const copy = vi.fn(); vi.stubGlobal('window', { salesCopilot: { copyText: copy } });
    const editor = composers(ConversationWorkspace({ ...workspaceProps(), messageSource: 'cached' }))[0];
    expect(editor.props.disabled).toBe(true);
    expect(await editor.props.onCopy('人工编写的草稿')).toBe(false); expect(copy).not.toHaveBeenCalled();
  });
  it.each(['客户资料', '引用'])('keeps the editor mounted while checking %s', (tab) => {
    const props = workspaceProps();
    const initial = composers(ConversationWorkspace(props));
    state({ 0: tab });
    const tree = ConversationWorkspace(props);
    expect(composers(tree).map((item) => item.key)).toEqual(initial.map((item) => item.key));
    expect(elements<ComponentProps<'div'>>(tree, (element) => element.props.className === 'advice-tab-content')[0].props.hidden).toBe(true);
  });
  it('preserves the editor when new messages arrive but isolates a different customer', () => {
    const props = workspaceProps();
    const first = composers(ConversationWorkspace(props)).map((item) => item.key);
    const second = composers(ConversationWorkspace({ ...props, messages: [{ ...message, text: '这周没空，下周再聊' }] })).map((item) => item.key);
    expect(second).toEqual(first);
    const other = composers(ConversationWorkspace({ ...props, scope: { ...props.scope, contactKey: 'another-customer' } })).map((item) => item.key);
    expect(other).not.toEqual(first);
  });
  it('distinguishes inaccessible CRM followups from zero rows in the summary', () => {
    state({ 0: '客户资料', 5: { customer: { id: 1, name: '合成客户' }, followups: [], calls: [], tasks: [], houseTargets: [], fetchedAt: '2026-08-31T00:00:00Z', sourceBaseUrl: 'https://crm.example.test', availability: { followups: 'forbidden', calls: 'forbidden' } } });
    const html = renderToStaticMarkup(ConversationWorkspace(workspaceProps()));
    expect(html).toContain('跟进：无读取权限'); expect(html).toContain('通话：无读取权限');
    expect(html).not.toContain('跟进 0 条'); expect(html).not.toContain('通话 0 条');
  });
  it('does not register a conversation shortcut while the page is hidden', () => {
    const add = vi.fn(); vi.stubGlobal('window', { addEventListener: add });
    ConversationWorkspace({ ...workspaceProps(), active: false });
    hooks.useEffect.mock.calls.at(-1)?.[0](); expect(add).not.toHaveBeenCalled();
  });
  it('maps confirmed voice text to the supplied message ID', () => {
    const tree = ConversationWorkspace({ ...workspaceProps(), messages: [{ ...message, id: 'voice-7', messageType: 'voice', text: '[语音]' }] });
    const voice = elements<ComponentProps<typeof VoiceMessage> & { children?: ReactNode }>(tree, (element) => element.type === VoiceMessage)[0];
    voice.props.onConfirmed('voice-7', '核对后的语音文字');
    const update = hooks.useState.mock.results[9].value[1].mock.calls[0][0];
    expect(update({ 'voice-6': '之前核对的文字' })).toEqual({ 'voice-6': '之前核对的文字', 'voice-7': '核对后的语音文字' });
  });
  it('does not prepare a model request from an inactive page', async () => {
    const preview = vi.fn(); vi.stubGlobal('window', { salesCopilot: { previewConversationReply: preview } });
    const editor = composers(ConversationWorkspace({ ...workspaceProps(), active: false }))[0];
    expect(editor.props.disabled).toBe(true); editor.props.onGenerate(); await Promise.resolve();
    expect(preview).not.toHaveBeenCalled();
  });
  it.each([
    { messages: [{ ...message, text: '[图片]', messageType: 'image' as const }], explanation: '请先核对消息或冲突信息' },
    { messages: [message, { ...message, id: 'outgoing-question', direction: 'outgoing' as const, text: '您方便哪天过来？', sentAt: '2026-08-31T00:01:00Z' }], explanation: '当前应等待客户进一步回复' },
  ])('allows deliberate generation while waiting or needing human review', async ({ messages, explanation }) => {
    const preview = vi.fn().mockResolvedValue({ ok: false, error: '合成测试' }); vi.stubGlobal('window', { salesCopilot: { previewConversationReply: preview } });
    const tree = ConversationWorkspace({ ...workspaceProps(), messages });
    const editor = composers(tree)[0]; expect(editor.props.disabled).toBe(false); expect(preview).not.toHaveBeenCalled();
    editor.props.onGenerate(); await Promise.resolve(); expect(preview).toHaveBeenCalledOnce();
    expect(renderToStaticMarkup(tree)).not.toContain(explanation);
  });
  it('opens export for the current conversation without invoking a model', () => {
    const onExport = vi.fn(); const tree = ConversationWorkspace({ ...workspaceProps(), onExport });
    const button = elements<ComponentProps<'button'>>(tree, (element) => element.props.children === '导出此会话')[0];
    button.props.onClick?.({} as Parameters<NonNullable<ComponentProps<'button'>['onClick']>>[0]); expect(onExport).toHaveBeenCalledOnce();
  });
  it('keeps the full visible chat count distinct from bounded model input in reference', () => {
    state({ 0: '引用' });
    const html = renderToStaticMarkup(ConversationWorkspace({ ...workspaceProps(), messages: Array.from({ length: 140 }, (_, index) => ({ ...message, id: 'bounded-' + index })) }));
    expect(html).toContain('显示 140 条'); expect(html).toContain('最近 100 条参与起草'); expect(html).toContain('生成时检索'); expect(html).toContain('使用常用话术');
  });
  it('requires an explicit click to prepare chat, linked CRM and knowledge together', async () => {
    state({ 4: { customerId: 12, customerName: '合成客户', confirmedAt: '2026-09-12' } });
    const preview = vi.fn().mockResolvedValue({ ok: false, error: '合成验证，不请求服务' }); vi.stubGlobal('window', { salesCopilot: { previewConversationReply: preview } });
    const tree = ConversationWorkspace(workspaceProps()); expect(preview).not.toHaveBeenCalled();
    composers(tree)[0].props.onGenerate(); await Promise.resolve();
    expect(preview).toHaveBeenCalledWith({ scope: workspaceProps().scope, includeCrm: true, includeKnowledge: true });
  });
  it('keeps technical details and local rules off the reply tab and in reference', () => {
    const html = renderToStaticMarkup(ConversationWorkspace(workspaceProps()));
    for (const text of ['资料选项', '使用常用话术', '回复参考', '建议方向', '尚未调用 AI', 'advice-footer']) expect(html).not.toContain(text);
    state({ 0: '引用' });
    const reference = ConversationWorkspace(workspaceProps());
    const settings = elements<ComponentProps<'details'>>(reference, (element) => element.props.className === 'reply-context-config')[0];
    expect(settings.props.open).not.toBe(true); expect(renderToStaticMarkup(reference)).toContain('使用常用话术');
  });
  it('only activates local scripts after their explicit action', () => {
    state({ 0: '引用' }); const tree = ConversationWorkspace(workspaceProps());
    expect(composers(tree)[0].props.drafts).toEqual([]);
    const button = elements<ComponentProps<'button'>>(tree, (element) => element.props.children === '使用常用话术')[0];
    button.props.onClick?.({} as Parameters<NonNullable<ComponentProps<'button'>['onClick']>>[0]);
    expect(hooks.useState.mock.results[16].value[1]).toHaveBeenCalledWith(true);
    expect(hooks.useState.mock.results[0].value[1]).toHaveBeenCalledWith('建议');
    state({ 16: true }); expect(composers(ConversationWorkspace(workspaceProps()))[0].props.drafts.length).toBeGreaterThan(0);
  });
  it.each(['cached', 'empty'] as const)('still blocks preparation for %s messages', (messageSource) => {
    expect(composers(ConversationWorkspace({ ...workspaceProps(), messageSource }))[0].props.disabled).toBe(true);
  });
  it('preserves editable text when knowledge options change', () => {
    const original = composers(ConversationWorkspace(workspaceProps())).map((item) => item.key); state({ 14: false });
    expect(composers(ConversationWorkspace(workspaceProps())).map((item) => item.key)).toEqual(original);
  });
  it('shows one generated editor and both actions without displaying sources on the reply tab', () => {
    ConversationWorkspace(workspaceProps());
    const signature = hooks.useRef.mock.results.map((result) => result.value.current).find((value) => typeof value === 'string' && value.startsWith('account-test:contact-test:'));
    state({ 10: { signature, value: { provider: 'openai', model: 'synthetic', drafts: [{ text: '合成建议', reason: '测试依据', sourceIds: ['chat:1'] }], sources: [{ id: 'chat:1', title: '合成消息' }], warnings: [] } } });
    const html = renderToStaticMarkup(ConversationWorkspace(workspaceProps()));
    expect(html).toContain('合成建议'); expect((html.match(/<textarea/g) || [])).toHaveLength(1);
    expect(html.indexOf('编辑回复')).toBeLessThan(html.indexOf('重新生成')); expect(html).toContain('复制回复');
    expect(html).not.toContain('资料选项'); expect(html).not.toContain('测试依据');
  });
});

describe('private, windowed conversation queue', () => {
  it('defaults to contacts and offers group/all without showing official/system rows', () => {
    const html = renderToStaticMarkup(WechatConversationQueue({ ...queueProps(), snapshot: { ...snapshot, conversations: [...snapshot.conversations,
      { contactKey: 'group-test', displayName: '测试群', kind: 'group' },
      { contactKey: 'official-test', displayName: '测试公众号', kind: 'official' },
      { contactKey: 'system-test', displayName: '微信团队', kind: 'other' },
    ] } }));
    expect(html).toContain('测试客户'); expect(html).not.toContain('测试公众号'); expect(html).not.toContain('微信团队'); expect(html).not.toContain('测试群');
    expect(html).toContain('群聊'); expect(html).toContain('全部');
    expect(html).toContain('置顶此会话'); expect(html).toContain('不显示此会话');
  });
  it('renders only a small window for 1032 conversations without dropping the full count', () => {
    const rows = Array.from({ length: 1032 }, (_, index) => ({ contactKey: `contact-${index}`, displayName: `合成客户${index}`, kind: 'contact' as const }));
    const tree = WechatConversationQueue({ ...queueProps(), snapshot: { ...snapshot, conversations: rows } });
    const rendered = elements<ComponentProps<'button'>>(tree, (element) => element.type === 'button' && typeof (element.props as Record<string, unknown>)['data-contact-key'] === 'string');
    expect(rendered.length).toBeLessThanOrEqual(20); expect(rendered.length).toBeGreaterThan(0);
    expect(renderToStaticMarkup(tree)).toContain('1032');
  });
  it('hides selected preferences and provides a recovery-only hidden view', () => {
    const props = { ...queueProps(), preferences: { hidden: ['contact-test'], pinned: [] } };
    expect(renderToStaticMarkup(WechatConversationQueue(props))).not.toContain('测试客户');
    state({ 4: true });
    const tree = WechatConversationQueue(props);
    const rows = elements<ComponentProps<'button'>>(tree, (element) => element.props.className?.includes('wechat-queue-row') === true);
    rows[0].props.onClick?.({} as Parameters<NonNullable<ComponentProps<'button'>['onClick']>>[0]);
    expect(props.onPreference).toHaveBeenCalledWith('hidden', snapshot.conversations[0]);
    expect(props.onSelect).not.toHaveBeenCalled();
    expect(renderToStaticMarkup(tree)).toContain('恢复显示此会话');
  });
  it('does not steal Ctrl+K from other pages', () => {
    const add = vi.fn(); vi.stubGlobal('window', { addEventListener: add });
    WechatConversationQueue({ ...queueProps(), active: false });
    hooks.useEffect.mock.calls[0][0](); expect(add).not.toHaveBeenCalled();
  });
});
