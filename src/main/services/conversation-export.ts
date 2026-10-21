import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, realpath, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Zip, ZipDeflate, ZipPassThrough } from 'fflate';
import { compareWechatMessageOrder } from '../../shared/wechat-message-order';
import {
  CONVERSATION_EXPORT_FORMATS,
  type ConversationExportProgress,
  type ConversationExportRequest,
  type ExportCrmContext,
  type ExportMessage,
  type ExportMessageType,
} from '../../shared/export-contracts';

export const CONVERSATION_EXPORT_LIMITS = {
  conversations: 5,
  messages: 50_000,
  scannedMessages: 250_000,
  textBytes: 48 * 1024 * 1024,
  archiveJsonBytes: 80 * 1024 * 1024,
  mediaFileBytes: 16 * 1024 * 1024,
  mediaTotalBytes: 512 * 1024 * 1024,
  mediaFiles: 3_000,
  operationTimeoutMs: 35_000,
} as const;

export interface ExportConversationSource {
  contactKey: string;
  title: string;
  messages: readonly ExportMessage[] | AsyncIterable<readonly ExportMessage[]>;
  /** Evaluated after consuming all pages. Never infer completeness from a 500-message snapshot. */
  completeness: 'complete' | 'partial' | 'unknown';
  crm?: ExportCrmContext;
  /** Main-process-only explanation for a bound CRM supplement that could not be read. */
  crmNotice?: string;
}

export type ExportMediaResolver = (key: string, options: {
  signal: AbortSignal;
  maxBytes: number;
}) => Promise<
  | { ok: true; bytes: Uint8Array; mime: string }
  | { ok: false; reason: string }
>;

export type ExportTranscriptResolver = (message: ExportMessage, options: {
  signal: AbortSignal;
}) => Promise<{ ok: true; text: string; engine?: string } | { ok: false; reason: string }>;

export interface ExportArchiveInput {
  /** Must come from the authenticated main-process directory chooser, never renderer input. */
  directory: string;
  /** A stable opaque account identity. It is hashed with the contact identity, never exported. */
  accountKey: string;
  request: ConversationExportRequest;
  conversations: ExportConversationSource[];
  resolveMedia?: ExportMediaResolver;
  resolveTranscript?: ExportTranscriptResolver;
  /** Main-process chooser result; only our own archive.json schema is accepted. */
  previousArchiveDirectory?: string;
  signal?: AbortSignal;
  onProgress?: (progress: ConversationExportProgress) => void;
}

export interface ExportArchiveResult {
  completeness?: 'complete' | 'partial';
  directory: string;
  entryPath: string;
  manifestPath: string;
  zipPath?: string;
  messageCount: number;
  mediaCount: number;
  warnings: string[];
}

interface ArchivedMessage extends Pick<ExportMessage, 'id' | 'direction' | 'sender' | 'text' | 'sentAt' | 'messageType' | 'sortSequence' | 'attachmentKind'> {
  mediaFile?: string;
  avatarFile?: string;
  mediaState?: 'saved' | 'omitted' | 'missing';
  voiceTranscript?: string;
  voiceTranscriptEngine?: string;
}

interface ArchivedConversation {
  id: string;
  title: string;
  completeness: 'complete' | 'partial' | 'unknown';
  crm?: ExportCrmContext;
  messages: ArchivedMessage[];
}

interface ArchiveDocument {
  schema: 'lingxu.conversation-archive';
  schemaVersion: 1;
  product: '领序·客户参谋';
  exportedAt: string;
  timeZone: 'Asia/Shanghai';
  title: string;
  filters: { from?: string; to?: string; messageTypes?: ExportMessageType[] };
  conversations: ArchivedConversation[];
  /** Single-conversation JSON remains compatible with the existing JSON importer's messages field. */
  messages?: ArchivedMessage[];
  warnings: string[];
}

interface MissingResource {
  conversationId: string;
  messageId: string;
  kind: 'media' | 'avatar' | 'transcript';
  reason: 'missing' | 'unsupported' | 'unavailable' | 'limit' | 'not-transcribed';
}

const MESSAGE_TYPES: readonly ExportMessageType[] = ['text', 'image', 'sticker', 'voice', 'video', 'file', 'system', 'other'];
const HASHED_ASSET = /^assets\/[a-f0-9]{64}\.(?:jpg|png|gif|webp|wav|mp3|ogg|mp4)$/u;
const HASHED_ID = /^[a-f0-9]{64}$/u;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const hash = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
const cleanText = (value: unknown, maximum = 1_000_000): string => {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  // eslint-disable-next-line no-control-regex -- Strip control bytes from untrusted export fields.
  const result = String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '');
  if (result.length > maximum) throw new Error('单条导出内容过长，请缩小导出范围');
  return result;
};
const optionalText = (value: unknown): string | undefined => cleanText(value) || undefined;

export class ConversationExportCancelledError extends Error {
  constructor() {
    super('导出已取消');
    this.name = 'AbortError';
  }
}

const checkCancelled = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw new ConversationExportCancelledError();
};

const withDeadline = async <T>(run: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> => {
  checkCancelled(signal);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => run(controller.signal)),
      new Promise<never>((_, reject) => {
        onAbort = () => { controller.abort(); reject(new ConversationExportCancelledError()); };
        signal?.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('读取导出资料超时，请缩小范围后重试'));
        }, CONVERSATION_EXPORT_LIMITS.operationTimeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
};

const parseBoundary = (value: string | undefined, end: boolean): number | undefined => {
  if (!value) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    const date = new Date(`${value}T00:00:00.000Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
      throw new Error('导出日期无效');
    }
    return Date.parse(`${value}T00:00:00.000+08:00`) + (end ? 86_400_000 - 1 : 0);
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) {
    throw new Error('导出时间须使用日期或带时区的时间');
  }
  const result = Date.parse(value);
  const calendarDay = new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
  if (!Number.isFinite(result) || !Number.isFinite(calendarDay.getTime()) || calendarDay.toISOString().slice(0, 10) !== value.slice(0, 10)) {
    throw new Error('导出日期无效');
  }
  return result;
};

export const validateConversationExportRequest = (value: unknown): ConversationExportRequest => {
  if (!isRecord(value) || !Array.isArray(value.contactKeys)
    || value.contactKeys.length < 1 || value.contactKeys.length > CONVERSATION_EXPORT_LIMITS.conversations
    || value.contactKeys.some((key) => typeof key !== 'string' || !key.trim() || key.length > 256)
    || new Set(value.contactKeys).size !== value.contactKeys.length) {
    throw new Error('请选择1至5个有效且不重复的会话');
  }
  if (!CONVERSATION_EXPORT_FORMATS.includes(value.format as ConversationExportRequest['format'])) {
    throw new Error('不支持的导出格式');
  }
  if (value.contactKeys.length > 1 && value.format !== 'html') throw new Error('多会话合并仅支持HTML');
  for (const flag of ['includeCrm', 'includeAvatars', 'includeVoiceTranscripts', 'zip', 'mergePrevious']) {
    if (value[flag] !== undefined && typeof value[flag] !== 'boolean') throw new Error('导出选项无效');
  }
  if (value.media !== undefined && !['none', 'available'].includes(String(value.media))) throw new Error('媒体选项无效');
  if (value.missingMedia !== undefined && !['placeholder', 'omit'].includes(String(value.missingMedia))) {
    throw new Error('缺失媒体选项无效');
  }
  if (value.format !== 'html' && (value.zip || value.mergePrevious || value.includeAvatars || value.media === 'available')) {
    throw new Error('媒体、头像、ZIP和增量合并仅支持HTML');
  }
  if (value.messageTypes !== undefined && (!Array.isArray(value.messageTypes) || value.messageTypes.length === 0
    || value.messageTypes.some((type) => !MESSAGE_TYPES.includes(type as ExportMessageType)))) {
    throw new Error('请至少选择一种有效消息类型');
  }
  for (const field of ['from', 'to']) {
    if (value[field] !== undefined && (typeof value[field] !== 'string' || String(value[field]).length > 64)) {
      throw new Error('导出日期无效');
    }
  }
  const from = parseBoundary(value.from as string | undefined, false);
  const to = parseBoundary(value.to as string | undefined, true);
  if (from !== undefined && to !== undefined && from > to) throw new Error('开始日期不能晚于结束日期');
  if (value.title !== undefined && (typeof value.title !== 'string' || value.title.length > 160)) {
    throw new Error('档案名称过长');
  }
  return {
    contactKeys: [...value.contactKeys] as string[],
    format: value.format as ConversationExportRequest['format'],
    title: cleanText(value.title, 160).trim() || undefined,
    from: optionalText(value.from), to: optionalText(value.to),
    messageTypes: value.messageTypes ? [...new Set(value.messageTypes as ExportMessageType[])] : undefined,
    includeCrm: value.includeCrm === true,
    includeAvatars: value.includeAvatars === true,
    includeVoiceTranscripts: value.includeVoiceTranscripts === true,
    media: value.media === 'available' ? 'available' : 'none',
    missingMedia: value.missingMedia === 'omit' ? 'omit' : 'placeholder',
    zip: value.zip === true, mergePrevious: value.mergePrevious === true,
  };
};

/** Only application-controlled business fields are exported; raw CRM records are never serialized. */
export const normalizeCrmExportContext = (input: unknown): ExportCrmContext => {
  if (!isRecord(input) || !isRecord(input.customer)) throw new Error('CRM客户资料格式无效');
  const customer = isRecord(input.customer.customer) ? input.customer.customer : input.customer;
  if (!optionalText(customer.id)) throw new Error('CRM客户资料缺少身份信息');
  const labels: Array<[string, string]> = [
    ['name', '姓名'], ['phone', '电话'], ['level', '客户等级'], ['ownerName', '负责人'],
    ['area', '购房区域'], ['budget', '预算'], ['location', '客户位置'], ['customerType', '购房用途'],
    ['source', '客户来源'], ['firstContact', '首次沟通'], ['houseRequirement', '选房需求'],
    ['targetProperty', '看中标的'], ['targetHousePrice', '起拍价（万元）'], ['targetHouseDistrict', '关联房源区域'],
    ['acquiredAt', '获客时间'], ['nextFollowupAt', '下次跟进'], ['visitAt', '到访时间'],
    ['dealSignedAt', '签约时间'], ['dealAmount', '付费金额'], ['dealPoints', '签约点数'], ['tags', '客户标签'],
    ['loanStatus', '贷款资质'], ['loanMethod', '购房方式'], ['loanApproval', '贷款审批'],
    ['loanRemark', '贷款备注'], ['auctionStatus', '参拍情况'], ['auctionTarget', '竞拍目标'],
    ['auctionCount', '参拍次数'], ['createdAt', '创建时间'], ['updatedAt', '更新时间'],
    ['lastFollowupContent', '最近跟进摘要'],
  ];
  const availability = isRecord(input.availability) ? input.availability : {};
  const ready = (value: unknown): boolean => ['ready', 'available', 'complete'].includes(String(value));
  const notices = ['未导出身份证号码、凭据及录音文件原始路径；通话文字不等于音频附件。'];
  for (const [field, title] of [['followups', '跟进记录'], ['calls', '通话记录']]) {
    if (!ready(availability[field])) notices.push(`${title}的完整性未获确认${availability[field] === 'forbidden' ? '（当前账号无权读取）' : ''}。`);
  }
  const followups = Array.isArray(input.followups) ? input.followups : [];
  const calls = Array.isArray(input.calls) ? input.calls : [];
  if (followups.length + calls.length > CONVERSATION_EXPORT_LIMITS.messages) throw new Error('CRM记录过多，请缩小导出范围');
  return {
    customerId: cleanText(customer.id, 256), customerName: cleanText(customer.name, 256),
    fetchedAt: cleanText(input.fetchedAt, 64),
    profile: labels.flatMap(([field, label]) => {
      const value = optionalText(customer[field]);
      return value ? [{ label, value }] : [];
    }),
    followups: followups.filter(isRecord).map((row) => ({
      id: optionalText(row.id), recordedAt: optionalText(row.followupAt ?? row.createdAt),
      author: optionalText(row.userName ?? row.author),
      text: [optionalText(row.method), optionalText(row.result), optionalText(row.content)].filter(Boolean).join(' · ') || '（无正文）',
    })),
    calls: calls.filter(isRecord).map((row) => ({
      id: optionalText(row.id), startedAt: optionalText(row.calledAt ?? row.createdAt),
      author: optionalText(row.userName), direction: row.direction === 'in' ? '呼入' : row.direction === 'out' ? '呼出' : undefined,
      durationSeconds: typeof row.durationSec === 'number' && Number.isFinite(row.durationSec) ? Math.max(0, row.durationSec) : undefined,
      result: row.connected === 1 ? '已接通' : row.connected === 0 ? '未接通' : undefined,
      notes: optionalText(row.notes), transcript: optionalText(row.transcript),
    })),
    completeness: ready(availability.followups) && ready(availability.calls) ? 'complete' : 'partial',
    notices,
  };
};

const sanitizeCrm = (input: ExportCrmContext): ExportCrmContext => ({
  customerId: cleanText(input.customerId, 256), customerName: cleanText(input.customerName, 256),
  fetchedAt: cleanText(input.fetchedAt, 64),
  profile: input.profile.map((field) => ({ label: cleanText(field.label, 160), value: cleanText(field.value) })),
  followups: input.followups.map((row) => ({
    id: optionalText(row.id), recordedAt: optionalText(row.recordedAt), author: optionalText(row.author), text: cleanText(row.text),
  })),
  calls: input.calls.map((row) => ({
    id: optionalText(row.id), startedAt: optionalText(row.startedAt), author: optionalText(row.author),
    direction: optionalText(row.direction), result: optionalText(row.result), notes: optionalText(row.notes),
    transcript: optionalText(row.transcript),
    durationSeconds: typeof row.durationSeconds === 'number' && Number.isFinite(row.durationSeconds) ? Math.max(0, row.durationSeconds) : undefined,
  })),
  completeness: ['complete', 'partial', 'unknown'].includes(input.completeness) ? input.completeness : 'unknown',
  notices: input.notices?.map((notice) => cleanText(notice)),
});

const normalizeMessage = (input: ExportMessage): ArchivedMessage => {
  if (!input || !optionalText(input.id) || !['incoming', 'outgoing', 'system'].includes(input.direction)) {
    throw new Error('读取到无效的消息，导出已停止');
  }
  const messageType = input.mediaKind === 'sticker' ? 'sticker' : input.messageType;
  return {
    id: hash(cleanText(input.id, 1024)), direction: input.direction,
    sender: cleanText(input.sender, 256), text: cleanText(input.text), sentAt: cleanText(input.sentAt, 64),
    messageType: MESSAGE_TYPES.includes(messageType) ? messageType : 'other',
    sortSequence: optionalText(input.sortSequence),
    ...(input.attachmentKind && ['video', 'file', 'unknown'].includes(input.attachmentKind)
      ? { attachmentKind: input.attachmentKind } : {}),
  };
};

async function* pages(source: ExportConversationSource['messages']): AsyncIterable<readonly ExportMessage[]> {
  if (Array.isArray(source)) {
    for (let index = 0; index < source.length; index += 500) yield source.slice(index, index + 500);
  } else {
    yield* source as AsyncIterable<readonly ExportMessage[]>;
  }
}

const safeFileStem = (value: string): string => {
  // eslint-disable-next-line no-control-regex -- Windows filenames cannot contain these bytes.
  let stem = value.replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '-').replace(/[. ]+$/gu, '').trim().slice(0, 64);
  if (!stem || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(stem)) stem = '客户聊天档案';
  return stem;
};

const mediaExtension = (bytes: Uint8Array, mime: string): string | undefined => {
  const head = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 24));
  if (mime === 'image/png' && head.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'png';
  if (mime === 'image/jpeg' && head.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))) return 'jpg';
  if (mime === 'image/gif' && ['GIF87a', 'GIF89a'].includes(head.toString('ascii', 0, 6))) return 'gif';
  if (mime === 'image/webp' && head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (mime === 'audio/wav' && head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WAVE') return 'wav';
  if (mime === 'audio/ogg' && head.toString('ascii', 0, 4) === 'OggS') return 'ogg';
  if (mime === 'audio/mpeg' && (head.toString('ascii', 0, 3) === 'ID3' || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0))) return 'mp3';
  if (mime === 'video/mp4' && head.toString('ascii', 4, 8) === 'ftyp') return 'mp4';
  return undefined;
};

const escapeHtml = (value: string): string => value.replace(/[&<>"']/gu, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character] as string));
const csvCell = (value: string): string => {
  const safe = /^[\s\uFEFF]*[=+\-@]/u.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/gu, '""')}"`;
};
const markdownText = (value: string): string => escapeHtml(value).replace(/([\\`*_{}[\]()#+.!|>-])/gu, '\\$1');
const crmCallText = (call: ExportCrmContext['calls'][number]): string => [
  call.direction, call.result, call.durationSeconds === undefined ? undefined : `时长 ${call.durationSeconds} 秒`,
  call.notes, call.transcript ? `通话转写：${call.transcript}` : undefined,
].filter(Boolean).join('\n');

type TimelineRow = { kind: 'chat' | 'crm-followup' | 'crm-call'; sentAt: string; sender: string; text: string; message?: ArchivedMessage };
const messageTime = (value: string): number => Date.parse(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/u.test(value)
  ? `${value.replace(' ', 'T')}+08:00` : value);
const chronologicalOrder = (left: { sentAt: string; sortSequence?: string }, right: { sentAt: string; sortSequence?: string }): number => {
  const leftTime = messageTime(left.sentAt);
  const rightTime = messageTime(right.sentAt);
  if (!Number.isFinite(leftTime)) return Number.isFinite(rightTime) ? 1 : 0;
  if (!Number.isFinite(rightTime)) return -1;
  return leftTime - rightTime || compareWechatMessageOrder('', '', left.sortSequence, right.sortSequence);
};
const timeline = (conversation: ArchivedConversation): TimelineRow[] => [
  ...conversation.messages.map((message): TimelineRow => ({ kind: 'chat', sentAt: message.sentAt, sender: message.sender, text: message.text, message })),
  ...(conversation.crm?.followups ?? []).map((row): TimelineRow => ({ kind: 'crm-followup', sentAt: row.recordedAt ?? '', sender: row.author ?? '', text: row.text })),
  ...(conversation.crm?.calls ?? []).map((row): TimelineRow => ({ kind: 'crm-call', sentAt: row.startedAt ?? '', sender: row.author ?? '', text: crmCallText(row) })),
].sort((left, right) => chronologicalOrder({ sentAt: left.sentAt, sortSequence: left.message?.sortSequence }, { sentAt: right.sentAt, sortSequence: right.message?.sortSequence }));
const rowTitle = (row: TimelineRow): string => row.kind === 'crm-followup' ? 'CRM 跟进' : row.kind === 'crm-call' ? 'CRM 通话' : row.sender || '微信消息';

const mediaMarkup = (message: ArchivedMessage, showMissing: boolean): string => {
  if (message.mediaFile) {
    const url = escapeHtml(message.mediaFile);
    if (/\.(?:png|jpg|gif|webp)$/u.test(message.mediaFile)) return `<img class="attachment" src="${url}" loading="lazy" alt="聊天${message.messageType === 'sticker' ? '表情' : '图片'}">`;
    if (/\.(?:wav|mp3|ogg)$/u.test(message.mediaFile)) return `<audio controls preload="none" src="${url}"></audio>`;
    if (/\.mp4$/u.test(message.mediaFile)) return `<video controls preload="none" src="${url}"></video>`;
  }
  return showMissing && message.mediaState === 'missing' ? '<p class="notice">此媒体未能读取，未在档案中伪造内容。</p>' : '';
};

const htmlDocument = (document: ArchiveDocument, showMissing: boolean): string => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>${escapeHtml(document.title)} · 领序</title><style>
:root{color-scheme:light;font:15px/1.7 system-ui,"Microsoft YaHei",sans-serif;color:#24231f;background:#f4f2ed}*{box-sizing:border-box}body{max-width:960px;margin:0 auto;padding:32px 20px}header{background:#181a1b;color:#f5f0e5;padding:28px;border-top:4px solid #b69860}h1{font-size:26px;line-height:1.4;margin:8px 0}h2{font-size:21px}p{white-space:pre-wrap;overflow-wrap:anywhere}header small{color:#dbc597}nav{display:flex;flex-wrap:wrap;gap:16px;margin:24px 0}a{color:#6c501d}section{margin:36px 0}details{border:1px solid #d7d2c6;background:white;padding:16px}summary{font-weight:600;cursor:pointer}dl{display:grid;grid-template-columns:minmax(90px,160px) 1fr;gap:8px 16px}dt{color:#666054}dd{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}article{display:flex;align-items:flex-start;gap:10px;margin:18px 0}.bubble{max-width:76%;border:1px solid #ddd8cd;background:white;border-radius:12px;padding:12px 16px}.outgoing{flex-direction:row-reverse}.outgoing .bubble{background:#f3e8cf;border-color:#d8c6a3}.system,.crm-followup,.crm-call{justify-content:center}.system .bubble,.crm-followup .bubble,.crm-call .bubble{background:#eae7df;max-width:90%;width:90%;border-left:3px solid #a58a59}.avatar{width:36px;height:36px;object-fit:cover;border-radius:8px;flex-shrink:0}.avatar.fallback{display:grid;place-items:center;background:#ddd6c9;color:#51452f}.bubble p{margin:6px 0}.meta{font-size:12px;color:#6c665c}.notice{font-size:13px;color:#77654b}.attachment{display:block;max-width:100%;max-height:520px;object-fit:contain}audio,video{display:block;max-width:100%;margin:8px 0}video{max-height:440px}footer{border-top:1px solid #d7d2c6;margin-top:32px;padding-top:16px;color:#6c665c;font-size:12px}@media(max-width:600px){body{padding:12px}header{padding:20px}.bubble{max-width:84%}dl{grid-template-columns:100px 1fr}}@media print{body{background:white}header{background:white;color:black}article{break-inside:avoid}details{display:block}}
</style></head><body><header><small>领序 · 客户参谋 / 本地客户档案</small><h1>${escapeHtml(document.title)}</h1><p>${escapeHtml(document.exportedAt)} · 时间范围按北京时间</p></header>
${document.warnings.length ? `<aside class="notice">${document.warnings.map((warning) => `<p>${escapeHtml(warning)}</p>`).join('')}</aside>` : ''}
<nav>${document.conversations.map((conversation, index) => `<a href="#conversation-${index}">${escapeHtml(conversation.title)} · ${conversation.messages.length} 条微信消息</a>`).join('')}</nav>
${document.conversations.map((conversation, index) => `<section id="conversation-${index}"><h2>${escapeHtml(conversation.title)}</h2><p class="meta">微信读取完整性：${conversation.completeness === 'complete' ? '所选范围读取完成' : '部分或未经完整性确认'}</p>
${conversation.crm ? `<details open><summary>CRM 客户资料 · ${escapeHtml(conversation.crm.customerName)}</summary><p class="meta">读取于 ${escapeHtml(conversation.crm.fetchedAt)} · ${conversation.crm.completeness === 'complete' ? '授权范围读取完成' : '部分资料'}</p><dl>${conversation.crm.profile.map((field) => `<dt>${escapeHtml(field.label)}</dt><dd>${escapeHtml(field.value)}</dd>`).join('')}</dl>${conversation.crm.notices?.map((notice) => `<p class="notice">${escapeHtml(notice)}</p>`).join('') ?? ''}</details>` : ''}
${timeline(conversation).map((row) => {
    const message = row.message;
    const avatar = message && message.direction !== 'system'
      ? message.avatarFile ? `<img class="avatar" src="${escapeHtml(message.avatarFile)}" loading="lazy" alt="${escapeHtml(message.sender)}的头像">` : `<span class="avatar fallback" aria-label="无头像">${escapeHtml(Array.from(message.sender || '微')[0])}</span>`
      : '';
    return `<article class="${message?.direction ?? row.kind}">${avatar}<div class="bubble"><div class="meta">${escapeHtml(rowTitle(row))} · ${escapeHtml(row.sentAt || '时间未提供')}</div><p>${escapeHtml(row.text)}</p>${message ? mediaMarkup(message, showMissing) : ''}${message?.voiceTranscript ? `<p>语音转写：${escapeHtml(message.voiceTranscript)}</p><span class="meta">本地识别结果，请对照语音核实${message.voiceTranscriptEngine ? ` · ${escapeHtml(message.voiceTranscriptEngine)}` : ''}</span>` : ''}</div></article>`;
  }).join('\n')}</section>`).join('\n')}
<footer>本档案由用户主动在本机导出，未修改微信原始数据。包含私人客户资料，请仅向获授权的人分享。缺失媒体详见 manifest.json；语音转写不保证完全准确。原始图片或缩略图取决于本机可用资源，不承诺所有媒体均为原图。</footer></body></html>`;

const textDocument = (document: ArchiveDocument, markdown: boolean): string => {
  const escape = markdown ? markdownText : (value: string) => value;
  const lines = [markdown ? `# ${escape(document.title)}` : document.title, `领序·客户参谋 | ${document.exportedAt}`, ''];
  lines.push(...document.warnings.map(escape), '');
  for (const conversation of document.conversations) {
    lines.push(`${markdown ? '## ' : ''}${escape(conversation.title)}`, `微信消息 ${conversation.messages.length} 条；完整性：${conversation.completeness}`, '');
    if (conversation.crm) {
      lines.push(`${markdown ? '### ' : ''}CRM 客户资料`, `客户：${escape(conversation.crm.customerName)}`);
      lines.push(...conversation.crm.profile.map((field) => `${escape(field.label)}：${escape(field.value)}`));
      lines.push(...(conversation.crm.notices ?? []).map(escape), '');
    }
    for (const row of timeline(conversation)) {
      lines.push(`[${escape(row.sentAt || '时间未提供')}] ${escape(rowTitle(row))}：${escape(row.text)}`);
      if (row.message?.voiceTranscript) lines.push(`语音转写（需核实）：${escape(row.message.voiceTranscript)}`);
      lines.push('');
    }
  }
  return lines.join('\n');
};

const csvDocument = (document: ArchiveDocument): string => {
  const rows: string[][] = [['记录类别', '会话', '时间', '发送者或记录人', '方向', '消息类型', '内容', '语音转写', 'CRM客户编号']];
  for (const conversation of document.conversations) {
    rows.push(['导出元数据', conversation.title, document.exportedAt, '', '', '', `微信读取完整性：${conversation.completeness}；${document.warnings.join('；')}`, '', conversation.crm?.customerId ?? '']);
    if (conversation.crm) {
      for (const field of conversation.crm.profile) rows.push(['CRM资料', conversation.title, conversation.crm.fetchedAt, '', '', field.label, field.value, '', conversation.crm.customerId]);
      for (const notice of conversation.crm.notices ?? []) rows.push(['CRM说明', conversation.title, '', '', '', '', notice, '', conversation.crm.customerId]);
    }
    for (const row of timeline(conversation)) rows.push([
      row.kind === 'chat' ? '微信消息' : rowTitle(row), conversation.title, row.sentAt, row.sender,
      row.message?.direction ?? '', row.message?.messageType ?? '', row.text, row.message?.voiceTranscript ?? '', conversation.crm?.customerId ?? '',
    ]);
  }
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
};

const readArchive = async (directory: string): Promise<ArchiveDocument> => {
  try {
    const root = await realpath(directory);
    const filePath = await realpath(path.join(root, 'archive.json'));
    if (path.dirname(filePath) !== root || (await stat(filePath)).size > CONVERSATION_EXPORT_LIMITS.archiveJsonBytes) throw new Error();
    const raw = await readFile(filePath, 'utf8');
    if (Buffer.byteLength(raw) > CONVERSATION_EXPORT_LIMITS.archiveJsonBytes) throw new Error();
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.schema !== 'lingxu.conversation-archive' || parsed.schemaVersion !== 1
      || !Array.isArray(parsed.conversations) || parsed.conversations.length > CONVERSATION_EXPORT_LIMITS.conversations) throw new Error();
    let count = 0;
    const conversations = parsed.conversations.map((conversation): ArchivedConversation => {
      if (!isRecord(conversation) || typeof conversation.id !== 'string' || !HASHED_ID.test(conversation.id) || !Array.isArray(conversation.messages)) throw new Error();
      count += conversation.messages.length;
      if (count > CONVERSATION_EXPORT_LIMITS.messages) throw new Error();
      const messages = conversation.messages.map((message): ArchivedMessage => {
        if (!isRecord(message) || typeof message.id !== 'string' || !HASHED_ID.test(message.id)
          || !['incoming', 'outgoing', 'system'].includes(String(message.direction))) throw new Error();
        for (const field of ['mediaFile', 'avatarFile']) if (message[field] !== undefined && !HASHED_ASSET.test(String(message[field]))) throw new Error();
        return {
          id: message.id, direction: message.direction as ArchivedMessage['direction'], sender: cleanText(message.sender, 256),
          text: cleanText(message.text), sentAt: cleanText(message.sentAt, 64),
          messageType: MESSAGE_TYPES.includes(message.messageType as ExportMessageType) ? message.messageType as ExportMessageType : 'other',
          sortSequence: optionalText(message.sortSequence),
          mediaFile: optionalText(message.mediaFile), avatarFile: optionalText(message.avatarFile),
          mediaState: ['saved', 'omitted', 'missing'].includes(String(message.mediaState)) ? message.mediaState as ArchivedMessage['mediaState'] : undefined,
          voiceTranscript: optionalText(message.voiceTranscript), voiceTranscriptEngine: optionalText(message.voiceTranscriptEngine),
        };
      });
      return {
        id: conversation.id, title: cleanText(conversation.title, 256),
        completeness: ['complete', 'partial', 'unknown'].includes(String(conversation.completeness)) ? conversation.completeness as ArchivedConversation['completeness'] : 'unknown',
        messages, crm: conversation.crm ? sanitizeCrm(conversation.crm as ExportCrmContext) : undefined,
      };
    });
    return {
      schema: 'lingxu.conversation-archive', schemaVersion: 1, product: '领序·客户参谋',
      exportedAt: cleanText(parsed.exportedAt, 64), timeZone: 'Asia/Shanghai', title: cleanText(parsed.title, 160),
      filters: {}, conversations, warnings: [],
    };
  } catch { throw new Error('旧档案不是有效的领序HTML档案，或资源路径不安全，未修改原文件'); }
};

const zipFiles = async (directory: string, names: string[], outputPath: string, signal?: AbortSignal): Promise<void> => {
  const handle = await open(outputPath, 'wx');
  let pendingChunks: Uint8Array[] = [];
  let failure: Error | undefined;
  let completed = false;
  const zip = new Zip((error, data, final) => {
    if (error) failure = error;
    if (data?.length) pendingChunks.push(data);
    if (final) completed = true;
  });
  const flush = async (): Promise<void> => {
    if (failure) throw failure;
    const chunks = pendingChunks;
    pendingChunks = [];
    for (const chunk of chunks) { checkCancelled(signal); await handle.writeFile(chunk); }
  };
  try {
    for (const name of names) {
      checkCancelled(signal);
      const file = name.startsWith('assets/') ? new ZipPassThrough(name) : new ZipDeflate(name, { level: 3 });
      zip.add(file);
      for await (const chunk of createReadStream(path.join(directory, name), { highWaterMark: 64 * 1024, signal })) {
        file.push(chunk as Buffer, false);
        await flush();
      }
      file.push(new Uint8Array(), true);
      await flush();
    }
    zip.end();
    await flush();
    if (!completed) throw new Error('ZIP未完成');
  } finally {
    zip.terminate();
    await handle.close();
  }
};

/** Reads and resolves one page/resource at a time. Only this new output directory is ever written. */
export const exportConversationArchive = async (input: ExportArchiveInput): Promise<ExportArchiveResult> => {
  const request = validateConversationExportRequest(input.request);
  checkCancelled(input.signal);
  if (!input.accountKey || input.accountKey.length > 256 || input.conversations.length !== request.contactKeys.length
    || new Set(input.conversations.map((source) => source.contactKey)).size !== request.contactKeys.length
    || input.conversations.some((source) => !request.contactKeys.includes(source.contactKey))) throw new Error('会话来源与导出选择不一致');
  if (request.mergePrevious !== Boolean(input.previousArchiveDirectory)) throw new Error('请明确选择要合并的旧档案目录');
  const parent = await realpath(input.directory);
  if (!(await stat(parent)).isDirectory()) throw new Error('请选择有效的导出文件夹');
  const old = input.previousArchiveDirectory ? await readArchive(input.previousArchiveDirectory) : undefined;
  const identity = (contactKey: string): string => hash(`${input.accountKey}\u0000${contactKey}`);
  if (old && (old.conversations.length !== input.conversations.length
    || new Set(old.conversations.map((source) => source.id)).size !== input.conversations.length
    || old.conversations.some((source) => !input.conversations.some((current) => identity(current.contactKey) === source.id)))) {
    throw new Error('旧档案与当前账号或所选会话不一致，不能合并');
  }
  const title = request.title ?? (input.conversations.length === 1 ? cleanText(input.conversations[0].title, 160) : '客户会话合集');
  const directory = await mkdtemp(path.join(parent, `${safeFileStem(title)}-`));
  const assets = path.join(directory, 'assets');
  const warnings: string[] = [];
  const missing: MissingResource[] = [];
  const files = new Set<string>();
  const mediaCache = new Map<string, { file?: string; reason?: MissingResource['reason'] }>();
  const savedAssets = new Set<string>();
  let mediaBytes = 0;
  let textBytes = 0;
  let invalidTimes = 0;
  const progress: ConversationExportProgress = {
    phase: 'reading', conversationsDone: 0, conversationCount: input.conversations.length,
    messagesRead: 0, messagesExported: 0, mediaSaved: 0, mediaMissing: 0,
  };
  let lastReportAt = 0;
  const report = (phase: ConversationExportProgress['phase']): void => {
    const changed = progress.phase !== phase;
    progress.phase = phase;
    if (!changed && phase !== 'complete' && Date.now() - lastReportAt < 120) return;
    lastReportAt = Date.now();
    input.onProgress?.({ ...progress });
  };
  const put = async (name: string, contents: string | Uint8Array): Promise<void> => {
    checkCancelled(input.signal);
    await writeFile(path.join(directory, name), contents, { flag: 'wx' });
    files.add(name);
  };
  const storeAsset = async (bytes: Uint8Array, extension: string): Promise<string | undefined> => {
    const name = `assets/${hash(bytes)}.${extension}`;
    if (savedAssets.has(name)) return name;
    if (savedAssets.size >= CONVERSATION_EXPORT_LIMITS.mediaFiles || mediaBytes + bytes.byteLength > CONVERSATION_EXPORT_LIMITS.mediaTotalBytes) return undefined;
    await mkdir(assets, { recursive: true });
    await put(name, bytes);
    savedAssets.add(name);
    mediaBytes += bytes.byteLength;
    progress.mediaSaved = savedAssets.size;
    return name;
  };
  const resolveAsset = async (key: string | undefined, avatar: boolean): Promise<{ file?: string; reason?: MissingResource['reason'] }> => {
    const resolver = input.resolveMedia;
    if (!key || !resolver) return { reason: 'missing' };
    const cacheKey = `${avatar ? 'avatar' : 'media'}:${key}`;
    const cached = mediaCache.get(cacheKey);
    if (cached) return cached;
    let result: { file?: string; reason?: MissingResource['reason'] };
    if (savedAssets.size >= CONVERSATION_EXPORT_LIMITS.mediaFiles || mediaBytes >= CONVERSATION_EXPORT_LIMITS.mediaTotalBytes) {
      result = { reason: 'limit' };
    } else {
      try {
        const read = () => withDeadline((signal) => resolver(key, { signal, maxBytes: CONVERSATION_EXPORT_LIMITS.mediaFileBytes }), input.signal);
        let resolved: Awaited<ReturnType<typeof read>>;
        let retried = false;
        try { resolved = await read(); }
        catch (error) {
          checkCancelled(input.signal);
          if (error instanceof ConversationExportCancelledError) throw error;
          retried = true;
          resolved = await read();
        }
        if (!retried && !resolved.ok && resolved.reason === 'unavailable') {
          checkCancelled(input.signal);
          resolved = await read();
        }
        checkCancelled(input.signal);
        if (!resolved.ok) result = { reason: resolved.reason === 'unsupported' ? 'unsupported' : resolved.reason === 'missing' ? 'missing' : resolved.reason === 'limit' ? 'limit' : 'unavailable' };
        else if (!(resolved.bytes instanceof Uint8Array) || !resolved.bytes.byteLength || resolved.bytes.byteLength > CONVERSATION_EXPORT_LIMITS.mediaFileBytes) result = { reason: 'limit' };
        else {
          const extension = mediaExtension(resolved.bytes, resolved.mime);
          if (!extension || (avatar && !['png', 'jpg', 'gif', 'webp'].includes(extension))) result = { reason: 'unsupported' };
          else {
            const file = await storeAsset(resolved.bytes, extension);
            result = file ? { file } : { reason: 'limit' };
          }
        }
      } catch (error) {
        if (error instanceof ConversationExportCancelledError) throw error;
        checkCancelled(input.signal);
        result = { reason: 'unavailable' };
      }
    }
    if (result.reason !== 'unavailable') mediaCache.set(cacheKey, result);
    return result;
  };
  const recordMissing = (conversationId: string, messageId: string, kind: MissingResource['kind'], reason: MissingResource['reason']): void => {
    missing.push({ conversationId, messageId, kind, reason });
    progress.mediaMissing += 1;
  };
  const copyPriorAsset = async (name: string): Promise<string | undefined> => {
    if (savedAssets.has(name)) return name;
    if (!input.previousArchiveDirectory || !HASHED_ASSET.test(name)) return undefined;
    try {
      const root = await realpath(input.previousArchiveDirectory);
      const filePath = await realpath(path.join(root, name));
      if (path.relative(root, filePath).replace(/\\/gu, '/') !== name || (await stat(filePath)).size > CONVERSATION_EXPORT_LIMITS.mediaFileBytes) return undefined;
      const bytes = await readFile(filePath);
      if (bytes.length > CONVERSATION_EXPORT_LIMITS.mediaFileBytes || path.basename(name).split('.')[0] !== hash(bytes)) return undefined;
      return await storeAsset(bytes, path.extname(name).slice(1));
    } catch { checkCancelled(input.signal); return undefined; }
  };
  try {
    report('reading');
    const document: ArchiveDocument = {
      schema: 'lingxu.conversation-archive', schemaVersion: 1, product: '领序·客户参谋',
      exportedAt: new Date().toISOString(), timeZone: 'Asia/Shanghai', title,
      filters: { from: request.from, to: request.to, messageTypes: request.messageTypes }, conversations: [], warnings,
    };
    const from = parseBoundary(request.from, false);
    const to = parseBoundary(request.to, true);
    for (const source of input.conversations) {
      checkCancelled(input.signal);
      const conversationId = identity(source.contactKey);
      const prior = old?.conversations.find((conversation) => conversation.id === conversationId);
      const messageMap = new Map<string, ArchivedMessage>();
      if (prior) {
        for (const original of prior.messages) {
          checkCancelled(input.signal);
          const message = { ...original };
          if (message.mediaFile) {
            message.mediaFile = await copyPriorAsset(message.mediaFile);
            if (!message.mediaFile) { message.mediaState = 'missing'; recordMissing(conversationId, message.id, 'media', 'missing'); }
          }
          if (message.avatarFile) message.avatarFile = await copyPriorAsset(message.avatarFile);
          messageMap.set(message.id, message);
        }
      }
      const iterator = pages(source.messages)[Symbol.asyncIterator]();
      let reading = true;
      let pageCount = 0;
      while (reading) {
        let next: IteratorResult<readonly ExportMessage[]>;
        try { next = await withDeadline(() => iterator.next(), input.signal); }
        catch (error) {
          void iterator.return?.().catch(() => undefined);
          throw error;
        }
        if (next.done) { reading = false; continue; }
        pageCount += 1;
        if (pageCount > 10_000) throw new Error('读取分页超过安全上限，请缩小日期范围');
        if (!Array.isArray(next.value)) throw new Error('消息分页格式无效');
        for (const raw of next.value) {
          checkCancelled(input.signal);
          progress.messagesRead += 1;
          if (progress.messagesRead > CONVERSATION_EXPORT_LIMITS.scannedMessages) throw new Error('读取消息超过安全上限，请缩小日期范围');
          const message = normalizeMessage(raw);
          const timestamp = messageTime(message.sentAt);
          if (!Number.isFinite(timestamp)) {
            invalidTimes += 1;
            if (from !== undefined || to !== undefined) continue;
          }
          if ((from !== undefined && timestamp < from) || (to !== undefined && timestamp > to)
            || (request.messageTypes && !request.messageTypes.includes(message.messageType))) continue;
          const existing = messageMap.get(message.id);
          if (existing) {
            // Preserve already archived content and enrich resources; never erase historical messages.
            message.mediaFile = existing.mediaFile;
            message.avatarFile = existing.avatarFile;
            message.voiceTranscript = existing.voiceTranscript;
            message.voiceTranscriptEngine = existing.voiceTranscriptEngine;
          }
          if (!existing && progress.messagesExported + messageMap.size >= CONVERSATION_EXPORT_LIMITS.messages) throw new Error('导出超过5万条消息，请缩小日期范围');
          if (request.format === 'html' && request.includeAvatars && message.direction !== 'system' && !message.avatarFile) {
            report('media');
            const result = await resolveAsset(raw.avatarMediaKey, true);
            message.avatarFile = result.file;
            if (!result.file) recordMissing(conversationId, message.id, 'avatar', result.reason ?? 'missing');
          }
          const isMedia = ['image', 'sticker', 'voice', 'video', 'file'].includes(message.messageType)
            || message.attachmentKind !== undefined;
          if (isMedia) {
            message.mediaState = message.mediaFile ? 'saved' : 'omitted';
            if (request.format === 'html' && request.media === 'available' && !message.mediaFile) {
              report('media');
              const result = message.attachmentKind && !raw.mediaKey
                ? { reason: 'unsupported' as const }
                : await resolveAsset(raw.mediaKey, false);
              message.mediaFile = result.file;
              message.mediaState = result.file ? 'saved' : 'missing';
              if (!result.file) recordMissing(conversationId, message.id, 'media', result.reason ?? 'missing');
            }
          }
          if (message.messageType === 'voice' && request.includeVoiceTranscripts && !message.voiceTranscript) {
            message.voiceTranscript = optionalText(raw.voiceTranscript);
            message.voiceTranscriptEngine = optionalText(raw.voiceTranscriptEngine);
            const transcriber = input.resolveTranscript;
            if (!message.voiceTranscript && transcriber) {
              report('transcribing');
              try {
                const result = await withDeadline((signal) => transcriber(raw, { signal }), input.signal);
                if (result.ok) {
                  message.voiceTranscript = optionalText(result.text);
                  message.voiceTranscriptEngine = optionalText(result.engine);
                }
              } catch (error) {
                if (error instanceof ConversationExportCancelledError) throw error;
                checkCancelled(input.signal);
              }
            }
            if (!message.voiceTranscript) recordMissing(conversationId, message.id, 'transcript', 'not-transcribed');
          }
          textBytes += Buffer.byteLength(JSON.stringify(message));
          if (textBytes > CONVERSATION_EXPORT_LIMITS.textBytes) throw new Error('导出文字超过安全上限，请缩小日期范围');
          messageMap.set(message.id, existing ? { ...existing, ...message, text: existing.text, sentAt: existing.sentAt } : message);
        }
        report('reading');
      }
      const messages = [...messageMap.values()].sort(chronologicalOrder);
      const crm = request.includeCrm && source.crm ? sanitizeCrm(source.crm) : undefined;
      if (source.crmNotice) warnings.push(`${source.title}：${cleanText(source.crmNotice, 500)}`);
      if (source.completeness !== 'complete') warnings.push(`${source.title}：仅导出本次已读到的消息，历史完整性未确认。`);
      if (crm && crm.completeness !== 'complete') warnings.push(`${source.title}：CRM资料不完整，请检查读取权限或连接。`);
      document.conversations.push({ id: conversationId, title: cleanText(source.title, 256), completeness: source.completeness, messages, crm });
      progress.messagesExported += messages.length;
      if (progress.messagesExported > CONVERSATION_EXPORT_LIMITS.messages) throw new Error('合并后超过5万条消息，请缩小导出范围');
      progress.conversationsDone += 1;
      report('reading');
    }
    const archivedById = new Map(document.conversations.flatMap((conversation) => conversation.messages.map((message) => [`${conversation.id}:${message.id}`, message] as const)));
    const unresolved = new Map<string, MissingResource>();
    for (const entry of missing) {
      const message = archivedById.get(`${entry.conversationId}:${entry.messageId}`);
      if (message && !(entry.kind === 'media' ? message.mediaFile : entry.kind === 'avatar' ? message.avatarFile : message.voiceTranscript)) {
        unresolved.set(`${entry.conversationId}:${entry.messageId}:${entry.kind}`, entry);
      }
    }
    missing.length = 0;
    for (const entry of unresolved.values()) missing.push(entry);
    const missingKeys = new Set(missing.map((entry) => `${entry.conversationId}:${entry.messageId}:${entry.kind}`));
    for (const conversation of document.conversations) {
      for (const message of conversation.messages) {
        for (const [kind, absent] of [
          ['media', message.mediaState === 'missing' && !message.mediaFile],
          ['avatar', request.includeAvatars && message.direction !== 'system' && !message.avatarFile],
          ['transcript', request.includeVoiceTranscripts && message.messageType === 'voice' && !message.voiceTranscript],
        ] as const) {
          const key = `${conversation.id}:${message.id}:${kind}`;
          if (absent && !missingKeys.has(key)) {
            recordMissing(conversation.id, message.id, kind, kind === 'transcript' ? 'not-transcribed' : 'missing');
            missingKeys.add(key);
          }
        }
      }
    }
    progress.mediaMissing = missing.length;
    if (old) warnings.push('已合并旧档案并保留历史消息；本次日期和类型筛选仅作用于新读取的消息，原档案未被覆盖。');
    if (missing.length) warnings.push(`${missing.length}处媒体、头像或语音转写未完成，具体见manifest.json。`);
    if (invalidTimes) warnings.push(`${invalidTimes}条消息的时间无法识别${from !== undefined || to !== undefined ? '，未纳入所选日期范围' : '，保留原时间文本'}。`);
    if (request.format === 'html' && request.media === 'available') warnings.push('媒体仅复制本机可读取的版本，可能为缩略图；未擅自联网下载缺失原图。');
    if (document.conversations.length === 1) document.messages = document.conversations[0].messages;
    report('writing');
    const extension = request.format === 'markdown' ? 'md' : request.format;
    const entryName = `conversation.${extension}`;
    const serialized = JSON.stringify(document, null, 2);
    if (Buffer.byteLength(serialized) > CONVERSATION_EXPORT_LIMITS.archiveJsonBytes) throw new Error('导出档案超过安全上限，请缩小范围');
    const body = request.format === 'html' ? htmlDocument(document, request.missingMedia !== 'omit')
      : request.format === 'json' ? serialized
        : request.format === 'csv' ? csvDocument(document) : textDocument(document, request.format === 'markdown');
    await put(entryName, body);
    if (request.format === 'html') await put('archive.json', serialized);
    const completeness = missing.length || invalidTimes || document.conversations.some((conversation) => conversation.completeness !== 'complete'
      || (conversation.crm && conversation.crm.completeness !== 'complete')) || input.conversations.some((source) => source.crmNotice)
      ? 'partial' : 'complete';
    const manifest = {
      schema: 'lingxu.export-manifest', schemaVersion: 1, status: completeness, product: document.product,
      exportedAt: document.exportedAt, format: request.format, filters: document.filters,
      messageCount: progress.messagesExported, mediaCount: savedAssets.size, mediaBytes,
      conversations: document.conversations.map((conversation) => ({ id: conversation.id, title: conversation.title, messageCount: conversation.messages.length, completeness: conversation.completeness, crmIncluded: Boolean(conversation.crm), crmCompleteness: conversation.crm?.completeness })),
      missingResources: missing, warnings,
      files: [...files].sort(),
    };
    await put('manifest.json', JSON.stringify(manifest, null, 2));
    let zipPath: string | undefined;
    if (request.zip) {
      report('compressing');
      zipPath = path.join(directory, 'archive.zip');
      await zipFiles(directory, [...files].sort(), zipPath, input.signal);
    }
    checkCancelled(input.signal);
    report('complete');
    return { completeness, directory, entryPath: path.join(directory, entryName), manifestPath: path.join(directory, 'manifest.json'), zipPath, messageCount: progress.messagesExported, mediaCount: savedAssets.size, warnings };
  } catch (error) {
    // Keep recoverable partial output, label it clearly, and never touch original or prior archives.
    await unlink(path.join(directory, 'archive.zip')).catch(() => undefined);
    const cancelled = error instanceof ConversationExportCancelledError || input.signal?.aborted;
    await writeFile(path.join(directory, 'INCOMPLETE.txt'), cancelled
      ? '导出已取消，此文件夹不是完整档案。微信原始数据及之前的档案均未修改。'
      : '导出未完成，此文件夹不是完整档案。微信原始数据及之前的档案均未修改。', { flag: 'wx' }).catch(() => undefined);
    if (files.has('manifest.json')) {
      await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({
        schema: 'lingxu.export-manifest', schemaVersion: 1,
        status: cancelled ? 'cancelled' : 'incomplete', warning: '此档案未完成，请勿当作完整记录。',
      }, null, 2)).catch(() => undefined);
    }
    if (cancelled) throw new ConversationExportCancelledError();
    const knownErrors = new Set([
      '读取到无效的消息，导出已停止', '读取导出资料超时，请缩小范围后重试', '消息分页格式无效',
      '读取分页超过安全上限，请缩小日期范围', '读取消息超过安全上限，请缩小日期范围',
      '导出超过5万条消息，请缩小日期范围', '导出文字超过安全上限，请缩小日期范围',
      '合并后超过5万条消息，请缩小导出范围', '导出档案超过安全上限，请缩小范围',
      '单条导出内容过长，请缩小导出范围',
    ]);
    if (error instanceof Error && knownErrors.has(error.message)) throw error;
    throw new Error('导出未完成，请检查可用磁盘空间、目录权限或缩小日期范围');
  }
};
