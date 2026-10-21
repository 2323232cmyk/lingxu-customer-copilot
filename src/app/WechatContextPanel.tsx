import { useMemo, useState } from 'react';
import { Info20Regular } from '@fluentui/react-icons';
import type { WechatLiveConversation, WechatLiveMessage } from '../shared/contracts';
import { replayLiveStrategy } from './strategy-runtime';
import { createWechatCustomer, formatWechatTime } from './wechat-inbox';

export function WechatContextPanel({ conversation, messages }: { conversation: WechatLiveConversation; messages: WechatLiveMessage[] }) {
  const [tab, setTab] = useState('信息');
  const strategy = useMemo(() => conversation.kind === 'contact'
    ? replayLiveStrategy(createWechatCustomer(conversation), conversation.contactKey, messages) : null, [conversation, messages]);
  const facts = [ ['purpose', '用途'], ['budget', '预算'], ['area', '区域'], ['decisionMaker', '决策人'], ['purchaseTiming', '购房时间'] ] as const;
  return <aside className="detail-panel wechat-context-panel" aria-label="当前微信会话信息">
    <div className="detail-tabs">{['信息', '依据', '时间线'].map((item) => <button type="button" key={item}
      className={tab === item ? 'detail-tab-active' : ''} aria-pressed={tab === item} onClick={() => setTab(item)}>{item}</button>)}</div>
    <div className="detail-content">
      {tab === '信息' && <>
        <section><div className="detail-section-title"><h3>从这段聊天了解的信息</h3></div><dl className="fact-grid">
          {facts.map(([key, label]) => { const fact = strategy?.state.facts[key]; return <div key={key}><dt>{label}</dt>
            <dd title={fact?.value}>{fact?.value || '尚未确认'}</dd>
            {fact?.value && <small>{fact.status === 'confirmed' ? '客户在聊天中明确说明' : fact.status === 'conflict' ? '信息有冲突，需核实' : '线索待确认'}</small>}</div>; })}
        </dl></section>
        <section><div className="detail-section-title"><h3>CRM 与通话记录</h3></div><p className="detail-copy">尚未关联真实 CRM 档案。这里不会套用演示客户的预算、通话摘要或成交记录。</p></section>
        <section><div className="detail-section-title"><h3>回复依据边界</h3></div><p className="detail-copy">当前综合已读取的 {messages.length} 条微信消息与本地销售策略。媒体可查看，但未做图片识别、语音转写；不会猜测其中内容。</p></section>
      </>}
      {tab === '依据' && <><div className="evidence-intro"><Info20Regular /><span>只引用这个会话的真实聊天，未关联的 CRM 和演示知识不会进入建议。</span></div>
        {messages.filter((message) => message.direction === 'incoming' && message.messageType === 'text').slice(-12).reverse().map((message) =>
          <article className="evidence-card" key={message.id}><header><small>微信原文</small><time>{formatWechatTime(message.sentAt)}</time></header><p>{message.text}</p></article>)}
      </>}
      {tab === '时间线' && <div className="timeline">{messages.slice(-30).reverse().map((message) => <div className="timeline-item" key={message.id}>
        <span className="timeline-dot" /><time>{new Date(message.sentAt).toLocaleString('zh-CN', { hour12: false })}</time>
        <h3>{message.direction === 'system' ? '微信系统提示' : message.direction === 'incoming' ? '对方消息' : '我发送的消息'}</h3><p>{message.text}</p>
      </div>)}</div>}
      {messages.length === 0 && <p className="detail-copy">读取这个会话后显示内容。</p>}
    </div>
  </aside>;
}
