import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AiSettings, CrmSettings, IntegrationSettingsPublic, IntegrationSettingsUpdate, KnowledgeIndexStatus } from '../../shared/integration-contracts';

export interface SecretStorage {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

const CRM_DEFAULTS: CrmSettings = { baseUrl: '', username: '', rememberSession: false, allowInsecureHttp: false };
const AI_DEFAULTS: AiSettings = { provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: '', rememberKey: false, allowRemote: false };
const PROVIDERS = new Set(['openai', 'deepseek', 'compatible', 'ollama']);

export function isLocalEndpoint(value: string): boolean {
  try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(value).hostname); }
  catch { return false; }
}

export function validateEndpoint(value: string, allowInsecureHttp = false): string {
  if (value.length > 2048) throw new Error('服务地址过长');
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error('请输入完整的服务地址'); }
  if (url.username || url.password || url.search || url.hash) throw new Error('服务地址不能包含账号、密码、查询参数或片段');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (isLocalEndpoint(value) || allowInsecureHttp))) {
    throw new Error('服务必须使用 HTTPS，本机地址除外；HTTP CRM 需要先明确允许不安全连接');
  }
  return url.toString().replace(/\/+$/, '');
}

function stringValue(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length > maxLength || [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new Error(`${label}格式不正确`);
  return value.trim();
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label}格式不正确`);
  return value;
}

export class IntegrationSettingsStore {
  private crm: CrmSettings = { ...CRM_DEFAULTS };
  private ai: AiSettings = { ...AI_DEFAULTS };
  private crmToken: string | null = null;
  private apiKey: string | null = null;
  private deviceId: string = randomUUID();
  private knowledgePath = '';
  private notice?: string;

  constructor(private readonly filePath: string, private readonly secretStorage: SecretStorage) {
    if (!existsSync(filePath)) return;
    try {
      if (statSync(filePath).size > 64 * 1024) throw new Error('配置文件过大');
      const saved = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
      if (saved.version !== 1) throw new Error('不支持的配置版本');
      const savedCrm = saved.crm as CrmSettings | undefined;
      const savedAi = saved.ai as AiSettings | undefined;
      if (savedCrm) this.crm = this.validateCrm(savedCrm);
      if (savedAi) this.ai = this.validateAi(savedAi);
      if (typeof saved.deviceId === 'string' && /^[a-zA-Z0-9._:-]{8,128}$/.test(saved.deviceId)) this.deviceId = saved.deviceId;
      if (typeof saved.knowledgePath === 'string') this.knowledgePath = stringValue(saved.knowledgePath, '知识库目录', 4096);
      if (this.crm.rememberSession) this.crmToken = this.decrypt(saved.crmToken);
      if (this.ai.rememberKey) this.apiKey = this.decrypt(saved.apiKey);
    } catch {
      this.crm = { ...CRM_DEFAULTS };
      this.ai = { ...AI_DEFAULTS };
      this.crmToken = null;
      this.apiKey = null;
      this.notice = '已有连接配置无法读取，请重新配置；未自动覆盖原文件';
    }
  }

  getCrmSettings(): CrmSettings { return { ...this.crm }; }
  getAiSettings(): AiSettings { return { ...this.ai }; }
  getCrmToken(): string | null { return this.crmToken; }
  getApiKey(): string | null { return this.apiKey; }
  getDeviceId(): string { return this.deviceId; }
  getKnowledgePath(): string { return this.knowledgePath; }

  getPublic(knowledge: KnowledgeIndexStatus): IntegrationSettingsPublic {
    return {
      crm: { ...this.crm, hasSession: Boolean(this.crmToken) },
      ai: { ...this.ai, hasApiKey: Boolean(this.apiKey), isLocal: isLocalEndpoint(this.ai.baseUrl) },
      knowledge: { ...knowledge, warnings: [...knowledge.warnings], supportedExtensions: [...knowledge.supportedExtensions] },
      secureStorageAvailable: this.secretStorage.isEncryptionAvailable(),
      ...(this.notice ? { notice: this.notice } : {}),
    };
  }

  update(patch: IntegrationSettingsUpdate): void {
    if (!patch || typeof patch !== 'object') throw new Error('配置格式不正确');
    const nextCrm = this.validateCrm({ ...this.crm, ...patch.crm });
    const nextAi = this.validateAi({ ...this.ai, ...patch.ai });
    let nextApiKey = this.apiKey;
    if (nextAi.baseUrl !== this.ai.baseUrl || nextAi.provider !== this.ai.provider) nextApiKey = null;
    if (patch.ai?.apiKey !== undefined) nextApiKey = stringValue(patch.ai.apiKey, 'API 密钥', 4096) || null;
    if (patch.ai?.clearApiKey) nextApiKey = null;
    if (nextCrm.baseUrl !== this.crm.baseUrl || nextCrm.username !== this.crm.username) this.crmToken = null;
    this.crm = nextCrm;
    this.ai = nextAi;
    this.apiKey = nextApiKey;
    this.persist();
  }

  setCrmToken(token: string | null): void {
    this.crmToken = token === null ? null : stringValue(token, '登录状态', 8192);
    this.persist();
  }

  setKnowledgePath(folderPath: string): void {
    this.knowledgePath = stringValue(folderPath, '知识库目录', 4096);
    this.persist();
  }

  private validateCrm(value: CrmSettings): CrmSettings {
    const baseUrl = stringValue(value.baseUrl, 'CRM 地址', 2048);
    const allowInsecureHttp = booleanValue(value.allowInsecureHttp, 'HTTP 连接选项');
    return {
      baseUrl: baseUrl ? validateEndpoint(baseUrl, allowInsecureHttp) : '',
      username: stringValue(value.username, '用户名', 254),
      rememberSession: booleanValue(value.rememberSession, '记住登录选项'),
      allowInsecureHttp,
    };
  }

  private validateAi(value: AiSettings): AiSettings {
    if (!PROVIDERS.has(value.provider)) throw new Error('不支持的模型服务类型');
    const baseUrl = stringValue(value.baseUrl, '模型地址', 2048);
    return {
      provider: value.provider,
      baseUrl: baseUrl ? validateEndpoint(baseUrl) : '',
      model: stringValue(value.model, '模型名称', 160),
      rememberKey: booleanValue(value.rememberKey, '记住密钥选项'),
      allowRemote: booleanValue(value.allowRemote, '远程发送选项'),
    };
  }

  private decrypt(value: unknown): string | null {
    if (typeof value !== 'string' || !value) return null;
    try {
      if (!this.secretStorage.isEncryptionAvailable()) throw new Error('加密不可用');
      return this.secretStorage.decryptString(Buffer.from(value, 'base64'));
    } catch {
      this.notice = '已保存的凭据无法解密，请重新登录或填写密钥';
      return null;
    }
  }

  private persist(): void {
    const canEncrypt = this.secretStorage.isEncryptionAvailable();
    const encrypt = (value: string | null, remember: boolean): string | null => value && remember && canEncrypt
      ? this.secretStorage.encryptString(value).toString('base64') : null;
    const serialized = JSON.stringify({
      version: 1,
      crm: this.crm,
      ai: this.ai,
      deviceId: this.deviceId,
      knowledgePath: this.knowledgePath,
      crmToken: encrypt(this.crmToken, this.crm.rememberSession),
      apiKey: encrypt(this.apiKey, this.ai.rememberKey),
    }, null, 2);
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    writeFileSync(temporaryPath, serialized, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporaryPath, this.filePath);
    this.notice = !canEncrypt && ((this.crm.rememberSession && this.crmToken) || (this.ai.rememberKey && this.apiKey))
      ? '系统安全存储不可用，凭据仅保留本次运行，关闭后需重新填写' : undefined;
  }
}
