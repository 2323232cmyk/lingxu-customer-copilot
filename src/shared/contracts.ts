import type { FeatureBridge } from './feature-bridge-contracts';

export type ConnectionState = 'ready' | 'attention' | 'offline';

export interface RuntimeSourceStatus {
  id: 'wechat' | 'crm' | 'knowledge';
  label: string;
  state: ConnectionState;
  detail: string;
}

export interface RuntimeStatus {
  version: string;
  mode: 'manual-assist';
  sources: RuntimeSourceStatus[];
}

export type MessageDirection = 'incoming' | 'outgoing' | 'system';

export interface ImportedMessage {
  id: string;
  direction: MessageDirection;
  sender: string;
  text: string;
  sentAt: string;
}

export interface ImportedConversation {
  title: string;
  sourceFile: string;
  messages: ImportedMessage[];
}

export type WechatLiveEngineState =
  | 'stopped'
  | 'starting'
  | 'waiting-login'
  | 'ready'
  | 'streaming'
  | 'backoff'
  | 'fatal';

export interface WechatLiveStatus {
  state: WechatLiveEngineState;
  detail: string;
  monitoring: boolean;
  updatedAt: string;
}

export interface WechatLiveConversation {
  contactKey: string;
  displayName: string;
  remark?: string;
  kind: 'contact' | 'group' | 'official' | 'other';
  lastMessageAt?: string;
  unreadCount?: number;
  preview?: string;
  avatarMediaKey?: string;
}

export interface WechatLiveMessage extends ImportedMessage {
  contactKey: string;
  senderDisplayName?: string;
  senderAvatarMediaKey?: string;
  voiceMediaKey?: string;
  voiceDurationMs?: number;
  sortSequence?: string;
  messageType: 'text' | 'image' | 'voice' | 'system' | 'other';
  observedAt: string;
  mediaKey?: string;
  mediaKind?: 'image' | 'sticker';
  mediaStatus?: 'pending' | 'ready' | 'encrypted' | 'missing' | 'unsupported';
  attachmentKind?: 'video' | 'file' | 'unknown';
}

export type WechatMediaResult =
  | { ok: true; dataUrl: string; mime: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' }
  | { ok: false; reason: 'missing' | 'unsupported' | 'unavailable'; mediaStatus?: 'pending' | 'encrypted' | 'missing' | 'unsupported' };

export interface WechatLiveSnapshot {
  revision: number;
  status: WechatLiveStatus;
  conversations: WechatLiveConversation[];
  accountKey?: string;
  selfAvatarMediaKey?: string;
  nextConversationCursor?: string;
}

export interface WechatLiveDelta {
  revision: number;
  accountKey?: string;
  contactKey?: string;
  messages: WechatLiveMessage[];
  status: WechatLiveStatus;
}

export type WechatLiveActionResult =
  | { ok: true; snapshot: WechatLiveSnapshot }
  | { ok: false; error: string; status: WechatLiveStatus };

export type WechatMessagesResult =
  | { ok: true; contactKey: string; messages: WechatLiveMessage[] }
  | { ok: false; error: string };

export type SelectWechatRootResult =
  | { ok: true }
  | { ok: false; cancelled: boolean; error?: string };

export type ConversationImportResult =
  | { ok: true; conversation: ImportedConversation }
  | { ok: false; cancelled: boolean; error?: string };

export interface SalesCopilotBridge extends FeatureBridge {
  getRuntimeStatus(): Promise<RuntimeStatus>;
  importConversation(): Promise<ConversationImportResult>;
  copyText(text: string): Promise<void>;
  getWechatSnapshot(): Promise<WechatLiveSnapshot>;
  getWechatConversations(cursor?: string): Promise<WechatLiveActionResult>;
  getWechatMedia(mediaKey: string): Promise<WechatMediaResult>;
  startWechatLive(): Promise<WechatLiveActionResult>;
  stopWechatLive(): Promise<WechatLiveSnapshot>;
  selectWechatAccountRoot(): Promise<SelectWechatRootResult>;
  getWechatMessages(contactKey: string, limit?: number): Promise<WechatMessagesResult>;
  watchWechatConversation(contactKey: string): Promise<void>;
  unwatchWechatConversation(): Promise<void>;
  onWechatDelta(listener: (delta: WechatLiveDelta) => void): () => void;
}
