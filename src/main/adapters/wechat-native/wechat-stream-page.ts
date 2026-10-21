import type { NativeMessage } from './native-normalize';
import { compareWechatMessageOrder, isWechatSortSequence } from '../../../shared/wechat-message-order';

export class WechatStreamPageError extends Error {
  constructor(readonly code: 'cursor.expired' | 'stream.scanLimit') {
    super('实时消息边界需要重新确认');
    this.name = 'WechatStreamPageError';
  }
}

/** Walk newest pages until the acknowledged boundary, rather than dropping bursts. */
export const readUnseenWechatMessages = (
  readPage: (limit: number, offset: number) => readonly NativeMessage[],
  seenIds: ReadonlySet<string>,
  wasEmpty: boolean,
): NativeMessage[] => {
  const messages = new Map<string, NativeMessage>();
  const pageSize = 500;
  const collectPage = (page: readonly NativeMessage[]) => {
    const known = page.filter((message) => seenIds.has(message.messageId));
    // The newest acknowledged timestamp and exact source sequence keep older
    // same-second rows outside a truncated baseline from masquerading as new.
    const boundary = known.sort((left, right) => compareWechatMessageOrder(
      left.occurredAt, right.occurredAt, left.sortSequence, right.sortSequence,
    )).at(-1);
    const boundarySequence = known.some((message) => message.occurredAt === boundary?.occurredAt
      && !isWechatSortSequence(message.sortSequence)) ? undefined : boundary?.sortSequence;
    for (const message of page) {
      if (!seenIds.has(message.messageId) && (!boundary || compareWechatMessageOrder(
        message.occurredAt, boundary.occurredAt, message.sortSequence, boundarySequence,
      ) >= 0)) {
        messages.set(message.messageId, message);
      }
    }
    return { boundary, boundarySequence };
  };
  // Most polls have zero or only a few new rows. Keep the full lossless scan for
  // bursts and ambiguous same-second legacy rows, rather than decoding 500 every tick.
  const probe = readPage(64, 0);
  const { boundary, boundarySequence } = collectPage(probe);
  if (boundary && (probe.length < 64
    || probe.every((message) => message.occurredAt !== boundary.occurredAt || isWechatSortSequence(message.sortSequence))
      && isWechatSortSequence(boundarySequence)
    || probe.some((message) => Date.parse(message.occurredAt) < Date.parse(boundary.occurredAt)))) {
    return [...messages.values()];
  }
  if (probe.length < 64) {
    if (!wasEmpty) throw new WechatStreamPageError('cursor.expired');
    return [...messages.values()];
  }
  messages.clear();
  for (let offset = 0; offset < 5000; offset += pageSize) {
    const page = readPage(pageSize, offset);
    if (collectPage(page).boundary) return [...messages.values()];
    if (page.length < pageSize) {
      if (!wasEmpty) throw new WechatStreamPageError('cursor.expired');
      return [...messages.values()];
    }
  }
  throw new WechatStreamPageError('stream.scanLimit');
};
