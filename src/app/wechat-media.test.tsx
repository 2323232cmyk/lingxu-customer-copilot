import { Children, isValidElement, type ComponentProps, type MouseEvent, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WechatMediaResult } from '../shared/contracts';
import { PrivateImage, WechatMessageBody } from './wechat-media';
import { WechatMediaReadQueue } from './wechat-media-queue';

const hooks = vi.hoisted(() => ({
  useState: vi.fn(),
  useRef: vi.fn((value: unknown) => ({ current: value })),
  useEffect: vi.fn(),
}));
vi.mock('react', async (importOriginal) => ({ ...await importOriginal<typeof import('react')>(), ...hooks }));

const key = 'a'.repeat(64);
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

it('renders card metadata as escaped readable text, never executable HTML', () => {
  const markup = renderToStaticMarkup(<WechatMessageBody message={{ id: 'card', contactKey: 'peer', sender: '客户',
    direction: 'incoming', messageType: 'other', text: '[文件]\n<script>alert(1)</script>.pdf\n大小：100 字节',
    attachmentKind: 'file', sentAt: '2026-09-08', observedAt: '2026-09-08' }} />);
  expect(markup).toContain('大小：100 字节');
  expect(markup).toContain('&lt;script&gt;');
  expect(markup).not.toContain('<script>');
  expect(markup).toContain('文件内容请在微信中打开');
});

// Inject synthetic hook state to inspect the rendered controls without a browser or IPC.
function renderImage(result: WechatMediaResult | null, props: Partial<Parameters<typeof PrivateImage>[0]> = {}) {
  const setResolved = vi.fn();
  const setRetry = vi.fn();
  hooks.useState.mockReturnValueOnce([true, vi.fn()])
    .mockReturnValueOnce([result ? { key, result } : null, setResolved])
    .mockReturnValueOnce([null, vi.fn()])
    .mockReturnValueOnce([0, setRetry]);
  const tree = PrivateImage({ mediaKey: key, alt: '微信聊天图片', fallback: '图片暂不可用', ...props });
  return { tree, markup: renderToStaticMarkup(tree), setResolved, setRetry };
}

function findButton(node: ReactNode): ReactElement<ComponentProps<'button'>> | undefined {
  if (!isValidElement<{ children?: ReactNode }>(node)) return undefined;
  if (node.type === 'button') return node as ReactElement<ComponentProps<'button'>>;
  return Children.toArray(node.props.children).map(findButton).find(Boolean);
}

describe('manual media recovery controls', () => {
  it.each(['encrypted', 'unsupported', 'pending', 'missing'] as const)('offers manual recovery for a %s image with an opaque media key', (mediaStatus) => {
    const { markup } = renderImage({ ok: false, reason: 'missing', mediaStatus });
    expect(markup).toContain('重试加载');
    expect(markup).toContain('微信中打开查看');
    expect(markup).toContain('<button');
  });

  it('also permits recovery from a legacy unsupported result', () => {
    expect(renderImage({ ok: false, reason: 'unsupported' }).markup).toContain('重试加载');
  });

  it('starts one loading cycle even when the same retry control receives rapid repeated clicks', () => {
    const { tree, setResolved, setRetry } = renderImage({ ok: false, reason: 'unsupported', mediaStatus: 'encrypted' });
    const button = findButton(tree);
    expect(button).toBeDefined();
    const event = { stopPropagation: vi.fn() } as unknown as MouseEvent<HTMLButtonElement>;
    button?.props.onClick?.(event);
    button?.props.onClick?.(event);
    expect(setResolved).toHaveBeenCalledOnce();
    expect(setResolved).toHaveBeenCalledWith(null);
    expect(setRetry).toHaveBeenCalledOnce();
    expect(setRetry.mock.calls[0][0](2)).toBe(3);
  });

  it('shows loading without a second retry button while waiting', () => {
    const { markup } = renderImage(null);
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('正在读取');
    expect(markup).not.toContain('<button');
  });

  it('releases the manual retry guard after the bounded read settles unsuccessfully', async () => {
    const failure: WechatMediaResult = { ok: false, reason: 'unsupported' };
    vi.spyOn(WechatMediaReadQueue.prototype, 'enqueue').mockReturnValue({ result: Promise.resolve(failure), cancel: vi.fn() });
    const { tree, setRetry } = renderImage(failure);
    const button = findButton(tree);
    const event = { stopPropagation: vi.fn() } as unknown as MouseEvent<HTMLButtonElement>;
    button?.props.onClick?.(event);
    const cleanup = hooks.useEffect.mock.calls[1][0]();
    await Promise.resolve();
    button?.props.onClick?.(event);
    expect(setRetry).toHaveBeenCalledTimes(2);
    cleanup();
  });

  it('cancels the read when leaving the visible scope and ignores its late result', async () => {
    let resolve!: (result: WechatMediaResult) => void;
    const result = new Promise<WechatMediaResult>((done) => { resolve = done; });
    const cancel = vi.fn();
    vi.spyOn(WechatMediaReadQueue.prototype, 'enqueue').mockReturnValue({ result, cancel });
    const { setResolved } = renderImage(null);
    const cleanup = hooks.useEffect.mock.calls[1][0]();
    setResolved.mockClear();
    cleanup();
    resolve({ ok: true, mime: 'image/png', dataUrl: 'data:image/png;base64,aW1hZ2U=' });
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledOnce();
    expect(setResolved).not.toHaveBeenCalled();
  });

  it('does not create a retry button inside an avatar conversation button', () => {
    const { markup } = renderImage({ ok: false, reason: 'unsupported' }, { className: 'queue-avatar', fallback: '客' });
    expect(markup).not.toContain('<button');
  });

  it('does not offer a nonfunctional retry when no opaque media key exists', () => {
    expect(renderImage(null, { mediaKey: undefined }).markup).not.toContain('<button');
  });

  it('labels a successfully displayed image without claiming original resolution', () => {
    const { markup } = renderImage({ ok: true, mime: 'image/png', dataUrl: 'data:image/png;base64,aW1hZ2U=' });
    expect(markup).toContain('alt="微信聊天图片"');
    expect(markup).not.toContain('原图');
    expect(markup).not.toContain('<button');
  });
});
