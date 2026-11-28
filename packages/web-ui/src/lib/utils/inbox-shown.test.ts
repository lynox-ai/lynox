import { describe, expect, it } from 'vitest';
import { rowHeadline, rowLabel, rowOwnDate, rowSender, shownIsSensitive, shownReplyFraming, type ShownCandidate } from './inbox-shown.js';
import { followUpLine } from './inbox-follow-up.js';

const t = (key: string): string => `«${key}»`;
const tf = (key: string, vars: Record<string, string>): string => `«${key}:${JSON.stringify(vars)}»`;

const notice: ShownCandidate & { classifierVersion: string } = {
	fromAddress: 'mailer-daemon@post.example', fromName: 'Mail Delivery System', subject: 'Undelivered Mail Returned to Sender',
	reasonDe: 'Meldet, dass eine deiner Mails nicht ankam.', mailDate: '2026-11-20T09:00:00.000Z', classifiedAt: '2026-11-20T09:00:01.000Z',
	classifierVersion: 'prefilter',
};
const shown = { fromAddress: 'anna@kunde.example', fromName: 'Anna Kunde', subject: 'Frage zur Offerte', messageId: '<real@x>', mailDate: '2026-11-20T10:00:00.000Z', sensitive: false };

describe('the row of a notice item with a shown mail', () => {
	it('headline, label, sender and date all name the shown mail', () => {
		const item = { ...notice, shown };
		expect({ headline: rowHeadline(item, t), label: rowLabel(item, t), sender: rowSender(item), date: rowOwnDate(item) }).toEqual({
			headline: 'Frage zur Offerte', label: 'Frage zur Offerte',
			sender: { label: 'Anna Kunde', address: 'anna@kunde.example' }, date: '2026-11-20T10:00:00.000Z',
		});
		expect(shownIsSensitive(item)).toBe(false);
	});

	it('a sensitive shown mail: the address without a name, the confidential mark in the subject place', () => {
		const item = { ...notice, shown: { fromAddress: 'bank@bank.example', messageId: '<real@x>', sensitive: true } };
		expect(rowHeadline(item, t)).toBe('«inbox.sensitive_mark»');
		expect(rowLabel(item, t)).toBe('«inbox.sensitive_mark»');
		expect(rowSender(item)).toEqual({ label: 'bank@bank.example', address: 'bank@bank.example' });
		expect(shownIsSensitive(item)).toBe(true);
		// A name that came along anyway is still not shown.
		expect(rowSender({ ...item, shown: { ...item.shown, fromName: 'Hausbank Support' } }).label).toBe('bank@bank.example');
	});

	it('a shown mail without a subject does not fall back to the notice', () => {
		const item = { ...notice, shown: { ...shown, subject: undefined } };
		expect(rowHeadline(item, t)).toBe('(kein Betreff)');
	});

	it('without a shown mail, the row is the item, as before', () => {
		expect(rowHeadline(notice, t)).toBe('Undelivered Mail Returned to Sender');
		expect(rowLabel({ ...notice, subject: ' ' }, t)).toBe('Meldet, dass eine deiner Mails nicht ankam.');
		expect(rowSender(notice)).toEqual({ label: 'Mail Delivery System', address: 'mailer-daemon@post.example' });
		expect(rowOwnDate(notice)).toBe('2026-11-20T09:00:00.000Z');
	});

	it('the follow-up line says nothing for the one mail the row shows, and still counts several', () => {
		const one = { count: 1 };
		expect(followUpLine({ ...notice, shown, followUps: one }, t, tf)).toBeUndefined();
		expect(followUpLine({ ...notice, shown, followUps: { count: 3 } }, t, tf)).toBe('«inbox.follow_up_many:{"count":"3"}»');
		expect(followUpLine({ ...notice, followUps: one }, t, tf)).toBe('«inbox.follow_up_one»');
	});
});

describe('the "Reply in chat" framing of a notice item', () => {
	it('with a shown mail: a fixed text, no value of the shown mail or of the notice', () => {
		const framing = shownReplyFraming({ ...notice, shown }, t)!;
		expect(framing).toBe('«inbox.reply_in_chat_prompt_newest»');
		for (const v of [shown.fromAddress, shown.fromName, shown.subject, shown.messageId, notice.subject, notice.fromAddress]) {
			expect(framing).not.toContain(v);
		}
	});

	it('without a shown mail: none, the framing stays the existing one', () => {
		expect(shownReplyFraming(notice, t)).toBeUndefined();
	});
});
