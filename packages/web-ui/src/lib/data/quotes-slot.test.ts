import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
	QUOTES, GREETINGS, moodForHour, slotForHour, dayIndex, getGreeting, getTodaysQuote,
} from './quotes.js';

/**
 * The welcome screen's greeting and quote must follow the clock, not the moment
 * the screen happened to render.
 *
 * Reported 2026-09-08 from rafael's instance: at 12:01 local the screen read
 * "Die Welt schläft, du nicht" over a `night` quote. Both pickers read
 * `new Date()` from inside a `{#if true}` block — a block with no reactive
 * dependency, created once and never re-evaluated — so the slot was frozen at
 * first render and the page had been open since the previous evening.
 *
 * The picks are indexed by day-of-year, which makes them self-dating: under the
 * formula that was running, greeting index 5 (`% 7`) and quote index 2 (`% 31`)
 * both resolve to day 250, and the `night` slot narrows that to 2026-09-07
 * 23:00–01:00. That is the forensic record, not something these tests can
 * re-assert, because the day index itself is corrected below.
 */

/** Local-time construction: `new Date(y, m, d, h)` and `getHours()` round-trip in ANY zone. */
const at = (y: number, m: number, d: number, h: number, min = 0): number =>
	new Date(y, m, d, h, min).getTime();

describe('time-of-day slot mapping', () => {
	it('has a pool for every hour of the day, in both catalogues', () => {
		// A mapping that returned an unknown key would make every other assertion
		// here vacuous — the pickers would throw, not silently mis-pick.
		for (let h = 0; h < 24; h++) {
			expect(QUOTES[moodForHour(h)], `mood for hour ${h}`).toBeDefined();
			expect(GREETINGS[slotForHour(h)], `slot for hour ${h}`).toBeDefined();
		}
	});

	// The full table, written out. The reported defect was a slot that did not
	// match the hour, so the hour→slot edges are the thing under test; asserting
	// a couple of samples would leave the boundaries inferred.
	const GREETING_TABLE: ReadonlyArray<[number, string]> = [
		[0, 'night'], [4, 'night'], [5, 'early'], [7, 'early'],
		[8, 'morning'], [11, 'morning'], [12, 'lunch'], [13, 'lunch'],
		[14, 'afternoon'], [17, 'afternoon'], [18, 'evening'], [22, 'evening'],
		[23, 'night'],
	];
	for (const [hour, slot] of GREETING_TABLE) {
		it(`greets from "${slot}" at ${String(hour).padStart(2, '0')}:00`, () => {
			expect(slotForHour(hour)).toBe(slot);
		});
	}

	const MOOD_TABLE: ReadonlyArray<[number, string]> = [
		[0, 'night'], [4, 'night'], [5, 'morning'], [11, 'morning'],
		[12, 'afternoon'], [17, 'afternoon'], [18, 'evening'], [22, 'evening'],
		[23, 'night'],
	];
	for (const [hour, mood] of MOOD_TABLE) {
		it(`quotes from "${mood}" at ${String(hour).padStart(2, '0')}:00`, () => {
			expect(moodForHour(hour)).toBe(mood);
		});
	}
});

describe('the reported regression: a page open across a slot boundary', () => {
	const RENDERED = at(2026, 8, 7, 23, 30); // when the screen was drawn
	const LOOKED_AT = at(2026, 8, 8, 12, 1); // when it was read, 12.5 h later

	it('picks the night greeting at 23:30 and a midday one at 12:01', () => {
		const nightTexts = GREETINGS['night']!.map((g) => g.de);
		const lunchTexts = GREETINGS['lunch']!.map((g) => g.de);

		expect(nightTexts).toContain(getGreeting('de', RENDERED).text);
		expect(lunchTexts).toContain(getGreeting('de', LOOKED_AT).text);
		// The symptom, stated directly: the 12:01 screen must not show a night line.
		expect(nightTexts).not.toContain(getGreeting('de', LOOKED_AT).text);
	});

	it('picks the night quote at 23:30 and an afternoon one at 12:01', () => {
		const nightQuotes = QUOTES['night']!.map((q) => q.text);
		const afternoonQuotes = QUOTES['afternoon']!.map((q) => q.text);

		expect(nightQuotes).toContain(getTodaysQuote(RENDERED).text);
		expect(afternoonQuotes).toContain(getTodaysQuote(LOOKED_AT).text);
		expect(nightQuotes).not.toContain(getTodaysQuote(LOOKED_AT).text);
	});

	it('answers differently for the two moments — the pickers are not frozen', () => {
		// The whole defect in one line: same module, same process, two timestamps.
		expect(getGreeting('de', LOOKED_AT).text).not.toBe(getGreeting('de', RENDERED).text);
		expect(getTodaysQuote(LOOKED_AT).text).not.toBe(getTodaysQuote(RENDERED).text);
	});

	it('translates the same pick rather than picking per locale', () => {
		const de = getGreeting('de', LOOKED_AT);
		const en = getGreeting('en', LOOKED_AT);
		const pair = GREETINGS['lunch']!.find((g) => g.de === de.text);
		expect(pair?.en).toBe(en.text);
	});
});

/**
 * The day index must turn at local midnight.
 *
 * Pinned to a DST zone on purpose. The old form divided an elapsed-millisecond
 * span by a fixed 24 h, which is not a calendar-day count — under CEST it first
 * reported the new day at 01:00. Under UTC both forms agree, so a test that
 * inherited the runner's zone would pass against the broken code on CI and
 * assert nothing.
 */
describe('day index turns at local midnight', () => {
	const legacyDayIndex = (now: Date): number =>
		Math.floor((now.getTime() - new Date(now.getFullYear(), 0, 0).getTime()) / 86_400_000);

	const hoursOf = (y: number, m: number, d: number, f: (n: Date) => number): Set<number> => {
		const seen = new Set<number>();
		for (let h = 0; h < 24; h++) seen.add(f(new Date(y, m, d, h, 30)));
		return seen;
	};

	let saved: string | undefined;
	beforeAll(() => { saved = process.env['TZ']; process.env['TZ'] = 'Europe/Zurich'; });
	afterAll(() => {
		if (saved === undefined) delete process.env['TZ'];
		else process.env['TZ'] = saved;
	});

	it('actually runs in Europe/Zurich — positive control for the TZ pin', () => {
		// Node re-reads process.env.TZ per Date operation, but if that ever stops
		// being true this suite would quietly degrade into a UTC run, where the
		// assertions below hold for the broken implementation too.
		expect(new Date(2026, 8, 8).getTimezoneOffset()).toBe(-120); // CEST = UTC+2
		expect(new Date(2026, 0, 15).getTimezoneOffset()).toBe(-60); // CET  = UTC+1
	});

	it('reports one index for all 24 hours of a summer day', () => {
		expect(hoursOf(2026, 8, 8, dayIndex).size).toBe(1);
	});

	it('and the old form did not — positive control that the day discriminates', () => {
		expect(hoursOf(2026, 8, 8, legacyDayIndex).size).toBe(2);
	});

	it('is stable in winter too, where the old form happened to be right', () => {
		expect(hoursOf(2026, 0, 15, dayIndex).size).toBe(1);
		expect(hoursOf(2026, 0, 15, legacyDayIndex).size).toBe(1);
	});

	it('counts from 0 on 1 January and advances by one per day', () => {
		expect(dayIndex(new Date(2026, 0, 1, 12))).toBe(0);
		expect(dayIndex(new Date(2026, 0, 2, 12))).toBe(1);
		// Across the spring transition, where a naive span-divide loses an hour.
		const beforeDst = dayIndex(new Date(2026, 2, 28, 12));
		expect(dayIndex(new Date(2026, 2, 29, 12))).toBe(beforeDst + 1);
		expect(dayIndex(new Date(2026, 2, 30, 12))).toBe(beforeDst + 2);
	});
});

/**
 * Structural guard: the pickers must have no ambient clock left to read.
 *
 * This is the invariant the fix rests on — not "they are called more often" but
 * "they cannot answer without being told when it is". A zero-argument
 * `Date.now()` or `new Date()` reintroduced here would freeze the screen again
 * while every behavioural test above stayed green, because those pass a
 * timestamp explicitly.
 */
describe('quotes.ts reads no ambient clock', () => {
	const SRC = readFileSync(fileURLToPath(new URL('./quotes.ts', import.meta.url)), 'utf-8');
	const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

	it('has source to scan — the comment strip did not eat the file', () => {
		expect(CODE).toContain('export function getGreeting');
		expect(CODE).toContain('export function getTodaysQuote');
	});

	it('never calls Date.now()', () => {
		expect(CODE).not.toMatch(/\bDate\.now\s*\(/);
	});

	it('never constructs a Date from the ambient clock', () => {
		expect(CODE).not.toMatch(/\bnew\s+Date\s*\(\s*\)/);
	});
});
