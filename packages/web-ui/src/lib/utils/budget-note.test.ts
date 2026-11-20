import { describe, it, expect } from 'vitest';
import {
	budgetNoteLines, budgetResetAt, formatCapUSD, formatResetWhen, formatSpentUSD, parseBudgetNoteRef,
	LIMITS_PAGE, SUPPORT_MAILTO,
} from './budget-note.js';

describe('when a cap opens again', () => {
	it('the daily cap at the next midnight UTC, the monthly one on the first of the next month', () => {
		const now = new Date('2026-11-20T23:30:00Z');
		expect(budgetResetAt('daily', now).toISOString()).toBe('2026-11-21T00:00:00.000Z');
		expect(budgetResetAt('monthly', now).toISOString()).toBe('2026-12-01T00:00:00.000Z');
		expect(budgetResetAt('monthly', new Date('2026-12-31T12:00:00Z')).toISOString()).toBe('2027-01-01T00:00:00.000Z');
		expect(budgetResetAt('daily', new Date('2026-11-30T00:00:00Z')).toISOString()).toBe('2026-12-01T00:00:00.000Z');
	});

	it('in the reader\'s time with its day: today, tomorrow, or the date', () => {
		const zurich = 'Europe/Zurich';
		// 20 Nov, 14:00 in Zurich: the daily reset (midnight UTC) is 01:00 there the next day.
		const afternoon = new Date('2026-11-20T13:00:00Z');
		expect(formatResetWhen(budgetResetAt('daily', afternoon), afternoon, 'de', zurich)).toBe('morgen um 01:00');
		expect(formatResetWhen(budgetResetAt('daily', afternoon), afternoon, 'en', zurich)).toBe('tomorrow at 01:00 AM');
		// 00:30 in Zurich is still the day before in UTC: the reset is today at 01:00.
		const night = new Date('2026-11-20T23:30:00Z');
		expect(formatResetWhen(budgetResetAt('daily', night), night, 'de', zurich)).toBe('heute um 01:00');
		expect(formatResetWhen(budgetResetAt('monthly', afternoon), afternoon, 'de', zurich)).toBe('am 1. Dezember um 01:00');
		expect(formatResetWhen(budgetResetAt('monthly', afternoon), afternoon, 'en', zurich)).toBe('on 1 December at 01:00 AM');
		// West of UTC the daily reset falls in the reader's evening of the same day.
		const ny = 'America/New_York';
		expect(formatResetWhen(budgetResetAt('daily', afternoon), afternoon, 'en', ny)).toBe('today at 07:00 PM');
		expect(formatResetWhen(budgetResetAt('daily', afternoon), afternoon, 'de', ny)).toBe('heute um 19:00');
	});
});

describe('amounts as the engine names them', () => {
	it('a whole cap without cents, spend always with cents', () => {
		expect(formatCapUSD(5)).toBe('$5');
		expect(formatCapUSD(7.5)).toBe('$7.50');
		expect(formatSpentUSD(5.12)).toBe('$5.12');
		expect(formatSpentUSD(150)).toBe('$150.00');
	});
});

describe('the note\'s lines', () => {
	const now = new Date('2026-11-20T13:00:00Z');
	const daily = { cap: 'daily', limitUSD: 5, spentUSD: 5.12 } as const;

	it('the reason with its amounts, and the step by who can change the cap', () => {
		const self = budgetNoteLines(daily, 'self', true, now, 'de');
		expect(self.reasonKey).toBe('chat.note.budget.daily');
		expect(self.reasonVars['limit']).toBe('$5');
		expect(self.reasonVars['spent']).toBe('$5.12');
		expect(self.reasonVars['when']).toBe(formatResetWhen(budgetResetAt('daily', now), now, 'de'));
		expect(self).toMatchObject({ nextKey: 'chat.note.budget.next_self', href: LIMITS_PAGE });
		expect(budgetNoteLines(daily, 'plan', false, now, 'de')).toMatchObject({ nextKey: 'chat.note.budget.next_plan', href: SUPPORT_MAILTO });
		const owner = budgetNoteLines(daily, 'owner', false, now, 'de');
		expect(owner.nextKey).toBe('chat.note.budget.next_owner');
		expect(owner.href).toBeUndefined();
		expect(budgetNoteLines({ cap: 'monthly', limitUSD: 150, spentUSD: 150.4 }, 'self', true, now, 'en').reasonKey).toBe('chat.note.budget.monthly');
	});

	it('while the page does not know who can change it, no step rather than a wrong one', () => {
		const lines = budgetNoteLines(daily, null, null, now, 'de');
		expect(lines.nextKey).toBeUndefined();
		expect(lines.href).toBeUndefined();
	});

	it('spend that cannot be checked: no amounts; restart on self-host, support elsewhere', () => {
		const unknown = { cap: 'unknown' } as const;
		expect(budgetNoteLines(unknown, 'self', true, now, 'de')).toEqual({ reasonKey: 'chat.note.budget.unverifiable', reasonVars: {}, nextKey: 'chat.note.budget.restart' });
		expect(budgetNoteLines(unknown, 'plan', false, now, 'de')).toEqual({ reasonKey: 'chat.note.budget.unverifiable', reasonVars: {}, nextKey: 'chat.note.budget.support_if_stays', href: SUPPORT_MAILTO });
		expect(budgetNoteLines(unknown, 'owner', null, now, 'de')).toEqual({ reasonKey: 'chat.note.budget.unverifiable', reasonVars: {} });
		// A cap reached without its amounts says no numbers either.
		expect(budgetNoteLines({ cap: 'daily', limitUSD: 5 }, 'self', true, now, 'de').reasonKey).toBe('chat.note.budget.unverifiable');
	});
});

describe('reading a budget from the wire', () => {
	it('keeps the engine\'s shape and drops anything else, field by field', () => {
		expect(parseBudgetNoteRef({ cap: 'daily', limitUSD: 5, spentUSD: 5.12 })).toEqual({ cap: 'daily', limitUSD: 5, spentUSD: 5.12 });
		expect(parseBudgetNoteRef({ cap: 'unknown' })).toEqual({ cap: 'unknown' });
		expect(parseBudgetNoteRef({ cap: 'weekly' })).toBeUndefined();
		expect(parseBudgetNoteRef(null)).toBeUndefined();
		expect(parseBudgetNoteRef({ cap: 'daily', limitUSD: -1, spentUSD: Number.NaN })).toEqual({ cap: 'daily' });
		expect(parseBudgetNoteRef({ cap: 'daily', limitUSD: '5', spentUSD: Infinity })).toEqual({ cap: 'daily' });
	});
});
