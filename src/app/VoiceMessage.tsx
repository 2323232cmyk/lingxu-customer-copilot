import { useEffect, useRef, useState } from 'react';
import { Button } from '@fluentui/react-components';
import { CheckmarkCircle20Regular, Mic20Regular } from '@fluentui/react-icons';
import type { WechatLiveMessage } from '../shared/contracts';
import type { WechatFeatureScope } from '../shared/feature-bridge-contracts';

export function VoiceMessage({ message, scope, onConfirmed, onOpenSettings }: {
  message: WechatLiveMessage; scope: WechatFeatureScope;
  onConfirmed: (messageId: string, text: string) => void; onOpenSettings: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState('');
  const [missingModel, setMissingModel] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const transcribe = async () => {
    if (busy || !message.voiceMediaKey) return;
    setBusy(true); setError(''); setMissingModel(false);
    try {
      const result = await window.salesCopilot.transcribeWechatVoice(message.voiceMediaKey, scope);
      if (!mounted.current) return;
      if (result.ok) { setText(result.text); setConfirmed(false); }
      else { setError(result.error); setMissingModel(result.reason === 'missing-model'); }
    } catch { if (mounted.current) setError('转写没有完成，请重试。'); }
    finally { if (mounted.current) setBusy(false); }
  };
  const confirm = async () => {
    if (busy || !text?.trim() || !message.voiceMediaKey) return;
    setBusy(true); setError('');
    try {
      const result = await window.salesCopilot.confirmWechatVoiceTranscript({ scope, voiceMediaKey: message.voiceMediaKey, text: text.trim() });
      if (!mounted.current) return;
      if (result.ok) { setConfirmed(true); onConfirmed(message.id, text.trim()); }
      else setError(result.error);
    } catch { if (mounted.current) setError('校对结果未保存，请重试。'); }
    finally { if (mounted.current) setBusy(false); }
  };
  return <div className="voice-message" aria-busy={busy}>
    <div className="voice-message-heading"><Mic20Regular /><strong>语音{message.voiceDurationMs ? ` · ${Math.ceil(message.voiceDurationMs / 1000)}秒` : ''}</strong>
      {text === null && <Button appearance="subtle" size="small" disabled={busy || !message.voiceMediaKey} onClick={() => void transcribe()}>
        {busy ? '本地转写中…' : '转文字'}
      </Button>}
    </div>
    {!message.voiceMediaKey && <small>本机尚未取得这条语音，请先在微信中打开，再刷新会话。</small>}
    {text !== null && <div className="voice-transcript">
      {confirmed ? <p>{text}</p> : <textarea aria-label="校对这条语音的文字" value={text} maxLength={32768} rows={3} onChange={(event) => setText(event.target.value)} />}
      <div className="voice-transcript-footer"><small>SenseVoice 本地转写 · {confirmed ? '已核对' : '待核对，不用于回复'}</small>
        {!confirmed && <Button appearance="subtle" size="small" icon={<CheckmarkCircle20Regular />} disabled={busy || !text.trim()} onClick={() => void confirm()}>核对完成</Button>}
      </div>
    </div>}
    {error && <div className="inline-error" role="alert">{error}{missingModel && <button type="button" className="text-link" onClick={onOpenSettings}>设置离线模型</button>}</div>}
  </div>;
}
