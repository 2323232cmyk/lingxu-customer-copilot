const WINDOWS_RUNTIME_VARIABLES = [
  'SystemRoot',
  'WINDIR',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'LOCALAPPDATA',
  'APPDATA',
  'ProgramData',
  'SystemDrive',
  'HOMEDRIVE',
  'HOMEPATH',
  'PATH',
  'ComSpec',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramW6432',
] as const;

const canonicalNames = new Map(WINDOWS_RUNTIME_VARIABLES.map((name) => [
  name.toLowerCase(), name,
]));

export interface WechatWorkerEnvironmentOptions {
  readonly generation: string;
  readonly resourceRoot: string;
  readonly koffiNodePath: string;
  readonly accountRoot: string;
}

export const createWechatWorkerEnvironment = (
  parentEnvironment: Readonly<Record<string, string | undefined>>,
  options: WechatWorkerEnvironmentOptions,
): Record<string, string> => {
  const inherited: Record<string, string> = {};
  for (const [name, value] of Object.entries(parentEnvironment)) {
    const canonicalName = canonicalNames.get(name.toLowerCase());
    if (!canonicalName || value === undefined) continue;
    // Prefer canonical casing when a synthetic environment contains duplicate aliases.
    if (inherited[canonicalName] === undefined || name === canonicalName) {
      inherited[canonicalName] = value;
    }
  }

  // Explicit env replaces inheritance in utilityProcess.fork. Keep runtime paths,
  // but never forward application secrets or Node/Electron injection settings.
  return {
    ...inherited,
    WECHAT_WORKER_GENERATION: options.generation,
    WECHAT_NATIVE_RESOURCE_ROOT: options.resourceRoot,
    WECHAT_KOFFI_NODE_PATH: options.koffiNodePath,
    WECHAT_ACCOUNT_ROOT: options.accountRoot,
  };
};
