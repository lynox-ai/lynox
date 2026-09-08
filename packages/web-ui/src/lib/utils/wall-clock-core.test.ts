import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { msToNextHour, createWallClock, type WallClockHost } from './wall-clock-core.js';

describe('msToNextHour', () => {
	it('is a full hour exactly on the hour', () => {
		expect(msToNextHour(0, 0, 0)).toBe(3_600_000);
	});

	it('never returns zero — a zero delay would re-fire immediately, forever', () => {
		expect(msToNextHour(59, 59, 999)).toBe(1);
		for (let m = 0; m < 60; m++) {
			expect(msToNextHour(m, 59, 999), `at :${m}:59.999`).toBeGreaterThan(0);
		}
	});

	it('never overshoots an hour', () => {
		for (let m = 0; m < 60; m++) {
			expect(msToNextHour(m, 0, 0), `at :${m}`).toBeLessThanOrEqual(3_600_000);
		}
	});

	it('counts down by the minute, the second and the millisecond', () => {
		expect(msToNextHour(1, 0, 0)).toBe(3_540_000);
		expect(msToNextHour(59, 0, 0)).toBe(60_000);
		expect(msToNextHour(12, 34, 567)).toBe(3_600_000 - (12 * 60_000 + 34 * 1_000 + 567));
	});
});

/** A scriptable stand-in for the browser: no timers, no DOM, no real clock. */
function fakeHost(startMs: number) {
	let now = startMs;
	let nextHandle = 1;
	const timers = new Map<number, { fn: () => void; ms: number }>();
	const visibilityHandlers = new Set<() => void>();
	let unsubscribeCalls = 0;

	const host: WallClockHost = {
		now: () => now,
		clockParts: () => {
			const d = new Date(now);
			return { minutes: d.getMinutes(), seconds: d.getSeconds(), millis: d.getMilliseconds() };
		},
		setTimer: (fn, ms) => {
			const h = nextHandle++;
			timers.set(h, { fn, ms });
			return h;
		},
		clearTimer: (handle) => { timers.delete(handle as number); },
		onVisible: (handler) => {
			visibilityHandlers.add(handler);
			return () => { unsubscribeCalls++; visibilityHandlers.delete(handler); };
		},
	};

	return {
		host,
		/** Advance the clock and fire every timer whose delay has elapsed, once. */
		fireTimers(advanceMs: number) {
			now += advanceMs;
			for (const [h, t] of [...timers]) {
				timers.delete(h);
				void t.ms;
				t.fn();
			}
		},
		advance(ms: number) { now += ms; },
		becomeVisible() { for (const h of [...visibilityHandlers]) h(); },
		pendingTimers: () => timers.size,
		pendingDelays: () => [...timers.values()].map((t) => t.ms),
		listeners: () => visibilityHandlers.size,
		unsubscribeCalls: () => unsubscribeCalls,
	};
}

/** 2026-09-07 23:30 local — the moment rafael's screen was drawn. */
const RENDERED_AT = new Date(2026, 8, 7, 23, 30).getTime();

describe('createWallClock', () => {
	it('publishes the current time as soon as it starts', () => {
		const f = fakeHost(RENDERED_AT);
		const seen: number[] = [];
		createWallClock(f.host, (ms) => seen.push(ms)).start();
		expect(seen).toEqual([RENDERED_AT]);
	});

	it('aims its first tick at the next full hour, not at a fixed interval', () => {
		const f = fakeHost(RENDERED_AT); // :30 past
		createWallClock(f.host, () => {}).start();
		expect(f.pendingDelays()).toEqual([30 * 60_000]);
	});

	it('republishes at the boundary and re-arms itself', () => {
		const f = fakeHost(RENDERED_AT);
		const seen: number[] = [];
		createWallClock(f.host, (ms) => seen.push(ms)).start();

		f.fireTimers(30 * 60_000); // 00:00
		expect(seen).toHaveLength(2);
		expect(new Date(seen[1]!).getHours()).toBe(0);
		// Without the re-arm the clock ticks once and dies — the screen freezes
		// again, one hour later than before.
		expect(f.pendingTimers()).toBe(1);
		expect(f.pendingDelays()).toEqual([3_600_000]);

		f.fireTimers(3_600_000); // 01:00
		expect(seen).toHaveLength(3);
		expect(new Date(seen[2]!).getHours()).toBe(1);
	});

	it('republishes when the page comes back into view — the observed case', () => {
		// A phone put down at 23:30 and picked up at 12:01 fires no timer: iOS
		// suspends them while the page is hidden. This branch is the whole reason
		// the greeting was still saying "Die Welt schläft, du nicht" at noon.
		const f = fakeHost(RENDERED_AT);
		const seen: number[] = [];
		createWallClock(f.host, (ms) => seen.push(ms)).start();

		f.advance(12.5 * 3_600_000 + 60_000); // no timer fires
		expect(seen).toHaveLength(1);

		f.becomeVisible();
		expect(seen).toHaveLength(2);
		expect(new Date(seen[1]!).getHours()).toBe(12);
	});

	it('re-aims the pending timer on resume instead of leaving a stale one', () => {
		const f = fakeHost(RENDERED_AT);
		createWallClock(f.host, () => {}).start();
		expect(f.pendingDelays()).toEqual([30 * 60_000]);

		f.advance(12.5 * 3_600_000 + 60_000); // now 12:00
		f.becomeVisible();

		// One timer, not two, and aimed at 13:00 (59 min away, it is 12:01) rather
		// than at a boundary that went by hours ago.
		expect(f.pendingTimers()).toBe(1);
		expect(f.pendingDelays()).toEqual([59 * 60_000]);
	});

	it('starting twice does not double the timer or the listener', () => {
		const f = fakeHost(RENDERED_AT);
		const clock = createWallClock(f.host, () => {});
		clock.start();
		clock.start();
		expect(f.pendingTimers()).toBe(1);
		expect(f.listeners()).toBe(1);
	});

	it('stops cleanly: no timer left, listener unsubscribed', () => {
		const f = fakeHost(RENDERED_AT);
		const seen: number[] = [];
		const clock = createWallClock(f.host, (ms) => seen.push(ms));
		clock.start();
		clock.stop();

		expect(f.pendingTimers()).toBe(0);
		expect(f.listeners()).toBe(0);
		expect(f.unsubscribeCalls()).toBe(1);

		// And it is genuinely deaf afterwards, not merely tidy.
		f.becomeVisible();
		expect(seen).toHaveLength(1);
	});

	it('can be restarted after a stop', () => {
		const f = fakeHost(RENDERED_AT);
		const seen: number[] = [];
		const clock = createWallClock(f.host, (ms) => seen.push(ms));
		clock.start();
		clock.stop();
		clock.start();
		expect(seen).toHaveLength(2);
		expect(f.pendingTimers()).toBe(1);
		expect(f.listeners()).toBe(1);
	});

	it('stopping twice is harmless', () => {
		const f = fakeHost(RENDERED_AT);
		const clock = createWallClock(f.host, () => {});
		clock.start();
		clock.stop();
		clock.stop();
		expect(f.unsubscribeCalls()).toBe(1);
	});
});

/**
 * Wiring guards. The pure pickers and the tested clock only fix anything if
 * ChatView connects them, and the adapter only works if it hands the core a
 * real browser.
 *
 * Source-level because neither ChatView nor the rune store can be imported in
 * vitest — a top-level `$state` throws `$state is not defined` without the
 * svelte plugin.
 */
describe('the clock is actually wired up', () => {
	const read = (rel: string): string =>
		readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8');
	const CHAT_VIEW = read('../components/ChatView.svelte');
	const ADAPTER = read('../stores/wall-clock.svelte.ts');

	it('has source to scan', () => {
		expect(CHAT_VIEW).toContain('getGreeting');
		expect(CHAT_VIEW).toContain('getTodaysQuote');
		expect(ADAPTER).toContain('createWallClock');
	});

	it('passes the reactive clock to both pickers', () => {
		expect(CHAT_VIEW).toMatch(/getGreeting\(\s*getLocale\(\)\s*,\s*wallClockNow\(\)\s*\)/);
		expect(CHAT_VIEW).toMatch(/getTodaysQuote\(\s*wallClockNow\(\)\s*\)/);
	});

	it('does not feed them a fresh ambient read instead', () => {
		// `getGreeting(getLocale(), Date.now())` type-checks and reads as correct;
		// it also restores the exact bug, because the block never re-runs.
		expect(CHAT_VIEW).not.toMatch(/getGreeting\([^)]*Date\.now\(\)/);
		expect(CHAT_VIEW).not.toMatch(/getTodaysQuote\(\s*Date\.now\(\)/);
	});

	it('starts the clock on mount and stops it on teardown', () => {
		// Without the start call nothing ticks and nothing listens: every test
		// above stays green while the screen stays frozen.
		expect(CHAT_VIEW).toMatch(/const\s+stopClock\s*=\s*startWallClock\(\)/);
		expect(CHAT_VIEW).toMatch(/\bstopClock\(\)/);
	});

	it('subscribes the adapter to visibilitychange, filtered to "visible"', () => {
		// The core is blind here: it only knows `onVisible`. If the adapter
		// listened to the wrong event, or fired on hidden as well, the tested
		// resume path would never run in the browser.
		expect(ADAPTER).toMatch(/addEventListener\(\s*'visibilitychange'/);
		expect(ADAPTER).toMatch(/visibilityState\s*!==\s*'visible'|visibilityState\s*===\s*'visible'/);
		expect(ADAPTER).toMatch(/removeEventListener\(\s*'visibilitychange'/);
	});
});
