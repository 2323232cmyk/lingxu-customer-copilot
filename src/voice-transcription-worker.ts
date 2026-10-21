import { createRequire } from 'node:module';
import path from 'node:path';
import { decodeVoice, MAX_VOICE_INPUT_BYTES, voiceSamplesToWav, type SilkDecoder } from './main/services/offline-voice-audio';

interface OfflineStream { acceptWaveform(input: { samples: Float32Array; sampleRate: number }): void }
interface OfflineRecognizer {
  createStream(): OfflineStream;
  decodeAsync(stream: OfflineStream): Promise<{ text?: string }>;
}
const parent = process.parentPort;
const modelRoot = process.env.LINGXU_VOICE_MODEL_ROOT;
const runtimeRoot = process.env.LINGXU_VOICE_RUNTIME_ROOT;
const nodeRequire = createRequire(__filename);
let running = false;

if (!parent || !modelRoot || !runtimeRoot || !path.isAbsolute(modelRoot) || !path.isAbsolute(runtimeRoot)) {
  process.exitCode = 1;
} else {
  parent.on('message', async (event: unknown) => {
    if (running) return;
    const message = event && typeof event === 'object' && 'data' in event ? (event as { data: unknown }).data : event;
    if (!message || typeof message !== 'object' || Array.isArray(message)) return;
    const request = message as Record<string, unknown>;
    if (request.kind !== 'transcribe' && request.kind !== 'decode') return;
    running = true;
    let bytes: Buffer | undefined;
    let samples: Float32Array | undefined;
    let output: Buffer | undefined;
    let phase = 'input';
    try {
      if (!(request.bytes instanceof Uint8Array) || request.bytes.byteLength < 1 || request.bytes.byteLength > MAX_VOICE_INPUT_BYTES) {
        parent.postMessage({ kind: 'result', ok: false, reason: 'unsupported' }); return;
      }
      bytes = Buffer.from(request.bytes);
      request.bytes.fill(0);
      phase = 'decoder-load';
      const silk = nodeRequire(path.join(runtimeRoot, 'silk-wasm')) as SilkDecoder;
      let wave;
      try { wave = await decodeVoice(bytes, silk); }
      catch { parent.postMessage({ kind: 'result', ok: false, reason: 'unsupported' }); return; }
      samples = wave.samples;
      if (request.kind === 'decode') {
        output = voiceSamplesToWav(wave);
        parent.postMessage({ kind: 'decoded', ok: true, bytes: output }); return;
      }
      phase = 'recognizer-load';
      const sherpa = nodeRequire(path.join(runtimeRoot, 'sherpa-onnx-node')) as {
        OfflineRecognizer: { createAsync(config: unknown): Promise<OfflineRecognizer> };
      };
      phase = 'model-load';
      // Windows native model loaders do not consistently handle UTF-8 absolute
      // paths. The isolated worker uses Unicode-aware chdir, then ASCII filenames.
      process.chdir(modelRoot);
      const recognizer = await sherpa.OfflineRecognizer.createAsync({
        featConfig: { sampleRate: 16000, featureDim: 80 },
        modelConfig: {
          senseVoice: { model: 'model.int8.onnx', language: 'auto', useInverseTextNormalization: 1 },
          tokens: 'tokens.txt', numThreads: 2, provider: 'cpu', debug: 0,
        },
      });
      // Bound the model's working sequence even for imported recordings. A long
      // recording is processed sequentially, not as one growing attention tensor.
      const parts: string[] = [];
      phase = 'recognize';
      const window = wave.sampleRate * 30;
      for (let start = 0; start < wave.samples.length; start += window) {
        const stream = recognizer.createStream();
        stream.acceptWaveform({ sampleRate: wave.sampleRate, samples: wave.samples.subarray(start, Math.min(start + window, wave.samples.length)) });
        const result = await recognizer.decodeAsync(stream);
        if (typeof result.text === 'string') {
          const part = result.text.replace(/<\|[^<>]{1,64}\|>/gu, '').trim();
          if (part) parts.push(part);
        }
        if (parts.reduce((sum, part) => sum + part.length, 0) > 32768) throw new Error('Transcript size limit');
      }
      const text = parts.join('\n');
      parent.postMessage(text && text.length <= 32768 ? { kind: 'result', ok: true, text } : { kind: 'result', ok: false, reason: 'unavailable' });
    } catch { parent.postMessage({ kind: 'result', ok: false, reason: 'unavailable', phase }); }
    finally { bytes?.fill(0); samples?.fill(0); output?.fill(0); }
  });
  parent.postMessage({ kind: 'ready' });
}
