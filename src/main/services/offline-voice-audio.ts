import { voiceFormat } from '../adapters/wechat-native/wechat-voice-store';

export const MAX_VOICE_SECONDS = 600;
export const MAX_VOICE_INPUT_BYTES = 24 * 1024 * 1024;
export interface VoiceSamples { samples: Float32Array; sampleRate: number }
export interface SilkDecoder {
  getDuration(bytes: Uint8Array): number;
  decode(bytes: Uint8Array, sampleRate: number): Promise<{ data: Uint8Array; duration: number }>;
}

/** Canonical mono PCM16 WAV for local HTML/audio exports, without an ASR model. */
export function voiceSamplesToWav(wave: VoiceSamples): Buffer {
  const length = wave.samples.length * 2;
  if (!Number.isSafeInteger(wave.sampleRate) || wave.sampleRate < 8000 || wave.sampleRate > 48000
    || length < 2 || length + 44 > MAX_VOICE_INPUT_BYTES || wave.samples.length / wave.sampleRate > MAX_VOICE_SECONDS) {
    throw new Error('音频超过导出范围');
  }
  const bytes = Buffer.alloc(44 + length);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(36 + length, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(wave.sampleRate, 24); bytes.writeUInt32LE(wave.sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(length, 40);
  for (let index = 0; index < wave.samples.length; index += 1) {
    const sample = wave.samples[index];
    if (!Number.isFinite(sample)) { bytes.fill(0); throw new Error('音频样本无效'); }
    bytes.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample * 32768))), 44 + index * 2);
  }
  return bytes;
}

/** Accept ordinary uncompressed WAV only. Unsupported codecs are explicit, never guessed. */
export function wavSamples(bytes: Buffer): VoiceSamples {
  if (voiceFormat(bytes) !== 'wav' || bytes.length > MAX_VOICE_INPUT_BYTES || bytes.readUInt32LE(4) + 8 !== bytes.length) {
    throw new Error('请选择完整的 PCM WAV 音频');
  }
  let format: { channels: number; sampleRate: number; bits: number; code: number } | undefined;
  let pcm: Buffer | undefined;
  for (let cursor = 12, count = 0; cursor + 8 <= bytes.length && count < 128; count += 1) {
    const id = bytes.toString('ascii', cursor, cursor + 4);
    const length = bytes.readUInt32LE(cursor + 4);
    const start = cursor + 8;
    if (start + length > bytes.length) throw new Error('WAV 音频不完整');
    if (id === 'fmt ') {
      if (format || length < 16) throw new Error('WAV 格式不支持');
      format = { code: bytes.readUInt16LE(start), channels: bytes.readUInt16LE(start + 2),
        sampleRate: bytes.readUInt32LE(start + 4), bits: bytes.readUInt16LE(start + 14) };
    }
    if (id === 'data') { if (pcm) throw new Error('WAV 格式不支持'); pcm = bytes.subarray(start, start + length); }
    cursor = start + length + (length % 2);
  }
  if (!format || !pcm || !pcm.length || format.code !== 1 || format.bits !== 16
    || ![1, 2].includes(format.channels) || format.sampleRate < 8000 || format.sampleRate > 48000
    || pcm.length % (2 * format.channels) || pcm.length / (2 * format.channels * format.sampleRate) > MAX_VOICE_SECONDS) {
    throw new Error('仅支持 10 分钟以内、8–48 kHz、16-bit PCM WAV 单声道或双声道音频');
  }
  const samples = new Float32Array(pcm.length / (2 * format.channels));
  for (let i = 0; i < samples.length; i += 1) {
    let sum = 0;
    for (let channel = 0; channel < format.channels; channel += 1) sum += pcm.readInt16LE((i * format.channels + channel) * 2) / 32768;
    samples[i] = sum / format.channels;
  }
  return { samples, sampleRate: format.sampleRate };
}

export async function decodeVoice(bytes: Buffer, decoder: SilkDecoder): Promise<VoiceSamples> {
  if (!bytes.length || bytes.length > MAX_VOICE_INPUT_BYTES) throw new Error('音频超过大小限制');
  if (voiceFormat(bytes) === 'wav') return wavSamples(bytes);
  if (voiceFormat(bytes) !== 'silk') throw new Error('语音编码暂不支持');
  const duration = decoder.getDuration(bytes);
  if (!Number.isFinite(duration) || duration <= 0 || duration > MAX_VOICE_SECONDS * 1000) throw new Error('语音时长不支持');
  const decoded = await decoder.decode(bytes, 16000);
  try {
    if (!decoded.data.length || decoded.data.length % 2 || decoded.data.length > MAX_VOICE_SECONDS * 32000) throw new Error('语音解码失败');
    const pcm = Buffer.from(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength);
    const samples = new Float32Array(pcm.length / 2);
    for (let i = 0; i < samples.length; i += 1) samples[i] = pcm.readInt16LE(i * 2) / 32768;
    return { samples, sampleRate: 16000 };
  } finally { decoded.data.fill(0); }
}
