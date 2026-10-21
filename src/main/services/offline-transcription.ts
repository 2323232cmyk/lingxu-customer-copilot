import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import path from 'node:path';
import type { OfflineVoiceStatus, VoiceModelActionResult, VoiceTranscriptionResult } from '../../shared/voice-contracts';
import { voiceFormat } from '../adapters/wechat-native/wechat-voice-store';
import { MAX_VOICE_INPUT_BYTES } from './offline-voice-audio';
import { OFFLINE_VOICE_MODEL_BYTES, OfflineVoiceModel } from './offline-voice-model';

export interface OfflineVoiceProcess {
  postMessage(message: unknown): void;
  kill(): boolean;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  once(event: 'exit', listener: (code: number) => void): unknown;
}
export interface VoiceInput { bytes: Buffer; format: 'silk' | 'wav'; sourceKey?: string }
export type DecodedVoiceResult = { ok: true; bytes: Buffer; mime: 'audio/wav' } | { ok: false; reason: string };
type VoiceJobResult = VoiceTranscriptionResult | DecodedVoiceResult;
interface VoiceTask {
  input: VoiceInput;
  signal?: AbortSignal;
  cacheKey: string;
  generation: number;
  job: 'transcribe' | 'decode';
  resolve(result: VoiceJobResult): void;
  cancelled?: () => void;
}
const failure = (reason: Extract<VoiceTranscriptionResult, { ok: false }>['reason']): VoiceTranscriptionResult => ({
  ok: false, reason, error: {
    'missing-model': '请先在设置中下载或导入 SenseVoice 离线模型',
    unavailable: '本机语音处理器未完成转写，请检查模型或稍后重试',
    unsupported: '暂不支持该语音格式；可选择 10 分钟以内的 16-bit PCM WAV 或 SILK 文件',
    cancelled: '语音转写已取消', 'queue-full': '本机转写队列已满，请稍后重试', timeout: '本机转写超时，已释放处理器，请稍后重试',
  }[reason],
});

export class OfflineTranscriptionService {
  private readonly model: Pick<OfflineVoiceModel, 'isReady' | 'install'>;
  private readonly queue: VoiceTask[] = [];
  private readonly cache = new Map<string, Extract<VoiceTranscriptionResult, { ok: true }>>();
  private active?: VoiceTask;
  private process?: OfflineVoiceProcess;
  private allocatedBytes = 0;
  private download?: Promise<VoiceModelActionResult>;
  private downloadController?: AbortController;
  private progress = 0;
  private lastError?: string;
  private notifiedAt = 0;
  private disposed = false;
  private cancellationGeneration = 0;
  private cancelActive: (() => void) | undefined;

  constructor(private readonly options: {
    readonly modelDirectory: string;
    readonly workerPath: string;
    /** Directory containing sibling silk-wasm, sherpa-onnx-node and sherpa-onnx-win-x64 packages. */
    readonly runtimeRoot: string;
    readonly fetch?: typeof fetch;
    readonly spawn?: () => OfflineVoiceProcess;
    readonly model?: Pick<OfflineVoiceModel, 'isReady' | 'install'>;
    readonly taskTimeoutMs?: number;
    readonly onStatus?: (status: OfflineVoiceStatus) => void;
  }) {
    if (![options.modelDirectory, options.workerPath, options.runtimeRoot].every((value) => path.isAbsolute(value))) throw new Error('离线转写配置无效');
    this.model = options.model ?? new OfflineVoiceModel(options.modelDirectory, { fetch: options.fetch });
  }

  async status(): Promise<OfflineVoiceStatus> {
    const ready = !this.disposed && await this.model.isReady();
    return { engine: 'SenseVoice', state: this.disposed ? 'unsupported' : this.download ? 'downloading' : ready ? 'ready' : this.lastError ? 'error' : 'missing',
      detail: this.disposed ? '本机转写已停止' : this.download ? '正在准备离线模型，语音不会上传'
        : ready ? 'SenseVoice 离线模型已就绪 · 单任务队列 · CPU 双线程' : this.lastError ?? '首次使用请下载约 240 MB 模型，或导入已下载的模型文件夹',
      totalBytes: OFFLINE_VOICE_MODEL_BYTES, downloadedBytes: ready ? OFFLINE_VOICE_MODEL_BYTES : this.progress,
      active: Boolean(this.active), queued: this.queue.length };
  }

  private notify(): void {
    if (this.options.onStatus && Date.now() - this.notifiedAt >= 100) {
      this.notifiedAt = Date.now();
      void this.status().then((status) => this.options.onStatus?.(status));
    }
  }
  downloadModel(): Promise<VoiceModelActionResult> { return this.installModel(); }
  importModelDirectory(directory: string): Promise<VoiceModelActionResult> { return this.installModel(directory); }
  cancelDownload(): void { this.downloadController?.abort(); }

  private installModel(sourceDirectory?: string): Promise<VoiceModelActionResult> {
    if (this.download) return this.download;
    if (this.disposed || this.active || this.queue.length) return this.status().then((status) => ({ ok: false, status, error: '请等待正在进行的语音转写结束' }));
    this.downloadController = new AbortController();
    const controller = this.downloadController;
    const timer = setTimeout(() => controller.abort(), 15 * 60_000);
    this.lastError = undefined; this.progress = 0;
    const install = this.model.install({ sourceDirectory, signal: controller.signal, onProgress: (bytes) => { this.progress = bytes; this.notify(); } });
    this.download = install.then(async () => {
      this.lastError = undefined;
      this.download = undefined;
      return { ok: true as const, status: await this.status() };
    }).catch(async () => {
      this.lastError = controller.signal.aborted ? '模型准备已取消，已有完整模型不受影响' : '模型准备未完成，请检查网络、磁盘空间和模型版本后重试';
      this.download = undefined;
      return { ok: false as const, cancelled: controller.signal.aborted, error: this.lastError, status: await this.status() };
    }).finally(() => { clearTimeout(timer); this.downloadController = undefined; this.download = undefined; this.notify(); });
    return this.download;
  }

  async transcribeVoice(input: VoiceInput, signal?: AbortSignal): Promise<VoiceTranscriptionResult> {
    const result = await this.enqueueVoice(input, 'transcribe', signal);
    return result.ok && 'text' in result || !result.ok && 'error' in result ? result : failure('unavailable');
  }

  /** Decode only; local playback/export does not require the speech-recognition model. */
  async decodeWechatVoiceToWav(input: Pick<VoiceInput, 'bytes' | 'format'>, signal?: AbortSignal): Promise<DecodedVoiceResult> {
    const result = await this.enqueueVoice(input, 'decode', signal);
    return result.ok && 'bytes' in result ? result : { ok: false, reason: result.ok ? 'unavailable' : result.reason };
  }

  private enqueueVoice(input: VoiceInput, job: VoiceTask['job'], signal?: AbortSignal): Promise<VoiceJobResult> {
    if (this.disposed || signal?.aborted) return Promise.resolve(failure('cancelled'));
    if (!Buffer.isBuffer(input.bytes) || !input.bytes.length || input.bytes.length > MAX_VOICE_INPUT_BYTES
      || !['silk', 'wav'].includes(input.format) || voiceFormat(input.bytes) !== input.format
      || input.sourceKey !== undefined && !/^[a-zA-Z0-9:._-]{1,160}$/u.test(input.sourceKey)) return Promise.resolve(failure('unsupported'));
    if (job === 'transcribe' && this.download) return Promise.resolve(failure('missing-model'));
    const cacheKey = `${input.sourceKey ?? ''}:${createHash('sha256').update(input.bytes).digest('hex')}`;
    const cached = job === 'transcribe' ? this.cache.get(cacheKey) : undefined;
    if (cached) return Promise.resolve({ ...cached });
    if (this.queue.length >= 8 || this.allocatedBytes + input.bytes.length > 32 * 1024 * 1024) return Promise.resolve(failure('queue-full'));
    const owned = { ...input, bytes: Buffer.from(input.bytes) };
    this.allocatedBytes += owned.bytes.length;
    return new Promise((resolve) => {
      const task: VoiceTask = { input: owned, signal, cacheKey, resolve, generation: this.cancellationGeneration, job };
      const cancelled = () => {
        const index = this.queue.indexOf(task);
        if (index >= 0) { this.queue.splice(index, 1); this.release(task, failure('cancelled')); }
      };
      task.cancelled = cancelled;
      signal?.addEventListener('abort', cancelled, { once: true });
      this.queue.push(task); this.notify(); void this.pump();
    });
  }

  async transcribeFile(filename: string, signal?: AbortSignal): Promise<VoiceTranscriptionResult> {
    const generation = this.cancellationGeneration;
    if (!path.isAbsolute(filename) || !/\.(?:wav|silk|slk)$/iu.test(filename)) return failure('unsupported');
    let bytes: Buffer | undefined;
    try {
      const handle = await open(filename, 'r');
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size < 1 || info.size > MAX_VOICE_INPUT_BYTES) return failure('unsupported');
        bytes = Buffer.alloc(info.size);
        let offset = 0;
        while (offset < bytes.length) {
          const read = await handle.read(bytes, offset, bytes.length - offset, offset);
          if (!read.bytesRead) return failure('unsupported');
          offset += read.bytesRead;
        }
      } finally { await handle.close(); }
      if (generation !== this.cancellationGeneration || signal?.aborted || this.disposed) return failure('cancelled');
      const format = voiceFormat(bytes);
      return format ? await this.transcribeVoice({ bytes, format }, signal) : failure('unsupported');
    } catch { return failure('unavailable'); }
    finally { bytes?.fill(0); }
  }

  private release(task: VoiceTask, result: VoiceJobResult): void {
    this.allocatedBytes -= task.input.bytes.length;
    task.input.bytes.fill(0);
    if (task.cancelled) task.signal?.removeEventListener('abort', task.cancelled);
    task.resolve(result); this.notify();
  }

  private async pump(): Promise<void> {
    if (this.active || this.disposed) return;
    const task = this.queue.shift();
    if (!task) return;
    this.active = task;
    let result: VoiceJobResult;
    try {
      result = task.signal?.aborted ? failure('cancelled')
        : task.job === 'transcribe' && !await this.model.isReady() ? failure('missing-model') : await this.recognize(task);
    } catch { result = failure('unavailable'); }
    if (this.disposed || task.signal?.aborted || task.generation !== this.cancellationGeneration) {
      if (result.ok && 'bytes' in result) result.bytes.fill(0);
      result = failure('cancelled');
    }
    if (result.ok && 'text' in result) {
      this.cache.set(task.cacheKey, result);
      if (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value as string);
    }
    this.active = undefined; this.release(task, result); void this.pump();
  }

  private async spawn(): Promise<OfflineVoiceProcess> {
    if (this.options.spawn) return this.options.spawn();
    const { utilityProcess } = await import('electron');
    const systemRoot = process.env.SystemRoot || 'C:\\Windows';
    const child = utilityProcess.fork(this.options.workerPath, [], {
      cwd: path.dirname(this.options.workerPath), serviceName: 'Lingxu Offline Speech', stdio: 'pipe',
      env: { SystemRoot: systemRoot, WINDIR: systemRoot,
        PATH: [path.join(this.options.runtimeRoot, 'sherpa-onnx-win-x64'), path.join(systemRoot, 'System32')].join(path.delimiter),
        LINGXU_VOICE_RUNTIME_ROOT: this.options.runtimeRoot, LINGXU_VOICE_MODEL_ROOT: this.options.modelDirectory },
    });
    child.stdout?.resume(); child.stderr?.resume();
    return child;
  }

  private async recognize(task: VoiceTask): Promise<VoiceJobResult> {
    if (this.disposed || task.signal?.aborted || task.generation !== this.cancellationGeneration) return failure('cancelled');
    const child = await this.spawn();
    this.process = child;
    return new Promise((resolve) => {
      let finished = false;
      const done = (result: VoiceJobResult) => {
        if (finished) return;
        finished = true; clearTimeout(timer); task.signal?.removeEventListener('abort', cancelled);
        if (this.cancelActive === cancelled) this.cancelActive = undefined;
        try { child.kill(); } catch { /* Child may already be gone. */ }
        if (this.process === child) this.process = undefined; resolve(result);
      };
      const cancelled = () => done(failure('cancelled'));
      this.cancelActive = cancelled;
      const timer = setTimeout(() => done(failure('timeout')), this.options.taskTimeoutMs ?? 120_000);
      task.signal?.addEventListener('abort', cancelled, { once: true });
      child.once('exit', () => done(failure('unavailable')));
      child.on('message', (message) => {
        if (finished || !message || typeof message !== 'object' || Array.isArray(message)) return;
        const value = message as Record<string, unknown>;
        if (value.kind === 'ready') {
          child.postMessage({ kind: task.job, bytes: task.input.bytes, format: task.input.format }); return;
        }
        if (value.kind === 'decoded' && task.job === 'decode') {
          const bytes = value.bytes;
          if (value.ok !== true || !(bytes instanceof Uint8Array) || bytes.byteLength < 46 || bytes.byteLength > MAX_VOICE_INPUT_BYTES) {
            done(failure('unsupported')); return;
          }
          const owned = Buffer.from(bytes); bytes.fill(0);
          if (voiceFormat(owned) !== 'wav' || owned.readUInt32LE(4) + 8 !== owned.length
            || owned.toString('ascii', 12, 16) !== 'fmt ' || owned.readUInt32LE(16) !== 16
            || owned.readUInt16LE(20) !== 1 || owned.readUInt16LE(22) !== 1 || owned.readUInt16LE(34) !== 16
            || owned.readUInt16LE(32) !== 2 || owned.readUInt32LE(24) < 8000 || owned.readUInt32LE(24) > 48000
            || owned.readUInt32LE(28) !== owned.readUInt32LE(24) * 2
            || owned.toString('ascii', 36, 40) !== 'data' || owned.readUInt32LE(40) + 44 !== owned.length
            || owned.readUInt32LE(40) % 2 || owned.readUInt32LE(40) / (owned.readUInt32LE(24) * 2) > 600) {
            owned.fill(0); done(failure('unsupported')); return;
          }
          done({ ok: true, bytes: owned, mime: 'audio/wav' }); return;
        }
        if (value.kind !== 'result') return;
        if (task.job === 'transcribe' && value.ok === true && typeof value.text === 'string' && value.text.trim().length > 0 && value.text.length <= 32768) {
          done({ ok: true, text: value.text.trim(), engine: 'SenseVoice', ...(task.input.sourceKey ? { sourceKey: task.input.sourceKey } : {}) });
        } else done(failure(value.reason === 'unsupported' ? 'unsupported' : 'unavailable'));
      });
      if (this.disposed || task.signal?.aborted || task.generation !== this.cancellationGeneration) cancelled();
    });
  }

  /** Revoke old-account audio, queued jobs and text cache without removing the installed model. */
  cancelPending(): void {
    this.cancellationGeneration += 1;
    this.cancelActive?.();
    try { this.process?.kill(); } catch { /* Child may already be gone. */ }
    this.process = undefined;
    for (const task of this.queue.splice(0)) this.release(task, failure('cancelled'));
    this.cache.clear(); this.notify();
  }

  dispose(): void {
    this.disposed = true; this.cancelDownload(); this.cancelPending();
  }
}
