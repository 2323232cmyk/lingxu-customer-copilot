import { customerGrade } from './workbench-model';

export const workMetrics = [
  { key: 'phone', label: '电话', unit: '通' },
  { key: 'acquired', label: '获客', unit: '位' },
  { key: 'interview', label: '面谈', unit: '位' },
  { key: 'visited', label: '到访', unit: '位' },
  { key: 'deal', label: '成交', unit: '位' },
] as const;
export type WorkMetric = typeof workMetrics[number]['key'];
export type WorkTrendInput = { date: string; label?: string } & Partial<Record<WorkMetric, unknown>>;
export type WorkTrendPoint = { date: string; label: string } & Record<WorkMetric, number | null>;

export function chartCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Missing reports remain gaps; only the CRM can provide a real numeric zero. */
export function buildWorkTrend(rows: readonly WorkTrendInput[], fetchedAt: string): WorkTrendPoint[] {
  const fetched = Date.parse(fetchedAt);
  if (!Number.isFinite(fetched)) return [];
  const endDay = new Date(fetched + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const end = Date.parse(`${endDay}T00:00:00Z`);
  const byDate = new Map<string, WorkTrendInput | null>();
  for (const row of rows) byDate.set(row.date, byDate.has(row.date) ? null : row);
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(end - (6 - index) * 86400000).toISOString().slice(0, 10);
    const row = byDate.get(date);
    return { date, label: `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`,
      phone: chartCount(row?.phone), acquired: chartCount(row?.acquired), interview: chartCount(row?.interview),
      visited: chartCount(row?.visited), deal: chartCount(row?.deal) };
  });
}

export function trendSummary(days: readonly WorkTrendPoint[], metric: WorkMetric) {
  const values = days.map((day) => day[metric]).filter((value): value is number => value !== null);
  const knownDays = values.length;
  const total = knownDays ? values.reduce((sum, value) => sum + value, 0) : null;
  return { total, knownDays, missingDays: days.length - knownDays, maximum: Math.max(0, ...values),
    state: !knownDays ? 'missing' : knownDays < days.length ? 'partial' : total === 0 ? 'zero' : 'complete' } as const;
}

/** The grade is a current classification, not a chronological conversion stage. */
export function gradeDistribution(rows: ReadonlyArray<{ level: string; count: unknown }>) {
  const counts = new Map<string, number | null>();
  for (const row of rows) {
    const grade = customerGrade(row.level); const count = chartCount(row.count);
    const previous = counts.get(grade);
    counts.set(grade, count === null || previous === null ? null : (previous || 0) + count);
  }
  const order = ['A类', 'B类', 'C类', 'D类', 'E类', '未分级'];
  return [...counts].map(([grade, count]) => ({ grade, count })).sort((a, b) => {
    const left = order.indexOf(a.grade); const right = order.indexOf(b.grade);
    return (left < 0 ? order.length : left) - (right < 0 ? order.length : right);
  });
}
