import { describe, expect, it } from 'vitest';
import type { WechatLiveConversation, WechatLiveMessage } from '../shared/contracts';
import { conversationSignature, crmText, customerWithCrm, messageAvatar } from './conversation-presentation';

const contact: WechatLiveConversation = { contactKey: 'contact', displayName: '客户', kind: 'contact', avatarMediaKey: 'contact-avatar' };
const message: WechatLiveMessage = { id: 'one', contactKey: 'contact', direction: 'incoming', sender: '客户',
  text: '周末方便', messageType: 'text', sentAt: '2026-08-31T10:00:00+08:00', observedAt: '2026-08-31T10:00:01+08:00' };

describe('conversation presentation boundaries', () => {
  it('uses the own avatar for outgoing messages, not the customer photo', () => {
    expect(messageAvatar({ ...message, direction: 'outgoing' }, contact, 'self-avatar')?.mediaKey).toBe('self-avatar');
    expect(messageAvatar({ ...message, direction: 'outgoing' }, contact)?.mediaKey).toBeUndefined();
  });
  it('never passes off a group icon as a sender avatar', () => {
    expect(messageAvatar(message, { ...contact, kind: 'group' })?.mediaKey).toBeUndefined();
    expect(messageAvatar({ ...message, senderAvatarMediaKey: 'member-photo' }, { ...contact, kind: 'group' })?.mediaKey).toBe('member-photo');
  });
  it('uses the contact fallback only in a real contact chat', () => {
    expect(messageAvatar(message, contact)?.mediaKey).toBe('contact-avatar');
    expect(messageAvatar({ ...message, direction: 'system' }, contact)).toBeNull();
  });
  it('invalidates context on edits/new messages but not reread observation timestamps', () => {
    expect(conversationSignature([message])).toBe(conversationSignature([{ ...message, observedAt: '2026-08-31T12:00:00+08:00' }]));
    expect(conversationSignature([message])).not.toBe(conversationSignature([{ ...message, text: '这周不方便' }]));
    expect(conversationSignature([message])).not.toBe(conversationSignature([message, { ...message, id: 'two' }]));
  });
  it('keeps CRM field content literal and skips objects rather than stringifying private fields', () => {
    expect(crmText({ budget: '200–250万' }, 'budget')).toBe('200–250万');
    expect(crmText({ budget: { secret: 'hidden' } }, 'budget')).toBe('');
  });
  it('keeps the CRM purchase area separate from the customer location', () => {
    const context = { customer: { area: '杭州·西湖', location: '杭州·上城', budget: '200–250万' },
      followups: [], calls: [], tasks: [], houseTargets: [], fetchedAt: '', sourceBaseUrl: '',
      availability: { followups: 'available' as const, calls: 'available' as const } };
    expect(customerWithCrm(contact, context).area).toBe('杭州·西湖');
    expect(customerWithCrm(contact, { ...context, customer: { location: '杭州·上城' } }).area).toBe('未知');
  });
  it('does not replace the customer purchase area with a linked house district', () => {
    const context = { customer: { customerType: '改善自住', area: '杭州·西湖', targetHouseDistrict: '杭州·上城' },
      followups: [], calls: [], tasks: [], houseTargets: [], fetchedAt: '', sourceBaseUrl: '',
      availability: { followups: 'available' as const, calls: 'available' as const } };
    expect(customerWithCrm(contact, context)).toMatchObject({ purpose: '改善自住', area: '杭州·西湖' });
  });
});
