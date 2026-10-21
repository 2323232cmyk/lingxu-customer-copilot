import type { WechatMediaResult } from '../shared/contracts';

export const WECHAT_MEDIA_QUEUE_LIMITS = {
  concurrentReads: 3,
  pendingReads: 128,
  attempts: 3,
  preparationAttempts: 8,
  retryDelaysMs: [1_500, 5_000],
  timeoutMs: 35_000,
} as const;

type MediaRead = (key: string) => Promise<WechatMediaResult>;
export interface WechatMediaReadTicket {
  result: Promise<WechatMediaResult | null>;
  cancel(): void;
}
interface QueuedRead {
  key: string;
  attempts: number;
  done: boolean;
  settle(result: WechatMediaResult | null): void;
  deadline?: ReturnType<typeof setTimeout>;
  retry?: ReturnType<typeof setTimeout>;
}

const unavailable = (): WechatMediaResult => ({ ok: false, reason: 'unavailable' });

export const describeWechatMediaFailure = (result: Extract<WechatMediaResult, { ok: false }>): string => {
  switch (result.mediaStatus) {
    case 'pending': return '图片仍在准备';
    case 'encrypted': return '本地图片尚未解密';
    case 'missing': return '本机尚无这张图片';
    case 'unsupported': return '暂不支持此媒体格式';
  }
  return result.reason === 'missing' ? '本机尚无这张图片'
    : result.reason === 'unsupported' ? '暂不支持此媒体格式' : '暂时无法读取';
};

/** Renderer-only scheduling. Completed images are never cached here. */
export class WechatMediaReadQueue {
  private queued: QueuedRead[] = [];
  private readonly pending = new Set<QueuedRead>();
  private active = 0;

  constructor(private readonly read: MediaRead) {}

  enqueue(key: string): WechatMediaReadTicket {
    if (typeof key !== 'string' || key.length !== 64 || !/^[a-f0-9]{64}$/u.test(key)) {
      return { result: Promise.resolve({ ok: false, reason: 'missing' }), cancel: () => undefined };
    }
    if (this.pending.size >= WECHAT_MEDIA_QUEUE_LIMITS.pendingReads) {
      return { result: Promise.resolve(unavailable()), cancel: () => undefined };
    }
    let settle!: QueuedRead['settle'];
    const result = new Promise<WechatMediaResult | null>((resolve) => { settle = resolve; });
    const job: QueuedRead = { key, settle, attempts: 0, done: false };
    job.deadline = setTimeout(() => this.finish(job, unavailable()), WECHAT_MEDIA_QUEUE_LIMITS.timeoutMs);
    this.pending.add(job);
    this.queued.push(job);
    this.drain();
    return { result, cancel: () => this.finish(job, null) };
  }

  private finish(job: QueuedRead, result: WechatMediaResult | null): void {
    if (job.done) return;
    job.done = true;
    clearTimeout(job.deadline);
    clearTimeout(job.retry);
    this.pending.delete(job);
    this.queued = this.queued.filter((queued) => queued !== job);
    job.settle(result);
  }

  private drain(): void {
    while (this.active < WECHAT_MEDIA_QUEUE_LIMITS.concurrentReads && this.queued.length > 0) {
      const job = this.queued.shift();
      if (!job || job.done) continue;
      this.active += 1;
      job.attempts += 1;
      void this.run(job);
    }
  }

  private async run(job: QueuedRead): Promise<void> {
    let result: WechatMediaResult;
    try { result = await this.read(job.key); }
    catch { result = unavailable(); }
    // Cancellation/timeout cannot abort an IPC call: keep its slot until it really settles.
    this.active -= 1;
    if (!job.done) {
      const attemptLimit = !result.ok && result.mediaStatus === 'pending'
        ? WECHAT_MEDIA_QUEUE_LIMITS.preparationAttempts : WECHAT_MEDIA_QUEUE_LIMITS.attempts;
      if (!result.ok && result.reason === 'unavailable' && job.attempts < attemptLimit) {
        job.retry = setTimeout(() => {
          if (job.done) return;
          this.queued.push(job);
          this.drain();
        }, WECHAT_MEDIA_QUEUE_LIMITS.retryDelaysMs[Math.min(job.attempts - 1, WECHAT_MEDIA_QUEUE_LIMITS.retryDelaysMs.length - 1)]);
      } else this.finish(job, result);
    }
    this.drain();
  }
}
