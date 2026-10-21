import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { decodeVoice, voiceSamplesToWav, wavSamples, type SilkDecoder } from './offline-voice-audio';

export function fixtureWav(samples: readonly number[] = [0, 16384, -16384, 32767], channels = 1, sampleRate = 16000): Buffer {
  const bytes = Buffer.alloc(44 + samples.length * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(channels, 22); bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * channels * 2, 28); bytes.writeUInt16LE(channels * 2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((sample, index) => bytes.writeInt16LE(sample, 44 + index * 2)); return bytes;
}

describe('local audio decoding', () => {
  it('writes canonical browser-playable PCM WAV without a recognition model', () => {
    const original = fixtureWav([0, 32767, -32768, 1234]);
    expect(voiceSamplesToWav(wavSamples(original))).toEqual(original);
    const stereo = wavSamples(fixtureWav([16384, 0, -16384, 0], 2));
    expect([...wavSamples(voiceSamplesToWav(stereo)).samples]).toEqual([0.25, -0.25]);
    expect(() => voiceSamplesToWav({ samples: new Float32Array([NaN]), sampleRate: 16000 })).toThrow();
    expect(() => voiceSamplesToWav({ samples: new Float32Array(), sampleRate: 16000 })).toThrow();
  });
  it('decodes PCM WAV and mixes stereo safely', () => {
    expect([...wavSamples(fixtureWav()).samples].slice(0, 3)).toEqual([0, 0.5, -0.5]);
    expect([...wavSamples(fixtureWav([16384, 0, -16384, 0], 2)).samples]).toEqual([0.25, -0.25]);
  });
  it('rejects incomplete, compressed and oversize-duration WAV files', () => {
    expect(() => wavSamples(fixtureWav().subarray(0, 45))).toThrow();
    const compressed = fixtureWav(); compressed.writeUInt16LE(3, 20); expect(() => wavSamples(compressed)).toThrow();
    const odd = fixtureWav(); odd.writeUInt32LE(7, 40); expect(() => wavSamples(odd)).toThrow();
  });
  it('does not invoke a SILK decoder for ordinary WAV or unknown bytes', async () => {
    const decoder: SilkDecoder = { getDuration: vi.fn(), decode: vi.fn() };
    expect((await decodeVoice(fixtureWav(), decoder)).sampleRate).toBe(16000);
    await expect(decodeVoice(Buffer.from('not audio'), decoder)).rejects.toThrow(); expect(decoder.decode).not.toHaveBeenCalled();
  });
  it('bounds SILK duration before decoding and erases temporary PCM after conversion', async () => {
    const silk = Buffer.from('\x02#!SILK_V3fixture'); const pcm = Buffer.from([0, 0, 0, 64]);
    const decoder: SilkDecoder = { getDuration: () => 20, decode: async () => ({ data: pcm, duration: 20 }) };
    expect([...(await decodeVoice(silk, decoder)).samples]).toEqual([0, 0.5]); expect(pcm.every((byte) => byte === 0)).toBe(true);
    await expect(decodeVoice(silk, { ...decoder, getDuration: () => 601000 })).rejects.toThrow();
  });
  it('round-trips public synthetic silence through the actual pinned SILK WASM codec', async () => {
    const nodeRequire = createRequire(path.join(process.cwd(), 'package.json'));
    const codec = nodeRequire('silk-wasm') as SilkDecoder & { encode(data: Uint8Array, sampleRate: number): Promise<{ data: Uint8Array }> };
    const encoded = await codec.encode(Buffer.alloc(16000 * 2 / 5), 16000);
    const decoded = await decodeVoice(Buffer.from(encoded.data), codec);
    expect(decoded.sampleRate).toBe(16000); expect(decoded.samples.length).toBeGreaterThan(0);
    expect(decoded.samples.length).toBeLessThanOrEqual(4000);
    const exported = voiceSamplesToWav(decoded);
    expect(wavSamples(exported).sampleRate).toBe(16000);
    expect(wavSamples(exported).samples.length).toBe(decoded.samples.length);
    exported.fill(0); decoded.samples.fill(0); encoded.data.fill(0);
  });
});
