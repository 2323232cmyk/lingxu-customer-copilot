import { Children, isValidElement, type ComponentProps, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AppearanceSettings } from './AppearanceSettings';
import { NavigationRail } from './NavigationRail';

vi.mock('@fluentui/react-components', async () => ({
  ...await import('@fluentui/react-theme'),
  Tooltip: ({ children }: { children?: ReactNode }) => children,
}));

function elements<T extends { children?: ReactNode }>(node: ReactNode, predicate: (element: ReactElement<T>) => boolean): ReactElement<T>[] {
  if (!isValidElement<T>(node)) return [];
  return [...(predicate(node) ? [node] : []), ...Children.toArray(node.props.children).flatMap((child) => elements(child, predicate))];
}
const props = (): ComponentProps<typeof AppearanceSettings> => ({ design: 'A', onDesignChange: vi.fn(), appearance: { skin: 'warm', accent: 'gold' }, onAppearanceChange: vi.fn(), layout: 'labelled', onLayoutChange: vi.fn() });
const change = (input: ReactElement<ComponentProps<'input'>>) => input.props.onChange?.({} as Parameters<NonNullable<ComponentProps<'input'>['onChange']>>[0]);

describe('appearance settings controls', () => {
  it('provides three complete layouts, six skins and six colors as independent choices', () => {
    const controls = props(); const tree = AppearanceSettings(controls);
    const inputs = (name: string) => elements<ComponentProps<'input'>>(tree, (element) => element.type === 'input' && element.props.name === name);
    expect(inputs('workspace-design')).toHaveLength(3);
    expect(inputs('workspace-skin')).toHaveLength(6);
    expect(inputs('workspace-accent')).toHaveLength(6);
    change(inputs('workspace-skin')[4]);
    expect(controls.onAppearanceChange).toHaveBeenCalledWith({ skin: 'ink', accent: 'gold' });
    expect(controls.onDesignChange).not.toHaveBeenCalled();
    change(inputs('workspace-accent')[2]);
    expect(controls.onAppearanceChange).toHaveBeenCalledWith({ skin: 'warm', accent: 'jade' });
    expect(controls.onLayoutChange).not.toHaveBeenCalled();
  });
  it('explains C top navigation and does not offer a misleading sidebar width', () => {
    const tree = AppearanceSettings({ ...props(), design: 'C' });
    const fieldset = elements<ComponentProps<'fieldset'>>(tree, (element) => element.type === 'fieldset' && element.props.disabled === true)[0];
    expect(fieldset).toBeDefined();
    const html = renderToStaticMarkup(tree);
    expect(html).toContain('C · 客户案卷台'); expect(html).toContain('顶部导航');
    expect(html).toContain('原版标志保持不变');
  });
  it('renders one horizontal main navigation with labels and no collapse control', () => {
    const onChange = vi.fn();
    const tree = NavigationRail({ active: 'conversation', layout: 'compact', orientation: 'horizontal', onChange, onLayoutChange: vi.fn() });
    const buttons = elements<ComponentProps<'button'>>(tree, (element) => element.type === 'button');
    expect(buttons).toHaveLength(6);
    buttons.find((button) => button.props['aria-label'] === 'settings' || button.props['aria-label'] === '设置')?.props.onClick?.({} as Parameters<NonNullable<ComponentProps<'button'>['onClick']>>[0]);
    expect(onChange).toHaveBeenCalledWith('settings');
    const html = renderToStaticMarkup(tree);
    expect(html).toContain('navigation-top'); expect(html).not.toContain('nav-collapse');
    expect(html).toContain('aria-current="page"'); expect(html).toContain('<span>知识库</span>');
  });
});
