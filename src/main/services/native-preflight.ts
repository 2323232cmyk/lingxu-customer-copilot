import path from 'node:path';
import { app, utilityProcess, type UtilityProcess } from 'electron';
import { createWechatWorkerEnvironment } from '../adapters/wechat-native/worker-environment';

const WORKER_ERROR_CODES = new Set([
  'configuration.missing',
  'resource.invalid',
  'resource.load',
  'platform.unsupported',
  'database.initialize',
  'database.open',
  'database.configure',
  'database.keyInvalid',
  'database.key',
  'database.validationFailed',
  'database.queryDenied',
  'database.prepare',
  'database.bind',
  'database.query',
  'database.busy',
  'database.finalize',
  'database.close',
  'database.closed',
  'engine.unavailable',
]);

interface NativePreflightReader {
  readonly implementation: 'sqlite3mc';
  readonly version: '2.5.1';
  readonly readOnlySelfTestPassed: boolean;
}

interface NativePreflightRuntime {
  readonly electron: string;
  readonly node: string;
  readonly v8: string;
  readonly architecture: 'x64';
  readonly processType: 'utility';
}

export interface NativePreflightReport {
  readonly kind: 'native-preflight';
  readonly ok: boolean;
  readonly code?: string;
  readonly reader: NativePreflightReader | null;
  readonly runtime: NativePreflightRuntime | null;
  /** The self-test may use :memory:, but must never open a WeChat source database. */
  readonly openedDatabase: false;
  readonly requestedLoginKey: false;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isVersion = (value: unknown, v8 = false): value is string => typeof value === 'string'
  && value.length <= (v8 ? 64 : 32)
  && value.trim() === value
  && (v8 ? /^\d+\.\d+\.\d+(?:\.\d+)?(?:-electron\.\d+)?$/u : /^\d+\.\d+\.\d+$/u).test(value);

/** Validate and reconstruct; never forward arbitrary fields or native diagnostics. */
export const parseNativePreflightReport = (value: unknown): NativePreflightReport | null => {
  if (!isRecord(value)
    || Object.keys(value).some((key) => ![
      'kind', 'ok', 'code', 'reader', 'runtime', 'openedDatabase', 'requestedLoginKey',
    ].includes(key))
    || value.kind !== 'native-preflight'
    || typeof value.ok !== 'boolean'
    || value.openedDatabase !== false
    || value.requestedLoginKey !== false
    || (value.code !== undefined
      && (typeof value.code !== 'string' || !WORKER_ERROR_CODES.has(value.code)))
    || (!value.ok && value.code === undefined)
    || !isRecord(value.reader)
    || !isRecord(value.runtime)) return null;

  const reader = value.reader;
  if (Object.keys(reader).length !== 3
    || reader.implementation !== 'sqlite3mc'
    || reader.version !== '2.5.1'
    || typeof reader.readOnlySelfTestPassed !== 'boolean'
    || (value.ok && (value.code !== undefined || !reader.readOnlySelfTestPassed))) {
    return null;
  }

  const runtime = value.runtime;
  if (Object.keys(runtime).length !== 5
    || !isVersion(runtime.electron)
    || !isVersion(runtime.node)
    || !isVersion(runtime.v8, true)
    || runtime.architecture !== 'x64'
    || runtime.processType !== 'utility') return null;

  return {
    kind: 'native-preflight',
    ok: value.ok,
    ...(value.code === undefined ? {} : { code: value.code as string }),
    reader: {
      implementation: 'sqlite3mc',
      version: '2.5.1',
      readOnlySelfTestPassed: reader.readOnlySelfTestPassed,
    },
    runtime: {
      electron: runtime.electron,
      node: runtime.node,
      v8: runtime.v8,
      architecture: 'x64',
      processType: 'utility',
    },
    openedDatabase: false,
    requestedLoginKey: false,
  };
};

type LauncherFailure = 'preflight.timeout' | 'preflight.invalidReport'
  | 'preflight.spawnFailed' | 'preflight.workerExited' | 'preflight.appExiting'
  | 'preflight.appReadyFailed';

const failedReport = (code: LauncherFailure): NativePreflightReport => ({
  kind: 'native-preflight',
  ok: false,
  code,
  // A launcher failure cannot assert the runtime or reader state of the child.
  reader: null,
  runtime: null,
  openedDatabase: false,
  requestedLoginKey: false,
});

const collectReport = (): Promise<NativePreflightReport> => new Promise((resolve) => {
  let child: UtilityProcess | undefined;
  let finished = false;
  const cleanup = (): void => {
    app.removeListener('before-quit', onAppExit);
    process.removeListener('exit', onProcessExit);
    if (!child) return;
    child.removeListener('message', onMessage);
    child.removeListener('exit', onWorkerExit);
    try {
      child.kill();
    } catch {
      // Exit may have already disposed the child; do not print native errors.
    }
  };
  const finish = (report: NativePreflightReport): void => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    cleanup();
    resolve(report);
  };
  const onMessage = (value: unknown): void => {
    finish(parseNativePreflightReport(value) ?? failedReport('preflight.invalidReport'));
  };
  const onWorkerExit = (): void => finish(failedReport('preflight.workerExited'));
  const onAppExit = (): void => finish(failedReport('preflight.appExiting'));
  const onProcessExit = (): void => cleanup();
  const timer = setTimeout(() => finish(failedReport('preflight.timeout')), 15_000);
  app.once('before-quit', onAppExit);
  process.once('exit', onProcessExit);

  try {
    // Keep the packaged/development paths identical to the production launcher.
    const basePath = app.isPackaged ? process.resourcesPath : app.getAppPath();
    const workerPath = app.isPackaged
      ? path.join(process.resourcesPath, 'wechat-native-worker.js')
      : path.join(__dirname, 'wechat-native-worker.js');
    const resourceRoot = path.join(basePath, app.isPackaged
      ? 'wechat-reader' : path.join('native-resources', 'wechat-reader'));
    const koffiNodePath = path.join(basePath, app.isPackaged
      ? path.join('koffi', 'win32_x64', 'koffi.node')
      : path.join('native-resources', 'koffi', 'win32_x64', 'koffi.node'));
    child = utilityProcess.fork(workerPath, [], {
      cwd: path.dirname(workerPath),
      env: {
        ...createWechatWorkerEnvironment(process.env, {
          generation: 'preflight',
          resourceRoot,
          koffiNodePath,
          // Deliberately not a WeChat account. No account settings are read.
          accountRoot: path.dirname(workerPath),
        }),
        WECHAT_WORKER_PREFLIGHT: '1',
      },
      serviceName: 'WeChat Data Engine',
      stdio: 'pipe',
    });
    child.stdout?.resume();
    child.stderr?.resume();
    child.on('message', onMessage);
    child.once('exit', onWorkerExit);
  } catch {
    finish(failedReport('preflight.spawnFailed'));
  }
});

export const runWechatNativePreflight = async (): Promise<void> => {
  let report: NativePreflightReport;
  try {
    await app.whenReady();
    report = await collectReport();
  } catch {
    report = failedReport('preflight.appReadyFailed');
  }
  try {
    process.stdout.write(`${JSON.stringify(report)}\n`, (error) => {
      app.exit(error || !report.ok ? 1 : 0);
    });
  } catch {
    app.exit(1);
  }
};
