import type { WechatLiveMessage } from '../shared/contracts';
import { compareWechatMessageOrder } from '../shared/wechat-message-order';
import { analyzeMessageSignals } from '../shared/message-signals';
import {
  createInitialStrategyState,
  reduceStrategy,
  type FactKey,
  type NormalizedMessageEvent,
  type StrategyDecision,
  type StrategyState,
} from '../shared/sales-strategy';
import type { CustomerQueueItem } from './types';

export interface LiveStrategyResult {
  state: StrategyState;
  decision: StrategyDecision;
}

const seedConfirmedFact = (
  state: StrategyState,
  key: FactKey,
  value: string,
  customerId: string,
): StrategyState => {
  const normalized = value.trim();
  if (!normalized || normalized === '—' || normalized === '未知') return state;
  return {
    ...state,
    facts: {
      ...state.facts,
      [key]: {
        key,
        value: normalized,
        status: 'confirmed',
        sourceMessageIds: [`crm:${customerId}:${key}`],
      },
    },
  };
};

const createBoundState = (
  customer: CustomerQueueItem,
  contactKey: string,
): StrategyState => {
  let state = createInitialStrategyState(customer.id, contactKey, true);
  state = seedConfirmedFact(state, 'purpose', customer.purpose, customer.id);
  state = seedConfirmedFact(state, 'budget', customer.budget, customer.id);
  state = seedConfirmedFact(state, 'area', customer.area, customer.id);
  state = seedConfirmedFact(state, 'decisionMaker', customer.decisionMaker, customer.id);
  return state;
};

const asEvent = (
  message: WechatLiveMessage,
  contactKey: string,
): NormalizedMessageEvent => ({
  schemaVersion: 1,
  eventId: `wechat:${message.id}`,
  accountId: 'local-wechat',
  contactKey,
  messageId: message.id,
  direction: message.direction,
  messageType: message.messageType,
  ...(message.text ? { text: message.text } : {}),
  occurredAt: message.sentAt,
  observedAt: message.observedAt,
});

export const replayLiveStrategy = (
  customer: CustomerQueueItem,
  contactKey: string,
  messages: readonly WechatLiveMessage[],
): LiveStrategyResult | null => {
  if (messages.length === 0) return null;
  let state = createBoundState(customer, contactKey);
  let decision: StrategyDecision | undefined;
  const ordered = [...messages].sort((left, right) =>
    compareWechatMessageOrder(left.sentAt, right.sentAt, left.sortSequence, right.sortSequence));

  for (const message of ordered) {
    if (message.contactKey !== contactKey
      || !['incoming', 'outgoing'].includes(message.direction)
      || message.messageType === 'system') continue;
    const event = asEvent(message, contactKey);
    const result = reduceStrategy(state, event, analyzeMessageSignals(event));
    state = result.state;
    if (!result.ignored) decision = result.decision;
  }

  return decision ? { state, decision } : null;
};
