import type { StrategyDecision, StrategyState } from '../shared/sales-strategy';
import { replyAcknowledgements } from '../shared/reply-policy';
import type { CustomerQueueItem, ReplyDraft, WorkGoal } from './types';

export interface ReplyGenerationContext {
  customer: CustomerQueueItem;
  state: StrategyState;
  decision: StrategyDecision;
  revision?: number;
}

type ReplyAction = ReplyDraft['action'];

interface DraftCopy {
  text: string;
  reason: string;
  warning?: string;
  action?: ReplyAction;
}

const tones: ReplyDraft['tone'][] = ['稳妥', '推荐', '更直接'];

const makeDrafts = (
  copies: [DraftCopy, DraftCopy, DraftCopy],
  stateVersion: number,
  triggerMessageId: string,
  evidenceIds: string[],
  idPrefix: string,
  revision: number,
): ReplyDraft[] => copies.map((copy, index) => ({
  id: `${idPrefix}-${tones[index]}-${revision}`,
  basedOnStateVersion: stateVersion,
  triggerMessageId,
  tone: tones[index],
  text: copy.text,
  reason: copy.reason,
  evidenceIds,
  warning: copy.warning,
  action: copy.action,
  requiresHumanConfirmation: true,
}));

const visitCopies = (customer: CustomerQueueItem): [DraftCopy, DraftCopy, DraftCopy] => {
  const action: ReplyAction = { kind: 'offer_visit', label: '询问到店意愿并核对接待时间' };
  const warning = '接待时间和所需时长尚未核实，不代表已预约。';
  return [
    {
      text: `${customer.name}，可以先到公司把法拍流程、费用和风险了解清楚。您哪天比较方便？我核对接待安排后再跟您确认。`,
      reason: '先解释到店价值，再把时间选择权交给客户。',
      warning,
      action,
    },
    {
      text: `${customer.name}，如果您愿意，我们可以到公司当面把关心的问题聊清楚。您什么时候方便？接待时间我核对后再回复您。`,
      reason: '主动提出到店了解，不编造可选时段或沟通时长。',
      warning,
      action,
    },
    {
      text: `${customer.name}，您看哪天方便来公司了解一下？您告诉我方便的时间，我先核对接待安排，确认后再约定。`,
      reason: '用一个明确问题推进邀约，保留双方确认的前提。',
      warning,
      action,
    },
  ];
};

const answerCopies = (customer: CustomerQueueItem): [DraftCopy, DraftCopy, DraftCopy] => {
  return [
    {
      text: `${customer.name}，您这个问题我先核实清楚，再把能确定的信息回复您。暂时不能确认的地方，我也会说明。`,
      reason: '资料不足时先核实当前问题，不擅自套用贷款或其他专业结论。',
      warning: '复制前核对客户的问题，并补充已经核实的信息。',
    },
    {
      text: `${customer.name}，收到，我先把您问的这件事核实清楚，再具体答复您，免得给您不准确的信息。`,
      reason: '承接当前提问，没有依据时不转移话题或安排电话。',
      warning: '复制前补充已核实的答复；本地模板不代表知识库已经有答案。',
    },
    {
      text: `${customer.name}，这个我先确认一下再回复您，避免说得不准确。`,
      reason: '简短确认需要核实，不虚构专业信息或预约时段。',
      warning: '请先核对资料，再补充针对当前问题的答案。',
    },
  ];
};

const visitRequestCopies = (customer: CustomerQueueItem, requestsAddress: boolean): [DraftCopy, DraftCopy, DraftCopy] => {
  const texts = requestsAddress ? [
    '我先核对公司的准确地址和定位，再发给您。您打算哪天过来了解？我一起确认接待时间。',
    '地址和定位我核对后发您。您哪天比较方便过来？咱们先把接待时间对好。',
    '我先核对地址和接待安排。您想哪天过来了解？确认后我再把定位发您。',
  ] : [
    '可以先约时间到公司了解流程、费用和风险。您哪天方便？我核对接待安排后再跟您确认。',
    '收到，您想过来了解。您哪天方便？我先确认接待时间，再把公司地址和定位发您。',
    '来之前我们先把时间对好。您打算哪天过来？我核对接待安排和地址后再回复您。',
  ];
  return texts.map((text) => ({
    text: `${customer.name}，${text}`,
    reason: requestsAddress ? '先回应本条消息的地址问题，再核对一次到访安排。' : '承接本条消息的主动到访意愿，先核对接待安排。',
    warning: '复制前核对公司地址、定位和接待时间；尚未确认预约。',
    action: { kind: 'offer_visit', label: '核对到访时间与公司地址' },
  })) as [DraftCopy, DraftCopy, DraftCopy];
};

const callCopies = (customer: CustomerQueueItem): [DraftCopy, DraftCopy, DraftCopy] => {
  const action: ReplyAction = { kind: 'offer_call', label: '确认一个短电话时段' };
  return [
    {
      text: `${customer.name}，文字里有些细节容易说不清。我可以先用电话把流程讲一遍，您方便时告诉我就行。`,
      reason: '降低电话沟通压力。',
      action,
    },
    {
      text: `${customer.name}，如果您愿意，我们可以先电话沟通一下。您什么时候方便？我核对时间后再跟您确认。`,
      reason: '由客户提出方便时间，不编造空闲时段或通话时长。',
      action,
    },
    {
      text: `${customer.name}，您方便电话聊一下吗？我们先把需要核实的情况过一遍，时间再一起确认。`,
      reason: '只邀请一次电话，先核对条件，不承诺一次沟通解决全部问题。',
      warning: '通话时间和时长尚未确认。',
      action,
    },
  ];
};

const acknowledgementCopies = (customer: CustomerQueueItem, move: 'acknowledge_pause' | 'acknowledge_close'): [DraftCopy, DraftCopy, DraftCopy] =>
  replyAcknowledgements(move).map((copy) => ({ ...copy, text: `${customer.name}，${copy.text}` })) as [DraftCopy, DraftCopy, DraftCopy];

const missingCoreFact = (state: StrategyState): 'purpose' | 'budget' | 'area' | 'purchaseTiming' => {
  const keys: Array<'purpose' | 'budget' | 'area' | 'purchaseTiming'> = [
    'purpose',
    'budget',
    'area',
    'purchaseTiming',
  ];
  return keys.find((key) => state.facts[key].status !== 'confirmed') ?? 'purchaseTiming';
};

const factQuestion = (
  customer: CustomerQueueItem,
  key: ReturnType<typeof missingCoreFact>,
): [DraftCopy, DraftCopy, DraftCopy] => {
  const questions = {
    purpose: ['您这次主要考虑自住还是投资？', '您买房更偏自住，还是兼顾保值？', '我先确认一下，您这次核心需求是自住吗？'],
    budget: ['您大致准备把总预算控制在什么范围？', '为了把流程讲得更准，您的预算上限大概是多少？', '我先确认一个关键点：总预算大概控制在多少？'],
    area: ['您目前优先考虑杭州哪个区域？', '您更关注哪个区，通勤范围有要求吗？', '我先确认一下，您优先看哪个区域？'],
    purchaseTiming: ['您大概计划什么时候落实购房？', '您希望近期就推进，还是先了解一段时间？', '时间上您希望这个月推进，还是再往后安排？'],
  } as const;
  const action: ReplyAction = { kind: 'ask_fact', label: `确认${key}` };
  return questions[key].map((question) => ({
    text: `${customer.name}，${question}`,
    reason: '每次只补充一个邀约前需要确认的事实。',
    action,
  })) as [DraftCopy, DraftCopy, DraftCopy];
};

const listingObjectionCopies = (customer: CustomerQueueItem): [DraftCopy, DraftCopy, DraftCopy] => {
  const action: ReplyAction = { kind: 'ask_fact', label: '确认客户购房用途' };
  return [
    {
      text: `${customer.name}，可以先给您看真实成交案例，但线上不直接按具体房源做匹配。我们要先把法拍流程和风险讲清楚。您这次主要考虑自住还是投资？`,
      reason: '说明服务边界后，只确认一个基础需求。',
      action,
    },
    {
      text: `${customer.name}，房源很多，但先发几套容易忽略产权、腾退和付款节点。我们可以先看案例、把买法讲清楚。您更偏自住还是投资？`,
      reason: '先解释不直接发房源的原因，再推进一个事实。',
      action,
    },
    {
      text: `${customer.name}，我先不给您随便推具体房源，先用真实案例把买法和风险说明白。您这次核心需求是自住吗？`,
      reason: '守住房源匹配边界，同时继续了解客户。',
      action,
    },
  ];
};

const familyDecisionCopies = (customer: CustomerQueueItem): [DraftCopy, DraftCopy, DraftCopy] => [
  {
    text: `${customer.name}，没问题，您先和家人商量好，不着急定时间。方便时我们再沟通。`,
    reason: '尊重家人共同决定，先不安排具体时段。',
  },
  {
    text: `${customer.name}，可以的，等您和家人商量好，方便时可以一起来了解流程、费用和风险，时间再一起确认。`,
    reason: '说明一起了解的内容，保留家人意见与时间确认的前提。',
    warning: '家人意见尚待确认，不记作已预约。',
  },
  {
    text: `${customer.name}，先听听家人的想法就好。有想了解的问题，随时发我，我们说清楚再决定要不要过来。`,
    reason: '先承接家人顾虑，不催促到店，保留问题沟通入口。',
  },
];

const highRiskObjectionCopies = (customer: CustomerQueueItem): [DraftCopy, DraftCopy, DraftCopy] => {
  const action: ReplyAction = { kind: 'offer_call', label: '确认一个短电话时段' };
  return [
    {
      text: `${customer.name}，这个问题要结合实际条件和资料核实，我不能直接保证结果。您方便电话聊一下吗？我们先把需要核实的情况过一遍。`,
      reason: '不作保证，先转入低压力核实。',
      action,
    },
    {
      text: `${customer.name}，这个风险点确实要提前核实，不能只凭一句话判断。您什么时候方便电话沟通？我核对时间后再确认。`,
      reason: '正面回应风险，并只提出一次电话。',
      action,
    },
    {
      text: `${customer.name}，我先不承诺结果，把需要核实的条件逐项确认。您方便电话聊一下吗？具体时间我们再一起对好。`,
      reason: '先征询电话意愿，不编造时段或保证核实结果。',
      warning: '复制前确认没有加入贷款、产权或腾退保证。',
      action,
    },
  ];
};

const confirmationCopies = (customer: CustomerQueueItem, state: StrategyState): [DraftCopy, DraftCopy, DraftCopy] => {
  const time = state.confirmedVisitAt;
  const preference = time ? `您提到的${time}` : '您方便的到店时间';
  const action: ReplyAction = { kind: 'confirm_visit', label: '核对客户时间意向与接待安排' };
  const warning = '客户表达的时间意向不等于公司已完成预约，请核对接待安排和地址。';
  return [
    {
      text: `${customer.name}，收到。关于${preference}，我先核对接待安排和准确地址，再跟您确认。`,
      reason: '承接客户的时间意向，不把它当作已完成的预约。',
      warning,
      action,
    },
    {
      text: `${customer.name}，${preference}我先确认一下是否能接待，核实后再把时间和地址一起回复您。`,
      reason: '先核实能否接待，不声称已预留时段或已发送地址。',
      warning,
      action,
    },
    {
      text: `${customer.name}，好的，我先核对${preference}的接待安排，确认后再约定，避免让您白跑。`,
      reason: '只推进一次接待核实，预约仍待双方确认。',
      warning,
      action,
    },
  ];
};

const copiesForDecision = (
  context: ReplyGenerationContext,
): [DraftCopy, DraftCopy, DraftCopy] | null => {
  const { customer, state, decision } = context;
  // Historical interest is not the customer's current question. Never let this
  // response bypass a refusal, unresolved risk, or human-review decision.
  const currentVisit = state.commitments.filter((item) => item.sourceMessageId === decision.triggerMessageId
    && item.status === 'accepted' && ['requested_address', 'agreed_visit'].includes(item.kind));
  if (currentVisit.length && ['answer_question', 'offer_visit', 'offer_visit_slots'].includes(decision.nextMove)) {
    return visitRequestCopies(customer, currentVisit.some((item) => item.kind === 'requested_address'));
  }
  switch (decision.nextMove) {
    case 'answer_question':
      return answerCopies(customer);
    case 'ask_one_fact':
      return factQuestion(customer, missingCoreFact(state));
    case 'propose_short_call':
      return callCopies(customer);
    case 'handle_objection':
      if (state.activeObjection?.kind === 'decision_maker') return familyDecisionCopies(customer);
      return state.activeObjection?.kind === 'wants_listing_first'
        ? listingObjectionCopies(customer)
        : highRiskObjectionCopies(customer);
    case 'offer_visit':
    case 'offer_visit_slots':
      return visitCopies(customer);
    case 'confirm_visit':
      return confirmationCopies(customer, state);
    case 'acknowledge_pause':
      return acknowledgementCopies(customer, 'acknowledge_pause');
    case 'acknowledge_close':
      return acknowledgementCopies(customer, 'acknowledge_close');
    case 'wait':
    case 'human_review':
      return null;
  }
};

export const buildStrategyReplyDrafts = (context: ReplyGenerationContext): ReplyDraft[] => {
  const copies = copiesForDecision(context);
  if (!copies) return [];
  return makeDrafts(
    copies,
    context.decision.stateVersion,
    context.decision.triggerMessageId,
    context.decision.requiredEvidenceIds,
    context.decision.nextMove,
    context.revision ?? 0,
  );
};

/**
 * Compatibility wrapper for the current App.tsx. New incremental-message code should
 * use buildStrategyReplyDrafts so every draft is tied to a strategy-state version.
 */
export const buildReplyDrafts = (
  customer: CustomerQueueItem,
  goal: WorkGoal,
  revision = 0,
): ReplyDraft[] => {
  const triggerMessageId = customer.messages.at(-1)?.id ?? `legacy-${customer.id}`;
  const copies = goal === 'visit'
    ? visitCopies(customer)
    : goal === 'answer'
      ? answerCopies(customer)
      : goal === 'call'
        ? callCopies(customer)
        : acknowledgementCopies(customer, 'acknowledge_pause');
  const evidenceIds = ['E1', 'E2', 'E3']
    .filter((id) => customer.evidence.some((item) => item.id === id));
  return makeDrafts(copies, 0, triggerMessageId, evidenceIds, goal, revision);
};
