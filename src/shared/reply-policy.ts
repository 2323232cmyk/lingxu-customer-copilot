import type { ImportedMessage } from './contracts';
import { analyzeMessageSignals } from './message-signals';
import { createInitialStrategyState, reduceStrategy, type NextMove, type NormalizedMessageEvent, type SalesStage, type StrategyDecision } from './sales-strategy';
import { compareWechatMessageOrder } from './wechat-message-order';

export interface ReplyPolicyMessage extends ImportedMessage {
  messageType?: NormalizedMessageEvent['messageType'];
  sortSequence?: string;
}

/** Derived in the main process, never accepted as renderer authorization. No customer prose. */
export interface ReplyPolicy {
  nextMove: NextMove;
  stage: SalesStage;
  triggerSourceId?: string;
  reasonCodes: string[];
  mustInclude: string[];
  mustAvoid: string[];
}

export function deriveReplyPolicy(messages: readonly ReplyPolicyMessage[], crmCustomer?: Record<string, unknown>): ReplyPolicy {
  // The controller already verified the selected WeChat identity. CRM association is optional.
  let state = createInitialStrategyState('current-customer', 'current-contact', true);
  for (const [key, field] of [['purpose', 'customerType'], ['budget', 'budget'], ['area', 'area'], ['decisionMaker', 'decisionMaker']] as const) {
    const value = crmCustomer?.[field];
    if (typeof value !== 'string' || !value.trim() || /^(?:—|未知|待定|待确认|未填写)$/.test(value.trim())) continue;
    state.facts[key] = { key, status: 'confirmed', value: value.trim(), sourceMessageIds: [`crm:profile:${key}`] };
  }
  let decision: StrategyDecision | undefined;
  const ordered = messages.map((message, index) => ({ message, index }))
    .sort((a, b) => compareWechatMessageOrder(a.message.sentAt, b.message.sentAt, a.message.sortSequence, b.message.sortSequence));
  let triggerIndex = -1;
  for (const { message, index } of ordered) {
    if (!message || !['incoming', 'outgoing'].includes(message.direction) || message.messageType === 'system') continue;
    const text = typeof message.text === 'string' ? message.text : '';
    const messageType = message.messageType ?? (!text.trim() || /^\[(?:图片|语音|表情|视频|其他消息|文件)\]$/.test(text.trim()) ? 'other' : 'text');
    const event: NormalizedMessageEvent = {
      schemaVersion: 1, eventId: `reply:${message.id}`, accountId: 'verified-current-account', contactKey: state.contactKey,
      messageId: message.id, direction: message.direction, messageType, text,
      occurredAt: message.sentAt, observedAt: message.sentAt,
    };
    const signals = analyzeMessageSignals(event);
    const result = reduceStrategy(state, event, signals);
    state = result.state;
    if (!result.ignored) {
      decision = result.decision;
      triggerIndex = index;
      // A fact conflict must not mask an explicit request to pause or stop contact.
      if (message.direction === 'incoming' && messageType === 'text' && (signals.intent === 'refusal' || signals.intent === 'pause')) {
        const closed = state.stage === 'closed' || signals.intent === 'refusal';
        state = { ...state, stage: closed ? 'closed' : 'paused' };
        decision = { ...decision, nextMove: closed ? 'acknowledge_close' : 'acknowledge_pause',
          reasonCodes: [closed ? 'explicit-refusal' : 'explicit-pause'],
          mustInclude: [closed ? '简短确认不再主动联系' : '尊重客户提出的暂停时间'],
          mustAvoid: ['继续邀约', '制造紧迫感'] };
      }
    }
  }
  return {
    nextMove: decision?.nextMove ?? 'human_review', stage: state.stage,
    ...(triggerIndex >= 0 ? { triggerSourceId: `chat:${triggerIndex + 1}` } : {}),
    reasonCodes: [...(decision?.reasonCodes ?? ['no-customer-message'])],
    mustInclude: decision?.nextMove === 'offer_visit_slots'
      ? ['询问客户方便的到店时间，核实接待安排后再确认'] : [...(decision?.mustInclude ?? [])],
    mustAvoid: [...(decision?.mustAvoid ?? []), '编造接待时段、时长或已经完成预约'],
  };
}

export function replyPolicyBlockReason(policy: ReplyPolicy | undefined): string | undefined {
  if (!policy) return '本次会话策略尚未核实，请重新预览后再起草';
  // Strategy recommends when to send; it must not prevent user-requested drafting.
  return undefined;
}

interface AcknowledgementCopy { text: string; reason: string }
type AcknowledgementCopies = [AcknowledgementCopy, AcknowledgementCopy, AcknowledgementCopy];

/** Keep pause/close acknowledgements deterministic: a model cannot reintroduce an invitation. */
export function replyAcknowledgements(move: 'acknowledge_pause' | 'acknowledge_close'): AcknowledgementCopies;
export function replyAcknowledgements(move: NextMove): AcknowledgementCopies | null;
export function replyAcknowledgements(move: NextMove): AcknowledgementCopies | null {
  if (move === 'acknowledge_pause') return [
    { text: '好的，您先忙，我这边先不打扰。等您方便时我们再联系。', reason: '尊重客户的暂停意愿，不猜测暂停原因。' },
    { text: '明白，先按您的安排来，我这边先暂停跟进，不着急。', reason: '只确认暂停，不继续追问或安排时间。' },
    { text: '收到，我先暂停跟进。您有需要时再给我消息就好。', reason: '保留联系入口，不提出新的行动要求。' },
  ];
  if (move === 'acknowledge_close') return [
    { text: '收到，我这边不再主动联系您。', reason: '尊重客户停止联系的要求。' },
    { text: '明白，我会停止后续跟进，不再打扰。', reason: '不继续解释或邀约。' },
    { text: '好的，之后不再主动联系您。', reason: '只作简短确认，不声称已修改 CRM。' },
  ];
  return null;
}
