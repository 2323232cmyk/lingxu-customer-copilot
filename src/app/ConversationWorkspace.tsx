import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Tooltip } from '@fluentui/react-components';
import { ArrowDown20Regular, ArrowExport20Regular, ArrowSync20Regular, CheckmarkCircle20Regular, DocumentText20Regular, Link20Regular, Settings20Regular } from '@fluentui/react-icons';
import type { WechatLiveConversation, WechatLiveMessage, WechatLiveStatus } from '../shared/contracts';
import type { ConversationCrmBinding, ConversationReplyPreview, WechatFeatureScope } from '../shared/feature-bridge-contracts';
import type { AiContextSummary, AiDraftResponse, CrmCustomerContext, IntegrationSettingsPublic } from '../shared/integration-contracts';
import { buildStrategyReplyDrafts } from './reply-engine';
import { replayLiveStrategy } from './strategy-runtime';
import { conversationKindText, formatWechatTime } from './wechat-inbox';
import { conversationSignature, crmText, customerWithCrm, messageAvatar } from './conversation-presentation';
import { PrivateImage, WechatMessageBody } from './wechat-media';
import { VoiceMessage } from './VoiceMessage';
import { CrmBindingDialog, type SettingsSection } from './FeatureViews';
import { crmRecordParts } from './feature-views-model';
import type { WorkspaceDesign } from './layout-preferences';
import { ReplyComposer, type ReplyChoice } from './ReplyComposer';

type Notice = (message: string, kind?: 'success' | 'error') => void;
type AdviceTab = '建议' | '客户资料' | '引用';


function ContextSummary({ summary }: { summary: AiContextSummary }) {
  return <section className="generation-context-summary" aria-label="本次提供给模型的资料">
    <div className="context-counts"><span>聊天 <strong>{summary.chatMessages}</strong> 条</span><span>CRM <strong>{summary.crmRecords}</strong> 条</span><span>知识 <strong>{summary.knowledgeHits}</strong> 条</span></div>
    {summary.focus && <p><strong>本次回应</strong>{summary.focus}</p>}
    {summary.knowledgeStatus === 'no_match' && <p className="inline-warning">知识库没有相关命中，不能据此确认费用或规则。</p>}
    {summary.knowledgeStatus === 'disabled' && <small>本次未使用公司知识库。</small>}
    {summary.knowledgeQueries.length > 0 && <details><summary>查看知识检索问题</summary>{summary.knowledgeQueries.map((query, index) => <p key={index}>{query}</p>)}</details>}
  </section>;
}

function CrmSummary({ binding, context, error, onBind }: {
  binding: ConversationCrmBinding | null; context: CrmCustomerContext | null; error: string; onBind: () => void;
}) {
  return <section className="crm-summary" aria-label="关联的CRM资料">
    <div className="section-heading"><h3>客户资料（CRM）</h3><button type="button" className="text-link" onClick={onBind}><Link20Regular />{binding ? '更改关联' : '关联 CRM'}</button></div>
    {context ? <div className="crm-summary-body">
      <strong>{crmText(context.customer, 'name') || binding?.customerName}</strong>
      <dl><div><dt>预算</dt><dd>{crmText(context.customer, 'budget') || '未填写'}</dd></div>
        <div><dt>购房区域</dt><dd>{crmText(context.customer, 'area') || '未填写'}</dd></div>
        <div><dt>客户位置</dt><dd>{crmText(context.customer, 'location') || '未填写'}</dd></div>
        <div><dt>类型</dt><dd>{crmText(context.customer, 'customerType', 'houseRequirement') || '未填写'}</dd></div>
        <div><dt>电话</dt><dd>{crmText(context.customer, 'phone') || '未填写'}</dd></div></dl>
      <p>{crmText(context.customer, 'targetProperty', 'houseRequirement', 'firstContact', 'loanRemark') || '暂无可显示的需求或首次沟通记录'}</p>
      <small>{context.availability.followups === 'forbidden' ? '跟进：无读取权限' : `跟进 ${context.followups.length} 条`} · {context.availability.calls === 'forbidden' ? '通话：无读取权限' : `通话 ${context.calls.length} 条`}</small>
    </div> : <div className="crm-unbound"><p>{error || (binding ? '正在读取已关联客户资料…' : '未关联客户档案。关联后可一起查看电话和跟进记录。')}</p>
      {!binding && <small>不会凭微信昵称猜测对应客户。</small>}</div>}
  </section>;
}

function CustomerHistory({ context }: { context: CrmCustomerContext | null }) {
  if (!context) return null;
  return <div className="customer-history">
    {context.availability.followups === 'forbidden' && <p className="inline-warning">当前 CRM 账号没有读取跟进记录的权限。</p>}
    <h3>跟进记录</h3>
    {context.followups.length === 0 && <p className="quiet-copy">暂无可读跟进记录。</p>}
    {context.followups.slice().reverse().map((record, index) => { const item = crmRecordParts(record, 'followup'); return <article className="history-entry" key={`followup-${index}`}>
      <small>{item.stamp || '未记录时间'}{item.author ? ` · ${item.author}` : ''}</small>
      <p>{item.text || '该记录没有文字内容'}</p>
    </article>; })}
    <h3>电话记录</h3>
    {context.availability.calls === 'forbidden' && <p className="inline-warning">当前 CRM 账号没有读取通话记录的权限。</p>}
    {context.calls.length === 0 && <p className="quiet-copy">暂无可读通话记录。</p>}
    {context.calls.slice().reverse().map((record, index) => { const item = crmRecordParts(record, 'call'); return <article className="history-entry" key={`call-${index}`}>
      <small>{item.stamp || '未记录时间'}{item.author ? ` · ${item.author}` : ''}</small>
      {item.detail && <p>{item.detail}</p>}<p>{item.text || item.transcript || '该通话没有可读摘要或转写'}</p>
      {item.text && item.transcript && <details><summary>查看通话文字</summary><p>{item.transcript}</p></details>}
    </article>; })}
    <small className="source-footnote">只读于 {new Date(context.fetchedAt).toLocaleString('zh-CN', { hour12: false })}</small>
  </div>;
}

export function ConversationWorkspace({ scope, conversation, messages, status, selfAvatarMediaKey, loading, readError,
  design, active = true, messageSource, messagesUpdatedAt, settingsRevision, onReload, onLoadEarlier, onOpenSettings, onExport, onNotice }: {
  scope: WechatFeatureScope; conversation: WechatLiveConversation; messages: WechatLiveMessage[]; status: WechatLiveStatus;
  selfAvatarMediaKey?: string; loading: boolean; readError?: string; settingsRevision: number;
  design: WorkspaceDesign; active?: boolean; messageSource: 'empty' | 'cached' | 'fresh'; messagesUpdatedAt?: string;
  onReload: () => void; onLoadEarlier: () => void; onOpenSettings: (section?: SettingsSection) => void; onExport?: () => void; onNotice: Notice;
}) {
  const [tab, setTab] = useState<AdviceTab>('建议');
  const [revision, setRevision] = useState(0);
  const [handled, setHandled] = useState(false);
  const [settings, setSettings] = useState<IntegrationSettingsPublic | null>(null);
  const [binding, setBinding] = useState<ConversationCrmBinding | null>(null);
  const [context, setContext] = useState<CrmCustomerContext | null>(null);
  const [contextError, setContextError] = useState('');
  const [bindingOpen, setBindingOpen] = useState(false);
  const [bindingRevision, setBindingRevision] = useState(0);
  const [confirmedVoice, setConfirmedVoice] = useState<Record<string, string>>({});
  const [modelReply, setModelReply] = useState<{ value: AiDraftResponse; signature: string } | null>(null);
  const [preview, setPreview] = useState<{ value: ConversationReplyPreview; signature: string } | null>(null);
  const [generating, setGenerating] = useState(false);
  const [generationError, setGenerationError] = useState('');
  const [includeKnowledge, setIncludeKnowledge] = useState(true);
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  const [useLocalDrafts, setUseLocalDrafts] = useState(false);
  const advice = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const alive = useRef(true);
  const generationToken = useRef(0);
  const preparing = useRef(false);
  const pendingReply = useRef<{ scope: WechatFeatureScope; previewId: string } | null>(null);
  const runningReply = useRef(false);
  const releaseReply = useCallback(() => {
    const pending = pendingReply.current;
    pendingReply.current = null;
    runningReply.current = false;
    preparing.current = false;
    if (pending) void window.salesCopilot.cancelConversationReply(pending).catch(() => undefined);
  }, []);
  const transcriptMessages = useMemo(() => messages.map((message) => confirmedVoice[message.id]
    ? { ...message, text: confirmedVoice[message.id], messageType: 'text' as const } : message), [messages, confirmedVoice]);
  const customer = useMemo(() => customerWithCrm(conversation, context), [conversation, context]);
  const strategy = useMemo(() => conversation.kind === 'contact'
    ? replayLiveStrategy(customer, scope.contactKey, transcriptMessages) : null, [customer, scope.contactKey, transcriptMessages, conversation.kind]);
  const useKnowledge = settings?.knowledge.source === 'cloud' || includeKnowledge;
  const signature = `${scope.accountKey}:${scope.contactKey}:${settingsRevision}:${bindingRevision}:${context?.fetchedAt || ''}:${useKnowledge}:${conversationSignature(transcriptMessages)}`;
  const latestSignature = useRef(signature);
  latestSignature.current = signature;
  const ready = !loading && !readError && messageSource === 'fresh' && status.state === 'streaming';
  const activeTab = design === 'B' && tab === '客户资料' ? '建议' : tab;
  const canSuggest = active && ready && conversation.kind === 'contact' && messages.length > 0;
  const canGenerate = canSuggest;
  // Keep edits while verifying the same context; copying/generation still require a fresh read.
  const localDrafts = useMemo(() => strategy && messages.length > 0 ? buildStrategyReplyDrafts({ customer, ...strategy, revision }) : [], [strategy, messages.length, customer, revision]);
  const currentModelReply = modelReply?.signature === signature ? modelReply.value : null;
  const visibleDrafts: ReplyChoice[] = modelReply
    ? modelReply.value.drafts.map((draft, index) => ({ ...draft, id: `model-${index}-${revision}` }))
    : useLocalDrafts ? [...localDrafts].sort((left, right) => Number(right.tone === '推荐') - Number(left.tone === '推荐'))
      .map((draft) => ({ ...draft, sourceIds: draft.evidenceIds })) : [];
  // Context changes invalidate consent, not the user's writing. Only a deliberately
  // generated replacement changes this editor's identity within the same contact.
  const editorIdentity = `${scope.accountKey}:${scope.contactKey}:${modelReply ? 'model' : useLocalDrafts ? 'local' : 'manual'}:${revision}`;


  useEffect(() => { alive.current = true; return () => { alive.current = false; ++generationToken.current; releaseReply(); }; }, [releaseReply]);
  useEffect(() => {
    let cancelled = false;
    setContext(null); setBinding(null); setContextError('');
    void Promise.all([window.salesCopilot.getIntegrationSettings(), window.salesCopilot.getConversationCrmBinding(scope)]).then(async ([config, linked]) => {
      if (cancelled) return;
      if (config.ok) setSettings(config.value);
      if (!linked.ok) { setContextError(linked.error); return; }
      setBinding(linked.value);
      if (!linked.value) return;
      const result = await window.salesCopilot.getCrmCustomerContext(linked.value.customerId);
      if (cancelled) return;
      if (result.ok) setContext(result.value); else setContextError(result.error);
    }).catch(() => { if (!cancelled) setContextError('未能读取关联资料，可在设置中检查连接。'); });
    return () => { cancelled = true; };
  }, [scope.accountKey, scope.contactKey, settingsRevision, bindingRevision]);
  useEffect(() => {
    setHandled(false); setPreview(null); setGenerationError(''); ++generationToken.current; setGenerating(false);
    releaseReply();
    if (followLatest.current && list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [signature, releaseReply]);
  useEffect(() => {
    if (!active) { ++generationToken.current; releaseReply(); setPreview(null); setGenerating(false); }
  }, [active, releaseReply]);
  useEffect(() => {
    if (!content.current) return;
    const observer = new ResizeObserver(() => { if (followLatest.current && list.current) list.current.scrollTop = list.current.scrollHeight; });
    observer.observe(content.current); return () => observer.disconnect();
  }, []);

  const copy = async (text: string, draftSignature: string): Promise<boolean> => {
    if (!canSuggest || draftSignature !== latestSignature.current) { onNotice('会话已更新，请使用基于最新消息的建议。', 'error'); return false; }
    try { await window.salesCopilot.copyText(text); onNotice('已复制，请在微信中核对后发送。'); return true; }
    catch { onNotice('复制没有完成，请重试。', 'error'); return false; }
  };
  const generate = useCallback(async (candidate: { value: ConversationReplyPreview; signature: string }, consent: boolean) => {
    if (runningReply.current) return;
    if (candidate.signature !== latestSignature.current) { setGenerationError('客户有新消息，请重新生成。'); return; }
    const token = ++generationToken.current;
    runningReply.current = true;
    preparing.current = false;
    pendingReply.current = { scope, previewId: candidate.value.previewId };
    setGenerating(true); setGenerationError(''); setPreview(null);
    try {
      const result = await window.salesCopilot.generateConversationReply({ scope, previewId: candidate.value.previewId, remoteConsent: consent });
      if (!alive.current || token !== generationToken.current || candidate.signature !== latestSignature.current) return;
      if (result.ok) { setModelReply({ value: result.value, signature: candidate.signature }); setRevision((value) => value + 1); if (advice.current) advice.current.scrollTop = 0; }
      else if (!result.cancelled) setGenerationError(result.error);
    } catch { if (alive.current && token === generationToken.current) setGenerationError('生成未完成，请检查模型设置后重试。'); }
    finally { if (token === generationToken.current) { pendingReply.current = null; runningReply.current = false; if (alive.current) setGenerating(false); } }
  }, [scope.accountKey, scope.contactKey]);
  const prepareModel = async () => {
    if (!canGenerate || generating || preparing.current || runningReply.current) return;
    preparing.current = true;
    const token = ++generationToken.current;
    const current = latestSignature.current;
    setGenerating(true); setGenerationError('');
    try {
      const result = await window.salesCopilot.previewConversationReply({ scope, includeKnowledge: useKnowledge, includeCrm: Boolean(binding) });
      if (!alive.current || token !== generationToken.current || current !== latestSignature.current) {
        if (result.ok) void window.salesCopilot.cancelConversationReply({ scope, previewId: result.value.previewId }).catch(() => undefined);
        return;
      }
      if (!result.ok) { setGenerationError(result.error); return; }
      const candidate = { value: result.value, signature: current };
      pendingReply.current = { scope, previewId: result.value.previewId };
      if (result.value.isRemote) setPreview(candidate);
      else { await generate(candidate, false); return; }
    } catch { if (alive.current && token === generationToken.current) setGenerationError('未能准备模型上下文，请检查设置。'); }
    finally { if (token === generationToken.current) { preparing.current = false; if (alive.current) setGenerating(false); } }
  };
  const cancelReply = () => {
    ++generationToken.current;
    releaseReply(); setPreview(null); setGenerating(false); setGenerationError('');
  };
  const cycleLocalDrafts = useCallback(() => { setModelReply(null); setUseLocalDrafts(true); setTab('建议'); setRevision((value) => value + 1); }, []);
  const crmBlock = <CrmSummary binding={binding} context={context} error={contextError} onBind={() => setBindingOpen(true)} />;
  const chatFacts = <section className="chat-facts"><h3>聊天中提到的信息</h3><dl>{([['purpose', '用途'], ['budget', '预算'], ['area', '区域'], ['decisionMaker', '决策人']] as const).map(([key, label]) => {
    const fact = strategy?.state.facts[key]; return <div key={key}><dt>{label}</dt><dd>{fact?.value || '尚未确认'}{fact?.status === 'conflict' && <small>信息冲突，需核对</small>}</dd></div>;
  })}</dl></section>;
  const citedSources = currentModelReply?.sources.filter(source => currentModelReply.drafts.some(draft => draft.sourceIds.includes(source.id)))
    .sort((a, b) => Number(b.id.startsWith('kb:')) - Number(a.id.startsWith('kb:')));
  const sourcesSummary = <section className="sources-summary"><div className="section-heading"><h3>候选回复参考</h3><button type="button" className="text-link" onClick={() => setTab('引用')}>查看</button></div>
    {citedSources?.slice(0, 3).map((source) => <button type="button" className="source-row" key={source.id} onClick={() => setTab('引用')}><DocumentText20Regular />{source.title}</button>)}
    {!currentModelReply && <p className="quiet-copy">已读取的聊天{context ? '、关联 CRM 资料' : ''}与本地沟通策略。模型检索知识后会显示具体引用。</p>}
  </section>;
  const contextOptions = <details key="context" className="reply-context-config"><summary>资料选项</summary><section className="reply-context" aria-label="回复使用的资料">
            <div className="reply-context-row"><span>微信聊天</span><strong>{ready ? `已读 · 最近 ${Math.min(messages.length, 100)} 条参与起草` : '等待读取最新消息'}</strong></div>
            <div className="reply-context-row"><span>CRM 档案</span><button type="button" className="text-link" onClick={() => setBindingOpen(true)}>{contextError ? '读取失败 · 检查关联' : binding ? `${binding.customerName} · 已关联` : '关联客户' }<Link20Regular /></button></div>
            <div className="reply-context-row"><span>公司知识库</span>{settings?.knowledge.source === 'cloud' ? <strong>生成前检索 · 无依据先核实</strong> : <label className="reply-knowledge-toggle"><input id="reply-knowledge" type="checkbox" aria-label="使用公司知识库" checked={includeKnowledge} onChange={(event) => { setIncludeKnowledge(event.target.checked); setPreview(null); }} />{includeKnowledge ? '生成时检索' : '本次不使用'}</label>}</div>
            {!binding && <small>关联后会结合客户需求、跟进和通话；也可仅按聊天起草。</small>}
          </section><button type="button" className="text-link reply-settings" onClick={() => onOpenSettings('ai')}><Settings20Regular />回复设置</button></details>;
  return <>
    <main className="conversation-workspace" aria-label="当前微信聊天">
      <header className="conversation-header">
        <div className="customer-heading"><h2 title={customer.name}>{customer.name}</h2><span className="stage-chip">{conversationKindText[conversation.kind]}</span></div>
        <div className="header-actions">
          {onExport && <Button appearance="subtle" icon={<ArrowExport20Regular />} onClick={onExport}>导出此会话</Button>}
          <Tooltip content="刷新当前会话" relationship="label"><Button appearance="subtle" icon={<ArrowSync20Regular />} aria-label="刷新当前会话" disabled={loading} onClick={onReload} /></Tooltip>
          <Tooltip content={handled ? '取消已处理标记' : '标记为已处理'} relationship="label"><Button appearance="subtle" icon={<CheckmarkCircle20Regular />} aria-label={handled ? '取消已处理标记' : '标记为已处理'} aria-pressed={handled} onClick={() => setHandled(!handled)} /></Tooltip>
        </div>
      </header>
      <div className="freshness-strip"><span className={`source-dot ${ready ? 'source-dot-ready' : 'source-dot-attention'}`} />
        <span title={messagesUpdatedAt ? new Date(messagesUpdatedAt).toLocaleString('zh-CN', { hour12: false }) : undefined}>{messageSource === 'cached' ? loading ? '正在核对最新消息' : '缓存消息 · 等待重新读取' : loading ? '正在读取消息' : ready ? '已连接 · 消息自动刷新' : status.detail}</span><span>显示 {messages.length} 条</span>
      </div>
      {readError && <div className="inbox-inline-error" role="alert">{readError}<button type="button" className="text-link" onClick={onReload}>重试</button></div>}
      <div className="message-list" aria-busy={loading} ref={list} onScroll={() => { const element = list.current; if (!element) return; followLatest.current = element.scrollHeight - element.scrollTop - element.clientHeight < 50; setAwayFromLatest(!followLatest.current); }}>
        <div ref={content} className="message-items">
          <div className="earlier-messages"><button type="button" className="text-link" disabled={loading || messages.length >= 500} onClick={onLoadEarlier}>{messages.length >= 500 ? '当前展示最近 500 条 · 导出可读取更早记录' : '读取更早消息'}</button></div>
          {messages.map((message, index) => {
            const avatar = messageAvatar(message, conversation, selfAvatarMediaKey);
            const previous = messages[index - 1];
            const showTime = !previous || Math.abs(Date.parse(message.sentAt) - Date.parse(previous.sentAt)) > 5 * 60_000;
            return <div key={message.id}>
              {showTime && <div className="message-date"><time dateTime={message.sentAt}>{new Date(message.sentAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}</time></div>}
              <div className={`message-row message-row-${message.direction}`}>
                {avatar && <PrivateImage mediaKey={avatar.mediaKey} className="message-avatar" alt={`${avatar.name}的微信头像`} fallback={avatar.fallback} />}
                <div className="message-bubble">
                  {conversation.kind === 'group' && message.direction === 'incoming' && <small className="message-sender">{avatar?.name}</small>}
                  {message.messageType === 'voice' ? <VoiceMessage message={message} scope={scope} onOpenSettings={() => onOpenSettings('voice')} onConfirmed={(messageId, text) => setConfirmedVoice((current) => ({ ...current, [messageId]: text }))} /> : <WechatMessageBody message={message} />}
                  <time dateTime={message.sentAt}>{new Date(message.sentAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}</time>
                </div>
              </div>
            </div>;
          })}
          {!loading && !readError && messages.length === 0 && <div className="empty-state"><h3>这个会话暂未读到消息</h3><p>刷新后重试，不使用演示聊天填充。</p></div>}
        </div>
      </div>
      {awayFromLatest && <div className="latest-message-action"><Button size="small" icon={<ArrowDown20Regular />} onClick={() => { if (list.current) list.current.scrollTop = list.current.scrollHeight; followLatest.current = true; setAwayFromLatest(false); }}>回到最新消息</Button></div>}
    </main>
    <aside className="advice-panel" aria-label="回复参谋">
      <div className="detail-tabs" aria-label="参谋内容">{(design === 'B' ? ['建议', '引用'] : ['建议', '客户资料', '引用']).map((item) => <button type="button" key={item} aria-pressed={activeTab === item} className={activeTab === item ? 'detail-tab-active' : ''} onClick={() => setTab(item as AdviceTab)}>{item === '建议' ? '回复' : item === '引用' ? '参考' : item}</button>)}</div>
      <div className={`advice-content ${activeTab === '建议' ? 'advice-editing' : ''}`} ref={advice}>
        <div className="advice-tab-content" data-model-reply={Boolean(currentModelReply)} hidden={activeTab !== '建议'}>
          {generationError && <div className="inline-error" role="alert">{generationError}<button type="button" className="text-link" onClick={() => onOpenSettings(/知识|CRM|登录|身份|权限/.test(generationError) ? 'connections' : 'ai')}>检查设置</button></div>}
          {!ready && visibleDrafts.length > 0 && <p className="quiet-copy" role="status">草稿暂时保留，读取最新消息后可继续生成和复制。</p>}
          {modelReply && !currentModelReply && <p className="reply-update-note" role="status">有新消息或资料，已保留草稿，请核对后使用。</p>}
          <ReplyComposer key={editorIdentity} drafts={visibleDrafts} sources={currentModelReply?.sources} knowledgeStatus={currentModelReply?.contextSummary?.knowledgeStatus} disabled={!canGenerate} generating={generating} generated={Boolean(modelReply)} onCopy={(text) => copy(text, signature)} onGenerate={() => void prepareModel()} onCancel={cancelReply} />
        </div>
        {activeTab === '客户资料' && <>{crmBlock}{chatFacts}<CustomerHistory context={context} /></>}
        {activeTab === '引用' && <>
          <h2>回复参考</h2>{contextOptions}
          <div className="reference-actions"><button type="button" className="text-link" disabled={!canSuggest || generating} onClick={cycleLocalDrafts}>使用常用话术</button><span className="quiet-copy">{settings?.ai.model ? `已配置 ${settings.ai.model}` : '尚未设置回复助手'}</span></div>
          {visibleDrafts.filter((draft) => draft.reason).map((draft, index) => <section className="reply-reason" key={draft.id}><h3>{index === 0 ? '推荐回复的依据' : `说法 ${index + 1} 的依据`}</h3><p>{draft.reason}</p>{draft.warning && <p className="inline-warning">{draft.warning}</p>}</section>)}
          {currentModelReply?.contextSummary && <ContextSummary summary={currentModelReply.contextSummary} />}
          {currentModelReply && <p className="quiet-copy">本次使用 {currentModelReply.model}</p>}
          {currentModelReply?.warnings.map((warning, index) => <p className="inline-warning" key={index}>{warning}</p>)}
          {currentModelReply && <h3>提供给起草的资料</h3>}
          {currentModelReply?.sources.map((source) => <article className="source-entry" key={source.id}><DocumentText20Regular /><div><strong>{source.title}</strong><p>{source.sourcePath || source.id}</p></div></article>)}
          <h3>最近客户原文</h3>
          {transcriptMessages.filter((message) => message.direction === 'incoming' && message.text).slice(-12).reverse().map((message) => <article className="history-entry" key={message.id}><small>{confirmedVoice[message.id] ? '已核对语音 · ' : ''}{formatWechatTime(message.sentAt)}</small><p>{message.text}</p></article>)}
          {!transcriptMessages.some((message) => message.direction === 'incoming' && message.text) && <p className="quiet-copy">尚无可引用的聊天。</p>}
        </>}
      </div>
    </aside>
    {design === 'B' && <aside className="conversation-crm-panel" aria-label="客户资料与跟进履历"><header className="conversation-crm-header"><h2>客户履历</h2><span>CRM · 只读</span></header><div className="conversation-crm-content">{crmBlock}{chatFacts}<CustomerHistory context={context} />{sourcesSummary}</div></aside>}
    <CrmBindingDialog scope={scope} open={bindingOpen} onOpenChange={setBindingOpen} onBound={() => { setBindingOpen(false); setContext(null); setBindingRevision((value) => value + 1); }} onNotice={onNotice} />
    <Dialog open={Boolean(preview)} onOpenChange={(_, data) => { if (!data.open) cancelReply(); }}>
      <DialogSurface className="consent-dialog"><DialogBody><DialogTitle>生成这次回复？</DialogTitle><DialogContent>{preview && <>
        <p className="consent-intro">将本次聊天和选用的资料发送至 <strong>{new URL(preview.value.destination).hostname}</strong>。生成成功后替换当前草稿，取消则保留。</p>
        <details className="consent-details"><summary>查看本次发送的资料</summary><p>模型：{preview.value.model}</p><p>服务地址：<strong className="break-anywhere">{preview.value.destination}</strong></p>
          {preview.value.contextSummary && <ContextSummary summary={preview.value.contextSummary} />}<p className="quiet-copy">以下内容将提供给模型用于本次回复。</p>
          <div className="consent-sources">{preview.value.sources.map((source) => <details key={source.id}><summary>{source.title}</summary><pre>{source.text}</pre></details>)}</div>
        </details>{preview.value.warnings.map((warning, index) => <p className="inline-warning" key={index}>{warning}</p>)}
      </>}</DialogContent><DialogActions><Button onClick={cancelReply}>取消</Button><Button appearance="primary" onClick={() => { if (preview) void generate(preview, true); }}>确认生成</Button></DialogActions></DialogBody></DialogSurface>
    </Dialog>
  </>;
}
