import type { AiConnectionResult, AiDraftPreview, AiDraftResponse, CrmCustomerCandidate, CrmCustomerContext, CrmCustomerListQuery, CrmCustomerPage, CrmLoginRequest, CrmLoginResponse, CrmTaskList, CrmTaskQuery, CrmWorkspaceOverview, IntegrationSettingsPublic, IntegrationSettingsUpdate, KnowledgeHit, KnowledgeIndexStatus } from './integration-contracts';
import type { ConversationExportProgress, ConversationExportRequest, ConversationExportResult } from './export-contracts';
import type { OfflineVoiceStatus, VoiceModelActionResult, VoiceTranscriptionResult } from './voice-contracts';
import type { LocalPlan, LocalPlanCreateInput, LocalPlanDeleteInput, LocalPlanUpdateInput } from './local-plan-contracts';
import type { KnowledgeDocument, KnowledgeDocumentSaveInput, KnowledgeDocumentStatusInput, KnowledgeDraftInput, KnowledgeImportResult, KnowledgeWorkspace } from './knowledge-workspace-contracts';

export type FeatureResult<T> = { ok: true; value: T } | { ok: false; error: string; cancelled?: boolean };

export interface WechatFeatureScope {
  accountKey: string;
  contactKey: string;
}

export interface ConversationCrmBinding {
  customerId: number;
  customerName: string;
  confirmedAt: string;
}

export interface ConversationReplyPreview extends AiDraftPreview {
  previewId: string;
  scope: WechatFeatureScope;
  expiresAt: string;
}

export interface ConversationExportTask {
  id: string;
  accountKey: string;
  contactKeys: string[];
  state: 'running' | 'complete' | 'cancelled' | 'failed';
  progress?: ConversationExportProgress;
  result?: ConversationExportResult;
}

/** Every file/directory is selected by a main-process dialog, never supplied by a page. */
export interface FeatureBridge {
  getIntegrationSettings(): Promise<FeatureResult<IntegrationSettingsPublic>>;
  updateIntegrationSettings(patch: IntegrationSettingsUpdate): Promise<FeatureResult<IntegrationSettingsPublic>>;
  loginCrm(input: CrmLoginRequest): Promise<FeatureResult<CrmLoginResponse>>;
  verifyCrmDevice(challengeId: number, code: string): Promise<FeatureResult<CrmLoginResponse>>;
  disconnectCrm(): Promise<FeatureResult<IntegrationSettingsPublic>>;
  testCrm(): Promise<FeatureResult<Record<string, unknown>>>;
  searchCrmCustomers(query: string): Promise<FeatureResult<CrmCustomerCandidate[]>>;
  listCrmCustomers(query: CrmCustomerListQuery): Promise<FeatureResult<CrmCustomerPage>>;
  getCrmWorkspaceOverview(): Promise<FeatureResult<CrmWorkspaceOverview>>;
  listCrmTasks(query: CrmTaskQuery): Promise<FeatureResult<CrmTaskList>>;
  listLocalPlans(accountKey: string): Promise<FeatureResult<LocalPlan[]>>;
  createLocalPlan(input: LocalPlanCreateInput): Promise<FeatureResult<LocalPlan>>;
  updateLocalPlan(input: LocalPlanUpdateInput): Promise<FeatureResult<LocalPlan>>;
  deleteLocalPlan(input: LocalPlanDeleteInput): Promise<FeatureResult<void>>;
  getCrmCustomerContext(customerId: number): Promise<FeatureResult<CrmCustomerContext>>;
  getConversationCrmBinding(scope: WechatFeatureScope): Promise<FeatureResult<ConversationCrmBinding | null>>;
  setConversationCrmBinding(scope: WechatFeatureScope, customerId: number | null): Promise<FeatureResult<ConversationCrmBinding | null>>;
  selectKnowledgeFolder(): Promise<FeatureResult<KnowledgeIndexStatus>>;
  reindexKnowledge(): Promise<FeatureResult<KnowledgeIndexStatus>>;
  clearKnowledge(): Promise<FeatureResult<IntegrationSettingsPublic>>;
  searchKnowledge(query: string): Promise<FeatureResult<KnowledgeHit[]>>;
  getKnowledgeWorkspace(): Promise<FeatureResult<KnowledgeWorkspace>>;
  getKnowledgeDocument(id: string): Promise<FeatureResult<KnowledgeDocument>>;
  createKnowledgeDocument(input: KnowledgeDraftInput): Promise<FeatureResult<KnowledgeDocument>>;
  saveKnowledgeDocument(input: KnowledgeDocumentSaveInput): Promise<FeatureResult<KnowledgeDocument>>;
  setKnowledgeDocumentStatus(input: KnowledgeDocumentStatusInput): Promise<FeatureResult<KnowledgeDocument>>;
  importKnowledgeDocuments(): Promise<FeatureResult<KnowledgeImportResult>>;
  testAi(): Promise<FeatureResult<AiConnectionResult>>;
  previewConversationReply(input: { scope: WechatFeatureScope; includeKnowledge: boolean; includeCrm?: boolean }): Promise<FeatureResult<ConversationReplyPreview>>;
  generateConversationReply(input: { scope: WechatFeatureScope; previewId: string; remoteConsent: boolean }): Promise<FeatureResult<AiDraftResponse>>;
  cancelConversationReply(input: { scope: WechatFeatureScope; previewId: string }): Promise<FeatureResult<void>>;
  getVoiceStatus(): Promise<OfflineVoiceStatus>;
  downloadVoiceModel(): Promise<VoiceModelActionResult>;
  cancelVoiceModelDownload(): Promise<void>;
  importVoiceModel(): Promise<VoiceModelActionResult>;
  transcribeWechatVoice(voiceMediaKey: string, scope: WechatFeatureScope): Promise<VoiceTranscriptionResult>;
  confirmWechatVoiceTranscript(input: { scope: WechatFeatureScope; voiceMediaKey: string; text: string }): Promise<FeatureResult<void>>;
  transcribeAudioFile(): Promise<VoiceTranscriptionResult>;
  cancelVoiceTranscription(): Promise<void>;
  startConversationExport(input: { accountKey: string; request: ConversationExportRequest }): Promise<FeatureResult<ConversationExportTask>>;
  getConversationExportTask(taskId: string): Promise<FeatureResult<ConversationExportTask | null>>;
  cancelConversationExport(taskId: string): Promise<void>;
  openConversationExport(taskId: string): Promise<FeatureResult<void>>;
}

export const FEATURE_CHANNELS = {
  getIntegrationSettings: 'features:get-settings', updateIntegrationSettings: 'features:update-settings',
  loginCrm: 'features:crm-login', verifyCrmDevice: 'features:crm-verify', disconnectCrm: 'features:crm-disconnect',
  testCrm: 'features:crm-test', searchCrmCustomers: 'features:crm-search', getCrmCustomerContext: 'features:crm-context',
  listCrmCustomers: 'features:crm-list', getCrmWorkspaceOverview: 'features:crm-overview', listCrmTasks: 'features:crm-tasks',
  listLocalPlans: 'features:plans-list', createLocalPlan: 'features:plans-create', updateLocalPlan: 'features:plans-update', deleteLocalPlan: 'features:plans-delete',
  getConversationCrmBinding: 'features:binding-get', setConversationCrmBinding: 'features:binding-set',
  selectKnowledgeFolder: 'features:knowledge-select', reindexKnowledge: 'features:knowledge-reindex',
  clearKnowledge: 'features:knowledge-clear', searchKnowledge: 'features:knowledge-search',
  getKnowledgeWorkspace: 'features:knowledge-workspace', getKnowledgeDocument: 'features:knowledge-document',
  createKnowledgeDocument: 'features:knowledge-create', saveKnowledgeDocument: 'features:knowledge-save',
  setKnowledgeDocumentStatus: 'features:knowledge-status', importKnowledgeDocuments: 'features:knowledge-import',
  testAi: 'features:ai-test', previewConversationReply: 'features:ai-preview', generateConversationReply: 'features:ai-generate',
  cancelConversationReply: 'features:ai-cancel',
  getVoiceStatus: 'features:voice-status', downloadVoiceModel: 'features:voice-download', cancelVoiceModelDownload: 'features:voice-download-cancel',
  importVoiceModel: 'features:voice-import-model', transcribeWechatVoice: 'features:voice-transcribe-wechat', confirmWechatVoiceTranscript: 'features:voice-confirm',
  transcribeAudioFile: 'features:voice-transcribe-file', cancelVoiceTranscription: 'features:voice-transcribe-cancel',
  startConversationExport: 'features:export-start', getConversationExportTask: 'features:export-status',
  cancelConversationExport: 'features:export-cancel', openConversationExport: 'features:export-open',
} as const satisfies Record<keyof FeatureBridge, string>;
