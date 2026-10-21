import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OfflineVoiceModel } from './offline-voice-model';

const roots: string[] = [];
const bytes = Buffer.from('public synthetic model fixture');
const files = [{ name: 'model.int8.onnx', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), url: 'https://fixture.invalid/model' }];
async function directory() { const root = await mkdtemp(path.join(os.tmpdir(), 'lingxu-model-test-')); roots.push(root); return root; }
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe('verified local voice model installation', () => {
  it('downloads only on request and checks all bytes before enabling a model', async () => {
    const root = await directory(); const fetcher = vi.fn(async () => new Response(bytes));
    const model = new OfflineVoiceModel(root, { files, fetch: fetcher });
    expect(await model.isReady()).toBe(false); expect(fetcher).not.toHaveBeenCalled();
    await model.install({ signal: new AbortController().signal, onProgress: vi.fn() });
    expect(await model.isReady()).toBe(true); expect(await readFile(path.join(root, files[0].name))).toEqual(bytes);
  });
  it('never enables incorrect or oversized download bodies', async () => {
    for (const response of [Buffer.from('wrong'), Buffer.concat([bytes, bytes])]) {
      const model = new OfflineVoiceModel(await directory(), { files, fetch: vi.fn(async () => new Response(response)) });
      await expect(model.install({ signal: new AbortController().signal, onProgress: vi.fn() })).rejects.toThrow();
      expect(await model.isReady()).toBe(false);
    }
  });
  it('copies and verifies user-imported models without network access', async () => {
    const source = await directory(), target = await directory(); await writeFile(path.join(source, files[0].name), bytes);
    const fetcher = vi.fn(); const model = new OfflineVoiceModel(target, { files, fetch: fetcher });
    await model.install({ sourceDirectory: source, signal: new AbortController().signal, onProgress: vi.fn() });
    expect(await model.isReady()).toBe(true); expect(fetcher).not.toHaveBeenCalled(); expect(await readFile(path.join(source, files[0].name))).toEqual(bytes);
  });
  it('rejects modification after the cached verification', async () => {
    const target = await directory(); await writeFile(path.join(target, files[0].name), bytes);
    const model = new OfflineVoiceModel(target, { files }); expect(await model.isReady()).toBe(true);
    await writeFile(path.join(target, files[0].name), Buffer.alloc(bytes.length)); expect(await model.isReady()).toBe(false);
  });
  it('handles cancellation without replacing an existing verified asset', async () => {
    const target = await directory(); await writeFile(path.join(target, files[0].name), bytes);
    const model = new OfflineVoiceModel(target, { files }); const abort = new AbortController(); abort.abort();
    await expect(model.install({ signal: abort.signal, onProgress: vi.fn() })).rejects.toThrow();
    expect(await model.isReady()).toBe(true);
  });
});
