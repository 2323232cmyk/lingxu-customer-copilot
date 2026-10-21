import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  net,
  safeStorage,
  shell,
  type IpcMainInvokeEvent,
} from 'electron';
import path from 'node:path';
import type {
  ConversationImportResult,
  RuntimeStatus,
  SelectWechatRootResult,
  WechatLiveActionResult,
  WechatLiveDelta,
  WechatLiveSnapshot,
  WechatMessagesResult,
  WechatMediaResult,
} from '../shared/contracts';
import { probeWechatNativeResources } from './adapters/wechat-native';
import { isTrustedRendererUrl } from './renderer-trust';
import { importConversationFile } from './services/conversation-import';
import {
  resolveWechatAccountRootHint,
  saveWechatAccountRoot,
} from './services/wechat-account-root';
import { WechatLiveService } from './services/wechat-live-service';
import { registerFeatureHandlers } from './feature-ipc';
import { FeatureController } from './services/feature-controller';
import { IntegrationService } from './services/integration-service';
import { OfflineTranscriptionService } from './services/offline-transcription';
import { LocalPlanStore } from './services/local-plan-store';

const assertTrustedSender = (event: IpcMainInvokeEvent, expectedRendererUrl: string): void => {
  const frame = event.senderFrame;
  if (!frame) {
    throw new Error('已拒绝来源不明的页面请求');
  }
  const sourceUrl = frame.url;
  if (frame !== event.sender.mainFrame || !isTrustedRendererUrl(sourceUrl, expectedRendererUrl)) {
    throw new Error('已拒绝非受信任页面请求');
  }
};

const stoppedSnapshot = (detail = '尚未选择微信账号数据目录'): WechatLiveSnapshot => ({
  revision: 0,
  status: {
    state: 'stopped',
    detail,
    monitoring: false,
    updatedAt: new Date().toISOString(),
  },
  conversations: [],
});

const isContactKey = (value: unknown): value is string =>
  typeof value === 'string'
  && value.length > 0
  && value.length <= 256
  && /^[a-zA-Z0-9._:@-]+$/u.test(value);

export interface IpcRegistration {
  dispose(): void;
}

export const registerIpcHandlers = (expectedRendererUrl: string): IpcRegistration => {
  let liveService: WechatLiveService | undefined;
  let liveAccountRoot: string | undefined;
  let watchRequest = 0;
  let unsubscribeLive: (() => void) | undefined;
  const userDataPath = app.getPath('userData');

  const broadcastDelta = (delta: WechatLiveDelta): void => {
    features?.onWechatDelta(delta);
    for (const window of BrowserWindow.getAllWindows()) {
      if (
        !window.isDestroyed()
        && isTrustedRendererUrl(window.webContents.getURL(), expectedRendererUrl)
      ) {
        window.webContents.send('wechat:delta', delta);
      }
    }
  };

  const replaceService = (accountRoot: string): WechatLiveService => {
    watchRequest += 1;
    features?.resetWechatScope();
    unsubscribeLive?.();
    liveService?.dispose();
    liveService = new WechatLiveService({ accountRoot });
    liveAccountRoot = accountRoot;
    unsubscribeLive = liveService.subscribe(broadcastDelta);
    return liveService;
  };

  const resolveService = async (): Promise<WechatLiveService | null> => {
    const hint = await resolveWechatAccountRootHint({ userDataPath });
    if (!hint.accountRoot) return null;
    if (!liveService || liveAccountRoot !== hint.accountRoot) {
      return replaceService(hint.accountRoot);
    }
    return liveService;
  };

  const localFetch: typeof fetch = (input, init) => net.fetch(input instanceof URL ? input.href : input, { ...init, credentials: 'omit' });
  const integrations = new IntegrationService({
    settingsPath: path.join(userDataPath, 'integrations.json'), knowledgeRepositoryPath: path.join(userDataPath, 'knowledge-workspace.enc.json'), secretStorage: safeStorage, fetch: localFetch, cloudKnowledge: false,
  });
  const voice = new OfflineTranscriptionService({
    modelDirectory: path.join(userDataPath, 'offline-models', 'sensevoice-int8'),
    workerPath: app.isPackaged ? path.join(process.resourcesPath, 'voice-transcription-worker.js') : path.join(app.getAppPath(), '.vite', 'build', 'voice-transcription-worker.js'),
    runtimeRoot: app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'node_modules'),
    fetch: localFetch,
  });
  const features = new FeatureController({
    userDataPath, integrations, voice, getLiveService: resolveService,
    localPlans: new LocalPlanStore(path.join(userDataPath, 'local-plans.enc.json'), safeStorage),
    choosePath: async (kind) => {
      const titles = {
        knowledge: '选择知识库文件夹（Markdown / TXT / Obsidian 仓库）',
        'voice-model': '选择包含 model.int8.onnx 和 tokens.txt 的离线模型文件夹',
        audio: '选择本机 WAV 或 SILK 音频（不会上传）',
        export: '选择聊天档案导出位置',
        'previous-export': '选择此前领序导出的 HTML 档案文件夹（包含 archive.json）',
      };
      const result = await dialog.showOpenDialog({ title: titles[kind],
        properties: kind === 'audio' ? ['openFile'] : ['openDirectory'],
        ...(kind === 'audio' ? { filters: [{ name: '本地语音', extensions: ['wav', 'silk', 'slk'] }] } : {}),
      });
      return !result.canceled && result.filePaths[0] ? result.filePaths[0] : null;
    },
    chooseKnowledgeFiles: async () => {
      const result = await dialog.showOpenDialog({
        title: '导入知识资料（每次最多 20 个 Markdown / TXT 文件）',
        properties: ['openFile', 'multiSelections', 'dontAddToRecent'],
        filters: [{ name: '知识资料', extensions: ['md', 'txt'] }],
      });
      return result.canceled ? null : result.filePaths;
    },
    openDirectory: (directory) => shell.openPath(directory),
  });
  const unregisterFeatures = registerFeatureHandlers(ipcMain, features, (event: IpcMainInvokeEvent) => assertTrustedSender(event, expectedRendererUrl));

  ipcMain.handle('runtime:get-status', async (event): Promise<RuntimeStatus> => {
    assertTrustedSender(event, expectedRendererUrl);
    let wechatState: RuntimeStatus['sources'][number]['state'] = 'attention';
    let wechatDetail = '微信原生读取组件尚未就绪';
    try {
      const resourceRoot = app.isPackaged
        ? path.join(process.resourcesPath, 'wechat-reader')
        : path.join(app.getAppPath(), 'native-resources', 'wechat-reader');
      const [probe, service] = await Promise.all([
        probeWechatNativeResources(resourceRoot),
        resolveService(),
      ]);
      if (!probe.available) {
        const issueCount = probe.missingFiles.length + probe.mismatchedFiles.length;
        wechatState = 'offline';
        wechatDetail = `微信原生读取组件存在 ${issueCount} 项校验问题`;
      } else if (!service) {
        wechatDetail = '原生组件已校验，请选择微信账号数据目录';
      } else {
        const status = service.snapshot().status;
        wechatState = status.state === 'streaming' || status.state === 'ready'
          ? 'ready'
          : status.state === 'fatal'
            ? 'offline'
            : 'attention';
        wechatDetail = status.state === 'stopped'
          ? '账号目录已确认，等待启动实时读取'
          : status.detail;
      }
    } catch {
      wechatState = 'offline';
      wechatDetail = '微信原生读取组件校验失败';
    }
    const configured = integrations.getSettings();
    const knowledgeState = configured.knowledge.state ?? (configured.knowledge.documents ? 'ready' : 'idle');
    const knowledgeReady = knowledgeState === 'ready' && configured.knowledge.documents > 0;
    const knowledgeDetail = knowledgeState === 'indexing' ? '知识资料正在整理，完成前暂不可用于回复'
      : knowledgeState === 'error' ? '知识索引整理失败，当前资料暂不可用于回复；请重新整理'
        : knowledgeReady ? `已索引 ${configured.knowledge.documents} 份本地资料`
          : '请在知识库导入并审核资料，或在设置中选择外部目录';
    return {
      version: app.getVersion(),
      mode: 'manual-assist',
      sources: [
        { id: 'wechat', label: '微信数据', state: wechatState, detail: wechatDetail },
        { id: 'crm', label: 'CRM', state: configured.crm.hasSession ? 'ready' : 'attention', detail: configured.crm.hasSession ? '已保存登录状态 · 仅按需读取授权资料' : '请在设置中填写地址并登录 CRM' },
        { id: 'knowledge', label: '知识库', state: knowledgeState === 'error' ? 'offline' : knowledgeReady ? 'ready' : 'attention', detail: knowledgeDetail },
      ],
    };
  });

  ipcMain.handle('wechat:get-snapshot', async (event): Promise<WechatLiveSnapshot> => {
    assertTrustedSender(event, expectedRendererUrl);
    const service = await resolveService();
    return service?.snapshot() ?? stoppedSnapshot();
  });

  ipcMain.handle('wechat:get-media', async (event, mediaKey: unknown): Promise<WechatMediaResult> => {
    assertTrustedSender(event, expectedRendererUrl);
    // Do not resolve paths/configuration on arbitrary renderer input.
    if (typeof mediaKey !== 'string' || !/^[a-f0-9]{64}$/u.test(mediaKey)) return { ok: false, reason: 'missing' };
    return liveService?.mediaForRenderer(mediaKey) ?? { ok: false, reason: 'missing' };
  });

  ipcMain.handle('wechat:get-conversations', async (event, cursor: unknown): Promise<WechatLiveActionResult> => {
    assertTrustedSender(event, expectedRendererUrl);
    const service = await resolveService();
    if (!service) {
      const snapshot = stoppedSnapshot();
      return { ok: false, error: snapshot.status.detail, status: snapshot.status };
    }
    if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > 256)) {
      return { ok: false, error: '微信会话分页参数无效', status: service.snapshot().status };
    }
    try {
      return { ok: true, snapshot: await service.conversationsPage(cursor as string | undefined) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '读取微信会话失败', status: service.snapshot().status };
    }
  });

  ipcMain.handle('wechat:start', async (event): Promise<WechatLiveActionResult> => {
    assertTrustedSender(event, expectedRendererUrl);
    const service = await resolveService();
    if (!service) {
      const snapshot = stoppedSnapshot();
      return { ok: false, error: snapshot.status.detail, status: snapshot.status };
    }
    try {
      return { ok: true, snapshot: await service.start() };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : '微信数据暂时不可用，请稍后重试',
        status: service.snapshot().status,
      };
    }
  });

  ipcMain.handle('wechat:stop', async (event): Promise<WechatLiveSnapshot> => {
    assertTrustedSender(event, expectedRendererUrl);
    watchRequest += 1;
    features?.resetWechatScope();
    const service = await resolveService();
    return service ? service.stop() : stoppedSnapshot();
  });

  ipcMain.handle('wechat:select-root', async (event): Promise<SelectWechatRootResult> => {
    assertTrustedSender(event, expectedRendererUrl);
    const result = await dialog.showOpenDialog({
      title: '选择微信账号目录（目录内应包含 db_storage）',
      properties: ['openDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) {
      return { ok: false, cancelled: true };
    }
    try {
      watchRequest += 1;
      if (liveService) await liveService.stop();
      await saveWechatAccountRoot(userDataPath, result.filePaths[0]);
      replaceService(result.filePaths[0]);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        cancelled: false,
        error: error instanceof Error ? error.message : '无法使用所选微信账号目录',
      };
    }
  });

  ipcMain.handle(
    'wechat:get-messages',
    async (event, contactKey: unknown, limit: unknown): Promise<WechatMessagesResult> => {
      assertTrustedSender(event, expectedRendererUrl);
      if (
        !isContactKey(contactKey)
        || (limit !== undefined && (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 500))
      ) {
        return { ok: false, error: '微信会话参数无效' };
      }
      const service = await resolveService();
      if (!service) return { ok: false, error: '请先选择微信账号数据目录' };
      try {
        return {
          ok: true,
          contactKey,
          messages: await service.messagesSnapshot(contactKey, limit === undefined ? 100 : Number(limit)),
        };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : '微信消息读取失败',
        };
      }
    },
  );

  ipcMain.handle('wechat:watch-conversation', async (event, contactKey: unknown): Promise<void> => {
    assertTrustedSender(event, expectedRendererUrl);
    if (!isContactKey(contactKey)) throw new Error('微信会话参数无效');
    const operation = ++watchRequest;
    const service = await resolveService();
    if (!service) throw new Error('请先选择微信账号数据目录');
    if (operation !== watchRequest || service !== liveService) throw new Error('会话切换已取消，请重新选择会话');
    await service.watchContacts([contactKey]);
  });

  ipcMain.handle('wechat:unwatch-conversation', async (event): Promise<void> => {
    assertTrustedSender(event, expectedRendererUrl);
    watchRequest += 1;
    // Do not await path/configuration resolution: cancel already queued watch IPC
    // requests immediately, including ones still waiting for the account hint.
    await liveService?.unwatchContacts();
  });

  ipcMain.handle('conversation:import', async (event): Promise<ConversationImportResult> => {
    assertTrustedSender(event, expectedRendererUrl);
    const result = await dialog.showOpenDialog({
      title: '导入聊天记录',
      properties: ['openFile'],
      filters: [{ name: '聊天记录', extensions: ['json', 'txt', 'md'] }],
    });
    if (result.canceled || !result.filePaths[0]) {
      return { ok: false, cancelled: true };
    }
    try {
      return { ok: true, conversation: await importConversationFile(result.filePaths[0]) };
    } catch (error) {
      return {
        ok: false,
        cancelled: false,
        error: error instanceof Error ? error.message : '导入失败',
      };
    }
  });

  ipcMain.handle('clipboard:copy', (event, text: unknown): void => {
    assertTrustedSender(event, expectedRendererUrl);
    if (typeof text !== 'string' || text.length > 5000) {
      throw new Error('复制内容无效');
    }
    clipboard.writeText(text);
  });

  return {
    dispose: () => {
      unregisterFeatures();
      features?.dispose();
      unsubscribeLive?.();
      liveService?.dispose();
    },
  };
};
