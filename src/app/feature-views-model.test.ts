import { describe, expect, it } from 'vitest';
import { buildExportRequest, crmProfileRows, crmRecordParts, displayTime, FeatureActionCancelled, featureValue, fieldText, providerDefaults } from './feature-views-model';

describe('feature forms', () => {
  it('unwraps success and distinguishes a cancelled chooser from an error', () => {
    expect(featureValue({ ok: true, value: 0 })).toBe(0);
    expect(() => featureValue({ ok: false, cancelled: true, error: 'cancel' })).toThrow(FeatureActionCancelled);
    expect(() => featureValue({ ok: false, error: 'no permission' })).toThrow('no permission');
  });

  it('does not fabricate model IDs in provider presets', () => {
    expect(providerDefaults.ollama.baseUrl).toBe('http://127.0.0.1:11434/v1');
    expect(Object.values(providerDefaults).some((preset) => 'model' in preset)).toBe(false);
  });

  it('builds one complete archive preset without date or message-type filters', () => {
    const result = buildExportRequest(['contact-a']);
    expect(result.from).toBeUndefined();
    expect(result.to).toBeUndefined();
    expect(result.messageTypes).toBeUndefined();
    expect(result).toMatchObject({ format: 'html', includeCrm: true, includeAvatars: true, media: 'available',
      includeVoiceTranscripts: true, missingMedia: 'placeholder', zip: true, mergePrevious: false });
  });

  it.each(['markdown', 'csv', 'json', 'txt'] as const)('builds a complete %s text/data export without unsupported media options', (format) => {
    const result = buildExportRequest(['contact-a'], format);
    expect(result.from).toBeUndefined();
    expect(result.to).toBeUndefined();
    expect(result.messageTypes).toBeUndefined();
    expect(result).toMatchObject({ format, includeCrm: true, includeAvatars: false, media: 'none',
      includeVoiceTranscripts: true, missingMedia: 'placeholder', zip: false, mergePrevious: false });
  });

  it('requires HTML when more than one conversation is selected', () => {
    expect(() => buildExportRequest(['one', 'two'], 'csv')).toThrow('每次只能导出 1 个会话');
  });

  it('deduplicates selected conversations before export', () => {
    expect(buildExportRequest(['one', 'one']).contactKeys).toEqual(['one']);
  });

  it('permits five chats and rejects six', () => {
    expect(buildExportRequest(['1', '2', '3', '4', '5']).contactKeys).toHaveLength(5);
    expect(() => buildExportRequest(['1', '2', '3', '4', '5', '6'])).toThrow('最多选择 5');
  });

  it('rejects an empty selection', () => {
    expect(() => buildExportRequest([])).toThrow('选择');
  });

  it('renders only known CRM fields, excluding arbitrary credentials and nested objects', () => {
    const result = crmProfileRows({ name: '测试客户', phone: '000', budget: '150万', customerType: '自住', targetProperty: '上城区住宅', source: '视频号', loanRemark: '待核实征信', idCard: 'private-id', password: 'secret', api_key: 'secret', notes: { malformed: true }, ownerName: '测试负责人' });
    expect(result).toEqual([['姓名', '测试客户'], ['电话', '000'], ['预算', '150万'], ['购房用途', '自住'], ['看中标的', '上城区住宅'], ['负责人', '测试负责人'], ['客户来源', '视频号'], ['贷款备注', '待核实征信']]);
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(JSON.stringify(result)).not.toContain('private-id');
  });

  it('keeps purchase area, customer location and linked-house district as separate CRM facts', () => {
    expect(crmProfileRows({ area: '西湖区', location: '现住拱墅区', targetHouseDistrict: '上城区' })).toEqual([
      ['购房区域', '西湖区'], ['客户位置', '现住拱墅区'], ['关联房源区域', '上城区'],
    ]);
  });

  it('accepts valid zero data and legacy field names but never object stringification', () => {
    expect(fieldText({ old: '', next: 0 }, 'old', 'next')).toBe('0');
    expect(fieldText({ next: {} }, 'next')).toBe('');
    expect(fieldText(null, 'name')).toBe('');
    expect(fieldText(['private'], '0')).toBe('');
  });

  it('does not invent times for missing or invalid source timestamps', () => {
    expect(displayTime(null)).toBe('尚无记录');
    expect(displayTime('未记录时间')).toBe('未记录时间');
  });

  it('reads the CRM mappers camelCase followup fields', () => {
    expect(crmRecordParts({ id: 1, followupAt: '2026-08-31 10:00:00', content: '合成测试记录', method: '微信', result: '待跟进' }, 'followup'))
      .toMatchObject({ stamp: '2026-08-31 10:00:00', text: '合成测试记录', detail: '微信 · 待跟进' });
  });

  it('shows actual CRM call time, user, result and duration without guessing missing values', () => {
    expect(crmRecordParts({ id: 2, calledAt: '2026-08-31 11:00:00', userName: '测试账号', direction: 'out', connected: 0, durationSec: 0, transcript: '合成测试' }, 'call'))
      .toMatchObject({ stamp: '2026-08-31 11:00:00', author: '测试账号', detail: '呼出 · 未接通 · 通话 0 秒', transcript: '合成测试' });
    expect(crmRecordParts({}, 'call').detail).toBe('');
  });
});
