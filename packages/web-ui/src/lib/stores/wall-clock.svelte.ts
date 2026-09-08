/*
 * Wall clock — a shared, reactive "what time is it now" for surfaces whose
 * content is picked by time of day.
 *
 * Why this exists. The welcome screen's greeting and quote are chosen from a
 * time-of-day slot, and both used to read `new Date()` from inside a
 * `{#if true}` block in ChatView. That block has no reactive dependency, so it
 * is created once and never re-evaluated: the slot froze at the moment the
 * empty-chat screen first rendered, and a page left open across a boundary kept
 * greeting you for the slot it was opened in.
 *
 * Observed on rafael's instance 2026-09-08: at 12:01 local the screen read
 * "Die Welt schläft, du nicht" under a `night` quote. The picks are indexed by
 * day-of-year, so they date themselves — under the formula then running,
 * greeting index 5 (`% 7`) and quote index 2 (`% 31`) both resolve to day 250,
 * and the `night` slot narrows that to a two-hour window the previous evening.
 *
 * The fix is not "recompute more often": `getGreeting`/`getTodaysQuote` no
 * longer have a clock to read, they take a timestamp, and this store is the one
 * reactive source they are fed from.
 *
 * All the scheduling lives in utils/wall-clock-core.ts, where it can be tested.
 * This file is the adapter: the reactive cell plus the real browser. Pattern
 * follows theme.svelte.ts — module-level $state with getters, no $effect here.
 */

import { createWallClock, type WallClockHost } from '../utils/wall-clock-core.js';

let _now = $state(Date.now());

const host: WallClockHost = {
	now: () => Date.now(),
	clockParts: () => {
		const d = new Date();
		return { minutes: d.getMinutes(), seconds: d.getSeconds(), millis: d.getMilliseconds() };
	},
	setTimer: (fn, ms) => setTimeout(fn, ms),
	clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
	onVisible: (handler) => {
		const listener = (): void => {
			if (document.visibilityState === 'visible') handler();
		};
		document.addEventListener('visibilitychange', listener);
		return () => document.removeEventListener('visibilitychange', listener);
	},
};

const clock = createWallClock(host, (ms) => { _now = ms; });

/** Current wall-clock reading. Reactive: reading this in markup re-renders on tick. */
export function wallClockNow(): number {
	return _now;
}

/** Start the clock. Returns a teardown; safe to call from onMount. Idempotent. */
export function startWallClock(): () => void {
	clock.start();
	return stopWallClock;
}

/** Stop the clock and drop its listener. */
export function stopWallClock(): void {
	clock.stop();
}
