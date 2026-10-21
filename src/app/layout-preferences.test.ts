import { describe, expect, it } from 'vitest';
import { NAVIGATION_LAYOUT_KEY, readNavigationLayout, saveNavigationLayout } from './layout-preferences';

describe('navigation layout', () => {
  it('defaults to the approved narrowed icon and label rail', () => {
    expect(readNavigationLayout({ getItem: () => null })).toBe('labelled');
    expect(readNavigationLayout({ getItem: () => 'invalid' })).toBe('labelled');
  });
  it('remembers icon-only mode and can return to labels', () => {
    const data = new Map<string, string>();
    const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
    expect(saveNavigationLayout(storage, 'compact')).toBe(true);
    expect(data.get(NAVIGATION_LAYOUT_KEY)).toBe('compact');
    expect(readNavigationLayout(storage)).toBe('compact');
    saveNavigationLayout(storage, 'labelled');
    expect(readNavigationLayout(storage)).toBe('labelled');
  });
  it('keeps the current UI usable when local storage is unavailable', () => {
    expect(readNavigationLayout({ getItem: () => { throw new Error('blocked'); } })).toBe('labelled');
    expect(saveNavigationLayout({ setItem: () => { throw new Error('full'); } }, 'compact')).toBe(false);
  });
});
