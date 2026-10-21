import { describe, expect, it } from 'vitest';
import type { WechatLiveMessage } from '../shared/contracts';
import { customers } from './sample-data';
import { replayLiveStrategy } from './strategy-runtime';
import { createWechatCustomer } from './wechat-inbox';

const liveMessage = (
  id: string,
  direction: WechatLiveMessage['direction'],
  text: string,
): WechatLiveMessage => ({
  id,
  contactKey: 'contact:one',
  direction,
  sender: direction === 'system' ? '微信系统' : direction === 'incoming' ? '客户' : '我',
  text,
  sentAt: `2026-08-30T10:0${id.slice(-1)}:00.000Z`,
  observedAt: `2026-08-30T10:0${id.slice(-1)}:01.000Z`,
  messageType: direction === 'system' ? 'system' : 'text',
});

describe('replayLiveStrategy', () => {
  it('keeps the existing reply strategy when system notices mention appointments or budget', () => {
    const humanMessages = [
      liveMessage('m1', 'incoming', '我想先了解一下贷款'),
      liveMessage('m3', 'outgoing', '先核实贷款条件，再安排后面的沟通'),
    ];
    const expected = replayLiveStrategy(customers[0], 'contact:one', humanMessages);
    const replayed = replayLiveStrategy(customers[0], 'contact:one', [
      liveMessage('m0', 'system', '[微信系统] 预算300万'),
      ...humanMessages,
      liveMessage('m2', 'system', '[微信系统] 周六可以来'),
      liveMessage('m4', 'system', '[微信系统] 周六可以来，预算500万'),
    ]);

    expect(expected).not.toBeNull();
    expect(replayed).toEqual(expected);
    expect(replayed?.state.version).toBe(2);
    expect(replayed?.state.processedMessageIds).toEqual(['m1', 'm3']);
  });

  it('does not create a reply strategy from system-only history', () => {
    expect(replayLiveStrategy(customers[0], 'contact:one', [
      liveMessage('m1', 'system', '周六可以来，预算300万'),
    ])).toBeNull();
  });

  it('does not treat unknown or wrongly paired human directions as incoming intent', () => {
    const message = liveMessage('m1', 'incoming', '周六可以来，预算300万');
    expect(replayLiveStrategy(customers[0], 'contact:one', [
      { ...message, direction: 'unknown' } as unknown as WechatLiveMessage,
      { ...message, id: 'm2', messageType: 'system' },
    ])).toBeNull();
  });

  it('replans from the newest inbound message instead of a fixed reply goal', () => {
    const result = replayLiveStrategy(customers[0], 'contact:one', [
      liveMessage('m1', 'incoming', '我想先了解一下'),
      liveMessage('m2', 'outgoing', '可以，我们电话里用十分钟先讲清楚，下午方便吗？'),
      liveMessage('m3', 'incoming', '法拍房贷款是不是很麻烦？'),
    ]);
    expect(result?.decision.nextMove).toBe('handle_objection');
    expect(result?.state.activeObjection?.kind).toBe('loan');
  });

  it('replans the five-message media conversation around pending family approval, not the previous outbound', () => {
    const customer = createWechatCustomer({ contactKey: 'contact:one', displayName: '测试客户', kind: 'contact' });
    const messages: WechatLiveMessage[] = [
      liveMessage('m1', 'incoming', '我准备自住，预算300万，想在萧山。'),
      { ...liveMessage('m2', 'incoming', '[图片]'), messageType: 'image', mediaKind: 'image' },
      { ...liveMessage('m3', 'incoming', '[表情]'), messageType: 'other', mediaKind: 'sticker' },
      liveMessage('m4', 'outgoing', '没问题，流程和费用都可以当面详细讲清楚。'),
      liveMessage('m5', 'incoming', '家人同意后，我周末过来了解[握手]'),
    ];
    const beforeLast = replayLiveStrategy(customer, 'contact:one', messages.slice(0, -1));
    const result = replayLiveStrategy(customer, 'contact:one', messages);

    expect(beforeLast?.decision.reasonCodes).toEqual(['actual-outbound-observed']);
    expect(result?.state.processedMessageIds).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
    expect(result?.state.stage).toBe('trust_building');
    expect(result?.state.awaiting).toBe('none');
    expect(result?.decision.triggerMessageId).toBe('m5');
    expect(result?.decision.nextMove).toBe('handle_objection');
    expect(result?.decision.reasonCodes).toEqual(['active-objection:decision_maker']);
    expect(result?.state.activeObjection).toMatchObject({ kind: 'decision_maker', sourceMessageId: 'm5' });
    expect(result?.state.confirmedVisitAt).toBeUndefined();
    expect(result?.state.commitments).toEqual([]);
    expect(result?.state.facts.visitAvailability.status).toBe('missing');
    expect(result?.state.facts.purpose).toMatchObject({ value: '自住', status: 'confirmed', sourceMessageIds: ['m1'] });
    expect(result?.state.facts.budget).toMatchObject({ value: '300万', status: 'confirmed', sourceMessageIds: ['m1'] });
    expect(result?.state.facts.area).toMatchObject({ value: '萧山', status: 'confirmed', sourceMessageIds: ['m1'] });
  });

  it('stops invitation progression after an explicit refusal', () => {
    const result = replayLiveStrategy(customers[0], 'contact:one', [
      liveMessage('m1', 'incoming', '不用了谢谢，我不考虑了'),
    ]);
    expect(result?.state.stage).toBe('closed');
    expect(result?.decision.nextMove).toBe('acknowledge_close');
  });

  it('replays same-second messages in actual sequence order before deciding the latest response', () => {
    const older = { ...liveMessage('m1', 'incoming', '我想先了解一下'), id: 'z-older', sortSequence: '9007199254740992' };
    const newer = { ...liveMessage('m1', 'incoming', '不用了谢谢，我不考虑了'), id: 'a-newer', sortSequence: '9007199254740993' };
    const result = replayLiveStrategy(customers[0], 'contact:one', [newer, older]);
    expect(result?.state.processedMessageIds).toEqual(['z-older', 'a-newer']);
    expect(result?.decision.nextMove).toBe('acknowledge_close');
  });

  it('keeps input order for same-second imported messages without a source sequence', () => {
    const first = { ...liveMessage('m1', 'incoming', '我想先了解一下'), id: 'z-first' };
    const second = { ...liveMessage('m1', 'incoming', '法拍房贷款是不是很麻烦？'), id: 'a-second' };
    expect(replayLiveStrategy(customers[0], 'contact:one', [first, second])?.state.processedMessageIds)
      .toEqual(['z-first', 'a-second']);
  });
});
