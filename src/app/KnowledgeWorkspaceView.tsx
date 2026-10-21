import { useEffect, useRef, useState } from 'react';
import { Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle } from '@fluentui/react-components';
import { Add20Regular, ArrowSync20Regular, DocumentAdd20Regular } from '@fluentui/react-icons';
import type { FeatureBridge } from '../shared/feature-bridge-contracts';
import { KNOWLEDGE_BODY_MAX_LENGTH, KNOWLEDGE_TITLE_MAX_LENGTH } from '../shared/knowledge-workspace-contracts';
import type { KnowledgeDocument, KnowledgeDraftInput, KnowledgeImportResult, KnowledgeWorkspace } from '../shared/knowledge-workspace-contracts';
import { displayTime, FeatureActionCancelled, featureValue } from './feature-views-model';
import { canApproveKnowledge, emptyKnowledgeDraft, filterKnowledgeDocuments, knowledgeCounts, knowledgeDraftDirty, knowledgeDraftError, knowledgeDraftFrom, knowledgeState, knowledgeStateLabels, type KnowledgeFilter } from './knowledge-workspace-model';
import './knowledge-workspace.css';

type Intent = { kind: 'open'; id: string } | { kind: 'new' | 'approve' | 'disable' };
interface Props {
  active: boolean;
  onNotice: (message: string, kind?: 'success' | 'error') => void;
  onChanged: () => void;
  onOpenSearch: () => void;
}

function bridge(): FeatureBridge {
  if (!window.salesCopilot?.getKnowledgeWorkspace) throw new Error('资料管理接口暂不可用，请重新打开已更新的桌面应用。');
  return window.salesCopilot;
}
const failureMessage = (error: unknown) => error instanceof Error ? error.message : '操作未完成，请重试。';

export function KnowledgeWorkspaceView({ active, onNotice, onChanged, onOpenSearch }: Props) {
  const [workspace, setWorkspace] = useState<KnowledgeWorkspace | null>(null);
  const [selected, setSelected] = useState<KnowledgeDocument | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<KnowledgeDraftInput>(emptyKnowledgeDraft);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<KnowledgeFilter>('all');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [report, setReport] = useState<KnowledgeImportResult | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [intent, setIntent] = useState<Intent | null>(null);
  const [needsReload, setNeedsReload] = useState(false);
  const [now, setNow] = useState(Date.now);
  const alive = useRef(true);
  const inFlight = useRef(false);
  const changed = useRef(onChanged); changed.current = onChanged;
  const focusReturn = useRef<HTMLElement | null>(null);
  const errorElement = useRef<HTMLDivElement>(null);
  const titleElement = useRef<HTMLInputElement>(null);
  const dirty = knowledgeDraftDirty(draft, selected);
  const validation = knowledgeDraftError(draft);
  const counts = workspace ? knowledgeCounts(workspace.documents, now) : null;
  const documents = workspace ? filterKnowledgeDocuments(workspace.documents, query, filter, now) : [];
  const approvalReady = canApproveKnowledge(selected, dirty, reviewed, now) && !needsReload;

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { if (error && !intent && active) errorElement.current?.focus(); }, [error, intent, active]);
  useEffect(() => { if (creating && active) titleElement.current?.focus(); }, [creating, active]);
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    void run('load', refreshWorkspace);
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [active]);

  async function refreshWorkspace() {
    const next = featureValue(await bridge().getKnowledgeWorkspace());
    if (alive.current) setWorkspace(next);
  }
  async function run(name: string, operation: () => Promise<string | void>, mutation = false) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(name); setError('');
    if (mutation) changed.current();
    let failed = false;
    try {
      const message = await operation();
      if (alive.current && message) onNotice(message, 'success');
    } catch (failure) {
      failed = true;
      if (alive.current && !(failure instanceof FeatureActionCancelled)) { setError(failureMessage(failure)); if (mutation) setNeedsReload(true); }
    } finally {
      if (mutation && alive.current) {
        changed.current();
        try { await refreshWorkspace(); } catch (failure) { if (alive.current && !failed) setError(`操作已完成，但列表未刷新：${failureMessage(failure)}`); }
      }
      inFlight.current = false;
      if (alive.current) { setBusy(''); setNow(Date.now()); }
    }
  }
  function accept(document: KnowledgeDocument | null) {
    if (!alive.current) return;
    setSelected(document); setDraft(document ? knowledgeDraftFrom(document) : emptyKnowledgeDraft());
    setCreating(!document); setReviewed(false); setNeedsReload(false);
  }
  function closeDialog() {
    setIntent(null);
    requestAnimationFrame(() => { if (focusReturn.current?.isConnected) focusReturn.current.focus(); });
  }
  function ask(next: Intent) {
    if (inFlight.current) return;
    focusReturn.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setError(''); setIntent(next);
  }
  function openDocument(id: string) {
    void run('open', async () => { const document = featureValue(await bridge().getKnowledgeDocument(id)); accept(document); closeDialog(); });
  }
  function choose(next: Intent) {
    if (inFlight.current) return;
    if (dirty) { ask(next); return; }
    if (next.kind === 'new') { setError(''); accept(null); }
    else if (next.kind === 'open') openDocument(next.id);
  }
  function edit(patch: Partial<KnowledgeDraftInput>) { setDraft({ ...draft, ...patch }); setReviewed(false); }
  function save() {
    if (validation) { setError(validation); return; }
    if (needsReload || !dirty || (!selected && !creating)) return;
    void run('save', async () => {
      const result = selected
        ? await bridge().saveKnowledgeDocument({ ...draft, id: selected.id, expectedRevision: selected.revision })
        : await bridge().createKnowledgeDocument(draft);
      accept(featureValue(result));
      return '已保存为待审核资料；尚未用于回复。';
    }, true);
  }
  function changeStatus(status: 'draft' | 'approved' | 'disabled') {
    if (!selected || dirty || needsReload || (status === 'approved' && !canApproveKnowledge(selected, dirty, reviewed))) return;
    void run(status, async () => {
      const next = featureValue(await bridge().setKnowledgeDocumentStatus({ id: selected.id, expectedRevision: selected.revision, status }));
      accept(next); closeDialog();
      return status === 'approved' ? '资料已启用，可以在“目录与检索”核对命中片段。' : status === 'disabled' ? '已停用本机副本；外部目录中的文件不受影响。' : '已转为待审核，请重新核对后启用。';
    }, true);
  }
  function confirmIntent() {
    if (!intent || inFlight.current) return;
    if (intent.kind === 'open') openDocument(intent.id);
    else if (intent.kind === 'new') { accept(null); closeDialog(); }
    else changeStatus(intent.kind === 'approve' ? 'approved' : 'disabled');
  }
  const discarding = intent?.kind === 'new' || intent?.kind === 'open';

  return <div className="kw-workspace">
    <div className="kw-heading"><div><h2>本机资料</h2><p>先保存、再审核。只有启用且未过期的本机资料才进入回复依据。</p></div>
      <div className="fv-actions"><Button appearance="primary" icon={<DocumentAdd20Regular />} disabled={Boolean(busy)} onClick={() => void run('import', async () => {
        const result = featureValue(await bridge().importKnowledgeDocuments());
        if (alive.current) setReport(result);
        return result.imported.length ? `已接收 ${result.imported.length} 份资料，均为待审核。` : '没有新增资料，请查看导入结果。';
      }, true)}>{busy === 'import' ? '正在接收…' : '导入 MD / TXT'}</Button>
        <Button icon={<Add20Regular />} disabled={Boolean(busy)} onClick={() => choose({ kind: 'new' })}>新建资料</Button></div>
    </div>
    <p className="kw-boundary">本机加密保存副本，不改原文件。每批最多 20 份、每份 2 MB / 20 万字；先脱敏，不自动收集客户聊天或 CRM 记录。</p>
    {error && <div className="fv-error" role="alert" tabIndex={-1} ref={errorElement}>{error}{needsReload && <p>请刷新列表并重新选择资料核对保存结果，再继续编辑；不要重复新建。</p>}</div>}
    {report && <details className="kw-import-report" open><summary>本次接收 {report.imported.length} 份 · 未导入 {report.skipped.length} 份</summary>
      {report.imported.length > 0 && <p>新文件已放入待审核列表，导入不等于启用。</p>}
      {report.skipped.length > 0 && <ul>{report.skipped.map((item, index) => <li key={`${item.name}-${index}`}><strong>{item.name}</strong>：{item.error}</li>)}</ul>}
      <Button appearance="subtle" onClick={() => setReport(null)}>收起本次结果</Button></details>}
    <div className="kw-columns">
      <aside className="kw-library" aria-label="资料列表">
        <div className="kw-library-toolbar"><label className="fv-field"><span>搜索资料</span><input type="search" value={query} placeholder="标题或来源文件名" onChange={(event) => setQuery(event.target.value)} /></label>
          <Button appearance="subtle" icon={<ArrowSync20Regular />} aria-label="刷新资料列表" title="刷新资料列表，不覆盖编辑内容" disabled={Boolean(busy)} onClick={() => void run('load', refreshWorkspace)} /></div>
        <nav className="kw-filters" aria-label="资料状态">{(['all', 'draft', 'approved', 'expired', 'disabled'] as const).map((value) => <button key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{value === 'all' ? '全部' : knowledgeStateLabels[value]} <span>{counts ? counts[value === 'all' ? 'total' : value] : '—'}</span></button>)}</nav>
        {!workspace ? <div className="kw-empty" role="status">{error ? '资料列表尚未读取，请刷新重试。' : '正在读取本机资料…'}</div> : !documents.length ? <div className="kw-empty"><p>{workspace.documents.length ? '没有符合条件的资料。' : '还没有本机资料'}</p><small>{workspace.documents.length ? '更换关键词或状态试试。' : '从一份培训笔记或常见问答开始；也可以明天再导入。'}</small></div>
          : <ul className="kw-document-list">{documents.map((item) => <li key={item.id}><button aria-pressed={selected?.id === item.id} disabled={Boolean(busy)} onClick={() => choose({ kind: 'open', id: item.id })}>
            <span className="kw-document-title">{item.title}</span><span className={`kw-state kw-state-${knowledgeState(item, now)}`}>{knowledgeStateLabels[knowledgeState(item, now)]}</span>
            <small>{item.sourceName || '手动录入'} · 版本 {item.revision}</small><small>{item.characters.toLocaleString('zh-CN')} 字 · {displayTime(item.updatedAt)}</small>
          </button></li>)}</ul>}
      </aside>
      <section className="kw-editor" aria-label="资料内容与审核">
        {!selected && !creating ? <div className="kw-empty kw-editor-empty"><h2>把自己的经验变成可核对的依据</h2><p>选择左侧资料检查正文，或新建一份。未审核内容不会进入本机资料索引。</p><Button onClick={onOpenSearch}>查看外部目录与试搜</Button><small>旧笔记目录按原规则接入；这里的审核只管理本机副本。</small></div>
          : <>
            <div className="kw-editor-heading"><h2>{creating ? '新建资料' : '核对与编辑'}</h2><span className={`kw-state kw-state-${selected ? knowledgeState(selected, now) : 'draft'}`}>{dirty ? '未保存' : selected ? knowledgeStateLabels[knowledgeState(selected, now)] : '待填写'}</span></div>
            {selected && <p className="kw-source">{selected.sourceName || '手动录入'} · 版本 {selected.revision} · 更新于 {displayTime(selected.updatedAt)}</p>}
            <form onSubmit={(event) => { event.preventDefault(); save(); }}>
              <fieldset disabled={Boolean(busy)} className="kw-editor-fields">
                <div className="kw-editor-meta"><label className="fv-field"><span>资料标题</span><input ref={titleElement} required maxLength={KNOWLEDGE_TITLE_MAX_LENGTH} value={draft.title} onChange={(event) => edit({ title: event.target.value })} /></label>
                  <label className="fv-field"><span>有效至（可留空）</span><input type="date" value={draft.expiry || ''} onChange={(event) => edit({ expiry: event.target.value || null })} /><small>截至所选日期北京时间结束</small></label></div>
                <label className="fv-field"><span>正文</span><textarea required maxLength={KNOWLEDGE_BODY_MAX_LENGTH} rows={15} value={draft.body} onChange={(event) => edit({ body: event.target.value })} placeholder="填写已核对的事实、适用条件和例外情况。案例请先去除客户姓名、电话等私人信息。" /><small>{draft.body.length.toLocaleString('zh-CN')} / 200,000 字 · 支持 Markdown 文字</small></label>
              </fieldset>
              {selected?.status === 'approved' && dirty && <p className="fv-warning">保存修订后，这份本机资料会立即退出回复依据；重新审核启用后再使用。</p>}
              {dirty && <p className="kw-unsaved">未保存内容仅在本次窗口保留；切换页面不会清空，关闭软件前请保存。</p>}
              <div className="fv-actions"><Button type="submit" appearance={dirty ? 'primary' : 'secondary'} disabled={Boolean(busy) || !dirty || Boolean(validation) || needsReload}>{busy === 'save' ? '正在保存…' : '保存为待审核'}</Button>
                {selected && <Button disabled={Boolean(busy)} onClick={() => choose({ kind: 'open', id: selected.id })}>重新读取此资料</Button>}</div>
            </form>
            <div className="kw-review">
              <h3>审核后用于回复</h3>
              {selected?.status === 'draft' && <label className="fv-check"><input type="checkbox" checked={reviewed} disabled={Boolean(busy) || dirty || needsReload} onChange={(event) => setReviewed(event.target.checked)} /><span>我已核对内容、适用条件，并确认不含客户私人资料。</span></label>}
              <p>{dirty || !selected ? '先保存，再逐份审核启用。' : selected.status === 'disabled' ? '已停用。恢复后会进入待审核，不会直接启用。' : selected.expiry && Date.parse(`${selected.expiry}T23:59:59.999+08:00`) < now ? '有效期已结束。请修改有效期、保存，再重新审核。' : selected.status === 'approved' ? '已进入本机索引；可试搜核对实际命中片段。检索命中不代表结论一定适用。' : '启用会更新回复依据，不会自动生成或发送消息。'}</p>
              <div className="fv-actions">{selected?.status === 'draft' && <Button appearance="primary" disabled={Boolean(busy) || !approvalReady} onClick={() => ask({ kind: 'approve' })}>审核并启用</Button>}
                {selected?.status === 'disabled' && <Button disabled={Boolean(busy) || dirty || needsReload} onClick={() => changeStatus('draft')}>转为待审核</Button>}
                {selected && selected.status !== 'disabled' && <Button disabled={Boolean(busy) || dirty || needsReload} onClick={() => ask({ kind: 'disable' })}>停用本机副本</Button>}
                <Button disabled={Boolean(busy)} onClick={onOpenSearch}>试搜知识库</Button></div>
              <small>本次审核仅针对本机副本。外部目录里的同名文件仍按目录规则处理，停用本机副本不会移除那份外部资料。</small>
            </div>
          </>}
      </section>
    </div>
    <Dialog open={Boolean(intent)} onOpenChange={(_, data) => { if (!data.open && !busy) closeDialog(); }}>
      <DialogSurface className="fv-dialog"><DialogBody><DialogTitle>{discarding ? '放弃尚未保存的修改？' : intent?.kind === 'approve' ? '确认启用这份资料？' : '停用这份本机资料？'}</DialogTitle>
        <DialogContent>{discarding ? <p>未保存的标题、正文和有效期会丢失。已经保存的版本不受影响。</p> : <><p>《{selected?.title}》· 版本 {selected?.revision}</p><p>{intent?.kind === 'approve' ? '启用后可供检索和回复引用。请确认内容真实、已脱敏，并且适用于你的实际业务。' : '停用后不再引用这份本机副本，资料仍保留且可恢复为待审核；外部目录文件不受影响。'}</p></>}
          {error && <div className="fv-error" role="alert">{error}</div>}</DialogContent>
        <DialogActions><Button disabled={Boolean(busy)} onClick={closeDialog}>取消</Button><Button appearance="primary" disabled={Boolean(busy) || (intent?.kind === 'approve' && !approvalReady)} onClick={confirmIntent}>{busy ? '处理中…' : discarding ? '放弃修改并继续' : intent?.kind === 'approve' ? '确认启用' : '确认停用'}</Button></DialogActions>
      </DialogBody></DialogSurface>
    </Dialog>
  </div>;
}
