import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import type { WorkspaceDesign } from './layout-preferences';
import { clampPanelSize, fitWorkspacePanels, panelSizeFromKey, readPanelSizes, savePanelSizes, workspacePanelDefaults, WORKSPACE_PANELS_KEY } from './panel-sizing';

export function useSavedPanelSizes<T extends Record<string, number>>(key: string, defaults: T) {
  const [saved, setSaved] = useState<Record<string, T>>({});
  const sizes = useMemo(() => {
    if (saved[key]) return saved[key];
    try { return readPanelSizes(window.localStorage, key, defaults); } catch { return { ...defaults }; }
  }, [saved, key, defaults]);
  const setSizes = useCallback((next: T) => setSaved((previous) => ({ ...previous, [key]: next })), [key]);
  const commit = useCallback((next: T) => {
    setSizes(next);
    try { savePanelSizes(window.localStorage, key, next); } catch { /* Panel sizing also works without local storage. */ }
  }, [key, setSizes]);
  const reset = useCallback(() => {
    setSaved((previous) => ({ ...previous, [key]: { ...defaults } }));
    try { window.localStorage.removeItem(key); } catch { /* Reset the current view even when storage is unavailable. */ }
  }, [key, defaults]);
  return { sizes, setSizes, commit, reset };
}

type HandleProps = {
  axis: 'x' | 'y'; label: string; value: number; min: number; max: number;
  onChange: (value: number) => void; onCommit: (value: number) => void; onReset: () => void;
  direction?: 1 | -1; style?: CSSProperties; className?: string;
};

export function PanelResizeHandle({ axis, label, value, min, max, onChange, onCommit, onReset, direction = 1, style, className = '' }: HandleProps) {
  const latest = useRef({ onChange, onCommit });
  latest.current = { onChange, onCommit };
  const drag = useRef<{ pointerId: number; start: number; value: number; current: number; target: HTMLDivElement } | null>(null);
  const [dragging, setDragging] = useState(false);
  const finish = useCallback((cancel: boolean) => {
    const active = drag.current;
    if (!active) return;
    drag.current = null;
    document.documentElement.classList.remove('panel-resizing-x', 'panel-resizing-y');
    if (active.target.hasPointerCapture?.(active.pointerId)) active.target.releasePointerCapture(active.pointerId);
    setDragging(false);
    if (cancel) latest.current.onChange(active.value);
    else latest.current.onCommit(active.current);
  }, []);
  useEffect(() => {
    if (!dragging) return;
    const cancel = () => finish(true);
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); cancel(); } };
    window.addEventListener('blur', cancel);
    window.addEventListener('keydown', escape);
    return () => { window.removeEventListener('blur', cancel); window.removeEventListener('keydown', escape); };
  }, [dragging, finish]);
  useEffect(() => () => {
    const active = drag.current;
    if (!active) return;
    drag.current = null;
    document.documentElement.classList.remove('panel-resizing-x', 'panel-resizing-y');
    if (active.target.hasPointerCapture?.(active.pointerId)) active.target.releasePointerCapture(active.pointerId);
    latest.current.onChange(active.value);
  }, []);
  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    const active = drag.current;
    if (!active || event.pointerId !== active.pointerId) return;
    active.current = clampPanelSize(active.value + ((axis === 'x' ? event.clientX : event.clientY) - active.start) * direction, min, max);
    onChange(active.current);
  };
  return <div role="separator" tabIndex={0} aria-label={label} aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
    aria-valuemin={Math.round(min)} aria-valuemax={Math.round(max)} aria-valuenow={Math.round(value)} aria-valuetext={`${Math.round(value)} 像素`}
    className={`panel-resize-handle panel-resize-${axis}${dragging ? ' is-dragging' : ''} ${className}`} style={style}
    title={`${label} · 拖动调整，方向键微调，双击恢复`}
    onPointerDown={(event) => {
      if (event.button !== 0 || drag.current) return;
      event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { pointerId: event.pointerId, start: axis === 'x' ? event.clientX : event.clientY, value, current: value, target: event.currentTarget };
      document.documentElement.classList.add(`panel-resizing-${axis}`); setDragging(true);
    }}
    onPointerMove={move} onPointerUp={(event) => { if (drag.current?.pointerId === event.pointerId) { move(event); finish(false); } }}
    onPointerCancel={(event) => { if (drag.current?.pointerId === event.pointerId) finish(true); }}
    onLostPointerCapture={(event) => { if (drag.current?.pointerId === event.pointerId) finish(true); }} onDoubleClick={onReset}
    onKeyDown={(event) => {
      if (drag.current) return;
      if (axis === 'x' && ['ArrowUp', 'ArrowDown'].includes(event.key)) return;
      if (axis === 'y' && ['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      const next = panelSizeFromKey(event.key, value, min, max, direction, event.shiftKey);
      if (next !== undefined) { event.preventDefault(); onCommit(next); }
    }}><span aria-hidden="true" /></div>;
}

export function WorkspaceResizeHandles({ containerRef, design, hasConversation }: {
  containerRef: RefObject<HTMLDivElement | null>; design: WorkspaceDesign; hasConversation: boolean;
}) {
  const [bounds, setBounds] = useState({ width: 1200, height: 740 });
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observe = () => {
      if (container.clientWidth && container.clientHeight) setBounds({ width: container.clientWidth, height: container.clientHeight });
    };
    observe();
    const observer = new ResizeObserver(observe);
    observer.observe(container);
    return () => observer.disconnect();
  }, [containerRef]);
  const defaults = useMemo(() => workspacePanelDefaults(design, bounds.height), [design, bounds.height]);
  const { sizes, setSizes, commit, reset } = useSavedPanelSizes(`${WORKSPACE_PANELS_KEY}.${design}`, defaults);
  const fitted = fitWorkspacePanels(sizes, bounds.width, bounds.height);
  useEffect(() => {
    const style = containerRef.current?.style;
    style?.setProperty('--panel-queue', `${fitted.queue}px`);
    style?.setProperty('--panel-side', `${fitted.side}px`);
    style?.setProperty('--panel-top', `${fitted.top}px`);
  }, [containerRef, fitted.queue, fitted.side, fitted.top]);
  const change = (name: 'queue' | 'side' | 'top', value: number, save = false) => {
    const next = { queue: fitted.queue, side: fitted.side, top: fitted.top, [name]: value };
    (save ? commit : setSizes)(next);
  };
  return <>
    <PanelResizeHandle key={`${design}-queue`} axis="x" label="调整会话列表宽度" value={fitted.queue} min={fitted.minQueue} max={fitted.maxQueue}
      onChange={(value) => change('queue', value)} onCommit={(value) => change('queue', value, true)} onReset={reset} style={{ left: fitted.queue }} />
    {hasConversation && <PanelResizeHandle key={`${design}-side`} axis="x" direction={-1} label={design === 'B' ? '调整客户资料宽度' : '调整回复区域宽度'} value={fitted.side} min={fitted.minSide} max={fitted.maxSide}
      onChange={(value) => change('side', value)} onCommit={(value) => change('side', value, true)} onReset={reset} style={{ right: fitted.side }} />}
    {hasConversation && design === 'B' && <PanelResizeHandle key="B-height" axis="y" label="调整聊天与回复高度" value={fitted.top} min={fitted.minTop} max={fitted.maxTop}
      onChange={(value) => change('top', value)} onCommit={(value) => change('top', value, true)} onReset={reset} style={{ left: fitted.queue, right: fitted.side, top: fitted.top }} />}
    <button type="button" className="panel-layout-reset" aria-label="恢复默认布局" title="拖动区域分隔线可调整大小；点击恢复默认布局" onClick={reset}>恢复布局</button>
  </>;
}
