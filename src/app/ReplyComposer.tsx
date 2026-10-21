import { useEffect, useState } from 'react';
import { Button } from '@fluentui/react-components';
import { ArrowSync20Regular, CheckmarkCircle20Regular, Clipboard20Regular, Dismiss20Regular } from '@fluentui/react-icons';
import type { AiContextSummary, AiDraftResponse } from '../shared/integration-contracts';

export interface ReplyChoice { id: string; text: string; reason: string; sourceIds: string[]; warning?: string }

export function ReplyComposer({ drafts, sources, knowledgeStatus, disabled, generating, generated, onCopy, onGenerate, onCancel }: {
  drafts: ReplyChoice[]; disabled: boolean; generating: boolean; generated: boolean;
  sources?: AiDraftResponse['sources']; knowledgeStatus?: AiContextSummary['knowledgeStatus'];
  onCopy: (text: string) => Promise<boolean>; onGenerate: () => void; onCancel?: () => void;
}) {
  const [selected, setSelected] = useState(0);
  const [edits, setEdits] = useState<Record<number, string>>({});
  const [copiedText, setCopiedText] = useState<string | null>(null);
  const [copying, setCopying] = useState(false);
  const text = edits[selected] ?? drafts[selected]?.text ?? '';
  const knowledgeSources = sources?.filter(source => source.id.startsWith('kb:') && drafts[selected]?.sourceIds.includes(source.id)) ?? [];
  const edited = text !== (drafts[selected]?.text ?? '');
  useEffect(() => {
    if (!copiedText) return;
    const timer = setTimeout(() => setCopiedText(null), 2400);
    return () => clearTimeout(timer);
  }, [copiedText]);
  const copy = async () => {
    if (disabled || copying || !text.trim()) return;
    setCopying(true);
    try { if (await onCopy(text)) setCopiedText(text); }
    finally { setCopying(false); }
  };
  return <section className="reply-composer" aria-label="编辑回复草稿">
    <div className="reply-composer-heading">
      <label htmlFor="reply-text">回复草稿 <span className="reply-character-count" title="最多 3000 字">{generating ? '生成中' : `${text.length} 字`}</span></label>
      {drafts.length > 1 && <div className="reply-choices" role="group" aria-label="切换回复说法">
        {drafts.map((draft, index) => <button key={draft.id} type="button" aria-pressed={selected === index}
          onClick={() => setSelected(index)}>{index === 0 ? '推荐' : `说法${index + 1}`}</button>)}
      </div>}
    </div>
    <textarea id="reply-text" aria-label="编辑回复" value={text} maxLength={3000} spellCheck={false} readOnly={generating} aria-busy={generating}
      placeholder={generating ? '正在准备回复，请稍候…' : '写下想说的话，或点击下方生成回复…'}
      onChange={(event) => { const value = event.target.value; setEdits((current) => ({ ...current, [selected]: value })); }} />
    {knowledgeStatus && <div className="reply-knowledge-evidence" role="status">
      {knowledgeStatus === 'no_match' ? '知识库未命中 · 当前为待核实话术，未调用模型' : knowledgeSources.length
        ? `${edited ? '原草稿知识来源（编辑后请核对）' : '本条知识来源'}：${knowledgeSources.map(source => source.title).join('、')}`
        : knowledgeStatus === 'included' ? '已检索知识库 · 本条草稿未引用知识片段' : '本次未使用公司知识库'}
    </div>}
    <footer className="reply-action-bar">
      {generating && onCancel ? <Button appearance="secondary" icon={<Dismiss20Regular />} onClick={onCancel}>停止生成</Button> :
        <Button appearance={text.trim() ? 'secondary' : 'primary'} icon={<ArrowSync20Regular />} disabled={disabled || generating}
          onClick={onGenerate}>{generating ? '正在生成…' : generated ? '重新生成' : '生成回复'}</Button>}
      <Button appearance="primary" icon={copiedText === text ? <CheckmarkCircle20Regular /> : <Clipboard20Regular />}
        disabled={disabled || copying || !text.trim()} onClick={() => void copy()}>{copiedText === text && text ? '已复制' : '复制回复'}</Button>
    </footer>
  </section>;
}
