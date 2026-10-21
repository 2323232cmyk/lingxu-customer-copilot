import { describe, expect, it } from 'vitest';
import {
  createInitialStrategyState,
  reduceStrategy,
  type NormalizedMessageEvent,
  type ObjectionKind,
} from './sales-strategy';
import { analyzeMessageSignals } from './message-signals';

const event = (
  text: string,
  direction: NormalizedMessageEvent['direction'] = 'incoming',
  messageType: NormalizedMessageEvent['messageType'] = 'text',
  id = 'm1',
): NormalizedMessageEvent => ({
  schemaVersion: 1,
  eventId: `event-${id}`,
  accountId: 'account-1',
  contactKey: 'contact-1',
  messageId: id,
  direction,
  messageType,
  text,
  occurredAt: '2026-08-30T10:00:00+08:00',
  observedAt: '2026-08-30T10:00:01+08:00',
});

describe('analyzeMessageSignals inbound', () => {
  it.each([
    '不要再联系我了',
    '我不考虑法拍了',
    '不用了谢谢',
  ])('recognizes an explicit refusal: %s', (text) => {
    const result = analyzeMessageSignals(event(text));
    expect(result.intent).toBe('refusal');
    expect(result.objection?.kind).toBe('not_interested');
  });

  it.each([
    '最近家里有事，下个月再联系吧',
    '目前先不看，过段时间再说',
    '最近比较忙，晚点再联系',
    '暂时不用了，后面再说',
  ])('recognizes an explicit pause: %s', (text) => {
    const result = analyzeMessageSignals(event(text));
    expect(result.intent).toBe('pause');
    expect(result.objection?.kind).toBe('not_now');
  });

  it('flags a negated refusal as ambiguous instead of closing the customer', () => {
    const result = analyzeMessageSignals(event('我不是不考虑，只是最近比较忙'));
    expect(result.intent).toBe('pause');
    expect(result.needsHumanReview).toBe(true);
    expect(result.objection?.kind).not.toBe('not_interested');
  });

  it.each(['好的', '嗯嗯', '收到', '可以', '谢谢'])('keeps a plain acknowledgement neutral: %s', (text) => {
    const result = analyzeMessageSignals(event(text));
    expect(result.intent).toBe('ack');
    expect(result.commitments).toBeUndefined();
    expect(result.explicitVisitIntent).toBeUndefined();
  });

  it.each<[string, ObjectionKind]>([
    ['你先给我发几套房子看看', 'wants_listing_first'],
    ['法拍房贷款是不是很麻烦？', 'loan'],
    ['你们服务费怎么收？', 'fee'],
    ['房子有人占用的话腾退会不会有问题？', 'auction_risk'],
    ['法拍有哪些风险？', 'auction_risk'],
    ['工作日太忙，我没时间过去', 'distance_or_time'],
    ['这个我得先和老婆商量一下', 'decision_maker'],
  ])('recognizes objection %s as %s', (text, kind) => {
    const result = analyzeMessageSignals(event(text));
    expect(result.intent).toBe('objection');
    expect(result.objection?.kind).toBe(kind);
  });

  it('extracts explicit purpose, budget, area and purchase timing facts', () => {
    const result = analyzeMessageSignals(event(
      '我主要是自住，预算220万以内，主要看滨江和萧山，计划三个月内买',
    ));
    const facts = Object.fromEntries((result.factUpdates ?? []).map((item) => [item.key, item]));

    expect(result.intent).toBe('fact');
    expect(facts.purpose).toMatchObject({ value: '自住', certainty: 'explicit' });
    expect(facts.budget).toMatchObject({ value: '220万以内', certainty: 'explicit' });
    expect(facts.area).toMatchObject({ value: '滨江、萧山', certainty: 'explicit' });
    expect(facts.purchaseTiming).toMatchObject({ value: '三个月内', certainty: 'explicit' });
  });

  it.each(['我准备自住，预算200万', '准备自住', '我们准备自住'])('recognizes a stated preparation to buy for personal use: %s', (text) => {
    expect(analyzeMessageSignals(event(text)).factUpdates)
      .toContainEqual({ key: 'purpose', value: '自住', certainty: 'explicit' });
  });

  it.each(['我不准备自住', '我没准备自住', '不是准备自住', '没有准备自住', '并非准备自住'])(
    'does not turn a negated preparation into a confirmed purpose: %s', (text) => {
      expect(analyzeMessageSignals(event(text)).factUpdates?.some((fact) => fact.key === 'purpose') ?? false).toBe(false);
    },
  );

  it.each([
    '我准备自住，预算300万，想在萧山。', '我想在萧山', '我想在萧山区买房', '我住滨江，想在萧山',
  ])('recognizes a directly stated desired area without taking the current address: %s', (text) => {
    expect(analyzeMessageSignals(event(text)).factUpdates)
      .toContainEqual({ key: 'area', value: '萧山', certainty: 'explicit' });
  });

  it.each([
    '我不想在萧山', '我没有想在萧山', '我不是想在萧山', '我住在萧山', '我想在萧山上班',
  ])('does not invent a buying area from negation, residence or unrelated plans: %s', (text) => {
    expect(analyzeMessageSignals(event(text)).factUpdates?.some((fact) => fact.key === 'area') ?? false).toBe(false);
  });

  it.each([
    '家人同意后，我周末过来了解[握手]',
    '家人同意后，我周六下午三点可以到你们公司',
    '爱人确认后，我会周六下午三点准时到你们公司',
  ])('keeps a family-dependent visit conditional instead of accepting a booking: %s', (text) => {
    const result = analyzeMessageSignals(event(text));
    expect(result.intent).toBe('objection');
    expect(result.objection?.kind).toBe('decision_maker');
    expect(result.explicitVisitIntent).toBe(false);
    expect(result.commitments).toBeUndefined();
    expect(result.needsHumanReview).toBe(false);
  });

  it('keeps availability tentative until family approval has actually happened', () => {
    const result = analyzeMessageSignals(event('老婆同意以后，周末方便到你们公司'));
    expect(result.factUpdates).toContainEqual({ key: 'visitAvailability', value: '周末方便', certainty: 'candidate' });
    expect(result.explicitVisitIntent).toBe(false);
    expect(result.commitments).toBeUndefined();
  });

  it('does not mistake already obtained family approval for a pending condition', () => {
    const result = analyzeMessageSignals(event('家人已经同意了，我会周六下午三点准时到你们公司'));
    expect(result.objection).toBeUndefined();
    expect(result.commitments).toContainEqual({
      kind: 'confirmed_visit', status: 'accepted', sourceMessageId: 'm1', value: '周六下午三点',
    });
  });

  it('extracts a short-call commitment and its selected time', () => {
    const result = analyzeMessageSignals(event('今天下午四点给我打电话吧'));
    expect(result.intent).toBe('scheduling');
    expect(result.commitments).toContainEqual({
      kind: 'selected_call_slot',
      status: 'accepted',
      sourceMessageId: 'm1',
      value: '今天下午四点',
    });
  });

  it('recognizes a low-pressure call commitment without inventing a visit', () => {
    const result = analyzeMessageSignals(event('可以电话聊一下'));
    expect(result.commitments).toContainEqual({
      kind: 'accepted_short_call',
      status: 'accepted',
      sourceMessageId: 'm1',
      value: undefined,
    });
    expect(result.explicitVisitIntent).toBe(false);
  });

  it('recognizes an explicit request to visit or receive the address', () => {
    const result = analyzeMessageSignals(event('可以，把你们公司地址发我，我过去了解一下'));
    expect(result.intent).toBe('positive');
    expect(result.explicitVisitIntent).toBe(true);
    expect(result.commitments?.[0]?.kind).toBe('requested_address');
  });

  it.each(['你们公司在哪里？周末可以过来了解吗？', '你们公司在哪里？', '门店在哪儿？'])('recognizes a location question as an address request, without a booking: %s', (text) => {
    const result = analyzeMessageSignals(event(text));
    expect(result.commitments).toContainEqual({ kind: 'requested_address', status: 'accepted', sourceMessageId: 'm1' });
    expect(result.commitments?.some((item) => ['selected_visit_slot', 'confirmed_visit'].includes(item.kind))).not.toBe(true);
    expect(result.needsHumanReview).toBe(false);
  });

  it.each(['周末可以过来了解吗？', '周六下午三点可以过来了解吗？'])('keeps tentative visit availability as interest instead of a confirmed slot: %s', (text) => {
    const result = analyzeMessageSignals(event(text));
    expect(result.commitments).toContainEqual({ kind: 'agreed_visit', status: 'accepted', sourceMessageId: 'm1' });
    expect(result.commitments?.some((item) => ['selected_visit_slot', 'confirmed_visit'].includes(item.kind))).not.toBe(true);
    expect(result.needsHumanReview).toBe(false);
  });

  it.each(['周末不能过来了解', '我不想过来了解', '家人同意后我周末过来了解'])('does not turn negative or family-conditional wording into an accepted visit: %s', (text) => {
    const result = analyzeMessageSignals(event(text));
    expect(result.commitments).toBeUndefined(); expect(result.explicitVisitIntent).not.toBe(true);
  });

  it('recognizes a selected visit time only when the destination is explicit', () => {
    const result = analyzeMessageSignals(event('周六下午三点到你们公司可以'));
    expect(result.intent).toBe('scheduling');
    expect(result.needsHumanReview).toBe(false);
    expect(result.commitments).toContainEqual({
      kind: 'selected_visit_slot',
      status: 'accepted',
      sourceMessageId: 'm1',
      value: '周六下午三点',
    });
  });

  it('recognizes an explicit visit confirmation', () => {
    const result = analyzeMessageSignals(event('我会周六下午三点准时到你们公司'));
    expect(result.intent).toBe('scheduling');
    expect(result.commitments).toContainEqual({
      kind: 'confirmed_visit',
      status: 'accepted',
      sourceMessageId: 'm1',
      value: '周六下午三点',
    });
  });

  it.each(['周六下午三点可以', '周六可以'])('does not guess whether an ambiguous time is for a call or visit: %s', (text) => {
    const result = analyzeMessageSignals(event(text));
    expect(result.intent).toBe('scheduling');
    expect(result.needsHumanReview).toBe(true);
    expect(result.commitments).toBeUndefined();
  });

  it.each([
    '周六不方便到你们公司',
    '我没空去公司',
    '今天不方便电话',
  ])('does not turn a negative availability statement into a commitment: %s', (text) => {
    const result = analyzeMessageSignals(event(text));
    expect(result.objection?.kind).toBe('distance_or_time');
    expect(result.commitments).toBeUndefined();
    expect(result.explicitVisitIntent).not.toBe(true);
  });

  it('does not turn a positive financing statement into a loan objection', () => {
    const result = analyzeMessageSignals(event('我的征信没问题，可以正常贷款'));
    expect(result.objection).toBeUndefined();
    expect(result.intent).toBe('fact');
    expect(result.factUpdates).toContainEqual({
      key: 'financing',
      value: '我的征信没问题，可以正常贷款',
      certainty: 'explicit',
    });
  });

  it('does not treat a context-free price question as a service-fee objection', () => {
    const result = analyzeMessageSignals(event('多少钱？'));
    expect(result.intent).toBe('question');
    expect(result.objection).toBeUndefined();
  });

  it('requires review for an incoming voice or image without a transcript', () => {
    const result = analyzeMessageSignals(event('', 'incoming', 'voice'));
    expect(result.intent).toBe('other');
    expect(result.needsHumanReview).toBe(true);
  });
});

describe('analyzeMessageSignals outbound', () => {
  it.each<[string, string]>([
    ['周六上午或周日下午，您看哪个时间方便来公司？', 'visit_invitation'],
    ['第一次沟通大概40分钟，周六上午或周日下午，您看哪个时间顺一点？', 'visit_invitation'],
    ['周六下午三点已给您留好，我把公司地址和停车方式发您。', 'visit_confirmation'],
    ['线上不直接按具体房源匹配，要先把流程和风险讲清楚。', 'objection_answer'],
    ['您先忙，我这边先暂停跟进，等您方便再联系。', 'pause_ack'],
    ['收到，已记录不再联系，不再打扰。', 'close_ack'],
    ['电话里十分钟能说清楚，您今天下午还是晚上方便吗？', 'call_offer'],
  ])('classifies a sent message as outbound action %s', (text, action) => {
    const result = analyzeMessageSignals(event(text, 'outgoing'));
    expect(result.intent).toBe('other');
    expect(result.outboundAction).toBe(action);
  });

  it('keeps inbound and outbound interpretation separate for similar visit wording', () => {
    const text = '周六下午来你们公司可以吗？';
    const incoming = analyzeMessageSignals(event(text, 'incoming'));
    const outgoing = analyzeMessageSignals(event(text, 'outgoing'));

    expect(incoming.explicitVisitIntent).toBe(true);
    expect(outgoing.outboundAction).toBe('visit_invitation');
    expect(outgoing.commitments).toBeUndefined();
  });

  it('falls back to a normal answer instead of inventing an outbound invitation', () => {
    const result = analyzeMessageSignals(event('这个问题我先给您说明一下。', 'outgoing'));
    expect(result.outboundAction).toBe('answer');
  });
});

describe('message analysis and strategy replay', () => {
  it('replays consecutive inbound and actual outbound messages into a scheduled visit', () => {
    const initial = createInitialStrategyState('customer-1', 'contact-1', true);
    const firstEvent = event('我主要是自住，预算220万以内', 'incoming', 'text', 'm1');
    const first = reduceStrategy(initial, firstEvent, analyzeMessageSignals(firstEvent));
    const secondEvent = event('我主要看滨江和萧山', 'incoming', 'text', 'm2');
    const second = reduceStrategy(first.state, secondEvent, analyzeMessageSignals(secondEvent));
    const inviteEvent = event(
      '第一次沟通大概40分钟，周六上午或周日下午，您看哪个时间顺一点？',
      'outgoing',
      'text',
      'm3',
    );
    const invited = reduceStrategy(second.state, inviteEvent, analyzeMessageSignals(inviteEvent));
    const selectedEvent = event('周六下午三点到你们公司可以', 'incoming', 'text', 'm4');
    const scheduled = reduceStrategy(invited.state, selectedEvent, analyzeMessageSignals(selectedEvent));

    expect(second.decision.nextMove).toBe('offer_visit');
    expect(invited.state.stage).toBe('invited');
    expect(scheduled.state.stage).toBe('scheduled');
    expect(scheduled.state.confirmedVisitAt).toBe('周六下午三点');
  });
});
