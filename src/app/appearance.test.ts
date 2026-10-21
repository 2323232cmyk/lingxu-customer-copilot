import { describe, expect, it, vi } from 'vitest';
import { accents, APPEARANCE_KEY, appearanceTheme, readAppearance, saveAppearance, skins } from './appearance';
import { readWorkspaceDesign, saveWorkspaceDesign, WORKSPACE_DESIGN_KEY } from './layout-preferences';

vi.mock('@fluentui/react-components', async () => import('@fluentui/react-theme'));

function contrast(first: string, second: string): number {
  const lightness = (hex: string) => [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map((value) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
    .reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
  const pair = [lightness(first), lightness(second)].sort((a, b) => b - a);
  return (pair[0] + .05) / (pair[1] + .05);
}

describe('independent layout and appearance preferences', () => {
  it.each(['A', 'B', 'C'] as const)('accepts and persists complete layout %s', (design) => {
    const storage = { getItem: vi.fn(() => design), setItem: vi.fn() };
    expect(readWorkspaceDesign(storage)).toBe(design);
    expect(saveWorkspaceDesign(storage, design)).toBe(true);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(storage.setItem).toHaveBeenCalledWith(WORKSPACE_DESIGN_KEY, design);
  });
  it('preserves the previous A/B brightness on first upgrade without tying future choices to layout', () => {
    expect(readAppearance({ getItem: () => null }, 'A')).toEqual({ skin: 'warm', accent: 'gold' });
    expect(readAppearance({ getItem: () => null }, 'B')).toEqual({ skin: 'graphite', accent: 'gold' });
    expect(readAppearance({ getItem: () => '{"skin":"mist","accent":"jade"}' }, 'B')).toEqual({ skin: 'mist', accent: 'jade' });
  });
  it.each(['broken', 'null', '[]', '{"skin":"<style>","accent":"http://remote"}'])('safely restores invalid preference %s', (stored) => {
    expect(readAppearance({ getItem: () => stored }, 'C')).toEqual({ skin: 'warm', accent: 'gold' });
  });
  it('keeps valid parts and never writes layout, credentials or unknown keys when changing colors', () => {
    expect(readAppearance({ getItem: () => '{"skin":"ink","accent":"invalid"}' }, 'A')).toEqual({ skin: 'ink', accent: 'gold' });
    const storage = { setItem: vi.fn() };
    expect(saveAppearance(storage, { skin: 'snow', accent: 'blue' })).toBe(true);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(storage.setItem).toHaveBeenCalledWith(APPEARANCE_KEY, '{"skin":"snow","accent":"blue"}');
  });
  it('handles unavailable local storage without losing the session choice', () => {
    expect(readAppearance({ getItem: () => { throw new Error(); } }, 'B')).toEqual({ skin: 'graphite', accent: 'gold' });
    expect(saveAppearance({ setItem: () => { throw new Error(); } }, { skin: 'warm', accent: 'gold' })).toBe(false);
  });
});

describe('all skin and accent combinations', () => {
  for (const skin of skins) for (const accent of accents) {
    it(`${skin.id}/${accent.id} keeps legible text and exposes matching portal/chart variables`, () => {
      const theme = appearanceTheme({ skin: skin.id, accent: accent.id });
      for (const background of [theme.surface, theme['surface-muted'], theme.canvas]) {
        for (const foreground of [theme.text, theme['text-2'], theme['text-3']]) expect(contrast(foreground, background)).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrast(theme['accent-text'], theme['accent-soft'])).toBeGreaterThanOrEqual(4.5);
      expect(contrast(theme.colorNeutralForegroundOnBrand, theme.colorBrandBackground)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(theme['chart-primary'], theme.surface)).toBeGreaterThanOrEqual(3);
      expect(theme.colorNeutralBackground1).toBe(theme.surface);
      expect(theme.colorBrandForeground1).toBe(theme['accent-text']);
      expect(theme['appearance-scheme']).toBe(skin.mode);
      expect(theme['chart-grid']).toBe(theme.line);
    });
  }
});
