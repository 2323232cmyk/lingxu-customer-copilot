import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { importConversationFile } from './conversation-import';

const temporaryDirectories: string[] = [];

async function fixtureFile(name: string, content: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'conversation-import-'));
  temporaryDirectories.push(directory);
  const filePath = join(directory, name);
  await writeFile(filePath, content, 'utf8');
  return filePath;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true,
  })));
});

describe('importConversationFile', () => {
  it('normalizes a JSON message export', async () => {
    const filePath = await fixtureFile('聊天.json', JSON.stringify({
      messages: [
        { id: 1, sender: '客户', content: '你好', timestamp: '2026-08-30 10:00' },
        { id: 2, sender: '我', text: '您好', timestamp: '2026-08-30 10:01' },
      ],
    }));

    const conversation = await importConversationFile(filePath);

    expect(conversation.messages).toHaveLength(2);
    expect(conversation.messages[0].direction).toBe('incoming');
    expect(conversation.messages[1].direction).toBe('outgoing');
  });

  it('parses a plain text transcript', async () => {
    const filePath = await fixtureFile(
      '聊天.txt',
      '[2026-08-30 10:00] 客户：周末方便\n[2026-08-30 10:01] 我：好的',
    );

    const conversation = await importConversationFile(filePath);

    expect(conversation.messages.map((message) => message.text)).toEqual(['周末方便', '好的']);
  });
});
