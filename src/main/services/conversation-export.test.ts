import { mkdtemp, readFile, readdir, rm, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConversationExportRequest, ExportMessage } from '../../shared/export-contracts';
import {
  CONVERSATION_EXPORT_LIMITS,
  ConversationExportCancelledError,
  exportConversationArchive,
  normalizeCrmExportContext,
  validateConversationExportRequest,
  type ExportArchiveInput,
} from './conversation-export';
import { importConversationFile } from './conversation-import';

const temporaryDirectories: string[] = [];
const fixtureImage = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZcMsAAAAASUVORK5CYII=', 'base64');
const message = (id = 'one', changes: Partial<ExportMessage> = {}): ExportMessage => ({
  id, direction: 'incoming', sender: '客户', text: '周六可以来公司聊聊',
  sentAt: '2026-08-31T02:00:00.000Z', messageType: 'text', ...changes,
});
const baseRequest = (changes: Partial<ConversationExportRequest> = {}): ConversationExportRequest => ({
  contactKeys: ['opaque-contact'], format: 'html', ...changes,
});
const fixtureInput = async (changes: Partial<ExportArchiveInput> = {}): Promise<ExportArchiveInput> => {
  const directory = await mkdtemp(path.join(tmpdir(), 'lingxu-export-test-'));
  temporaryDirectories.push(directory);
  return {
    directory, accountKey: 'opaque-account', request: baseRequest(),
    conversations: [{ contactKey: 'opaque-contact', title: '客户聊天', messages: [message()], completeness: 'complete' }],
    ...changes,
  };
};
const readJson = async (filePath: string): Promise<Record<string, unknown>> => JSON.parse(await readFile(filePath, 'utf8'));
const readArchivedMessages = async (directory: string): Promise<Array<Record<string, unknown>>> => {
  const archive = await readJson(path.join(directory, 'archive.json'));
  return archive.messages as Array<Record<string, unknown>>;
};

afterEach(async () => {
  vi.useRealTimers();
  for (const directory of temporaryDirectories.splice(0)) {
    const relative = path.relative(tmpdir(), directory);
    if (!relative.startsWith('lingxu-export-test-') || relative.includes(path.sep)) throw new Error('Unsafe test cleanup');
    await rm(directory, { recursive: true, force: true });
  }
});

describe('export completeness regressions', () => {
  it('retries a transient attachment failure without losing the attachment', async () => {
    const resolveMedia = vi.fn().mockResolvedValueOnce({ ok: false, reason: 'unavailable' })
      .mockResolvedValueOnce({ ok: true, bytes: fixtureImage, mime: 'image/png' });
    const input = await fixtureInput({ request: baseRequest({ media: 'available' }), resolveMedia });
    input.conversations[0].messages = [message('image', { messageType: 'image', mediaKey: 'image-key' })];
    const result = await exportConversationArchive(input);
    expect(resolveMedia).toHaveBeenCalledTimes(2);
    expect(result.completeness).toBe('complete');
    expect(result.mediaCount).toBe(1);
    expect((await readJson(result.manifestPath)).missingResources).toEqual([]);
  });

  it('marks missing attachments and unverified history partial, not complete', async () => {
    const input = await fixtureInput({ request: baseRequest({ media: 'available' }) });
    input.conversations[0].messages = [message('image', { messageType: 'image' })];
    const result = await exportConversationArchive(input);
    expect(result.completeness).toBe('partial');
    expect((await readJson(result.manifestPath)).status).toBe('partial');
    const unknown = await fixtureInput();
    unknown.conversations[0].completeness = 'unknown';
    expect((await exportConversationArchive(unknown)).completeness).toBe('partial');
  });

  it('exports all pages beyond the live conversation snapshot', async () => {
    const input = await fixtureInput();
    input.conversations[0].messages = (async function* () {
      for (let page = 0; page < 8; page++) yield Array.from({ length: 200 }, (_, row) => message(`${page}-${row}`));
    })();
    const result = await exportConversationArchive(input);
    expect(result.messageCount).toBe(1600);
    expect(await readArchivedMessages(result.directory)).toHaveLength(1600);
  });
});

describe('export request boundary', () => {
  it.each([
    null, {}, baseRequest({ contactKeys: [] }), baseRequest({ contactKeys: ['a', 'a'] }),
    baseRequest({ contactKeys: ['1', '2', '3', '4', '5', '6'] }),
    { ...baseRequest(), format: 'pdf' }, { ...baseRequest(), includeCrm: 'yes' },
    baseRequest({ format: 'csv', contactKeys: ['a', 'b'] }),
    baseRequest({ format: 'json', zip: true }), baseRequest({ format: 'txt', includeAvatars: true }),
    baseRequest({ format: 'markdown', media: 'available' }),
    baseRequest({ messageTypes: [] }), { ...baseRequest(), messageTypes: ['secret'] },
    baseRequest({ from: '2026-02-30' }), baseRequest({ from: '2026-02-30T00:00:00Z' }),
    baseRequest({ from: '2026-08-31T10:00' }), baseRequest({ from: '2026-09-01', to: '2026-08-31' }),
  ])('rejects unsupported or ambiguous options %#', (request) => {
    expect(() => validateConversationExportRequest(request)).toThrow();
  });

  it('drops unexpected renderer paths and credentials', () => {
    const request = validateConversationExportRequest({ ...baseRequest(), directory: 'C:\\private', apiKey: 'SECRET', accountKey: 'RAW' });
    expect(request).not.toHaveProperty('directory');
    expect(request).not.toHaveProperty('apiKey');
    expect(request).not.toHaveProperty('accountKey');
  });

  it('rejects source/request and merge intent mismatches before any output', async () => {
    const input = await fixtureInput({ request: baseRequest({ contactKeys: ['other'] }) });
    await expect(exportConversationArchive(input)).rejects.toThrow('会话来源');
    expect(await readdir(input.directory)).toEqual([]);
    input.request = baseRequest({ mergePrevious: true });
    await expect(exportConversationArchive(input)).rejects.toThrow('明确选择');
  });
});

describe('CRM dossier normalization', () => {
  const crmRaw = () => ({
    customer: { id: 23, name: '王客户', phone: '13800000000', budget: '200万', area: '西湖区', location: '现住拱墅区', dealAmount: '服务费测试值', dealPoints: '测试点数', firstContact: '首次电话明确了家庭需求',
      idCard: 'PRIVATE-ID', token: 'PRIVATE-TOKEN', deviceSecret: 'PRIVATE-DEVICE', localPath: 'C:\\private\\database' },
    followups: Array.from({ length: 30 }, (_, index) => ({ id: index, followupAt: `2026-08-${String(index + 1).padStart(2, '0')} 10:00:00`, method: '电话', result: '已联系', content: `跟进 ${index}`, password: 'secret' })),
    calls: Array.from({ length: 7 }, (_, index) => ({ id: index, calledAt: '2026-08-31 09:00:00', userName: '销售', durationSec: 30, direction: 'out', connected: 1, transcript: `通话文字 ${index}`, audioPath: 'D:\\private\\call.mp3', fileName: 'private-call.mp3' })),
    fetchedAt: '2026-08-31T03:00:00Z', sourceBaseUrl: 'https://crm.example/?token=SECRET',
    availability: { followups: 'available', calls: 'available' },
  });

  it('retains all authorized followups/calls, maps actual CRM fields and excludes credentials and paths', () => {
    const crm = normalizeCrmExportContext(crmRaw());
    expect(crm.customerId).toBe('23');
    expect(crm.profile).toContainEqual({ label: '首次沟通', value: '首次电话明确了家庭需求' });
    expect(crm.profile).toContainEqual({ label: '购房区域', value: '西湖区' });
    expect(crm.profile).toContainEqual({ label: '客户位置', value: '现住拱墅区' });
    expect(crm.profile).toContainEqual({ label: '付费金额', value: '服务费测试值' });
    expect(crm.profile).toContainEqual({ label: '签约点数', value: '测试点数' });
    expect(crm.followups).toHaveLength(30);
    expect(crm.calls).toHaveLength(7);
    expect(crm.calls[0]).toMatchObject({ author: '销售', direction: '呼出', durationSeconds: 30, result: '已接通', transcript: '通话文字 0' });
    expect(crm.completeness).toBe('complete');
    const serialized = JSON.stringify(crm);
    for (const secret of ['PRIVATE-ID', 'PRIVATE-TOKEN', 'PRIVATE-DEVICE', 'private-call.mp3', 'C:\\private', 'D:\\private', 'crm.example', 'password']) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('accepts the old nested customer envelope without treating it as missing data', () => {
    const input = crmRaw();
    expect(normalizeCrmExportContext({ ...input, customer: { customer: input.customer, tasks: [] } }).customerName).toBe('王客户');
  });

  it('marks denied or unverified CRM feeds as partial', () => {
    const input = crmRaw();
    const crm = normalizeCrmExportContext({ ...input, calls: [], availability: { followups: 'available', calls: 'forbidden' } });
    expect(crm.completeness).toBe('partial');
    expect(crm.notices?.join('')).toContain('无权读取');
    expect(normalizeCrmExportContext({ ...input, availability: undefined }).completeness).toBe('partial');
  });

  it('includes profile and chronological followups/calls in each text-oriented format', async () => {
    for (const format of ['markdown', 'txt', 'csv', 'json'] as const) {
      const input = await fixtureInput({ request: baseRequest({ format, includeCrm: true }) });
      input.conversations[0].crm = normalizeCrmExportContext(crmRaw());
      const result = await exportConversationArchive(input);
      const body = await readFile(result.entryPath, 'utf8');
      expect(body).toContain('王客户');
      expect(body).toContain('首次电话明确了家庭需求');
      expect(body).toContain('跟进 29');
      expect(body).toContain('通话文字 6');
      expect(body).not.toContain('PRIVATE-TOKEN');
    }
  });
});

describe('chat export formats and filtering', () => {
  it('streams all pages, deduplicates message IDs and keeps int64 order', async () => {
    let pagesRead = 0;
    const input = await fixtureInput();
    input.conversations[0].messages = (async function* () {
      pagesRead += 1;
      yield [message('late', { sortSequence: '9223372036854775807' })];
      pagesRead += 1;
      yield [message('early', { sortSequence: '9223372036854775806' }), message('late', { sortSequence: '9223372036854775807' })];
    })();
    const result = await exportConversationArchive(input);
    expect(pagesRead).toBe(2);
    expect(result.messageCount).toBe(2);
    expect((await readArchivedMessages(result.directory)).map((row) => row.sortSequence)).toEqual(['9223372036854775806', '9223372036854775807']);
  });

  it('treats both endpoints as inclusive Beijing calendar dates, not machine-local or UTC dates', async () => {
    const input = await fixtureInput({ request: baseRequest({ from: '2026-08-31', to: '2026-08-31' }) });
    input.conversations[0].messages = [
      message('before', { text: 'before', sentAt: '2026-08-30T15:59:59.999Z' }),
      message('start', { text: 'start', sentAt: '2026-08-30T16:00:00.000Z' }),
      message('local', { text: 'local', sentAt: '2026-08-31 01:00:00' }),
      message('end', { text: 'end', sentAt: '2026-08-31T15:59:59.999Z' }),
      message('after', { text: 'after', sentAt: '2026-08-31T16:00:00.000Z' }),
      message('invalid', { text: 'unknown', sentAt: 'unknown' }),
    ];
    const result = await exportConversationArchive(input);
    expect((await readArchivedMessages(result.directory)).map((row) => row.text)).toEqual(['start', 'local', 'end']);
    expect(result.warnings.join('')).toContain('1条消息的时间无法识别');
  });

  it('preserves unknown timestamp text without inventing a date and sorts it after valid messages', async () => {
    const input = await fixtureInput();
    input.conversations[0].messages = [message('late', { text: 'late', sentAt: '2026-08-31T03:00:00Z' }), message('bad', { text: 'bad', sentAt: 'unknown' }), message('early', { text: 'early' })];
    const result = await exportConversationArchive(input);
    expect((await readArchivedMessages(result.directory)).map((row) => row.text)).toEqual(['early', 'late', 'bad']);
    expect(result.warnings.join('')).toContain('保留原时间文本');
  });

  it('filters sticker messages using actual media kind', async () => {
    const input = await fixtureInput({ request: baseRequest({ messageTypes: ['sticker'] }) });
    input.conversations[0].messages = [message(), message('sticker', { messageType: 'image', mediaKind: 'sticker', text: '[表情]' })];
    const result = await exportConversationArchive(input);
    expect(result.messageCount).toBe(1);
    expect((await readArchivedMessages(result.directory))[0].messageType).toBe('sticker');
  });

  it('exports up to five selected conversations to one HTML file', async () => {
    const input = await fixtureInput({ request: baseRequest({ contactKeys: ['1', '2', '3', '4', '5'] }) });
    input.conversations = input.request.contactKeys.map((contactKey) => ({ contactKey, title: `客户${contactKey}`, completeness: 'complete', messages: [message()] }));
    const result = await exportConversationArchive(input);
    expect(result.messageCount).toBe(5);
    const html = await readFile(result.entryPath, 'utf8');
    expect(html).toContain('id="conversation-4"');
    expect(html).toContain('客户5');
  });

  it('keeps single-conversation JSON compatible with the existing import text schema', async () => {
    const input = await fixtureInput({ request: baseRequest({ format: 'json' }) });
    input.conversations[0].messages = [message(), message('me', { direction: 'outgoing', sender: '我', text: '好，周六上午十点您方便吗' })];
    const result = await exportConversationArchive(input);
    const imported = await importConversationFile(result.entryPath);
    expect(imported.messages.map((row) => row.direction)).toEqual(['incoming', 'outgoing']);
    expect(imported.messages[1].text).toBe('好，周六上午十点您方便吗');
    const raw = await readFile(result.entryPath, 'utf8');
    expect(raw).not.toContain('opaque-account');
    expect(raw).not.toContain('opaque-contact');
  });

  it('discloses partial chat history and a failed bound CRM supplement without requiring CRM', async () => {
    const input = await fixtureInput({ request: baseRequest({ includeCrm: true }) });
    input.conversations[0].completeness = 'partial';
    input.conversations[0].crmNotice = '已关联 CRM，但本次补充资料不可用。';
    const result = await exportConversationArchive(input);
    expect(result.warnings.join('')).toContain('历史完整性未确认');
    expect(result.warnings.join('')).toContain('本次补充资料不可用');
    const manifest = await readJson(result.manifestPath);
    expect(manifest.conversations).toEqual([expect.objectContaining({ completeness: 'partial', crmIncluded: false })]);
  });

  it('does not warn about CRM when a chat has no optional CRM binding', async () => {
    const input = await fixtureInput({ request: baseRequest({ includeCrm: true }) });
    const result = await exportConversationArchive(input);
    expect(result.warnings.join('')).not.toContain('CRM');
  });

  it('escapes HTML/Markdown content and uses a no-script, no-network export CSP', async () => {
    const input = await fixtureInput();
    input.conversations[0].title = '<script>alert(1)</script>';
    input.conversations[0].messages = [message('xss', { sender: '" onerror="bad', text: '<img src="https://evil.test/x" onerror="evil()">\n<script>alert(1)</script>' })];
    const result = await exportConversationArchive(input);
    const html = await readFile(result.entryPath, 'utf8');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src="https://');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain("default-src 'none'");
    input.request = baseRequest({ format: 'markdown' });
    const markdown = await readFile((await exportConversationArchive(input)).entryPath, 'utf8');
    expect(markdown).not.toContain('<script>');
  });

  it.each(['=HYPERLINK("https://evil")', '+cmd', '-2+3', '@SUM(1)', '\t=1+2', '\n =1+2'])('neutralizes CSV formula content %s', async (text) => {
    const input = await fixtureInput({ request: baseRequest({ format: 'csv' }) });
    input.conversations[0].messages = [message('formula', { text })];
    const result = await exportConversationArchive(input);
    const csv = await readFile(result.entryPath, 'utf8');
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain(`"'${text.replace(/"/gu, '""')}"`);
  });

  it('creates a unique safe subdirectory without overwriting an existing export', async () => {
    const input = await fixtureInput({ request: baseRequest({ title: '..\\..\\CON:/bad*name?' }) });
    const first = await exportConversationArchive(input);
    const before = await readFile(first.entryPath);
    const second = await exportConversationArchive(input);
    expect(first.directory).not.toBe(second.directory);
    expect(path.dirname(first.directory)).toBe(await import('node:fs/promises').then((fs) => fs.realpath(input.directory)));
    expect(await readFile(first.entryPath)).toEqual(before);
    expect(path.basename(first.directory)).not.toMatch(/[<>:"/\\|?*]/u);
  });
});

describe('offline media, avatars and transcripts', () => {
  it('exports both incoming/outgoing avatars and deduplicates identical media bytes', async () => {
    const resolver = vi.fn(async () => ({ ok: true as const, bytes: fixtureImage, mime: 'image/png' }));
    const input = await fixtureInput({ request: baseRequest({ includeAvatars: true, media: 'available' }), resolveMedia: resolver });
    input.conversations[0].messages = [
      message('image', { messageType: 'image', mediaKey: 'photo', avatarMediaKey: 'customer-avatar', text: '[图片]' }),
      message('me', { direction: 'outgoing', sender: '我', avatarMediaKey: 'self-avatar' }),
      message('same-photo', { messageType: 'image', mediaKey: 'photo', avatarMediaKey: 'customer-avatar' }),
    ];
    const result = await exportConversationArchive(input);
    expect(resolver).toHaveBeenCalledTimes(3);
    expect(result.mediaCount).toBe(1);
    const messages = await readArchivedMessages(result.directory);
    expect(messages.every((row) => typeof row.avatarFile === 'string')).toBe(true);
    const html = await readFile(result.entryPath, 'utf8');
    expect(html).toContain('客户的头像');
    expect(html).toContain('我的头像');
    expect(html).toContain('class="outgoing"');
    expect(html).not.toContain('customer-avatar');
  });

  it('resolves resources sequentially and does not read keys when media options are off', async () => {
    let active = 0;
    let peak = 0;
    const resolver = vi.fn(async () => {
      active += 1; peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
      return { ok: true as const, bytes: fixtureImage, mime: 'image/png' };
    });
    const input = await fixtureInput({ request: baseRequest({ media: 'available' }), resolveMedia: resolver });
    input.conversations[0].messages = Array.from({ length: 10 }, (_, index) => message(String(index), { messageType: 'image', mediaKey: `m-${index}` }));
    await exportConversationArchive(input);
    expect(peak).toBe(1);
    expect(resolver).toHaveBeenCalledTimes(10);
    resolver.mockClear();
    input.request = baseRequest();
    await exportConversationArchive(input);
    expect(resolver).not.toHaveBeenCalled();
  });

  it('keeps media failures visible in the manifest and optionally hides the HTML placeholder only', async () => {
    const input = await fixtureInput({ request: baseRequest({ media: 'available', missingMedia: 'omit' }), resolveMedia: async () => ({ ok: false, reason: 'encrypted' }) });
    input.conversations[0].messages = [message('missing', { messageType: 'image', mediaKey: 'opaque-unavailable', text: '[图片]' })];
    const result = await exportConversationArchive(input);
    expect(result.mediaCount).toBe(0);
    const manifest = await readJson(result.manifestPath);
    expect(manifest.missingResources).toEqual([expect.objectContaining({ kind: 'media', reason: 'unavailable' })]);
    expect(await readFile(result.entryPath, 'utf8')).not.toContain('此媒体未能读取');
    expect(await readFile(result.manifestPath, 'utf8')).not.toContain('opaque-unavailable');
  });

  it('lists unsupported native attachments in the missing manifest instead of silently exporting them as other text', async () => {
    const input = await fixtureInput({ request: baseRequest({ media: 'available' }) });
    input.conversations[0].messages = [
      message('video', { messageType: 'video', attachmentKind: 'video', text: '[视频]' }),
      message('file', { messageType: 'file', attachmentKind: 'file', text: '[文件]' }),
      message('app', { messageType: 'other', attachmentKind: 'unknown', text: '[附件或卡片消息]' }),
    ];

    const result = await exportConversationArchive(input);
    const manifest = await readJson(result.manifestPath);
    const archived = await readArchivedMessages(result.directory);
    expect(manifest.missingResources).toEqual([
      expect.objectContaining({ kind: 'media', reason: 'unsupported' }),
      expect.objectContaining({ kind: 'media', reason: 'unsupported' }),
      expect.objectContaining({ kind: 'media', reason: 'unsupported' }),
    ]);
    expect(archived.map((row) => row.attachmentKind)).toEqual(['video', 'file', 'unknown']);
    expect(result.warnings.join('\n')).toContain('未完成');
  });

  it('rejects scriptable SVG and mismatched MIME while preserving the original message', async () => {
    const input = await fixtureInput({ request: baseRequest({ media: 'available' }), resolveMedia: async () => ({ ok: true, bytes: Buffer.from('<svg onload="alert(1)"></svg>'), mime: 'image/svg+xml' }) });
    input.conversations[0].messages = [message('svg', { messageType: 'image', mediaKey: 'svg' })];
    const result = await exportConversationArchive(input);
    expect(result.messageCount).toBe(1);
    expect(result.mediaCount).toBe(0);
    expect((await readJson(result.manifestPath)).missingResources).toEqual([expect.objectContaining({ reason: 'unsupported' })]);
  });

  it('bounds individual media allocation from an oversized resolver response', async () => {
    const bytes = new Uint8Array(CONVERSATION_EXPORT_LIMITS.mediaFileBytes + 1);
    const input = await fixtureInput({ request: baseRequest({ media: 'available' }), resolveMedia: async () => ({ ok: true, bytes, mime: 'image/png' }) });
    input.conversations[0].messages = [message('large', { messageType: 'image', mediaKey: 'large' })];
    const result = await exportConversationArchive(input);
    expect(result.mediaCount).toBe(0);
    expect((await readJson(result.manifestPath)).missingResources).toEqual([expect.objectContaining({ reason: 'limit' })]);
  });

  it('uses passed local voice transcriber only when requested and records engine and review caution', async () => {
    const transcriber = vi.fn(async () => ({ ok: true as const, text: '周六上午十点', engine: 'SenseVoice' }));
    const input = await fixtureInput({ request: baseRequest({ includeVoiceTranscripts: true }), resolveTranscript: transcriber });
    input.conversations[0].messages = [message('voice', { messageType: 'voice', text: '[语音]' }), message('cached', { messageType: 'voice', text: '[语音]', voiceTranscript: '已有转写', voiceTranscriptEngine: 'SenseVoice' })];
    const result = await exportConversationArchive(input);
    expect(transcriber).toHaveBeenCalledTimes(1);
    expect(await readFile(result.entryPath, 'utf8')).toContain('周六上午十点');
    expect(await readFile(result.entryPath, 'utf8')).toContain('请对照语音核实');
    transcriber.mockClear();
    input.request = baseRequest();
    await exportConversationArchive(input);
    expect(transcriber).not.toHaveBeenCalled();
  });

  it('does not convert failed or empty voice recognition into invented text', async () => {
    const input = await fixtureInput({ request: baseRequest({ includeVoiceTranscripts: true }), resolveTranscript: async () => ({ ok: false, reason: 'missing-model' }) });
    input.conversations[0].messages = [message('voice', { messageType: 'voice', text: '[语音]' })];
    const result = await exportConversationArchive(input);
    expect((await readArchivedMessages(result.directory))[0].voiceTranscript).toBeUndefined();
    expect((await readJson(result.manifestPath)).missingResources).toEqual([expect.objectContaining({ kind: 'transcript', reason: 'not-transcribed' })]);
  });
});

describe('ZIP and incremental archives', () => {
  it('creates an offline ZIP containing HTML, canonical JSON, manifest and real media bytes', async () => {
    const input = await fixtureInput({ request: baseRequest({ zip: true, media: 'available' }), resolveMedia: async () => ({ ok: true, bytes: fixtureImage, mime: 'image/png' }) });
    input.conversations[0].messages = [message('img', { messageType: 'image', mediaKey: 'img' })];
    const result = await exportConversationArchive(input);
    expect(result.zipPath).toBeDefined();
    const files = unzipSync(await readFile(result.zipPath as string));
    expect(files).toHaveProperty('conversation.html');
    expect(files).toHaveProperty('archive.json');
    expect(files).toHaveProperty('manifest.json');
    const asset = Object.keys(files).find((name) => name.startsWith('assets/'));
    expect(asset).toBeDefined();
    expect(Buffer.from(files[asset as string])).toEqual(fixtureImage);
    expect(Object.keys(files).some((name) => name.startsWith('/') || name.includes('..'))).toBe(false);
  });

  it('merges unique messages and copies retained assets into a new folder without changing the old archive', async () => {
    const input = await fixtureInput({ request: baseRequest({ media: 'available' }), resolveMedia: async () => ({ ok: true, bytes: fixtureImage, mime: 'image/png' }) });
    input.conversations[0].messages = [message('original', { text: '原始记录', messageType: 'image', mediaKey: 'image' })];
    const first = await exportConversationArchive(input);
    const originalArchive = await readFile(path.join(first.directory, 'archive.json'));
    input.request = baseRequest({ mergePrevious: true });
    input.previousArchiveDirectory = first.directory;
    input.conversations[0].messages = [message('original', { text: '不要改写旧内容' }), message('new', { text: '新增内容' })];
    const merged = await exportConversationArchive(input);
    expect(merged.directory).not.toBe(first.directory);
    expect(merged.messageCount).toBe(2);
    expect(merged.mediaCount).toBe(1);
    const messages = await readArchivedMessages(merged.directory);
    expect(messages.map((row) => row.text)).toEqual(['原始记录', '新增内容']);
    expect(await readFile(path.join(merged.directory, messages[0].mediaFile as string))).toEqual(fixtureImage);
    expect(await readFile(path.join(first.directory, 'archive.json'))).toEqual(originalArchive);
    expect(merged.warnings.join('')).toContain('原档案未被覆盖');
  });

  it('retains previous out-of-range messages with an explicit incremental-filter warning', async () => {
    const input = await fixtureInput();
    input.conversations[0].messages = [message('old', { text: '旧时间', sentAt: '2026-08-01T10:00:00Z' })];
    const old = await exportConversationArchive(input);
    input.request = baseRequest({ from: '2026-08-31', mergePrevious: true });
    input.previousArchiveDirectory = old.directory;
    input.conversations[0].messages = [message('new', { text: '新时间' })];
    const merged = await exportConversationArchive(input);
    expect(merged.messageCount).toBe(2);
    expect(merged.warnings.join('')).toContain('筛选仅作用于新读取');
  });

  it('does not merge another account into the current customer', async () => {
    const input = await fixtureInput();
    const old = await exportConversationArchive(input);
    input.accountKey = 'different-account';
    input.request = baseRequest({ mergePrevious: true });
    input.previousArchiveDirectory = old.directory;
    await expect(exportConversationArchive(input)).rejects.toThrow('当前账号或所选会话不一致');
    expect(await readdir(input.directory)).toHaveLength(1);
  });

  it('rejects untrusted prior archive resource traversal before copying any files', async () => {
    const input = await fixtureInput();
    const old = await exportConversationArchive(input);
    const archive = await readJson(path.join(old.directory, 'archive.json'));
    const conversations = archive.conversations as Array<{ messages: Array<Record<string, unknown>> }>;
    conversations[0].messages[0].mediaFile = '../../private.txt';
    await writeFile(path.join(old.directory, 'archive.json'), JSON.stringify(archive));
    input.request = baseRequest({ mergePrevious: true });
    input.previousArchiveDirectory = old.directory;
    await expect(exportConversationArchive(input)).rejects.toThrow('资源路径不安全');
    expect(await readdir(input.directory)).toHaveLength(1);
  });

  it('does not hide media missing from a previous archive', async () => {
    const input = await fixtureInput({ request: baseRequest({ media: 'available' }), resolveMedia: async () => ({ ok: true, bytes: fixtureImage, mime: 'image/png' }) });
    input.conversations[0].messages = [message('original', { messageType: 'image', mediaKey: 'img' })];
    const old = await exportConversationArchive(input);
    const saved = await readArchivedMessages(old.directory);
    await unlink(path.join(old.directory, saved[0].mediaFile as string));
    input.request = baseRequest({ mergePrevious: true });
    input.previousArchiveDirectory = old.directory;
    input.conversations[0].messages = [];
    const merged = await exportConversationArchive(input);
    expect(merged.messageCount).toBe(1);
    expect((await readJson(merged.manifestPath)).missingResources).toEqual([expect.objectContaining({ kind: 'media', reason: 'missing' })]);
  });
});

describe('cancellation and failure boundaries', () => {
  it('does not create output for an already-cancelled request', async () => {
    const controller = new AbortController();
    controller.abort();
    const input = await fixtureInput({ signal: controller.signal });
    await expect(exportConversationArchive(input)).rejects.toBeInstanceOf(ConversationExportCancelledError);
    expect(await readdir(input.directory)).toEqual([]);
  });

  it('cancels sequential resource work and leaves an explicit incomplete marker', async () => {
    const controller = new AbortController();
    const resolver = vi.fn(async () => { controller.abort(); return { ok: true as const, bytes: fixtureImage, mime: 'image/png' }; });
    const input = await fixtureInput({ request: baseRequest({ media: 'available' }), signal: controller.signal, resolveMedia: resolver });
    input.conversations[0].messages = [message('1', { messageType: 'image', mediaKey: 'one' }), message('2', { messageType: 'image', mediaKey: 'two' })];
    await expect(exportConversationArchive(input)).rejects.toBeInstanceOf(ConversationExportCancelledError);
    expect(resolver).toHaveBeenCalledTimes(1);
    const [partial] = await readdir(input.directory);
    expect(await readFile(path.join(input.directory, partial, 'INCOMPLETE.txt'), 'utf8')).toContain('已取消');
  });

  it('never exposes an underlying source database path or token in the error', async () => {
    const input = await fixtureInput();
    input.conversations[0].messages = {
      async *[Symbol.asyncIterator]() {
        yield [message()];
        throw new Error('读取失败 C:\\private\\database TOKEN=SECRET');
      },
    };
    await expect(exportConversationArchive(input)).rejects.toThrow('导出未完成，请检查');
    const [partial] = await readdir(input.directory);
    const marker = await readFile(path.join(input.directory, partial, 'INCOMPLETE.txt'), 'utf8');
    expect(marker).not.toContain('SECRET');
  });

  it('does not leave a valid-looking manifest or ZIP when compression is cancelled', async () => {
    const controller = new AbortController();
    const input = await fixtureInput({ request: baseRequest({ zip: true }), signal: controller.signal, onProgress: (progress) => { if (progress.phase === 'compressing') controller.abort(); } });
    await expect(exportConversationArchive(input)).rejects.toBeInstanceOf(ConversationExportCancelledError);
    const [partial] = await readdir(input.directory);
    const files = await readdir(path.join(input.directory, partial));
    expect(files).toContain('INCOMPLETE.txt');
    expect(files).not.toContain('archive.zip');
    expect((await readJson(path.join(input.directory, partial, 'manifest.json'))).status).toBe('cancelled');
  });

  it('fails explicitly for oversized messages instead of silently truncating text', async () => {
    const input = await fixtureInput();
    input.conversations[0].messages = [message('large', { text: 'x'.repeat(1_000_001) })];
    await expect(exportConversationArchive(input)).rejects.toThrow('单条导出内容过长');
  });
});
