import { app } from 'electron';
import path from 'node:path';
import { runWechatConnectionCheck } from '../src/main/services/wechat-connection-check';

const root = process.cwd();
void runWechatConnectionCheck({
  sourceSettingsPath: path.join(app.getPath('appData'), 'LingxuCopilotPublic', 'wechat-source.json'),
  workerPaths: {
    workerPath: path.join(root, 'outputs', 'wechat-connection-check', 'wechat-native-worker.js'),
    resourceRoot: path.join(root, 'native-resources', 'wechat-reader'),
    koffiNodePath: path.join(root, 'native-resources', 'koffi', 'win32_x64', 'koffi.node'),
  },
});
