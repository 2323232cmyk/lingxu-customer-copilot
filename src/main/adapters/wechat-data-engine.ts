import type { MessageDirection } from '../../shared/contracts';

export interface WechatAccount {
  accountId: string;
  displayName: string;
  dataPath: string;
}

export interface WechatContact {
  contactKey: string;
  displayName: string;
  remark?: string;
}

export interface WechatEngineMessage {
  messageId: string;
  contactKey: string;
  direction: MessageDirection;
  type: 'text' | 'image' | 'voice' | 'system' | 'other';
  text?: string;
  occurredAt: string;
}

export interface WechatDataEngine {
  discoverAccounts(): Promise<WechatAccount[]>;
  connect(accountId: string): Promise<void>;
  listContacts(): Promise<WechatContact[]>;
  listMessages(contactKey: string, limit: number): Promise<WechatEngineMessage[]>;
  subscribeChanges(listener: (contactKeys: string[]) => void): () => void;
  disconnect(): Promise<void>;
}

export class NativeEngineNotBundledError extends Error {
  constructor() {
    super('原生微信数据引擎尚未打包到当前开发版本');
    this.name = 'NativeEngineNotBundledError';
  }
}
