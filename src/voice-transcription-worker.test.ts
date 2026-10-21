import { EventEmitter } from 'node:events';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { voiceSamplesToWav, wavSamples } from './main/services/offline-voice-audio';

class ParentFixture extends EventEmitter {
  readonly posted: Record<string, unknown>[] = [];
  postMessage(message: Record<string, unknown>): void {
    // Match structured-clone ownership: the sender erases its buffers after posting.
    this.posted.push(structuredClone(message));
  }
}

describe('isolated offline voice process', () => {
  let parent: ParentFixture;
  let descriptor: PropertyDescriptor | undefined;
  let runtimeLoads: string[];
  let decoder: { getDuration: ReturnType<typeof vi.fn>; decode: ReturnType<typeof vi.fn> };
  let recognize: ReturnType<typeof vi.fn>;
  let createRecognizer: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules(); parent = new ParentFixture(); runtimeLoads = [];
    vi.spyOn(process, 'chdir').mockImplementation(() => undefined);
    descriptor = Object.getOwnPropertyDescriptor(process, 'parentPort');
    Object.defineProperty(process, 'parentPort', { value: parent, configurable: true });
    vi.stubEnv('LINGXU_VOICE_MODEL_ROOT', path.resolve('synthetic-fixtures/model'));
    vi.stubEnv('LINGXU_VOICE_RUNTIME_ROOT', path.resolve('synthetic-fixtures/runtime'));
    decoder = { getDuration: vi.fn(() => 20), decode: vi.fn(async () => ({ data: new Uint8Array([0, 0, 0, 64]), duration: 20 })) };
    recognize = vi.fn(async () => ({ text: '<|zh|><|NEUTRAL|>合成转写文字' }));
    createRecognizer = vi.fn(async () => ({ createStream: () => ({ acceptWaveform: vi.fn() }), decodeAsync: recognize }));
    vi.doMock('node:module', () => ({ createRequire: () => (filename: string) => {
      runtimeLoads.push(filename);
      if (path.basename(filename) === 'silk-wasm') return decoder;
      if (path.basename(filename) === 'sherpa-onnx-node') return { OfflineRecognizer: { createAsync: createRecognizer } };
      throw new Error('Unapproved synthetic runtime import');
    } }));
    await import('./voice-transcription-worker');
  });

  afterEach(() => {
    parent.removeAllListeners();
    if (descriptor) Object.defineProperty(process, 'parentPort', descriptor);
    else Reflect.deleteProperty(process, 'parentPort');
    vi.unstubAllEnvs(); vi.restoreAllMocks();
  });

  it('announces readiness without loading an audio engine or model', () => {
    expect(parent.posted).toEqual([{ kind: 'ready' }]); expect(runtimeLoads).toEqual([]);
  });

  it('decodes SILK to playable WAV without loading sherpa or touching a model', async () => {
    const bytes = new Uint8Array(Buffer.from('\x02#!SILK_V3fixture', 'binary'));
    parent.emit('message', { data: { kind: 'decode', bytes, format: 'silk' } });
    await vi.waitFor(() => expect(parent.posted).toHaveLength(2));
    const result = parent.posted[1];
    expect(result).toMatchObject({ kind: 'decoded', ok: true });
    const wave = wavSamples(Buffer.from(result.bytes as Uint8Array));
    expect([...wave.samples]).toEqual([0, 0.5]); expect(wave.sampleRate).toBe(16000);
    expect(runtimeLoads.map((filename) => path.basename(filename))).toEqual(['silk-wasm']);
    expect(createRecognizer).not.toHaveBeenCalled(); expect(bytes.every((value) => value === 0)).toBe(true);
  });

  it('runs a transcription with the fixed local CPU configuration and strips engine-only language tokens', async () => {
    const wav = voiceSamplesToWav({ samples: new Float32Array([0, 0.5, -0.5]), sampleRate: 16000 });
    parent.emit('message', { data: { kind: 'transcribe', bytes: wav, format: 'wav' } });
    await vi.waitFor(() => expect(parent.posted).toHaveLength(2));
    expect(parent.posted[1]).toEqual({ kind: 'result', ok: true, text: '合成转写文字' });
    expect(decoder.decode).not.toHaveBeenCalled();
    expect(createRecognizer).toHaveBeenCalledWith(expect.objectContaining({ modelConfig: expect.objectContaining({ provider: 'cpu', numThreads: 2, debug: 0 }) }));
    expect(wav.every((value) => value === 0)).toBe(true);
  });

  it('bounds long recordings to sequential 30-second recognition windows', async () => {
    const wav = voiceSamplesToWav({ samples: new Float32Array(16000 * 61), sampleRate: 16000 });
    parent.emit('message', { data: { kind: 'transcribe', bytes: wav, format: 'wav' } });
    await vi.waitFor(() => expect(parent.posted).toHaveLength(2));
    expect(recognize).toHaveBeenCalledTimes(3);
    expect(parent.posted[1]).toMatchObject({ ok: true, text: '合成转写文字\n合成转写文字\n合成转写文字' });
  });

  it('rejects unsupported audio and ignores duplicate jobs so one process never runs concurrent work', async () => {
    parent.emit('message', { data: { kind: 'decode', bytes: new Uint8Array([0, 1, 2]), format: 'silk' } });
    parent.emit('message', { data: { kind: 'transcribe', bytes: new Uint8Array([0, 1, 2]), format: 'silk' } });
    await vi.waitFor(() => expect(parent.posted).toHaveLength(2));
    expect(parent.posted[1]).toEqual({ kind: 'result', ok: false, reason: 'unsupported' });
    expect(createRecognizer).not.toHaveBeenCalled();
  });
});
