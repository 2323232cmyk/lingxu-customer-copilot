import { useEffect, useRef, useState } from 'react';
import type { WechatLiveMessage, WechatMediaResult } from '../shared/contracts';
import { describeWechatMediaFailure, WechatMediaReadQueue } from './wechat-media-queue';

const mediaReads = new WechatMediaReadQueue((key) => window.salesCopilot.getWechatMedia(key));

/** Only request visible media through the authenticated bridge; never accept paths or URLs. */
export function PrivateImage({ mediaKey, alt, className = '', fallback }: {
  mediaKey?: string; alt: string; className?: string; fallback: string;
}) {
  const container = useRef<HTMLSpanElement>(null);
  const retryPending = useRef(false);
  const [visible, setVisible] = useState(false);
  const [resolved, setResolved] = useState<{ key: string; result: WechatMediaResult } | null>(null);
  const [reservedSize, setReservedSize] = useState<{ key: string; height: number } | null>(null);
  const [retry, setRetry] = useState(0);
  const compact = /(?:^|\s)(?:queue-avatar|customer-avatar-large|message-avatar)(?:\s|$)/u.test(className);
  useEffect(() => {
    if (!container.current) return;
    const observer = new IntersectionObserver((entries) => {
      setVisible(entries.some((entry) => entry.isIntersecting));
    }, { rootMargin: '100px' });
    observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    // Release the data URL on key changes and when leaving the nearby viewport.
    setResolved(null);
    setReservedSize((previous) => previous?.key === mediaKey ? previous : null);
    if (!visible || !mediaKey) { retryPending.current = false; return; }
    let cancelled = false;
    const ticket = mediaReads.enqueue(mediaKey);
    void ticket.result.then((result) => {
      if (cancelled || !result) return;
      retryPending.current = false;
      const safeResult: WechatMediaResult = result.ok
        && (!/^data:image\/(?:jpeg|png|gif|webp);base64,/u.test(result.dataUrl)
          || !result.dataUrl.startsWith(`data:${result.mime};base64,`))
        ? { ok: false, reason: 'unsupported' } : result;
      setResolved({ key: mediaKey, result: safeResult });
    });
    return () => { cancelled = true; ticket.cancel(); };
  }, [mediaKey, visible, retry]);

  const result = visible && resolved && resolved.key === mediaKey ? resolved.result : null;
  const loading = Boolean(visible && mediaKey && !result);
  const status = !mediaKey ? fallback : !visible ? '图片待显示' : !result ? '正在读取'
    : result.ok ? alt : describeWechatMediaFailure(result);
  return (
    <span ref={container} className={`private-image ${className}`} aria-busy={loading} title={`${alt}：${status}`}
      style={!compact && reservedSize && reservedSize.key === mediaKey ? { minHeight: reservedSize.height } : undefined}>
      {mediaKey && result?.ok
        ? <img key={mediaKey} src={result.dataUrl} alt={alt} loading="lazy" decoding="async"
          onLoad={() => {
            const height = container.current?.getBoundingClientRect().height;
            if (!compact && height) setReservedSize({ key: mediaKey, height: Math.min(280, Math.ceil(height)) });
          }}
          onError={() => setResolved((previous) => previous?.key === mediaKey && previous.result === result
            ? { key: mediaKey, result: { ok: false, reason: 'unsupported' } } : previous)} />
        : <span role={compact ? undefined : 'status'}>
          <span role="img" aria-label={`${alt}：${status}`}>{compact ? fallback : status}</span>
          {!compact && result && !result.ok && <>
            <span>。可先在微信中打开查看，再重试加载。</span>
            <button type="button" className="icon-text-button" onClick={(event) => {
              event.stopPropagation();
              if (retryPending.current) return;
              retryPending.current = true;
              setResolved(null); setRetry((previous) => previous + 1);
            }}>重试加载</button>
          </>}
        </span>}
    </span>
  );
}

const textEmoticons: Record<string, string> = {
  '[微笑]': '🙂', '[呲牙]': '😁', '[笑哭]': '😂', '[破涕为笑]': '😂', '[偷笑]': '🤭',
  '[愉快]': '😊', '[大哭]': '😭', '[流泪]': '😢', '[害羞]': '😊', '[捂脸]': '🤦',
  '[赞]': '👍', '[强]': '👍', '[握手]': '🤝', '[抱拳]': '🙏', '[合十]': '🙏',
  '[爱心]': '❤️', '[玫瑰]': '🌹', '[OK]': '👌', '[庆祝]': '🎉', '[疑问]': '❓',
};

export function WechatMessageBody({ message }: { message: WechatLiveMessage }) {
  if (message.messageType === 'other' && /^\[(?:位置|文件|联系人名片|小程序分享|引用回复|链接与分享)\]/u.test(message.text)) {
    const [heading, ...lines] = message.text.split('\n');
    return <div className="message-card"><strong>{heading.slice(1, -1)}</strong>
      {lines.map((line, index) => <p key={index} style={{ overflowWrap: 'anywhere' }}>{line}</p>)}
      {message.attachmentKind === 'file' && <small>文件内容请在微信中打开；这里展示文件信息。</small>}
    </div>;
  }
  if (message.mediaKey) {
    const sticker = message.mediaKind === 'sticker';
    return <div className={`message-media ${sticker ? 'message-sticker' : ''}`}>
      <PrivateImage mediaKey={message.mediaKey} alt={sticker ? '微信表情' : '微信聊天图片'} fallback={sticker ? '表情暂不可用' : '图片暂不可用'} />
      {!sticker && <small>图片内容尚未转为文字依据</small>}
    </div>;
  }
  if (message.messageType === 'image' || message.mediaKind === 'sticker') {
    const status = describeWechatMediaFailure({
      ok: false, reason: 'missing', mediaStatus: message.mediaStatus === 'ready' ? undefined : message.mediaStatus,
    });
    return <p className="media-unavailable">{message.mediaKind === 'sticker' ? '[表情]' : '[图片]'} · {status}</p>;
  }
  return <p>{message.text.split(/(\[[^\]\r\n]{1,10}\])/u).map((part, index) => textEmoticons[part]
    ? <span key={index} title={part} aria-label={part} className="inline-emoticon">{textEmoticons[part]}</span>
    : part)}</p>;
}
