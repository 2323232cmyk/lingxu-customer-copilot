import type { AiConnectionResult, AiDraftPreview, AiDraftRequest, AiDraftResponse, CrmCustomerCandidate, CrmCustomerContext, CrmCustomerListQuery, CrmCustomerPage, CrmLoginRequest, CrmLoginResponse, CrmTaskList, CrmTaskQuery, CrmWorkspaceOverview, IntegrationSettingsPublic, IntegrationSettingsUpdate, KnowledgeHit, KnowledgeIndexStatus } from '../../shared/integration-contracts';
import { ReadOnlyCrmConnector } from '../connectors/crm-connector';
import { AiReplyClient, prepareAiContext, type PreparedAiContext } from './ai-replies';
import { IntegrationSettingsStore, type SecretStorage } from './integration-settings';
import { KnowledgeLibrary } from './knowledge-library';
import { CloudKnowledge } from './cloud-knowledge';
import { cloudTransport } from './cloud-transport';
import { KnowledgeRepository } from './knowledge-repository';
import path from 'node:path';
import type { ReplyPolicyMessage } from '../../shared/reply-policy';
import type { KnowledgeDocument, KnowledgeDocumentSaveInput, KnowledgeDocumentStatusInput, KnowledgeDraftInput, KnowledgeImportResult, KnowledgeWorkspace } from '../../shared/knowledge-workspace-contracts';

function knowledgeTopics(text: string): string[] {
  return [
    ['贷款', /贷款|按揭|金融|征信/u], ['退款', /退[款费]|退回|不退|能退|退吗/u],
    ['服务费', /服务费|收费|佣金|费用|尾款/u], ['尽调', /尽调|调查报告/u],
    ['竞拍', /竞拍|参拍|拍中|流拍/u], ['交付过户', /交房|交付|过户|三书/u],
    ['签约流程', /签约|委托|合同/u], ['到访安排', /到店|到访|接待|预约/u],
  ].filter(([, pattern]) => (pattern as RegExp).test(text)).map(([topic]) => topic as string);
}

function redactKnowledgeQuery(query: string): string {
  return query
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, ' ')
    .replace(/(?<!\d)(?:\d{17}[\dXx]|\d{15})(?!\d)/gu, ' ')
    .replace(/(?<!\d)(?:\+?86[-\s]?)?1[3-9](?:[-\s]?\d){9}(?!\d)/gu, ' ')
    .replace(/(?<!\d)0\d{2,3}[-\s]?\d{7,8}(?!\d)/gu, ' ')
    .replace(/\s+/gu, ' ').trim();
}

function customerKnowledgeQueries(messages: readonly ReplyPolicyMessage[], crm: CrmCustomerContext | null): string[] {
  const recent = messages.slice(-100);
  const usableText = (message: ReplyPolicyMessage): string => {
    if (message?.direction !== 'incoming' || typeof message.text !== 'string'
      || (message.messageType !== undefined && message.messageType !== 'text')) return '';
    const text = message.text.replace(/^\[SenseVoice 本地语音转写，经用户核对\]\s*/u, '').trim();
    if (!text || /^\[(?:图片|语音|表情|视频|其他消息|文件)\]$/u.test(text)
      || !text.replace(/好的|好啊|收到|明白|知道了|你好|您好|谢谢|感谢|嗯|好|[，,。.!！\s]/gu, '')) return '';
    return text;
  };
  const last = recent.findLastIndex((message) => Boolean(usableText(message)));
  if (last < 0) return [''];
  const latest = redactKnowledgeQuery(usableText(recent[last])).slice(0, 600);
  const latestTopics = knowledgeTopics(latest);
  const dependent = latestTopics.length === 0 && latest.length <= 40 && /^(?:那|这|它|还有|另外|需要哪些|要准备|怎么办|多久|可以吗|有吗|多少)/u.test(latest);
  const supplementalTopics = new Set<string>();
  for (let index = last - 1; index >= 0 && supplementalTopics.size < 2; index -= 1) {
    if (recent[index].direction === 'outgoing') break;
    const text = usableText(recent[index]);
    if (!text || (!dependent && !/[？?]|怎么|如何|多少|哪些|是否|能否|能不能|可不可以|什么|为什么|多久/u.test(text))) continue;
    for (const topic of knowledgeTopics(text)) if (!latestTopics.includes(topic)) supplementalTopics.add(topic);
  }
  // Earlier messages may contain unrelated identity details. Only recognized
  // question topics become supplementary queries, never arbitrary chat prose.
  // An explicit subject after "另外/还有" still gets its own independent query.
  if (!dependent || supplementalTopics.size) return [latest, ...supplementalTopics].slice(0, 3);
  // For short follow-ups across turns, carry topic labels, never our sales
  // scripts or raw CRM details. This also keeps names/phones out of CRM queries.
  const previousCustomer = recent.slice(Math.max(0, last - 8), last).findLast((message) => Boolean(usableText(message)));
  let topics = previousCustomer ? knowledgeTopics(usableText(previousCustomer)) : [];
  if (!topics.length && crm) {
    const recentFollowup = crm.availability.followups === 'available' ? crm.followups[0] : null;
    const followupText = recentFollowup && typeof recentFollowup === 'object' && 'content' in recentFollowup ? String(recentFollowup.content) : '';
    topics = knowledgeTopics([followupText, ...['lastFollowupContent', 'loanRemark', 'loanMethod', 'auctionStatus', 'tags'].map((field) => typeof crm.customer[field] === 'string' ? crm.customer[field] : '')].join('\n'));
  }
  return [latest, ...topics].slice(0, 3);
}

export interface IntegrationServiceOptions {
  settingsPath: string;
  knowledgeRepositoryPath?: string;
  secretStorage: SecretStorage;
  fetch?: typeof fetch;
  cloudKnowledge?: boolean;
}

export class IntegrationService {
  private readonly store: IntegrationSettingsStore;
  private readonly cloud?: CloudKnowledge;
  private readonly knowledge = new KnowledgeLibrary();
  private repository: KnowledgeRepository | null = null;
  private knowledgeBusy = false;
  private disposed = false;
  private readonly knowledgeController = new AbortController();
  private crm: ReadOnlyCrmConnector | null = null;
  private crmGeneration = 0;
  private pendingChallenge: number | null = null;
  private knowledgeError: string | null = null;
  private aiBusy = false;
  private settingsGeneration = 0;

  constructor(private readonly options: IntegrationServiceOptions) {
    this.store = new IntegrationSettingsStore(options.settingsPath, options.secretStorage);
    if (options.cloudKnowledge) this.cloud = new CloudKnowledge(() => {
      if (this.disposed) return null;
      const settings = this.store.getCrmSettings();
      return settings.baseUrl.replace(/\/+$/, '').replace(/\/api$/, '') === 'https://crm.example.com' ? this.store.getCrmToken() : null;
    }, cloudTransport(options.fetch ?? fetch));
  }

  async initialize(): Promise<void> {
    if (this.cloud) { await this.cloud.refresh().catch(() => undefined); return; }
    const folder = this.store.getKnowledgePath();
    try { await this.changeKnowledge(() => undefined, folder); }
    catch { this.knowledgeError = '知识资料暂不可读取，请检查本机资料库或重新选择外部目录'; }
  }

  getSettings(): IntegrationSettingsPublic {
    if (this.cloud) return this.store.getPublic(this.cloud.status());
    const knowledge = this.knowledge.getStatus();
    if (!knowledge.folderPath) knowledge.folderPath = this.store.getKnowledgePath();
    if (this.knowledgeError) knowledge.warnings.push(this.knowledgeError);
    return this.store.getPublic(knowledge);
  }

  updateSettings(patch: IntegrationSettingsUpdate): IntegrationSettingsPublic {
    this.store.update(patch);
    this.settingsGeneration += 1;
    if (patch.crm) {
      this.cloud?.invalidate();
      this.crmGeneration += 1;
      this.crm = null;
      this.pendingChallenge = null;
    }
    return this.getSettings();
  }

  async loginCrm(input: CrmLoginRequest): Promise<CrmLoginResponse> {
    if (!input || typeof input.username !== 'string' || typeof input.password !== 'string') throw new Error('请填写 CRM 用户名和密码');
    this.updateSettings({ crm: { username: input.username, ...(input.rememberSession === undefined ? {} : { rememberSession: input.rememberSession }) } });
    const crm = this.getCrm();
    const generation = this.crmGeneration;
    const result = await crm.login({ username: input.username.trim(), password: input.password, deviceId: this.store.getDeviceId(), deviceName: '领序·客户参谋 Windows 桌面端' });
    this.assertCrmGeneration(generation);
    if (result.kind === 'verification-required') {
      this.pendingChallenge = result.challengeId;
      return result;
    }
    const user = await crm.getCurrentUser();
    this.assertCrmGeneration(generation);
    await this.cloud?.refresh().catch(() => undefined);
    this.assertCrmGeneration(generation);
    return { kind: 'authenticated', user };
  }

  async verifyCrmDevice(challengeId: number, code: string): Promise<CrmLoginResponse> {
    if (this.pendingChallenge !== challengeId) throw new Error('本次设备验证已失效，请重新登录 CRM');
    const crm = this.getCrm();
    const generation = this.crmGeneration;
    await crm.verifyDevice(challengeId, code);
    this.assertCrmGeneration(generation);
    this.pendingChallenge = null;
    const user = await crm.getCurrentUser();
    this.assertCrmGeneration(generation);
    await this.cloud?.refresh().catch(() => undefined);
    this.assertCrmGeneration(generation);
    return { kind: 'authenticated', user };
  }

  disconnectCrm(): IntegrationSettingsPublic {
    this.cloud?.invalidate();
    this.crmGeneration += 1;
    this.crm = null;
    this.pendingChallenge = null;
    this.store.setCrmToken(null);
    return this.getSettings();
  }

  async testCrm(): Promise<Record<string, unknown>> {
    const generation = this.crmGeneration;
    const user = await this.getCrm().getCurrentUser();
    this.assertCrmGeneration(generation);
    return user;
  }

  async searchCrmCustomers(query: string): Promise<CrmCustomerCandidate[]> {
    const generation = this.crmGeneration;
    const result = await this.getCrm().searchCustomers(query);
    this.assertCrmGeneration(generation);
    return result;
  }

  async listCrmCustomers(query: CrmCustomerListQuery): Promise<CrmCustomerPage> {
    const generation = this.crmGeneration;
    const result = await this.getCrm().listCustomers(query);
    this.assertCrmGeneration(generation);
    return result;
  }

  async getCrmWorkspaceOverview(): Promise<CrmWorkspaceOverview> {
    const generation = this.crmGeneration;
    const result = await this.getCrm().getWorkspaceOverview();
    this.assertCrmGeneration(generation);
    return result;
  }

  async listCrmTasks(query: CrmTaskQuery): Promise<CrmTaskList> {
    const generation = this.crmGeneration;
    const result = await this.getCrm().listTasks(query);
    this.assertCrmGeneration(generation);
    return result;
  }

  async getCrmContext(customerId: number, options: { forExport?: boolean } = {}): Promise<CrmCustomerContext> {
    const generation = this.crmGeneration;
    const result = await this.getCrm().getCustomerContext(customerId, options);
    this.assertCrmGeneration(generation);
    return result;
  }

  async indexKnowledge(folderPath: string): Promise<KnowledgeIndexStatus> {
    if (this.cloud) return this.cloud.refresh();
    if (typeof folderPath !== 'string' || folderPath.length > 4096) throw new Error('请选择有效的知识库目录');
    return (await this.changeKnowledge(() => undefined, folderPath, true)).status;
  }

  async clearKnowledge(): Promise<IntegrationSettingsPublic> {
    if (this.cloud) throw new Error('当前统一使用云端知识库，无需移除本地目录');
    // This detaches an external directory; reviewed local documents remain available.
    await this.changeKnowledge(() => undefined, '', true);
    return this.getSettings();
  }

  searchKnowledge(query: string, limit?: number): KnowledgeHit[] | Promise<KnowledgeHit[]> {
    if (this.cloud) return this.cloud.search(query, limit);
    this.assertKnowledgeRepositoryCurrent();
    return this.knowledge.search(query, limit);
  }

  getKnowledgeWorkspace(): KnowledgeWorkspace {
    if (this.cloud) throw new Error('知识资料由公司云端统一发布，本机不再维护副本');
    this.assertActive();
    try { return this.getRepository().list(); }
    catch (error) { this.assertKnowledgeRepositoryCurrent(); throw error; }
  }
  getKnowledgeDocument(id: string): KnowledgeDocument {
    this.assertActive();
    try { return this.getRepository().get(id); }
    catch (error) { this.assertKnowledgeRepositoryCurrent(); throw error; }
  }
  async createKnowledgeDocument(input: KnowledgeDraftInput): Promise<KnowledgeDocument> {
    return (await this.changeKnowledge(() => this.getRepository().createDraft(input), undefined, false, true)).value;
  }
  async saveKnowledgeDocument(input: KnowledgeDocumentSaveInput): Promise<KnowledgeDocument> {
    return (await this.changeKnowledge(() => this.getRepository().saveDraft(input), undefined, false, true)).value;
  }
  async setKnowledgeDocumentStatus(input: KnowledgeDocumentStatusInput): Promise<KnowledgeDocument> {
    return (await this.changeKnowledge(() => this.getRepository().setStatus(input), undefined, false, true)).value;
  }
  async importKnowledgeDocuments(paths: string[]): Promise<KnowledgeImportResult> {
    return (await this.changeKnowledge(() => this.getRepository().importFiles(paths, { signal: this.knowledgeController.signal }), undefined, false, true)).value;
  }

  dispose(): void {
    this.cloud?.invalidate();
    this.disposed = true;
    this.knowledgeController.abort();
    this.knowledge.invalidate(true);
  }

  async previewDrafts(request: AiDraftRequest): Promise<AiDraftPreview> {
    const generation = this.settingsGeneration;
    const client = this.getAi();
    const context = await this.prepare(request);
    if (generation !== this.settingsGeneration) throw new Error('配置已变更，请重新预览本次发送内容');
    await this.assertKnowledgeReferencesCurrent(context.sources);
    return client.preview(context);
  }

  async generateDrafts(request: AiDraftRequest): Promise<AiDraftResponse> {
    if (this.aiBusy) throw new Error('已有一项模型任务正在执行，请等待完成');
    this.aiBusy = true;
    try {
      const generation = this.settingsGeneration;
      const client = this.getAi();
      const context = await this.prepare(request);
      if (generation !== this.settingsGeneration) throw new Error('配置已变更，未向旧地址发送聊天内容');
      await this.assertKnowledgeReferencesCurrent(context.sources);
      const result = await client.generate(context, request.remoteConsent);
      await this.assertKnowledgeReferencesCurrent(context.sources);
      return result;
    } finally { this.aiBusy = false; }
  }

  /** Main-process-only: controller supplies its cached, user-previewed sources, never renderer input. */
  async generatePreview(preview: AiDraftPreview, remoteConsent: boolean, signal?: AbortSignal): Promise<AiDraftResponse> {
    signal?.throwIfAborted();
    if (this.aiBusy) throw new Error('已有一项模型任务正在执行，请等待完成');
    const client = this.getAi();
    const current = client.preview({ sources: [], warnings: [] });
    if (current.provider !== preview.provider || current.model !== preview.model || current.destination !== preview.destination) throw new Error('模型配置已变更，请重新预览发送内容');
    this.aiBusy = true;
    try {
      const validation = this.assertKnowledgeReferencesCurrent(preview.sources);
      if (validation) await validation;
      signal?.throwIfAborted();
      const result = await client.generate({ sources: preview.sources, warnings: preview.warnings, replyPolicy: preview.replyPolicy, contextSummary: preview.contextSummary }, remoteConsent, signal);
      signal?.throwIfAborted();
      await this.assertKnowledgeReferencesCurrent(preview.sources);
      signal?.throwIfAborted();
      return result;
    }
    finally { this.aiBusy = false; }
  }

  async testAi(): Promise<AiConnectionResult> {
    if (this.aiBusy) throw new Error('已有一项模型任务正在执行，请等待完成');
    this.aiBusy = true;
    try { return await this.getAi().test(); }
    finally { this.aiBusy = false; }
  }

  private async prepare(request: AiDraftRequest): Promise<PreparedAiContext> {
    if (!request || typeof request !== 'object' || typeof request.includeKnowledge !== 'boolean' || typeof request.remoteConsent !== 'boolean'
      || !Array.isArray(request.messages) || request.messages.length > 5000
      || (request.query !== undefined && (typeof request.query !== 'string' || request.query.length > 4000))) throw new Error('起草请求格式不正确');
    // Installed cloud clients always retrieve company knowledge, even when an
    // older renderer sends the former opt-out. Local development keeps its option.
    const effectiveRequest = this.cloud ? { ...request, includeKnowledge: true } : request;
    const crm = request.crmCustomerId === undefined ? null : await this.getCrmContext(request.crmCustomerId);
    const hits: KnowledgeHit[] = [];
    const knowledgeQueries: string[] = [];
    if (effectiveRequest.includeKnowledge) {
      const queries = request.query !== undefined ? [request.query] : customerKnowledgeQueries(request.messages, crm);
      const groups: KnowledgeHit[][] = [];
      for (const query of queries) {
        const redacted = redactKnowledgeQuery(query);
        const bounded = this.cloud ? redacted.slice(0, 600) : redacted;
        knowledgeQueries.push(bounded);
        groups.push(await this.searchKnowledge(bounded, 6));
      }
      // Round-robin the ranked results so one question cannot occupy every
      // available source slot. Keep the six-excerpt limit and stable source ids.
      for (let rank = 0; rank < 6 && hits.length < 6; rank += 1) for (const group of groups) {
        const hit = group[rank];
        if (hit && !hits.some((item) => item.id === hit.id) && hits.length < 6) hits.push(hit);
      }
    }
    const context = prepareAiContext(effectiveRequest, crm, hits);
    if (context.contextSummary) context.contextSummary.knowledgeQueries = knowledgeQueries;
    return context;
  }

  private getAi(): AiReplyClient { return new AiReplyClient(this.store.getAiSettings(), this.store.getApiKey(), this.options.fetch); }

  private getRepository(): KnowledgeRepository {
    this.repository ??= new KnowledgeRepository(this.options.knowledgeRepositoryPath ?? path.join(path.dirname(this.options.settingsPath), 'knowledge-workspace.enc.json'), this.options.secretStorage);
    return this.repository;
  }

  private assertKnowledgeRepositoryCurrent(): void {
    this.assertActive();
    try { this.getRepository().approvedDocuments(); }
    catch {
      this.knowledge.invalidate(true);
      this.knowledgeError = '本机知识资料已变化或暂不可验证，旧知识引用已停用；请重新打开软件后再检索';
      throw new Error(this.knowledgeError);
    }
  }

  private assertKnowledgeReferencesCurrent(sources: AiDraftPreview['sources']): void | Promise<void> {
    if (this.cloud) return this.cloud.validate(sources);
    if (!sources.some((source) => source.id.startsWith('kb:'))) return;
    this.assertKnowledgeRepositoryCurrent();
    this.knowledge.assertReferencesCurrent(sources);
  }

  private assertActive(): void { if (this.disposed) throw new Error('本地知识资料服务已停止'); }

  private async changeKnowledge<T>(operation: () => T | Promise<T>, folderPath = this.store.getKnowledgePath(), persistDirectory = false, documentChange = false): Promise<{ value: T; status: KnowledgeIndexStatus }> {
    if (this.cloud) throw new Error('知识资料由公司云端统一发布，本机不再维护副本');
    this.assertActive();
    if (this.knowledgeBusy) throw new Error('知识库正在处理另一项变更，请完成后再试');
    this.knowledgeBusy = true;
    this.knowledge.invalidate();
    let changed = false;
    try {
      const value = await operation();
      changed = true;
      this.assertActive();
      const status = await this.knowledge.index(folderPath, this.getRepository().approvedDocuments());
      this.assertActive();
      if (persistDirectory) this.store.setKnowledgePath(status.folderPath);
      this.knowledgeError = null;
      return { value, status };
    } catch (error) {
      if (!changed && !this.disposed) {
        // A rejected edit must not erase the last approved material. Restore only
        // the repository's current, main-validated snapshot, never the old chunks.
        try {
          await this.knowledge.index(this.store.getKnowledgePath(), this.getRepository().approvedDocuments());
          this.assertActive();
          this.knowledgeError = null;
        } catch {
          this.knowledge.invalidate(true);
          this.knowledgeError = '知识资料未完成整理，旧引用已停用；请检查资料后重建索引';
        }
      } else {
        this.knowledge.invalidate(true);
        this.knowledgeError = this.disposed ? '本地知识资料服务已停止' : documentChange
          ? '资料已保存或更新，但索引未完成；请重新整理后再使用，不要重复新建'
          : '知识索引未完成，旧引用已停用；请检查目录后重新整理';
        if (changed && documentChange && !this.disposed) throw new Error(this.knowledgeError);
      }
      throw error;
    } finally { this.knowledgeBusy = false; }
  }

  private getCrm(): ReadOnlyCrmConnector {
    if (!this.crm) {
      const settings = this.store.getCrmSettings();
      if (!settings.baseUrl) throw new Error('请先配置 CRM 服务地址');
      const generation = this.crmGeneration;
      this.crm = new ReadOnlyCrmConnector(settings.baseUrl, {
        token: this.store.getCrmToken(), allowInsecureHttp: settings.allowInsecureHttp, fetch: this.options.fetch,
        onToken: (token) => { if (generation === this.crmGeneration) this.store.setCrmToken(token); },
      });
    }
    return this.crm;
  }

  private assertCrmGeneration(generation: number): void {
    if (generation !== this.crmGeneration) throw new Error('CRM连接已切换，旧请求结果已丢弃');
  }
}
