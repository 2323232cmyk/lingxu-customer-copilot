import { createHash, randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type { WechatLiveDelta, WechatLiveMessage, WechatLiveSnapshot, WechatMediaResult } from '../../shared/contracts';
import type { ConversationCrmBinding, ConversationExportTask, ConversationReplyPreview, FeatureBridge, FeatureResult, WechatFeatureScope } from '../../shared/feature-bridge-contracts';
import type { AiDraftPreview, AiDraftResponse, CrmCustomerContext } from '../../shared/integration-contracts';
import type { ConversationExportRequest, ExportMessage } from '../../shared/export-contracts';
import type { VoiceTranscriptionResult } from '../../shared/voice-contracts';
import { ConversationBindings } from './conversation-bindings';
import { exportConversationArchive, normalizeCrmExportContext, validateConversationExportRequest, type ExportArchiveInput, type ExportArchiveResult, type ExportConversationSource } from './conversation-export';
import { crmCustomerListInput, crmTaskQueryInput, isRecord, loginInput, mediaAlias, opaqueKey, positiveId, publicFeatureError, scopeInput, searchInput, settingsInput, taskId } from './feature-input';
import { IntegrationService } from './integration-service';
import { prepareAiContext } from './ai-replies';
import { OfflineTranscriptionService } from './offline-transcription';
import { LocalPlanStore } from './local-plan-store';
import type { LocalPlanCreateInput, LocalPlanDeleteInput, LocalPlanUpdateInput } from '../../shared/local-plan-contracts';
import { deriveReplyPolicy, type ReplyPolicyMessage } from '../../shared/reply-policy';
import { KNOWLEDGE_IMPORT_MAX_FILES, type KnowledgeDocumentSaveInput, type KnowledgeDocumentStatusInput, type KnowledgeDraftInput } from '../../shared/knowledge-workspace-contracts';

export interface FeatureLiveSource {
  snapshot(): WechatLiveSnapshot;
  messagesSnapshot(contactKey: string, limit?: number): Promise<WechatLiveMessage[]>;
  mediaForRenderer(key: unknown): Promise<WechatMediaResult>;
  readVoice(alias: string, options?: { signal?: AbortSignal }): Promise<{ bytes: Buffer; format: 'silk' | 'wav' } | undefined>;
  exportMessages(contactKey: string, options?: { from?: string; to?: string; signal?: AbortSignal }): AsyncIterable<WechatLiveMessage[]>;
}

type DialogKind = 'knowledge' | 'voice-model' | 'audio' | 'export' | 'previous-export';
interface StoredPreview { preview: ConversationReplyPreview; fingerprint: string; configEpoch: number; scopeEpoch: number; knowledgeEpoch?: number; customerId?: number }
interface Transcript { scope: WechatFeatureScope; voiceMediaKey: string; messageId: string; text: string; confirmed: boolean }
interface ExportTaskState { public: ConversationExportTask; controller: AbortController; output?: ExportArchiveResult; canonicalDirectory?: string }
interface ReplyTask { scope: WechatFeatureScope; controller: AbortController; usesKnowledge: boolean }
const sameScope = (a: WechatFeatureScope, b: WechatFeatureScope) => a.accountKey === b.accountKey && a.contactKey === b.contactKey;
const fingerprint = (messages: ReplyPolicyMessage[]) => createHash('sha256').update(JSON.stringify(messages.map(({ id, direction, text, sentAt, messageType, sortSequence }) => ({ id, direction, text, sentAt, messageType, sortSequence })))).digest('hex');
const cancelVoice = (): VoiceTranscriptionResult => ({ ok: false, reason: 'cancelled', error: '微信账号或会话范围已变化，本次转写已取消' });
const exportBoundary = (value: string | undefined, end: boolean): string | undefined => !value ? undefined : /^\d{4}-\d{2}-\d{2}$/u.test(value)
  ? `${value}T${end ? '23:59:59.999' : '00:00:00.000'}+08:00` : value;

export class FeatureController implements FeatureBridge {
  private readonly bindings: ConversationBindings;
  private readonly ready: Promise<void>;
  private accountKey?: string;
  private scopeEpoch = 0;
  private configEpoch = 0;
  private knowledgeEpoch = 0;
  private disposed = false;
  private dialogBusy = false;
  private readonly previews = new Map<string, StoredPreview>();
  private readonly replies = new Map<string, ReplyTask>();
  private readonly transcripts = new Map<string, Transcript>();
  private readonly voiceControllers = new Set<AbortController>();
  private readonly exports = new Map<string, ExportTaskState>();

  constructor(private readonly options: {
    userDataPath: string;
    integrations: IntegrationService;
    localPlans?: LocalPlanStore;
    voice: OfflineTranscriptionService;
    getLiveService: () => Promise<FeatureLiveSource | null>;
    choosePath: (kind: DialogKind) => Promise<string | null>;
    chooseKnowledgeFiles?: () => Promise<string[] | null>;
    openDirectory: (directory: string) => Promise<string>;
    exportArchive?: (input: ExportArchiveInput) => Promise<ExportArchiveResult>;
  }) {
    this.bindings = new ConversationBindings(path.join(options.userDataPath, 'conversation-crm-bindings.json'));
    this.ready = options.integrations.initialize();
  }

  getIntegrationSettings() { return this.result(() => this.options.integrations.getSettings()); }
  updateIntegrationSettings(patch: unknown) { return this.result(() => { const value = settingsInput(patch); this.invalidateConfiguration(); return this.options.integrations.updateSettings(value); }); }
  loginCrm(input: unknown) { return this.result(() => { const value = loginInput(input); this.invalidateConfiguration(); return this.options.integrations.loginCrm(value); }); }
  verifyCrmDevice(challengeId: unknown, code: unknown) { return this.result(() => {
    if (!positiveId(challengeId) || typeof code !== 'string' || !/^\d{6}$/u.test(code)) throw new Error('设备验证码无效');
    this.invalidateConfiguration(); return this.options.integrations.verifyCrmDevice(challengeId, code);
  }); }
  disconnectCrm() { return this.result(() => { this.invalidateConfiguration(); return this.options.integrations.disconnectCrm(); }); }
  testCrm() { return this.result(() => this.options.integrations.testCrm()); }
  searchCrmCustomers(query: unknown) { return this.crmRead(() => this.options.integrations.searchCrmCustomers(searchInput(query))); }
  listCrmCustomers(query: unknown) { return this.crmRead(() => this.options.integrations.listCrmCustomers(crmCustomerListInput(query))); }
  getCrmWorkspaceOverview() { return this.crmRead(() => this.options.integrations.getCrmWorkspaceOverview()); }
  listCrmTasks(query: unknown) { return this.crmRead(() => this.options.integrations.listCrmTasks(crmTaskQueryInput(query))); }
  getCrmCustomerContext(customerId: unknown) { return this.crmRead(() => {
    if (!positiveId(customerId)) throw new Error('请选择有效的 CRM 客户');
    return this.options.integrations.getCrmContext(customerId);
  }); }

  listLocalPlans(accountKey: unknown) { return this.localPlanOperation(accountKey, (plans, account) => plans.list(account)); }
  createLocalPlan(input: unknown) { return this.localPlanOperation(isRecord(input) ? input.accountKey : null, (plans) => plans.create(input as LocalPlanCreateInput)); }
  updateLocalPlan(input: unknown) { return this.localPlanOperation(isRecord(input) ? input.accountKey : null, (plans) => plans.update(input as LocalPlanUpdateInput)); }
  deleteLocalPlan(input: unknown) { return this.localPlanOperation(isRecord(input) ? input.accountKey : null, (plans) => plans.delete(input as LocalPlanDeleteInput)); }

  getConversationCrmBinding(scope: unknown) { return this.result(async () => {
    const value = scopeInput(scope); await this.assertScope(value);
    return this.bindingFor(value);
  }); }

  setConversationCrmBinding(scope: unknown, customerId: unknown) { return this.result(async () => {
    const value = scopeInput(scope);
    if (customerId !== null && !positiveId(customerId)) throw new Error('请选择有效的 CRM 客户');
    await this.assertScope(value);
    const epoch = this.configEpoch;
    const identity = await this.crmIdentity();
    const context = customerId === null ? null : await this.options.integrations.getCrmContext(customerId);
    await this.assertScope(value);
    if (epoch !== this.configEpoch) throw new Error('CRM配置已切换，请重新确认关联');
    const binding: ConversationCrmBinding | null = context ? { customerId: Number(context.customer.id), customerName: String(context.customer.name ?? '').slice(0, 256), confirmedAt: new Date().toISOString() } : null;
    if (binding && (!positiveId(binding.customerId) || binding.customerId !== customerId)) throw new Error('CRM返回的客户身份不一致，未关联');
    this.bindings.set(value, identity, binding);
    this.invalidateConfiguration();
    return binding;
  }); }

  selectKnowledgeFolder() { return this.result(async () => {
    const directory = await this.choose('knowledge');
    if (!directory) throw new DialogCancelled();
    this.invalidateKnowledgePreviews(); return this.options.integrations.indexKnowledge(directory);
  }); }
  reindexKnowledge() { return this.result(() => {
    const directory = this.options.integrations.getSettings().knowledge.folderPath;
    this.invalidateKnowledgePreviews(); return this.options.integrations.indexKnowledge(directory);
  }); }
  clearKnowledge() { return this.result(() => { this.invalidateKnowledgePreviews(); return this.options.integrations.clearKnowledge(); }); }
  searchKnowledge(query: unknown) { return this.result(() => this.options.integrations.searchKnowledge(searchInput(query, 4000))); }
  getKnowledgeWorkspace() { return this.result(() => this.options.integrations.getKnowledgeWorkspace()); }
  getKnowledgeDocument(id: unknown) { return this.result(() => {
    if (!taskId(id)) throw new Error('资料标识无效');
    return this.options.integrations.getKnowledgeDocument(id);
  }); }
  createKnowledgeDocument(input: unknown) { return this.result(() => {
    this.invalidateKnowledgePreviews(); return this.options.integrations.createKnowledgeDocument(input as KnowledgeDraftInput);
  }); }
  saveKnowledgeDocument(input: unknown) { return this.result(() => {
    this.invalidateKnowledgePreviews(); return this.options.integrations.saveKnowledgeDocument(input as KnowledgeDocumentSaveInput);
  }); }
  setKnowledgeDocumentStatus(input: unknown) { return this.result(() => {
    this.invalidateKnowledgePreviews(); return this.options.integrations.setKnowledgeDocumentStatus(input as KnowledgeDocumentStatusInput);
  }); }
  importKnowledgeDocuments(...args: unknown[]) { return this.result(async () => {
    if (args.length) throw new Error('请通过本机文件选择窗口导入资料');
    const files = await this.chooseKnowledgeFiles();
    if (!files?.length) throw new DialogCancelled();
    this.invalidateKnowledgePreviews(); return this.options.integrations.importKnowledgeDocuments(files);
  }); }
  testAi() { return this.result(() => this.options.integrations.testAi()); }

  previewConversationReply(input: unknown) { return this.result(async () => {
    if (!isRecord(input) || typeof input.includeKnowledge !== 'boolean' || (input.includeCrm !== undefined && typeof input.includeCrm !== 'boolean') || Object.keys(input).some((key) => !['scope', 'includeKnowledge', 'includeCrm'].includes(key))) throw new Error('预览参数无效');
    const scope = scopeInput(input.scope);
    const live = await this.assertScope(scope);
    const scopeEpoch = this.scopeEpoch;
    const configEpoch = this.configEpoch;
    const knowledgeEpoch = this.knowledgeEpoch;
    const messages = this.withTranscripts(scope, await live.messagesSnapshot(scope.contactKey, 100));
    const binding = input.includeCrm === false ? null : await this.bindingFor(scope);
    const preview = await this.options.integrations.previewDrafts({ messages, includeKnowledge: input.includeKnowledge, remoteConsent: false, ...(binding ? { crmCustomerId: binding.customerId } : {}) });
    const usesKnowledge = preview.sources.some((source) => source.id.startsWith('kb:'));
    await this.assertScope(scope);
    if (scopeEpoch !== this.scopeEpoch || configEpoch !== this.configEpoch) throw new Error('连接或资料已变化，请重新预览');
    if (usesKnowledge && knowledgeEpoch !== this.knowledgeEpoch) throw new Error('知识库已变化，请重新预览后再起草');
    const id = randomUUID();
    const value: ConversationReplyPreview = { ...preview, previewId: id, scope, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() };
    this.previews.set(id, { preview: value, fingerprint: fingerprint(messages), scopeEpoch, configEpoch, ...(usesKnowledge ? { knowledgeEpoch } : {}), ...(binding ? { customerId: binding.customerId } : {}) });
    if (this.previews.size > 8) this.previews.delete(this.previews.keys().next().value as string);
    return structuredClone(value);
  }); }

  generateConversationReply(input: unknown) { return this.result(async (): Promise<AiDraftResponse> => {
    if (!isRecord(input) || !taskId(input.previewId) || typeof input.remoteConsent !== 'boolean' || Object.keys(input).some((key) => !['scope', 'previewId', 'remoteConsent'].includes(key))) throw new Error('起草参数无效');
    const scope = scopeInput(input.scope);
    const stored = this.previews.get(input.previewId);
    if (!stored || !sameScope(stored.preview.scope, scope) || Date.parse(stored.preview.expiresAt) <= Date.now()) throw new Error('发送预览已失效，请重新预览');
    const live = await this.assertScope(scope);
    const assertUnchanged = () => {
      if (stored.scopeEpoch !== this.scopeEpoch || stored.configEpoch !== this.configEpoch) throw new Error('会话或配置已变化，草稿已失效');
      if (stored.knowledgeEpoch !== undefined && stored.knowledgeEpoch !== this.knowledgeEpoch) throw new Error('知识库已变化，旧引用与草稿已失效，请重新预览');
    };
    const ensureCurrent = async () => {
      await this.assertScope(scope);
      assertUnchanged();
      const messages = await live.messagesSnapshot(scope.contactKey, 100);
      await this.assertScope(scope);
      assertUnchanged();
      const current = this.withTranscripts(scope, messages);
      if (fingerprint(current) !== stored.fingerprint) throw new Error('客户已有新消息或文字已更新，请重新预览再起草');
      return current;
    };
    await ensureCurrent();
    const crm = stored.customerId ? await this.options.integrations.getCrmContext(stored.customerId) : null;
    const currentMessages = await ensureCurrent();
    if (JSON.stringify(deriveReplyPolicy(currentMessages.slice(-100), crm?.customer)) !== JSON.stringify(stored.preview.replyPolicy)) throw new Error('客户状态或资料已变化，请重新预览本次策略');
    if (crm) {
      const currentCrmSources = prepareAiContext({ messages: currentMessages, includeKnowledge: false, remoteConsent: false }, crm, []).sources.filter((source) => source.id.startsWith('crm:'));
      const previewCrmSources = stored.preview.sources.filter((source) => source.id.startsWith('crm:'));
      if (JSON.stringify(currentCrmSources) !== JSON.stringify(previewCrmSources)) throw new Error('客户 CRM 资料或跟进记录已变化，请重新预览本次发送内容');
    }
    // No await between the final validity check, one-time consumption and model dispatch.
    assertUnchanged();
    if (this.previews.get(input.previewId) !== stored || Date.parse(stored.preview.expiresAt) <= Date.now()) throw new Error('发送预览已失效，请重新预览');
    this.previews.delete(input.previewId);
    const controller = new AbortController();
    this.replies.set(input.previewId, { scope, controller, usesKnowledge: stored.knowledgeEpoch !== undefined });
    try {
      const result = await this.options.integrations.generatePreview(stored.preview as AiDraftPreview, input.remoteConsent, controller.signal);
      controller.signal.throwIfAborted();
      await ensureCurrent();
      controller.signal.throwIfAborted();
      return result;
    } finally { this.replies.delete(input.previewId); }
  }); }

  cancelConversationReply(input: unknown) { return this.result(() => {
    if (!isRecord(input) || !taskId(input.previewId) || Object.keys(input).some((key) => !['scope', 'previewId'].includes(key))) throw new Error('停止生成参数无效');
    const scope = scopeInput(input.scope);
    const preview = this.previews.get(input.previewId);
    const task = this.replies.get(input.previewId);
    if ((preview && !sameScope(preview.preview.scope, scope)) || (task && !sameScope(task.scope, scope))) throw new Error('会话与生成任务不一致');
    // Cancellation also works after navigating away; it cannot start a request or read data.
    if (preview) this.previews.delete(input.previewId);
    task?.controller.abort(new ReplyCancelled());
  }); }

  getVoiceStatus() { return this.options.voice.status(); }
  downloadVoiceModel() { return this.options.voice.downloadModel(); }
  async cancelVoiceModelDownload(): Promise<void> { this.options.voice.cancelDownload(); }
  async importVoiceModel() {
    try {
      const directory = await this.choose('voice-model');
      if (!directory) return { ok: false as const, cancelled: true, error: '已取消选择离线模型', status: await this.options.voice.status() };
      return this.options.voice.importModelDirectory(directory);
    } catch (error) { return { ok: false as const, error: publicFeatureError(error), status: await this.options.voice.status() }; }
  }

  async transcribeWechatVoice(voiceMediaKey: unknown, inputScope: unknown): Promise<VoiceTranscriptionResult> {
    if (this.voiceControllers.size >= 8) return { ok: false, reason: 'queue-full', error: '本机语音请求已满，请等待当前任务完成' };
    const controller = new AbortController();
    let bytes: Buffer | undefined;
    try {
      if (!mediaAlias(voiceMediaKey)) throw new Error('语音标识无效');
      const scope = scopeInput(inputScope);
      const live = await this.assertScope(scope);
      const epoch = this.scopeEpoch;
      this.voiceControllers.add(controller);
      const messages = await live.messagesSnapshot(scope.contactKey, 500);
      const message = messages.find((item) => item.messageType === 'voice' && item.voiceMediaKey === voiceMediaKey);
      if (!message) throw new Error('该语音不在当前会话已读取范围内，请刷新会话');
      const input = await live.readVoice(voiceMediaKey, { signal: controller.signal });
      if (!input) return { ok: false, reason: 'unavailable', error: '微信本机没有可读取的语音内容，请先在微信中下载或播放' };
      bytes = input.bytes;
      await this.assertScope(scope);
      if (epoch !== this.scopeEpoch || controller.signal.aborted) return cancelVoice();
      const sourceKey = createHash('sha256').update(JSON.stringify([scope, voiceMediaKey])).digest('hex');
      const result = await this.options.voice.transcribeVoice({ ...input, sourceKey }, controller.signal);
      await this.assertScope(scope);
      if (epoch !== this.scopeEpoch || controller.signal.aborted) return cancelVoice();
      if (result.ok) {
        this.transcripts.set(sourceKey, { scope, voiceMediaKey, messageId: message.id, text: result.text, confirmed: false });
        if (this.transcripts.size > 128) this.transcripts.delete(this.transcripts.keys().next().value as string);
        return { ...result, sourceKey: voiceMediaKey };
      }
      return result;
    } catch (error) { return controller.signal.aborted ? cancelVoice() : { ok: false, reason: 'unavailable', error: publicFeatureError(error, '语音未完成转写，请刷新会话后重试') }; }
    finally { bytes?.fill(0); this.voiceControllers.delete(controller); }
  }

  confirmWechatVoiceTranscript(input: unknown) { return this.result(async () => {
    if (!isRecord(input) || !mediaAlias(input.voiceMediaKey) || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 32768
      || Object.keys(input).some((key) => !['scope', 'voiceMediaKey', 'text'].includes(key))) throw new Error('校对文字无效或过长');
    const scope = scopeInput(input.scope);
    await this.assertScope(scope);
    const key = createHash('sha256').update(JSON.stringify([scope, input.voiceMediaKey])).digest('hex');
    const stored = this.transcripts.get(key);
    if (!stored || !sameScope(stored.scope, scope)) throw new Error('本会话尚未完成该条语音识别，请先转写');
    this.transcripts.set(key, { ...stored, text: input.text.trim(), confirmed: true });
    for (const [id, preview] of this.previews) if (sameScope(preview.preview.scope, scope)) this.previews.delete(id);
  }); }

  async transcribeAudioFile(): Promise<VoiceTranscriptionResult> {
    const controller = new AbortController();
    this.voiceControllers.add(controller);
    try {
      const filename = await this.choose('audio');
      if (!filename || controller.signal.aborted) return cancelVoice();
      const result = await this.options.voice.transcribeFile(filename, controller.signal);
      return controller.signal.aborted ? cancelVoice() : result;
    } catch (error) { return { ok: false, reason: 'unavailable', error: publicFeatureError(error) }; }
    finally { this.voiceControllers.delete(controller); }
  }
  async cancelVoiceTranscription(): Promise<void> {
    for (const controller of this.voiceControllers) controller.abort();
    this.options.voice.cancelPending();
  }

  startConversationExport(input: unknown) { return this.result(async () => {
    if (!isRecord(input) || !opaqueKey(input.accountKey) || Object.keys(input).some((key) => !['accountKey', 'request'].includes(key))) throw new Error('导出范围无效');
    const request = validateConversationExportRequest(input.request);
    if (request.contactKeys.some((key) => !opaqueKey(key))) throw new Error('导出会话无效');
    if ([...this.exports.values()].some((task) => task.public.state === 'running')) throw new Error('已有一项导出任务，请等待或取消后再开始');
    const scope = { accountKey: input.accountKey, contactKey: request.contactKeys[0] };
    const live = await this.assertScope(scope);
    const epoch = this.scopeEpoch;
    for (const contactKey of request.contactKeys) await this.assertScope({ ...scope, contactKey });
    const directory = await this.choose('export');
    if (!directory) throw new DialogCancelled();
    const previous = request.mergePrevious ? await this.choose('previous-export') : null;
    if (request.mergePrevious && !previous) throw new DialogCancelled();
    await this.assertScope(scope);
    if (epoch !== this.scopeEpoch) throw new Error('微信账号已变化，请重新开始导出');
    if ([...this.exports.values()].some((item) => item.public.state === 'running')) throw new Error('已有一项导出任务，请等待或取消后再开始');
    const id = randomUUID();
    const task: ExportTaskState = { public: { id, accountKey: scope.accountKey, contactKeys: [...request.contactKeys], state: 'running' }, controller: new AbortController() };
    this.exports.set(id, task);
    if (this.exports.size > 8) this.exports.delete(this.exports.keys().next().value as string);
    void this.runExport(task, live, scope.accountKey, directory, request, previous ?? undefined, epoch);
    return structuredClone(task.public);
  }); }

  getConversationExportTask(id: unknown) { return this.result(async () => {
    if (!taskId(id)) throw new Error('导出任务标识无效');
    const task = this.exports.get(id);
    if (!task) return null;
    await this.assertScope({ accountKey: task.public.accountKey, contactKey: task.public.contactKeys[0] });
    return structuredClone(task.public);
  }); }
  async cancelConversationExport(id: unknown): Promise<void> {
    if (!taskId(id)) return;
    this.exports.get(id)?.controller.abort();
  }
  openConversationExport(id: unknown) { return this.result(async () => {
    if (!taskId(id)) throw new Error('导出任务标识无效');
    const task = this.exports.get(id);
    if (!task?.output || !task.canonicalDirectory || task.public.state !== 'complete') throw new Error('该导出任务尚未完成');
    const epoch = this.scopeEpoch;
    await this.assertScope({ accountKey: task.public.accountKey, contactKey: task.public.contactKeys[0] });
    const directory = await realpath(task.output.directory);
    if (directory !== task.canonicalDirectory) throw new Error('导出目录已变化，请在资源管理器中检查');
    if (this.disposed || epoch !== this.scopeEpoch || this.exports.get(id) !== task) throw new Error('微信账号或导出任务已变化，请重新选择导出记录');
    if (await this.options.openDirectory(directory)) throw new Error('无法打开导出目录，请在资源管理器中查看');
  }); }

  onWechatDelta(delta: WechatLiveDelta): void {
    if (delta.accountKey !== this.accountKey || !['ready', 'streaming'].includes(delta.status.state)) this.resetWechatScope(delta.accountKey);
  }
  resetWechatScope(accountKey?: string): void {
    this.scopeEpoch += 1; this.accountKey = accountKey; this.previews.clear(); this.transcripts.clear();
    for (const task of this.replies.values()) task.controller.abort(new Error('会话或配置已变化，草稿已失效'));
    for (const task of this.exports.values()) task.controller.abort();
    this.exports.clear();
    void this.cancelVoiceTranscription();
  }
  dispose(): void {
    this.disposed = true; this.resetWechatScope(); this.options.integrations.dispose(); this.options.voice.dispose();
  }

  private async result<T>(run: () => T | Promise<T>): Promise<FeatureResult<T>> {
    try { await this.ready; if (this.disposed) throw new Error('本地服务已停止'); return { ok: true, value: await run() }; }
    catch (error) {
      if (this.options.integrations.getSettings().knowledge.state === 'error') this.invalidateKnowledgePreviews();
      return { ok: false, error: publicFeatureError(error), ...(error instanceof DialogCancelled || error instanceof ReplyCancelled ? { cancelled: true } : {}) };
    }
  }
  private crmRead<T>(read: () => Promise<T>): Promise<FeatureResult<T>> {
    return this.result(async () => {
      const scopeEpoch = this.scopeEpoch;
      const configEpoch = this.configEpoch;
      const value = await read();
      if (this.disposed || scopeEpoch !== this.scopeEpoch || configEpoch !== this.configEpoch) throw new Error('账号或连接配置已变化，旧 CRM 请求结果已丢弃');
      return value;
    });
  }
  private localPlanOperation<T>(accountKey: unknown, run: (plans: LocalPlanStore, account: string) => T): Promise<FeatureResult<T>> {
    return this.result(async () => {
      if (!opaqueKey(accountKey)) throw new Error('请先选择微信账号，再管理本机计划');
      const epoch = this.scopeEpoch;
      const live = await this.options.getLiveService();
      if (this.disposed || epoch !== this.scopeEpoch || live?.snapshot().accountKey !== accountKey
        || (this.accountKey !== undefined && this.accountKey !== accountKey)) throw new Error('微信账号已变化，未读取或修改其他账号的本机计划');
      if (!this.options.localPlans) throw new Error('本机计划服务尚未就绪，请重新打开软件');
      // No await between the current-account check and the synchronous encrypted store operation.
      return run(this.options.localPlans, accountKey);
    });
  }
  private async choose(kind: DialogKind): Promise<string | null> {
    if (this.dialogBusy) throw new Error('请先完成已经打开的文件选择窗口');
    this.dialogBusy = true;
    try {
      const value = await this.options.choosePath(kind);
      if (this.disposed) throw new Error('本地服务已停止');
      if (value && !path.isAbsolute(value)) throw new Error('所选路径无效');
      return value;
    }
    finally { this.dialogBusy = false; }
  }
  private async chooseKnowledgeFiles(): Promise<string[] | null> {
    if (this.dialogBusy) throw new Error('请先完成已经打开的文件选择窗口');
    if (!this.options.chooseKnowledgeFiles) throw new Error('资料文件选择服务尚未就绪，请重新打开软件');
    this.dialogBusy = true;
    try {
      const files = await this.options.chooseKnowledgeFiles();
      if (this.disposed) throw new Error('本地服务已停止');
      if (files === null) return null;
      if (!Array.isArray(files) || files.length > KNOWLEDGE_IMPORT_MAX_FILES
        || files.some((file) => typeof file !== 'string' || !path.isAbsolute(file))) throw new Error('所选资料无效；每次最多导入 20 个文件');
      return files;
    } finally { this.dialogBusy = false; }
  }
  private async assertScope(scope: WechatFeatureScope): Promise<FeatureLiveSource> {
    if (this.disposed) throw new Error('本地服务已停止');
    const live = await this.options.getLiveService();
    const snapshot = live?.snapshot();
    if (!live || snapshot?.accountKey !== scope.accountKey || !snapshot.conversations.some((item) => item.contactKey === scope.contactKey)
      || !['ready', 'streaming'].includes(snapshot.status.state)) throw new Error('微信账号或会话已变化，请重新选择会话');
    if (this.accountKey !== scope.accountKey) this.resetWechatScope(scope.accountKey);
    return live;
  }
  private async crmIdentity(): Promise<string> {
    const user = await this.options.integrations.testCrm();
    if (!positiveId(user.id)) throw new Error('无法确认当前 CRM 账号身份');
    return JSON.stringify([this.options.integrations.getSettings().crm.baseUrl, user.id]);
  }
  private async bindingFor(scope: WechatFeatureScope, knownIdentity?: string): Promise<ConversationCrmBinding | null> {
    if (!this.options.integrations.getSettings().crm.hasSession) return null;
    const epoch = this.configEpoch;
    const identity = knownIdentity ?? await this.crmIdentity();
    await this.assertScope(scope);
    if (epoch !== this.configEpoch) throw new Error('CRM配置已变化，请重新选择客户');
    return this.bindings.get(scope, identity);
  }
  private invalidateConfiguration(): void {
    this.configEpoch += 1; this.previews.clear();
    for (const task of this.replies.values()) task.controller.abort(new Error('会话或配置已变化，草稿已失效'));
    for (const task of this.exports.values()) if (task.public.state === 'running') task.controller.abort();
  }
  private invalidateKnowledgePreviews(): void {
    this.knowledgeEpoch += 1;
    for (const task of this.replies.values()) if (task.usesKnowledge) task.controller.abort(new Error('知识库已变化，旧引用与草稿已失效，请重新预览'));
    for (const [id, stored] of this.previews) if (stored.knowledgeEpoch !== undefined) this.previews.delete(id);
  }
  private withTranscripts(scope: WechatFeatureScope, messages: WechatLiveMessage[]): ReplyPolicyMessage[] {
    return messages.map((message) => {
      const transcript = [...this.transcripts.values()].find((item) => sameScope(item.scope, scope) && item.messageId === message.id && item.confirmed);
      return { id: message.id, direction: message.direction, sender: message.sender, sentAt: message.sentAt,
        messageType: transcript ? 'text' : message.messageType, sortSequence: message.sortSequence,
        text: transcript ? `[SenseVoice 本地语音转写，经用户核对]\n${transcript.text}` : message.messageType === 'voice' ? '' : message.text };
    });
  }

  private async runExport(task: ExportTaskState, live: FeatureLiveSource, accountKey: string, directory: string, request: ConversationExportRequest, previousArchiveDirectory: string | undefined, epoch: number): Promise<void> {
    try {
      const transcripts = [...this.transcripts.values()].filter((item) => item.confirmed && item.scope.accountKey === accountKey);
      const from = exportBoundary(request.from, false);
      const to = exportBoundary(request.to, true) ?? new Date().toISOString();
      const voices = new Set<string>();
      const conversations: ExportConversationSource[] = [];
      let exportCrmIdentity: string | null | undefined = request.includeCrm && this.options.integrations.getSettings().crm.hasSession ? undefined : null;
      let exportCrmIdentityNotice: string | undefined;
      for (const contactKey of request.contactKeys) {
        const scope = { accountKey, contactKey };
        await this.assertScope(scope);
        let crm: CrmCustomerContext | undefined;
        let crmNotice: string | undefined;
        if (request.includeCrm) {
          try {
            if (exportCrmIdentity === undefined) exportCrmIdentity = await this.crmIdentity();
            const binding = exportCrmIdentity ? await this.bindingFor(scope, exportCrmIdentity) : null;
            if (binding) crm = await this.options.integrations.getCrmContext(binding.customerId, { forExport: true });
          } catch (error) {
            await this.assertScope(scope);
            if (task.controller.signal.aborted || epoch !== this.scopeEpoch) throw error;
            crmNotice = 'CRM 补充资料本次未能读取，或当前账号无权导出 CRM；微信聊天仍已正常导出。';
            if (exportCrmIdentity === undefined || !this.options.integrations.getSettings().crm.hasSession) {
              exportCrmIdentity = null; exportCrmIdentityNotice = crmNotice;
            }
          }
          if (!crm && !crmNotice && exportCrmIdentityNotice) crmNotice = exportCrmIdentityNotice;
        }
        const source: ExportConversationSource = { contactKey, title: live.snapshot().conversations.find((item) => item.contactKey === contactKey)?.displayName ?? '微信会话', completeness: 'unknown', messages: [], ...(crm ? { crm: normalizeCrmExportContext(crm) } : {}), ...(crmNotice ? { crmNotice } : {}) };
        const selfAvatar = live.snapshot().selfAvatarMediaKey;
        source.messages = (async function* (controller: FeatureController): AsyncIterable<ExportMessage[]> {
          for await (const page of live.exportMessages(contactKey, { from, to, signal: task.controller.signal })) {
            await controller.assertScope(scope);
            if (epoch !== controller.scopeEpoch || task.controller.signal.aborted) throw new Error('导出已取消');
            yield page.map((message): ExportMessage => {
              const transcript = transcripts.find((item) => item.scope.contactKey === contactKey && item.messageId === message.id);
              if (message.voiceMediaKey) voices.add(message.voiceMediaKey);
              return { ...message, messageType: message.attachmentKind === 'video' ? 'video'
                : message.attachmentKind === 'file' ? 'file'
                  : message.mediaKind === 'sticker' ? 'sticker' : message.messageType,
                mediaKey: message.voiceMediaKey ?? message.mediaKey, mediaKind: message.voiceMediaKey ? 'voice' : message.mediaKind,
                avatarMediaKey: message.senderAvatarMediaKey ?? (message.direction === 'outgoing' ? selfAvatar : undefined),
                ...(request.includeVoiceTranscripts && transcript ? { voiceTranscript: transcript.text, voiceTranscriptEngine: 'SenseVoice 本地转写，经用户核对' } : {}) };
            });
          }
          source.completeness = 'complete';
        })(this);
        conversations.push(source);
      }
      const output = await (this.options.exportArchive ?? exportConversationArchive)({
        directory, accountKey, request, conversations, previousArchiveDirectory, signal: task.controller.signal,
        onProgress: (progress) => { if (!task.controller.signal.aborted) task.public.progress = { ...progress }; },
        resolveMedia: async (key, options) => {
          if (options.signal.aborted || task.controller.signal.aborted || epoch !== this.scopeEpoch) return { ok: false, reason: 'unavailable' };
          if (voices.has(key)) {
            const voice = await live.readVoice(key, { signal: options.signal });
            if (!voice) return { ok: false, reason: 'missing' };
            if (options.signal.aborted || task.controller.signal.aborted || epoch !== this.scopeEpoch) { voice.bytes.fill(0); return { ok: false, reason: 'unavailable' }; }
            try {
              const decoded = await this.options.voice.decodeWechatVoiceToWav(voice, options.signal);
              if (!decoded.ok) return { ok: false, reason: decoded.reason };
              try {
                if (options.signal.aborted || task.controller.signal.aborted || epoch !== this.scopeEpoch) return { ok: false, reason: 'unavailable' };
                if (decoded.bytes.length > options.maxBytes) return { ok: false, reason: 'limit' };
                return { ok: true, bytes: Buffer.from(decoded.bytes), mime: 'audio/wav' };
              } finally { decoded.bytes.fill(0); }
            } finally { voice.bytes.fill(0); }
          }
          const media = await live.mediaForRenderer(key);
          if (options.signal.aborted || task.controller.signal.aborted || epoch !== this.scopeEpoch) return { ok: false, reason: 'unavailable' };
          if (!media.ok) return { ok: false, reason: media.reason };
          const encoded = media.dataUrl.split(',')[1];
          if (!encoded || encoded.length > Math.ceil(options.maxBytes / 3) * 4) return { ok: false, reason: 'limit' };
          const bytes = Buffer.from(encoded, 'base64');
          return bytes.length <= options.maxBytes ? { ok: true, bytes, mime: media.mime } : { ok: false, reason: 'limit' };
        },
        resolveTranscript: async () => ({ ok: false, reason: 'not-transcribed' }),
      });
      // Retain the completed target, not its short-name or junction spelling.
      // Re-resolving it when opening must still point to the same directory.
      const canonicalDirectory = await realpath(output.directory);
      if (task.controller.signal.aborted || epoch !== this.scopeEpoch) throw new Error('导出已取消');
      task.output = output; task.canonicalDirectory = canonicalDirectory;
      task.public.state = 'complete';
      task.public.result = { ok: true, completeness: output.completeness, fileName: path.basename(output.zipPath ?? output.entryPath), messageCount: output.messageCount, mediaCount: output.mediaCount, warnings: output.warnings };
    } catch (error) {
      const cancelled = task.controller.signal.aborted || epoch !== this.scopeEpoch;
      task.public.state = cancelled ? 'cancelled' : 'failed';
      task.public.result = { ok: false, cancelled, error: cancelled ? '导出已取消' : publicFeatureError(error, '导出未完成，请检查读取状态或缩小范围') };
    }
  }
}

class DialogCancelled extends Error { constructor() { super('已取消选择'); } }
class ReplyCancelled extends Error { constructor() { super('已停止生成，草稿已保留'); } }
