import type { ConversationExportFormat, ConversationExportRequest } from '../shared/export-contracts';
import type { FeatureResult } from '../shared/feature-bridge-contracts';
import type { AiProvider, AiSettings, CrmSettings } from '../shared/integration-contracts';

export class FeatureActionCancelled extends Error {}

export function featureValue<T>(result: FeatureResult<T>): T {
  if (result.ok) return result.value;
  if (result.cancelled) throw new FeatureActionCancelled('已取消');
  throw new Error(result.error);
}

export const providerDefaults: Record<AiProvider, { label: string; baseUrl: string }> = {
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
  deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com' },
  compatible: { label: '兼容 OpenAI 的服务', baseUrl: '' },
  ollama: { label: '本机 Ollama', baseUrl: 'http://127.0.0.1:11434/v1' },
};

export function editableCrmSettings(value: CrmSettings): CrmSettings {
  return { baseUrl: value.baseUrl, username: value.username, rememberSession: value.rememberSession, allowInsecureHttp: value.allowInsecureHttp };
}

export function editableAiSettings(value: AiSettings): AiSettings {
  return { provider: value.provider, baseUrl: value.baseUrl, model: value.model, rememberKey: value.rememberKey, allowRemote: value.allowRemote };
}

export function buildExportRequest(keys: string[], format: ConversationExportFormat = 'html'): ConversationExportRequest {
  const contactKeys = [...new Set(keys)];
  if (!contactKeys.length) throw new Error('请先选择要导出的微信会话。');
  if (contactKeys.length > 5) throw new Error('每次最多选择 5 个会话。');
  if (format !== 'html' && contactKeys.length > 1) throw new Error('该文件格式每次只能导出 1 个会话；多个会话请使用 HTML。');
  if (format !== 'html') {
    return {
      contactKeys, format, includeCrm: true, includeAvatars: false,
      media: 'none', includeVoiceTranscripts: true, missingMedia: 'placeholder', zip: false, mergePrevious: false,
    };
  }
  return {
    contactKeys, format, includeCrm: true, includeAvatars: true,
    media: 'available', includeVoiceTranscripts: true, missingMedia: 'placeholder', zip: true, mergePrevious: false,
  };
}

export function fieldText(value: unknown, ...names: string[]): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const record = value as Record<string, unknown>;
  for (const name of names) {
    const field = record[name];
    if (typeof field === 'string' && field.trim()) return field.trim();
    if (typeof field === 'number' && Number.isFinite(field)) return String(field);
  }
  return '';
}

export function crmProfileRows(customer: Record<string, unknown>): Array<[string, string]> {
  const fields: Array<[string, string[]]> = [
    ['姓名', ['name']], ['电话', ['phone']], ['客户等级', ['level']], ['预算', ['budget']],
    ['购房区域', ['area', 'region']], ['客户位置', ['location']], ['关联房源区域', ['targetHouseDistrict']], ['购房用途', ['customerType', 'customer_type']],
    ['选房需求', ['houseRequirement', 'house_requirement']], ['看中标的', ['targetProperty', 'target_property']],
    ['负责人', ['ownerName', 'owner']], ['客户来源', ['source']], ['首次沟通', ['firstContact', 'first_contact']],
    ['获客时间', ['acquiredAt', 'acquired_at']], ['下次跟进', ['nextFollowupAt', 'next_followup_at']],
    ['到访时间', ['visitAt', 'visit_at']], ['签约时间', ['dealSignedAt', 'deal_signed_at']],
    ['付费金额', ['dealAmount', 'deal_amount']], ['签约点数', ['dealPoints', 'deal_points']],
    ['贷款资质', ['loanStatus', 'loan_status']], ['购房方式', ['loanMethod', 'loan_method']],
    ['贷款审批', ['loanApproval', 'loan_approval']], ['贷款备注', ['loanRemark', 'loan_remark']],
    ['参拍情况', ['auctionStatus', 'auction_status']], ['竞拍目标', ['auctionTarget', 'auction_target']],
    ['参拍次数', ['auctionCount', 'auction_count']], ['客户标签', ['tags']],
    ['创建时间', ['createdAt', 'created_at']], ['更新时间', ['updatedAt', 'updated_at']],
  ];
  return fields.map(([label, names]): [string, string] => [label, fieldText(customer, ...names)]).filter(([, value]) => Boolean(value));
}

export function crmRecordParts(record: unknown, kind: 'followup' | 'call') {
  const direction = fieldText(record, 'direction');
  const connected = fieldText(record, 'connected');
  const seconds = fieldText(record, 'durationSec', 'duration_sec', 'durationSeconds');
  const duration = seconds && Number.isFinite(Number(seconds)) && Number(seconds) >= 0 ? `通话 ${Number(seconds)} 秒` : '';
  const callDetail = [direction === 'in' ? '呼入' : direction === 'out' ? '呼出' : direction,
    connected === '1' ? '已接通' : connected === '0' ? '未接通' : fieldText(record, 'result', 'status'), duration];
  return {
    id: fieldText(record, 'id'),
    stamp: fieldText(record, 'followupAt', 'calledAt', 'startedAt', 'followup_at', 'started_at', 'start_time', 'called_at', 'createdAt', 'created_at'),
    author: fieldText(record, 'userName', 'creatorName', 'creator_name', 'user_name', 'operator_name', 'owner', 'author'),
    text: fieldText(record, 'content', 'notes', 'summary', 'note'),
    transcript: fieldText(record, 'transcript', 'transcription', 'transcript_text'),
    detail: (kind === 'call' ? callDetail : [fieldText(record, 'method'), fieldText(record, 'result', 'status')]).filter(Boolean).join(' · '),
  };
}

export function displayTime(value?: string | null): string {
  if (!value) return '尚无记录';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false });
}
