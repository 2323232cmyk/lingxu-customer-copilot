import { describe, expect, it } from 'vitest';
import { deriveReplyPolicy, replyAcknowledgements, replyPolicyBlockReason, type ReplyPolicyMessage } from './reply-policy';

const message = (text: string, id = 'm1', direction: ReplyPolicyMessage['direction'] = 'incoming'): ReplyPolicyMessage => ({
  id, direction, sender: direction === 'incoming' ? '合成客户' : '我', text, sentAt: '2026-08-31T10:00:00+08:00',
});

describe('main-process reply policy', () => {
  it.each([
    ['流程是怎样的？', 'answer_question'],
    ['不要再联系我了', 'acknowledge_close'],
    ['最近比较忙，过段时间再联系', 'acknowledge_pause'],
    ['好的', 'wait'],
    ['周六下午可以', 'human_review'],
    ['[图片]', 'human_review'],
    ['', 'human_review'],
  ] as const)('reuses the existing strategy for %s', (text, nextMove) => {
    const policy = deriveReplyPolicy([message(text)]);
    expect(policy.nextMove).toBe(nextMove);
    expect(policy.triggerSourceId).toBe('chat:1');
    expect(JSON.stringify(policy)).not.toContain(text || '合成客户');
  });

  it('does not expose customer facts or message text in the policy', () => {
    const policy = deriveReplyPolicy([message('我准备自住，预算300万，想在萧山。')], { name: 'private-customer', budget: 'private-budget', phone: 'private-phone' });
    expect(JSON.stringify(policy)).not.toMatch(/private-|萧山|300万|我准备/);
  });

  it('does not revive a stopped conversation because another acknowledgement arrives', () => {
    const policy = deriveReplyPolicy([message('不考虑了', '1'), message('收到', '2')]);
    expect(policy).toMatchObject({ stage: 'closed', nextMove: 'wait' });
    expect(replyPolicyBlockReason(policy)).toBeUndefined();
  });

  it('waits after an actual outbound message instead of drafting another invitation', () => {
    const policy = deriveReplyPolicy([message('想了解一下', '1'), message('您哪天方便来公司了解？', '2', 'outgoing')]);
    expect(policy).toMatchObject({ stage: 'invited', nextMove: 'wait' });
    expect(policy.reasonCodes).toContain('actual-outbound-observed');
  });

  it('keeps the latest unrecognized media in the decision even when it has text-like metadata', () => {
    const policy = deriveReplyPolicy([message('贷款怎么处理？'), { ...message('不是图片正文，仅为元数据', 'm2'), messageType: 'image' }]);
    expect(policy.nextMove).toBe('human_review');
    expect(replyPolicyBlockReason(policy)).toBeUndefined();
  });

  it('preserves message ordering and ignores trailing system notices', () => {
    const policy = deriveReplyPolicy([
      { ...message('流程是怎样的？', 'later'), sortSequence: '12' },
      { ...message('最近比较忙', 'earlier'), sortSequence: '11' },
      { ...message('系统通知', 'system', 'system'), sortSequence: '13', messageType: 'system' },
    ]);
    expect(policy.nextMove).toBe('answer_question');
    expect(policy.triggerSourceId).toBe('chat:1');
  });

  it('does not ask the model to invent reception slots just because a visit is requested', () => {
    const policy = deriveReplyPolicy([message('我想去公司了解一下')]);
    expect(policy.nextMove).toBe('offer_visit_slots');
    expect(policy.mustInclude.join('')).toContain('核实接待');
    expect(policy.mustInclude.join('')).not.toContain('一组到店时间选择');
    expect(policy.mustAvoid.join('')).toContain('已经完成预约');
  });

  it('blocks missing policy but permits a user-requested clarification for contradictory facts', () => {
    expect(replyPolicyBlockReason(undefined)).toContain('尚未核实');
    const policy = deriveReplyPolicy([message('预算300万', '1'), message('预算400万', '2')]);
    expect(policy.nextMove).toBe('human_review');
    expect(replyPolicyBlockReason(policy)).toBeUndefined();
    expect(replyAcknowledgements(policy.nextMove)).toBeNull();
  });

  it.each([
    ['不要再联系我', 'acknowledge_close', 'closed'],
    ['最近比较忙，过段时间再联系', 'acknowledge_pause', 'paused'],
  ] as const)('keeps %s effective even when prior facts conflict', (text, nextMove, stage) => {
    const policy = deriveReplyPolicy([message('预算300万', '1'), message('预算400万', '2'), message(text, '3')]);
    expect(policy).toMatchObject({ nextMove, stage, triggerSourceId: 'chat:3' });
  });

  it.each(['acknowledge_pause', 'acknowledge_close'] as const)('limits %s to deterministic acknowledgements', (move) => {
    const copies = replyAcknowledgements(move);
    expect(copies).toHaveLength(3);
    expect(new Set(copies?.map((copy) => copy.text)).size).toBe(3);
    expect(copies?.every((copy) => !/到公司|到店|电话|预约|优惠|保证|家里|周[一二三四五六日天]|已记录|[？?]/.test(copy.text))).toBe(true);
  });
});
