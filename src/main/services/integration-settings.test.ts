import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { IntegrationSettingsStore, isLocalEndpoint, validateEndpoint, type SecretStorage } from './integration-settings';
import { EMPTY_KNOWLEDGE_STATUS } from './knowledge-library';

const folders: string[] = [];
const fakeStorage: SecretStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (text) => Buffer.from([...text].reverse().join('')),
  decryptString: (bytes) => [...bytes.toString()].reverse().join(''),
};
function setup(storage = fakeStorage) {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'lingxu-config-test-'));
  folders.push(folder);
  const file = path.join(folder, 'integrations.json');
  return { file, store: new IntegrationSettingsStore(file, storage) };
}
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });

describe('IntegrationSettingsStore', () => {
  it('starts private and exposes no secret fields', () => {
    const { store } = setup();
    expect(store.getPublic(EMPTY_KNOWLEDGE_STATUS).ai.allowRemote).toBe(false);
    expect(store.getPublic(EMPTY_KNOWLEDGE_STATUS).crm.hasSession).toBe(false);
    store.update({ ai: { apiKey: 'my-private-api-key' } });
    expect(JSON.stringify(store.getPublic(EMPTY_KNOWLEDGE_STATUS))).not.toContain('my-private-api-key');
  });

  it('persists only encrypted secrets when explicitly remembered', () => {
    const { file, store } = setup();
    store.update({ crm: { rememberSession: true }, ai: { rememberKey: true, apiKey: 'private-key-A' } });
    store.setCrmToken('private-session-A');
    const text = readFileSync(file, 'utf8');
    expect(text).not.toContain('private-key-A');
    expect(text).not.toContain('private-session-A');
    const reload = new IntegrationSettingsStore(file, fakeStorage);
    expect(reload.getApiKey()).toBe('private-key-A');
    expect(reload.getCrmToken()).toBe('private-session-A');
    expect(reload.getDeviceId()).toBe(store.getDeviceId());
  });

  it('does not persist session-only or unavailable encryption secrets', () => {
    const { file, store } = setup({ ...fakeStorage, isEncryptionAvailable: () => false });
    store.update({ ai: { rememberKey: true, apiKey: 'private' }, crm: { rememberSession: true } });
    store.setCrmToken('session');
    expect(store.getApiKey()).toBe('private');
    expect(store.getPublic(EMPTY_KNOWLEDGE_STATUS).notice).toContain('仅保留本次');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ apiKey: null, crmToken: null });
  });

  it('forgets saved credentials when remember is unchecked', () => {
    const { file, store } = setup();
    store.update({ ai: { rememberKey: true, apiKey: 'private' } });
    store.update({ ai: { rememberKey: false } });
    expect(store.getApiKey()).toBe('private');
    expect(new IntegrationSettingsStore(file, fakeStorage).getApiKey()).toBe(null);
  });

  it('drops credentials when the destination changes', () => {
    const { store } = setup();
    store.update({ crm: { baseUrl: 'https://crm.example', username: 'first' }, ai: { apiKey: 'secret' } });
    store.setCrmToken('token');
    store.update({ crm: { baseUrl: 'https://other.example' }, ai: { baseUrl: 'https://gateway.example/v1' } });
    expect(store.getCrmToken()).toBe(null);
    expect(store.getApiKey()).toBe(null);
  });

  it('can replace key and destination in the same explicit save', () => {
    const { store } = setup();
    store.update({ ai: { baseUrl: 'https://gateway.example/v1', apiKey: 'new-key' } });
    expect(store.getApiKey()).toBe('new-key');
    store.update({ ai: { clearApiKey: true } });
    expect(store.getApiKey()).toBe(null);
  });

  it('does not destroy an unreadable settings file', () => {
    const { file } = setup();
    writeFileSync(file, 'not json');
    const store = new IntegrationSettingsStore(file, fakeStorage);
    expect(store.getPublic(EMPTY_KNOWLEDGE_STATUS).notice).toContain('未自动覆盖');
    expect(readFileSync(file, 'utf8')).toBe('not json');
  });

  it('requires explicit insecure CRM acknowledgement but never allows remote HTTP AI', () => {
    const { store } = setup();
    expect(() => store.update({ crm: { baseUrl: 'http://crm.example' } })).toThrow('HTTPS');
    store.update({ crm: { baseUrl: 'http://crm.example', allowInsecureHttp: true } });
    expect(() => store.update({ ai: { baseUrl: 'http://gateway.example' } })).toThrow('HTTPS');
  });
});

describe('endpoint validation', () => {
  it.each(['file:///x', 'https://user:pass@example.com', 'https://example.com?token=secret', 'https://example.com/#x', 'http://example.com'])('rejects unsafe %s', (url) => {
    expect(() => validateEndpoint(url)).toThrow();
  });
  it.each(['http://localhost:11434/v1', 'http://127.0.0.1:1234/v1', 'http://[::1]:3219'])('accepts local %s', (url) => {
    expect(isLocalEndpoint(url)).toBe(true);
    expect(validateEndpoint(url)).toBe(url);
  });
  it('does not classify a lookalike localhost hostname as local', () => {
    expect(isLocalEndpoint('https://localhost.evil.example')).toBe(false);
  });
});
