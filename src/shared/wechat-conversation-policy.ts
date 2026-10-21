import type { WechatLiveConversation } from './contracts';

/** Kind is classified from native account identifiers, never from a person's name. */
export const isSalesWechatConversation = (
  conversation: Pick<WechatLiveConversation, 'kind'>,
): boolean => conversation.kind === 'contact' || conversation.kind === 'group';
