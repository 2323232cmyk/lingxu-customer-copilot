export type KnowledgeDocumentStatus = 'draft' | 'approved' | 'disabled';

export const KNOWLEDGE_TITLE_MAX_LENGTH = 200;
export const KNOWLEDGE_BODY_MAX_LENGTH = 200_000;
export const KNOWLEDGE_IMPORT_MAX_FILES = 20;

/** Company material only. Customer chats and CRM records never enter this repository automatically. */
export interface KnowledgeDocument {
  id: string;
  title: string;
  body: string;
  status: KnowledgeDocumentStatus;
  revision: number;
  sourceKind: 'file' | 'manual';
  sourceName: string | null;
  expiry: string | null;
  createdAt: string;
  updatedAt: string;
  approvedAt: string | null;
}

export type KnowledgeDocumentSummary = Omit<KnowledgeDocument, 'body'> & { characters: number };

export interface KnowledgeWorkspace {
  documents: KnowledgeDocumentSummary[];
  /** Approved excludes expired documents; the four counts sum to total. */
  counts: { total: number; draft: number; approved: number; disabled: number; expired: number };
}

export interface KnowledgeDraftInput {
  title: string;
  body: string;
  /** YYYY-MM-DD, inclusive until the end of that day in Beijing, or null. */
  expiry: string | null;
}

export interface KnowledgeDocumentSaveInput extends KnowledgeDraftInput {
  id: string;
  expectedRevision: number;
}

export interface KnowledgeDocumentStatusInput {
  id: string;
  expectedRevision: number;
  status: KnowledgeDocumentStatus;
}

export interface KnowledgeImportResult {
  imported: KnowledgeDocumentSummary[];
  skipped: Array<{ name: string; error: string }>;
}

/** Main-process snapshot for the existing KnowledgeLibrary, never a page-supplied approval. */
export interface KnowledgeSourceDocument {
  id: string;
  revision: number;
  title: string;
  body: string;
  expiry: string | null;
}
