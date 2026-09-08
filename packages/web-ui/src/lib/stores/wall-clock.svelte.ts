/*
 * Wall clock — the reactive cell behind the welcome screen's greeting and quote.
 *
 * Why this exists. Both are picked from a time-of-day slot, and both used to
 * read `new Date()` inside a Svelte expression that reads no signal changing
 * with time. Such an expression is evaluated once and then only re-evaluated
 * when something it reads changes — for the quote that was never, and for the
 * greeting only on a language switch. The slot therefore froze at first render.
 *
 * Observed on rafael's instance 2026-09-08: at 12:01 local the screen read
 * "Die Welt schläft, du nicht" under a `night` quote. The picks are indexed by
 * day-of-year, so they date themselves — under the formula then running,
 * greeting index 5 (`% 7`) and quote index 2 (`% 31`) both resolve to day 250,
 * and the `night` slot narrows that to a two-hour window the evening before.
 *
 * This file is deliberately almost empty. It cannot be imported in vitest (a
 * top-level `$state` throws `$state is not defined` without the svelte plugin),
 * so everything here is guarded only by a source-text comparison — which is a
 * string count, not a test. Scheduling, resume handling and the browser host
 * all live in utils/wall-clock-core.ts where they are driven by real
 * assertions. What is left is the reactive cell and the wiring, and the
 * whole body is pinned byte-for-byte by wall-clock-core.test.ts.
 *
 * `currentGreeting`/`currentQuote` exist so the call site has no timestamp to
 * get wrong: `getGreeting(locale, Date.now())` type-checks and restores the bug
 * exactly, and no regex over a 4000-line component reliably catches it.
 */

import { getGreeting, getTodaysQuote } from '../data/quotes.js';
import { createBrowserHost, createWallClock } from '../utils/wall-clock-core.js';

let _now = $state(Date.now());

const clock = createWallClock(
	createBrowserHost(() => document, {
		setTimeout: (fn, ms) => window.setTimeout(fn, ms),
		clearTimeout: (handle) => window.clearTimeout(handle as number),
	}),
	(ms) => { _now = ms; },
);

/** Start the clock; returns a disposer for this start. Reference-counted. */
export function startWallClock(): () => void {
	return clock.start();
}

/** The greeting for the current moment. Reactive: re-reads on every tick. */
export function currentGreeting(locale: string): { text: string; punct: string } {
	return getGreeting(locale, _now);
}

/** The quote for the current moment. Reactive: re-reads on every tick. */
export function currentQuote(): { text: string; author: string } {
	return getTodaysQuote(_now);
}
