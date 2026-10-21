import { describe, expect, it } from 'vitest';
import { wechatCardText } from './wechat-card-text';
import { normalizeNativeMessages } from './native-normalize';

describe('display-only WeChat cards', () => {
  it('preserves location labels and validates coordinates', () => {
    expect(wechatCardText(48, '<msg><location x="30.2" y="120.1" label="杭州市" poiname="公司" /></msg>'))
      .toBe('[位置]\n公司\n杭州市\n纬度 30.2，经度 120.1');
    expect(wechatCardText(48, '<location x="NaN" y="9999" label="地址" />')).toBe('[位置]\n地址');
  });
  it('shows file name and size without treating the XML as executable markup', () => {
    expect(wechatCardText(49, '<appmsg><title><![CDATA[合同.pdf]]></title><type>6</type><appattach><totallen>2048</totallen></appattach></appmsg>'))
      .toBe('[文件]\n合同.pdf\n大小：2,048 字节');
    expect(wechatCardText(49, '<!DOCTYPE msg><appmsg><title>bad</title></appmsg>')).toBeUndefined();
  });
  it('shows safe share URLs and never displays unsafe URL schemes', () => {
    expect(wechatCardText(49, '<appmsg><type>5</type><title>介绍</title><des>业务资料</des><url>https://example.com/?a=1&amp;b=2</url></appmsg>'))
      .toContain('https://example.com/?a=1&b=2');
    expect(wechatCardText(49, '<appmsg><type>5</type><title>介绍</title><url>javascript:alert(1)</url></appmsg>')).not.toContain('javascript');
  });
  it('keeps cards as display-only non-text and recognizes alternate sticker type fields', () => {
    const context = { accountKey: 'account', contactKey: 'contact', username: 'peer' };
    const rows = normalizeNativeMessages([
      { id: '1', type: 48, is_send: 0, create_time: 1788067200, content: '<location label="杭州" />' },
      { id: '2', msgType: 47, is_send: 0, create_time: 1788067201 },
    ], context);
    expect(rows[0]).toMatchObject({ messageType: 'other', text: '[位置]\n杭州' });
    expect(rows[1]).toMatchObject({ mediaKind: 'sticker' });
  });
});
