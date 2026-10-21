import type {
  ActiveObjection,
  Commitment,
  FactUpdate,
  MessageIntent,
  MessageSignals,
  NormalizedMessageEvent,
  ObjectionKind,
  OutboundAction,
} from './sales-strategy';

const ACK_ONLY = /^(?:好|好的|好啊|嗯|嗯嗯|知道了|收到|明白|可以|行|没问题|谢谢|感谢)$/;
const EXPLICIT_NO_CONTACT = /(?:不要|别)(?:再)?(?:给我)?(?:打电话|发消息|发微信|联系)|不用联系|停止联系|不想再聊|拉黑|删除我/;
const EXPLICIT_REFUSAL = /(?:不考虑了|不考虑法拍|没有兴趣|没兴趣|不想了解|不需要了|不用了谢谢|已经买好了|已经买了|找好房了)/;
const NEGATED_REFUSAL = /(?:不是|并非)(?:不考虑|没兴趣|不需要)/;
const EXPLICIT_PAUSE = /(?:下个月|过段时间|晚点|以后|回头|忙完)(?:再联系|再说|再聊)|(?:暂时|最近|目前|现在).{0,8}(?:不考虑|不需要|不用|没空|不方便|先不看)|先放一放|先别联系|家里有事|最近比较忙/;

const LISTING_FIRST = /(?:先|先给我|能不能先|可以先).{0,8}(?:发|看|推荐).{0,8}(?:房子|房源)|发几套|具体房源.{0,6}(?:发|看|推荐)|有没有.{0,8}(?:房子|房源)/;
const LOAN_TERMS = /贷款|按揭|征信|首付|流水/;
const LOAN_CONCERN = /(?:贷款|按揭|征信|首付|流水).{0,12}(?:吗|呢|怎么|如何|能不能|可不可以|麻烦|难|办不了|有问题|担心)|(?:能不能|可不可以|怎么|如何).{0,8}(?:贷款|按揭)/;
const FEE_CONCERN = /(?:服务费|中介费|佣金|收费|费用).{0,10}(?:多少|怎么|贵|高|吗|呢|算|收)|(?:怎么收费|收多少钱|多少钱服务费)/;
const AUCTION_RISK_CONCERN = /(?:腾退|产权|占用|查封|税费|保证金|悔拍|法拍风险|风险).{0,12}(?:吗|呢|怎么|如何|能不能|麻烦|问题|担心|风险|坑)|(?:会不会|是不是).{0,8}(?:腾退|产权|占用|查封|税费|保证金|悔拍)|(?:法拍|房子).{0,8}(?:有什么|哪些)风险/;
const TIME_DISTANCE_CONCERN = /工作日.{0,6}(?:忙|没时间|不方便)|没时间|时间不确定|(?:不方便|没空|不能|来不了|去不了|到不了).{0,8}(?:过去|到店|到你们公司|去你们公司|来你们公司|到公司|去公司|来公司|电话|通话)|(?:过去|到店|到你们公司|去你们公司|来你们公司|到公司|去公司|来公司).{0,6}(?:不方便|不行|来不了|去不了|到不了)|太远|距离.{0,4}远|离我.{0,4}远|路上.{0,6}多久|过去.{0,6}多久/;
const DECISION_MAKER_CONCERN = /(?:要|得|需要|先).{0,4}(?:和|问)(?:老婆|老公|爱人|父母|家人).{0,5}(?:商量|确认|同意)|(?:家人|老婆|老公|爱人|父母).{0,5}(?:不同意|没同意)|(?:我|自己).{0,5}(?:做不了主|决定不了)/;
const PENDING_FAMILY_APPROVAL = /(?:家人|老婆|老公|爱人|父母)(?:都)?(?:同意|确认)(?:后|以后|之后|了再|了才|的话)/;

const QUESTION = /[？?]|(?:吗|呢|怎么|如何|多少|是不是|能不能|可不可以)(?:[。.]|$)/;
const POSITIVE = /(?:想|愿意|可以)(?:继续)?了解|有兴趣|你继续说|可以聊聊/;

const VISIT_TERMS = /到店|到你们公司|去你们公司|来你们公司|到公司|去公司|来公司|我过去|(?:过去|过来)了解/;
const ADDRESS_REQUEST = /(?:公司|门店)?地址.{0,5}(?:发我|给我|在哪|哪里)|(?:发我|给我).{0,4}(?:公司|门店)?地址|(?:公司|门店)(?:具体)?(?:在(?:哪里|哪儿|哪|什么(?:位置|地方))|怎么走)(?=[？?，,。.]|$)/;
const VISIT_INTENT = /(?:想|准备|打算|可以|方便|什么时候).{0,8}(?:到店|到你们公司|去你们公司|来你们公司|去公司|到公司|(?:过去|过来)(?:了解|看看))|(?:我|我们).{0,5}(?:过去|过来|到店|去你们公司).{0,5}(?:了解|看看|可以|行)?/;
const VISIT_CONFIRMATION = /(?:确认|就定|确定|准时).{0,12}(?:到店|到你们公司|去你们公司|到公司|过去)|(?:我|我们)(?:会|一定|准时).{0,8}(?:到店|到你们公司|去你们公司|到公司|过去)/;
const NEGATIVE_VISIT = /(?:不方便|不能|不可以|不想|没空|来不了|去不了|到不了|不会).{0,8}(?:到店|到你们公司|去你们公司|来你们公司|到公司|去公司|来公司|过去|过来)|(?:到店|到你们公司|去你们公司|来你们公司|到公司|去公司|来公司|过去|过来).{0,6}(?:不方便|不行|来不了|去不了|到不了)/;
const CALL_TERMS = /电话|通话|打给我|给我打|电话聊|电话说|电话沟通/;
const CALL_ACCEPTANCE = /(?:可以|方便|行|没问题).{0,6}(?:打|接|用)?(?:电话|通话)|(?:给我|你).{0,4}打电话|电话.{0,6}(?:聊|说|沟通)(?:可以|吧|也行)?/;

const TIME_EXPRESSION = /(?:今天|明天|后天|本周|这周|下周|周[一二三四五六日天]|星期[一二三四五六日天])(?:(?:上午|下午|晚上|中午|早上)?(?:[0-2]?\d|[一二三四五六七八九十两]{1,3})点(?:半|\d{1,2}分?)?)?|(?:上午|下午|晚上|中午|早上)(?:[0-2]?\d|[一二三四五六七八九十两]{1,3})点(?:半|\d{1,2}分?)?/;
const TIME_ACCEPTANCE = /可以|方便|行|没问题|就这个|就定|能到|会到|准时到/;
const NEGATIVE_TIME_ACCEPTANCE = /不可以|不方便|不行|没空|不能|来不了|去不了|到不了/;

const BUDGET_AFTER_LABEL = /(?:预算|总价|上限|最多|控制在).{0,8}?((?:\d+(?:\.\d+)?|[一二三四五六七八九十百两]+)\s*万(?:元)?(?:左右|以内|以下|上下)?)/;
const BUDGET_BEFORE_LABEL = /((?:\d+(?:\.\d+)?|[一二三四五六七八九十百两]+)\s*万(?:元)?(?:左右|以内|以下|上下)?).{0,5}(?:预算|总价|上限)/;
const PURCHASE_TIMING_AFTER_PLAN = /(?:计划|打算|准备|希望).{0,8}(这个月|下个月|三个月内|半年内|年底前|今年|明年|近期).{0,8}(?:买|购房|拍|落实|定下来)/;
const PURCHASE_TIMING_BEFORE_BUY = /(这个月|下个月|三个月内|半年内|年底前|今年|明年|近期).{0,8}(?:买|购房|拍|落实|定下来)/;
const VISIT_AVAILABILITY = /(?:周末|工作日|周[一二三四五六日天]|星期[一二三四五六日天])(?:上午|下午|晚上)?(?:有时间|方便|可以)/;
const CALL_AVAILABILITY = /(?:周末|工作日|周[一二三四五六日天]|星期[一二三四五六日天]|今天|明天|上午|下午|晚上).{0,6}(?:方便|可以|有时间).{0,5}(?:电话|通话)|(?:电话|通话).{0,5}(?:周末|工作日|周[一二三四五六日天]|今天|明天|上午|下午|晚上).{0,5}(?:方便|可以|有时间)?/;
const NEGATIVE_CALL = /(?:不方便|不能|不可以|没空).{0,6}(?:电话|通话)|(?:电话|通话).{0,6}(?:不方便|不行|没空)/;
const OUTBOUND_VISIT_TEMPLATE = /第一次(?:沟通)?.{0,18}(?:40分钟|四十分钟).{0,24}(?:周末哪天|哪个时间|时间顺一点)|我先给您留意.{0,12}(?:周|星期).{0,8}时间/;

const HANGZHOU_AREAS = [
  '杭州主城区',
  '主城区',
  '上城',
  '拱墅',
  '西湖',
  '滨江',
  '萧山',
  '余杭',
  '临平',
  '钱塘',
  '富阳',
  '临安',
  '桐庐',
  '淳安',
  '建德',
];

const normalizeText = (text: string): string => text
  .replace(/[\u200B-\u200D\uFEFF]/g, '')
  .replace(/\s+/g, '')
  .replace(/[！!。,.，；;：:]+$/g, '')
  .trim();

const uniqueFactUpdates = (updates: FactUpdate[]): FactUpdate[] => {
  const seen = new Set<string>();
  return updates.filter((update) => {
    const key = `${update.key}:${update.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const findPurpose = (text: string): string | undefined => {
  const exact = text.match(/^(自住|改善自住|投资|首次置业)$/)?.[1];
  if (exact) return exact;
  return text.match(/(?:主要(?:是|考虑)?|我是|买来|用于|打算|考虑|(?<!不|没|不是|没有|并非)准备)(改善自住|自住|投资|首次置业|给父母住|给孩子住)/)?.[1];
};

const findBudget = (text: string): string | undefined =>
  text.match(BUDGET_AFTER_LABEL)?.[1] ?? text.match(BUDGET_BEFORE_LABEL)?.[1];

const findArea = (text: string): string | undefined => {
  if (!/(?:主要看|考虑|关注|优先看|想买|区域|板块)/.test(text)) {
    return HANGZHOU_AREAS.find((area) => new RegExp(
      `(?<!不|没|不是|没有|并非)想在${area}(?:区)?(?:买房|购房|置业)?(?=[，。！？,!?；;]|$)`,
    ).test(text));
  }
  const areas = HANGZHOU_AREAS.filter((area) => text.includes(area));
  return areas.length > 0 ? areas.join('、') : undefined;
};

const findPurchaseTiming = (text: string): string | undefined =>
  text.match(PURCHASE_TIMING_AFTER_PLAN)?.[1] ?? text.match(PURCHASE_TIMING_BEFORE_BUY)?.[1];

const findDecisionMaker = (text: string): string | undefined => {
  if (/我自己(?:决定|做主)/.test(text)) return '本人决定';
  const family = text.match(/(?:我)?和(老婆|老公|爱人|父母|家人).{0,4}(?:一起|共同)(?:决定|商量)/)?.[1];
  return family ? `与${family}共同决定` : undefined;
};

const extractFacts = (text: string, visitIsExplicit: boolean): FactUpdate[] => {
  const updates: FactUpdate[] = [];
  const purpose = findPurpose(text);
  const budget = findBudget(text);
  const area = findArea(text);
  const purchaseTiming = findPurchaseTiming(text);
  const decisionMaker = findDecisionMaker(text);
  const visitAvailability = text.match(VISIT_AVAILABILITY)?.[0];
  const callAvailability = text.match(CALL_AVAILABILITY)?.[0];

  if (purpose) updates.push({ key: 'purpose', value: purpose, certainty: 'explicit' });
  if (budget) updates.push({ key: 'budget', value: budget, certainty: 'explicit' });
  if (area) updates.push({ key: 'area', value: area, certainty: 'explicit' });
  if (purchaseTiming) updates.push({ key: 'purchaseTiming', value: purchaseTiming, certainty: 'explicit' });
  if (decisionMaker) updates.push({ key: 'decisionMaker', value: decisionMaker, certainty: 'explicit' });
  if (visitAvailability) {
    updates.push({
      key: 'visitAvailability',
      value: visitAvailability,
      certainty: visitIsExplicit ? 'explicit' : 'candidate',
    });
  }
  if (callAvailability) {
    updates.push({ key: 'callAvailability', value: callAvailability, certainty: 'explicit' });
  }
  if (LOAN_TERMS.test(text) && /(?:没问题|正常|可以贷|不贷款|全款)/.test(text) && !LOAN_CONCERN.test(text)) {
    updates.push({ key: 'financing', value: text, certainty: 'explicit' });
  }
  return uniqueFactUpdates(updates);
};

const objectionMatches = (text: string): Array<{ kind: ObjectionKind; severity: ActiveObjection['severity'] }> => {
  const matches: Array<{ kind: ObjectionKind; severity: ActiveObjection['severity'] }> = [];
  if (LOAN_CONCERN.test(text)) matches.push({ kind: 'loan', severity: 'high' });
  if (FEE_CONCERN.test(text)) matches.push({ kind: 'fee', severity: 'high' });
  if (AUCTION_RISK_CONCERN.test(text)) matches.push({ kind: 'auction_risk', severity: 'high' });
  if (LISTING_FIRST.test(text)) matches.push({ kind: 'wants_listing_first', severity: 'normal' });
  if (TIME_DISTANCE_CONCERN.test(text)) matches.push({ kind: 'distance_or_time', severity: 'normal' });
  if (DECISION_MAKER_CONCERN.test(text) || PENDING_FAMILY_APPROVAL.test(text)) {
    matches.push({ kind: 'decision_maker', severity: 'normal' });
  }
  return matches;
};

const outboundAction = (text: string): OutboundAction => {
  if (/(?:不再主动联系|停止后续跟进|不再打扰|已记录不再联系)/.test(text)) return 'close_ack';
  if (/(?:先暂停|暂停跟进|您先忙|等您方便|下个月再联系)/.test(text)) return 'pause_ack';
  if (/(?:到店时间|给您留好|先按.{0,12}安排|定在.{0,12})(?:.{0,12}(?:地址|停车|到店|公司))|地址和停车(?:方式|位置)/.test(text)) {
    return 'visit_confirmation';
  }
  if (OUTBOUND_VISIT_TEMPLATE.test(text)
    || (VISIT_TERMS.test(text) && /(?:哪天|什么时候|哪个时间|方便吗|可以吗|能来吗|您看哪个|给您留|安排)/.test(text))) {
    return 'visit_invitation';
  }
  if (/(?:不能|不).{0,8}(?:承诺|保证)|线上不直接.{0,8}(?:房源|匹配)|先.{0,10}(?:流程|风险).{0,10}讲清楚|需要.{0,8}核实/.test(text)) {
    return 'objection_answer';
  }
  if (CALL_TERMS.test(text) && /(?:方便吗|什么时候|下午还是晚上|几点|选一个|告诉我)/.test(text)) {
    return 'call_offer';
  }
  return 'answer';
};

const analyzeOutbound = (event: NormalizedMessageEvent, text: string): MessageSignals => ({
  sourceMessageId: event.messageId,
  intent: 'other',
  outboundAction: outboundAction(text),
  needsHumanReview: event.messageType !== 'text' || !text,
});

const inferIntent = (
  text: string,
  objections: ReturnType<typeof objectionMatches>,
  facts: FactUpdate[],
  commitments: Commitment[],
): MessageIntent => {
  if (objections.length > 0) return 'objection';
  if (commitments.some((item) => ['selected_visit_slot', 'confirmed_visit', 'selected_call_slot'].includes(item.kind))) {
    return 'scheduling';
  }
  if (QUESTION.test(text)) return 'question';
  if (facts.length > 0) return 'fact';
  if (commitments.length > 0 || POSITIVE.test(text)) return 'positive';
  return 'other';
};

const analyzeInbound = (event: NormalizedMessageEvent, text: string): MessageSignals => {
  if (event.messageType !== 'text' || !text) {
    return {
      sourceMessageId: event.messageId,
      intent: 'other',
      needsHumanReview: event.messageType !== 'system',
    };
  }

  const ackText = text.replace(/[？?]/g, '');
  if (ACK_ONLY.test(ackText)) {
    return { sourceMessageId: event.messageId, intent: 'ack' };
  }

  const negatedRefusal = NEGATED_REFUSAL.test(text);
  const explicitNoContact = EXPLICIT_NO_CONTACT.test(text);
  const explicitPause = EXPLICIT_PAUSE.test(text);
  const explicitRefusal = EXPLICIT_REFUSAL.test(text) && !negatedRefusal;
  if (explicitNoContact || explicitRefusal) {
    return {
      sourceMessageId: event.messageId,
      intent: 'refusal',
      objection: {
        kind: 'not_interested',
        severity: 'normal',
        status: 'active',
        sourceMessageId: event.messageId,
      },
      needsHumanReview: negatedRefusal || explicitPause,
    };
  }
  if (explicitPause) {
    return {
      sourceMessageId: event.messageId,
      intent: 'pause',
      objection: {
        kind: 'not_now',
        severity: 'normal',
        status: 'active',
        sourceMessageId: event.messageId,
      },
      needsHumanReview: negatedRefusal,
    };
  }

  const time = text.match(TIME_EXPRESSION)?.[0];
  const hasVisitTerms = VISIT_TERMS.test(text);
  const negativeVisit = NEGATIVE_VISIT.test(text);
  const pendingFamilyApproval = PENDING_FAMILY_APPROVAL.test(text);
  const asksForAddress = ADDRESS_REQUEST.test(text);
  const explicitVisitIntent = !negativeVisit && !pendingFamilyApproval && (VISIT_INTENT.test(text) || asksForAddress);
  const confirmsVisit = !negativeVisit && !pendingFamilyApproval && VISIT_CONFIRMATION.test(text);
  const acceptsCall = CALL_ACCEPTANCE.test(text) && !NEGATIVE_CALL.test(text);
  const acceptsTime = TIME_ACCEPTANCE.test(text) && !NEGATIVE_TIME_ACCEPTANCE.test(text);
  const commitments: Commitment[] = [];

  if (confirmsVisit) {
    commitments.push({
      kind: 'confirmed_visit',
      status: 'accepted',
      sourceMessageId: event.messageId,
      value: time,
    });
  } else if (time && hasVisitTerms && acceptsTime && !negativeVisit && !pendingFamilyApproval && !QUESTION.test(text)) {
    commitments.push({
      kind: 'selected_visit_slot',
      status: 'accepted',
      sourceMessageId: event.messageId,
      value: time,
    });
  } else if (explicitVisitIntent) {
    commitments.push({
      kind: asksForAddress ? 'requested_address' : 'agreed_visit',
      status: 'accepted',
      sourceMessageId: event.messageId,
    });
  }

  if (acceptsCall) {
    commitments.push({
      kind: time ? 'selected_call_slot' : 'accepted_short_call',
      status: 'accepted',
      sourceMessageId: event.messageId,
      value: time,
    });
  }

  const facts = extractFacts(text, !pendingFamilyApproval && (explicitVisitIntent || hasVisitTerms));
  const objections = objectionMatches(text);
  const ambiguousTimeAcceptance = Boolean(
    time
    && acceptsTime
    && !hasVisitTerms
    && !CALL_TERMS.test(text),
  );
  const mixedCommitmentAndObjection = commitments.length > 0 && objections.length > 0;
  const intent = ambiguousTimeAcceptance
    ? 'scheduling'
    : inferIntent(text, objections, facts, commitments);

  return {
    sourceMessageId: event.messageId,
    intent,
    factUpdates: facts.length > 0 ? facts : undefined,
    objection: objections[0]
      ? {
        ...objections[0],
        status: 'active',
        sourceMessageId: event.messageId,
      }
      : undefined,
    commitments: commitments.length > 0 ? commitments : undefined,
    explicitVisitIntent: !negativeVisit && !pendingFamilyApproval
      && (explicitVisitIntent || confirmsVisit || (Boolean(time) && hasVisitTerms)),
    needsHumanReview: negatedRefusal
      || objections.length > 1
      || mixedCommitmentAndObjection
      || ambiguousTimeAcceptance,
  };
};

export const analyzeMessageSignals = (event: NormalizedMessageEvent): MessageSignals => {
  const text = normalizeText(event.text ?? '');
  return event.direction === 'outgoing'
    ? analyzeOutbound(event, text)
    : analyzeInbound(event, text);
};
