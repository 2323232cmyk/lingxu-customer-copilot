import { request } from 'node:https';
import { isIP } from 'node:net';
import { CLOUD_KNOWLEDGE_URL } from './cloud-knowledge';

/** Domain-only DNS fallback for VPN Fake-IP failures. Never changes system DNS or disables TLS. */
export function cloudTransport(primary: typeof fetch, dnsFetch: typeof fetch = fetch): typeof fetch {
  let resolved: { address: string; until: number } | undefined;
  return async (input, init) => {
    const url = new URL(String(input));
    if (url.origin !== CLOUD_KNOWLEDGE_URL || !/^\/v1\/knowledge\/(status|search)$/.test(url.pathname) || url.search) throw new Error('云端知识地址无效');
    if (!resolved || resolved.until <= Date.now()) {
      try { return await primary(input, { ...init, signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(3500)]) }); }
      catch {
        if (init?.signal?.aborted) throw new Error('云端知识请求已超时');
        const response = await dnsFetch(`https://dns.google/resolve?name=${url.hostname}&type=AAAA`, { redirect: 'error', signal: AbortSignal.timeout(7000) });
        if (!response.ok) throw new Error('云端知识域名解析失败');
        const reader = response.body?.getReader();
        if (!reader) throw new Error('云端知识域名响应无效');
        const chunks: Uint8Array[] = []; let bytes = 0;
        try {
          for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.length;
            if (bytes > 8192) throw new Error('云端知识域名响应无效'); chunks.push(next.value); }
        } finally { await reader.cancel().catch(() => undefined); }
        const text = Buffer.concat(chunks).toString('utf8');
        const value = JSON.parse(text);
        const answer = value.Status === 0 && Array.isArray(value.Answer) ? value.Answer.find((row: { type: number; data: string }) => row.type === 28 && typeof row.data === 'string' && isIP(row.data) === 6 && /^[23][0-9a-f]{3}:/i.test(row.data)) : null;
        if (!answer) throw new Error('云端知识未提供可用地址');
        resolved = { address: answer.data, until: Date.now() + 60000 };
      }
    }
    const address = resolved.address;
    return new Promise<Response>((resolve, reject) => {
      const headers = Object.fromEntries(new Headers(init?.headers).entries());
      const req = request({ hostname: address, servername: url.hostname, port: 443, path: url.pathname,
        method: init?.method ?? 'GET', headers: { ...headers, Host: url.hostname }, signal: init?.signal ?? undefined }, response => {
        const parts: Buffer[] = []; let size = 0;
        response.on('data', (part: Buffer) => { size += part.length; if (size > 128 * 1024) req.destroy(new Error('云端知识响应过大')); else parts.push(part); });
        response.on('error', reject);
        response.on('end', () => resolve(new Response(Buffer.concat(parts), { status: response.statusCode ?? 502, headers: { 'Content-Type': 'application/json' } })));
      });
      req.setTimeout(10000, () => req.destroy(new Error('云端知识请求超时')));
      req.on('error', error => { resolved = undefined; reject(error); });
      if (typeof init?.body === 'string') req.write(init.body);
      req.end();
    });
  };
}
