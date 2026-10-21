import { describe, expect, it } from 'vitest';
import { createWechatWorkerEnvironment } from './worker-environment';

const options = {
  generation: 'generation:1',
  resourceRoot: 'C:\\Copilot\\resources\\wechat-native',
  koffiNodePath: 'C:\\Copilot\\resources\\koffi\\win32_x64\\koffi.node',
  accountRoot: 'D:\\WeChat Files\\test-account',
};

const workerConfiguration = {
  WECHAT_WORKER_GENERATION: options.generation,
  WECHAT_NATIVE_RESOURCE_ROOT: options.resourceRoot,
  WECHAT_KOFFI_NODE_PATH: options.koffiNodePath,
  WECHAT_ACCOUNT_ROOT: options.accountRoot,
};

describe('createWechatWorkerEnvironment', () => {
  it('uses only explicit worker configuration when the parent environment is empty', () => {
    expect(createWechatWorkerEnvironment({}, options)).toEqual(workerConfiguration);
  });

  it('preserves the required Windows runtime paths without changing their values', () => {
    const runtime = {
      SystemRoot: 'C:\\Windows',
      WINDIR: 'C:\\Windows',
      TEMP: 'D:\\Temporary Files',
      TMP: 'D:\\Temporary Files',
      USERPROFILE: 'C:\\Users\\Test User',
      LOCALAPPDATA: 'C:\\Users\\Test User\\AppData\\Local',
      APPDATA: 'C:\\Users\\Test User\\AppData\\Roaming',
      ProgramData: 'C:\\ProgramData',
      SystemDrive: 'C:',
      HOMEDRIVE: 'C:',
      HOMEPATH: '\\Users\\Test User',
      PATH: 'C:\\Windows\\System32;D:\\Runtime Tools',
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
      ProgramW6432: 'C:\\Program Files',
    };

    expect(createWechatWorkerEnvironment(runtime, options)).toEqual({
      ...runtime,
      ...workerConfiguration,
    });
  });

  it('normalizes Windows names and keeps only one canonical case for each variable', () => {
    const result = createWechatWorkerEnvironment({
      systemroot: 'C:\\Windows',
      windir: 'C:\\Windows',
      TeMp: 'D:\\Temp',
      appdata: 'D:\\Roaming',
      path: 'lowercase alias',
      PATH: 'C:\\Windows\\System32',
      Path: 'mixed-case alias',
      PROGRAMFILES: 'C:\\Program Files',
      'programfiles(X86)': 'C:\\Program Files (x86)',
      COMSPEC: 'C:\\Windows\\System32\\cmd.exe',
    }, options);

    expect(result).toEqual({
      SystemRoot: 'C:\\Windows',
      WINDIR: 'C:\\Windows',
      TEMP: 'D:\\Temp',
      APPDATA: 'D:\\Roaming',
      PATH: 'C:\\Windows\\System32',
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      ...workerConfiguration,
    });
  });

  it('does not inherit secrets or Electron and Node injection variables', () => {
    const result = createWechatWorkerEnvironment({
      TEMP: 'D:\\Temp',
      OPENAI_API_KEY: 'test-secret',
      TRACEMEMO_API_TOKEN: 'test-secret',
      ACCESS_TOKEN: 'test-secret',
      AWS_SECRET_ACCESS_KEY: 'test-secret',
      DATABASE_PASSWORD: 'test-secret',
      PATH_SECRET: 'test-secret',
      NODE_OPTIONS: '--require injected.cjs',
      NODE_PATH: 'D:\\Injected Modules',
      NODE_EXTRA_CA_CERTS: 'D:\\Injected Certificate.pem',
      ELECTRON_RUN_AS_NODE: '1',
      ELECTRON_ENABLE_LOGGING: '1',
      ELECTRON_REMOTE_DEBUGGING_PORT: '9222',
    }, options);

    expect(result).toEqual({ TEMP: 'D:\\Temp', ...workerConfiguration });
  });

  it('cannot override fixed worker settings through inherited environment values', () => {
    const result = createWechatWorkerEnvironment({
      WECHAT_WORKER_GENERATION: 'untrusted-generation',
      WECHAT_NATIVE_RESOURCE_ROOT: 'D:\\Other Resources',
      WECHAT_KOFFI_NODE_PATH: 'D:\\Other Runtime.node',
      WECHAT_ACCOUNT_ROOT: 'D:\\Other Account',
      wechat_account_root: 'D:\\Lowercase Alias',
      WECHAT_DEBUG: '1',
    }, options);

    expect(result).toEqual(workerConfiguration);
  });

  it('ignores undefined values and does not mutate either input', () => {
    const parent = Object.freeze({ SystemRoot: undefined, TEMP: 'D:\\Temp' });
    const configuration = Object.freeze({ ...options });

    expect(createWechatWorkerEnvironment(parent, configuration)).toEqual({
      TEMP: 'D:\\Temp',
      ...workerConfiguration,
    });
    expect(parent).toEqual({ SystemRoot: undefined, TEMP: 'D:\\Temp' });
    expect(configuration).toEqual(options);
  });
});
