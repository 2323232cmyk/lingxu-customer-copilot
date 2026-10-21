/* Synthetic UI verification only. Never loads the app main/preload or saved user data. */
const fs = require('node:fs');
const path = require('node:path');
const project = path.resolve(__dirname, '..');
const argument = (name) => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };

function installSyntheticBridge(version) {
  const stamp = new Date().toISOString();
  const accountKey = 'synthetic-ui-account';
  const contactKey = 'synthetic-lin';
  const ok = (value) => ({ ok: true, value });
  const calls = { preview: [], generate: [], cancelled: [], copies: [], exports: [], unexpected: [], errors: [] };
  window.__uiSmoke = calls;
  window.addEventListener('error', (event) => calls.errors.push(event.message));
  window.addEventListener('unhandledrejection', (event) => calls.errors.push(String(event.reason)));
  if (!sessionStorage.getItem('synthetic-ui-initialized')) {
    localStorage.clear();
    localStorage.setItem('lingxu.workspace-design.v1', 'A');
    localStorage.setItem('lingxu.appearance.v1', JSON.stringify({ skin: 'warm', accent: 'gold' }));
    sessionStorage.setItem('synthetic-ui-initialized', 'true');
  }
  const status = { state: 'streaming', detail: '合成数据 · 隔离界面验证，未读取真实微信', monitoring: true, updatedAt: stamp };
  const conversations = [
    { contactKey, displayName: '合成客户 · 林女士', kind: 'contact', preview: '方便说一下你们具体怎么服务吗？', unreadCount: 2 },
    { contactKey: 'synthetic-zhou', displayName: '合成客户 · 周先生', kind: 'contact', preview: '收到，我和家里人再商量一下。', unreadCount: 0 },
    { contactKey: 'synthetic-zhao', displayName: '合成客户 · 赵女士', kind: 'contact', preview: '我主要考虑滨江附近，交通方便一点。', unreadCount: 1 },
    { contactKey: 'synthetic-chen', displayName: '合成客户 · 陈先生', kind: 'contact', preview: '周末有空再聊。', unreadCount: 0 },
    { contactKey: 'synthetic-group', displayName: '合成群聊 · 界面验收', kind: 'group', preview: '本会话仅用于界面测试。', unreadCount: 0 },
  ].map((item, index) => ({ ...item, lastMessageAt: new Date(Date.now() - index * 12 * 60_000).toISOString() }));
  const messages = [
    ['incoming', '你好，我想了解一下法拍房。'],
    ['outgoing', '你好，你主要考虑哪个区域，自住还是投资？'],
    ['incoming', '自住，想在滨江附近看看。'],
    ['outgoing', '了解，区域先记下了，你最想先了解哪方面？'],
    ['incoming', '方便说一下你们具体怎么服务吗？'],
  ].map(([direction, text], index) => ({ id: `synthetic-message-${index}`, contactKey, direction,
    sender: direction === 'incoming' ? '合成客户 · 林女士' : '合成销售', text, messageType: 'text',
    sentAt: new Date(Date.now() - (5 - index) * 90_000).toISOString(), observedAt: stamp }));
  const snapshot = { revision: 1, accountKey, status, conversations };
  const knowledge = { source: 'cloud', state: 'ready', folderPath: 'https://knowledge.example.com', documents: 3, chunks: 3,
    indexedAt: stamp, skipped: 0, warnings: ['合成知识状态，仅用于界面验证'], supportedExtensions: [] };
  const settings = { crm: { baseUrl: 'https://crm.example.invalid', username: 'synthetic-review', rememberSession: false, allowInsecureHttp: false, hasSession: true },
    ai: { provider: 'openai', baseUrl: 'https://model.example.invalid/v1', model: 'synthetic-review-model', rememberKey: false, allowRemote: true, hasApiKey: true, isLocal: false },
    knowledge, secureStorageAvailable: true };
  const context = { customer: { id: 101, name: '合成客户 · 林女士', budget: '尚未确认', area: '滨江附近（合成）', location: '杭州（合成）',
    customerType: '自住', phone: '未提供', firstContact: '合成记录：先了解服务，再核对需求。' },
    followups: [{ id: 1, content: '合成跟进：客户希望先了解服务方式。', createdAt: stamp, author: '合成销售' }],
    calls: [{ id: 1, notes: '合成通话摘要：当前未约定下一次联系时间。', createdAt: stamp }], tasks: [], houseTargets: [],
    fetchedAt: stamp, sourceBaseUrl: 'https://crm.example.invalid', availability: { followups: 'available', calls: 'available' } };
  const sources = [
    { id: 'chat:synthetic', title: '微信聊天 · 合成会话', text: messages.map((item) => `${item.sender}：${item.text}`).join('\n') },
    { id: 'crm:synthetic', title: 'CRM 档案与跟进 · 合成资料', text: '自住，关注滨江附近，预算尚未确认。所有资料为合成验收数据。' },
    { id: 'kb:synthetic', title: '公司知识库 · 合成片段', text: '服务安排应依正式合同和经审核的公司规则说明，未知事项先核实。', sourcePath: '合成知识 / 界面验收' },
  ];
  const contextSummary = { focus: '方便说一下你们具体怎么服务吗？', chatMessages: messages.length, crmRecords: 3,
    knowledgeHits: 1, knowledgeStatus: 'included', knowledgeQueries: ['客户希望了解公司服务流程，需要先明确哪些事项？'] };
  const generated = { provider: 'openai', model: 'synthetic-review-model', contextSummary,
    drafts: [{ text: '好的，林女士，我先把流程用文字说明白，你可以慢慢看。我们会先了解你自住的需求、考虑的区域和大致预算，再一起核对具体房源的公告、看样安排以及需要进一步确认的情况。选定房源以后，保证金、报名截止时间、尾款期限、贷款条件和交付方式，都以对应公告、法院要求及实际审核结果为准，不能把别的房源条件直接套过来。你提到主要考虑滨江附近，这一点我记下了；是否涉及上学、通勤和入住时间，我们可以按你的实际需要逐项确认。关于税费承担、是否腾空、产权和后续过户，也需要看具体材料后再说清楚。公司具体提供哪些服务、费用怎么算、什么情况下可以调整，最终会在正式合同里写明白。你先看看这些环节，最想了解哪一步，我们就先聊哪一步；没有核实的内容我不会提前给你保证。这里只是合成界面验收文字，用来检查长回复是否仍然容易编辑、切换和复制，不代表真实业务承诺，也不会发送到微信。', reason: '先回应客户正在询问的服务问题，不急着推进邀约。', sourceIds: sources.map((source) => source.id) },
      { text: '可以，咱们先把服务方式聊清楚：先核对你的需求和具体房源，再逐项说明公告、报名、资金安排和后续手续。每套房的条件都可能不同，费用和服务范围也会按正式合同确认。你最关心哪个环节，我们就先从那里聊。这里是另一条合成回复，用于检查切换版本和人工编辑是否保留。', reason: '更简短地回应当前问题。', sourceIds: ['chat:synthetic'] }],
    sources: sources.map(({ id, title, sourcePath }) => ({ id, title, sourcePath })), warnings: ['AI 草稿仅供人工核对，引用存在不代表结论必然正确；不会自动发送'] };
  const bridge = {
    getRuntimeStatus: async () => ({ version: `${version} · 合成验证`, mode: 'manual-assist', sources: [
      { id: 'wechat', label: '微信', state: 'ready', detail: '合成连接' }, { id: 'crm', label: 'CRM', state: 'ready', detail: '合成连接' },
      { id: 'knowledge', label: '知识库', state: 'ready', detail: '合成连接' }] }),
    getWechatSnapshot: async () => snapshot,
    getWechatConversations: async () => ({ ok: true, snapshot }),
    getWechatMessages: async (key) => ({ ok: true, contactKey: key, messages: [...messages, ...(calls.waiting ? [{...messages[0], id:'synthetic-waiting-question', direction:'outgoing', sender:'合成销售', text:'你看周末哪天方便？', sentAt:new Date().toISOString()}] : [])].map((item) => ({ ...item, contactKey: key })) }),
    watchWechatConversation: async () => {}, unwatchWechatConversation: async () => {}, onWechatDelta: () => () => {},
    getWechatMedia: async () => ({ ok: false, reason: 'missing' }),
    getIntegrationSettings: async () => ok(settings),
    getConversationCrmBinding: async () => ok({ customerId: 101, customerName: '合成客户 · 林女士', confirmedAt: stamp }),
    getCrmCustomerContext: async () => ok(context),
    listCrmCustomers: async () => ok({ customers: [{ ...context.customer, ownerId: 1, ownerName: '合成销售', level: 'B', accessProfile: 'full',
      lastFollowupAt: stamp, lastFollowupContent: '合成跟进：希望先了解服务方式。', nextFollowupAt: '', followupCount: 1,
      isVisited: false, isDeal: false, visitAt: '', dealSignedAt: '', updatedAt: stamp, isFavorite: false, tags: '' }],
      total: 1, page: 1, limit: 50, hasMore: false, fetchedAt: stamp, sourceBaseUrl: 'https://crm.example.invalid' }),
    getVoiceStatus: async () => ({ engine: 'SenseVoice', state: 'ready', detail: '合成语音状态 · 未加载真实模型', downloadedBytes: 0, totalBytes: 0, queued: 0, active: false }),
    previewConversationReply: async (input) => { calls.preview.push(input); return ok({ previewId: `synthetic-preview-${calls.preview.length}`,
      scope: input.scope, expiresAt: new Date(Date.now() + 300_000).toISOString(), provider: 'openai', model: 'synthetic-review-model',
      destination: 'https://model.example.invalid/v1', isRemote: true, sources, contextSummary, warnings: ['合成资料验证，不会连接真实模型或产生费用。'] }); },
    generateConversationReply: async (input) => { calls.generate.push(input); if (input.remoteConsent !== true) throw new Error('Synthetic remote generation requires explicit consent');
      if (calls.holdGeneration) await new Promise((resolve) => { window.__releaseSyntheticGeneration = resolve; }); return ok(generated); },
    cancelConversationReply: async (input) => { calls.cancelled.push(input); return ok(undefined); },
    copyText: async (text) => { calls.copies.push(text); },
    startConversationExport: async (input) => { calls.exports.push(input); return ok({ id: 'synthetic-export', accountKey,
      contactKeys: input.request.contactKeys, state: 'complete', result: { ok: true, completeness: 'complete', fileName: '合成界面验收.html（未创建真实档案）',
        messageCount: messages.length, mediaCount: 0, warnings: ['仅验证界面请求；没有读取或导出真实聊天。'] } }); },
  };
  window.salesCopilot = new Proxy(bridge, { get(target, property) {
    if (property in target) return target[property];
    return async () => { calls.unexpected.push(String(property)); throw new Error(`Unimplemented synthetic bridge call: ${String(property)}`); };
  } });
}

async function prepare() {
  const output = path.join(project, '.impeccable', 'review');
  fs.mkdirSync(output, { recursive: true });
  const runRoot = fs.mkdtempSync(path.join(output, 'ui-smoke-'));
  const result = await require('esbuild').build({ entryPoints: [path.join(project, 'src', 'renderer.tsx')],
    bundle: true, platform: 'browser', format: 'iife', outfile: path.join(runRoot, 'app.js'),
    loader: { '.svg': 'dataurl', '.png': 'dataurl', '.jpg': 'dataurl', '.woff2': 'dataurl' },
    define: { 'process.env.NODE_ENV': '"production"' }, metafile: true, logLevel: 'silent' });
  const inputs = Object.keys(result.metafile.inputs);
  if (inputs.some((input) => /(^|[\\/])src[\\/](main[\\/]|preload\.)/.test(input))) throw new Error('Production main/preload entered UI bundle');
  const version = JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8')).version;
  fs.writeFileSync(path.join(runRoot, 'fixture.js'), `(${installSyntheticBridge.toString()})(${JSON.stringify(version)});`);
  fs.writeFileSync(path.join(runRoot, 'index.html'), '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'self\' data:; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; connect-src \'none\'; object-src \'none\'; frame-src \'none\'"><title>领序客户参谋 · 合成界面验证</title><link rel="stylesheet" href="app.css"><script src="fixture.js"></script></head><body><div id="root"></div><script src="app.js"></script><div style="position:fixed;left:8px;bottom:3px;font:10px/1.2 sans-serif;color:#666;pointer-events:none;z-index:999999">合成资料 · 隔离 UI 验证</div></body></html>');
  fs.writeFileSync(path.join(runRoot, 'bundle-inputs.json'), JSON.stringify(inputs, null, 2));
  return runRoot;
}

async function electronHost() {
  const { app, BrowserWindow, session } = require('electron');
  const runRoot = fs.realpathSync(argument('--run-root'));
  const profile = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'copilot-synthetic-ui-'));
  app.setPath('userData', profile); app.setPath('sessionData', profile);
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-background-networking');
  app.commandLine.appendSwitch('force-device-scale-factor', '1');
  app.on('window-all-closed', () => {});
  await app.whenReady();
  const blockedRequests = [];
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const allowed = details.url.startsWith('file:') || details.url.startsWith('data:');
    if (!allowed) blockedRequests.push(new URL(details.url).origin);
    callback({ cancel: !allowed });
  });
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.on('will-download', (event) => event.preventDefault());
  const win = new BrowserWindow({ width: 1540, height: 960, useContentSize: true, frame: false, show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
  win.setContentSize(1540, 960);
  win.webContents.setFrameRate(60);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => { if (!url.startsWith('file:')) event.preventDefault(); });
  const proof = { ok: false, syntheticOnly: true, productionMainLoaded: false, productionPreloadLoaded: false,
    realNetworkAllowed: false, nativeClipboardUsed: false, captured: [], checks: [], blockedRequests };
  const evaluate = (code) => win.webContents.executeJavaScript(code, true);
  const check = (condition, name) => { if (!condition) throw new Error(name); proof.checks.push(name); };
  async function waitFor(code, label) {
    const end = Date.now() + 10_000;
    while (Date.now() < end) { if (await evaluate(code)) return; await new Promise((resolve) => setTimeout(resolve, 40)); }
    throw new Error(`Timed out: ${label}`);
  }
  async function click(selector, text) {
    const code = `(() => { const node = [...document.querySelectorAll(${JSON.stringify(selector)})].find(node => node.getClientRects().length && !node.closest('[hidden]') && (${text === undefined ? 'true' : `node.textContent.trim() === ${JSON.stringify(text)}`})); if (!node || node.disabled) return false; node.scrollIntoView({block:'nearest'}); node.click(); return true; })()`;
    check(await evaluate(code), `Click ${text || selector}`);
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  async function editReply(text) {
    await evaluate(`(() => { const node = document.querySelector('.reply-composer textarea'); if (!node) throw new Error('Visible reply editor missing'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(node,${JSON.stringify(text)}); node.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  }
  async function panelMetrics(design) {
    return evaluate(`(() => { const rect = (selector) => { const node = document.querySelector(selector); const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }; return {
      queue: rect('.queue-panel'), side: rect(${JSON.stringify(design === 'B' ? '.conversation-crm-panel' : '.advice-panel')}), chat: rect('.conversation-workspace'),
      stored: JSON.parse(localStorage.getItem(${JSON.stringify(`lingxu.workspace-panels.v1.${design}`)}) || 'null'),
      editor: document.querySelector('.reply-composer textarea')?.value
    }; })()`);
  }
  async function dragSeparator(label, deltaX, deltaY = 0, cancel = false) {
    const start = await evaluate(`(() => { const node = document.querySelector('[role="separator"][aria-label=${JSON.stringify(label)}]'); if (!node) throw new Error('Resize separator missing'); const r = node.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    win.webContents.sendInputEvent({ type: 'mouseMove', ...start });
    win.webContents.sendInputEvent({ type: 'mouseDown', ...start, button: 'left', clickCount: 1 });
    for (let step = 1; step <= 6; step += 1) {
      win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(start.x + deltaX * step / 6), y: Math.round(start.y + deltaY * step / 6), button: 'left', modifiers: ['leftbuttondown'], movementX: Math.round(deltaX / 6), movementY: Math.round(deltaY / 6) });
      await new Promise((resolve) => setTimeout(resolve, 16));
    }
    if (cancel) {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    }
    win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(start.x + deltaX), y: Math.round(start.y + deltaY), button: 'left', clickCount: 1 });
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  async function resizeByKey(label, keyCode, modifiers = []) {
    await evaluate(`document.querySelector('[role="separator"][aria-label=${JSON.stringify(label)}]').focus()`);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  async function checkDraftKeyboardOrder() {
    check(await evaluate(`(() => {
      const editor = document.querySelector('.reply-composer textarea');
      const actions = [...document.querySelectorAll('.reply-action-bar button')];
      return editor && actions.length === 2 && actions.every(button => Boolean(editor.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING));
    })()`), 'Single editor precedes its two visible actions in actual DOM order');
    await evaluate('document.querySelector(".reply-composer textarea").focus()');
    const visited = [];
    for (let index = 0; index < 2; index += 1) {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
      await new Promise((resolve) => setTimeout(resolve, 20));
      visited.push(await evaluate('document.activeElement.textContent.trim()'));
    }
    proof.draftKeyboardOrder = visited;
    check(visited[0] === '重新生成' && visited[1] === '复制回复', 'Real Tab navigation follows visible generate then copy actions');
    await evaluate('document.activeElement.blur()');
  }
  async function checkSimpleReply(label, expectLong = true) {
    const metrics = await evaluate(`(() => {
      const visible = node => node.getClientRects().length && !node.closest('[hidden]');
      const editors = [...document.querySelectorAll('.advice-panel textarea')].filter(visible);
      const panel = document.querySelector('.advice-content');
      const composer = document.querySelector('.reply-composer');
      const editor = editors[0];
      const rect = panel.getBoundingClientRect();
      const actions = [...document.querySelectorAll('.reply-action-bar button')];
      return { editorCount: editors.length, chars: editor?.value.length || 0, editorHeight: editor?.getBoundingClientRect().height || 0, editorScrolls: editor && editor.scrollHeight > editor.clientHeight + 2,
        outerScrolls: panel.scrollHeight > panel.clientHeight + 2 || composer.scrollHeight > composer.clientHeight + 2,
        actionCount: actions.length, actionsVisible: actions.every(node => { const r = node.getBoundingClientRect(); return r.top >= rect.top && r.bottom <= rect.bottom + 1 && r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth; }),
        actionsUncovered: actions.every(node => { const r = node.getBoundingClientRect(); return [[.2,.5],[.5,.5],[.8,.8]].every(([x,y]) => node.contains(document.elementFromPoint(r.x+r.width*x,r.y+r.height*y))); }),
        visibleDetails: [...composer.querySelectorAll('details')].filter(visible).length,
        duplicateCards: composer.querySelectorAll('.reply-card,.more-drafts').length,
        extrasVisible: /为什么这样回复|资料选项|常用话术|推荐回复|备选 1/.test(panel.innerText)
      };
    })()`);
    proof.replyChecks ||= [];
    proof.replyChecks.push({ label, ...metrics });
    check(metrics.editorCount === 1 && metrics.actionCount === 2, label + ': exactly one reply editor and two primary actions');
    check(metrics.editorHeight >= 64, label + ': editor retains at least 64 pixels of usable writing height');
    check(metrics.actionsVisible && metrics.actionsUncovered && !metrics.outerScrolls, label + ': action bar stays visible and unobstructed without scrolling the reply pane');
    check(metrics.visibleDetails === 0 && metrics.duplicateCards === 0 && !metrics.extrasVisible, label + ': daily reply view omits duplicate drafts and explanations');
    if (expectLong) check(metrics.chars > 350, label + ': complete long reply remains editable');
    if (expectLong && label.startsWith('B short')) check(metrics.editorScrolls, label + ': long reply scrolls inside the single editor');
  }
  async function capture(name) {
    await evaluate('document.fonts.ready');
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await new Promise((resolve) => setTimeout(resolve, 400));
    const metrics = await evaluate(`(() => ({ width: innerWidth, height: innerHeight, pageWidth: document.documentElement.scrollWidth,
      design: document.querySelector('.app-shell').className, activePage: document.querySelector('.nav-item[aria-current="page"]').getAttribute('aria-label'),
      consentVisible: !!document.querySelector('.consent-dialog'), replyMode: document.querySelector('.advice-tab-content')?.dataset.modelReply,
      regions: [...document.querySelectorAll('.navigation-rail,.queue-panel,.conversation-workspace,.advice-panel,.conversation-crm-panel,.consent-dialog,.fv-page')]
        .filter(node => node.getClientRects().length && !node.closest('[hidden]')).map(node => { const r = node.getBoundingClientRect(); return {className:node.className,x:r.x,y:r.y,width:r.width,height:r.height}; }) }))()`);
    if (/^[ABC]-/.test(name)) check(metrics.design.includes(`design-${name[0]}`) && metrics.activePage === '客户会话', `Expected conversation layout before capture: ${name}`);
    check(metrics.consentVisible === name.includes('-consent'), `Expected consent state before capture: ${name}`);
    if (name.includes('-generated')) check(metrics.replyMode === 'true', 'Generated screenshot contains model reply');
    const file = `${name}.png`;
    const freshFrame = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { win.webContents.removeListener('paint', onPaint); reject(new Error('No fresh offscreen frame')); }, 5000);
      const onPaint = (_event, _dirty, image) => { clearTimeout(timer); resolve(image); };
      win.webContents.once('paint', onPaint); win.webContents.invalidate();
    });
    check(freshFrame.getSize().width === metrics.width && freshFrame.getSize().height === metrics.height, `Screenshot pixels match viewport: ${name}`);
    fs.writeFileSync(path.join(runRoot, file), freshFrame.toPNG());
    proof.captured.push({ file, ...metrics });
    check(metrics.pageWidth <= metrics.width + 1, `No page horizontal overflow: ${name}`);
  }
  async function setDesign(design, dark = false) {
    await click('button[aria-label="设置"]');
    await click('.fv-tabs button', '界面布局');
    await click(`input[name="workspace-design"][aria-label^="${design} ·"]`);
    await click(`input[name="workspace-skin"][aria-label="${dark ? '曜石深灰' : '领序极简'}"]`);
    await click('button[aria-label="客户会话"]');
    await waitFor(`!!document.querySelector('.design-${design} .conversation-workspace')`, `layout ${design}`);
    await evaluate('document.querySelector(".advice-content").scrollTop = 0');
  }
  try {
    await win.loadFile(path.join(runRoot, 'index.html'));
    await waitFor('!!document.querySelector(\'[data-contact-key="synthetic-lin"]\')', 'synthetic queue');
    check(await evaluate('window.__uiSmoke.generate.length === 0 && window.__uiSmoke.preview.length === 0'), 'No model or preview call before user action');
    await click('[data-contact-key="synthetic-lin"]');
    await waitFor("!![...document.querySelectorAll('.reply-action-bar button')].find(node => !node.disabled)", 'generation ready');
    check(await evaluate('window.__uiSmoke.generate.length === 0'), 'Reading a conversation never generates AI');
    check(await evaluate('!document.querySelector(".advice-content").innerText.includes("CRM 档案") && !document.querySelector(".advice-content").innerText.includes("synthetic-review-model")'), 'Daily view omits technical context and model name');
    check(await evaluate('document.querySelector(".window-drag-region").getBoundingClientRect().height === 52 && !document.querySelector(".window-mode") && !document.querySelector(".version-label")'), 'Integrated 52px titlebar omits repeated status and version');
    await checkSimpleReply('Initial view', false);
    await click('.detail-tabs button', '参考');
    await waitFor("!!document.querySelector('.reply-context') && document.querySelector('.reply-context').textContent.includes('已关联')", 'three-source context loaded');
    check(await evaluate("['微信聊天','CRM 档案','公司知识库'].every(text => document.querySelector('.reply-context').textContent.includes(text))"), 'Three input sources remain available in references');
    check(await evaluate('!document.querySelector("#reply-knowledge") && document.querySelector(".reply-context").textContent.includes("生成前检索")'), 'Cloud knowledge cannot be disabled in the reply controls');
    await click('.reply-context-config > summary');
    check(await evaluate('document.querySelector(".reply-context-config").open'), 'Source options can be opened when needed in references');
    await click('.reply-context-config > summary');
    await click('.detail-tabs button', '回复');
    await capture('A-1540x960-local');
    await click('.reply-action-bar button', '生成回复');
    await waitFor('!!document.querySelector(".consent-dialog")', 'consent dialog');
    check(await evaluate('window.__uiSmoke.preview.length === 1 && window.__uiSmoke.generate.length === 0'), 'Preview does not generate before confirmation');
    check(await evaluate('document.querySelectorAll(".consent-sources details").length === 3'), 'Consent shows exact three source groups');
    check(await evaluate('document.querySelector(".consent-dialog .generation-context-summary").textContent.includes("本次回应")'), 'Consent shows actual context counts and response focus');
    check(await evaluate('!document.querySelector(".consent-details").open'), 'Consent starts with a concise recipient explanation');
    await click('.consent-details > summary');
    check(await evaluate('document.querySelector(".consent-details").open'), 'Exact outbound data remains available before consent');
    await click('.consent-details > summary');
    await capture('A-1540x960-consent');
    await click('.consent-dialog button', '取消');
    check(await evaluate('window.__uiSmoke.generate.length === 0'), 'Cancel keeps model generation at zero');
    await click('.reply-action-bar button', '生成回复');
    await waitFor('!!document.querySelector(".consent-dialog")', 'second consent');
    await click('.consent-dialog button', '确认生成');
    await waitFor('window.__uiSmoke.generate.length === 1 && document.querySelector(".advice-tab-content").dataset.modelReply === "true"', 'generated editable draft');
    await waitFor('!document.querySelector(".consent-dialog")', 'generation consent finishes closing');
    check(await evaluate('window.__uiSmoke.generate[0].remoteConsent === true && window.__uiSmoke.preview[1].includeKnowledge === true && window.__uiSmoke.preview[1].includeCrm === true'), 'Explicit consent and selected sources reach synthetic bridge');
    check(await evaluate('!document.querySelector(".advice-tab-content .generation-context-summary") && !document.querySelector(".advice-content").innerText.includes("引用存在不代表")'), 'Generated daily view hides source counts and repeated technical warnings');
    check(await evaluate('document.querySelectorAll(".reply-choices button").length === 2'), 'Two model versions use compact choices rather than two editors');
    check(await evaluate('document.querySelector(".reply-knowledge-evidence").textContent === "本条知识来源：公司知识库 · 合成片段"'), 'Recommendation shows its actual cited knowledge');
    await checkSimpleReply('A generated long reply');
    await checkDraftKeyboardOrder();
    const original = await evaluate('document.querySelector(".reply-composer textarea").value');
    const edited = original + '\n人工修改：你最关心哪一步，我们就先聊哪一步。';
    await editReply(edited);
    check(await evaluate('document.querySelector(".reply-knowledge-evidence").textContent.includes("原草稿知识来源（编辑后请核对）")'), 'Edited copy is not advertised as newly grounded');
    await click('.reply-choices button', '说法2');
    check(await evaluate('document.querySelector(".reply-composer textarea").value.startsWith("可以，咱们先把服务方式聊清楚")'), 'Switching version loads the alternate text in the same editor');
    check(await evaluate('document.querySelector(".reply-knowledge-evidence").textContent.includes("本条草稿未引用知识片段")'), 'Alternate draft does not inherit another draft knowledge citations');
    const alternateEdit = '另一种说法的人工修改：服务范围和费用会按正式合同确认，你最想先了解哪个环节？';
    await editReply(alternateEdit);
    await click('.reply-action-bar button', '复制回复');
    check(await evaluate('window.__uiSmoke.copies[0] === ' + JSON.stringify(alternateEdit)), 'Copy uses the selected alternate version and its edits');
    await click('.reply-choices button', '推荐');
    check(await evaluate('document.querySelector(".reply-composer textarea").value === ' + JSON.stringify(edited)), 'Recommended draft edits survive variant switching');
    await click('.reply-choices button', '说法2');
    check(await evaluate('document.querySelector(".reply-composer textarea").value === ' + JSON.stringify(alternateEdit)), 'Alternate draft retains its own edits independently');
    await click('.reply-choices button', '推荐');
    await click('.detail-tabs button', '参考');
    check(await evaluate('document.querySelector(".advice-tab-content").hidden'), 'Reference tab hides the single reply editor');
    check(await evaluate('!!document.querySelector(".generation-context-summary")'), 'Reference page retains actual model source counts');
    check(await evaluate('document.querySelector(".advice-content").innerText.includes("引用存在不代表")'), 'Reference page preserves detailed warnings');
    await click('.detail-tabs button', '回复');
    check(await evaluate('document.querySelector(".reply-composer textarea").value === ' + JSON.stringify(edited)), 'Edited draft survives switching to references and back');
    await click('.reply-action-bar button', '复制回复');
    check(await evaluate('window.__uiSmoke.copies[1] === ' + JSON.stringify(edited)), 'Copy records the edited recommendation without native clipboard');
    await capture('A-1540x960-generated');

    const layouts = {};
    const aInitial = await panelMetrics('A');
    await dragSeparator('调整会话列表宽度', 30);
    const aQueue = await panelMetrics('A');
    proof.resizeChecks = { aInitial, aQueue };
    check(Math.abs(aQueue.queue.width - aInitial.queue.width - 30) <= 2, 'Real pointer drag resizes the conversation list by its horizontal movement');
    await dragSeparator('调整回复区域宽度', -40);
    const aSide = await panelMetrics('A');
    check(Math.abs(aSide.side.width - aQueue.side.width - 40) <= 2, 'Real pointer drag expands the reply region from its left edge');
    check(aSide.editor === edited, 'Panel dragging preserves the active edited reply');
    await dragSeparator('调整会话列表宽度', 45, 0, true);
    const aCancelled = await panelMetrics('A');
    check(Math.abs(aCancelled.queue.width - aSide.queue.width) <= 1 && JSON.stringify(aCancelled.stored) === JSON.stringify(aSide.stored), 'Escape cancels a resize and preserves the previous saved dimensions');
    await resizeByKey('调整会话列表宽度', 'Right');
    const aKey = await panelMetrics('A');
    check(Math.abs(aKey.queue.width - aSide.queue.width - 10) <= 1, 'Keyboard arrow resizes the focused panel by 10 pixels');
    await resizeByKey('调整会话列表宽度', 'Left', ['shift']);
    const aShift = await panelMetrics('A');
    check(Math.abs(aShift.queue.width - aKey.queue.width + 40) <= 1, 'Shift and arrow resize the focused panel by 40 pixels');
    await resizeByKey('调整会话列表宽度', 'Home');
    const aMinimum = await panelMetrics('A');
    check(aMinimum.queue.width >= 210 && aMinimum.chat.width >= 280 && aMinimum.side.width >= 260, 'Panel minimum bounds keep the list, chat and reply usable');
    await resizeByKey('调整会话列表宽度', 'End');
    const aMaximum = await panelMetrics('A');
    check(aMaximum.chat.width >= 279 && aMaximum.side.width >= 260, 'Maximum resize preserves room for the other regions');
    await click('button[aria-label="恢复默认布局"]');
    const aReset = await panelMetrics('A');
    check(Math.abs(aReset.queue.width - aInitial.queue.width) <= 1 && Math.abs(aReset.side.width - aInitial.side.width) <= 1 && aReset.stored === null, 'Restore layout returns to defaults and clears only the current saved dimensions');
    await dragSeparator('调整会话列表宽度', 25);
    await dragSeparator('调整回复区域宽度', -30);
    layouts.A = await panelMetrics('A');
    await capture('A-1540x960-resized');

    await click('.conversation-header button', '导出此会话');
    await waitFor('!!document.querySelector(".fv-export-chat-list input:checked")', 'direct export selection');
    check(await evaluate('document.querySelectorAll(".fv-export-chat-list input:checked").length === 1 && document.querySelector(".fv-selected-chats").textContent.includes("合成客户 · 林女士")'), 'Direct export preselects the active conversation');
    const exportInitialWidth = await evaluate('document.querySelector(".fv-export-selection").getBoundingClientRect().width');
    await dragSeparator('调整导出会话列表宽度', 35);
    const exportSaved = await evaluate('({ width: document.querySelector(".fv-export-selection").getBoundingClientRect().width, stored: JSON.parse(localStorage.getItem("lingxu.export-panels.v1")) })');
    check(Math.abs(exportSaved.width - exportInitialWidth - 35) <= 2 && exportSaved.stored.list > exportInitialWidth, 'Export conversation list resizes with a real pointer drag and saves its width');
    check(await evaluate('document.querySelectorAll(".fv-export-chat-list input:checked").length === 1'), 'Resizing export columns preserves the selected conversation');
    await capture('export-1540x960');
    await click('.fv-export-options button', '选择保存位置并导出');
    await waitFor('window.__uiSmoke.exports.length === 1', 'synthetic export request');
    check(await evaluate('window.__uiSmoke.exports[0].accountKey === "synthetic-ui-account" && window.__uiSmoke.exports[0].request.contactKeys.length === 1 && window.__uiSmoke.exports[0].request.contactKeys[0] === "synthetic-lin" && window.__uiSmoke.exports[0].request.format === "html"'), 'Export submits only selected synthetic account and conversation');
    await click('button[aria-label="设置"]');
    await waitFor('!!document.querySelector(".fv-tabs")', 'settings');
    await capture('settings-1540x960');
    await click('.fv-tabs button', '回复模型');
    await capture('model-settings-1540x960');
    await click('button[aria-label="CRM 客户"]');
    await waitFor('!!document.querySelector(".wb-customer-heading") && !!document.querySelector(".wb-customer-row[aria-selected=true]")', 'synthetic CRM customer and history');
    const crmInitialWidth = await evaluate('document.querySelector(".wb-customer-list").getBoundingClientRect().width');
    await dragSeparator('调整 CRM 客户列表宽度', 30);
    const crmSaved = await evaluate('({ width: document.querySelector(".wb-customer-list").getBoundingClientRect().width, stored: JSON.parse(localStorage.getItem("lingxu.crm-panels.v1")) })');
    check(Math.abs(crmSaved.width - crmInitialWidth - 30) <= 2 && crmSaved.stored.list > crmInitialWidth, 'CRM customer list resizes with a real pointer drag and saves its width');
    check(await evaluate('document.querySelector(".wb-customer-heading").textContent.includes("合成客户 · 林女士") && document.querySelector(".wb-customer-row[aria-selected=true]").textContent.includes("合成客户 · 林女士")'), 'Resizing CRM columns preserves the active customer and readable history');
    proof.featurePanels = { export: exportSaved, crm: crmSaved };
    await capture('crm-1540x960');

    await setDesign('B', true);
    const bInitial = await panelMetrics('B');
    await dragSeparator('调整会话列表宽度', 15);
    await dragSeparator('调整客户资料宽度', -20);
    await dragSeparator('调整聊天与回复高度', 0, -45);
    layouts.B = await panelMetrics('B');
    check(Math.abs(layouts.B.queue.width - bInitial.queue.width - 15) <= 2 && Math.abs(layouts.B.side.width - bInitial.side.width - 20) <= 2, 'B layout list and customer regions resize independently');
    check(Math.abs(layouts.B.chat.height - bInitial.chat.height + 45) <= 2, 'Real vertical pointer drag changes the chat and reply heights in B');
    check(layouts.B.editor === edited, 'Changing the B layout dimensions preserves the same edited reply');
    await capture('B-1540x960');
    await setDesign('C');
    const cInitial = await panelMetrics('C');
    await dragSeparator('调整会话列表宽度', 10);
    await dragSeparator('调整回复区域宽度', -20);
    layouts.C = await panelMetrics('C');
    check(Math.abs(layouts.C.queue.width - cInitial.queue.width - 10) <= 2 && Math.abs(layouts.C.side.width - cInitial.side.width - 20) <= 2, 'C layout list and reply regions resize independently');
    check(layouts.C.editor === edited && await evaluate('!document.querySelector(".dossier-composer")'), 'C uses the same edited reply without a second composer');
    await capture('C-1540x960');
    proof.savedLayouts = layouts;

    win.setContentSize(1180, 720);
    for (const design of ['A', 'B', 'C']) {
      await setDesign(design, design === 'B');
      await checkSimpleReply(design + ' short window');
      const sizes = await panelMetrics(design);
      check(sizes.queue.width >= 210 && sizes.side.width >= 260 && sizes.chat.width >= 279, design + ': shrinking the window keeps each pane inside its usable width bounds');
      check(sizes.editor === edited, design + ': resizing the window preserves the draft edits');
      await capture(design + '-1180x720');
    }
    await setDesign('B', true);
    const generationCount = await evaluate('window.__uiSmoke.generate.length');
    await click('.reply-action-bar button', '重新生成');
    await waitFor('!!document.querySelector(".consent-dialog")', 'short-window consent dialog');
    check(await evaluate('(() => { const controls = [...document.querySelectorAll(".consent-dialog button")].filter(node => node.getClientRects().length); return controls.length === 2 && controls.every(node => { const r = node.getBoundingClientRect(); return !node.disabled && r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth; }); })()'), 'B short window exposes both consent actions within the viewport');
    await click('.consent-dialog button', '取消');
    await waitFor('!document.querySelector(".consent-dialog")', 'short-window consent dismissed');
    check(await evaluate('window.__uiSmoke.generate.length === ' + generationCount), 'Short-window consent can be cancelled without generation');
    check(await evaluate('document.querySelector(".reply-composer textarea").value === ' + JSON.stringify(edited)), 'Cancelling regeneration keeps the edited reply');
    await evaluate('window.__uiSmoke.waiting = true');
    await click('.conversation-header button[aria-label="刷新当前会话"]');
    await waitFor('document.querySelector(".message-items").textContent.includes("你看周末哪天方便？") && !document.querySelector(".reply-action-bar button").disabled', 'manual generation remains available while waiting');
    check(await evaluate('!document.querySelector(".advice-content").innerText.includes("暂不生成")'), 'Waiting strategy does not block manual drafting');
    check(await evaluate('document.querySelector(".reply-composer textarea").value === ' + JSON.stringify(edited)), 'A real message refresh preserves both the editor and its manual edits');
    check(await evaluate('document.querySelector(".advice-tab-content").dataset.modelReply === "false" && !!document.querySelector(".reply-update-note")'), 'Retained draft is marked stale and not advertised as current model evidence');
    await checkSimpleReply('Waiting state', false);
    await capture('B-1180x720-waiting');
    const previewCount = await evaluate('window.__uiSmoke.preview.length');
    await click('.reply-action-bar button', '重新生成');
    await waitFor('!!document.querySelector(".consent-dialog")', 'waiting-state consent');
    check(await evaluate('window.__uiSmoke.preview.length === ' + (previewCount + 1) + ' && window.__uiSmoke.generate.length === ' + generationCount), 'Waiting-state click prepares without remote generation');
    await evaluate('window.__uiSmoke.holdGeneration = true');
    await click('.consent-dialog button', '确认生成');
    await waitFor('!!window.__releaseSyntheticGeneration && !document.querySelector(".consent-dialog")', 'controlled synthetic model request is pending');
    check(await evaluate('document.querySelector(".reply-composer textarea").readOnly && document.querySelector(".reply-composer textarea").getAttribute("aria-busy") === "true" && document.querySelector(".reply-action-bar button").textContent === "停止生成" && !document.querySelector(".reply-action-bar button").disabled'), 'A pending generation keeps the editor readable and provides a working stop action');
    const busyText = await evaluate('document.querySelector(".reply-composer textarea").value');
    await evaluate('document.querySelector(".reply-composer textarea").focus()');
    win.webContents.sendInputEvent({ type: 'char', keyCode: 'X' });
    check(await evaluate('document.querySelector(".reply-composer textarea").value === ' + JSON.stringify(busyText)), 'Real keyboard input cannot modify a pending-generation editor');
    await evaluate('window.__releaseSyntheticGeneration()');
    await waitFor('window.__uiSmoke.generate.length === ' + (generationCount + 1) + ' && document.querySelector(".advice-tab-content").dataset.modelReply === "true"', 'manual waiting-state reply');
    check(await evaluate('!document.querySelector(".reply-composer textarea").readOnly && document.querySelector(".reply-composer textarea").getAttribute("aria-busy") === "false"'), 'Completed generation returns the editor to normal editing');
    const cancelledEdit = '合成手工草稿：停止后继续写，迟到的结果不能覆盖。';
    await evaluate('delete window.__releaseSyntheticGeneration');
    await click('.reply-action-bar button', '重新生成');
    await waitFor('!!document.querySelector(".consent-dialog")', 'cancellable reply consent');
    await click('.consent-dialog button', '确认生成');
    await waitFor('!!window.__releaseSyntheticGeneration', 'held cancellable request');
    const activePreviewId = await evaluate('window.__uiSmoke.generate.at(-1).previewId');
    await click('.reply-action-bar button', '停止生成');
    await editReply(cancelledEdit);
    check(await evaluate('window.__uiSmoke.cancelled.some(item => item.previewId === ' + JSON.stringify(activePreviewId) + ')'), 'Stop addresses the exact account, conversation and preview at the bridge');
    await evaluate('window.__releaseSyntheticGeneration()');
    await new Promise((resolve) => setTimeout(resolve, 80));
    check(await evaluate('document.querySelector(".reply-composer textarea").value === ' + JSON.stringify(cancelledEdit)), 'A cancelled late success cannot overwrite text edited after stopping');
    await capture('B-1180x720-cancelled');

    await evaluate('delete window.__releaseSyntheticGeneration');
    await click('.reply-action-bar button', '重新生成');
    await waitFor('!!document.querySelector(".consent-dialog")', 'switch-contact consent');
    await click('.consent-dialog button', '确认生成');
    await waitFor('!!window.__releaseSyntheticGeneration', 'held request before changing contact');
    const switchingPreviewId = await evaluate('window.__uiSmoke.generate.at(-1).previewId');
    await click('[data-contact-key="synthetic-zhou"]');
    await waitFor('!!document.querySelector(".reply-composer textarea") && !document.querySelector(".reply-composer textarea").readOnly', 'second customer editor');
    await evaluate('window.__releaseSyntheticGeneration()');
    await new Promise((resolve) => setTimeout(resolve, 80));
    check(await evaluate('window.__uiSmoke.cancelled.some(item => item.previewId === ' + JSON.stringify(switchingPreviewId) + ') && document.querySelector(".reply-composer textarea").value === ""'), 'Changing customer cancels the previous task and never inserts its late reply into another conversation');
    const beforeDoubleClick = await evaluate('window.__uiSmoke.preview.length');
    await evaluate('(() => { const button = document.querySelector(".reply-action-bar button"); button.click(); button.click(); })()');
    await waitFor('!!document.querySelector(".consent-dialog")', 'rapid-click consent');
    check(await evaluate('window.__uiSmoke.preview.length === ' + (beforeDoubleClick + 1)), 'Rapid repeat clicks prepare only one request');
    await click('.consent-dialog button', '取消');
    proof.calls = await evaluate('window.__uiSmoke');
    check(proof.calls.unexpected.length === 0 && proof.calls.errors.length === 0, 'No unsupported bridge calls or renderer errors before reload');

    win.setContentSize(1540, 960);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await new Promise((resolve) => { win.webContents.once('did-finish-load', resolve); win.webContents.reload(); });
    await waitFor('!!document.querySelector(\'[data-contact-key="synthetic-lin"]\')', 'queue after renderer reload');
    check(await evaluate('window.__uiSmoke.generate.length === 0 && window.__uiSmoke.preview.length === 0'), 'Reloading never starts model generation');
    await click('[data-contact-key="synthetic-lin"]');
    await waitFor('!!document.querySelector(".reply-composer textarea")', 'reply after reload');
    for (const design of ['A', 'B', 'C']) {
      await setDesign(design, design === 'B');
      const reloaded = await panelMetrics(design);
      check(JSON.stringify(reloaded.stored) === JSON.stringify(layouts[design].stored), design + ': saved sizes persist through a real renderer reload');
      check(Math.abs(reloaded.queue.width - layouts[design].queue.width) <= 2 && Math.abs(reloaded.side.width - layouts[design].side.width) <= 2 && (design !== 'B' || Math.abs(reloaded.chat.height - layouts[design].chat.height) <= 2), design + ': restored panel geometry matches its own layout preference');
    }
    await click('button[aria-label="恢复默认布局"]');
    check(await evaluate('localStorage.getItem("lingxu.workspace-panels.v1.C") === null && localStorage.getItem("lingxu.workspace-panels.v1.A") !== null && localStorage.getItem("lingxu.workspace-panels.v1.B") !== null'), 'Resetting C preserves independently saved A and B layouts');
    await click('button[aria-label="CRM 客户"]');
    await waitFor('!!document.querySelector(".wb-customer-heading")', 'CRM after reload');
    const crmReloaded = await evaluate('({ width: document.querySelector(".wb-customer-list").getBoundingClientRect().width, stored: JSON.parse(localStorage.getItem("lingxu.crm-panels.v1")) })');
    check(Math.abs(crmReloaded.width - crmSaved.width) <= 2 && JSON.stringify(crmReloaded.stored) === JSON.stringify(crmSaved.stored), 'CRM column width persists through the actual renderer reload');
    await click('button[aria-label="聊天导出"]');
    await waitFor('!!document.querySelector(".fv-export-selection")', 'export after reload');
    const exportReloaded = await evaluate('({ width: document.querySelector(".fv-export-selection").getBoundingClientRect().width, stored: JSON.parse(localStorage.getItem("lingxu.export-panels.v1")) })');
    check(Math.abs(exportReloaded.width - exportSaved.width) <= 2 && JSON.stringify(exportReloaded.stored) === JSON.stringify(exportSaved.stored), 'Export column width persists through the actual renderer reload');
    proof.reloadCalls = await evaluate('window.__uiSmoke');
    check(proof.reloadCalls.unexpected.length === 0 && proof.reloadCalls.errors.length === 0, 'No unsupported bridge calls or renderer errors after reload');
    check(blockedRequests.length === 0, 'No attempted external network requests');
    check(!win.isVisible(), 'All screenshots captured with hidden window');
    proof.ok = true;
  } catch (error) {
    proof.error = error.message;
    proof.calls = await evaluate('window.__uiSmoke || null').catch(() => null);
    fs.writeFileSync(path.join(runRoot, 'failure.png'), (await win.webContents.capturePage(undefined, { stayHidden: true })).toPNG());
  } finally {
    fs.writeFileSync(path.join(runRoot, 'proof.json'), JSON.stringify(proof, null, 2));
    process.stdout.write(`${JSON.stringify({ ok: proof.ok, runRoot, error: proof.error, checks: proof.checks.length, captures: proof.captured.length })}\n`);
    win.destroy(); app.exit(proof.ok ? 0 : 1);
  }
}

async function launch() {
  const runRoot = await prepare();
  if (!process.argv.includes('--run')) { process.stdout.write(`${JSON.stringify({ prepared: true, runRoot, rendererOnly: true, command: 'node scripts/ui-redesign-smoke.cjs --run' })}\n`); return; }
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawn(path.join(project, 'node_modules', 'electron', 'dist', 'electron.exe'),
    [__filename, '--run-root', runRoot], { cwd: project, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const timer = setTimeout(() => child.kill(), 90_000);
  child.stdout.on('data', (chunk) => process.stdout.write(chunk)); child.stderr.resume();
  child.once('error', (error) => { clearTimeout(timer); process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
  child.once('exit', (code) => { clearTimeout(timer); process.exitCode = code === 0 ? 0 : 1; });
}

if (process.versions.electron && process.type === 'browser') {
  electronHost().catch((error) => { process.stderr.write(`${error.message}\n`); require('electron').app.exit(1); });
} else {
  launch().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
