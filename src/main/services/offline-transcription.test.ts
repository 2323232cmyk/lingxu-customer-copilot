import { EventEmitter } from 'node:events';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { OfflineTranscriptionService, type OfflineVoiceProcess } from './offline-transcription';
import { voiceSamplesToWav } from './offline-voice-audio';

const fixture = () => Buffer.from('\x02#!SILK_V3\x01\x00\x00');
class ProcessFixture extends EventEmitter implements OfflineVoiceProcess {
  sent: unknown[] = [];
  killed = false;
  postMessage(message: unknown): void { this.sent.push(message); }
  kill(): boolean { if (!this.killed) { this.killed = true; this.emit('exit', 0); } return true; }
  complete(text = '这是合成测试转写'): void { this.emit('message', { kind: 'result', ok: true, text }); }
}
function setup(ready = true, timeout = 5000) {
  const processes: ProcessFixture[] = [];
  const model = { isReady: vi.fn(async () => ready), install: vi.fn(async (): Promise<void> => undefined) };
  const service = new OfflineTranscriptionService({ modelDirectory: path.resolve('outputs/synthetic-model'), workerPath: path.resolve('outputs/synthetic-worker'),
    runtimeRoot: path.resolve('node_modules'), model, taskTimeoutMs: timeout,
    spawn: () => { const child = new ProcessFixture(); processes.push(child); setTimeout(() => child.emit('message', { kind: 'ready' }), 0); return child; } });
  return { service, model, processes };
}

describe('bounded offline transcription service', () => {
  it('decodes audio for export without downloading, checking, or loading the speech model', async () => {
    const { service, processes, model } = setup(false);
    const decoded = service.decodeWechatVoiceToWav({ bytes: fixture(), format: 'silk' });
    await vi.waitFor(() => expect(processes[0]?.sent).toHaveLength(1));
    expect(processes[0].sent[0]).toMatchObject({ kind: 'decode', format: 'silk' });
    const wav = voiceSamplesToWav({ samples: new Float32Array([0, 0.5, -0.5]), sampleRate: 16000 });
    const expected = Buffer.from(wav);
    processes[0].emit('message', { kind: 'decoded', ok: true, bytes: wav });
    const result = await decoded;
    expect(result).toEqual({ ok: true, bytes: expected, mime: 'audio/wav' });
    expect(wav.every((byte) => byte === 0)).toBe(true);
    expect(model.isReady).not.toHaveBeenCalled(); expect(model.install).not.toHaveBeenCalled();
    expect(processes[0].killed).toBe(true);
    if (result.ok) result.bytes.fill(0); service.dispose();
  });

  it('shares the same single-job queue between decoding for export and transcription', async () => {
    const { service, processes } = setup();
    const decoded = service.decodeWechatVoiceToWav({ bytes: fixture(), format: 'silk' });
    const transcribed = service.transcribeVoice({ bytes: fixture(), format: 'silk' });
    await vi.waitFor(() => expect(processes[0]?.sent).toHaveLength(1)); expect(processes).toHaveLength(1);
    processes[0].emit('message', { kind: 'decoded', ok: true,
      bytes: voiceSamplesToWav({ samples: new Float32Array([0]), sampleRate: 16000 }) });
    const wave = await decoded; if (wave.ok) wave.bytes.fill(0);
    await vi.waitFor(() => expect(processes[1]?.sent).toHaveLength(1));
    expect(processes[1].sent[0]).toMatchObject({ kind: 'transcribe' }); processes[1].complete();
    expect(await transcribed).toMatchObject({ ok: true, text: '这是合成测试转写' }); service.dispose();
  });

  it('rejects a malformed decoded WAV and cancels export decodes with the same account boundary', async () => {
    const { service, processes } = setup(false);
    const first = service.decodeWechatVoiceToWav({ bytes: fixture(), format: 'silk' });
    await vi.waitFor(() => expect(processes[0]?.sent).toHaveLength(1));
    const wav = voiceSamplesToWav({ samples: new Float32Array([0]), sampleRate: 16000 }); wav.writeUInt16LE(3, 20);
    processes[0].emit('message', { kind: 'decoded', ok: true, bytes: wav });
    expect(await first).toMatchObject({ ok: false, reason: 'unsupported' });
    const second = service.decodeWechatVoiceToWav({ bytes: fixture(), format: 'silk' });
    await vi.waitFor(() => expect(processes[1]?.sent).toHaveLength(1)); service.cancelPending();
    expect(await second).toMatchObject({ ok: false, reason: 'cancelled' }); service.dispose();
  });
  it('cancels old-account tasks and cached results while keeping the installed model usable', async () => {
    const { service, processes, model } = setup();
    const input = { bytes: fixture(), format: 'silk' as const, sourceKey: 'synthetic:cached' };
    const cached = service.transcribeVoice(input);
    await vi.waitFor(() => expect(processes[0]?.sent).toHaveLength(1)); processes[0].complete(); await cached;
    const active = service.transcribeVoice({ ...input, sourceKey: 'synthetic:active' });
    const waiting = service.transcribeVoice({ ...input, sourceKey: 'synthetic:queued' });
    await vi.waitFor(() => expect(processes[1]?.sent).toHaveLength(1));
    service.cancelPending(); processes[1].complete('旧账号迟到文字');
    expect(await active).toMatchObject({ ok: false, reason: 'cancelled' });
    expect(await waiting).toMatchObject({ ok: false, reason: 'cancelled' });
    expect(processes[1].killed).toBe(true); expect((await service.status()).state).toBe('ready');
    const again = service.transcribeVoice(input);
    await vi.waitFor(() => expect(processes[2]?.sent).toHaveLength(1)); processes[2].complete('新任务重新转写');
    expect(await again).toMatchObject({ ok: true, text: '新任务重新转写' });
    expect(model.install).not.toHaveBeenCalled(); service.dispose();
  });

  it('cancels before delayed model validation can create an old-account process', async () => {
    const { service, processes, model } = setup();
    let verified: ((ready: boolean) => void) | undefined;
    model.isReady.mockImplementationOnce(() => new Promise<boolean>((resolve) => { verified = resolve; }));
    const first = service.transcribeVoice({ bytes: fixture(), format: 'silk' });
    service.cancelPending(); verified?.(true);
    expect(await first).toMatchObject({ ok: false, reason: 'cancelled' }); expect(processes).toHaveLength(0);
    service.dispose();
  });
  it('does not spawn without a verified local model', async () => {
    const { service, processes } = setup(false);
    expect(await service.transcribeVoice({ bytes: fixture(), format: 'silk' })).toMatchObject({ ok: false, reason: 'missing-model' });
    expect(processes).toHaveLength(0); service.dispose();
  });
  it('runs one task at a time, caches by actual audio and leaves caller bytes untouched', async () => {
    const { service, processes } = setup(); const input = fixture();
    const first = service.transcribeVoice({ bytes: input, format: 'silk', sourceKey: 'opaque:first' });
    const second = service.transcribeVoice({ bytes: input, format: 'silk', sourceKey: 'opaque:second' });
    await vi.waitFor(() => expect(processes[0]?.sent).toHaveLength(1));
    expect(processes).toHaveLength(1); processes[0].complete();
    expect(await first).toMatchObject({ ok: true, engine: 'SenseVoice', sourceKey: 'opaque:first' });
    await vi.waitFor(() => expect(processes[1]?.sent).toHaveLength(1)); processes[1].complete(); await second;
    expect(processes.every((child) => child.killed)).toBe(true);
    expect(await service.transcribeVoice({ bytes: input, format: 'silk', sourceKey: 'opaque:first' })).toMatchObject({ ok: true });
    expect(processes).toHaveLength(2); expect(input).toEqual(fixture()); service.dispose();
  });
  it('supports cancelling active and queued tasks without starting another worker', async () => {
    const { service, processes } = setup(); const firstAbort = new AbortController(), nextAbort = new AbortController();
    const first = service.transcribeVoice({ bytes: fixture(), format: 'silk' }, firstAbort.signal);
    const next = service.transcribeVoice({ bytes: fixture(), format: 'silk' }, nextAbort.signal);
    await vi.waitFor(() => expect(processes).toHaveLength(1)); nextAbort.abort(); firstAbort.abort();
    expect(await first).toMatchObject({ ok: false, reason: 'cancelled' }); expect(await next).toMatchObject({ ok: false, reason: 'cancelled' });
    expect(processes).toHaveLength(1); expect(processes[0].killed).toBe(true); service.dispose();
  });
  it('kills a timed-out worker so the queue can continue', async () => {
    const { service, processes } = setup(true, 30);
    expect(await service.transcribeVoice({ bytes: fixture(), format: 'silk' })).toMatchObject({ ok: false, reason: 'timeout' });
    expect(processes[0].killed).toBe(true); expect((await service.status()).active).toBe(false); service.dispose();
  });
  it('rejects unknown input formats and full queues', async () => {
    const { service } = setup();
    expect(await service.transcribeVoice({ bytes: Buffer.from('unknown'), format: 'wav' })).toMatchObject({ ok: false, reason: 'unsupported' });
    expect(await service.transcribeVoice({ bytes: fixture(), format: 'silk', sourceKey: 'private path with spaces' })).toMatchObject({ ok: false, reason: 'unsupported' });
    const tasks = Array.from({ length: 9 }, () => service.transcribeVoice({ bytes: fixture(), format: 'silk' }));
    expect(await service.transcribeVoice({ bytes: fixture(), format: 'silk' })).toMatchObject({ ok: false, reason: 'queue-full' });
    service.dispose(); expect((await Promise.all(tasks)).every((result) => !result.ok)).toBe(true);
  });
  it('never returns worker errors, file paths or empty transcriptions as success', async () => {
    const { service, processes } = setup();
    const task = service.transcribeVoice({ bytes: fixture(), format: 'silk' });
    await vi.waitFor(() => expect(processes[0]?.sent).toHaveLength(1));
    processes[0].emit('message', { kind: 'result', ok: false, error: 'C:/private/account/key' });
    const result = await task;
    expect(result.ok).toBe(false); expect(JSON.stringify(result)).not.toContain('private'); service.dispose();
  });
  it('keeps downloaded-model setup explicit and uses one shared install operation', async () => {
    const { service, model } = setup(false); let finish: (() => void) | undefined;
    model.install.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    expect(model.install).not.toHaveBeenCalled();
    const one = service.downloadModel(); const two = service.downloadModel(); expect(one).toBe(two);
    expect((await service.status()).state).toBe('downloading');
    expect(await service.transcribeVoice({ bytes: fixture(), format: 'silk' })).toMatchObject({ ok: false, reason: 'missing-model' });
    model.isReady.mockResolvedValue(true); finish?.(); expect(await one).toMatchObject({ ok: true });
    expect((await service.status()).state).toBe('ready'); service.dispose();
  });
  it('cancels pending audio on disposal and rejects subsequent input', async () => {
    const { service, processes } = setup(); const task = service.transcribeVoice({ bytes: fixture(), format: 'silk' });
    await vi.waitFor(() => expect(processes).toHaveLength(1)); service.dispose();
    expect(await task).toMatchObject({ ok: false, reason: 'cancelled' });
    expect(await service.transcribeVoice({ bytes: fixture(), format: 'silk' })).toMatchObject({ ok: false, reason: 'cancelled' });
  });
});
