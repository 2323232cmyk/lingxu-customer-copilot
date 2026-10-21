import { Children, isValidElement, type ComponentProps, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CustomerGradeChart, WorkTrendChart } from './dashboard-charts';

const hooks = vi.hoisted(() => ({ useState: vi.fn(), useMemo: vi.fn() }));
vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(), ...hooks }));
vi.mock('recharts', async () => {
  const { createElement } = await import('react');
  return Object.fromEntries(['ResponsiveContainer', 'LineChart', 'Line', 'CartesianGrid', 'XAxis', 'YAxis', 'Tooltip'].map((name) => [name,
    (props: { children?: ReactNode }) => createElement('div', { 'data-chart-part': name }, props.children)]));
});

const fetchedAt = '2026-08-31T10:00:00+08:00';
const rows = [{ date: '2026-08-31', label: '8/31', phone: 12, acquired: 3, interview: 2, visited: 1, deal: 0 }];
function elements<T extends { children?: ReactNode }>(node: ReactNode, predicate: (item: ReactElement<T>) => boolean): Array<ReactElement<T>> {
  if (!isValidElement<T>(node)) return [];
  return [...(predicate(node) ? [node] : []), ...Children.toArray(node.props.children).flatMap((child) => elements(child, predicate))];
}
beforeEach(() => { vi.clearAllMocks(); hooks.useState.mockImplementation((initial) => [initial, vi.fn()]); hooks.useMemo.mockImplementation((factory) => factory()); });

describe('dashboard visualizations', () => {
  it('renders source, date range, missing-value explanation and exact accessible values', () => {
    const html = renderToStaticMarkup(WorkTrendChart({ rows, fetchedAt, busy: false, available: true }));
    expect(html).toContain('来源：CRM 工作日报'); expect(html).toContain('8/25'); expect(html).toContain('8/31');
    expect(html).toContain('查看日报原数值'); expect(html).toContain('scope="col"'); expect(html).toContain('12');
    expect(html).toContain('未返回'); expect(html).toContain('未填日报'); expect(html).not.toContain('转化率');
  });
  it('supports five keyboard-focusable metric choices without mixing units', () => {
    const setter = vi.fn(); hooks.useState.mockReturnValue(['phone', setter]);
    const tree = WorkTrendChart({ rows, fetchedAt, busy: false, available: true });
    const buttons = elements<ComponentProps<'button'>>(tree, (item) => item.type === 'button');
    expect(buttons).toHaveLength(5); expect(buttons.filter((item) => item.props['aria-pressed'] === true)).toHaveLength(1);
    buttons[4].props.onClick?.({} as never); expect(setter).toHaveBeenCalledWith('deal');
    hooks.useState.mockReturnValue(['deal', setter]);
    const html = renderToStaticMarkup(WorkTrendChart({ rows, fetchedAt, busy: false, available: true }));
    expect(html).toContain('成交'); expect(html).toContain('单位：位');
  });
  it('keeps gaps unconnected and disables chart animation', async () => {
    const { Line, LineChart, ResponsiveContainer, YAxis } = await import('recharts');
    const tree = WorkTrendChart({ rows, fetchedAt, busy: false, available: true });
    const line = elements<{ children?: ReactNode; connectNulls?: boolean; isAnimationActive?: boolean; dataKey?: string }>(tree, (item) => item.type === Line)[0];
    expect(line.props).toMatchObject({ connectNulls: false, isAnimationActive: false, dataKey: 'phone' });
    const chart = elements<{ children?: ReactNode; accessibilityLayer?: boolean; data?: unknown[] }>(tree, (item) => item.type === LineChart)[0];
    expect(chart.props.accessibilityLayer).toBe(true); expect(chart.props.data).toHaveLength(7);
    expect(elements<{ children?: ReactNode; height?: number }>(tree, (item) => item.type === ResponsiveContainer)[0].props.height).toBeGreaterThan(200);
    expect(elements<{ children?: ReactNode; allowDecimals?: boolean }>(tree, (item) => item.type === YAxis)[0].props.allowDecimals).toBe(false);
  });
  it('shows a real all-zero report without claiming no work happened', () => {
    const zeroRows = Array.from({ length: 7 }, (_, index) => ({ ...rows[0], date: `2026-08-${25 + index}`, phone: 0 }));
    const html = renderToStaticMarkup(WorkTrendChart({ rows: zeroRows, fetchedAt, busy: false, available: true }));
    expect(html).toContain('CRM 返回本项均为 0'); expect(html).toContain('不能据此认定当天没有工作');
    expect(html).not.toContain('未返回本项');
  });
  it('distinguishes loading, an unavailable permission response, and empty accessible reports', () => {
    const loading = renderToStaticMarkup(WorkTrendChart({ rows: [], fetchedAt, busy: true, available: false }));
    expect(loading).toContain('正在读取工作日报'); expect(loading).toContain('role="status"');
    const unavailable = renderToStaticMarkup(WorkTrendChart({ rows: [], fetchedAt, busy: false, available: false }));
    expect(unavailable).toContain('工作日报暂不可用'); expect(unavailable).not.toContain('已返回 0');
    const empty = renderToStaticMarkup(WorkTrendChart({ rows: [], fetchedAt, busy: false, available: true }));
    expect(empty).toContain('CRM 尚未返回本项日报数值'); expect(empty).not.toContain('data-chart-part="LineChart"');
  });
  it('keeps customer counts textual beside proportionate horizontal bars without funnel conversions', () => {
    const html = renderToStaticMarkup(CustomerGradeChart({ rows: [{ level: 'B', count: 4 }, { level: 'A', count: 2 }], busy: false, available: true }));
    expect(html).toContain('客户分级'); expect(html).toContain('>4<'); expect(html).toContain('>2<'); expect(html).toContain('width:50%'); expect(html).toContain('width:100%');
    expect(html).toContain('非销售阶段'); expect(html).not.toContain('成交率');
  });
  it('distinguishes unavailable, empty, zero, and missing grade counts', () => {
    expect(renderToStaticMarkup(CustomerGradeChart({ rows: [], busy: false, available: false }))).toContain('等级分布暂不可用');
    expect(renderToStaticMarkup(CustomerGradeChart({ rows: [], busy: false, available: true }))).toContain('暂无客户等级统计');
    const html = renderToStaticMarkup(CustomerGradeChart({ rows: [{ level: 'A', count: 0 }, { level: 'B', count: null }], busy: false, available: true }));
    expect(html).toContain('>0<'); expect(html).toContain('—'); expect(html).toContain('未返回');
  });
});
