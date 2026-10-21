import { contextBridge, ipcRenderer } from 'electron';
import { createFeaturePreloadBridge } from './shared/feature-preload';
import type {
  ConversationImportResult,
  RuntimeStatus,
  SalesCopilotBridge,
  SelectWechatRootResult,
  WechatLiveActionResult,
  WechatLiveDelta,
  WechatLiveSnapshot,
  WechatMessagesResult,
  WechatMediaResult,
} from './shared/contracts';

const bridge: SalesCopilotBridge = {
  ...createFeaturePreloadBridge((channel, ...args) => ipcRenderer.invoke(channel, ...args)),
  getRuntimeStatus: () => ipcRenderer.invoke('runtime:get-status') as Promise<RuntimeStatus>,
  importConversation: () =>
    ipcRenderer.invoke('conversation:import') as Promise<ConversationImportResult>,
  copyText: (text: string) => ipcRenderer.invoke('clipboard:copy', text) as Promise<void>,
  getWechatSnapshot: () =>
    ipcRenderer.invoke('wechat:get-snapshot') as Promise<WechatLiveSnapshot>,
  getWechatConversations: (cursor?: string) =>
    ipcRenderer.invoke('wechat:get-conversations', cursor) as Promise<WechatLiveActionResult>,
  getWechatMedia: (mediaKey: string) =>
    ipcRenderer.invoke('wechat:get-media', mediaKey) as Promise<WechatMediaResult>,
  startWechatLive: () =>
    ipcRenderer.invoke('wechat:start') as Promise<WechatLiveActionResult>,
  stopWechatLive: () =>
    ipcRenderer.invoke('wechat:stop') as Promise<WechatLiveSnapshot>,
  selectWechatAccountRoot: () =>
    ipcRenderer.invoke('wechat:select-root') as Promise<SelectWechatRootResult>,
  getWechatMessages: (contactKey: string, limit?: number) =>
    ipcRenderer.invoke('wechat:get-messages', contactKey, limit) as Promise<WechatMessagesResult>,
  watchWechatConversation: (contactKey: string) =>
    ipcRenderer.invoke('wechat:watch-conversation', contactKey) as Promise<void>,
  unwatchWechatConversation: () =>
    ipcRenderer.invoke('wechat:unwatch-conversation') as Promise<void>,
  onWechatDelta: (listener: (delta: WechatLiveDelta) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, delta: WechatLiveDelta): void => {
      listener(delta);
    };
    ipcRenderer.on('wechat:delta', handler);
    return () => ipcRenderer.removeListener('wechat:delta', handler);
  },
};

contextBridge.exposeInMainWorld('salesCopilot', bridge);
