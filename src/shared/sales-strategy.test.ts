import { describe, expect, it } from 'vitest';
import {
  createInitialStrategyState,
  reduceStrategy,
  type MessageSignals,
  type NormalizedMessageEvent,
  type StrategyState,
} from './sales-strategy';

const message = (
  id: string,
  direction: NormalizedMessageEvent['direction'] = 'incoming',
  text = id,
): NormalizedMessageEvent => ({
  schemaVersion: 1,
  eventId: `event-${id}`,
  accountId: 'wechat-account-1',
  contactKey: 'contact-1',
  messageId: id,
  direction,
  messageType: direction === 'system' ? 'system' : 'text',
  text,
  occurredAt: `2026-08-30T10:${id.replace(/\D/g, '').padStart(2, '0') || '00'}:00+08:00`,
  observedAt: '2026-08-30T10:30:00+08:00',
});

const signals = (
  id: string,
  input: Omit<MessageSignals, 'sourceMessageId'>,
): MessageSignals => ({ sourceMessageId: id, ...input });

const boundState = (): StrategyState => createInitialStrategyState('customer-1', 'contact-1', true);

describe('reduceStrategy', () => {
  it('ignores system text and precomputed sales signals without changing any strategy state', () => {
    const previous = reduceStrategy(boundState(), message('m1'), signals('m1', {
      intent: 'fact',
      factUpdates: [{ key: 'budget', value: '200万', certainty: 'explicit' }],
    })).state;
    const original = JSON.stringify(previous);
    const event = message('m2', 'system', '周六可以来，预算300万');
    const result = reduceStrategy(previous, event, signals('m2', {
      intent: 'scheduling',
      explicitVisitIntent: true,
      outboundAction: 'visit_invitation',
      factUpdates: [{ key: 'budget', value: '300万', certainty: 'explicit' }],
      commitments: [{
        kind: 'selected_visit_slot', status: 'accepted', sourceMessageId: 'm2', value: '周六',
      }],
    }));

    expect(result.ignored).toBe(true);
    expect(result.state).toBe(previous);
    expect(JSON.stringify(result.state)).toBe(original);
    expect(result.state.processedMessageIds).not.toContain('m2');
    expect(result.decision.reasonCodes).toContain('system-message-ignored');
  });

  it.each([
    ['unknown', 'text'],
    ['system', 'text'],
    ['incoming', 'system'],
    ['outgoing', 'system'],
  ])('does not reinterpret invalid direction %s / type %s as a customer message', (direction, messageType) => {
    const previous = boundState();
    const event = { ...message('m1'), direction, messageType } as NormalizedMessageEvent;
    const result = reduceStrategy(previous, event, signals('m1', {
      intent: 'scheduling', explicitVisitIntent: true,
      factUpdates: [{ key: 'budget', value: '300万', certainty: 'explicit' }],
    }));
    expect(result.ignored).toBe(true);
    expect(result.state).toBe(previous);
    expect(result.decision.nextMove).toBe('human_review');
    expect(result.decision.reasonCodes).toContain('invalid-message-direction');
  });

  it('deduplicates a repeated message without advancing the version', () => {
    const event = message('m1');
    const analysis = signals('m1', { intent: 'fact' });
    const first = reduceStrategy(boundState(), event, analysis);
    const repeated = reduceStrategy(first.state, event, analysis);

    expect(first.state.version).toBe(1);
    expect(repeated.ignored).toBe(true);
    expect(repeated.state).toBe(first.state);
    expect(repeated.state.version).toBe(1);
  });

  it.each(['ack', 'other'] as const)('does not reuse outbound waiting state for a later inbound %s', (intent) => {
    const sent = reduceStrategy(boundState(), message('m1', 'outgoing'), signals('m1', {
      intent: 'other', outboundAction: 'answer',
    }));
    const received = reduceStrategy(sent.state, message('m2', 'incoming'), signals('m2', { intent }));

    expect(sent.state.awaiting).toBe('customer');
    expect(sent.decision.reasonCodes).toEqual(['actual-outbound-observed']);
    expect(received.state.awaiting).toBe('none');
    expect(received.state.lastActualOutboundMessageId).toBe('m1');
    expect(received.state.lastInboundMessageId).toBe('m2');
    expect(received.decision.triggerMessageId).toBe('m2');
    expect(received.decision.reasonCodes).toEqual(['no-substantive-signal']);
    expect(received.decision.reasonCodes).not.toContain('actual-outbound-observed');
  });

  it('rejects a signal that is not bound to the same message id', () => {
    const result = reduceStrategy(
      boundState(),
      message('m1'),
      signals('different-message', { intent: 'fact' }),
    );

    expect(result.ignored).toBe(true);
    expect(result.state.version).toBe(0);
    expect(result.decision.nextMove).toBe('human_review');
  });

  it('requires manual CRM binding before producing a sales move', () => {
    const result = reduceStrategy(
      createInitialStrategyState('customer-1', 'contact-1'),
      message('m1'),
      signals('m1', { intent: 'question' }),
    );

    expect(result.decision.nextMove).toBe('human_review');
    expect(result.state.awaiting).toBe('human');
  });

  it('collects facts over consecutive messages and opens the invitation gate deterministically', () => {
    const first = reduceStrategy(
      boundState(),
      message('m1'),
      signals('m1', {
        intent: 'fact',
        factUpdates: [
          { key: 'purpose', value: '自住', certainty: 'explicit' },
          { key: 'budget', value: '200万左右', certainty: 'explicit' },
        ],
        commitments: [{ kind: 'shared_need', status: 'accepted', sourceMessageId: 'm1' }],
      }),
    );
    const second = reduceStrategy(
      first.state,
      message('m2'),
      signals('m2', {
        intent: 'fact',
        factUpdates: [{ key: 'area', value: '杭州主城区', certainty: 'explicit' }],
      }),
    );

    expect(first.state.stage).toBe('trust_building');
    expect(first.decision.nextMove).toBe('propose_short_call');
    expect(second.state.stage).toBe('invite_ready');
    expect(second.decision.nextMove).toBe('offer_visit');
    expect(second.state.facts.area.status).toBe('confirmed');
  });

  it('handles a request for listings without recommending a concrete property', () => {
    const result = reduceStrategy(
      boundState(),
      message('m1', 'incoming', '先发几套房子看看'),
      signals('m1', {
        intent: 'objection',
        objection: {
          kind: 'wants_listing_first',
          severity: 'normal',
          status: 'active',
          sourceMessageId: 'm1',
        },
      }),
    );

    expect(result.state.stage).toBe('trust_building');
    expect(result.decision.nextMove).toBe('handle_objection');
    expect(result.decision.mustAvoid).toContain('在线匹配或推荐具体房源');
  });

  it('blocks an invitation while a loan objection is unresolved', () => {
    const state = boundState();
    state.facts.purpose = {
      key: 'purpose',
      value: '自住',
      status: 'confirmed',
      sourceMessageIds: ['old-1'],
    };
    state.facts.budget = {
      key: 'budget',
      value: '250万',
      status: 'confirmed',
      sourceMessageIds: ['old-2'],
    };
    state.meaningfulInboundCount = 2;

    const result = reduceStrategy(
      state,
      message('m3', 'incoming', '法拍房贷款是不是很麻烦'),
      signals('m3', {
        intent: 'objection',
        objection: {
          kind: 'loan',
          severity: 'high',
          status: 'active',
          sourceMessageId: 'm3',
        },
      }),
    );

    expect(result.state.stage).toBe('trust_building');
    expect(result.decision.nextMove).toBe('handle_objection');
    expect(result.decision.mustAvoid).toContain('保证贷款、产权、腾退、费用结果');
  });

  it('pauses on an explicit defer and only resumes after substantive re-engagement', () => {
    const paused = reduceStrategy(
      boundState(),
      message('m1', 'incoming', '最近家里有事，下个月再联系'),
      signals('m1', { intent: 'pause' }),
    );
    const acknowledgement = reduceStrategy(
      paused.state,
      message('m2', 'incoming', '好的'),
      signals('m2', { intent: 'ack' }),
    );
    const resumed = reduceStrategy(
      acknowledgement.state,
      message('m3', 'incoming', '贷款的事情我想再了解一下'),
      signals('m3', { intent: 'question' }),
    );

    expect(paused.state.stage).toBe('paused');
    expect(paused.decision.nextMove).toBe('acknowledge_pause');
    expect(acknowledgement.state.stage).toBe('paused');
    expect(acknowledgement.decision.nextMove).toBe('wait');
    expect(resumed.state.stage).toBe('trust_building');
    expect(resumed.decision.nextMove).toBe('answer_question');
  });

  it('closes on an explicit refusal and treats the state as terminal', () => {
    const closed = reduceStrategy(
      boundState(),
      message('m1', 'incoming', '不用了，别联系我'),
      signals('m1', { intent: 'refusal' }),
    );
    const later = reduceStrategy(
      closed.state,
      message('m2', 'incoming', '好的'),
      signals('m2', { intent: 'ack' }),
    );

    expect(closed.state.stage).toBe('closed');
    expect(closed.decision.nextMove).toBe('acknowledge_close');
    expect(later.state.stage).toBe('closed');
    expect(later.decision.nextMove).toBe('wait');
  });

  it('moves to scheduled when the customer selects a visit slot', () => {
    const invited = reduceStrategy(
      boundState(),
      message('m1', 'outgoing', '周六上午或周日下午哪个方便'),
      signals('m1', { intent: 'other', outboundAction: 'visit_invitation' }),
    );
    const scheduled = reduceStrategy(
      invited.state,
      message('m2', 'incoming', '周六下午三点可以'),
      signals('m2', {
        intent: 'scheduling',
        commitments: [{
          kind: 'selected_visit_slot',
          status: 'accepted',
          sourceMessageId: 'm2',
          value: '周六下午三点',
        }],
      }),
    );

    expect(invited.state.stage).toBe('invited');
    expect(scheduled.state.stage).toBe('scheduled');
    expect(scheduled.state.confirmedVisitAt).toBe('周六下午三点');
    expect(scheduled.decision.nextMove).toBe('confirm_visit');
  });

  it('offers an alternative after a rejected slot but does not repeat on a pure acknowledgement', () => {
    const invited = reduceStrategy(
      boundState(),
      message('m1', 'outgoing'),
      signals('m1', { intent: 'other', outboundAction: 'visit_invitation' }),
    );
    const noTime = reduceStrategy(
      invited.state,
      message('m2', 'incoming', '周六不行'),
      signals('m2', { intent: 'scheduling' }),
    );
    const invitedAgain = reduceStrategy(
      noTime.state,
      message('m3', 'outgoing'),
      signals('m3', { intent: 'other', outboundAction: 'visit_invitation' }),
    );
    const ack = reduceStrategy(
      invitedAgain.state,
      message('m4', 'incoming', '好的'),
      signals('m4', { intent: 'ack' }),
    );

    expect(noTime.state.stage).toBe('invite_ready');
    expect(noTime.decision.nextMove).toBe('offer_visit_slots');
    expect(ack.state.stage).toBe('invited');
    expect(ack.decision.nextMove).toBe('wait');
  });

  it('marks conflicting explicit facts for human review instead of overwriting', () => {
    const first = reduceStrategy(
      boundState(),
      message('m1'),
      signals('m1', {
        intent: 'fact',
        factUpdates: [{ key: 'budget', value: '200万', certainty: 'explicit' }],
      }),
    );
    const conflict = reduceStrategy(
      first.state,
      message('m2'),
      signals('m2', {
        intent: 'fact',
        factUpdates: [{ key: 'budget', value: '300万', certainty: 'explicit' }],
      }),
    );

    expect(conflict.state.facts.budget.status).toBe('conflict');
    expect(conflict.state.facts.budget.value).toBe('200万');
    expect(conflict.decision.nextMove).toBe('human_review');
  });

  it('replays the same event sequence to an identical state and decision', () => {
    const events: Array<[NormalizedMessageEvent, MessageSignals]> = [
      [message('m1'), signals('m1', {
        intent: 'fact',
        factUpdates: [{ key: 'purpose', value: '自住', certainty: 'explicit' }],
      })],
      [message('m2'), signals('m2', {
        intent: 'fact',
        factUpdates: [{ key: 'budget', value: '220万', certainty: 'explicit' }],
      })],
    ];
    const replay = () => events.reduce(
      (result, [event, analysis]) => reduceStrategy(result.state, event, analysis),
      {
        state: boundState(),
        decision: null,
        ignored: false,
      } as { state: StrategyState; decision: ReturnType<typeof reduceStrategy>['decision'] | null; ignored: boolean },
    );

    expect(replay()).toEqual(replay());
  });
});
