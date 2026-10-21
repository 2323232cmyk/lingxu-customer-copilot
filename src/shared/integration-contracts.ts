import type { ImportedMessage } from './contracts';
import type { ReplyPolicy } from './reply-policy';

export type AiProvider = 'openai' | 'deepseek' | 'compatible' | 'ollama';

export interface CrmSettings {
  baseUrl: string;
  username: string;
  rememberSession: boolean;
  allowInsecureHttp: boolean;
}

export interface AiSettings {
  provider: AiProvider;
  baseUrl: string;
  model: string;
  rememberKey: boolean;
  allowRemote: boolean;
}

export interface KnowledgeIndexStatus {
  source?: 'local' | 'cloud';
  version?: string;
  /** Optional for older clients; current libraries always report an explicit availability state. */
  state?: 'idle' | 'indexing' | 'ready' | 'error';
  folderPath: string;
  /** Readable indexed counts: zero while rebuilding or unavailable, not last-success totals. */
  documents: number;
  chunks: number;
  indexedAt: string | null;
  skipped: number;
  warnings: string[];
  supportedExtensions: string[];
}

export interface IntegrationSettingsPublic {
  crm: CrmSettings & { hasSession: boolean };
  ai: AiSettings & { hasApiKey: boolean; isLocal: boolean };
  knowledge: KnowledgeIndexStatus;
  secureStorageAvailable: boolean;
  notice?: string;
}

export interface IntegrationSettingsUpdate {
  crm?: Partial<CrmSettings>;
  ai?: Partial<AiSettings> & { apiKey?: string; clearApiKey?: boolean };
}

export interface CrmLoginRequest {
  username: string;
  password: string;
  rememberSession?: boolean;
}

export type CrmLoginResponse =
  | { kind: 'authenticated'; user: Record<string, unknown> }
  | { kind: 'verification-required'; challengeId: number; expiresAt: string };

export interface CrmCustomerCandidate {
  id: number;
  name: string;
  phone: string;
  level?: string;
  ownerName?: string;
}

export interface CrmCustomerListQuery {
  search?: string;
  stage?: 'active' | 'visited' | 'deal';
  page?: number;
  limit?: number;
  level?: string;
  sort?: 'updated' | 'next' | 'last';
  order?: 'asc' | 'desc';
}

/** Only the CRM's permission-filtered summary; never reconstruct masked fields. */
export interface CrmCustomerSummary extends CrmCustomerCandidate {
  ownerId: number | null;
  accessProfile: 'full' | 'masked';
  area: string;
  budget: string;
  location: string;
  firstContact: string;
  customerType: string;
  lastFollowupAt: string;
  lastFollowupContent: string;
  nextFollowupAt: string;
  followupCount: number | null;
  isVisited: boolean;
  isDeal: boolean;
  visitAt: string;
  dealSignedAt: string;
  updatedAt: string;
  isFavorite: boolean;
  tags: string;
}

export interface CrmCustomerPage {
  customers: CrmCustomerSummary[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
  fetchedAt: string;
  sourceBaseUrl: string;
}

export interface CrmTaskQuery {
  scope?: 'all' | 'today' | 'overdue' | 'future';
  done?: 'open' | 'done' | 'all';
  ownOnly?: boolean;
}

export interface CrmTask {
  id: number;
  customerId: number;
  title: string;
  dueAt: string;
  done: boolean;
  doneAt: string | null;
  source: string;
  customerName: string;
  customerLevel: string;
  accessProfile: 'full' | 'masked';
}

export interface CrmTaskList {
  tasks: CrmTask[];
  scope: NonNullable<CrmTaskQuery['scope']>;
  ownOnly: boolean;
  fetchedAt: string;
  sourceBaseUrl: string;
}

export interface CrmWorkspaceOverview {
  stats: {
    totalCustomers: number;
    todayTasks: number;
    overdueTasks: number;
    monthNew: number;
    todayNew: number;
    weekVisited: number;
    monthVisited: number;
    monthDeal: number;
  };
  today: CrmTask[];
  overdue: CrmTask[];
  future: CrmTask[];
  priorityCustomers: CrmCustomerSummary[];
  staleCustomers: CrmCustomerSummary[];
  staleCount: number;
  levelStats: Array<{ level: string; count: number }>;
  workTrend: Array<{ date: string; label: string; phone: number; acquired: number; interview: number; visited: number; deal: number }>;
  scopeLabel: string;
  metricNotes: string[];
  fetchedAt: string;
  sourceBaseUrl: string;
}

export interface CrmCustomerContext {
  customer: Record<string, unknown>;
  followups: unknown[];
  calls: unknown[];
  tasks: unknown[];
  houseTargets: unknown[];
  fetchedAt: string;
  sourceBaseUrl: string;
  availability: { followups: 'available' | 'forbidden'; calls: 'available' | 'forbidden' };
}

export interface KnowledgeHit {
  id: string;
  title: string;
  sourcePath: string;
  text: string;
  score: number;
}

export interface AiDraftRequest {
  messages: ImportedMessage[];
  /** A customer explicitly confirmed by the user, never inferred from a nickname. */
  crmCustomerId?: number;
  includeKnowledge: boolean;
  query?: string;
  /** Per-request approval; saving a provider is not approval to transmit chats. */
  remoteConsent: boolean;
}

export interface AiDraft {
  text: string;
  reason: string;
  sourceIds: string[];
}

export interface AiDraftResponse {
  drafts: AiDraft[];
  provider: AiProvider;
  model: string;
  sources: Array<{ id: string; title: string; sourcePath?: string }>;
  warnings: string[];
  contextSummary?: AiContextSummary;
}

/** Counts describe the excerpts actually prepared for this generation, not all customer history. */
export interface AiContextSummary {
  focus: string;
  chatMessages: number;
  crmRecords: number;
  knowledgeHits: number;
  knowledgeStatus: 'included' | 'no_match' | 'disabled';
  knowledgeQueries: string[];
}

export interface AiDraftPreview {
  provider: AiProvider;
  model: string;
  destination: string;
  isRemote: boolean;
  sources: Array<{ id: string; title: string; text: string; sourcePath?: string }>;
  warnings: string[];
  contextSummary?: AiContextSummary;
  /** Main-process-derived constraints, bound to the cached message preview. */
  replyPolicy?: ReplyPolicy;
}

export interface AiConnectionResult {
  ok: true;
  provider: AiProvider;
  model: string;
  detail: string;
}
