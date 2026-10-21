import { app } from 'electron';
import { mkdtempSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createLiveWechatWorkerSpawn, WechatEngineManager, WechatWorkerCommandError } from '../adapters/wechat-native';
import type { LiveWechatWorkerSpawnOptions } from '../adapters/wechat-native/live-worker-spawn';
import { WechatLiveService } from './wechat-live-service';
import { findWechatProcessIds } from './wechat-processes';
import { createDiagnosticReporter } from './diagnostic-output';

interface ConnectionCheckOptions {
  readonly sourceSettingsPath?: string;
  readonly workerPaths?: Omit<LiveWechatWorkerSpawnOptions, 'accountRoot'>;
}

/** Explicit diagnostic mode: read the selected account, print counts only, never send. */
export const runWechatConnectionCheck = async (options: ConnectionCheckOptions = {}): Promise<void> => {
  let service: WechatLiveService | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let succeeded = false;
  let realtimeMessageCount = 0;
  let currentMessageCount = 0;
  let currentHumanMessageCount = 0;
  let watchStartedAt: number | undefined;
  const print = createDiagnosticReporter(process.stdout);
  try {
    // Keep the real app's saved selection, but never open its Chromium profile.
    const configPath = options.sourceSettingsPath ?? path.join(app.getPath('userData'), 'wechat-source.json');
    app.setPath('userData', mkdtempSync(path.join(app.getPath('temp'), 'fapai-wechat-check-')));
    app.disableHardwareAcceleration();
    await app.whenReady();
    const config = JSON.parse(await readFile(configPath, 'utf8')) as { accountRoot?: unknown };
    if (typeof config.accountRoot !== 'string' || !path.isAbsolute(config.accountRoot)) throw new Error('configuration');
    const manager = new WechatEngineManager({
      spawn: createLiveWechatWorkerSpawn({ accountRoot: config.accountRoot, ...options.workerPaths }),
      maxRestartAttempts: 0,
    });
    const request = manager.request.bind(manager);
    manager.request = async (command, payload, timeout) => {
      try { return await request(command, payload, timeout); } catch (error) {
        if (error instanceof WechatWorkerCommandError && /^[a-zA-Z0-9._-]{1,96}$/u.test(error.code)) {
          print({ phase: command, code: error.code });
        }
        throw error;
      }
    };
    manager.subscribeEvents((event) => {
      if (event.event !== 'engine.state') return;
      const code = event.payload.detailCode;
      if (typeof code === 'string' && /^[a-zA-Z0-9._-]{1,96}$/u.test(code)) print({ phase: 'engine', code });
    });
    service = new WechatLiveService({ accountRoot: config.accountRoot, manager, processIds: findWechatProcessIds });
    let lastStatus = '';
    service.subscribe((delta) => {
      realtimeMessageCount += delta.messages.length;
      const since = watchStartedAt;
      const current = since === undefined ? []
        : delta.messages.filter((message) => Date.parse(message.sentAt) >= since);
      currentMessageCount += current.length;
      currentHumanMessageCount += current.filter((message) => message.messageType !== 'system').length;
      const status = JSON.stringify({ state: delta.status.state, detail: delta.status.detail });
      if (status !== lastStatus) print({ state: delta.status.state, detail: delta.status.detail });
      lastStatus = status;
    });
    timer = setTimeout(() => {
      service?.dispose();
      print({ connected: false, code: 'check.timeout' });
      app.exit(1);
    }, 85_000);
    let snapshot = await service.start();
    print({ phase: 'sessions', conversationCount: snapshot.conversations.length });
    if (process.argv.includes('--check-inbox-media')) {
      let pageCount = 1;
      while (snapshot.nextConversationCursor && pageCount < 500) {
        snapshot = await service.conversationsPage(snapshot.nextConversationCursor);
        pageCount++;
      }
      print({ phase: 'inbox', pageCount, conversationCount: snapshot.conversations.length,
        uniqueConversationCount: new Set(snapshot.conversations.map((item) => item.contactKey)).size,
        listComplete: !snapshot.nextConversationCursor });
      const avatars = snapshot.conversations.filter((item) => item.avatarMediaKey).slice(0, 12);
      let renderedAvatarCount = 0;
      for (const conversation of avatars) {
        const result = await service.mediaForRenderer(conversation.avatarMediaKey);
        if (result.ok && result.dataUrl.startsWith(`data:${result.mime};base64,`)) renderedAvatarCount++;
      }
      print({ phase: 'avatar-through-worker-and-main', availableAvatarCount: snapshot.conversations.filter((item) => item.avatarMediaKey).length,
        checkedAvatarCount: avatars.length, renderedAvatarCount });
    }
    // This acceptance check covers direct customer conversations, not group parity.
    const contacts = snapshot.conversations.filter((item) => item.kind === 'contact').slice(0, 10);
    let sampleMessageCount = 0;
    let sampleDirectionKnown = true;
    for (const contact of contacts) {
      const sample = await service.messagesSnapshot(contact.contactKey, 3);
      sampleMessageCount += sample.length;
      sampleDirectionKnown &&= sample.every((item) => item.messageType === 'system'
        ? item.direction === 'system' : ['incoming', 'outgoing'].includes(item.direction));
      if (sampleMessageCount > 0) break;
    }
    if (!sampleMessageCount || !sampleDirectionKnown) {
      print({ connected: false, code: 'check.messagesUnverified', conversationCount: snapshot.conversations.length });
      return;
    }
    const watchArgument = process.argv.find((argument) => /^--watch-seconds=\d{1,2}$/u.test(argument));
    const watchSeconds = Math.min(25, Number(watchArgument?.split('=')[1] ?? 0));
    if (watchSeconds > 0) {
      watchStartedAt = Math.ceil(Date.now() / 1000) * 1000;
      await service.watchContacts(contacts.map((conversation) => conversation.contactKey));
      print({ phase: 'watching', scope: 'direct-contact', contactCount: contacts.length, seconds: watchSeconds });
      await new Promise<void>((resolve) => setTimeout(resolve, watchSeconds * 1000));
      if (service.snapshot().status.state !== 'streaming') throw new Error('stream');
    }
    succeeded = true;
    print({
      connected: true, scope: 'direct-contact', packaged: app.isPackaged, version: app.getVersion(),
      conversationCount: snapshot.conversations.length, sampleMessageCount, sampleDirectionKnown,
      realtimeMessageCount, currentMessageCount, currentHumanMessageCount,
      newMessageVerified: currentHumanMessageCount > 0,
    });
  } catch {
    print({ connected: false, ...(service ? { detail: service.snapshot().status.detail } : { code: 'check.configuration' }) });
  } finally {
    if (timer) clearTimeout(timer);
    if (service) { try { await service.stop(); } catch { /* Dispose still terminates the worker. */ } }
    service?.dispose();
    app.exit(succeeded ? 0 : 1);
  }
};
