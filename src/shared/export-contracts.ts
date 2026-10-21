import type { ImportedMessage } from './contracts';

export const CONVERSATION_EXPORT_FORMATS = ['html', 'markdown', 'csv', 'json', 'txt'] as const;
export type ConversationExportFormat = typeof CONVERSATION_EXPORT_FORMATS[number];
export type ExportMessageType = 'text' | 'image' | 'sticker' | 'voice' | 'video' | 'file' | 'system' | 'other';

/** Paths, account identities and credentials never enter a renderer export request. */
export interface ConversationExportRequest {
  contactKeys: string[];
  format: ConversationExportFormat;
  title?: string;
  /** A date (inclusive, Asia/Shanghai), or an ISO timestamp with an explicit offset. */
  from?: string;
  to?: string;
  messageTypes?: ExportMessageType[];
  includeCrm?: boolean;
  includeAvatars?: boolean;
  media?: 'none' | 'available';
  includeVoiceTranscripts?: boolean;
  missingMedia?: 'placeholder' | 'omit';
  zip?: boolean;
  /** The main process asks the user to choose an existing Lingxu HTML archive. */
  mergePrevious?: boolean;
}

export interface ExportMessage extends ImportedMessage {
  messageType: ExportMessageType;
  sortSequence?: string;
  mediaKey?: string;
  mediaKind?: 'image' | 'sticker' | 'voice' | 'video' | 'file';
  avatarMediaKey?: string;
  voiceTranscript?: string;
  voiceTranscriptEngine?: string;
  /** Present when native data proves an attachment exists but this version cannot read its bytes. */
  attachmentKind?: 'video' | 'file' | 'unknown';
}

export interface ExportCrmContext {
  customerId: string;
  customerName: string;
  fetchedAt: string;
  profile: Array<{ label: string; value: string }>;
  followups: Array<{ id?: string; recordedAt?: string; author?: string; text: string }>;
  calls: Array<{
    id?: string;
    startedAt?: string;
    author?: string;
    direction?: string;
    durationSeconds?: number;
    result?: string;
    notes?: string;
    transcript?: string;
  }>;
  completeness: 'complete' | 'partial' | 'unknown';
  notices?: string[];
}

export interface ConversationExportProgress {
  phase: 'reading' | 'media' | 'transcribing' | 'writing' | 'compressing' | 'complete';
  conversationsDone: number;
  conversationCount: number;
  messagesRead: number;
  messagesExported: number;
  mediaSaved: number;
  mediaMissing: number;
}

export type ConversationExportResult =
  | { ok: true; completeness?: 'complete' | 'partial'; fileName: string; messageCount: number; mediaCount: number; warnings: string[] }
  | { ok: false; cancelled: boolean; error?: string };
