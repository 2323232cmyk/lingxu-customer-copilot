import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { parseWechatTasklistPids } from '../adapters/wechat-native/native-normalize';

const execFileAsync = promisify(execFile);

export const findWechatProcessIds = async (): Promise<number[]> => {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const tasklist = path.join(systemRoot, 'System32', 'tasklist.exe');
  const { stdout } = await execFileAsync(tasklist, ['/FO', 'CSV', '/NH'], {
    windowsHide: true,
    timeout: 5000,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  return parseWechatTasklistPids(String(stdout));
};
