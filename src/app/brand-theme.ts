import { createDarkTheme, createLightTheme, type BrandVariants } from '@fluentui/react-components';

const brand: BrandVariants = {
  10: '#1C180E', 20: '#302813', 30: '#443719', 40: '#584720',
  50: '#6E5827', 60: '#836B30', 70: '#967326', 80: '#A88836',
  90: '#BA9A45', 100: '#CCAC53', 110: '#D5B353', 120: '#DFCA87',
  130: '#E9D8A9', 140: '#F0E3C1', 150: '#F6EEDB', 160: '#FBF8F0',
};

export const appTheme = {
  ...createLightTheme(brand),
  fontFamilyBase: '"Segoe UI Variable Text", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif',
  colorBrandBackground: '#D5B353',
  colorBrandBackgroundHover: '#C8A545',
  colorBrandBackgroundPressed: '#BE9B3D',
  colorNeutralForegroundOnBrand: '#231C0D',
  colorBrandForeground1: '#876615',
  colorBrandForeground2: '#876615',
  colorBrandStroke1: '#967326',
  colorNeutralForeground1: '#242424',
  colorNeutralForeground2: '#62605A',
  colorNeutralBackground1: '#FFFFFF',
  colorNeutralBackground2: '#FAF8F2',
  borderRadiusMedium: '6px',
};

export const appDarkTheme = {
  ...createDarkTheme(brand),
  fontFamilyBase: appTheme.fontFamilyBase,
  colorBrandBackground: '#D5B353',
  colorBrandBackgroundHover: '#DFCA87',
  colorBrandBackgroundPressed: '#BE9B3D',
  colorNeutralForegroundOnBrand: '#231C0D',
  colorBrandForeground1: '#E1C574',
  colorBrandForeground2: '#E1C574',
  colorBrandStroke1: '#B89A4C',
  colorNeutralForeground1: '#F2F0EB',
  colorNeutralForeground2: '#C1BDB2',
  colorNeutralForeground3: '#AAA69C',
  colorNeutralBackground1: '#1B1C1A',
  colorNeutralBackground2: '#222320',
  colorNeutralBackground3: '#292A25',
  borderRadiusMedium: '4px',
};
