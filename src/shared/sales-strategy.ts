import type { MessageDirection } from './contracts';

export type SalesStage =
  | 'discovering'
  | 'trust_building'
  | 'invite_ready'
  | 'invited'
  | 'scheduled'
  | 'paused'
  | 'closed';

export type StrategyGoal = 'answer' | 'call' | 'visit' | 'pause';

export type FactKey =
  | 'purpose'
  | 'budget'
  | 'area'
  | 'purchaseTiming'
  | 'decisionMaker'
  | 'financing'
  | 'callAvailability'
  | 'visitAvailability';

export type FactStatus = 'missing' | 'candidate' | 'confirmed' | 'conflict';

export interface FactSlot {
  key: FactKey;
  value?: string;
  status: FactStatus;
  sourceMessageIds: string[];
  updatedAt?: string;
}

export interface FactUpdate {
  key: FactKey;
  value: string;
  certainty: 'explicit' | 'candidate';
}

export type ObjectionKind =
  | 'wants_listing_first'
  | 'loan'
  | 'auction_risk'
  | 'fee'
  | 'distance_or_time'
  | 'decision_maker'
  | 'not_now'
  | 'not_interested'
  | 'other';

export interface ActiveObjection {
  kind: ObjectionKind;
  severity: 'normal' | 'high';
  status: 'active' | 'answered' | 'resolved';
  sourceMessageId: string;
}

export type CommitmentKind =
  | 'shared_need'
  | 'accepted_short_call'
  | 'selected_call_slot'
  | 'agreed_visit'
  | 'selected_visit_slot'
  | 'requested_address'
  | 'confirmed_visit';

export interface Commitment {
  kind: CommitmentKind;
  status: 'accepted' | 'declined';
  sourceMessageId: string;
  value?: string;
}

export type MessageIntent =
  | 'question'
  | 'fact'
  | 'positive'
  | 'scheduling'
  | 'objection'
  | 'pause'
  | 'refusal'
  | 'ack'
  | 'other';

export type OutboundAction =
  | 'answer'
  | 'objection_answer'
  | 'call_offer'
  | 'visit_invitation'
  | 'visit_confirmation'
  | 'pause_ack'
  | 'close_ack'
  | 'other';

export interface MessageSignals {
  sourceMessageId: string;
  intent: MessageIntent;
  factUpdates?: FactUpdate[];
  objection?: ActiveObjection;
  resolvedObjectionKinds?: ObjectionKind[];
  commitments?: Commitment[];
  explicitVisitIntent?: boolean;
  needsHumanReview?: boolean;
  outboundAction?: OutboundAction;
}

export interface NormalizedMessageEvent {
  schemaVersion: 1;
  eventId: string;
  accountId: string;
  contactKey: string;
  messageId: string;
  direction: MessageDirection;
  messageType: 'text' | 'image' | 'voice' | 'system' | 'other';
  text?: string;
  occurredAt: string;
  observedAt: string;
}

export type NextMove =
  | 'answer_question'
  | 'ask_one_fact'
  | 'propose_short_call'
  | 'handle_objection'
  | 'offer_visit'
  | 'offer_visit_slots'
  | 'confirm_visit'
  | 'acknowledge_pause'
  | 'acknowledge_close'
  | 'wait'
  | 'human_review';

export interface StrategyState {
  customerId: string;
  contactKey: string;
  bindingConfirmed: boolean;
  version: number;
  stage: SalesStage;
  facts: Record<FactKey, FactSlot>;
  activeObjection?: ActiveObjection;
  commitments: Commitment[];
  processedMessageIds: string[];
  lastProcessedMessageId?: string;
  lastInboundMessageId?: string;
  lastActualOutboundMessageId?: string;
  meaningfulInboundCount: number;
  awaiting: 'none' | 'customer' | 'human';
  proposedVisitSlots: string[];
  confirmedVisitAt?: string;
}

export interface StrategyDecision {
  stateVersion: number;
  triggerMessageId: string;
  nextMove: NextMove;
  goal?: StrategyGoal;
  reasonCodes: string[];
  requiredEvidenceIds: string[];
  mustInclude: string[];
  mustAvoid: string[];
  requiresHumanConfirmation: true;
}

export interface TransitionResult {
  state: StrategyState;
  decision: StrategyDecision;
  ignored: boolean;
}

const FACT_KEYS: FactKey[] = [
  'purpose',
  'budget',
  'area',
  'purchaseTiming',
  'decisionMaker',
  'financing',
  'callAvailability',
  'visitAvailability',
];

const CORE_FACT_KEYS: FactKey[] = ['purpose', 'budget', 'area', 'purchaseTiming'];

const HIGH_RISK_OBJECTIONS: ObjectionKind[] = ['loan', 'auction_risk', 'fee'];

const MEANINGFUL_INTENTS: MessageIntent[] = [
  'question',
  'fact',
  'positive',
  'scheduling',
  'objection',
];

const goalForMove = (nextMove: NextMove): StrategyGoal | undefined => {
  if (nextMove === 'answer_question' || nextMove === 'ask_one_fact' || nextMove === 'handle_objection') {
    return 'answer';
  }
  if (nextMove === 'propose_short_call') return 'call';
  if (nextMove === 'offer_visit' || nextMove === 'offer_visit_slots' || nextMove === 'confirm_visit') {
    return 'visit';
  }
  if (nextMove === 'acknowledge_pause') return 'pause';
  return undefined;
};

const decision = (
  state: StrategyState,
  triggerMessageId: string,
  nextMove: NextMove,
  reasonCodes: string[],
  mustInclude: string[] = [],
  mustAvoid: string[] = [],
): StrategyDecision => ({
  stateVersion: state.version,
  triggerMessageId,
  nextMove,
  goal: goalForMove(nextMove),
  reasonCodes,
  requiredEvidenceIds: [triggerMessageId],
  mustInclude,
  mustAvoid,
  requiresHumanConfirmation: true,
});

export const createInitialStrategyState = (
  customerId: string,
  contactKey: string,
  bindingConfirmed = false,
): StrategyState => ({
  customerId,
  contactKey,
  bindingConfirmed,
  version: 0,
  stage: 'discovering',
  facts: {
    purpose: { key: 'purpose', status: 'missing', sourceMessageIds: [] },
    budget: { key: 'budget', status: 'missing', sourceMessageIds: [] },
    area: { key: 'area', status: 'missing', sourceMessageIds: [] },
    purchaseTiming: { key: 'purchaseTiming', status: 'missing', sourceMessageIds: [] },
    decisionMaker: { key: 'decisionMaker', status: 'missing', sourceMessageIds: [] },
    financing: { key: 'financing', status: 'missing', sourceMessageIds: [] },
    callAvailability: { key: 'callAvailability', status: 'missing', sourceMessageIds: [] },
    visitAvailability: { key: 'visitAvailability', status: 'missing', sourceMessageIds: [] },
  },
  commitments: [],
  processedMessageIds: [],
  meaningfulInboundCount: 0,
  awaiting: 'none',
  proposedVisitSlots: [],
});

const applyFactUpdates = (
  facts: Record<FactKey, FactSlot>,
  updates: FactUpdate[],
  event: NormalizedMessageEvent,
): Record<FactKey, FactSlot> => {
  const nextFacts = { ...facts };
  for (const update of updates) {
    const previous = nextFacts[update.key];
    const value = update.value.trim();
    if (!value) continue;

    const incomingStatus: FactStatus = update.certainty === 'explicit' ? 'confirmed' : 'candidate';
    const conflicts = previous.status === 'confirmed'
      && incomingStatus === 'confirmed'
      && previous.value !== value;
    nextFacts[update.key] = {
      key: update.key,
      value: conflicts ? previous.value : value,
      status: conflicts ? 'conflict' : incomingStatus,
      sourceMessageIds: Array.from(new Set([...previous.sourceMessageIds, event.messageId])),
      updatedAt: event.occurredAt,
    };
  }
  return nextFacts;
};

const mergeCommitments = (
  existing: Commitment[],
  incoming: Commitment[],
): Commitment[] => {
  const next = [...existing];
  for (const commitment of incoming) {
    const index = next.findIndex((item) => item.kind === commitment.kind);
    if (index >= 0) next[index] = commitment;
    else next.push(commitment);
  }
  return next;
};

const hasAcceptedCommitment = (state: StrategyState, kinds: CommitmentKind[]): boolean =>
  state.commitments.some((item) => item.status === 'accepted' && kinds.includes(item.kind));

const confirmedCoreFactCount = (state: StrategyState): number =>
  CORE_FACT_KEYS.filter((key) => state.facts[key].status === 'confirmed').length;

const hasFactConflict = (state: StrategyState): boolean =>
  FACT_KEYS.some((key) => state.facts[key].status === 'conflict');

const hasUnresolvedHighRiskObjection = (state: StrategyState): boolean =>
  Boolean(
    state.activeObjection
    && HIGH_RISK_OBJECTIONS.includes(state.activeObjection.kind)
    && state.activeObjection.status !== 'resolved',
  );

const invitationGateOpen = (state: StrategyState, explicitVisitIntent: boolean): boolean => {
  if (!state.bindingConfirmed || state.stage === 'paused' || state.stage === 'closed') return false;
  if (hasFactConflict(state) || hasUnresolvedHighRiskObjection(state)) return false;
  if (explicitVisitIntent) return true;
  const hasCallCommitment = hasAcceptedCommitment(state, ['accepted_short_call', 'selected_call_slot']);
  return hasCallCommitment
    || (confirmedCoreFactCount(state) >= 2 && state.meaningfulInboundCount >= 2);
};

const applyResolvedObjections = (
  active: ActiveObjection | undefined,
  resolvedKinds: ObjectionKind[],
): ActiveObjection | undefined => {
  if (!active || !resolvedKinds.includes(active.kind)) return active;
  return { ...active, status: 'resolved' };
};

const reduceOutgoing = (
  state: StrategyState,
  event: NormalizedMessageEvent,
  signals: MessageSignals,
): TransitionResult => {
  if (!state.bindingConfirmed) {
    const nextState = { ...state, awaiting: 'human' as const };
    return {
      state: nextState,
      decision: decision(nextState, event.messageId, 'human_review', ['customer-binding-required']),
      ignored: false,
    };
  }
  if (state.stage === 'closed') {
    return {
      state,
      decision: decision(state, event.messageId, 'wait', ['closed-is-terminal']),
      ignored: false,
    };
  }

  let nextState: StrategyState = {
    ...state,
    lastActualOutboundMessageId: event.messageId,
    awaiting: 'customer',
  };

  if (signals.outboundAction === 'visit_invitation') {
    nextState = { ...nextState, stage: 'invited' };
  } else if (signals.outboundAction === 'visit_confirmation') {
    nextState = { ...nextState, stage: 'scheduled' };
  } else if (signals.outboundAction === 'pause_ack') {
    nextState = { ...nextState, stage: 'paused' };
  } else if (signals.outboundAction === 'close_ack') {
    nextState = { ...nextState, stage: 'closed' };
  } else if (signals.outboundAction === 'objection_answer' && nextState.activeObjection) {
    nextState = {
      ...nextState,
      activeObjection: { ...nextState.activeObjection, status: 'answered' },
    };
  }

  return {
    state: nextState,
    decision: decision(nextState, event.messageId, 'wait', ['actual-outbound-observed']),
    ignored: false,
  };
};

const reduceIncoming = (
  state: StrategyState,
  event: NormalizedMessageEvent,
  signals: MessageSignals,
): TransitionResult => {
  let nextState: StrategyState = {
    ...state,
    lastInboundMessageId: event.messageId,
    awaiting: 'none',
  };

  if (nextState.stage === 'closed') {
    return {
      state: nextState,
      decision: decision(nextState, event.messageId, 'wait', ['closed-is-terminal']),
      ignored: false,
    };
  }

  if (!nextState.bindingConfirmed) {
    nextState = { ...nextState, awaiting: 'human' };
    return {
      state: nextState,
      decision: decision(
        nextState,
        event.messageId,
        'human_review',
        ['customer-binding-required'],
        ['人工确认微信联系人与CRM客户身份'],
      ),
      ignored: false,
    };
  }

  if (signals.needsHumanReview || hasFactConflict(nextState)) {
    nextState = { ...nextState, awaiting: 'human' };
    return {
      state: nextState,
      decision: decision(
        nextState,
        event.messageId,
        'human_review',
        [signals.needsHumanReview ? 'ambiguous-message' : 'fact-conflict'],
      ),
      ignored: false,
    };
  }

  if (signals.intent === 'refusal' || signals.objection?.kind === 'not_interested') {
    nextState = { ...nextState, stage: 'closed', awaiting: 'human' };
    return {
      state: nextState,
      decision: decision(
        nextState,
        event.messageId,
        'acknowledge_close',
        ['explicit-refusal'],
        ['简短确认不再主动联系'],
        ['继续邀约', '制造紧迫感'],
      ),
      ignored: false,
    };
  }

  if (signals.intent === 'pause' || signals.objection?.kind === 'not_now') {
    nextState = { ...nextState, stage: 'paused', awaiting: 'human' };
    return {
      state: nextState,
      decision: decision(
        nextState,
        event.messageId,
        'acknowledge_pause',
        ['explicit-pause'],
        ['尊重客户提出的暂停时间'],
        ['继续追问', '催促邀约'],
      ),
      ignored: false,
    };
  }

  if (nextState.stage === 'paused') {
    if (!MEANINGFUL_INTENTS.includes(signals.intent)) {
      return {
        state: nextState,
        decision: decision(nextState, event.messageId, 'wait', ['paused-without-reengagement']),
        ignored: false,
      };
    }
    nextState = { ...nextState, stage: 'trust_building' };
  }

  const currentCommitments = signals.commitments ?? [];
  const selectedVisitAt = currentCommitments
    .find((item) => item.kind === 'selected_visit_slot' && item.status === 'accepted')?.value;
  const confirmedVisitAt = currentCommitments
    .find((item) => item.kind === 'confirmed_visit' && item.status === 'accepted')?.value;
  if (selectedVisitAt || confirmedVisitAt) {
    nextState = {
      ...nextState,
      stage: 'scheduled',
      confirmedVisitAt: confirmedVisitAt ?? selectedVisitAt,
    };
    return {
      state: nextState,
      decision: decision(
        nextState,
        event.messageId,
        'confirm_visit',
        ['visit-time-selected'],
        ['核对到店时间和地址'],
        ['追加第二个行动要求'],
      ),
      ignored: false,
    };
  }

  if (signals.objection && signals.objection.status !== 'resolved') {
    nextState = { ...nextState, stage: 'trust_building' };
    const mustAvoid = signals.objection.kind === 'wants_listing_first'
      ? ['在线匹配或推荐具体房源']
      : HIGH_RISK_OBJECTIONS.includes(signals.objection.kind)
        ? ['保证贷款、产权、腾退、费用结果']
        : [];
    return {
      state: nextState,
      decision: decision(
        nextState,
        event.messageId,
        'handle_objection',
        [`active-objection:${signals.objection.kind}`],
        ['先回应当前异议'],
        mustAvoid,
      ),
      ignored: false,
    };
  }

  if (hasUnresolvedHighRiskObjection(nextState)) {
    nextState = { ...nextState, stage: 'trust_building' };
    return {
      state: nextState,
      decision: decision(
        nextState,
        event.messageId,
        'handle_objection',
        [`unresolved-high-risk:${nextState.activeObjection?.kind ?? 'unknown'}`],
        ['先核实并回应高风险问题'],
        ['直接邀约', '保证结果'],
      ),
      ignored: false,
    };
  }

  const requestedVisit = signals.explicitVisitIntent
    || currentCommitments.some((item) =>
      item.status === 'accepted' && ['agreed_visit', 'requested_address'].includes(item.kind));
  if (requestedVisit) {
    nextState = { ...nextState, stage: 'invite_ready' };
    return {
      state: nextState,
      decision: decision(
        nextState,
        event.messageId,
        'offer_visit_slots',
        ['explicit-visit-intent'],
        ['只提供一组到店时间选择'],
      ),
      ignored: false,
    };
  }

  if (signals.intent === 'question') {
    if (invitationGateOpen(nextState, false)) nextState = { ...nextState, stage: 'invite_ready' };
    else nextState = { ...nextState, stage: 'trust_building' };
    return {
      state: nextState,
      decision: decision(
        nextState,
        event.messageId,
        'answer_question',
        ['customer-question-first'],
        ['先回答客户当前问题'],
        ['回避问题直接邀约'],
      ),
      ignored: false,
    };
  }

  if (nextState.stage === 'invited') {
    if (signals.intent === 'ack' || signals.intent === 'other') {
      return {
        state: nextState,
        decision: decision(nextState, event.messageId, 'wait', ['invitation-awaiting-substantive-response']),
        ignored: false,
      };
    }
    if (signals.intent === 'scheduling') {
      nextState = { ...nextState, stage: 'invite_ready' };
      return {
        state: nextState,
        decision: decision(nextState, event.messageId, 'offer_visit_slots', ['visit-time-needs-alternative']),
        ignored: false,
      };
    }
  }

  if (signals.intent === 'ack' || signals.intent === 'other') {
    return {
      state: nextState,
      decision: decision(nextState, event.messageId, 'wait', ['no-substantive-signal']),
      ignored: false,
    };
  }

  if (invitationGateOpen(nextState, false)) {
    nextState = { ...nextState, stage: 'invite_ready' };
    return {
      state: nextState,
      decision: decision(
        nextState,
        event.messageId,
        'offer_visit',
        ['invitation-gate-open'],
        ['说明到店价值并提出一个到店选择'],
        ['推荐具体房源', '同时提出多个行动要求'],
      ),
      ignored: false,
    };
  }

  const coreFacts = confirmedCoreFactCount(nextState);
  nextState = { ...nextState, stage: coreFacts > 0 ? 'trust_building' : 'discovering' };
  const nextMove: NextMove = coreFacts >= 2 ? 'propose_short_call' : 'ask_one_fact';
  return {
    state: nextState,
    decision: decision(
      nextState,
      event.messageId,
      nextMove,
      [coreFacts >= 2 ? 'needs-low-pressure-call-commitment' : 'missing-core-facts'],
      [coreFacts >= 2 ? '只提出一次短电话' : '只追问一个缺失事实'],
    ),
    ignored: false,
  };
};

export const reduceStrategy = (
  previous: StrategyState,
  event: NormalizedMessageEvent,
  signals: MessageSignals,
): TransitionResult => {
  if (event.contactKey !== previous.contactKey || signals.sourceMessageId !== event.messageId) {
    return {
      state: previous,
      decision: decision(
        previous,
        event.messageId,
        'human_review',
        ['message-source-mismatch'],
      ),
      ignored: true,
    };
  }
  if (!['incoming', 'outgoing', 'system'].includes(event.direction)
    || (event.direction === 'system') !== (event.messageType === 'system')) {
    return {
      state: previous,
      decision: decision(previous, event.messageId, 'human_review', ['invalid-message-direction']),
      ignored: true,
    };
  }
  if (event.direction === 'system') {
    return {
      state: previous,
      decision: decision(previous, event.messageId, 'wait', ['system-message-ignored']),
      ignored: true,
    };
  }
  if (previous.processedMessageIds.includes(event.messageId)) {
    return {
      state: previous,
      decision: decision(previous, event.messageId, 'wait', ['duplicate-message']),
      ignored: true,
    };
  }

  const facts = applyFactUpdates(previous.facts, signals.factUpdates ?? [], event);
  const commitments = mergeCommitments(previous.commitments, signals.commitments ?? []);
  const meaningfulInboundCount = previous.meaningfulInboundCount
    + (event.direction === 'incoming' && MEANINGFUL_INTENTS.includes(signals.intent) ? 1 : 0);
  const nextObjection = signals.objection
    ?? applyResolvedObjections(previous.activeObjection, signals.resolvedObjectionKinds ?? []);

  const state: StrategyState = {
    ...previous,
    version: previous.version + 1,
    facts,
    commitments,
    activeObjection: nextObjection,
    processedMessageIds: [...previous.processedMessageIds, event.messageId],
    lastProcessedMessageId: event.messageId,
    meaningfulInboundCount,
  };

  return event.direction === 'outgoing'
    ? reduceOutgoing(state, event, signals)
    : reduceIncoming(state, event, signals);
};
