import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConversationBindings } from './conversation-bindings';

const folders: string[] = [];
const scope = { accountKey: 'account-private-id', contactKey: 'contact-private-id' };
const binding = { customerId: 12, customerName: '已确认客户', confirmedAt: '2026-08-31T10:00:00Z' };
function setup() { const root = mkdtempSync(path.join(os.tmpdir(), 'lingxu-bind-test-')); folders.push(root); const filename = path.join(root, 'bindings.json'); return { filename, store: new ConversationBindings(filename) }; }
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });

describe('explicit local CRM bindings', () => {
  it('persists an explicit link across restart without raw account or conversation ids', () => {
    const { filename, store } = setup();
    store.set(scope, 'crm-server-and-user-1', binding);
    expect(new ConversationBindings(filename).get(scope, 'crm-server-and-user-1')).toEqual(binding);
    const raw = readFileSync(filename, 'utf8');
    expect(raw).not.toContain('account-private-id');
    expect(raw).not.toContain('contact-private-id');
    expect(raw).not.toContain('crm-server-and-user-1');
  });
  it('isolates WeChat account, conversation and CRM account identities', () => {
    const { store } = setup();
    store.set(scope, 'crm-1', binding);
    expect(store.get({ ...scope, accountKey: 'account-2' }, 'crm-1')).toBe(null);
    expect(store.get({ ...scope, contactKey: 'contact-2' }, 'crm-1')).toBe(null);
    expect(store.get(scope, 'crm-2')).toBe(null);
  });
  it('unlinks only the selected scope without deleting unrelated bindings', () => {
    const { store } = setup();
    store.set(scope, 'crm-1', binding);
    store.set({ ...scope, contactKey: 'other' }, 'crm-1', binding);
    store.set(scope, 'crm-1', null);
    expect(store.get(scope, 'crm-1')).toBe(null);
    expect(store.get({ ...scope, contactKey: 'other' }, 'crm-1')).toEqual(binding);
  });
  it('does not silently discard damaged bindings or guess them from a name', () => {
    const { filename } = setup();
    writeFileSync(filename, 'damaged');
    const store = new ConversationBindings(filename);
    expect(() => store.get(scope, 'crm-1')).toThrow('无法读取');
    expect(readFileSync(filename, 'utf8')).toBe('damaged');
    store.set(scope, 'crm-1', binding);
    expect(store.get(scope, 'crm-1')).toEqual(binding);
  });
});
