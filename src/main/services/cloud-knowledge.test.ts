import { describe, it, expect, vi } from 'vitest';
import { CloudKnowledge, CLOUD_KNOWLEDGE_URL } from './cloud-knowledge';
const version = 'a'.repeat(64);
const hit = { id: 'kb:one', title: '收费规则', text: '拍中之后支付尾款', sourcePath: 'release.md', score: 1 };
const response = (body: object, status = 200) => new Response(JSON.stringify(body), { status });
describe('company cloud knowledge', () => {
  it('uses fixed endpoint and current account; validates citations before use', async () => {
    expect(CLOUD_KNOWLEDGE_URL).toBe('https://knowledge.example.com');
    const fetcher = vi.fn<typeof fetch>(async (url) => response(String(url).endsWith('/search') ? { version, hits: [hit] } : { version, documents: 6, chunks: 6 }));
    const cloud = new CloudKnowledge(() => 'synthetic-token', fetcher);
    const hits = await cloud.search('尾款');
    expect(hits[0].text).toBe(hit.text);
    await cloud.validate(hits);
    expect(cloud.status()).toMatchObject({ source: 'cloud', state: 'ready', documents: 6, folderPath: 'https://knowledge.example.com' });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      'https://knowledge.example.com/v1/knowledge/status',
      'https://knowledge.example.com/v1/knowledge/search',
      'https://knowledge.example.com/v1/knowledge/status',
    ]);
    expect(fetcher.mock.calls.every(([, options]) => options?.redirect === 'error' && new Headers(options.headers).get('Authorization') === 'Bearer synthetic-token')).toBe(true);
    expect(fetcher.mock.calls[1][1]?.body).toBe(JSON.stringify({ query: '尾款', limit: 6 }));
  });
  it('does not request knowledge without an authenticated company account', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const cloud = new CloudKnowledge(() => null, fetcher);
    await expect(cloud.search('服务费')).rejects.toThrow('请先登录公司 CRM');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects old citations after version change or revocation', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response({ version, documents: 6, chunks: 6 }))
      .mockResolvedValueOnce(response({ version, hits: [hit] }))
      .mockResolvedValueOnce(response({ version: 'b'.repeat(64), documents: 6, chunks: 6 }))
      .mockResolvedValueOnce(response({}, 401));
    const cloud = new CloudKnowledge(() => 'token', fetcher);
    const hits = await cloud.search('尾款');
    await expect(cloud.validate(hits)).rejects.toThrow('引用已失效');
    await expect(cloud.search('尾款')).rejects.toThrow('身份验证失败');
    expect(cloud.status().documents).toBe(0);
  });
  it('rejects in-flight data after account change without exposing server errors', async () => {
    let token: string | null = 'token';
    const cloud = new CloudKnowledge(() => token, async () => { token = null; return response({ version, documents: 6, chunks: 6 }); });
    await expect(cloud.refresh()).rejects.toThrow('登录账号已改变');
    const broken = new CloudKnowledge(() => 'token', async () => { throw new Error('secret'); });
    await expect(broken.refresh()).rejects.toThrow('连接失败');
    expect(JSON.stringify(broken.status())).not.toContain('secret');
  });
});
