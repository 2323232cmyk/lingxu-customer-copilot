import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ConversationCrmBinding, WechatFeatureScope } from '../../shared/feature-bridge-contracts';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** Local explicit links only. No nickname matching, chat body, phone or CRM credentials. */
export class ConversationBindings {
  private entries = new Map<string, ConversationCrmBinding>();
  private invalidFile = false;

  constructor(private readonly filename: string) {
    if (!existsSync(filename)) return;
    try {
      if (statSync(filename).size > 2 * 1024 * 1024) throw new Error('Too large');
      const data = JSON.parse(readFileSync(filename, 'utf8')) as { version?: unknown; entries?: unknown };
      if (data.version !== 1 || !Array.isArray(data.entries) || data.entries.length > 5000) throw new Error('Invalid binding file');
      for (const entry of data.entries as unknown[]) {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || !/^[a-f0-9]{64}$/u.test(entry[0])) throw new Error('Invalid binding');
        const value = entry[1] as ConversationCrmBinding;
        if (!value || !Number.isSafeInteger(value.customerId) || value.customerId <= 0 || typeof value.customerName !== 'string' || value.customerName.length > 256 || typeof value.confirmedAt !== 'string' || !Number.isFinite(Date.parse(value.confirmedAt))) throw new Error('Invalid binding');
        this.entries.set(entry[0], { customerId: value.customerId, customerName: value.customerName, confirmedAt: value.confirmedAt });
      }
    } catch { this.entries.clear(); this.invalidFile = true; }
  }

  get(scope: WechatFeatureScope, crmIdentity: string): ConversationCrmBinding | null {
    if (this.invalidFile) throw new Error('本地客户关联文件无法读取，请重新确认并关联客户');
    const value = this.entries.get(this.key(scope, crmIdentity));
    return value ? { ...value } : null;
  }

  set(scope: WechatFeatureScope, crmIdentity: string, value: ConversationCrmBinding | null): void {
    const key = this.key(scope, crmIdentity);
    if (value && !this.entries.has(key) && this.entries.size >= 5000) throw new Error('已达到本地客户关联数量上限');
    const previous = new Map(this.entries);
    if (value) this.entries.set(key, { ...value });
    else this.entries.delete(key);
    try {
      mkdirSync(path.dirname(this.filename), { recursive: true });
      writeFileSync(`${this.filename}.tmp`, JSON.stringify({ version: 1, entries: [...this.entries] }), { encoding: 'utf8', mode: 0o600 });
      renameSync(`${this.filename}.tmp`, this.filename);
      this.invalidFile = false;
    } catch { this.entries = previous; throw new Error('无法保存本地客户关联，请检查本机目录权限'); }
  }

  private key(scope: WechatFeatureScope, crmIdentity: string): string { return hash(JSON.stringify([scope.accountKey, scope.contactKey, crmIdentity])); }
}
