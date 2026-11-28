import { describe, it, expect } from 'vitest';
import { escalationChatLink, escalationNotice } from './trigger-escalation.js';

const AT = '2026-10-09T08:00:00.000Z';

describe('escalationNotice', () => {
	it('says delivered without a warning', () => {
		expect(escalationNotice({ last_escalation_at: AT, last_escalation_outcome: 'delivered' }))
			.toEqual({ key: 'triggers.escalation_delivered', warn: false, at: AT });
	});

	it('warns when nobody was reached, and names a missing channel apart from a failed one', () => {
		expect(escalationNotice({ last_escalation_at: AT, last_escalation_outcome: 'not_delivered' }))
			.toEqual({ key: 'triggers.escalation_not_delivered', warn: true, at: AT });
		expect(escalationNotice({ last_escalation_at: AT, last_escalation_outcome: 'no_channel' }))
			.toEqual({ key: 'triggers.escalation_no_channel', warn: true, at: AT });
	});

	it('warns while an escalation has started and no channel has answered', () => {
		expect(escalationNotice({ last_escalation_at: AT, last_escalation_outcome: 'unconfirmed' }))
			.toEqual({ key: 'triggers.escalation_unconfirmed', warn: true, at: AT });
	});

	it('says nothing for a trigger that never escalated', () => {
		expect(escalationNotice({})).toBeNull();
		expect(escalationNotice({ last_escalation_at: null, last_escalation_outcome: null })).toBeNull();
	});

	it('says nothing for a value the engine does not write, rather than guessing', () => {
		expect(escalationNotice({ last_escalation_at: AT, last_escalation_outcome: 'maybe' })).toBeNull();
		expect(escalationNotice({ last_escalation_at: AT })).toBeNull();
		expect(escalationNotice({ last_escalation_outcome: 'delivered' })).toBeNull();
		// A record without a usable start time is not a record: no date to show beside it.
		expect(escalationNotice({ last_escalation_at: null, last_escalation_outcome: 'delivered' })).toBeNull();
		expect(escalationNotice({ last_escalation_at: '', last_escalation_outcome: 'delivered' })).toBeNull();
	});
});

describe('escalationNotice by why nobody was reached', () => {
	it('names a missing setup and a failed send apart, and falls back for a case it does not know', () => {
		const notDelivered = (c?: string) => escalationNotice({ last_escalation_at: AT, last_escalation_outcome: 'not_delivered', last_escalation_case: c });
		expect(notDelivered('no_subscription')).toEqual({ key: 'triggers.escalation_not_delivered_no_subscription', warn: true, at: AT });
		expect(notDelivered('send_failed')).toEqual({ key: 'triggers.escalation_not_delivered_send_failed', warn: true, at: AT });
		expect(notDelivered()).toEqual({ key: 'triggers.escalation_not_delivered', warn: true, at: AT });
		expect(notDelivered('maybe')).toEqual({ key: 'triggers.escalation_not_delivered', warn: true, at: AT });
	});

	it('reads a case only beside not_delivered', () => {
		expect(escalationNotice({ last_escalation_at: AT, last_escalation_outcome: 'delivered', last_escalation_case: 'send_failed' })?.key).toBe('triggers.escalation_delivered');
	});
});

describe('escalationChatLink', () => {
	const chat = (kind: string, threadId = 'th 1/x') => ({ threadId, kind });

	it('links a question and an alert to their chat, the id encoded, with its own words', () => {
		expect(escalationChatLink({ last_escalation_at: AT, last_escalation_outcome: 'not_delivered', last_escalation_chat: chat('question') }))
			.toEqual({ href: '/app?thread=th%201%2Fx', key: 'triggers.escalation_chat_question' });
		expect(escalationChatLink({ last_escalation_at: AT, last_escalation_outcome: 'not_delivered', last_escalation_chat: chat('alert') }))
			.toEqual({ href: '/app?thread=th%201%2Fx', key: 'triggers.escalation_chat_alert' });
	});

	it('links under every notice, a delivered one and one still unconfirmed included', () => {
		for (const outcome of ['delivered', 'not_delivered', 'no_channel', 'unconfirmed']) {
			expect(escalationChatLink({ last_escalation_at: AT, last_escalation_outcome: outcome, last_escalation_chat: chat('question') })?.key, outcome).toBe('triggers.escalation_chat_question');
		}
	});

	it('links nothing without a notice, without a chat, or for a kind or id it does not know', () => {
		expect(escalationChatLink({ last_escalation_chat: chat('question') })).toBeNull();
		expect(escalationChatLink({ last_escalation_at: AT, last_escalation_outcome: 'maybe', last_escalation_chat: chat('question') })).toBeNull();
		expect(escalationChatLink({ last_escalation_at: AT, last_escalation_outcome: 'delivered' })).toBeNull();
		expect(escalationChatLink({ last_escalation_at: AT, last_escalation_outcome: 'delivered', last_escalation_chat: chat('note') })).toBeNull();
		expect(escalationChatLink({ last_escalation_at: AT, last_escalation_outcome: 'delivered', last_escalation_chat: chat('question', '') })).toBeNull();
		expect(escalationChatLink({ last_escalation_at: AT, last_escalation_outcome: 'delivered', last_escalation_chat: { threadId: 7, kind: 'question' } })).toBeNull();
	});
});

describe('escalationNotice by what the escalation was', () => {
	it('names a sent or unconfirmed question a question, and an alert, or one without a kind, an alert', () => {
		const n = (outcome: string, kind?: string) => escalationNotice({ last_escalation_at: AT, last_escalation_outcome: outcome, last_escalation_kind: kind })?.key;
		expect([n('delivered', 'question'), n('unconfirmed', 'question')]).toEqual(['triggers.escalation_delivered_question', 'triggers.escalation_unconfirmed_question']);
		expect([n('delivered', 'alert'), n('unconfirmed', 'alert')]).toEqual(['triggers.escalation_delivered', 'triggers.escalation_unconfirmed']);
		expect([n('delivered'), n('unconfirmed'), n('delivered', 'note')]).toEqual(['triggers.escalation_delivered', 'triggers.escalation_unconfirmed', 'triggers.escalation_delivered']);
		// Why nobody was reached does not depend on it.
		expect(escalationNotice({ last_escalation_at: AT, last_escalation_outcome: 'not_delivered', last_escalation_case: 'send_failed', last_escalation_kind: 'question' })?.key).toBe('triggers.escalation_not_delivered_send_failed');
	});
});
