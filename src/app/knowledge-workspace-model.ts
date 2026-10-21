import { KNOWLEDGE_BODY_MAX_LENGTH, KNOWLEDGE_TITLE_MAX_LENGTH } from '../shared/knowledge-workspace-contracts';
import type { KnowledgeDocument, KnowledgeDocumentSummary, KnowledgeDraftInput, KnowledgeWorkspace } from '../shared/knowledge-workspace-contracts';

export type KnowledgeFilter = 'all' | 'draft' | 'approved' | 'expired' | 'disabled';
export const knowledgeStateLabels = { draft: '待审核', approved: '已启用', expired: '已过期', disabled: '已停用' } as const;
export const emptyKnowledgeDraft = (): KnowledgeDraftInput => ({ title: '', body: '', expiry: null });
export const knowledgeDraftFrom = (document: KnowledgeDocument): KnowledgeDraftInput => ({ title: document.title, body: document.body, expiry: document.expiry });

export function knowledgeState(document: Pick<KnowledgeDocument, 'status' | 'expiry'>, now = Date.now()): Exclude<KnowledgeFilter, 'all'> {
  return document.status === 'approved' && document.expiry && Date.parse(`${document.expiry}T23:59:59.999+08:00`) < now ? 'expired' : document.status;
}

export function knowledgeCounts(documents: KnowledgeDocumentSummary[], now = Date.now()): KnowledgeWorkspace['counts'] {
  const counts = { total: documents.length, draft: 0, approved: 0, disabled: 0, expired: 0 };
  for (const document of documents) counts[knowledgeState(document, now)] += 1;
  return counts;
}

export function filterKnowledgeDocuments(documents: KnowledgeDocumentSummary[], query: string, filter: KnowledgeFilter, now = Date.now()): KnowledgeDocumentSummary[] {
  const needle = query.trim().toLocaleLowerCase();
  return documents.filter((document) => (filter === 'all' || knowledgeState(document, now) === filter)
    && (!needle || `${document.title}\n${document.sourceName || ''}`.toLocaleLowerCase().includes(needle)));
}

export function knowledgeDraftDirty(draft: KnowledgeDraftInput, document: KnowledgeDocument | null): boolean {
  const saved = document ? knowledgeDraftFrom(document) : emptyKnowledgeDraft();
  return draft.title !== saved.title || draft.body !== saved.body || draft.expiry !== saved.expiry;
}

export function knowledgeDraftError(draft: KnowledgeDraftInput): string {
  if (!draft.title.trim() || draft.title.length > KNOWLEDGE_TITLE_MAX_LENGTH) return `请填写 1 至 ${KNOWLEDGE_TITLE_MAX_LENGTH} 字的资料标题。`;
  if (!draft.body.trim() || draft.body.length > KNOWLEDGE_BODY_MAX_LENGTH) return `请填写资料正文，最多 ${KNOWLEDGE_BODY_MAX_LENGTH.toLocaleString('zh-CN')} 字；较长文件请拆分。`;
  if (draft.expiry !== null) {
    const parsed = Date.parse(`${draft.expiry}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.expiry) || !Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== draft.expiry) return '请选择有效的到期日期，或清空为长期有效。';
  }
  return '';
}

export function canApproveKnowledge(document: KnowledgeDocument | null, dirty: boolean, reviewed: boolean, now = Date.now()): boolean {
  return Boolean(document && document.status === 'draft' && !dirty && reviewed
    && (!document.expiry || Date.parse(`${document.expiry}T23:59:59.999+08:00`) >= now));
}
