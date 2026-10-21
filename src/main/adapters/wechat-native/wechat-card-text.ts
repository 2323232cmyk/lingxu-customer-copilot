/** Display-only summaries. Never execute XML, fetch card URLs or infer attachment contents. */
export function wechatCardText(type: number, xml: string): string | undefined {
  if (![48, 49, 42].includes(type) || xml.length > 65536 || /<!DOCTYPE|<!ENTITY|\0/iu.test(xml)) return;
  const decode = (text: string) => text.replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/u, '$1')
    .replace(/&(?:amp|lt|gt|quot|apos);/gu, entity => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" })[entity] || entity)
    .trim().slice(0, 2048);
  const tag = (name: string) => decode(xml.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'iu'))?.[1] ?? '');
  const element = xml.match(new RegExp(`<${type === 48 ? 'location' : 'msg'}\\b([^<>]*)>`, 'iu'))?.[1] ?? '';
  const attr = (name: string) => decode(element.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'iu'))?.slice(1).find(Boolean) ?? '');
  if (type === 48) {
    const label = attr('label'), name = attr('poiname');
    const x = attr('x'), y = attr('y');
    const coordinates = x && y && Number.isFinite(Number(x)) && Number.isFinite(Number(y)) && Math.abs(Number(x)) <= 90 && Math.abs(Number(y)) <= 180 ? `纬度 ${x}，经度 ${y}` : '';
    return [ '[位置]', name, label, coordinates ].filter(Boolean).join('\n');
  }
  if (type === 42) return ['[联系人名片]', attr('nickname')].filter(Boolean).join('\n');
  const title = tag('title'), description = tag('des');
  if (!title && !description) return;
  const appType = tag('type');
  const kind = appType === '6' ? '文件' : ['33', '36'].includes(appType) ? '小程序分享' : appType === '57' ? '引用回复' : '链接与分享';
  const rawUrl = tag('url');
  let url = '';
  try { const parsed = new URL(rawUrl); if (['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password) url = parsed.href; } catch { /* Some cards have no web URL. */ }
  const size = tag('totallen');
  return [`[${kind}]`, title, description, appType === '6' && /^\d{1,15}$/u.test(size) ? `大小：${Number(size).toLocaleString('zh-CN')} 字节` : '', url].filter(Boolean).join('\n');
}
