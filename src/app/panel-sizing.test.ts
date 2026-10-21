import { describe, expect, it, vi } from 'vitest';
import { clampPanelSize, fitWorkspacePanels, panelSizeFromKey, readPanelSizes, savePanelSizes, workspacePanelDefaults, WORKSPACE_PANELS_KEY } from './panel-sizing';

describe('panel size preferences', () => {
  const defaults = { queue: 280, side: 380, top: 400 };
  it('retains valid fields and repairs only invalid saved dimensions', () => {
    const storage = { getItem: () => JSON.stringify({ queue: 325, side: -5, top: '400', unknown: 999 }) };
    expect(readPanelSizes(storage, 'test', defaults)).toEqual({ queue: 325, side: 380, top: 400 });
    expect(readPanelSizes({ getItem: () => '{"queue":1e999,"side":20001,"top":null}' }, 'test', defaults)).toEqual(defaults);
  });
  it.each(['broken', 'null', '[]', '42'])('falls back for corrupt storage %s', (input) => {
    expect(readPanelSizes({ getItem: () => input }, 'test', defaults)).toEqual(defaults);
  });
  it('keeps each layout independent and tolerates unavailable storage', () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) || null, setItem: (key: string, value: string) => { values.set(key, value); } };
    savePanelSizes(storage, `${WORKSPACE_PANELS_KEY}.A`, { ...defaults, queue: 310 });
    savePanelSizes(storage, `${WORKSPACE_PANELS_KEY}.B`, { ...defaults, queue: 240 });
    expect(readPanelSizes(storage, `${WORKSPACE_PANELS_KEY}.A`, defaults).queue).toBe(310);
    expect(readPanelSizes(storage, `${WORKSPACE_PANELS_KEY}.B`, defaults).queue).toBe(240);
    expect(readPanelSizes({ getItem: () => { throw new Error('Unavailable'); } }, 'test', defaults)).toEqual(defaults);
    expect(savePanelSizes({ setItem: () => { throw new Error('Unavailable'); } }, 'test', defaults)).toBe(false);
  });
  it('saves only on explicit commit calls', () => {
    const setItem = vi.fn();
    fitWorkspacePanels(defaults, 1040, 668);
    expect(setItem).not.toHaveBeenCalled();
    expect(savePanelSizes({ setItem }, 'test', defaults)).toBe(true);
    expect(setItem).toHaveBeenCalledOnce();
  });
});

describe('panel size constraints', () => {
  it('keeps chat space when persisted panels exceed a smaller window', () => {
    const fitted = fitWorkspacePanels({ queue: 650, side: 850, top: 900 }, 1040, 668);
    expect(fitted.queue + fitted.side).toBeLessThanOrEqual(760);
    expect(fitted.queue).toBeGreaterThanOrEqual(210);
    expect(fitted.side).toBeGreaterThanOrEqual(260);
    expect(fitted.top).toBeLessThanOrEqual(368);
  });
  it.each([[640, 300], [500, 200], [1040, 668], [1540, 960]])('fits all panels without overflow at %ix%i', (width, height) => {
    const fitted = fitWorkspacePanels({ queue: 650, side: 850, top: 900 }, width, height);
    expect(fitted.queue + fitted.side).toBeLessThan(width);
    expect(fitted.top).toBeLessThan(height);
    expect(fitted.top).toBeGreaterThan(0);
  });
  it('provides layout-specific defaults with height relative to current window', () => {
    expect(workspacePanelDefaults('A', 800)).toEqual({ queue: 280, side: 380, top: 432 });
    expect(workspacePanelDefaults('B', 600)).toEqual({ queue: 280, side: 320, top: 324 });
    expect(workspacePanelDefaults('C', 800)).toEqual(workspacePanelDefaults('A', 800));
  });
  it('supports fine, coarse and edge keyboard adjustment with right panel direction', () => {
    expect(panelSizeFromKey('ArrowRight', 280, 210, 500)).toBe(290);
    expect(panelSizeFromKey('ArrowRight', 280, 210, 500, 1, true)).toBe(320);
    expect(panelSizeFromKey('ArrowLeft', 380, 260, 600, -1)).toBe(390);
    expect(panelSizeFromKey('Home', 280, 210, 500)).toBe(210);
    expect(panelSizeFromKey('End', 280, 210, 500)).toBe(500);
    expect(panelSizeFromKey('ArrowRight', 495, 210, 500)).toBe(500);
    expect(panelSizeFromKey('Enter', 280, 210, 500)).toBeUndefined();
    expect(clampPanelSize(NaN, 210, 500)).toBe(210);
  });
});
