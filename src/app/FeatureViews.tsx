import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle } from '@fluentui/react-components';
import { ArrowDownload20Regular, ArrowSync20Regular, Dismiss20Regular, FolderOpen20Regular, Search20Regular } from '@fluentui/react-icons';
import type { WechatLiveConversation, WechatLiveSnapshot } from '../shared/contracts';
import type { ConversationExportFormat } from '../shared/export-contracts';
import type { ConversationCrmBinding, ConversationExportTask, FeatureBridge, WechatFeatureScope } from '../shared/feature-bridge-contracts';
import type { AiProvider, AiSettings, CrmCustomerCandidate, CrmCustomerContext, CrmLoginResponse, CrmSettings, IntegrationSettingsPublic, KnowledgeHit, KnowledgeIndexStatus } from '../shared/integration-contracts';
import type { OfflineVoiceStatus, VoiceModelActionResult } from '../shared/voice-contracts';
import { isSalesWechatConversation } from '../shared/wechat-conversation-policy';
import type { NavigationLayout, WorkspaceDesign } from './layout-preferences';
import type { Appearance } from './appearance';
import { AppearanceSettings } from './AppearanceSettings';
import { KnowledgeWorkspaceView } from './KnowledgeWorkspaceView';
import { buildExportRequest, crmProfileRows, crmRecordParts, displayTime, editableAiSettings, editableCrmSettings, FeatureActionCancelled, featureValue, fieldText, providerDefaults } from './feature-views-model';
import { PrivateImage } from './wechat-media';
import { PanelResizeHandle, useSavedPanelSizes } from './WorkspaceResizeHandles';
import { clampPanelSize } from './panel-sizing';
import './feature-views.css';
import './feature-panel-sizing.css';

type Notice = (message: string, kind?: 'success' | 'error') => void;

function bridge(): FeatureBridge {
  if (!window.salesCopilot?.getIntegrationSettings) throw new Error('配置接口暂不可用，请重新打开已更新的桌面应用。');
  return window.salesCopilot;
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : '操作未完成，请重试。'; }

function useFeatureAction(onNotice: Notice) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const inFlight = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  async function run(name: string, operation: () => Promise<string | void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(name);
    setError('');
    try {
      const message = await operation();
      if (alive.current && message) onNotice(message, 'success');
    } catch (failure) {
      if (alive.current && !(failure instanceof FeatureActionCancelled)) setError(errorMessage(failure));
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy('');
    }
  }
  return { busy, error, setError, run };
}

function FeatureError({ children }: { children: string }) {
  const element = useRef<HTMLDivElement>(null);
  useEffect(() => { if (children) element.current?.focus(); }, [children]);
  return children ? <div className="fv-error" role="alert" tabIndex={-1} ref={element}>{children}</div> : null;
}

function FeatureHeader({ title, children }: { title: string; children: ReactNode }) {
  return <header className="fv-header"><h1>{title}</h1><p>{children}</p></header>;
}

function Field({ label, help, children }: { label: string; help?: string; children: ReactNode }) {
  return <label className="fv-field"><span>{label}</span>{children}{help && <small>{help}</small>}</label>;
}

function Check({ checked, onChange, disabled, children }: { checked: boolean; onChange: (value: boolean) => void; disabled?: boolean; children: ReactNode }) {
  return <label className="fv-check"><input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} /><span>{children}</span></label>;
}

function ConfirmDialog({ open, title, children, confirm, onClose, onConfirm, destructive = false }: {
  open: boolean; title: string; children: ReactNode; confirm: string; onClose: () => void; onConfirm: () => void; destructive?: boolean;
}) {
  return <Dialog open={open} onOpenChange={(_, data) => { if (!data.open) onClose(); }}>
    <DialogSurface className="fv-dialog"><DialogBody>
      <DialogTitle>{title}</DialogTitle><DialogContent>{children}</DialogContent>
      <DialogActions><Button onClick={onClose}>取消</Button><Button appearance="primary" className={destructive ? 'fv-danger-button' : undefined} onClick={onConfirm}>{confirm}</Button></DialogActions>
    </DialogBody></DialogSurface>
  </Dialog>;
}

function KnowledgeStatus({ status }: { status: KnowledgeIndexStatus }) {
  if (status.source === 'cloud') return <div className="fv-knowledge-status" role="status">
    <p>{status.state === 'ready' ? `云端已连接 · ${status.documents} 份文档 · ${status.chunks} 段资料` : '云端知识暂不可用'}</p>
    {status.version && <small>知识版本：{status.version.slice(0, 12)} · 核验于 {displayTime(status.indexedAt || '')}</small>}
    {status.warnings.map((warning, index) => <p key={index} className="fv-warning">{warning}</p>)}
  </div>;
  return <div className="fv-knowledge-status">
    <p className="fv-path">{status.folderPath || '未连接外部目录（可选）'}</p>
    <p>{status.state === 'indexing' ? '正在整理索引，知识引用暂时停用。' : status.state === 'error' ? '索引整理失败，知识引用已停用。请检查提示并重新整理。' : status.indexedAt ? `当前可检索 ${status.documents} 份文档 · ${status.chunks} 段资料` : '审核启用本机资料，或连接已有笔记目录后建立索引。'}</p>
    {status.indexedAt && <small>上次整理完成：{displayTime(status.indexedAt)}{status.skipped ? ` · 跳过 ${status.skipped} 项` : ''}</small>}
    {status.warnings.length > 0 && <details className="fv-notes"><summary>查看 {status.warnings.length} 条整理提示</summary><ul>{status.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
  </div>;
}

export type SettingsSection = 'connections' | 'ai' | 'voice' | 'layout';

export interface SettingsViewProps {
  initialSection?: SettingsSection;
  navigationRevision?: number;
  design: WorkspaceDesign;
  onDesignChange: (design: WorkspaceDesign) => void;
  appearance: Appearance;
  onAppearanceChange: (appearance: Appearance) => void;
  layout: NavigationLayout;
  onLayoutChange: (layout: NavigationLayout) => void;
  wechat: WechatLiveSnapshot;
  wechatBusy: boolean;
  onStartWechat: () => void;
  onStopWechat: () => void;
  onSelectWechatRoot: () => void;
  onNotice: Notice;
  onSettingsChanged: (area: 'crm' | 'ai' | 'knowledge') => void;
  onOpenKnowledge: () => void;
}

export function SettingsView(props: SettingsViewProps) {
  const { onNotice, onSettingsChanged } = props;
  const [section, setSection] = useState<SettingsSection>(props.initialSection ?? 'connections');
  const [settings, setSettings] = useState<IntegrationSettingsPublic | null>(null);
  const [crm, setCrm] = useState<CrmSettings | null>(null);
  const [ai, setAi] = useState<AiSettings | null>(null);
  const [password, setPassword] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [challenge, setChallenge] = useState<Extract<CrmLoginResponse, { kind: 'verification-required' }> | null>(null);
  const [verificationCode, setVerificationCode] = useState('');
  const [voice, setVoice] = useState<OfflineVoiceStatus | null>(null);
  const [voiceError, setVoiceError] = useState('');
  const [confirmDownload, setConfirmDownload] = useState(false);
  const [audioText, setAudioText] = useState('');
  const [loadAttempt, setLoadAttempt] = useState(0);
  const action = useFeatureAction(onNotice);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = featureValue(await bridge().getIntegrationSettings());
        if (!cancelled) { setSettings(result); setCrm(editableCrmSettings(result.crm)); setAi(editableAiSettings(result.ai)); }
      } catch (failure) { if (!cancelled) action.setError(errorMessage(failure)); }
      try { const status = await bridge().getVoiceStatus(); if (!cancelled) { setVoice(status); setVoiceError(''); } }
      catch (failure) { if (!cancelled) setVoiceError(errorMessage(failure)); }
    })();
    return () => { cancelled = true; };
  }, [loadAttempt]);

  useEffect(() => {
    if (!(voice?.active || voice?.queued || voice?.state === 'downloading' || voice?.state === 'checking' || ['voice-download', 'voice-import', 'voice-test'].includes(action.busy))) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void bridge().getVoiceStatus().then((status) => { if (!cancelled) { setVoice(status); setVoiceError(''); } })
        .catch((failure) => { if (!cancelled) setVoiceError(errorMessage(failure)); });
    }, 1200);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [voice, action.busy]);

  useEffect(() => { setSection(props.initialSection ?? 'connections'); }, [props.initialSection, props.navigationRevision]);

  function acceptSettings(next: IntegrationSettingsPublic, area: 'crm' | 'ai' | 'knowledge') { setSettings(next); onSettingsChanged(area); }
  async function refreshSettings(area: 'crm' | 'ai' | 'knowledge') { acceptSettings(featureValue(await bridge().getIntegrationSettings()), area); }
  async function saveCrm() {
    if (!crm) throw new Error('配置尚未读取，请重试。');
    const next = featureValue(await bridge().updateIntegrationSettings({ crm: editableCrmSettings(crm) }));
    acceptSettings(next, 'crm');
    setCrm(editableCrmSettings(next.crm));
  }
  async function acceptLogin(result: CrmLoginResponse): Promise<string> {
    setPassword('');
    if (result.kind === 'verification-required') { setChallenge(result); return '请完成 CRM 新设备验证码验证。'; }
    setChallenge(null); setVerificationCode(''); await refreshSettings('crm'); return 'CRM 已连接，可读取当前账号有权限的客户资料。';
  }
  function changeProvider(provider: AiProvider) {
    if (!ai) return;
    setAi({ ...ai, provider, baseUrl: providerDefaults[provider].baseUrl, model: '', allowRemote: false });
    setApiKey('');
  }
  async function saveAi() {
    if (!ai) throw new Error('配置尚未读取，请重试。');
    const next = featureValue(await bridge().updateIntegrationSettings({ ai: { ...editableAiSettings(ai), ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) } }));
    setApiKey(''); setAi(editableAiSettings(next.ai)); acceptSettings(next, 'ai'); return '模型配置已保存；不会自动上传聊天内容。';
  }
  function acceptVoiceResult(result: VoiceModelActionResult): string | void {
    setVoice(result.status);
    if (!result.ok) { if (!result.cancelled) throw new Error(result.error); return; }
    return result.status.state === 'ready' ? '离线语音模型已就绪。' : result.status.detail;
  }
  const tabs = [['connections', '数据连接'], ['ai', '回复模型'], ['voice', '离线语音'], ['layout', '界面布局']] as const;

  return <div className="fv-page">
    <FeatureHeader title="设置">连接自己的资料与模型。微信和 CRM 只读接入，回复仍由你确认后复制发送。</FeatureHeader>
    <nav className="fv-tabs" aria-label="设置分类">{tabs.map(([id, label]) => <button key={id} aria-current={section === id ? 'page' : undefined} onClick={() => setSection(id)}>{label}</button>)}</nav>
    <FeatureError>{action.error}</FeatureError>
    {!settings && <div className="fv-empty" aria-busy={!action.error}><p>{action.error ? '未能读取本机配置。' : '正在读取本机配置…'}</p>{action.error && <Button onClick={() => { action.setError(''); setLoadAttempt((value) => value + 1); }}>重试</Button>}</div>}
    {settings?.notice && <p className="fv-warning">{settings.notice}</p>}
    {section === 'connections' && <div className="fv-sheet">
      <section className="fv-section"><div className="fv-section-heading"><h2>微信数据</h2><span>{props.wechat.status.monitoring ? '读取中' : '未在读取'}</span></div>
        <p className="fv-muted">{props.wechat.status.detail}</p>
        <div className="fv-actions"><Button disabled={props.wechatBusy} onClick={props.onSelectWechatRoot}>选择账号目录</Button>
          <Button appearance="primary" disabled={props.wechatBusy} onClick={props.wechat.status.monitoring ? props.onStopWechat : props.onStartWechat}>{props.wechatBusy ? '处理中…' : props.wechat.status.monitoring ? '停止读取' : '启动实时读取'}</Button></div>
      </section>
      {crm && settings && <section className="fv-section"><div className="fv-section-heading"><h2>CRM</h2><span>{settings.crm.hasSession ? '已登录' : '待连接'}</span></div>
        <p className="fv-muted">使用现有 CRM 账号登录。这里只读取资料、电话记录与跟进记录，不修改客户数据。</p>
        <form onSubmit={(event) => { event.preventDefault(); void action.run('crm-login', async () => { await saveCrm(); return acceptLogin(featureValue(await bridge().loginCrm({ username: crm.username, password, rememberSession: crm.rememberSession }))); }); }}>
          <fieldset className="fv-fields" disabled={Boolean(action.busy)}>
            <Field label="CRM 服务地址" help="填写你的 CRM 网站完整地址；修改地址后需要重新登录。"><input type="url" required value={crm.baseUrl} placeholder="https://你的 CRM 域名" onChange={(event) => { setCrm({ ...crm, baseUrl: event.target.value }); setChallenge(null); }} /></Field>
            <Field label="账号"><input autoComplete="username" required value={crm.username} onChange={(event) => { setCrm({ ...crm, username: event.target.value }); setChallenge(null); }} /></Field>
            <Field label="登录密码" help="密码只用于本次登录，不会保存或导出。"><input type="password" required autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></Field>
            <div className="fv-field fv-check-group"><Check checked={crm.rememberSession && settings.secureStorageAvailable} disabled={!settings.secureStorageAvailable} onChange={(value) => setCrm({ ...crm, rememberSession: value })}>在本机加密记住登录状态</Check>
              {!settings.secureStorageAvailable && <small>系统安全存储不可用，仅在本次启动中保留登录状态。</small>}</div>
          </fieldset>
          <Check checked={crm.allowInsecureHttp} disabled={Boolean(action.busy)} onChange={(value) => setCrm({ ...crm, allowInsecureHttp: value })}>我理解 HTTP 会明文传输登录信息，仍允许使用非 HTTPS 的 CRM</Check>
          <div className="fv-actions"><Button appearance="primary" type="submit" disabled={Boolean(action.busy)}>{action.busy === 'crm-login' ? '正在连接…' : '登录 CRM'}</Button>
            <Button disabled={Boolean(action.busy)} onClick={() => void action.run('crm-save', async () => { await saveCrm(); setPassword(''); return 'CRM 配置已保存。'; })}>仅保存配置</Button>
            <Button disabled={Boolean(action.busy) || !settings.crm.hasSession} onClick={() => void action.run('crm-test', async () => { await bridge().testCrm().then(featureValue); return 'CRM 连接测试成功。'; })}>测试已保存的连接</Button>
            {settings.crm.hasSession && <Button className="fv-subtle-action" disabled={Boolean(action.busy)} onClick={() => void action.run('crm-disconnect', async () => { acceptSettings(featureValue(await bridge().disconnectCrm()), 'crm'); setPassword(''); setChallenge(null); return '已断开本软件的 CRM 连接，不影响 CRM 网站。'; })}>断开连接</Button>}
          </div>
        </form>
        {challenge && <form className="fv-verification" onSubmit={(event) => { event.preventDefault(); void action.run('crm-verify', async () => acceptLogin(featureValue(await bridge().verifyCrmDevice(challenge.challengeId, verificationCode.trim())))); }}>
          <p>CRM 要求验证新设备。请从 CRM 的验证渠道获取验证码。有效期至 {displayTime(challenge.expiresAt)}。</p>
          <div className="fv-inline-form"><Field label="设备验证码（6 位数字）"><input required pattern="[0-9]{6}" maxLength={6} inputMode="numeric" autoComplete="one-time-code" value={verificationCode} onChange={(event) => setVerificationCode(event.target.value)} /></Field><Button type="submit" appearance="primary" disabled={Boolean(action.busy)}>验证并连接</Button></div>
        </form>}
      </section>}
      {settings?.knowledge.source === 'cloud' ? <section className="fv-section"><h2>公司云端知识库</h2><KnowledgeStatus status={settings.knowledge} /><p className="fv-muted">登录公司 CRM 后自动连接，无需填写地址或密钥。知识由公司统一发布，不使用本机旧资料。</p><Button appearance="primary" onClick={props.onOpenKnowledge}>查看与检索知识</Button></section> : settings && <section className="fv-section"><div className="fv-section-heading"><h2>知识库</h2><span>{settings.knowledge.state === 'error' ? '需检查' : settings.knowledge.state === 'indexing' ? '整理中' : settings.knowledge.indexedAt ? '本机索引' : '待导入'}</span></div>
        <KnowledgeStatus status={settings.knowledge} /><p className="fv-muted">新资料先进入本机待审核列表，启用后再用于回复。也可继续连接已有 Markdown / TXT 或 Obsidian 目录；客户私人资料不自动入库。</p>
        <div className="fv-actions"><Button appearance="primary" onClick={props.onOpenKnowledge}>导入、审核与检索</Button><Button disabled={Boolean(action.busy)} onClick={() => void action.run('knowledge-import', async () => { const status = featureValue(await bridge().selectKnowledgeFolder()); acceptSettings({ ...settings, knowledge: status }, 'knowledge'); return `已整理 ${status.documents} 份知识文档，请核对整理提示。`; })}>连接已有笔记目录</Button></div>
      </section>}
    </div>}
    {section === 'ai' && settings && ai && <div className="fv-sheet"><section className="fv-section">
      <div className="fv-section-heading"><h2>回复模型与 API</h2><span>{settings.ai.model ? '已有配置' : '待配置'}</span></div>
      <p className="fv-muted">模型帮助组织表达；回复依据来自当前会话、已关联的 CRM 资料和你的知识库。保存配置不代表授权上传聊天。</p>
      <form onSubmit={(event) => { event.preventDefault(); void action.run('ai-save', saveAi); }}>
        <fieldset className="fv-fields" disabled={Boolean(action.busy)}>
          <Field label="服务类型"><select value={ai.provider} onChange={(event) => changeProvider(event.target.value as AiProvider)}>{Object.entries(providerDefaults).map(([id, value]) => <option key={id} value={id}>{value.label}</option>)}</select></Field>
          <Field label="API 地址" help="兼容服务需提供 Chat Completions 接口；本机 Ollama 默认使用 11434 端口。"><input type="url" required value={ai.baseUrl} onChange={(event) => setAi({ ...ai, baseUrl: event.target.value })} /></Field>
          <Field label="模型名称" help="填写服务商实际开放或本机已安装的模型 ID。"><input required value={ai.model} onChange={(event) => setAi({ ...ai, model: event.target.value })} placeholder="填写模型 ID" spellCheck={false} /></Field>
          <Field label="API 密钥" help={settings.ai.hasApiKey ? '已保存密钥，留空不替换；更换服务类型或地址会清除旧密钥。' : '本机 Ollama 通常不需要密钥；远程服务按服务商要求填写。'}><input type="password" autoComplete="off" value={apiKey} placeholder={settings.ai.hasApiKey ? '已保存 · 不显示原密钥' : '按需填写'} onChange={(event) => setApiKey(event.target.value)} spellCheck={false} /></Field>
        </fieldset>
        <Check checked={ai.rememberKey && settings.secureStorageAvailable} disabled={!settings.secureStorageAvailable || Boolean(action.busy)} onChange={(value) => setAi({ ...ai, rememberKey: value })}>在本机加密保存 API 密钥</Check>
        <Check checked={ai.allowRemote} disabled={Boolean(action.busy)} onChange={(value) => setAi({ ...ai, allowRemote: value })}>允许使用远程模型；每次发送客户上下文前，仍需我核对并确认</Check>
        <p className="fv-warning">远程服务可能计费。测试只发送固定测试内容，不发送客户聊天；本机模型不需要开放远程选项。</p>
        <div className="fv-actions"><Button appearance="primary" type="submit" disabled={Boolean(action.busy)}>{action.busy === 'ai-save' ? '正在保存…' : '保存模型配置'}</Button>
          <Button disabled={Boolean(action.busy) || !settings.ai.model} onClick={() => void action.run('ai-test', async () => { const result = featureValue(await bridge().testAi()); return `模型连接成功：${result.model}。${result.detail}`; })}>{action.busy === 'ai-test' ? '正在测试…' : '测试已保存的配置'}</Button>
          {settings.ai.hasApiKey && <Button disabled={Boolean(action.busy)} onClick={() => void action.run('ai-clear-key', async () => { acceptSettings(featureValue(await bridge().updateIntegrationSettings({ ai: { clearApiKey: true } })), 'ai'); setApiKey(''); return '已清除本机保存的模型密钥。'; })}>清除已保存密钥</Button>}
        </div>
      </form>
    </section></div>}
    {section === 'voice' && <div className="fv-sheet"><section className="fv-section">
      <div className="fv-section-heading"><h2>离线语音转文字</h2><span>{voice?.state === 'ready' ? '模型已就绪' : 'SenseVoice'}</span></div>
      <p className="fv-muted">先下载或导入模型，再在聊天语音旁点击“转文字”。语音在这台电脑上处理，校对确认后的文字才用于回复和导出。</p>
      <FeatureError>{voiceError}</FeatureError>
      <p role="status">{voice?.detail || '正在检查本机模型…'}</p>
      {voice && (voice.state === 'downloading' || voice.state === 'checking') && <div className="fv-progress"><progress aria-label="离线模型下载进度" {...(voice.totalBytes > 0 ? { value: voice.downloadedBytes, max: voice.totalBytes } : {})} /><small>{(voice.downloadedBytes / 1024 / 1024).toFixed(1)} MB{voice.totalBytes ? ` / ${(voice.totalBytes / 1024 / 1024).toFixed(1)} MB` : ''}</small></div>}
      {voice && (voice.active || voice.queued > 0) && <p className="fv-warning">{voice.active ? '正在本机转写' : '等待转写'} · 排队 {voice.queued} 项。可以继续处理其他会话。</p>}
      <div className="fv-actions">
        <Button appearance="primary" disabled={Boolean(action.busy) || voice?.state === 'downloading' || voice?.state === 'ready'} onClick={() => setConfirmDownload(true)}>下载离线模型（约 240 MB）</Button>
        <Button disabled={Boolean(action.busy) || voice?.state === 'downloading'} onClick={() => void action.run('voice-import', async () => acceptVoiceResult(await bridge().importVoiceModel()))}>导入已有模型</Button>
        <Button onClick={() => void action.run('voice-check', async () => { setVoice(await bridge().getVoiceStatus()); setVoiceError(''); })} disabled={Boolean(action.busy)}>重新检查</Button>
        {(voice?.state === 'downloading' || action.busy === 'voice-download') && <Button onClick={() => void bridge().cancelVoiceModelDownload().catch((failure) => setVoiceError(errorMessage(failure)))}>取消下载</Button>}
      </div>
      <p className="fv-muted">下载需要网络与约 240 MB 空间。模型使用条款：<a href="https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE" target="_blank" rel="noreferrer">FunASR 模型许可</a>；程序组件许可随安装包提供。</p>
    </section><section className="fv-section"><h2>用本机音频测试</h2><p className="fv-muted">选择一个音频文件，检查本机识别效果。测试文字不会自动加入客户资料。</p>
      <div className="fv-actions"><Button disabled={Boolean(action.busy) || voice?.state !== 'ready'} onClick={() => void action.run('voice-test', async () => { setAudioText(''); const result = await bridge().transcribeAudioFile(); if (!result.ok) { if (result.reason === 'cancelled') return; throw new Error(result.error); } setAudioText(result.text); })}>{action.busy === 'voice-test' ? '本机转写中…' : '选择音频并转写'}</Button>
        {(action.busy === 'voice-test' || voice?.active) && <Button onClick={() => void bridge().cancelVoiceTranscription().catch((failure) => setVoiceError(errorMessage(failure)))}>停止当前转写</Button>}</div>
      {audioText && <Field label="测试识别结果 · 请自行校对"><textarea readOnly rows={6} value={audioText} /></Field>}
    </section></div>}
    {section === 'layout' && <AppearanceSettings design={props.design} onDesignChange={props.onDesignChange} appearance={props.appearance} onAppearanceChange={props.onAppearanceChange} layout={props.layout} onLayoutChange={props.onLayoutChange} />}
    <ConfirmDialog open={confirmDownload} title="下载离线语音模型" confirm="确认下载" onClose={() => setConfirmDownload(false)} onConfirm={() => { setConfirmDownload(false); void action.run('voice-download', async () => { setVoiceError(''); return acceptVoiceResult(await bridge().downloadVoiceModel()); }); }}>
      <p>将从模型发布源下载约 240 MB 的 SenseVoice 模型。下载完成后，语音在本机处理，不上传音频。</p><p>请阅读 <a href="https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE" target="_blank" rel="noreferrer">模型使用许可</a>，确认符合你的使用场景。下载期间可取消。</p>
    </ConfirmDialog>
  </div>;
}

export function KnowledgeView({ active = true, onNotice, onSettingsChanged }: { active?: boolean; onNotice: Notice; onSettingsChanged: () => void }) {
  const [status, setStatus] = useState<KnowledgeIndexStatus | null>(null);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<KnowledgeHit[] | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const action = useFeatureAction(onNotice);
  const [view, setView] = useState<'inbox' | 'search'>('inbox');
  const managedChanged = useCallback(() => { setHits(null); setLoadAttempt((value) => value + 1); onSettingsChanged(); }, [onSettingsChanged]);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void (async () => {
      try { const settings = featureValue(await bridge().getIntegrationSettings()); if (!cancelled) { setStatus(settings.knowledge); setHits(null); } }
      catch (failure) { if (!cancelled) action.setError(errorMessage(failure)); }
    })();
    return () => { cancelled = true; };
  }, [loadAttempt, active]);

  function accepted(next: KnowledgeIndexStatus) { setStatus(next); setHits(null); onSettingsChanged(); }
  if (status?.source === 'cloud') return <div className="fv-page">
    <FeatureHeader title="公司云端知识库">统一发布、自动接入。检索只发送当前问题，不上传整份聊天或 CRM 资料。</FeatureHeader>
    <FeatureError>{action.error}</FeatureError>
    <div className="fv-sheet"><section className="fv-section"><h2>连接与版本</h2><KnowledgeStatus status={status} />
      <Button disabled={Boolean(action.busy)} icon={<ArrowSync20Regular />} onClick={() => void action.run('cloud-refresh', async () => { accepted(featureValue(await bridge().reindexKnowledge())); })}>{action.busy === 'cloud-refresh' ? '连接中…' : '刷新连接'}</Button>
      <p className="fv-muted">登录公司 CRM 后自动验证访问权限。云端不可用时停止知识引用，不会切换到本地旧规则。</p>
    </section><section className="fv-section"><h2>查找业务知识</h2>
      <form className="fv-search-form" onSubmit={event => { event.preventDefault(); setHits(null); void action.run('cloud-search', async () => { setHits(featureValue(await bridge().searchKnowledge(query.trim()))); const next = featureValue(await bridge().getIntegrationSettings()); setStatus(next.knowledge); }); }}>
        <Field label="问题或关键词"><input required maxLength={600} type="search" value={query} onChange={event => { setQuery(event.target.value); setHits(null); }} placeholder="例如：服务费、尽调退款、拍中尾款" /></Field>
        <Button type="submit" appearance="primary" disabled={Boolean(action.busy) || !query.trim()}>{action.busy === 'cloud-search' ? '检索中…' : '检索'}</Button>
      </form>
      {hits?.length === 0 && <p>没有找到相关依据，请更换关键词；不会编造公司规则。</p>}
      <div className="fv-knowledge-hits">{hits?.map(hit => <article className="fv-knowledge-hit" key={hit.id}><h3>{hit.title}</h3><small>{hit.sourcePath}</small><p>{hit.text}</p></article>)}</div>
    </section></div>
  </div>;
  return <div className="fv-page">
    <FeatureHeader title="知识库">把已核对的流程、案例复盘与培训资料，整理成有来源、可停用的回复依据。</FeatureHeader>
    <nav className="fv-tabs" aria-label="知识库功能"><button aria-current={view === 'inbox' ? 'page' : undefined} onClick={() => setView('inbox')}>资料审核</button><button aria-current={view === 'search' ? 'page' : undefined} onClick={() => setView('search')}>目录与检索</button></nav>
    <FeatureError>{action.error}</FeatureError>
    {(status?.state === 'error' || status?.state === 'indexing') && <div className="fv-warning" role={status.state === 'error' ? 'alert' : 'status'}><p>{status.state === 'error' ? '索引未完成，知识引用暂不可用。资料仍保留，请到“目录与检索”查看提示并重新整理。' : '正在整理索引，知识引用暂时停用。'}</p></div>}
    <section hidden={view !== 'inbox'}><KnowledgeWorkspaceView active={active && view === 'inbox'} onNotice={onNotice} onChanged={managedChanged} onOpenSearch={() => setView('search')} /></section>
    <div className="fv-sheet" hidden={view !== 'search'}><section className="fv-section"><div className="fv-section-heading"><h2>检索来源</h2><span>本机已启用资料 + 已有笔记目录</span></div>
      {status ? <KnowledgeStatus status={status} /> : <p>{action.error ? '未能读取知识库状态，请重试。' : '正在读取知识库状态…'}</p>}
      <div className="fv-actions"><Button icon={<FolderOpen20Regular />} disabled={Boolean(action.busy)} onClick={() => void action.run('knowledge-folder', async () => { accepted(featureValue(await bridge().selectKnowledgeFolder())); return '外部目录已接入，请核对整理提示。'; })}>{action.busy === 'knowledge-folder' ? '正在整理…' : '连接已有笔记目录'}</Button>
        <Button appearance="primary" icon={<ArrowSync20Regular />} disabled={Boolean(action.busy) || !status} onClick={() => void action.run('knowledge-reindex', async () => { accepted(featureValue(await bridge().reindexKnowledge())); return '已重新整理可用资料。'; })}>{action.busy === 'knowledge-reindex' ? '正在整理…' : '重新整理'}</Button>
        {status?.folderPath && <Button disabled={Boolean(action.busy)} onClick={() => setConfirmClear(true)}>移除外部目录索引</Button>}
        {!status && action.error && <Button onClick={() => { action.setError(''); setLoadAttempt((value) => value + 1); }}>重新读取状态</Button>}
      </div>
      <p className="fv-muted">本机资料保存与审核后自动更新索引。外部目录只读接入 .md / .txt，包括 Obsidian；修改外部笔记后点击“重新整理”。PDF、Word、图片和录音需先整理成文字，本次不会自动识别。</p>
      <details className="fv-notes"><summary>哪些资料会用于回复？</summary><p>目前使用本地关键词检索，不是向量检索，也不会自动同步文件夹。检索命中只代表找到了文字片段，仍需核对条件和适用范围。</p>
        <p>笔记开头的元数据可写 status: approved（已确认可用）；draft、disabled、archived 会跳过。expiry: YYYY-MM-DD 表示有效至该日北京时间结束。控制字段不合法或已经过期的资料也会跳过。</p>
        <p>未标状态的外部旧资料为兼容仍可检索，不代表已经审核。本机副本的停用不会影响外部同名文件；如需严格逐份审核，请移除外部目录索引，再通过“资料审核”导入副本。客户私有聊天和 CRM 记录请与公司通用知识分开，案例先脱敏再入库。</p></details>
    </section><section className="fv-section"><h2>试着查找一条知识</h2>
      <form className="fv-search-form" onSubmit={(event) => { event.preventDefault(); if (!query.trim()) { action.setError('请填写要查找的问题或关键词。'); return; } setHits(null); void action.run('knowledge-search', async () => setHits(featureValue(await bridge().searchKnowledge(query.trim())))); }}>
        <Field label="问题或关键词"><input type="search" required disabled={Boolean(action.busy)} value={query} onChange={(event) => { setQuery(event.target.value); setHits(null); }} placeholder="例如：到访流程、客户顾虑、服务费用" /></Field><Button appearance="primary" type="submit" icon={<Search20Regular />} disabled={Boolean(action.busy) || !status?.documents}>{action.busy === 'knowledge-search' ? '检索中…' : '检索'}</Button>
      </form>
      {hits === null ? <p className="fv-muted">{status?.documents ? '检索结果显示来源与原文片段，便于核对回复引用；不会调用模型或上传资料。' : '请先审核启用本机资料，或连接已有 Markdown / TXT 目录。'}</p> : hits.length === 0 ? <div className="fv-empty"><p>没有找到相关片段。</p><small>试试更短的关键词，或检查资料是否已启用且未过期。</small></div> : <div className="fv-knowledge-hits"><p className="fv-muted">找到 {hits.length} 段相关资料</p>{hits.map((hit) => <article key={hit.id} className="fv-knowledge-hit"><h3>{hit.title}</h3><small className="fv-path">{hit.sourcePath}</small><p>{hit.text}</p></article>)}</div>}
    </section></div>
    <ConfirmDialog open={confirmClear} title="移除外部目录索引？" confirm="移除外部目录" destructive onClose={() => setConfirmClear(false)} onConfirm={() => { setConfirmClear(false); void action.run('knowledge-clear', async () => { accepted(featureValue(await bridge().clearKnowledge()).knowledge); return '已移除外部目录索引；本机资料与原始笔记均保留。'; }); }}><p>外部目录中的资料将不再参与检索，原文件不会删除。本机资料不受影响，已启用且未过期的本机资料仍可使用。</p></ConfirmDialog>
  </div>;
}

function CrmRecords({ records, kind, allowed }: { records: unknown[]; kind: 'followup' | 'call'; allowed: boolean }) {
  const [visible, setVisible] = useState(20);
  if (!allowed) return <p className="fv-warning">当前 CRM 账号无权读取这些记录，不能据此推断“没有记录”。</p>;
  if (!records.length) return <p className="fv-muted">CRM 暂无{kind === 'followup' ? '跟进' : '电话'}记录。</p>;
  return <><ol className="fv-records">{records.slice(0, visible).map((record, index) => {
    const { id, stamp, author, text, transcript, detail } = crmRecordParts(record, kind);
    return <li key={`${id || index}-${stamp}`}><div className="fv-record-meta"><time>{stamp || '未记录时间'}</time>{author && <span>{author}</span>}</div>{detail && <small>{detail}</small>}<p>{text || '本条记录没有文字备注。'}</p>{transcript && transcript !== text && <details><summary>查看通话转写</summary><p>{transcript}</p></details>}</li>;
  })}</ol>{records.length > visible && <Button onClick={() => setVisible((value) => value + 40)}>继续显示（还有 {records.length - visible} 条）</Button>}</>;
}

export function CrmContextDetails({ context }: { context: CrmCustomerContext }) {
  const profile = crmProfileRows(context.customer);
  const customerId = fieldText(context.customer, 'id');
  return <div className="fv-crm-context">
    <div className="fv-section-heading"><h2>{fieldText(context.customer, 'name') || 'CRM 客户资料'}</h2><span>只读</span></div>
    <dl className="fv-profile">{profile.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    {!profile.length && <p className="fv-muted">该客户暂未填写可显示的基础信息。</p>}
    <h3>跟进记录{context.availability.followups === 'available' ? `（${context.followups.length}）` : ''}</h3><CrmRecords key={`followup-${customerId}`} kind="followup" records={context.followups} allowed={context.availability.followups === 'available'} />
    <h3>电话记录{context.availability.calls === 'available' ? `（${context.calls.length}）` : ''}</h3><CrmRecords key={`call-${customerId}`} kind="call" records={context.calls} allowed={context.availability.calls === 'available'} />
    <p className="fv-muted fv-source-time">读取于 {displayTime(context.fetchedAt)} · {context.sourceBaseUrl}</p>
  </div>;
}

export function CrmCustomersView({ onNotice, onOpenSettings }: { onNotice: Notice; onOpenSettings: () => void }) {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [query, setQuery] = useState('');
  const [customers, setCustomers] = useState<CrmCustomerCandidate[] | null>(null);
  const [visible, setVisible] = useState(40);
  const [selected, setSelected] = useState<number | null>(null);
  const [context, setContext] = useState<CrmCustomerContext | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [detailError, setDetailError] = useState('');
  const detailGeneration = useRef(0);
  const action = useFeatureAction(onNotice);
  useEffect(() => {
    let cancelled = false;
    void bridge().getIntegrationSettings().then(featureValue).then((result) => { if (!cancelled) setConnected(result.crm.hasSession); }).catch((failure) => { if (!cancelled) action.setError(errorMessage(failure)); });
    return () => { cancelled = true; detailGeneration.current += 1; };
  }, []);

  async function selectCustomer(customer: CrmCustomerCandidate) {
    const generation = ++detailGeneration.current;
    setSelected(customer.id); setContext(null); setDetailBusy(true); setDetailError('');
    try { const result = featureValue(await bridge().getCrmCustomerContext(customer.id)); if (generation === detailGeneration.current) setContext(result); }
    catch (failure) { if (generation === detailGeneration.current) setDetailError(errorMessage(failure)); }
    finally { if (generation === detailGeneration.current) setDetailBusy(false); }
  }
  return <div className="fv-page">
    <FeatureHeader title="CRM 客户资料">回看客户需求、首通电话和后续跟进。需要关联微信时，请到会话右侧选择对应客户。</FeatureHeader>
    <FeatureError>{action.error}</FeatureError>
    {connected === false ? <div className="fv-empty"><h2>先连接你的 CRM</h2><p>登录后只显示该账号有权限读取的客户，不会载入演示资料。</p><Button appearance="primary" onClick={onOpenSettings}>前往设置</Button></div> : <div className="fv-sheet">
      <form className="fv-search-form fv-crm-search" onSubmit={(event) => { event.preventDefault(); void action.run('crm-search', async () => { detailGeneration.current += 1; setSelected(null); setContext(null); setDetailBusy(false); setDetailError(''); setVisible(40); setCustomers(featureValue(await bridge().searchCrmCustomers(query.trim()))); }); }}>
        <Field label="搜索客户"><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="输入客户姓名或电话号码" /></Field><Button appearance="primary" type="submit" disabled={Boolean(action.busy) || connected === null} icon={<Search20Regular />}>{action.busy ? '搜索中…' : '搜索'}</Button>
      </form>
      <div className="fv-crm-columns"><aside className="fv-crm-results" aria-label="CRM 搜索结果">
        {customers === null ? <p className="fv-muted">{connected === null ? '正在检查 CRM 连接…' : '输入姓名或电话后搜索；留空搜索当前账号可见的客户。'}</p> : customers.length === 0 ? <p className="fv-muted">没有找到可见的客户。试试完整电话，或检查 CRM 权限。</p> : <><p className="fv-muted">本次返回 {customers.length} 位客户</p>{customers.slice(0, visible).map((customer) => <button key={customer.id} className="fv-customer-result" aria-pressed={selected === customer.id} onClick={() => void selectCustomer(customer)}><span><strong>{customer.name}</strong>{customer.level && <small>{customer.level}</small>}</span><span>{customer.phone || '未填写电话'}</span>{customer.ownerName && <small>负责人：{customer.ownerName}</small>}</button>)}{customers.length > visible && <Button onClick={() => setVisible((value) => value + 40)}>显示更多客户</Button>}</>}
      </aside><section className="fv-crm-detail" aria-busy={detailBusy}>
        <FeatureError>{detailError}</FeatureError>
        {detailBusy ? <p className="fv-muted">正在读取客户资料与记录…</p> : context ? <CrmContextDetails context={context} /> : <div className="fv-empty"><p>选择左侧客户，查看 CRM 记录。</p>{detailError && <Button onClick={onOpenSettings}>检查连接与权限</Button>}</div>}
      </section></div>
    </div>}
  </div>;
}

export interface CrmBindingDialogProps {
  scope: WechatFeatureScope;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onBound: (binding: ConversationCrmBinding | null) => void;
  onNotice: Notice;
}

export function CrmBindingDialog({ scope, open, onOpenChange, onBound, onNotice }: CrmBindingDialogProps) {
  const [query, setQuery] = useState('');
  const [customers, setCustomers] = useState<CrmCustomerCandidate[] | null>(null);
  const [selected, setSelected] = useState<CrmCustomerCandidate | null>(null);
  const [current, setCurrent] = useState<ConversationCrmBinding | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [visible, setVisible] = useState(30);
  const generation = useRef(0);
  const busyRef = useRef(false);
  useEffect(() => {
    const ticket = ++generation.current;
    setQuery(''); setCustomers(null); setSelected(null); setCurrent(null); setError(''); setVisible(30);
    if (open) {
      setBusy('loading'); busyRef.current = true;
      void bridge().getConversationCrmBinding(scope).then(featureValue).then((binding) => { if (generation.current === ticket) setCurrent(binding); })
        .catch((failure) => { if (generation.current === ticket) setError(errorMessage(failure)); })
        .finally(() => { if (generation.current === ticket) { setBusy(''); busyRef.current = false; } });
    }
    return () => { generation.current += 1; busyRef.current = false; };
  }, [open, scope.accountKey, scope.contactKey]);

  async function run(name: string, operation: (ticket: number) => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    const ticket = generation.current;
    setBusy(name); setError('');
    try { await operation(ticket); }
    catch (failure) { if (generation.current === ticket) setError(errorMessage(failure)); }
    finally { if (generation.current === ticket) { setBusy(''); busyRef.current = false; } }
  }
  async function bind(customerId: number | null, ticket: number) {
    const value = featureValue(await bridge().setConversationCrmBinding(scope, customerId));
    if (generation.current !== ticket) return;
    onBound(value); onNotice(value ? `已关联 CRM 客户：${value.customerName}` : '已取消关联，CRM 资料没有修改。', 'success'); onOpenChange(false);
  }
  return <Dialog open={open} onOpenChange={(_, data) => onOpenChange(data.open)}>
    <DialogSurface className="fv-dialog fv-binding-dialog"><DialogBody>
      <DialogTitle action={<Button appearance="subtle" icon={<Dismiss20Regular />} aria-label="关闭客户关联" onClick={() => onOpenChange(false)} />}>关联 CRM 客户</DialogTitle>
      <DialogContent><p className="fv-muted">请用姓名或电话找到对应的客户，并核对后确认。不会按微信昵称自动关联，避免把别人的记录混入回复。</p>
        {current && <p className="fv-current-binding">当前关联：<strong>{current.customerName}</strong></p>}
        <FeatureError>{error}</FeatureError>
        <form className="fv-search-form" onSubmit={(event) => { event.preventDefault(); if (!query.trim()) { setError('请填写 CRM 客户姓名或电话。'); return; } void run('search', async (ticket) => { const found = featureValue(await bridge().searchCrmCustomers(query.trim())); if (generation.current === ticket) { setCustomers(found); setSelected(null); setVisible(30); } }); }}>
          <Field label="CRM 客户姓名或电话"><input type="search" required value={query} onChange={(event) => setQuery(event.target.value)} /></Field><Button type="submit" disabled={Boolean(busy)}>{busy === 'search' ? '搜索中…' : '搜索'}</Button>
        </form>
        {customers?.length === 0 && <p className="fv-muted">未找到客户，请检查电话和 CRM 账号的可见范围。</p>}
        {customers && customers.length > 0 && <fieldset className="fv-binding-results"><legend>选择要关联的客户</legend>{customers.slice(0, visible).map((customer) => <label key={customer.id}><input type="radio" name="crm-binding-customer" checked={selected?.id === customer.id} disabled={Boolean(busy)} onChange={() => setSelected(customer)} /><span><strong>{customer.name}</strong><small>{customer.phone || '未填写电话'}{customer.ownerName ? ` · 负责人：${customer.ownerName}` : ''}</small></span></label>)}{customers.length > visible && <Button onClick={() => setVisible((value) => value + 30)}>显示更多结果</Button>}</fieldset>}
        {selected && <p className="fv-warning">确认将此微信会话关联到 {selected.name}（{selected.phone || '未填写电话'}）。之后生成建议与导出档案可使用该客户的 CRM 记录。</p>}
      </DialogContent>
      <DialogActions>{current && <Button disabled={Boolean(busy)} onClick={() => void run('unbind', (ticket) => bind(null, ticket))}>取消当前关联</Button>}<Button onClick={() => onOpenChange(false)}>返回</Button><Button appearance="primary" disabled={!selected || Boolean(busy)} onClick={() => { if (selected) void run('bind', (ticket) => bind(selected.id, ticket)); }}>{busy === 'bind' ? '正在关联…' : '确认关联'}</Button></DialogActions>
    </DialogBody></DialogSurface>
  </Dialog>;
}

const exportPhaseLabels = { reading: '正在读取聊天记录', media: '正在整理媒体', transcribing: '正在整理转写', writing: '正在写入档案', compressing: '正在打包 ZIP', complete: '档案已生成' } as const;
const exportFormatOptions: Array<{ value: ConversationExportFormat; label: string }> = [
  { value: 'html', label: 'HTML · 网页聊天档案' },
  { value: 'markdown', label: 'Markdown · 知识整理' },
  { value: 'csv', label: 'CSV · 表格' },
  { value: 'json', label: 'JSON · 结构化数据' },
  { value: 'txt', label: 'TXT · 纯文字' },
];

const exportPanelDefaults = { list: 340 };

function ExportColumns({ children }: { children: ReactNode }) {
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1000);
  const { sizes, setSizes, commit, reset } = useSavedPanelSizes('lingxu.export-panels.v1', exportPanelDefaults);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const measure = () => { if (element.clientWidth > 0) setWidth(element.clientWidth); };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const scale = Math.min(1, width / 600);
  const min = Math.floor(260 * scale);
  const max = Math.max(min, Math.min(640, width - Math.floor(340 * scale)));
  const list = clampPanelSize(sizes.list, min, max);
  return <div ref={container} className="fv-sheet fv-export-columns feature-resizable-columns" style={{ '--feature-list-size': `${list}px` } as CSSProperties}>
    {children}
    <PanelResizeHandle axis="x" label="调整导出会话列表宽度" value={list} min={min} max={max}
      onChange={(value) => setSizes({ list: value })} onCommit={(value) => commit({ list: value })} onReset={reset} style={{ left: list }} />
  </div>;
}

export function ExportView({ snapshot, initialContactKey, navigationRevision, hiddenContactKeys = [], onNotice }: { snapshot: WechatLiveSnapshot; initialContactKey?: string; navigationRevision?: number; hiddenContactKeys?: readonly string[]; onNotice: Notice }) {
  const initialConversationKind: 'contact' | 'group' = snapshot.conversations.find((item) => item.contactKey === initialContactKey)?.kind === 'group' ? 'group' : 'contact';
  const navigationToken = `${navigationRevision ?? 0}:${initialContactKey ?? ''}`;
  const [selectedKeys, setSelectedKeys] = useState<string[]>(initialContactKey ? [initialContactKey] : []);
  const [conversationKind, setConversationKind] = useState<'contact' | 'group'>(initialConversationKind);
  const [query, setQuery] = useState('');
  const [task, setTask] = useState<ConversationExportTask | null>(null);
  const [pollError, setPollError] = useState('');
  const [pollAttempt, setPollAttempt] = useState(0);
  const [extraConversations, setExtraConversations] = useState<WechatLiveConversation[]>([]);
  const [extraCursor, setExtraCursor] = useState<string | null | undefined>(undefined);
  const [visible, setVisible] = useState(60);
  const [format, setFormat] = useState<ConversationExportFormat>('html');
  const appliedNavigation = useRef(navigationToken);
  const accountRef = useRef(snapshot.accountKey);
  accountRef.current = snapshot.accountKey;
  const noticeTask = useRef('');
  const action = useFeatureAction(onNotice);
  const conversations = useMemo(() => {
    const byKey = new Map(extraConversations.map((conversation) => [conversation.contactKey, conversation]));
    for (const conversation of snapshot.conversations) byKey.set(conversation.contactKey, conversation);
    return [...byKey.values()];
  }, [snapshot.conversations, extraConversations]);
  const hidden = useMemo(() => new Set(hiddenContactKeys), [hiddenContactKeys]);
  const exportableConversations = useMemo(() => conversations.filter((conversation) => isSalesWechatConversation(conversation) && !hidden.has(conversation.contactKey)), [conversations, hidden]);
  const exportableKeys = useMemo(() => new Set(exportableConversations.map((conversation) => conversation.contactKey)), [exportableConversations]);
  const selectedExportKeys = selectedKeys.filter((key) => exportableKeys.has(key));
  const matching = useMemo(() => exportableConversations.filter((conversation) => conversation.kind === conversationKind
    && `${conversation.displayName} ${conversation.remark || ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())), [exportableConversations, conversationKind, query]);
  const nextCursor = extraCursor === undefined ? snapshot.nextConversationCursor : extraCursor;
  const running = task?.state === 'running';
  const controlsBusy = Boolean(action.busy) || running;

  useEffect(() => {
    if (appliedNavigation.current === navigationToken || running) return;
    appliedNavigation.current = navigationToken;
    if (!initialContactKey) return;
    setSelectedKeys([initialContactKey]);
    setConversationKind(initialConversationKind);
  }, [navigationToken, running, initialContactKey, initialConversationKind]);

  useEffect(() => {
    if (!task || task.state !== 'running') return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const taskId = task.id;
    const accountKey = snapshot.accountKey;
    async function poll() {
      try {
        const value = featureValue(await bridge().getConversationExportTask(taskId));
        if (cancelled || accountKey !== accountRef.current) return;
        if (!value) { setPollError('本次导出任务已不可查询。若应用曾重启，请到所选目录检查档案，或重新导出。'); return; }
        setTask(value); setPollError('');
        if (value.state === 'running') timer = setTimeout(() => void poll(), 1200);
      } catch (failure) { if (!cancelled) setPollError(`进度暂时无法读取：${errorMessage(failure)}。任务不一定已停止，可重试读取进度。`); }
    }
    timer = setTimeout(() => void poll(), 600);
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [task?.id, task?.state, pollAttempt, snapshot.accountKey]);

  useEffect(() => {
    if (!task || task.state === 'running' || noticeTask.current === task.id) return;
    noticeTask.current = task.id;
    if (task.result?.ok) onNotice(`聊天档案已生成，共 ${task.result.messageCount} 条消息。请查看导出提示。`, 'success');
    else if (task.state === 'failed') onNotice(task.result && !task.result.ok ? task.result.error || '聊天导出失败，请查看任务提示。' : '聊天导出失败，请查看任务提示。', 'error');
  }, [task, onNotice]);

  function toggleContact(contactKey: string, checked: boolean) {
    if (!checked) { setSelectedKeys((keys) => keys.filter((key) => key !== contactKey)); return; }
    const limit = format === 'html' ? 5 : 1;
    if (selectedExportKeys.length >= limit) { action.setError(format === 'html' ? '一次最多导出 5 个会话，请先取消一项。' : '该文件格式每次只能导出 1 个会话；多个会话请使用 HTML。'); return; }
    setSelectedKeys((keys) => [...keys, contactKey]); action.setError('');
  }
  function changeFormat(next: ConversationExportFormat) {
    if (next !== 'html' && selectedExportKeys.length > 1) {
      action.setError('该文件格式每次只能导出 1 个会话；请先取消多余会话，或继续使用 HTML。');
      return;
    }
    setFormat(next); action.setError('');
  }
  async function startExport() {
    const accountKey = snapshot.accountKey;
    if (!accountKey) throw new Error('请先在设置中连接微信，再选择当前账号的会话。');
    const request = buildExportRequest(selectedExportKeys, format);
    const result = featureValue(await bridge().startConversationExport({ accountKey, request }));
    if (accountRef.current !== accountKey) return;
    setTask(result); setPollError('');
  }

  return <div className="fv-page">
    <FeatureHeader title="导出聊天档案">选择微信会话，即可导出完整时间范围内可读取的聊天资料。关联 CRM 不是前置条件。</FeatureHeader>
    <FeatureError>{action.error}</FeatureError>
    {!snapshot.accountKey && <p className="fv-warning">尚未连接微信账号。请先在设置中启动读取；不会使用示例聊天生成档案。</p>}
    <ExportColumns><section className="fv-export-selection"><h2>选择会话</h2>
      <div className="fv-export-kind-tabs" role="group" aria-label="会话类型"><button type="button" aria-pressed={conversationKind === 'contact'} onClick={() => { setConversationKind('contact'); setVisible(60); }}>单聊</button><button type="button" aria-pressed={conversationKind === 'group'} onClick={() => { setConversationKind('group'); setVisible(60); }}>群聊</button></div>
      <Field label="查找微信会话"><input type="search" value={query} onChange={(event) => { setQuery(event.target.value); setVisible(60); }} placeholder="搜索微信昵称或备注" /></Field>
      <p className="fv-muted">已选 {selectedExportKeys.length} / 5 个会话</p>
      {selectedExportKeys.length > 0 && <div className="fv-selected-chats" aria-label="已选会话">{selectedExportKeys.map((key) => <span key={key}>{conversations.find((conversation) => conversation.contactKey === key)?.displayName || '当前所选会话'}<button aria-label={`取消选择 ${conversations.find((conversation) => conversation.contactKey === key)?.displayName || '此会话'}`} disabled={controlsBusy} onClick={() => toggleContact(key, false)}><Dismiss20Regular /></button></span>)}</div>}
      <fieldset className="fv-export-chat-list" disabled={controlsBusy}><legend className="fv-sr-only">可导出的微信会话</legend>
        {matching.slice(0, visible).map((conversation) => <label key={conversation.contactKey}><input type="checkbox" checked={selectedKeys.includes(conversation.contactKey)} onChange={(event) => toggleContact(conversation.contactKey, event.target.checked)} /><PrivateImage mediaKey={conversation.avatarMediaKey} className="fv-export-avatar" alt={`${conversation.remark || conversation.displayName}的头像`} fallback={Array.from(conversation.remark || conversation.displayName)[0] || '聊'} /><span className="fv-export-chat-copy"><strong>{conversation.remark || conversation.displayName}</strong><small>{conversation.kind === 'group' ? '微信群聊' : '微信单聊'}{conversation.remark && conversation.remark !== conversation.displayName ? ` · 微信名：${conversation.displayName}` : ''}</small></span></label>)}
      </fieldset>
      {matching.length === 0 && <p className="fv-muted">{conversations.length ? '当前已加载的会话中没有匹配项。' : '当前没有可选择的微信会话。'}</p>}
      <div className="fv-actions">{matching.length > visible && <Button disabled={controlsBusy} onClick={() => setVisible((value) => value + 60)}>显示更多结果</Button>}
        {nextCursor && <Button disabled={controlsBusy} onClick={() => void action.run('load-chats', async () => { const result = await window.salesCopilot.getWechatConversations(nextCursor); if (!result.ok) throw new Error(result.error); if (result.snapshot.accountKey !== snapshot.accountKey) throw new Error('微信账号已变化，请重新选择会话。'); setExtraConversations((list) => [...list, ...result.snapshot.conversations]); setExtraCursor(result.snapshot.nextConversationCursor || null); })}>{action.busy === 'load-chats' ? '正在读取…' : '读取更多微信会话'}</Button>}</div>
    </section><section className="fv-export-options"><h2>导出设置</h2>
      <form onSubmit={(event) => { event.preventDefault(); void action.run('export-start', startExport); }}>
        <Field label="文件格式" help={format === 'html' ? '包含双方头像、本机可读取的附件，并同时生成 ZIP 备份包。' : '导出全部聊天文字与结构化资料；头像、附件文件和 ZIP 仅支持 HTML。'}><select value={format} disabled={controlsBusy} onChange={(event) => changeFormat(event.target.value as ConversationExportFormat)}>{exportFormatOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></Field>
        <div className="fv-export-summary"><strong>{format === 'html' ? '完整聊天档案' : '全部聊天文字与资料'}</strong><ul><li>全部日期与全部消息类型</li><li>{format === 'html' ? '双方头像及本机可读取的图片、表情、语音等附件' : '聊天文字及已人工确认的语音文字'}</li><li>{format === 'html' ? '可查看的 HTML 档案与 ZIP 备份包' : '不复制头像和附件文件；需要完整资料请选择 HTML'}</li></ul></div>
        <p className="fv-muted">如果会话已明确关联 CRM 且当前账号有导出权限，会自动附加客户资料、跟进和电话记录；没有关联也会正常导出微信聊天。</p>
        <p className="fv-warning">“完整”以当前电脑和微信数据库实际可读取的内容为准。未下载、缓存已清理、解密失败或暂不支持的附件会列入缺失清单，不会伪装成已导出。档案包含客户隐私，请妥善保存。</p>
        <div className="fv-actions"><Button type="submit" appearance="primary" icon={<ArrowDownload20Regular />} disabled={controlsBusy || !snapshot.accountKey || !selectedExportKeys.length}>{action.busy === 'export-start' ? '正在创建任务…' : running ? '导出进行中' : '选择保存位置并导出'}</Button></div>
      </form>
    </section></ExportColumns>
    {task && <section className="fv-export-task" aria-label="当前导出任务">
      <div className="fv-section-heading"><h2>{running ? exportPhaseLabels[task.progress?.phase || 'reading'] : task.state === 'complete' ? (task.result?.ok && task.result.completeness === 'partial' ? '部分导出完成，请核对缺失项' : '所选范围导出完成') : task.state === 'cancelled' ? '导出已取消' : '导出未完成'}</h2>{running && <Button disabled={action.busy === 'export-cancel'} onClick={() => void action.run('export-cancel', async () => { await bridge().cancelConversationExport(task.id); setPollAttempt((value) => value + 1); return '已请求停止导出，正在等待任务收尾。'; })}>取消导出</Button>}</div>
      {task.progress && <p role="status">会话 {task.progress.conversationsDone} / {task.progress.conversationCount} · 已读取 {task.progress.messagesRead} 条消息 · 已写入 {task.progress.messagesExported} 条 · 媒体 {task.progress.mediaSaved} 个{task.progress.mediaMissing > 0 ? ` · 缺失媒体 ${task.progress.mediaMissing} 个` : ''}</p>}
      {running && <p className="fv-muted">可以切换到其他页面，导出会继续；请保持软件开启。</p>}
      {pollError && <div className="fv-warning" role="alert"><p>{pollError}</p><Button onClick={() => { setPollError(''); setPollAttempt((value) => value + 1); }}>重试读取进度</Button></div>}
      {task.result?.ok && <><p>已保存 {task.result.messageCount} 条消息、{task.result.mediaCount} 个媒体文件。</p><p className="fv-path">{task.result.fileName}</p>{task.result.warnings.length > 0 && <details open className="fv-notes"><summary>请核对 {task.result.warnings.length} 条导出提示</summary><ul>{task.result.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}<Button icon={<FolderOpen20Regular />} appearance="primary" onClick={() => void action.run('export-open', async () => { featureValue(await bridge().openConversationExport(task.id)); })}>打开导出位置</Button></>}
      {task.result && !task.result.ok && <p className={task.result.cancelled ? 'fv-muted' : 'fv-warning'}>{task.result.cancelled ? '已取消任务。原始微信数据和已有档案未修改。' : task.result.error || '任务失败，请检查连接与保存目录后重试。'}</p>}
    </section>}
  </div>;
}
