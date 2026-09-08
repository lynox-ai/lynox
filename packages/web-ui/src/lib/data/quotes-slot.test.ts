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
 * `new Date()` from inside a Svelte expression that read no signal changing
 * with time, so the derived never invalidated and the slot froze at first
 * render. (The quote's expression compiled to `$.derived(getTodaysQuote)` —
 * an empty dependency set. The greeting's read the locale, so a language switch
 * refreshed it; nothing else did.)
 *
 * The picks are indexed by day-of-year, which dates them: under the formula
 * then running, greeting index 5 (`% 7`) and quote index 2 (`% 31`) both
 * resolve to day 250, and the `night` slot narrows that to six hours in two
 * pieces — 2026-09-07 01:00–05:00 and 23:00–2026-09-08 01:00. That is the
 * forensic record, not something these tests re-assert: the day index itself is
 * corrected below, and `lcm(7, 31) = 217` means the index PAIR repeats once a
 * year, so it dates the render only together with the report's own date.
 */

/** Local-time construction: `new Date(y, m, d, h)` and `getHours()` round-trip in ANY zone. */
const at = (y: number, m: number, d: number, h: number, min = 0): number =>
	new Date(y, m, d, h, min).getTime();

/**
 * The hour→pool mapping, all twenty-four hours, written out by hand.
 *
 * An earlier revision listed only the boundary hours and called itself "the full
 * table". It was 13 of 24 for greetings and 9 of 24 for quotes, and it let a
 * mutation that sent hours 1–3 to `morning` pass untouched — the reported
 * symptom is precisely "wrong slot for this hour", so every hour is the test.
 */
const GREETING_SLOTS: readonly string[] = [
	'night', 'night', 'night', 'night', 'night',        // 00–04
	'early', 'early', 'early',                          // 05–07
	'morning', 'morning', 'morning', 'morning',         // 08–11
	'lunch', 'lunch',                                   // 12–13
	'afternoon', 'afternoon', 'afternoon', 'afternoon', // 14–17
	'evening', 'evening', 'evening', 'evening', 'evening', // 18–22
	'night',                                            // 23
];

const QUOTE_MOODS: readonly string[] = [
	'night', 'night', 'night', 'night', 'night',        // 00–04
	'morning', 'morning', 'morning', 'morning', 'morning', 'morning', 'morning', // 05–11
	'afternoon', 'afternoon', 'afternoon', 'afternoon', 'afternoon', 'afternoon', // 12–17
	'evening', 'evening', 'evening', 'evening', 'evening', // 18–22
	'night',                                            // 23
];

describe('time-of-day slot mapping', () => {
	it('the expected tables cover the whole day exactly once', () => {
		// A table that quietly lost an entry would make the loops below skip an
		// hour and still look exhaustive.
		expect(GREETING_SLOTS).toHaveLength(24);
		expect(QUOTE_MOODS).toHaveLength(24);
	});

	for (let hour = 0; hour < 24; hour++) {
		const hh = String(hour).padStart(2, '0');
		it(`greets from "${GREETING_SLOTS[hour]}" at ${hh}:00`, () => {
			expect(slotForHour(hour)).toBe(GREETING_SLOTS[hour]);
		});
		it(`quotes from "${QUOTE_MOODS[hour]}" at ${hh}:00`, () => {
			expect(moodForHour(hour)).toBe(QUOTE_MOODS[hour]);
		});
	}

	it('every slot the mapping can name has a pool behind it', () => {
		for (let h = 0; h < 24; h++) {
			expect(QUOTES[moodForHour(h)], `mood for hour ${h}`).toBeDefined();
			expect(GREETINGS[slotForHour(h)], `slot for hour ${h}`).toBeDefined();
		}
	});
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
 * The day index must turn at local midnight, and it must count from the start
 * of the YEAR.
 *
 * Pinned to a DST zone on purpose. The old form divided an elapsed-millisecond
 * span by a fixed 24 h, which is not a calendar-day count — under CEST it first
 * reported the new day at 01:00. Under UTC both forms agree, so a test that
 * inherited the runner's zone would pass against the broken code on CI.
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

	it('the TZ pin is what sets the zone — not the machine that happens to run this', () => {
		// Asserting "we are in Zurich" is not a control on a developer machine
		// that IS in Zurich: it passes with the pin removed. What has to be shown
		// is that assigning process.env.TZ still moves the clock at runtime.
		expect(new Date(2026, 8, 8).getTimezoneOffset()).toBe(-120); // CEST
		process.env['TZ'] = 'UTC';
		expect(new Date(2026, 8, 8).getTimezoneOffset()).toBe(0);
		process.env['TZ'] = 'Europe/Zurich';
		expect(new Date(2026, 0, 15).getTimezoneOffset()).toBe(-60);  // CET
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

	it('counts from the start of the YEAR, not of the month', () => {
		// An absolute value, because every other assertion here is a difference
		// and a difference has two operands: re-anchoring the count on the first
		// of the current month keeps every delta intact and survives.
		expect(dayIndex(new Date(2026, 8, 8, 12))).toBe(250);
		expect(dayIndex(new Date(2026, 11, 31, 12))).toBe(364);
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
	const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

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
