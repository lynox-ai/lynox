import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { APPROVAL_OUTCOME_SENTENCES, APPROVAL_REWRITABLE_OUTCOMES, approvalEntryHref, approvalNoteLines, type ApprovalViewer } from './approvals.js';

/**
 * A chat note about an approved mail that did not go out names the reason the approvals page shows
 * for the same entry, the next step for the same viewer, and leads to the entry.
 *
 * Source is read for the i18n check, not imported: `i18n.svelte.ts` holds the locale in a `$state` rune.
 */
const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const I18N = read('../i18n.svelte.ts');
const CHAT_VIEW = read('./ChatView.svelte');
const CORE_VIEW = read('../../../../../src/core/approval-view.ts');

function entry(key: string): { de: string; en: string } | null {
	const lines = I18N.split('\n').filter((l) => l.trimStart().startsWith(`'${key}':`));
	if (lines.length !== 1) return null;
	const de = /\bde:\s*'((?:[^'\\]|\\.)*)'/.exec(lines[0]!);
	const en = /\ben:\s*'((?:[^'\\]|\\.)*)'/.exec(lines[0]!);
	return de && en ? { de: de[1]!, en: en[1]! } : null;
}

const ID = '0b6f1f9e-3c1a-4d6e-9c2a-6f0e4b1d2a33';
const VIEWERS: Array<ApprovalViewer | null> = ['owner', 'mandate', 'none', null];

describe('the lines of a note about an approved mail', () => {
	it('a failed mail names the page\'s reason and next step, and leads to its entry', () => {
		expect(approvalNoteLines('approval_failed', { id: ID, outcome: 'account_changed' }, 'owner')).toEqual({
			bodyKey: 'approvals.outcome.account_changed',
			nextKey: 'approvals.next.account_changed',
			href: `/app/approvals?entry=${ID}`,
			rewriteId: ID,
		});
	});

	it('a reason without a step of its own gets the general one: write it again in a chat', () => {
		expect(approvalNoteLines('approval_failed', { id: ID, outcome: 'mandate_ended' }, 'owner')?.nextKey).toBe('approvals.next.recreate');
	});

	it('a session that is not the owner\'s is told to ask the owner, as on the page', () => {
		for (const viewer of ['mandate', 'none'] as const) {
			expect(approvalNoteLines('approval_failed', { id: ID, outcome: 'account_changed' }, viewer)?.nextKey).toBe('approvals.next.ask_owner');
			expect(approvalNoteLines('approval_unknown', { id: ID, outcome: 'send_threw' }, viewer)?.nextKey).toBe('approvals.next.ask_owner');
		}
	});

	it('without a known viewer, no next step: it depends on whose session reads it', () => {
		const lines = approvalNoteLines('approval_failed', { id: ID, outcome: 'account_changed' }, null);
		expect(lines?.nextKey).toBeNull();
		expect(lines?.bodyKey).toBe('approvals.outcome.account_changed');
	});

	it('an unclear outcome reads as unclear, with the step to ask the recipient first', () => {
		expect(approvalNoteLines('approval_unknown', { id: ID, outcome: 'send_threw' }, 'owner')).toEqual({
			bodyKey: 'approvals.outcome.send_threw',
			nextKey: 'chat.note.approval_unknown.next',
			href: `/app/approvals?entry=${ID}`,
			rewriteId: null,
		});
	});

	it('a reason the page has no sentence for keeps the note\'s own sentence and the link, never "closed without a recorded reason"', () => {
		for (const outcome of ['other', 'something_new']) {
			for (const code of ['approval_failed', 'approval_unknown']) {
				expect(approvalNoteLines(code, { id: ID, outcome }, 'owner')).toEqual({
					bodyKey: `chat.note.${code}`, nextKey: null, href: `/app/approvals?entry=${ID}`, rewriteId: null,
				});
			}
		}
	});

	it('a reason that does not fit the title keeps the note\'s own sentence: a decision, or "unclear" on a "not sent" note', () => {
		for (const [code, outcome] of [
			['approval_failed', 'cleared_unknown'], ['approval_failed', 'discarded'], ['approval_unknown', 'cleared_unknown'],
			['approval_failed', 'send_threw'], ['approval_failed', 'provider_error'], ['approval_failed', 'send_timeout'], ['approval_failed', 'stale_claim'],
		] as const) {
			expect(approvalNoteLines(code, { id: ID, outcome }, 'owner')).toEqual({
				bodyKey: `chat.note.${code}`, nextKey: null, href: `/app/approvals?entry=${ID}`, rewriteId: null,
			});
		}
	});

	it('control: the same unclear reason on an "unclear" note reads the page\'s sentence', () => {
		expect(approvalNoteLines('approval_unknown', { id: ID, outcome: 'provider_error' }, 'owner')?.bodyKey).toBe('approvals.outcome.provider_error');
	});

	it('a note written before it carried its entry keeps its own sentence, without a link', () => {
		expect(approvalNoteLines('approval_failed', undefined, 'owner')).toEqual({ bodyKey: 'chat.note.approval_failed', nextKey: null, href: null, rewriteId: null });
	});

	it('every other note is left to the chat\'s own lines', () => {
		for (const code of ['approval_sent', 'provider_error', 'turn_limit']) {
			expect(approvalNoteLines(code, { id: ID, outcome: 'checksum' }, 'owner')).toBeNull();
		}
	});

	it('the link carries the id as one query value', () => {
		expect(approvalEntryHref('a&b=c')).toBe('/app/approvals?entry=a%26b%3Dc');
	});
});

describe('every line such a note can show exists in both languages', () => {
	it('over every code, outcome and viewer', () => {
		const keys = new Set<string>(['chat.note.approval_view_entry', 'chat.note.approval_failed.title', 'chat.note.approval_unknown.title']);
		for (const code of ['approval_failed', 'approval_unknown']) {
			for (const outcome of [...APPROVAL_OUTCOME_SENTENCES, 'sent', 'something_new']) {
				for (const viewer of VIEWERS) {
					const lines = approvalNoteLines(code, { id: ID, outcome }, viewer);
					if (lines === null) continue;
					keys.add(lines.bodyKey);
					if (lines.nextKey !== null) keys.add(lines.nextKey);
				}
			}
		}
		const missing = [...keys].filter((k) => entry(k) === null);
		expect(missing).toEqual([]);
	});

	it('the titles and the link read as ux wrote them (U-054)', () => {
		expect(entry('chat.note.approval_failed.title')).toEqual({ de: 'Mail nicht gesendet', en: 'Email not sent' });
		expect(entry('chat.note.approval_unknown.title')).toEqual({ de: 'Unklar, ob die Mail rausging', en: 'Unclear whether the email went out' });
		expect(entry('chat.note.approval_view_entry')).toEqual({ de: 'Unter „Wartet auf dich“ ansehen', en: 'View under “Waiting for you”' });
		expect(entry('chat.note.approval_failed')?.en).toBe('The email you approved was not sent.');
		expect(entry('chat.note.approval_unknown.next')).toEqual({
			de: 'Der Gesendet-Ordner zeigt das nicht sicher. Frag im Zweifel beim Empfänger nach, bevor du sie neu senden lässt. Schliesse den Eintrag danach unter „Wartet auf dich“ ab.',
			en: 'The Sent folder does not reliably show it. If in doubt, ask the recipient before you have it sent again. Then close the entry under “Waiting for you”.',
		});
	});
});

describe('the chat\'s note row is wired to those lines (source)', () => {
	// ChatView cannot be mounted here; this reads, in its source, that the note row asks the helper and
	// shows each line under the condition that line exists. It does not render: what it looks like is
	// checked on screenshots.
	it('the note row takes its sentence, its step and its link from the helper', () => {
		expect(CHAT_VIEW).toMatch(/approvalNoteLines\(msg\.note\.code, msg\.note\.approval, getApprovalsViewer\(\)\)/);
		expect(CHAT_VIEW).toMatch(/noteKey = approvalLines\?\.bodyKey \?\? `chat\.note\.\$\{msg\.note\.code\}`/);
		// Each line inside the guard that holds it, and nothing else in that guard.
		expect(CHAT_VIEW).toMatch(/\{#if approvalLines\?\.nextKey\}\s*<div[^>]*>\{t\(approvalLines\.nextKey\)\}<\/div>\s*\{\/if\}/);
		// The link's hit area is at least 24 px high (WCAG 2.5.8, ux U-054), by padding, not by type size.
		expect(CHAT_VIEW).toMatch(/<a href=\{approvalLines\.href\} class="[^"]*\bmin-h-6\b[^"]*"/);
		expect(CHAT_VIEW).toMatch(/\{#if approvalLines\?\.href\}\s*<a href=\{approvalLines\.href\}[^>]*>\{t\('chat\.note\.approval_view_entry'\)\}<\/a>\s*\{\/if\}/);
	});
});

describe('a note about a mail that was not sent offers to write it again in a chat', () => {
	const REWRITABLE = ['account_not_configured', 'receive_only', 'account_changed', 'mandate_ended', 'invalid_recipients', 'rate_limit',
		'cancelled', 'mail_unavailable', 'sending_address_unavailable', 'deadline_before_send', 'trail_unavailable', 'executor_error'];

	it('to the owner, for each reason given before the send began', () => {
		for (const outcome of REWRITABLE) {
			expect(approvalNoteLines('approval_failed', { id: ID, outcome }, 'owner')?.rewriteId, outcome).toBe(ID);
		}
	});

	it('to no other session, and not without a known viewer', () => {
		for (const viewer of ['mandate', 'none', null] as const) {
			expect(approvalNoteLines('approval_failed', { id: ID, outcome: 'receive_only' }, viewer)?.rewriteId).toBeNull();
		}
	});

	it('not for a reason the engine does not load', () => {
		for (const outcome of ['checksum', 'not_executable', 'secret_in_body', 'dedup_window', 'queued', 'other', 'something_new']) {
			expect(approvalNoteLines('approval_failed', { id: ID, outcome }, 'owner')?.rewriteId, outcome).toBeNull();
		}
	});

	it('not on a note whose outcome is unclear, whatever its reason', () => {
		for (const outcome of ['send_threw', 'provider_error', 'receive_only']) {
			expect(approvalNoteLines('approval_unknown', { id: ID, outcome }, 'owner')?.rewriteId, outcome).toBeNull();
		}
	});

	it('the list is the engine\'s, so the note never offers what the chat would not load', () => {
		const list = /export const APPROVAL_REWRITABLE_OUTCOMES: readonly ApprovalOutcome\[\] = \[([^\]]*)\]/.exec(CORE_VIEW);
		expect(list, 'the engine\'s list is not where it was').not.toBeNull();
		const engine = [...list![1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
		expect(engine).toEqual(REWRITABLE);
		expect([...APPROVAL_REWRITABLE_OUTCOMES]).toEqual(REWRITABLE);
	});

	it('the button and the chat\'s first line read as written', () => {
		expect(entry('chat.note.approval_rewrite')).toEqual({ de: 'Im Chat neu erstellen', en: 'Write it again in a chat' });
		expect(entry('chat.note.approval_rewrite_framing')).toEqual({ de: 'Ich möchte diese Mail neu erstellen.', en: 'I want to write this email again.' });
	});

	it('the note row shows the button under its guard, and it opens a new chat that loads the entry (source)', () => {
		expect(CHAT_VIEW).toMatch(/\{#if approvalLines\?\.rewriteId\}\s*\{@const rewriteId = approvalLines\.rewriteId\}\s*<div>\s*<button type="button" class="[^"]*\bmin-h-6\b[^"]*" onclick=\{\(\) => rewriteApprovalInChat\(rewriteId\)\} data-approval-rewrite>\{t\('chat\.note\.approval_rewrite'\)\}<\/button>\s*<\/div>\s*\{\/if\}/);
		const fn = /function rewriteApprovalInChat\(id: string\) \{([\s\S]*?)\n\t\}/.exec(CHAT_VIEW);
		expect(fn).not.toBeNull();
		const body = fn![1]!;
		expect(body.indexOf('newChat();')).toBeGreaterThan(-1);
		expect(body.indexOf('sendMessage(')).toBeGreaterThan(body.indexOf('newChat();'));
		expect(body).toContain("sendMessage(t('chat.note.approval_rewrite_framing'), undefined, undefined, { context: { kind: 'approval', id } })");
	});
});
