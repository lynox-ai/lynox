import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { APPROVAL_OUTCOME_SENTENCES, approvalEntryHref, approvalNoteLines, type ApprovalViewer } from './approvals.js';

/**
 * A chat note about an approved mail that did not go out names the reason the approvals page shows
 * for the same entry, the next step for the same viewer, and leads to the entry.
 *
 * Source is read for the i18n check, not imported: `i18n.svelte.ts` holds the locale in a `$state` rune.
 */
const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const I18N = read('../i18n.svelte.ts');
const CHAT_VIEW = read('./ChatView.svelte');

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
		});
	});

	it('a reason without a step of its own gets the general one: write it again in a chat', () => {
		expect(approvalNoteLines('approval_failed', { id: ID, outcome: 'mandate_ended' }, 'owner')?.nextKey).toBe('approvals.next.recreate');
	});

	it('a session that is not the owner\'s is told to ask the owner, as on the page', () => {
		for (const viewer of ['mandate', 'none'] as const) {
			expect(approvalNoteLines('approval_failed', { id: ID, outcome: 'account_changed' }, viewer)?.nextKey).toBe('approvals.next.ask_owner');
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
			nextKey: 'approvals.next.unknown',
			href: `/app/approvals?entry=${ID}`,
		});
	});

	it('a reason the page has no sentence for keeps the note\'s own sentence and the link, never "closed without a recorded reason"', () => {
		for (const outcome of ['other', 'something_new']) {
			for (const code of ['approval_failed', 'approval_unknown']) {
				expect(approvalNoteLines(code, { id: ID, outcome }, 'owner')).toEqual({
					bodyKey: `chat.note.${code}`, nextKey: null, href: `/app/approvals?entry=${ID}`,
				});
			}
		}
	});

	it('a note written before it carried its entry keeps its own sentence, without a link', () => {
		expect(approvalNoteLines('approval_failed', undefined, 'owner')).toEqual({ bodyKey: 'chat.note.approval_failed', nextKey: null, href: null });
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
	});
});

describe('the chat renders those lines', () => {
	// ChatView cannot be mounted here; this reads that the note row asks the helper and shows what it
	// answers. What it looks like is checked on screenshots.
	it('the note row takes its sentence, its step and its link from the helper', () => {
		expect(CHAT_VIEW).toMatch(/approvalNoteLines\(msg\.note\.code, msg\.note\.approval, getApprovalsViewer\(\)\)/);
		expect(CHAT_VIEW).toMatch(/noteKey = approvalLines\?\.bodyKey \?\? `chat\.note\.\$\{msg\.note\.code\}`/);
		expect(CHAT_VIEW).toMatch(/\{t\(approvalLines\.nextKey\)\}/);
		expect(CHAT_VIEW).toMatch(/<a href=\{approvalLines\.href\}[^>]*>\{t\('chat\.note\.approval_view_entry'\)\}<\/a>/);
	});
});
