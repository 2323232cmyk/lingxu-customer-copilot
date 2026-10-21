import { EventEmitter } from 'node:events';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseNativePreflightReport, runWechatNativePreflight } from './native-preflight';

const electron = vi.hoisted(() => ({
  app: {
    isPackaged: false,
    getAppPath: vi.fn(() => 'C:\\copilot\\app'),
    whenReady: vi.fn(async (): Promise<void> => undefined),
    once: vi.fn(),
    removeListener: vi.fn(),
    exit: vi.fn(),
  },
  utilityProcess: { fork: vi.fn() },
}));
vi.mock('electron', () => electron);

const successfulReport = () => ({
  kind: 'native-preflight',
  ok: true,
  reader: { implementation: 'sqlite3mc', version: '2.5.1', readOnlySelfTestPassed: true },
  runtime: {
    electron: '44.0.0', node: '24.16.0', v8: '14.8.174.17-electron.0',
    architecture: 'x64', processType: 'utility',
  },
  openedDatabase: false,
  requestedLoginKey: false,
});

class FakeChild extends EventEmitter {
  readonly stdout = { resume: vi.fn() };
  readonly stderr = { resume: vi.fn() };
  readonly kill = vi.fn(() => true);
}

beforeEach(() => {
  vi.clearAllMocks();
  electron.app.isPackaged = false;
  electron.app.whenReady.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('native preflight report validation', () => {
  it('reconstructs only safe fields and copies nested objects', () => {
    const input = successfulReport();
    const parsed = parseNativePreflightReport(input);
    expect(parsed).toEqual(input);
    expect(parsed).not.toBe(input);
    expect(parsed?.reader).not.toBe(input.reader);
    expect(parsed?.runtime).not.toBe(input.runtime);
    input.reader.readOnlySelfTestPassed = false;
    input.runtime.electron = '1.2.3';
    expect(parsed?.reader?.readOnlySelfTestPassed).toBe(true);
    expect(parsed?.runtime?.electron).toBe('44.0.0');
  });

  it('accepts a fixed initialization failure without secret diagnostics', () => {
    const report = {
      ...successfulReport(),
      ok: false,
      code: 'database.initialize',
      reader: { ...successfulReport().reader, readOnlySelfTestPassed: false },
    };
    expect(parseNativePreflightReport(report)).toEqual(report);
  });

  it('accepts an early resource failure without claiming a passed self-test', () => {
    const report = {
      ...successfulReport(), ok: false, code: 'resource.load',
      reader: { ...successfulReport().reader, readOnlySelfTestPassed: false },
    };
    expect(parseNativePreflightReport(report)).toEqual(report);
  });

  it('preserves child runtime when the read-only self-test fails', () => {
    const report = {
      ...successfulReport(), ok: false, code: 'database.queryDenied',
      reader: { ...successfulReport().reader, readOnlySelfTestPassed: false },
    };
    expect(parseNativePreflightReport(report)).toEqual(report);
    expect(parseNativePreflightReport({ ...report, runtime: null })).toBeNull();
    expect(parseNativePreflightReport({ ...report, reader: null })).toBeNull();
    expect(parseNativePreflightReport({ ...report, code: undefined })).toBeNull();
  });

  it.each(['14.8.174', '14.8.174.17', '14.8.174-electron.0', '14.8.174.17-electron.0'])(
    'accepts numeric V8 version %s', (v8) => {
      const report = successfulReport();
      report.runtime.v8 = v8;
      expect(parseNativePreflightReport(report)).toEqual(report);
    },
  );

  it.each([
    null, undefined,
    { ...successfulReport().runtime, processType: 'browser' },
    { ...successfulReport().runtime, architecture: 'arm64' },
    { ...successfulReport().runtime, electron: undefined },
    { ...successfulReport().runtime, path: 'private path' },
    { ...successfulReport().runtime, electron: '44.0.0\n' },
    { ...successfulReport().runtime, electron: '44.0.0-beta.1' },
    { ...successfulReport().runtime, node: '24.16.0-private' },
    { ...successfulReport().runtime, electron: `${'1'.repeat(29)}.0.0` },
    { ...successfulReport().runtime, node: `${'1'.repeat(29)}.0.0` },
    { ...successfulReport().runtime, v8: '14.8.174.17-electron.0\r\n' },
    { ...successfulReport().runtime, v8: '14.8.174.17.1' },
    { ...successfulReport().runtime, v8: '14.8.174.17-private' },
    { ...successfulReport().runtime, v8: `${'1'.repeat(61)}.0.0` },
  ])('rejects unsafe or non-worker runtime %#', (runtime) => {
    expect(parseNativePreflightReport({ ...successfulReport(), runtime })).toBeNull();
  });

  it.each([
    null, undefined,
    { ...successfulReport().reader, implementation: 'TraceMemo' },
    { ...successfulReport().reader, version: '2.2.2' },
    { ...successfulReport().reader, version: '2.5.1\n' },
    { ...successfulReport().reader, readOnlySelfTestPassed: false },
    { ...successfulReport().reader, readOnlySelfTestPassed: 1 },
    { ...successfulReport().reader, readOnlySelfTestPassed: undefined },
    { ...successfulReport().reader, path: 'private account directory' },
    { ...successfulReport().reader, key: 'private secret' },
  ])('rejects unsafe or unverified reader state %#', (reader) => {
    expect(parseNativePreflightReport({ ...successfulReport(), reader })).toBeNull();
  });

  it.each([
    { message: 'private native detail' },
    { key: 'f'.repeat(64) },
    { accountRoot: 'private account directory' },
    { code: 'private diagnostic' },
    { code: 'resource.load' },
    { kind: 'hello' },
    { openedDatabase: true },
    { requestedLoginKey: true },
    { ok: 1 },
    { initialization: { protectionCodes: [0], initializeCode: 0 } },
    { diagnostics: { logEntries: 0, wordsPresent: [] } },
    { ok: false, code: 'database.protectionFailed' },
    { ok: false, code: 'private diagnostic' },
    { ok: false, code: 'preflight.spawnFailed', reader: null, runtime: null },
  ])('rejects malformed or unsafe report %#', (overrides) => {
    expect(parseNativePreflightReport({ ...successfulReport(), ...overrides })).toBeNull();
  });

  it.each([null, [], {}, 'private raw log'])('rejects a non-report value %#', (value) => {
    expect(parseNativePreflightReport(value)).toBeNull();
  });
});

describe('native preflight lifecycle', () => {
  const captureOutput = (): string[] => {
    const output: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk, encodingOrCallback, callback) => {
      output.push(String(chunk));
      const secondArgument: unknown = encodingOrCallback;
      if (typeof secondArgument === 'function') secondArgument();
      else callback?.();
      return true;
    });
    return output;
  };

  it('waits for app readiness, uses the production environment and drains both streams', async () => {
    let ready: (() => void) | undefined;
    electron.app.whenReady.mockReturnValue(new Promise<void>((resolve) => { ready = resolve; }));
    const child = new FakeChild();
    electron.utilityProcess.fork.mockReturnValue(child);
    const output = captureOutput();
    const running = runWechatNativePreflight();
    expect(electron.utilityProcess.fork).not.toHaveBeenCalled();
    ready?.();
    await Promise.resolve();
    const [workerPath, args, options] = electron.utilityProcess.fork.mock.calls[0];
    expect(path.basename(workerPath)).toBe('wechat-native-worker.js');
    expect(args).toEqual([]);
    expect(options).toMatchObject({
      cwd: path.dirname(workerPath),
      stdio: 'pipe',
      serviceName: 'WeChat Data Engine',
      env: {
        WECHAT_WORKER_PREFLIGHT: '1',
        WECHAT_WORKER_GENERATION: 'preflight',
        WECHAT_ACCOUNT_ROOT: path.dirname(workerPath),
        WECHAT_NATIVE_RESOURCE_ROOT: path.join('C:\\copilot\\app', 'native-resources', 'wechat-reader'),
        WECHAT_KOFFI_NODE_PATH: path.join('C:\\copilot\\app', 'native-resources', 'koffi', 'win32_x64', 'koffi.node'),
      },
    });
    expect(child.stdout.resume).toHaveBeenCalledOnce();
    expect(child.stderr.resume).toHaveBeenCalledOnce();
    child.emit('message', successfulReport());
    await running;
    expect(output).toEqual([`${JSON.stringify(successfulReport())}\n`]);
    expect(child.kill).toHaveBeenCalledOnce();
    expect(electron.app.exit).toHaveBeenCalledWith(0);
    expect(child.listenerCount('message')).toBe(0);
    expect(child.listenerCount('exit')).toBe(0);
  });

  it('uses the real packaged resource paths with the same dummy non-account directory', async () => {
    const previousResourcesPath = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
    Object.defineProperty(process, 'resourcesPath', { value: 'C:\\copilot\\resources', configurable: true });
    try {
      electron.app.isPackaged = true;
      const child = new FakeChild();
      electron.utilityProcess.fork.mockReturnValue(child);
      captureOutput();
      const running = runWechatNativePreflight();
      await Promise.resolve();
      const [workerPath, , options] = electron.utilityProcess.fork.mock.calls[0];
      expect(workerPath).toBe(path.join(process.resourcesPath, 'wechat-native-worker.js'));
      expect(options.env).toMatchObject({
        WECHAT_ACCOUNT_ROOT: process.resourcesPath,
        WECHAT_NATIVE_RESOURCE_ROOT: path.join(process.resourcesPath, 'wechat-reader'),
        WECHAT_KOFFI_NODE_PATH: path.join(process.resourcesPath, 'koffi', 'win32_x64', 'koffi.node'),
      });
      expect(electron.app.getAppPath).not.toHaveBeenCalled();
      child.emit('message', successfulReport());
      await running;
    } finally {
      if (previousResourcesPath) Object.defineProperty(process, 'resourcesPath', previousResourcesPath);
      else Reflect.deleteProperty(process, 'resourcesPath');
    }
  });

  it('never forwards raw message fields and exits unsuccessfully on invalid output', async () => {
    const child = new FakeChild();
    electron.utilityProcess.fork.mockReturnValue(child);
    const output = captureOutput();
    const running = runWechatNativePreflight();
    await Promise.resolve();
    child.emit('message', { ...successfulReport(), secret: 'private diagnostic' });
    await running;
    expect(output).toHaveLength(1);
    expect(output[0]).not.toContain('private diagnostic');
    expect(JSON.parse(output[0])).toMatchObject({ ok: false, code: 'preflight.invalidReport' });
    expect(electron.app.exit).toHaveBeenCalledWith(1);
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it('kills a stalled child after 15 seconds and ignores late output', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    electron.utilityProcess.fork.mockReturnValue(child);
    const output = captureOutput();
    const running = runWechatNativePreflight();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(15_000);
    await running;
    child.emit('message', successfulReport());
    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0])).toMatchObject({ ok: false, code: 'preflight.timeout' });
    expect(child.kill).toHaveBeenCalledOnce();
    expect(electron.app.exit).toHaveBeenCalledWith(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports unexpected child exit without exposing any child output', async () => {
    const child = new FakeChild();
    electron.utilityProcess.fork.mockReturnValue(child);
    const output = captureOutput();
    const running = runWechatNativePreflight();
    await Promise.resolve();
    child.emit('exit', 1);
    await running;
    expect(JSON.parse(output[0])).toMatchObject({ ok: false, code: 'preflight.workerExited' });
    expect(electron.app.exit).toHaveBeenCalledWith(1);
  });

  it('sanitizes a spawn failure and removes the timeout', async () => {
    vi.useFakeTimers();
    electron.utilityProcess.fork.mockImplementation(() => { throw new Error('private spawn details'); });
    const output = captureOutput();
    await runWechatNativePreflight();
    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0])).toEqual({
      kind: 'native-preflight', ok: false, code: 'preflight.spawnFailed',
      reader: null, runtime: null,
      openedDatabase: false, requestedLoginKey: false,
    });
    expect(output[0]).not.toContain('private spawn details');
    expect(electron.app.exit).toHaveBeenCalledWith(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
