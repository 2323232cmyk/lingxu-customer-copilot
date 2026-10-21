import { randomUUID } from 'node:crypto';
import type { WechatEngineStartResult, WechatWorkerConversation } from '../../../shared/wechat-worker-protocol';
import type { NativeConversation } from './native-normalize';
import { isSalesWechatConversation } from '../../../shared/wechat-conversation-policy';

export class WechatConversationPageError extends Error {
  constructor(readonly code: 'conversations.cursorExpired' | 'database.pagination') {
    super(code === 'conversations.cursorExpired' ? '会话列表已刷新，请重新加载列表' : '会话分页范围无效');
    this.name = 'WechatConversationPageError';
  }
}

/** A metadata-only snapshot keeps live session reordering from skipping pages. */
export class WechatConversationPages {
  private readonly prefix = `conversation-page:${randomUUID()}:`;
  private readonly items: readonly WechatWorkerConversation[];

  constructor(private readonly accountKey: string, conversations: readonly NativeConversation[]) {
    this.items = conversations.filter(isSalesWechatConversation).map(({ contactKey, displayName, remark, kind, lastMessageAt, unreadCount, preview }) => ({
      contactKey, displayName, kind,
      ...(remark === undefined ? {} : { remark }),
      ...(lastMessageAt === undefined ? {} : { lastMessageAt }),
      ...(unreadCount === undefined ? {} : { unreadCount }),
      ...(preview === undefined ? {} : { preview }),
    }));
  }

  page(limit = 100, cursor?: string): WechatEngineStartResult {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new WechatConversationPageError('database.pagination');
    }
    const rawOffset = cursor?.startsWith(this.prefix) ? cursor.slice(this.prefix.length) : undefined;
    if (cursor !== undefined && (rawOffset === undefined || !/^[1-9]\d*$/u.test(rawOffset))) {
      throw new WechatConversationPageError('conversations.cursorExpired');
    }
    const offset = rawOffset === undefined ? 0 : Number(rawOffset);
    if (!Number.isSafeInteger(offset) || (offset !== 0 && offset >= this.items.length)) {
      throw new WechatConversationPageError('conversations.cursorExpired');
    }
    const end = Math.min(offset + limit, this.items.length);
    return {
      accountKey: this.accountKey,
      conversations: this.items.slice(offset, end).map((item) => ({ ...item })),
      ...(end < this.items.length ? { nextConversationCursor: `${this.prefix}${end}` } : {}),
    };
  }
}
