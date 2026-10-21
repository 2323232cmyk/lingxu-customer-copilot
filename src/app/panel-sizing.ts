import type { WorkspaceDesign } from './layout-preferences';

export const WORKSPACE_PANELS_KEY = 'lingxu.workspace-panels.v1';
export type WorkspacePanelSizes = { queue: number; side: number; top: number };

export function readPanelSizes<T extends Record<string, number>>(storage: Pick<Storage, 'getItem'>, key: string, defaults: T): T {
  try {
    const value: unknown = JSON.parse(storage.getItem(key) || 'null');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...defaults };
    const result = { ...defaults };
    for (const name of Object.keys(defaults) as (keyof T)[]) {
      const number = (value as Record<string, unknown>)[name as string];
      if (typeof number === 'number' && Number.isFinite(number) && number > 0 && number <= 10000) result[name] = number as T[keyof T];
    }
    return result;
  } catch { return { ...defaults }; }
}

export function savePanelSizes(storage: Pick<Storage, 'setItem'>, key: string, sizes: Record<string, number>): boolean {
  try { storage.setItem(key, JSON.stringify(sizes)); return true; } catch { return false; }
}

export function clampPanelSize(value: number, min: number, max: number): number {
  return Math.round(Math.min(Math.max(Number.isFinite(value) ? value : min, min), Math.max(min, max)));
}

export function panelSizeFromKey(key: string, value: number, min: number, max: number, direction = 1, largeStep = false): number | undefined {
  if (key === 'Home') return min;
  if (key === 'End') return max;
  const step = (largeStep ? 40 : 10) * direction;
  if (key === 'ArrowLeft' || key === 'ArrowUp') return clampPanelSize(value - step, min, max);
  if (key === 'ArrowRight' || key === 'ArrowDown') return clampPanelSize(value + step, min, max);
  return undefined;
}

export function workspacePanelDefaults(design: WorkspaceDesign, height: number): WorkspacePanelSizes {
  return { queue: 280, side: design === 'B' ? 320 : 380, top: Math.round(height * .54) };
}

export function fitWorkspacePanels(sizes: WorkspacePanelSizes, width: number, height: number) {
  const horizontalScale = Math.min(1, Math.max(0, width) / 750);
  const minQueue = Math.floor(210 * horizontalScale);
  const minSide = Math.floor(260 * horizontalScale);
  const minCenter = Math.floor(280 * horizontalScale);
  const queue = clampPanelSize(sizes.queue, minQueue, width - minSide - minCenter);
  const side = clampPanelSize(sizes.side, minSide, width - queue - minCenter);
  const verticalScale = Math.min(1, Math.max(0, height) / 500);
  const minTop = Math.floor(200 * verticalScale);
  const maxTop = Math.max(minTop, Math.floor(height - 300 * verticalScale));
  return { queue, side, top: clampPanelSize(sizes.top, minTop, maxTop), minQueue, minSide, minTop, maxTop,
    maxQueue: Math.max(minQueue, width - side - minCenter), maxSide: Math.max(minSide, width - queue - minCenter) };
}
