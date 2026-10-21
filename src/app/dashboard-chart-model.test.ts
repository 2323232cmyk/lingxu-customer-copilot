import { describe, expect, it } from 'vitest';
import { buildWorkTrend, chartCount, gradeDistribution, trendSummary, workMetrics } from './dashboard-chart-model';

const fetchedAt = '2026-08-31T10:00:00+08:00';
const day = (date: string, phone: unknown = 2) => ({ date, label: '不用于排序的标签', phone, acquired: 1, interview: 0, visited: 0, deal: 0 });

describe('dashboard chart data fidelity', () => {
  it('uses seven Beijing calendar days ending at the actual fetch date', () => {
    const result = buildWorkTrend([day('2026-08-30'), day('2026-08-31')], fetchedAt);
    expect(result.map((item) => item.date)).toEqual(['2026-08-25', '2026-08-26', '2026-08-27', '2026-08-28', '2026-08-29', '2026-08-30', '2026-08-31']);
    expect(result[0].phone).toBeNull(); expect(result[6].label).toBe('8/31');
    expect(buildWorkTrend([], '2026-08-31T17:00:00Z').at(-1)?.date).toBe('2026-09-01');
  });
  it('does not mutate, infer from chat, or sum duplicate date rows', () => {
    const input = [day('2026-08-31', 3), day('2026-08-29', 6), day('2026-08-31', 4)];
    const original = structuredClone(input); const result = buildWorkTrend(input, fetchedAt);
    expect(input).toEqual(original); expect(result[4].phone).toBe(6); expect(result[6].phone).toBeNull();
    expect(trendSummary(result, 'phone')).toMatchObject({ total: 6, knownDays: 1, missingDays: 6, state: 'partial' });
  });
  it('preserves real zero and treats null, absent, malformed, fractional and negative values as missing', () => {
    expect(chartCount(0)).toBe(0); expect(chartCount(123)).toBe(123);
    for (const value of [null, undefined, '', '5', -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) expect(chartCount(value)).toBeNull();
    const result = buildWorkTrend([day('2026-08-31', null)], fetchedAt);
    expect(result[6].phone).toBeNull(); expect(result[6].acquired).toBe(1);
  });
  it('distinguishes no returned values, explicit all-zero values, and a complete nonzero week', () => {
    const empty = buildWorkTrend([], fetchedAt);
    expect(trendSummary(empty, 'phone')).toMatchObject({ total: null, state: 'missing', knownDays: 0 });
    const zeros = empty.map((item) => ({ ...item, phone: 0 }));
    expect(trendSummary(zeros, 'phone')).toMatchObject({ total: 0, state: 'zero', knownDays: 7 });
    const complete = zeros.map((item, index) => ({ ...item, phone: index }));
    expect(trendSummary(complete, 'phone')).toMatchObject({ total: 21, state: 'complete', maximum: 6 });
  });
  it('does not turn missing dates into zero or connect to dates outside the selected week', () => {
    const result = buildWorkTrend([day('2026-08-24', 500), day('2026-09-01', 500), day('2026-08-31', 3), day('2026-02-31', 500)], fetchedAt);
    expect(trendSummary(result, 'phone')).toMatchObject({ total: 3, knownDays: 1 });
    expect(result.slice(0, 6).every((item) => item.phone === null)).toBe(true);
    expect(buildWorkTrend([day('2026-08-31')], 'bad-date')).toEqual([]);
  });
  it('keeps five report metrics independent and uses report units', () => {
    expect(workMetrics.map((metric) => metric.key)).toEqual(['phone', 'acquired', 'interview', 'visited', 'deal']);
    const result = buildWorkTrend([{ ...day('2026-08-31'), phone: 20, acquired: 4, interview: 3, visited: 2, deal: 1 }], fetchedAt);
    expect(workMetrics.map((metric) => trendSummary(result, metric.key).total)).toEqual([20, 4, 3, 2, 1]);
  });
  it('groups customer grade aliases without manufacturing a sales funnel or an ungraded count', () => {
    const rows = [{ level: 'B类·意向待明确', count: 2 }, { level: 'A', count: 3 }, { level: 'A类·高意向', count: 4 }, { level: '', count: 1 }];
    const before = structuredClone(rows);
    expect(gradeDistribution(rows)).toEqual([{ grade: 'A类', count: 7 }, { grade: 'B类', count: 2 }, { grade: '未分级', count: 1 }]);
    expect(rows).toEqual(before); expect(gradeDistribution([])).toEqual([]);
  });
  it('never fabricates a zero grade count when the source is incomplete', () => {
    expect(gradeDistribution([{ level: 'A', count: 2 }, { level: 'A类', count: null }, { level: 'B', count: 0 }]))
      .toEqual([{ grade: 'A类', count: null }, { grade: 'B类', count: 0 }]);
  });
});
