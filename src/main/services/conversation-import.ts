import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import type { ImportedConversation, ImportedMessage, MessageDirection } from '../../shared/contracts';

const MAX_IMPORT_BYTES = 10 * 1024 * 1024;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const normalizeDirection = (value: unknown, sender: string): MessageDirection => {
  if (value === 'outgoing' || value === 'sent' || value === 1 || sender === '我') {
    return 'outgoing';
  }
  return 'incoming';
};

const fromJson = (raw: unknown): ImportedMessage[] => {
  const candidates = Array.isArray(raw)
    ? raw
    : isRecord(raw) && Array.isArray(raw.messages)
      ? raw.messages
      : [];

  return candidates.flatMap((item, index): ImportedMessage[] => {
    if (!isRecord(item)) return [];
    const text = item.text ?? item.content ?? item.message;
    if (typeof text !== 'string' || !text.trim()) return [];
    const sender = typeof item.sender === 'string' ? item.sender : '客户';
    const sentAt = item.sentAt ?? item.timestamp ?? item.time;
    return [{
      id: String(item.id ?? `import-${index}`),
      direction: normalizeDirection(item.direction, sender),
      sender,
      text: text.trim(),
      sentAt: typeof sentAt === 'string' ? sentAt : new Date().toISOString(),
    }];
  });
};

const fromText = (content: string): ImportedMessage[] =>
  content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const matched = line.match(/^(?:\[([^\]]+)\]\s*)?([^:：]{1,20})[:：]\s*(.+)$/);
      const sender = matched?.[2]?.trim() ?? '客户';
      return {
        id: `import-${index}`,
        direction: normalizeDirection(undefined, sender),
        sender,
        text: matched?.[3]?.trim() ?? line,
        sentAt: matched?.[1]?.trim() ?? new Date().toISOString(),
      } satisfies ImportedMessage;
    });

export const importConversationFile = async (filePath: string): Promise<ImportedConversation> => {
  const fileStat = await stat(filePath);
  if (!fileStat.isFile() || fileStat.size > MAX_IMPORT_BYTES) {
    throw new Error('文件不存在或超过10 MB');
  }

  const content = await readFile(filePath, 'utf8');
  const extension = path.extname(filePath).toLowerCase();
  const messages = extension === '.json' ? fromJson(JSON.parse(content) as unknown) : fromText(content);
  if (messages.length === 0) {
    throw new Error('没有识别到可用的文字消息');
  }

  return {
    title: path.basename(filePath, extension),
    sourceFile: path.basename(filePath),
    messages,
  };
};
