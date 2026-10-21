import { describe, expect, it } from 'vitest';
import type { KnowledgeDocument, KnowledgeDocumentSummary } from '../shared/knowledge-workspace-contracts';
import { canApproveKnowledge, emptyKnowledgeDraft, filterKnowledgeDocuments, knowledgeCounts, knowledgeDraftDirty, knowledgeDraftError, knowledgeDraftFrom, knowledgeState } from './knowledge-workspace-model';

const document: KnowledgeDocument = { id: 'test-doc', title: '合成测试：服务说明', body: '仅用于测试的正文，不是真实业务口径。', status: 'draft', revision: 1, sourceKind: 'manual', sourceName: null, expiry: null, createdAt: '2030-01-01T00:00:00Z', updatedAt: '2030-01-01T00:00:00Z', approvedAt: null };
const summary = (value: KnowledgeDocument): KnowledgeDocumentSummary => { const { body, ...rest } = value; return { ...rest, characters: body.length }; };

describe('knowledge workspace view model', () => {
  it('starts blank without business claims and detects unsaved changes', () => {
    const draft = emptyKnowledgeDraft();
    expect(draft).toEqual({ title: '', body: '', expiry: null });
    expect(knowledgeDraftDirty(draft, null)).toBe(false);
    expect(knowledgeDraftDirty({ ...draft, body: '未保存' }, null)).toBe(true);
    expect(knowledgeDraftDirty(knowledgeDraftFrom(document), document)).toBe(false);
    expect(knowledgeDraftDirty({ ...knowledgeDraftFrom(document), expiry: '2030-12-31' }, document)).toBe(true);
  });

  it('uses inclusive Beijing expiry and does not classify drafts as active expired knowledge', () => {
    const approved = { ...document, status: 'approved' as const, expiry: '2030-01-01' };
    expect(knowledgeState(approved, Date.parse('2030-01-01T15:59:59.999Z'))).toBe('approved');
    expect(knowledgeState(approved, Date.parse('2030-01-01T16:00:00Z'))).toBe('expired');
    expect(knowledgeState({ ...approved, status: 'draft' }, Date.parse('2030-02-01T00:00:00Z'))).toBe('draft');
    expect(knowledgeState({ ...approved, status: 'disabled' }, Date.parse('2030-02-01T00:00:00Z'))).toBe('disabled');
  });

  it('counts active and expired materials separately without double counting', () => {
    const documents = [summary(document), summary({ ...document, id: 'active', status: 'approved' }), summary({ ...document, id: 'expired', status: 'approved', expiry: '2029-12-31' }), summary({ ...document, id: 'disabled', status: 'disabled' })];
    expect(knowledgeCounts(documents, Date.parse('2030-01-01T00:00:00Z'))).toEqual({ total: 4, draft: 1, approved: 1, expired: 1, disabled: 1 });
  });

  it('searches titles and source names, filters status, and never searches hidden body content', () => {
    const documents = [summary(document), summary({ ...document, id: 'file', title: '贷款材料', sourceKind: 'file', sourceName: 'Training.MD', status: 'approved' })];
    expect(filterKnowledgeDocuments(documents, 'training', 'approved').map((item) => item.id)).toEqual(['file']);
    expect(filterKnowledgeDocuments(documents, '', 'draft').map((item) => item.id)).toEqual(['test-doc']);
    expect(filterKnowledgeDocuments(documents, '不是真实业务', 'all')).toEqual([]);
  });

  it.each([
    { title: '', body: '正文', expiry: null },
    { title: '标题', body: ' ', expiry: null },
    { title: '标题', body: '正文', expiry: '2030-02-30' },
    { title: '标题', body: '正文', expiry: '2030-1-1' },
    { title: '标题', body: '正文', expiry: '无效' },
    { title: '字'.repeat(201), body: '正文', expiry: null },
    { title: '标题', body: '字'.repeat(200001), expiry: null },
  ])('rejects invalid or oversized draft input without truncating it', (draft) => {
    expect(knowledgeDraftError(draft)).not.toBe('');
  });

  it('allows a valid draft or past date to be saved for review, but not approved when expired', () => {
    expect(knowledgeDraftError(knowledgeDraftFrom(document))).toBe('');
    expect(knowledgeDraftError({ ...knowledgeDraftFrom(document), expiry: '2028-02-29' })).toBe('');
    expect(canApproveKnowledge({ ...document, expiry: '2029-01-01' }, false, true, Date.parse('2030-01-01T00:00:00Z'))).toBe(false);
  });

  it('requires a saved, clean, explicitly reviewed, unexpired draft for approval', () => {
    expect(canApproveKnowledge(document, false, true)).toBe(true);
    expect(canApproveKnowledge(document, true, true)).toBe(false);
    expect(canApproveKnowledge(document, false, false)).toBe(false);
    expect(canApproveKnowledge(null, false, true)).toBe(false);
    expect(canApproveKnowledge({ ...document, status: 'disabled' }, false, true)).toBe(false);
    expect(canApproveKnowledge({ ...document, status: 'approved' }, false, true)).toBe(false);
  });
});
