import path from 'node:path';
import { app, utilityProcess, type UtilityProcess } from 'electron';
import type { WechatWorkerProcess, WechatWorkerSpawn } from './engine-manager';
import { createWechatWorkerEnvironment } from './worker-environment';

export interface LiveWechatWorkerSpawnOptions {
  readonly accountRoot: string;
  readonly workerPath?: string;
  readonly resourceRoot?: string;
  readonly koffiNodePath?: string;
}

class UtilityWechatWorkerProcess implements WechatWorkerProcess {
  constructor(private readonly child: UtilityProcess) {}

  postMessage(message: unknown): void {
    this.child.postMessage(message);
  }

  kill(): boolean {
    return this.child.kill();
  }

  on(event: 'message', listener: (message: unknown) => void): this {
    this.child.on(event, listener);
    return this;
  }

  once(event: 'exit', listener: (code: number | null) => void): this;
  once(event: 'error', listener: (error: Error) => void): this;
  once(
    event: 'exit' | 'error',
    listener: ((code: number | null) => void) | ((error: Error) => void),
  ): this {
    if (event === 'exit') {
      this.child.once('exit', listener as (code: number | null) => void);
    }
    // UtilityProcess has no separate runtime error event. Synchronous spawn failures
    // throw from fork(), while later failures are reported through its exit event.
    return this;
  }
}

const resolveLiveWorkerPaths = (options: LiveWechatWorkerSpawnOptions) => {
  const basePath = app.isPackaged ? process.resourcesPath : app.getAppPath();
  const workerPath = options.workerPath ?? (app.isPackaged
    ? path.join(process.resourcesPath, 'wechat-native-worker.js')
    : path.join(__dirname, 'wechat-native-worker.js'));
  const resourceRoot = options.resourceRoot ?? path.join(
    basePath,
    app.isPackaged ? 'wechat-reader' : path.join('native-resources', 'wechat-reader'),
  );
  const koffiNodePath = options.koffiNodePath ?? path.join(
    basePath,
    app.isPackaged
      ? path.join('koffi', 'win32_x64', 'koffi.node')
      : path.join('native-resources', 'koffi', 'win32_x64', 'koffi.node'),
  );

  return {
    workerPath: path.resolve(workerPath),
    resourceRoot: path.resolve(resourceRoot),
    koffiNodePath: path.resolve(koffiNodePath),
  };
};

export const createLiveWechatWorkerSpawn = (
  options: LiveWechatWorkerSpawnOptions,
): WechatWorkerSpawn => {
  if (!options.accountRoot.trim()) {
    throw new Error('WeChat account root is required');
  }
  const accountRoot = path.resolve(options.accountRoot);
  const resolved = resolveLiveWorkerPaths(options);

  return (generation) => {
    if (!/^[a-zA-Z0-9._:-]{1,96}$/u.test(generation)) {
      throw new Error('WeChat worker generation is invalid');
    }
    const child = utilityProcess.fork(resolved.workerPath, [], {
      cwd: path.dirname(resolved.workerPath),
      env: createWechatWorkerEnvironment(process.env, {
        generation,
        resourceRoot: resolved.resourceRoot,
        koffiNodePath: resolved.koffiNodePath,
        accountRoot,
      }),
      serviceName: 'WeChat Data Engine',
      stdio: 'pipe',
    });

    // Drain both pipes so a noisy native dependency cannot block the child.
    // Their content is intentionally never logged because it may contain local paths or keys.
    child.stdout?.resume();
    child.stderr?.resume();
    return new UtilityWechatWorkerProcess(child);
  };
};
