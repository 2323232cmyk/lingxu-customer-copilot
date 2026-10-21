import { describe, expect, it } from 'vitest';
import {
  createInitialStrategyState,
  reduceStrategy,
  type MessageSignals,
  type NormalizedMessageEvent,
} from '../shared/sales-strategy';
import { customers } from './sample-data';
import { buildReplyDrafts, buildStrategyReplyDrafts } from './reply-engine';
import { analyzeMessageSignals } from '../shared/message-signals';
import type { WechatLiveMessage } from '../shared/contracts';
import { createWechatCustomer } from './wechat-inbox';
import { replayLiveStrategy } from './strategy-runtime';

const event = (id: string): NormalizedMessageEvent => ({
  schemaVersion: 1,
  eventId: `event-${id}`,
  accountId: 'account-1',
  contactKey: 'contact-1',
  messageId: id,
  direction: 'incoming',
  messageType: 'text',
  text: '先发几套房子看看',
  occurredAt: '2026-08-30T10:00:00+08:00',
  observedAt: '2026-08-30T10:00:01+08:00',
});

const listingSignals = (id: string): MessageSignals => ({
  sourceMessageId: id,
  intent: 'objection',
  objection: {
    kind: 'wants_listing_first',
    severity: 'normal',
    status: 'active',
    sourceMessageId: id,
  },
});

describe('buildReplyDrafts', () => {
  it.each([
    '你们公司在哪里？周末可以过来了解吗？',
    '你们公司在哪里？',
    '公司地址发我一下',
  ])('answers the current address request without inventing financing or an appointment: %s', (text) => {
    const customer = createWechatCustomer({ contactKey: 'contact-1', displayName: '合成客户', kind: 'contact' });
    const incoming = { ...event('address-now'), text };
    const transition = reduceStrategy(createInitialStrategyState(customer.id, 'contact-1', true), incoming, analyzeMessageSignals(incoming));
    const original = JSON.stringify(transition.state);
    const drafts = buildStrategyReplyDrafts({ customer, ...transition });
    expect(drafts).toHaveLength(3);
    for (const draft of drafts) {
      expect(draft.text).toMatch(/地址|定位/);
      expect(draft.text).not.toMatch(/首付|征信|贷款|流水|十点|两点|四点|七点|留好|预定|已预约|已安排|定在|\d+分钟|\d+号/);
      expect(draft.warning).toMatch(/核对.*地址.*时间/);
      expect(draft.requiresHumanConfirmation).toBe(true);
      expect(draft.triggerMessageId).toBe('address-now');
      expect(draft.basedOnStateVersion).toBe(transition.state.version);
      expect(draft.evidenceIds).toContain('address-now');
      expect((draft.text.match(/[？?]/g) ?? []).length).toBeLessThanOrEqual(1);
    }
    expect(transition.state.confirmedVisitAt).toBeUndefined();
    expect(JSON.stringify(transition.state)).toBe(original);
  });

  it.each(['周末可以过来了解吗？', '周六下午三点可以过来了解吗？', '我想去公司了解一下'])('responds to a visit enquiry without claiming that reception is booked: %s', (text) => {
    const incoming = { ...event('visit-enquiry'), text };
    const transition = reduceStrategy(createInitialStrategyState(customers[0].id, 'contact-1', true), incoming, analyzeMessageSignals(incoming));
    const drafts = buildStrategyReplyDrafts({ customer: customers[0], ...transition });
    expect(drafts).toHaveLength(3);
    expect(drafts.every((draft) => /核对|确认接待/.test(draft.text))).toBe(true);
    expect(drafts.every((draft) => !/首付|征信|贷款|流水|已给您留好|已安排|定在|十点|两点|\d+分钟/.test(draft.text))).toBe(true);
    expect(drafts.every((draft) => draft.warning?.includes('接待时间'))).toBe(true);
    expect(transition.state.confirmedVisitAt).toBeUndefined();
  });

  it('does not carry an old address request into the reply to a new unrelated question', () => {
    const address = { ...event('old-address'), text: '公司地址发我一下' };
    const first = reduceStrategy(createInitialStrategyState(customers[0].id, 'contact-1', true), address, analyzeMessageSignals(address));
    const question = { ...event('current-question'), text: '你怎么称呼？' };
    const next = reduceStrategy(first.state, question, analyzeMessageSignals(question));
    expect(next.decision.nextMove).toBe('answer_question');
    expect(next.state.commitments.some((item) => item.kind === 'requested_address')).toBe(true);
    const drafts = buildStrategyReplyDrafts({ customer: customers[0], ...next });
    expect(drafts).toHaveLength(3);
    expect(drafts.every((draft) => !/首付|征信|贷款|流水|公司地址|定位/.test(draft.text))).toBe(true);
    expect(drafts.every((draft) => draft.triggerMessageId === 'current-question')).toBe(true);
  });

  it('uses an information-checking fallback for general questions, not the financing template', () => {
    const incoming = { ...event('general-now'), text: '这些资料能发文字版吗？' };
    const next = reduceStrategy(createInitialStrategyState(customers[0].id, 'contact-1', true), incoming, analyzeMessageSignals(incoming));
    expect(next.decision.nextMove).toBe('answer_question');
    const drafts = buildStrategyReplyDrafts({ customer: customers[0], ...next });
    expect(drafts).toHaveLength(3);
    expect(drafts.every((draft) => !/首付|征信|贷款|流水|四点|七点/.test(draft.text))).toBe(true);
    expect(buildReplyDrafts({ ...customers[0], messages: [{ id: 'general-now', direction: 'incoming', sender: '合成客户', sentAt: '10:00', text: incoming.text }] }, 'answer')
      .every((draft) => !/首付|征信|贷款|流水/.test(draft.text))).toBe(true);
  });
  it('returns three traceable drafts for a visit goal', () => {
    const drafts = buildReplyDrafts(customers[0], 'visit');
    expect(drafts).toHaveLength(3);
    expect(drafts[1].evidenceIds).toContain('E3');
    expect(drafts.every((draft) => draft.text.length > 20)).toBe(true);
    expect(drafts.every((draft) => draft.requiresHumanConfirmation)).toBe(true);
    expect(drafts.every((draft) => draft.triggerMessageId === 'm4')).toBe(true);
  });

  it('respects a pause goal without adding urgency', () => {
    const drafts = buildReplyDrafts(customers[3], 'pause');
    expect(drafts[1].text).toContain('暂停跟进');
    expect(drafts.map((draft) => draft.text).join('')).not.toMatch(/抓紧|家里的事情|预约|\d+点/);
  });

  it.each(['visit', 'call'] as const)('keeps %s invitations active without invented slots or durations', (goal) => {
    for (const revision of [0, 1, 4]) {
      const drafts = buildReplyDrafts(customers[0], goal, revision);
      expect(drafts).toHaveLength(3);
      for (const draft of drafts) {
        expect(draft.text).toMatch(goal === 'visit' ? /公司|到店/ : /电话/);
        expect(draft.text).not.toMatch(/周[一二三四五六日天末]|今天|明天|下午|晚上|\d+分钟|十分钟|四十分钟|四点|七点|留好|留意|定在|已预约/);
        expect(draft.action?.kind).toBe(goal === 'visit' ? 'offer_visit' : 'offer_call');
      }
    }
  });

  it.each([undefined, '周六下午三点'])('does not treat a customer time preference as a confirmed booking: %s', (time) => {
    const state = { ...createInitialStrategyState(customers[0].id, 'contact-1', true), confirmedVisitAt: time };
    const transition = reduceStrategy(state, event('confirmation'), { sourceMessageId: 'confirmation', intent: 'scheduling', commitments: [{ kind: 'confirmed_visit', status: 'accepted', sourceMessageId: 'confirmation', value: time ?? '客户选择的时间' }] });
    const drafts = buildStrategyReplyDrafts({ customer: customers[0], ...transition, state });
    expect(drafts).toHaveLength(3);
    for (const draft of drafts) {
      expect(draft.text).toMatch(/核对|确认一下/);
      expect(draft.text).not.toMatch(/已给您留好|已预约|已安排|定在|我现在把地址发您|您刚才选的时间/);
      expect(draft.warning).toContain('不等于公司已完成预约');
    }
  });

  it('binds strategy-aware drafts to the exact state version and trigger message', () => {
    const initial = createInitialStrategyState(customers[0].id, 'contact-1', true);
    const transition = reduceStrategy(initial, event('live-1'), listingSignals('live-1'));
    const drafts = buildStrategyReplyDrafts({
      customer: customers[0],
      state: transition.state,
      decision: transition.decision,
    });

    expect(drafts).toHaveLength(3);
    expect(drafts.every((draft) => draft.basedOnStateVersion === 1)).toBe(true);
    expect(drafts.every((draft) => draft.triggerMessageId === 'live-1')).toBe(true);
    expect(drafts.every((draft) => draft.evidenceIds.includes('live-1'))).toBe(true);
  });

  it('keeps a listing-first response inside the service boundary with at most one action', () => {
    const initial = createInitialStrategyState(customers[0].id, 'contact-1', true);
    const transition = reduceStrategy(initial, event('live-2'), listingSignals('live-2'));
    const drafts = buildStrategyReplyDrafts({
      customer: customers[0],
      state: transition.state,
      decision: transition.decision,
    });

    expect(drafts.every((draft) => draft.action?.kind === 'ask_fact')).toBe(true);
    expect(drafts.every((draft) => (draft.text.match(/[？?]/g) ?? []).length <= 1)).toBe(true);
    expect(drafts.map((draft) => draft.text).join('')).not.toContain('给您推荐具体房源');
  });

  it('keeps all three replies relevant to the five-message family-dependent visit, without booking a time', () => {
    const customer = createWechatCustomer({ contactKey: 'contact-1', displayName: '测试客户', kind: 'contact' });
    const messages: WechatLiveMessage[] = [
      { id: 'm1', direction: 'incoming', messageType: 'text', text: '我准备自住，预算300万，想在萧山。' },
      { id: 'm2', direction: 'incoming', messageType: 'image', mediaKind: 'image', text: '[图片]' },
      { id: 'm3', direction: 'incoming', messageType: 'other', mediaKind: 'sticker', text: '[表情]' },
      { id: 'm4', direction: 'outgoing', messageType: 'text', text: '没问题，流程和费用都可以当面详细讲清楚。' },
      { id: 'm5', direction: 'incoming', messageType: 'text', text: '家人同意后，我周末过来了解[握手]' },
    ].map((message, index) => ({
      ...message, contactKey: 'contact-1', sender: message.direction === 'incoming' ? '测试客户' : '我',
      sentAt: `2026-08-30T10:0${index}:00.000Z`, observedAt: `2026-08-30T10:0${index}:01.000Z`,
    })) as WechatLiveMessage[];
    const replayed = replayLiveStrategy(customer, 'contact-1', messages);
    if (!replayed) throw new Error('Expected a strategy from the synthetic conversation');
    const originalState = JSON.stringify(replayed.state);
    const drafts = buildStrategyReplyDrafts({ customer, ...replayed });

    expect(replayed.decision.reasonCodes).toEqual(['active-objection:decision_maker']);
    expect(drafts).toHaveLength(3);
    expect(new Set(drafts.map((draft) => draft.text)).size).toBe(3);
    expect(drafts.map((draft) => draft.tone)).toEqual(['稳妥', '推荐', '更直接']);
    for (const draft of drafts) {
      expect(draft.text).toContain('家人');
      expect(draft.text.length).toBeLessThan(90);
      expect(draft.text).not.toMatch(/贷款|征信|首付|流水|腾退|产权|保证|包过|拍中/);
      expect(draft.text).not.toMatch(/今天|明天|下午|晚上|周[一二三四五六日天]|星期|\d+点|\d+分钟|留好|已安排|已预约|定在/);
      expect(draft.action).toBeUndefined();
      expect(draft.basedOnStateVersion).toBe(5);
      expect(draft.triggerMessageId).toBe('m5');
      expect(draft.evidenceIds).toEqual(['m5']);
      expect(draft.requiresHumanConfirmation).toBe(true);
    }
    expect(drafts.some((draft) => draft.text.includes('流程、费用和风险'))).toBe(true);
    expect(replayed.state.confirmedVisitAt).toBeUndefined();
    expect(JSON.stringify(replayed.state)).toBe(originalState);
  });

  it('also respects an existing request to discuss the purchase with family', () => {
    const message = { ...event('family-1'), text: '这个我得先和老婆商量一下' };
    const transition = reduceStrategy(
      createInitialStrategyState(customers[0].id, 'contact-1', true), message, analyzeMessageSignals(message),
    );
    const drafts = buildStrategyReplyDrafts({ customer: customers[0], ...transition });
    expect(drafts).toHaveLength(3);
    expect(drafts.every((draft) => draft.text.includes('家人') && !draft.action)).toBe(true);
    expect(drafts.every((draft) => draft.evidenceIds.includes('family-1'))).toBe(true);
  });

  it('leaves a real high-risk objection on its existing response branch', () => {
    const message = { ...event('loan-1'), text: '法拍房贷款是不是很麻烦？' };
    const transition = reduceStrategy(
      createInitialStrategyState(customers[0].id, 'contact-1', true), message, analyzeMessageSignals(message),
    );
    const drafts = buildStrategyReplyDrafts({ customer: customers[0], ...transition });
    expect(transition.state.activeObjection?.kind).toBe('loan');
    expect(drafts).toHaveLength(3);
    expect(drafts.every((draft) => draft.action?.kind === 'offer_call')).toBe(true);
    expect(drafts.every((draft) => !draft.text.includes('家人'))).toBe(true);
    expect(drafts.every((draft) => !/十分钟|四点|七点|今天|下午|晚上/.test(draft.text))).toBe(true);
  });

  it('does not generate a copyable draft while human review is required', () => {
    const initial = createInitialStrategyState(customers[0].id, 'contact-1', false);
    const analysis: MessageSignals = { sourceMessageId: 'live-3', intent: 'question' };
    const transition = reduceStrategy(initial, event('live-3'), analysis);
    const drafts = buildStrategyReplyDrafts({
      customer: customers[0],
      state: transition.state,
      decision: transition.decision,
    });

    expect(transition.decision.nextMove).toBe('human_review');
    expect(drafts).toEqual([]);
  });
});
