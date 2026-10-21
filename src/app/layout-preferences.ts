export type NavigationLayout = 'labelled' | 'compact';
export type WorkspaceDesign = 'A' | 'B' | 'C';

export const NAVIGATION_LAYOUT_KEY = 'lingxu.navigation-layout.v1';
export const WORKSPACE_DESIGN_KEY = 'lingxu.workspace-design.v1';

export function readWorkspaceDesign(storage: Pick<Storage, 'getItem'>): WorkspaceDesign {
  try { const value = storage.getItem(WORKSPACE_DESIGN_KEY); return value === 'B' || value === 'C' ? value : 'A'; }
  catch { return 'A'; }
}

export function saveWorkspaceDesign(storage: Pick<Storage, 'setItem'>, design: WorkspaceDesign): boolean {
  try { storage.setItem(WORKSPACE_DESIGN_KEY, design); return true; }
  catch { return false; }
}

export function readNavigationLayout(storage: Pick<Storage, 'getItem'>): NavigationLayout {
  try { return storage.getItem(NAVIGATION_LAYOUT_KEY) === 'compact' ? 'compact' : 'labelled'; }
  catch { return 'labelled'; }
}

export function saveNavigationLayout(storage: Pick<Storage, 'setItem'>, layout: NavigationLayout): boolean {
  try { storage.setItem(NAVIGATION_LAYOUT_KEY, layout); return true; }
  catch { return false; }
}
