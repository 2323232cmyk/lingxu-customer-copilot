import { describe, expect, it, vi } from 'vitest';
import { cloudTransport } from './cloud-transport';
const url = 'https://knowledge.example.com/v1/knowledge/status';
describe('cloud-only secure DNS fallback', () => {
  it('never resolves DNS when normal transport succeeds', async () => {
    const primary = vi.fn<typeof fetch>(async () => new Response('{}', { status: 401 }));
    const dns = vi.fn<typeof fetch>();
    expect((await cloudTransport(primary, dns)(url)).status).toBe(401);
    expect(dns).not.toHaveBeenCalled();
  });
  it.each([
    'https://knowledge-legacy.example.org/v1/knowledge/status',
    'https://knowledge-legacy.example.com/v1/knowledge/status',
    'https://knowledge.example.com.untrusted.test/v1/knowledge/status',
    'https://untrusted.test/v1/knowledge/status',
    'http://knowledge.example.com/v1/knowledge/status',
    'https://knowledge.example.com:8443/v1/knowledge/status',
    'https://knowledge.example.com/health',
    'https://knowledge.example.com/v1/knowledge/status?query=private',
  ])('rejects unauthorized address %s before sending any credentials', async (address) => {
    const primary = vi.fn<typeof fetch>();
    const dns = vi.fn<typeof fetch>();
    await expect(cloudTransport(primary, dns)(address, { headers: { Authorization: 'Bearer synthetic-secret' } })).rejects.toThrow('地址无效');
    expect(primary).not.toHaveBeenCalled();
    expect(dns).not.toHaveBeenCalled();
  });
  it('does not send credentials or queries to the DNS provider', async () => {
    const primary = vi.fn<typeof fetch>(async () => { throw new Error('network'); });
    const dns = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ Status: 0, Answer: [] })));
    await expect(cloudTransport(primary, dns)('https://knowledge.example.com/v1/knowledge/search', {
      method: 'POST', headers: { Authorization: 'Bearer synthetic-secret' }, body: JSON.stringify({ query: 'synthetic-private-query' }),
    })).rejects.toThrow('未提供可用地址');
    expect(JSON.stringify(dns.mock.calls)).not.toContain('synthetic-secret');
    expect(JSON.stringify(dns.mock.calls)).not.toContain('synthetic-private-query');
    expect(dns.mock.calls[0][0]).toBe('https://dns.google/resolve?name=knowledge.example.com&type=AAAA');
  });
});
