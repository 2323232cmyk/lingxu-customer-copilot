import { useEffect, useRef, useState } from 'react';
import { Button } from '@fluentui/react-components';
import { Add20Regular, ArrowSync20Regular, Checkmark20Regular, Delete20Regular } from '@fluentui/react-icons';
import type { FeatureBridge } from '../shared/feature-bridge-contracts';
import type { LocalPlan } from '../shared/local-plan-contracts';
import { featureValue } from './feature-views-model';
import { workbenchTime } from './workbench-model';
import './workbench.css';

export interface LocalPlanPanelProps {
  accountKey?: string;
  onNotice: (message: string) => void;
}

/** datetime-local is deliberately interpreted in the computer's local timezone. */
export function localPlanTimeToIso(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error('请选择有效的计划日期和时间。');
  const [, year, month, day, hour, minute] = match.map(Number);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getFullYear() !== year || date.getMonth() + 1 !== month
    || date.getDate() !== day || date.getHours() !== hour || date.getMinutes() !== minute) throw new Error('请选择有效的计划日期和时间。');
  return date.toISOString();
}

function plansBridge(): FeatureBridge {
  const bridge = typeof window === 'undefined' ? undefined : window.salesCopilot;
  if (!bridge || ['listLocalPlans', 'createLocalPlan', 'updateLocalPlan', 'deleteLocalPlan'].some((key) => typeof bridge[key as keyof FeatureBridge] !== 'function')) {
    throw new Error('本机计划服务尚未连接，请重新打开软件后重试。');
  }
  return bridge;
}
const messageOf = (failure: unknown) => failure instanceof Error ? failure.message : '本机计划操作失败，原记录未被移除。';

function AccountPlans({ accountKey, onNotice }: { accountKey: string; onNotice: LocalPlanPanelProps['onNotice'] }) {
  const [plans, setPlans] = useState<LocalPlan[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [title, setTitle] = useState('');
  const [dueLocal, setDueLocal] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [filter, setFilter] = useState<'open' | 'done'>('open');
  const [actionError, setActionError] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [visible, setVisible] = useState(10);
  const generation = useRef(0);
  const mutating = useRef(false);

  useEffect(() => {
    const ticket = ++generation.current;
    setLoading(true); setLoadError(''); setPlans(null); setConfirmDelete(null);
    async function load() {
      try {
        const rows = featureValue(await plansBridge().listLocalPlans(accountKey));
        if (generation.current === ticket) setPlans(rows);
      } catch (failure) { if (generation.current === ticket) setLoadError(messageOf(failure)); }
      finally { if (generation.current === ticket) setLoading(false); }
    }
    void load();
    return () => { generation.current += 1; };
  }, [accountKey, revision]);

  async function change(kind: 'create' | 'toggle' | 'delete', plan?: LocalPlan) {
    if (mutating.current || loading || plans === null) return;
    if (kind !== 'create' && (!plan || !plans.some((value) => value.id === plan.id))) return;
    if (kind === 'delete' && confirmDelete !== plan?.id) return;
    let dueAt = '';
    if (kind === 'create') {
      if (!title.trim() || title.length > 200 || [...title].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
        setActionError('计划内容需为 1 至 200 字的单行文字。'); return;
      }
      try { dueAt = localPlanTimeToIso(dueLocal); } catch (failure) { setActionError(messageOf(failure)); return; }
    }
    const ticket = generation.current;
    mutating.current = true; setPending(kind === 'create' ? 'create' : `${kind}:${plan?.id}`); setActionError('');
    try {
      const bridge = plansBridge();
      if (kind === 'create') {
        const saved = featureValue(await bridge.createLocalPlan({ accountKey, title: title.trim(), dueAt }));
        if (generation.current !== ticket) return;
        setPlans((current) => current ? [...current, saved] : current);
        setTitle(''); setDueLocal(''); setFormOpen(false); setFilter('open');
        onNotice('本机计划已保存，不会写入 CRM。');
      } else if (kind === 'toggle' && plan) {
        const saved = featureValue(await bridge.updateLocalPlan({ accountKey, id: plan.id, done: !plan.done }));
        if (generation.current !== ticket) return;
        if (saved.id !== plan.id) throw new Error('返回的计划身份不一致，请重新读取后核对。');
        setPlans((current) => current?.map((row) => row.id === saved.id ? saved : row) ?? null);
        onNotice(saved.done ? '本机计划已完成，仍可在“已完成”中恢复。' : '本机计划已恢复为未完成。');
      } else if (kind === 'delete' && plan) {
        featureValue(await bridge.deleteLocalPlan({ accountKey, id: plan.id }));
        if (generation.current !== ticket) return;
        setPlans((current) => current?.filter((row) => row.id !== plan.id) ?? null); setConfirmDelete(null);
        onNotice('已删除这项本机计划，无法撤销；CRM 记录未改动。');
      }
    } catch (failure) { if (generation.current === ticket) setActionError(messageOf(failure)); }
    finally { if (generation.current === ticket) { mutating.current = false; setPending(null); } }
  }

  const filtered = (plans || []).filter((plan) => plan.done === (filter === 'done'))
    .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt) || a.id.localeCompare(b.id));
  const available = plans !== null && !loading;
  const disabled = Boolean(pending) || !available;
  return <>
    <div className="wb-local-plan-toolbar"><div className="wb-segments" role="group" aria-label="本机计划状态">
      {([{ id: 'open', label: '未完成' }, { id: 'done', label: '已完成' }] as const).map((option) => <button type="button" key={option.id} aria-pressed={filter === option.id} onClick={() => { setFilter(option.id); setVisible(10); setConfirmDelete(null); }}>
        {option.label}<span>{plans ? plans.filter((plan) => plan.done === (option.id === 'done')).length : '—'}</span>
      </button>)}
    </div><div className="wb-local-plan-actions"><Button appearance="subtle" size="small" icon={<ArrowSync20Regular />} disabled={Boolean(pending) || loading} onClick={() => { if (!mutating.current) { setRevision((value) => value + 1); setActionError(''); } }}>重读</Button>
      <Button size="small" icon={<Add20Regular />} disabled={disabled} aria-expanded={formOpen} onClick={() => { setFormOpen((value) => !value); setActionError(''); }}>{formOpen ? '收起新增' : '新增计划'}</Button></div></div>
    {formOpen && <form className="wb-local-plan-form" aria-label="新增本机计划" onSubmit={(event) => { event.preventDefault(); void change('create'); }}>
      <label className="wb-local-plan-title"><span>计划内容</span><input name="title" value={title} onChange={(event) => setTitle(event.target.value)} required maxLength={200} disabled={disabled} placeholder="如：整理明天到访的沟通材料" /></label>
      <label><span>计划时间（本机时区）</span><input name="dueLocal" type="datetime-local" step={60} value={dueLocal} onChange={(event) => setDueLocal(event.target.value)} required disabled={disabled} /></label>
      <Button appearance="primary" type="submit" disabled={disabled}>{pending === 'create' ? '保存中…' : '保存计划'}</Button>
      <small>只保存在本机当前微信账号下，不自动发送消息，也不会创建 CRM 任务。</small>
    </form>}
    {loadError && <div className="wb-local-plan-error" role="alert"><strong>本机计划读取失败</strong><p>{loadError}</p><p>这不代表没有计划；不会用空列表覆盖原文件。</p><Button appearance="subtle" onClick={() => setRevision((value) => value + 1)}>重新读取</Button></div>}
    {actionError && <div className="wb-local-plan-error" role="alert"><p>{actionError}</p><small>未确认成功前，不会清空输入或移除原计划。</small></div>}
    {loading ? <div className="wb-loading" role="status"><span>正在读取本机加密计划…</span><div /><div /></div> : plans !== null && <>
      <ul className="wb-local-plan-list">{filtered.slice(0, visible).map((plan) => {
        const overdue = !plan.done && Date.parse(plan.dueAt) < Date.now();
        return <li key={plan.id}><div className="wb-local-plan-row"><span className={`wb-status ${overdue ? 'wb-status-overdue' : ''}`}>{plan.done ? '已完成' : overdue ? '逾期' : '计划中'}</span>
          <div className="wb-local-plan-body"><strong>{plan.title}</strong><time dateTime={plan.dueAt}>{workbenchTime(plan.dueAt)}</time></div>
          <div className="wb-local-plan-actions"><Button appearance="subtle" size="small" icon={plan.done ? undefined : <Checkmark20Regular />} disabled={Boolean(pending)} onClick={() => void change('toggle', plan)}>{pending === `toggle:${plan.id}` ? '保存中…' : plan.done ? '恢复' : '完成'}</Button>
            <Button appearance="subtle" size="small" icon={<Delete20Regular />} aria-label={`删除计划：${plan.title}`} disabled={Boolean(pending)} onClick={() => { setConfirmDelete(plan.id); setActionError(''); }}>删除</Button></div>
        </div>{confirmDelete === plan.id && <div className="wb-local-delete-confirm" role="group" aria-label={`确认删除计划：${plan.title}`}><p>删除这项本机计划？删除后无法恢复，CRM 记录不受影响。</p><Button size="small" disabled={Boolean(pending)} onClick={() => setConfirmDelete(null)}>取消</Button><Button size="small" disabled={Boolean(pending)} onClick={() => void change('delete', plan)}>{pending === `delete:${plan.id}` ? '删除中…' : '确认删除'}</Button></div>}</li>;
      })}</ul>
      {!filtered.length && <p className="wb-local-plan-empty">{filter === 'open' ? '当前没有未完成的本机计划，可手动新增。' : '还没有已完成的本机计划。'}</p>}
      {filtered.length > visible && <Button appearance="subtle" size="small" onClick={() => setVisible((value) => value + 10)}>再显示 {Math.min(10, filtered.length - visible)} 项</Button>}
    </>}
    {pending && <span className="wb-sr-only" role="status">正在保存本机计划，请稍候。</span>}
  </>;
}

export function LocalPlanPanel({ accountKey, onNotice }: LocalPlanPanelProps) {
  return <section className="wb-local-plan-panel" aria-label="本机计划"><div className="wb-section-heading"><h2>本机计划</h2><span className="wb-muted">与 CRM 任务分开</span></div>
    <p className="wb-section-note">按微信账号隔离、在这台电脑上加密保存；只有你手动操作才会新增或改动，不回写 CRM。</p>
    {accountKey?.trim() ? <AccountPlans key={accountKey} accountKey={accountKey} onNotice={onNotice} /> : <div className="wb-empty wb-empty-short"><strong>先选择并连接微信账号</strong><p>确认当前微信账号后，才能查看和安排该账号的本机计划。</p><Button icon={<Add20Regular />} disabled>新增计划</Button></div>}
  </section>;
}
