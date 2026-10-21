import { type ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PanelResizeHandle } from './WorkspaceResizeHandles';

const hooks = vi.hoisted(() => ({ useState: vi.fn(), useRef: vi.fn(), useEffect: vi.fn(), useCallback: vi.fn() }));
vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(), ...hooks }));
const cleanups: (() => void)[] = [];
beforeEach(() => {
  vi.clearAllMocks(); cleanups.length = 0;
  hooks.useState.mockImplementation((initial) => [initial, vi.fn()]);
  hooks.useRef.mockImplementation((initial) => ({ current: initial }));
  hooks.useCallback.mockImplementation((callback) => callback);
  hooks.useEffect.mockImplementation((effect) => { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); });
  vi.stubGlobal('document', { documentElement: { classList: { add: vi.fn(), remove: vi.fn() } } });
});
afterEach(() => vi.unstubAllGlobals());

function handle(axis: 'x' | 'y' = 'x') {
  const onChange = vi.fn(), onCommit = vi.fn(), onReset = vi.fn();
  const element = PanelResizeHandle({ axis, label: '调整宽度', value: 280, min: 210, max: 500, onChange, onCommit, onReset });
  return { props: element.props as ComponentProps<'div'>, onChange, onCommit, onReset };
}
function pointer(x: number, id = 1, button = 0) {
  return { button, pointerId: id, clientX: x, clientY: x, preventDefault: vi.fn(),
    currentTarget: { focus: vi.fn(), setPointerCapture: vi.fn(), hasPointerCapture: () => true, releasePointerCapture: vi.fn() } } as unknown as Parameters<NonNullable<ComponentProps<'div'>['onPointerDown']>>[0];
}
function keyboard(key: string, shiftKey = false) {
  return { key, shiftKey, preventDefault: vi.fn() } as unknown as Parameters<NonNullable<ComponentProps<'div'>['onKeyDown']>>[0];
}

describe('panel resize interaction', () => {
  it('previews movement, ignores other pointers and saves only on release', () => {
    const { props, onChange, onCommit } = handle();
    const start = pointer(100);
    props.onPointerDown?.(start);
    expect(start.currentTarget.setPointerCapture).toHaveBeenCalledWith(1);
    props.onPointerMove?.(pointer(200, 2)); expect(onChange).not.toHaveBeenCalled();
    props.onPointerMove?.(pointer(140)); expect(onChange).toHaveBeenLastCalledWith(320); expect(onCommit).not.toHaveBeenCalled();
    props.onPointerUp?.(pointer(160)); expect(onCommit).toHaveBeenCalledOnce(); expect(onCommit).toHaveBeenCalledWith(340);
    props.onLostPointerCapture?.(pointer(160)); expect(onCommit).toHaveBeenCalledOnce();
  });
  it('rolls back a cancelled gesture without persisting it', () => {
    const { props, onChange, onCommit } = handle();
    props.onPointerDown?.(pointer(100)); props.onPointerMove?.(pointer(450));
    expect(onChange).toHaveBeenLastCalledWith(500);
    props.onPointerCancel?.(pointer(450));
    expect(onChange).toHaveBeenLastCalledWith(280); expect(onCommit).not.toHaveBeenCalled();
    expect(document.documentElement.classList.remove).toHaveBeenCalledWith('panel-resizing-x', 'panel-resizing-y');
  });
  it('releases capture and restores the preview when unmounted during dragging', () => {
    const { props, onChange, onCommit } = handle();
    const start = pointer(100); props.onPointerDown?.(start); props.onPointerMove?.(pointer(150));
    cleanups.forEach((cleanup) => cleanup());
    expect(start.currentTarget.releasePointerCapture).toHaveBeenCalledWith(1);
    expect(onChange).toHaveBeenLastCalledWith(280); expect(onCommit).not.toHaveBeenCalled();
  });
  it('does not begin dragging for right mouse button', () => {
    const { props, onChange, onCommit } = handle();
    props.onPointerDown?.(pointer(100, 1, 2)); props.onPointerMove?.(pointer(150)); props.onPointerUp?.(pointer(150));
    expect(onChange).not.toHaveBeenCalled(); expect(onCommit).not.toHaveBeenCalled();
  });
  it('exposes separator values and supports axis-correct keyboard changes', () => {
    const { props, onCommit, onReset } = handle('y');
    expect(props.role).toBe('separator'); expect(props['aria-orientation']).toBe('horizontal'); expect(props['aria-valuenow']).toBe(280);
    props.onKeyDown?.(keyboard('ArrowRight')); expect(onCommit).not.toHaveBeenCalled();
    props.onKeyDown?.(keyboard('ArrowDown', true)); expect(onCommit).toHaveBeenLastCalledWith(320);
    props.onKeyDown?.(keyboard('Home')); expect(onCommit).toHaveBeenLastCalledWith(210);
    props.onKeyDown?.(keyboard('End')); expect(onCommit).toHaveBeenLastCalledWith(500);
    props.onDoubleClick?.({} as Parameters<NonNullable<ComponentProps<'div'>['onDoubleClick']>>[0]); expect(onReset).toHaveBeenCalledOnce();
  });
});
