import type { KnowledgeHit, KnowledgeIndexStatus, AiDraftPreview } from '../../shared/integration-contracts';

export const CLOUD_KNOWLEDGE_URL = 'https://knowledge.example.com';
export class CloudKnowledge {
  private version = '';
  private hits = new Map<string, KnowledgeHit>();
  private state: KnowledgeIndexStatus = this.empty();
  constructor(private readonly identity: () => string | null, private readonly fetcher: typeof fetch = fetch) {}
  private empty(): KnowledgeIndexStatus {
    return { source: 'cloud', state: 'idle', folderPath: CLOUD_KNOWLEDGE_URL, documents: 0, chunks: 0, indexedAt: null, skipped: 0, warnings: [], supportedExtensions: [] };
  }
  status(): KnowledgeIndexStatus { return { ...this.state, warnings: [...this.state.warnings] }; }
  invalidate(): void { this.version = ''; this.hits.clear(); this.state = this.empty(); }
  private async request(route: string, body?: object): Promise<Record<string, unknown>> {
    const token = this.identity();
    try {
      if (!token) throw new Error('请先登录公司 CRM，云端知识库将自动连接，无需另填密钥');
      const response = await this.fetcher(CLOUD_KNOWLEDGE_URL + route, {
        method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(12000),
        headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(response.status === 401 || response.status === 403 ? '云端知识库身份验证失败，请重新登录公司 CRM' : '云端知识库暂不可用，请稍后重试；未改用本地旧知识');
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error('云端知识库返回空响应');
      const parts: Uint8Array[] = []; let size = 0;
      try {
        for (;;) {
          const next = await reader.read(); if (next.done) break;
          size += next.value.length; if (size > 128 * 1024) throw new Error('云端知识库响应超过安全上限');
          parts.push(next.value);
        }
      } finally { await reader.cancel().catch(() => undefined); }
      if (this.identity() !== token) throw new Error('登录账号已改变，请重新检索云端知识');
      const value = JSON.parse(Buffer.concat(parts).toString('utf8'));
      if (!value || typeof value !== 'object' || !/^[a-f0-9]{64}$/.test(value.version)) throw new Error('云端知识库版本无效');
      if (this.version !== value.version) this.hits.clear();
      this.version = value.version;
      return value;
    } catch (error) {
      this.invalidate();
      const message = error instanceof Error && /^(云端知识库|请先登录公司 CRM|登录账号已改变)/u.test(error.message) ? error.message : '云端知识库连接失败，请检查网络后重试；未改用本地旧知识';
      this.state = { ...this.state, state: 'error', warnings: [message] };
      throw new Error(message);
    }
  }
  async refresh(): Promise<KnowledgeIndexStatus> {
    const value = await this.request('/v1/knowledge/status');
    if (![value.documents, value.chunks].every(n => Number.isSafeInteger(n) && Number(n) > 0)) {
      this.invalidate(); throw new Error('云端知识库索引尚未就绪');
    }
    this.state = { ...this.empty(), state: 'ready', documents: Number(value.documents), chunks: Number(value.chunks), indexedAt: new Date().toISOString(), version: this.version };
    return this.status();
  }
  async search(query: string, limit = 6): Promise<KnowledgeHit[]> {
    if (typeof query !== 'string' || query.length > 600 || !Number.isInteger(limit) || limit < 1 || limit > 6) throw new Error('云端检索问题最多 600 字，每次最多 6 条');
    await this.refresh();
    if (!query.trim()) return [];
    const value = await this.request('/v1/knowledge/search', { query, limit });
    if (!Array.isArray(value.hits) || value.hits.length > limit) { this.invalidate(); throw new Error('云端知识检索结果格式无效'); }
    const hits = value.hits.map((hit): KnowledgeHit => {
      if (!hit || typeof hit.id !== 'string' || !hit.id.startsWith('kb:') || hit.id.length > 512
        || typeof hit.title !== 'string' || hit.title.length > 256 || typeof hit.text !== 'string' || hit.text.length > 8000
        || typeof hit.score !== 'number' || !Number.isFinite(hit.score)) { this.invalidate(); throw new Error('云端知识片段格式无效'); }
      return { id: `kb:cloud:${this.version}:${hit.id}`, title: hit.title, text: hit.text, score: hit.score, sourcePath: `云端知识库 · ${hit.title}` };
    });
    if (this.hits.size + hits.length > 120) this.hits.clear();
    for (const hit of hits) this.hits.set(hit.id, hit);
    return hits;
  }
  async validate(sources: AiDraftPreview['sources']): Promise<void> {
    const knowledge = sources.filter(source => source.id.startsWith('kb:'));
    if (!knowledge.length) return;
    await this.refresh(); // Authentication and version are checked again, including after model generation.
    for (const source of knowledge) {
      const hit = this.hits.get(source.id);
      if (!hit || source.title !== hit.title || source.text !== hit.text.slice(0, 1200) || source.sourcePath !== hit.sourcePath) throw new Error('云端知识版本已变更或引用已失效，请重新生成建议');
    }
  }
}
