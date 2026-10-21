import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, open, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

export interface OfflineVoiceModelFile { readonly name: string; readonly size: number; readonly sha256: string; readonly url: string }
const MODEL_REPOSITORY = 'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/';
// Model hash verified against the upstream Git-LFS OID; tokens hash is over file bytes.
export const OFFLINE_VOICE_MODEL_FILES: readonly OfflineVoiceModelFile[] = Object.freeze([
  { name: 'model.int8.onnx', size: 239233841, sha256: 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51', url: `${MODEL_REPOSITORY}model.int8.onnx` },
  { name: 'tokens.txt', size: 315894, sha256: 'f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc', url: `${MODEL_REPOSITORY}tokens.txt` },
]);
export const OFFLINE_VOICE_MODEL_BYTES = OFFLINE_VOICE_MODEL_FILES.reduce((size, file) => size + file.size, 0);

/** Only fixed, hash-checked model assets are installed here; never executes downloaded files. */
export class OfflineVoiceModel {
  private fingerprint?: string;
  constructor(readonly directory: string, private readonly options: {
    readonly fetch?: typeof fetch;
    readonly files?: readonly OfflineVoiceModelFile[];
  } = {}) {
    if (!path.isAbsolute(directory)) throw new Error('离线模型目录无效');
  }
  private get files(): readonly OfflineVoiceModelFile[] { return this.options.files ?? OFFLINE_VOICE_MODEL_FILES; }

  private async signature(): Promise<string | undefined> {
    try {
      const result = await Promise.all(this.files.map(async (file) => {
        const info = await stat(path.join(this.directory, file.name));
        if (!info.isFile() || info.size !== file.size) throw new Error('Invalid model');
        return `${file.name}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
      }));
      return result.join('|');
    } catch { return undefined; }
  }

  private async matches(filename: string, file: OfflineVoiceModelFile): Promise<boolean> {
    const info = await stat(filename);
    if (!info.isFile() || info.size !== file.size) return false;
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of createReadStream(filename)) {
      bytes += chunk.length;
      if (bytes > file.size) return false;
      hash.update(chunk);
    }
    return bytes === file.size && hash.digest('hex') === file.sha256;
  }

  async isReady(): Promise<boolean> {
    const signature = await this.signature();
    if (!signature) return false;
    if (this.fingerprint === signature) return true;
    try {
      for (const file of this.files) if (!await this.matches(path.join(this.directory, file.name), file)) return false;
      if (signature !== await this.signature()) return false;
      this.fingerprint = signature;
      return true;
    } catch { return false; }
  }

  async install(options: { readonly sourceDirectory?: string; readonly signal: AbortSignal; readonly onProgress: (bytes: number) => void }): Promise<void> {
    if (options.sourceDirectory !== undefined && !path.isAbsolute(options.sourceDirectory)) throw new Error('请选择本机模型文件夹');
    await mkdir(this.directory, { recursive: true });
    let progress = 0;
    for (const file of this.files) {
      if (options.signal.aborted) throw new Error('下载已取消');
      const target = path.join(this.directory, file.name);
      if (await this.matches(target, file).catch(() => false)) {
        progress += file.size; options.onProgress(progress); continue;
      }
      const partial = path.join(this.directory, `${file.name}.${randomUUID()}.partial`);
      try {
        if (options.sourceDirectory) {
          const source = path.join(options.sourceDirectory, file.name);
          if (!await this.matches(source, file)) throw new Error('模型版本不符或文件损坏');
          await copyFile(source, partial);
          progress += file.size; options.onProgress(progress);
        } else {
          const response = await (this.options.fetch ?? fetch)(file.url, { signal: options.signal, redirect: 'follow', credentials: 'omit' });
          if (!response.ok || !response.body) throw new Error('模型下载未完成，请检查网络或导入离线模型');
          const reader = response.body.getReader();
          const handle = await open(partial, 'wx');
          let downloaded = 0;
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              if (options.signal.aborted || downloaded + value.byteLength > file.size) throw new Error('模型下载已取消或文件大小异常');
              let written = 0;
              while (written < value.byteLength) {
                const result = await handle.write(value, written, value.byteLength - written);
                if (!result.bytesWritten) throw new Error('模型无法写入磁盘');
                written += result.bytesWritten;
              }
              downloaded += value.byteLength;
              options.onProgress(progress + downloaded);
            }
          } finally { await reader.cancel().catch(() => undefined); await handle.close(); }
          progress += downloaded;
        }
        if (options.signal.aborted) throw new Error('下载已取消');
        if (!await this.matches(partial, file)) throw new Error('模型校验失败，未启用该文件');
        await rename(partial, target);
        this.fingerprint = undefined;
      } finally { await rm(partial, { force: true }).catch(() => undefined); }
    }
    if (!await this.isReady()) throw new Error('离线模型未通过校验');
  }
}
