import { createDarkTheme, createLightTheme, type BrandVariants } from '@fluentui/react-components';
import type { WorkspaceDesign } from './layout-preferences';

export const APPEARANCE_KEY = 'lingxu.appearance.v1'; // gitleaks:allow -- Public localStorage setting name, not a credential.

export const skins = [
  { id: 'warm', label: '领序极简', mode: 'light', canvas: '#FBFBFD', surface: '#FFFFFF', muted: '#F5F5F7', text: '#1D1D1F', secondary: '#505059', quiet: '#6E6E73', line: '#E5E5EA', border: '#D2D2D9', hover: '#F0F0F4' },
  { id: 'snow', label: '极简银白', mode: 'light', canvas: '#F3F5F7', surface: '#FFFFFF', muted: '#F8FAFC', text: '#202833', secondary: '#526071', quiet: '#626E7B', line: '#DEE3EA', border: '#BCC5D1', hover: '#EBEFF4' },
  { id: 'mist', label: '雾蓝晨光', mode: 'light', canvas: '#EDF2F8', surface: '#FCFEFF', muted: '#F3F7FC', text: '#233549', secondary: '#52657A', quiet: '#5C6A80', line: '#D9E2ED', border: '#ADBECE', hover: '#E5EDF6' },
  { id: 'sage', label: '青岚浅绿', mode: 'light', canvas: '#F0F4EE', surface: '#FCFEFC', muted: '#F5F8F2', text: '#2C392E', secondary: '#536456', quiet: '#5D6D5F', line: '#DCE5D8', border: '#B8C7B5', hover: '#E9F0E5' },
  { id: 'ink', label: '深海夜蓝', mode: 'dark', canvas: '#101B2B', surface: '#172434', muted: '#1C2C3F', text: '#EBF1F8', secondary: '#B9C9DD', quiet: '#A1B4CE', line: '#30445F', border: '#617C9F', hover: '#25384F' },
  { id: 'graphite', label: '曜石深灰', mode: 'dark', canvas: '#171816', surface: '#1B1C1A', muted: '#222320', text: '#F2F0EB', secondary: '#C1BDB2', quiet: '#AAA69C', line: '#353630', border: '#66655A', hover: '#282924' },
] as const;

export const accents = [
  { id: 'gold', label: '领序黑金', light: '#1D1D1F', lightText: '#1D1D1F', onLight: '#FFFFFF', dark: '#F2F2F5', darkText: '#F2F2F5', onDark: '#1D1D1F' },
  { id: 'blue', label: '远山蓝', light: '#255CB7', lightText: '#2457A8', onLight: '#FFFFFF', dark: '#8AB4FF', darkText: '#A7C7FF', onDark: '#112B4D' },
  { id: 'jade', label: '松石绿', light: '#18725C', lightText: '#14634F', onLight: '#FFFFFF', dark: '#70C9AC', darkText: '#98DDC7', onDark: '#103F31' },
  { id: 'violet', label: '鸢尾紫', light: '#7151B7', lightText: '#6741A8', onLight: '#FFFFFF', dark: '#BCA5EE', darkText: '#CEBDF6', onDark: '#24143E' },
  { id: 'rose', label: '蔷薇红', light: '#B13F65', lightText: '#983355', onLight: '#FFFFFF', dark: '#E9A0B6', darkText: '#F1BACC', onDark: '#401729' },
  { id: 'cyan', label: '湖水青', light: '#126F83', lightText: '#125F70', onLight: '#FFFFFF', dark: '#7ACAD7', darkText: '#9EDFE9', onDark: '#103840' },
] as const;

export type SkinId = typeof skins[number]['id'];
export type AccentId = typeof accents[number]['id'];
export interface Appearance { skin: SkinId; accent: AccentId }

export function readAppearance(storage: Pick<Storage, 'getItem'>, legacyDesign: WorkspaceDesign): Appearance {
  const fallback: Appearance = { skin: legacyDesign === 'B' ? 'graphite' : 'warm', accent: 'gold' };
  try {
    const value: unknown = JSON.parse(storage.getItem(APPEARANCE_KEY) || 'null');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback;
    const candidate = value as Record<string, unknown>;
    return { skin: skins.find((skin) => skin.id === candidate.skin)?.id ?? fallback.skin,
      accent: accents.find((accent) => accent.id === candidate.accent)?.id ?? fallback.accent };
  } catch { return fallback; }
}

export function saveAppearance(storage: Pick<Storage, 'setItem'>, appearance: Appearance): boolean {
  try { storage.setItem(APPEARANCE_KEY, JSON.stringify(appearance)); return true; }
  catch { return false; }
}

function mix(from: string, to: string, amount: number): string {
  const channel = (hex: string, index: number) => parseInt(hex.slice(index, index + 2), 16);
  return '#' + [1, 3, 5].map((index) => Math.round(channel(from, index) * (1 - amount) + channel(to, index) * amount).toString(16).padStart(2, '0')).join('');
}

function brandRamp(color: string): BrandVariants {
  const darkSteps = [.92, .8, .68, .56, .44, .3, .15, 0];
  const lightSteps = [.14, .28, .42, .56, .7, .8, .9, .97];
  return Object.fromEntries([...darkSteps.map((amount) => mix(color, '#000000', amount)),
    ...lightSteps.map((amount) => mix(color, '#FFFFFF', amount))].map((value, index) => [(index + 1) * 10, value])) as unknown as BrandVariants;
}

/** FluentProvider emits these extra theme tokens as CSS variables, including in its portals. */
export function appearanceTheme(appearance: Appearance) {
  const skin = skins.find((item) => item.id === appearance.skin) ?? skins[0];
  const accent = accents.find((item) => item.id === appearance.accent) ?? accents[0];
  const dark = skin.mode === 'dark';
  const primary = dark ? accent.dark : accent.light;
  const foreground = dark ? accent.darkText : accent.lightText;
  const onPrimary = dark ? accent.onDark : accent.onLight;
  const soft = mix(skin.surface, primary, dark ? .14 : .1);
  const softer = mix(skin.surface, primary, dark ? .07 : .045);
  const hover = mix(primary, dark ? '#FFFFFF' : '#000000', .09);
  const pressed = mix(primary, dark ? '#FFFFFF' : '#000000', .17);
  const danger = dark ? '#F0A196' : '#AD3139';
  const warning = dark ? '#E8C675' : '#886318';
  const success = dark ? '#8CCD9E' : '#266C47';
  const base = dark ? createDarkTheme(brandRamp(accent.light)) : createLightTheme(brandRamp(accent.light));
  return {
    ...base,
    fontFamilyBase: '"MiSans", "HarmonyOS Sans SC", "PingFang SC", "Microsoft YaHei", "Segoe UI", system-ui, sans-serif',
    borderRadiusMedium: '12px',
    colorBrandBackground: primary, colorBrandBackgroundHover: hover, colorBrandBackgroundPressed: pressed,
    colorBrandBackgroundSelected: pressed, colorBrandBackground2: soft,
    colorBrandBackground2Hover: soft, colorBrandBackground2Pressed: soft,
    colorNeutralForegroundOnBrand: onPrimary, colorBrandForeground1: foreground, colorBrandForeground2: foreground,
    colorBrandForeground2Hover: foreground, colorBrandForeground2Pressed: foreground,
    colorBrandForegroundLink: foreground, colorBrandForegroundLinkHover: foreground, colorBrandForegroundLinkPressed: foreground,
    colorBrandStroke1: foreground, colorBrandStroke2: foreground,
    colorNeutralForeground1: skin.text, colorNeutralForeground2: skin.secondary, colorNeutralForeground3: skin.quiet,
    colorNeutralForeground2BrandHover: foreground, colorNeutralForeground2BrandPressed: foreground, colorNeutralForeground2BrandSelected: foreground,
    colorNeutralForegroundDisabled: skin.quiet,
    colorNeutralBackground1: skin.surface, colorNeutralBackground1Hover: skin.hover,
    colorNeutralBackground1Pressed: skin.hover, colorNeutralBackground1Selected: soft,
    colorNeutralBackground2: skin.muted, colorNeutralBackground2Hover: skin.hover,
    colorNeutralBackground2Pressed: skin.hover, colorNeutralBackground2Selected: soft,
    colorNeutralBackground3: skin.canvas, colorNeutralBackground4: skin.canvas, colorNeutralBackground5: skin.muted, colorNeutralBackground6: skin.canvas,
    colorNeutralBackgroundDisabled: skin.muted, colorNeutralBackgroundInverted: dark ? '#F6F5F0' : '#242424',
    colorNeutralStroke1: skin.border, colorNeutralStroke1Hover: skin.quiet, colorNeutralStroke2: skin.line,
    colorNeutralStrokeAccessible: skin.quiet, colorNeutralStrokeAccessibleHover: foreground, colorNeutralStrokeAccessiblePressed: foreground,
    colorNeutralStrokeAccessibleSelected: foreground, colorStrokeFocus2: foreground,
    'appearance-scheme': skin.mode,
    accent: foreground, 'accent-strong': foreground, 'accent-text': foreground,
    'accent-fill': primary, 'accent-on-fill': onPrimary, 'accent-soft': soft, 'accent-softer': softer,
    canvas: skin.canvas, surface: skin.surface, 'surface-muted': skin.muted,
    text: skin.text, 'text-2': skin.secondary, 'text-3': skin.quiet,
    line: skin.line, 'line-strong': skin.border, hover: skin.hover,
    danger, warning, success,
    outgoing: soft, 'outgoing-line': mix(skin.surface, foreground, .35),
    'error-surface': mix(skin.surface, danger, .1), 'error-line': mix(skin.surface, danger, .4),
    'warning-surface': mix(skin.surface, warning, .09), 'warning-line': mix(skin.surface, warning, .4),
    'chrome-accent': accent.id === 'gold' ? '#D5B353' : accent.darkText,
    'chart-primary': foreground, 'chart-secondary': dark ? '#93B9E5' : '#386C9E',
    'chart-tertiary': dark ? '#A7D4BB' : '#317866', 'chart-grid': skin.line,
    'chart-text': skin.quiet, 'chart-warning': warning, 'chart-success': success,
  };
}
