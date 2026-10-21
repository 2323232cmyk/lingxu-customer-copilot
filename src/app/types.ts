import type { ImportedMessage } from '../shared/contracts';

export type WorkGoal = 'answer' | 'call' | 'visit' | 'pause';

export interface EvidenceItem {
  id: string;
  kind: 'chat' | 'call' | 'crm' | 'knowledge';
  title: string;
  excerpt: string;
  updatedAt: string;
}

export interface CustomerQueueItem {
  id: string;
  name: string;
  initials: string;
  phone: string;
  level: 'A' | 'B' | 'C' | null;
  source?: 'wechat';
  stage: string;
  owner: string;
  preview: string;
  lastContact: string;
  unread: number;
  priority: 'urgent' | 'today' | 'normal';
  status: '待回复' | '今日跟进' | '已邀约' | '全部';
  budget: string;
  area: string;
  purpose: string;
  decisionMaker: string;
  obstacle: string;
  nextAction: string;
  callSummary: string;
  messages: ImportedMessage[];
  evidence: EvidenceItem[];
}

export interface ReplyDraft {
  id: string;
  basedOnStateVersion: number;
  triggerMessageId: string;
  tone: '稳妥' | '推荐' | '更直接';
  text: string;
  reason: string;
  evidenceIds: string[];
  warning?: string;
  action?: {
    kind: 'ask_fact' | 'offer_call' | 'offer_visit' | 'confirm_visit';
    label: string;
  };
  requiresHumanConfirmation: true;
}
