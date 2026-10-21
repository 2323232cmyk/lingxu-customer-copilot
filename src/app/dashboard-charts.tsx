import { useMemo, useState } from 'react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { buildWorkTrend, gradeDistribution, trendSummary, workMetrics, type WorkMetric, type WorkTrendInput } from './dashboard-chart-model';

interface ChartStatus { busy: boolean; available: boolean }
interface WorkTrendChartProps extends ChartStatus { rows: readonly WorkTrendInput[]; fetchedAt: string }

export function WorkTrendChart({ rows, fetchedAt, busy, available }: WorkTrendChartProps) {
  const [metric, setMetric] = useState<WorkMetric>('phone');
  const days = useMemo(() => buildWorkTrend(rows, fetchedAt), [rows, fetchedAt]);
  const definition = workMetrics.find((item) => item.key === metric) || workMetrics[0];
  const summary = trendSummary(days, definition.key);
  const hasValues = available && !busy && summary.knownDays > 0;
  return <section className="wb-section wb-trend-section" aria-label="CRM 近七日工作记录">
    <div className="wb-section-heading"><h2>近 7 日工作记录</h2><span className="wb-muted">{days.length ? `${days[0].label} — ${days.at(-1)?.label}` : '最近 7 天'} · 北京时间</span></div>
    <p className="wb-section-note">来源：CRM 工作日报，不是聊天自动推断</p>
    <div className="wb-trend-toolbar"><div className="wb-segments wb-trend-metrics" role="group" aria-label="查看日报指标">
      {workMetrics.map((item) => <button type="button" key={item.key} aria-pressed={definition.key === item.key} onClick={() => setMetric(item.key)}>{item.label}</button>)}
    </div><span className="wb-chart-unit">单位：{definition.unit}</span></div>
    {busy ? <div className="wb-chart-loading" role="status"><span>正在读取工作日报…</span><div aria-hidden="true" /><div aria-hidden="true" /><div aria-hidden="true" /></div>
      : !available ? <div className="wb-chart-empty"><strong>工作日报暂不可用</strong><p>请检查上方连接或权限提示。未读取的数据不会画成 0。</p></div>
        : !summary.knownDays ? <div className="wb-chart-empty"><strong>CRM 尚未返回本项日报数值</strong><p>未返回、空值与数字 0 分开处理；填写并保存 CRM 日报后可刷新核对。</p></div>
          : <><div className="wb-trend-summary" aria-live="polite"><span>{definition.label} · {summary.missingDays ? `已返回 ${summary.knownDays} 天合计` : '7 天合计'} <strong>{summary.total}</strong> {definition.unit}</span>
            <span className={summary.missingDays ? 'wb-chart-incomplete' : 'wb-muted'}>{summary.state === 'zero' ? 'CRM 返回本项均为 0' : summary.missingDays ? `${summary.missingDays} 天未返回本项，保留断点` : '按日报原值展示'}</span></div>
          <div className="wb-trend-plot">
            <ResponsiveContainer width="100%" height={248} minWidth={0}>
              <LineChart data={days} accessibilityLayer title={`近 7 日${definition.label}，单位${definition.unit}；缺失数据不连线，下方可查看原数值。`} margin={{ top: 12, right: 18, left: -14, bottom: 4 }}>
                <CartesianGrid vertical={false} stroke="var(--chart-grid, var(--line))" strokeDasharray="3 5" />
                <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fill: 'var(--chart-text, var(--text-2))', fontSize: 12 }} minTickGap={12} padding={{ left: 16, right: 16 }} />
                <YAxis allowDecimals={false} tickCount={5} domain={[0, Math.max(1, summary.maximum)]} tickLine={false} axisLine={false} tick={{ fill: 'var(--chart-text, var(--text-2))', fontSize: 12 }} width={50} />
                <Tooltip isAnimationActive={false} cursor={{ stroke: 'var(--chart-grid, var(--line))' }}
                  contentStyle={{ background: 'var(--surface)', border: '1px solid var(--line-strong, var(--line))', borderRadius: 4, color: 'var(--text)', fontSize: 12 }}
                  labelStyle={{ color: 'var(--text-2)' }} itemStyle={{ color: 'var(--text)' }}
                  formatter={(value) => [`${value} ${definition.unit}`, definition.label]} labelFormatter={(label) => `日期 ${label}`} />
                <Line type="linear" dataKey={definition.key} name={definition.label} connectNulls={false} isAnimationActive={false}
                  stroke="var(--chart-primary, var(--accent))" strokeWidth={2.5} dot={{ r: 3, fill: 'var(--surface)', strokeWidth: 2 }} activeDot={{ r: 5, stroke: 'var(--surface)', strokeWidth: 2 }} />
              </LineChart>
            </ResponsiveContainer>
          </div></>}
    {available && !busy && <>
      <p className="wb-chart-source-note">CRM 未填日报也可能返回 0，不能据此认定当天没有工作。缺失数值以“—”表示。</p>
      {(hasValues || days.length > 0) && <details className="wb-chart-values"><summary>查看日报原数值</summary><div className="wb-trend-table"><table>
        <caption className="wb-sr-only">CRM 日报的电话、获客、面谈、到访和成交原值；— 为未返回</caption>
        <thead><tr><th scope="col">日期</th>{workMetrics.map((item) => <th scope="col" key={item.key}>{item.label}（{item.unit}）</th>)}</tr></thead>
        <tbody>{days.map((day) => <tr key={day.date}><th scope="row"><time dateTime={day.date}>{day.label}</time></th>{workMetrics.map((item) => <td key={item.key} title={day[item.key] === null ? 'CRM 未返回本项' : undefined}>{day[item.key] ?? '—'}</td>)}</tr>)}</tbody>
      </table></div></details>}
    </>}
  </section>;
}

export function CustomerGradeChart({ rows, busy, available }: ChartStatus & { rows: ReadonlyArray<{ level: string; count: unknown }> }) {
  const grades = useMemo(() => gradeDistribution(rows), [rows]);
  const maximum = Math.max(1, ...grades.map((item) => item.count ?? 0));
  return <section className="wb-section wb-grade-section" aria-label="CRM 客户等级分布">
    <div className="wb-section-heading"><h2>客户分级</h2><span className="wb-muted">单位：位</span></div>
    <p className="wb-section-note">CRM 当前范围 · 分类，非销售阶段</p>
    {busy ? <div className="wb-chart-loading" role="status"><span>正在读取客户分级…</span><div aria-hidden="true" /><div aria-hidden="true" /><div aria-hidden="true" /></div>
      : !available ? <div className="wb-chart-empty"><strong>等级分布暂不可用</strong><p>当前连接或权限未返回统计，不以 0 代替。</p></div>
        : grades.length ? <dl className="wb-grade-bars">{grades.map((item) => <div key={item.grade}>
          <dt>{item.grade}</dt><dd><span className="wb-grade-bar-track" aria-hidden="true"><span style={{ width: `${((item.count ?? 0) / maximum) * 100}%` }} /></span>
            <strong>{item.count ?? '—'}</strong><span className="wb-sr-only">{item.count === null ? '未返回' : '位'}</span></dd>
        </div>)}</dl> : <div className="wb-chart-empty"><strong>CRM 暂无客户等级统计</strong><p>这里会按 CRM 实际返回的分级显示人数，不推算成交率。</p></div>}
    {available && !busy && grades.length > 0 && <p className="wb-chart-source-note">横条比较人数，不代表阶段流转或目标完成度。</p>}
  </section>;
}
