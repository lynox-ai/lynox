import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
	msToNextHour, msToNextHourFrom, createWallClock, createBrowserHost,
	type WallClockHost, type ResumeDocument,
} from './wall-clock-core.js';

/** 2026-09-07 23:30:17.123 local — deliberately NOT on a round minute, see below. */
const RENDERED_AT = new Date(2026, 8, 7, 23, 30, 17, 123).getTime();

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

describe('msToNextHourFrom', () => {
	it('lands exactly on the next full local hour', () => {
		// One timestamp in, one delay out. An earlier shape read the clock twice
		// — once for the value, once for the components — and a boundary falling
		// between the two reads aimed the tick a full hour late, which is the
		// exact defect this module exists to prevent.
		expect(RENDERED_AT + msToNextHourFrom(RENDERED_AT))
			.toBe(new Date(2026, 8, 8, 0, 0, 0, 0).getTime());
	});

	it('carries seconds and milliseconds, not just minutes', () => {
		const sloppy = 3_600_000 - 30 * 60_000; // what dropping them would give
		expect(msToNextHourFrom(RENDERED_AT)).not.toBe(sloppy);
		expect(msToNextHourFrom(RENDERED_AT)).toBe(sloppy - (17 * 1_000 + 123));
	});
});

/**
 * A scriptable stand-in for the browser: virtual clock, a real scheduler.
 *
 * `run()` fires a timer at the virtual instant it is actually due, rather than
 * firing every pending timer unconditionally. That distinction is what binds
 * the scheduling arithmetic to the tick: with an unconditional fake, dropping
 * the seconds term from the delay computation is invisible.
 */
function fakeHost(startMs: number) {
	let now = startMs;
	let nextHandle = 1;
	const timers = new Map<number, { fn: () => void; dueAt: number; delay: number }>();
	const resumeHandlers = new Set<() => void>();
	let unsubscribeCalls = 0;

	const host: WallClockHost = {
		now: () => now,
		setTimer: (fn, ms) => {
			const h = nextHandle++;
			timers.set(h, { fn, dueAt: now + ms, delay: ms });
			return h;
		},
		clearTimer: (handle) => { timers.delete(handle as number); },
		onResume: (handler) => {
			resumeHandlers.add(handler);
			return () => { unsubscribeCalls++; resumeHandlers.delete(handler); };
		},
	};

	return {
		host,
		/** Advance to now+ms, firing each timer at its own due instant. */
		run(ms: number) {
			const target = now + ms;
			for (;;) {
				const due = [...timers.entries()]
					.filter(([, t]) => t.dueAt <= target)
					.sort((a, b) => a[1].dueAt - b[1].dueAt)[0];
				if (!due) break;
				timers.delete(due[0]);
				now = due[1].dueAt;
				due[1].fn();
			}
			now = target;
		},
		/** Move the clock without letting any timer fire — a suspended page. */
		advance(ms: number) { now += ms; },
		resume() { for (const h of [...resumeHandlers]) h(); },
		timerCount: () => timers.size,
		delays: () => [...timers.values()].map((t) => t.delay),
		listeners: () => resumeHandlers.size,
		unsubscribeCalls: () => unsubscribeCalls,
	};
}

describe('createWallClock', () => {
	it('publishes the current time as soon as it starts', () => {
		const f = fakeHost(RENDERED_AT);
		const seen: number[] = [];
		createWallClock(f.host, (ms) => seen.push(ms)).start();
		expect(seen).toEqual([RENDERED_AT]);
	});

	it('lands its tick on the hour boundary, to the millisecond', () => {
		const f = fakeHost(RENDERED_AT);
		const seen: number[] = [];
		createWallClock(f.host, (ms) => seen.push(ms)).start();

		f.run(30 * 60_000);
		expect(seen).toHaveLength(2);
		const landed = new Date(seen[1]!);
		expect([landed.getHours(), landed.getMinutes(), landed.getSeconds(), landed.getMilliseconds()])
			.toEqual([0, 0, 0, 0]);
	});

	it('re-arms itself, hour after hour', () => {
		const f = fakeHost(RENDERED_AT);
		const seen: number[] = [];
		createWallClock(f.host, (ms) => seen.push(ms)).start();

		f.run(30 * 60_000 + 3 * 3_600_000); // to 03:00
		// Without the re-arm the clock ticks once and dies — the screen freezes
		// again, one hour later than before.
		expect(seen.slice(1).map((ms) => new Date(ms).getHours())).toEqual([0, 1, 2, 3]);
		expect(seen.slice(1).every((ms) => new Date(ms).getMinutes() === 0)).toBe(true);
	});

	it('republishes when the page comes back — the observed case', () => {
		// A phone put down at 23:30 and picked up at 12:01 fires no timer: the
		// browser suspends them while the page is hidden. This branch is the
		// whole reason the greeting still said "Die Welt schläft, du nicht" at
		// noon, so it gets a test that can fail rather than a regex.
		const f = fakeHost(RENDERED_AT);
		const seen: number[] = [];
		createWallClock(f.host, (ms) => seen.push(ms)).start();

		f.advance(12 * 3_600_000 + 31 * 60_000); // no timer fires
		expect(seen).toHaveLength(1);

		f.resume();
		expect(seen).toHaveLength(2);
		expect(new Date(seen[1]!).getHours()).toBe(12);
	});

	it('re-aims the pending timer on resume instead of leaving a stale one', () => {
		const f = fakeHost(RENDERED_AT);
		createWallClock(f.host, () => {}).start();
		f.advance(12 * 3_600_000 + 31 * 60_000); // 12:01:17.123
		f.resume();

		expect(f.timerCount()).toBe(1);
		expect(f.delays()).toEqual([msToNextHourFrom(new Date(2026, 8, 8, 12, 1, 17, 123).getTime())]);
	});

	it('keeps ticking after a resume', () => {
		const f = fakeHost(RENDERED_AT);
		const seen: number[] = [];
		createWallClock(f.host, (ms) => seen.push(ms)).start();
		f.advance(12 * 3_600_000 + 31 * 60_000);
		f.resume();
		f.run(60 * 60_000);
		expect(new Date(seen.at(-1)!).getHours()).toBe(13);
	});

	it('subscribes before it schedules, so a failing subscribe leaks no timer', () => {
		const f = fakeHost(RENDERED_AT);
		const boom: WallClockHost = { ...f.host, onResume: () => { throw new Error('no document'); } };
		const clock = createWallClock(boom, () => {});
		expect(() => clock.start()).toThrow('no document');
		expect(f.timerCount()).toBe(0);
	});
});

describe('createWallClock reference counting', () => {
	// ChatView is a package export. Two mounted copies, or a {#key} swap whose
	// teardown runs after the new mount, must not let one disposer stop the
	// clock for the other — that silently restores the bug.
	it('starts once for many holders', () => {
		const f = fakeHost(RENDERED_AT);
		const clock = createWallClock(f.host, () => {});
		clock.start();
		clock.start();
		expect(f.timerCount()).toBe(1);
		expect(f.listeners()).toBe(1);
	});

	it('keeps running while any holder remains', () => {
		const f = fakeHost(RENDERED_AT);
		const seen: number[] = [];
		const clock = createWallClock(f.host, (ms) => seen.push(ms));
		const a = clock.start();
		clock.start();
		a();

		expect(f.timerCount()).toBe(1);
		expect(f.listeners()).toBe(1);
		f.resume();
		expect(seen).toHaveLength(2);
	});

	it('stops when the last holder disposes', () => {
		const f = fakeHost(RENDERED_AT);
		const seen: number[] = [];
		const clock = createWallClock(f.host, (ms) => seen.push(ms));
		const a = clock.start();
		const b = clock.start();
		a();
		b();

		expect(f.timerCount()).toBe(0);
		expect(f.listeners()).toBe(0);
		expect(f.unsubscribeCalls()).toBe(1);
		f.resume();
		expect(seen).toHaveLength(1); // genuinely deaf, not merely tidy
	});

	it('ignores a disposer called twice', () => {
		const f = fakeHost(RENDERED_AT);
		const clock = createWallClock(f.host, () => {});
		const a = clock.start();
		clock.start();
		a();
		a(); // must not decrement a second time
		expect(f.timerCount()).toBe(1);
		expect(f.listeners()).toBe(1);
	});

	it('can be restarted after the last holder left', () => {
		const f = fakeHost(RENDERED_AT);
		const seen: number[] = [];
		const clock = createWallClock(f.host, (ms) => seen.push(ms));
		clock.start()();
		clock.start();
		expect(seen).toHaveLength(2);
		expect(f.timerCount()).toBe(1);
		expect(f.listeners()).toBe(1);
	});
});

/** A scriptable `document`, so the browser host gets assertions rather than a regex. */
function fakeDocument(initial = 'visible') {
	let visibility = initial;
	const listeners = new Map<string, Set<() => void>>();
	const doc: ResumeDocument = {
		get visibilityState() { return visibility; },
		addEventListener: (type, listener) => {
			const set = listeners.get(type) ?? new Set<() => void>();
			set.add(listener);
			listeners.set(type, set);
		},
		removeEventListener: (type, listener) => { listeners.get(type)?.delete(listener); },
	};
	return {
		doc,
		setVisibility(v: string) { visibility = v; },
		fire(type: string) { for (const l of [...(listeners.get(type) ?? [])]) l(); },
		count(type: string) { return listeners.get(type)?.size ?? 0; },
	};
}

describe('createBrowserHost', () => {
	const timerSpy = () => {
		const set: Array<{ ms: number }> = [];
		const cleared: unknown[] = [];
		return {
			api: {
				setTimeout: (_fn: () => void, ms: number) => { set.push({ ms }); return set.length; },
				clearTimeout: (handle: unknown) => { cleared.push(handle); },
			},
			set, cleared,
		};
	};

	it('does not touch document until something subscribes', () => {
		// The module is imported at page load; ChatView is a package export and a
		// consumer could render it on a server, where `document` does not exist.
		let calls = 0;
		const t = timerSpy();
		createBrowserHost(() => { calls++; return fakeDocument().doc; }, t.api);
		expect(calls).toBe(0);
	});

	it('reports the real clock', () => {
		const t = timerSpy();
		const host = createBrowserHost(() => fakeDocument().doc, t.api);
		expect(Math.abs(host.now() - Date.now())).toBeLessThan(1_000);
	});

	it('delegates timers to the injected api', () => {
		const t = timerSpy();
		const host = createBrowserHost(() => fakeDocument().doc, t.api);
		const handle = host.setTimer(() => {}, 4_242);
		expect(t.set).toEqual([{ ms: 4_242 }]);
		host.clearTimer(handle);
		expect(t.cleared).toEqual([handle]);
	});

	it('listens on visibilitychange and pageshow', () => {
		const d = fakeDocument();
		createBrowserHost(() => d.doc, timerSpy().api).onResume(() => {});
		expect(d.count('visibilitychange')).toBe(1);
		expect(d.count('pageshow')).toBe(1);
	});

	it('fires on the way BACK, not on the way out', () => {
		// The polarity is the whole point: a host that published on `hidden`
		// would tick when nobody is looking and leave the return unhandled —
		// the reported bug, restored.
		const d = fakeDocument();
		let fired = 0;
		createBrowserHost(() => d.doc, timerSpy().api).onResume(() => { fired++; });

		d.setVisibility('hidden');
		d.fire('visibilitychange');
		expect(fired).toBe(0);

		d.setVisibility('visible');
		d.fire('visibilitychange');
		expect(fired).toBe(1);
	});

	it('fires on pageshow regardless of visibility — bfcache restore', () => {
		const d = fakeDocument('hidden');
		let fired = 0;
		createBrowserHost(() => d.doc, timerSpy().api).onResume(() => { fired++; });
		d.fire('pageshow');
		expect(fired).toBe(1);
	});

	it('unsubscribes from both events', () => {
		const d = fakeDocument();
		let fired = 0;
		const off = createBrowserHost(() => d.doc, timerSpy().api).onResume(() => { fired++; });
		off();
		expect(d.count('visibilitychange')).toBe(0);
		expect(d.count('pageshow')).toBe(0);
		d.fire('pageshow');
		expect(fired).toBe(0);
	});
});

/**
 * The rune store is the one file here that no test can execute — a top-level
 * `$state` throws `$state is not defined` without the svelte plugin (measured).
 * A token search over it is a string count, not a guard: an earlier revision of
 * this file matched `startWallClock()` inside a COMMENTED-OUT line and stayed
 * green over the original bug.
 *
 * So the whole body is compared instead. The file is nineteen lines of
 * substance and changes rarely; a full comparison of an artefact like that is
 * closed where a deny-list is open. If it fails, read the diff and decide —
 * that friction is the point.
 */
describe('the rune adapter, pinned whole', () => {
	const normalise = (src: string): string =>
		src
			.replace(/\/\*[\s\S]*?\*\//g, '')
			.replace(/^[ \t]*\/\/.*$/gm, '')
			.split('\n').map((l) => l.trim()).filter((l) => l.length > 0).join('\n');

	const ADAPTER = normalise(readFileSync(
		fileURLToPath(new URL('../stores/wall-clock.svelte.ts', import.meta.url)), 'utf-8',
	));

	const EXPECTED = [
		"import { getGreeting, getTodaysQuote } from '../data/quotes.js';",
		"import { createBrowserHost, createWallClock } from '../utils/wall-clock-core.js';",
		'let _now = $state(Date.now());',
		'const clock = createWallClock(',
		'createBrowserHost(() => document, {',
		'setTimeout: (fn, ms) => window.setTimeout(fn, ms),',
		'clearTimeout: (handle) => window.clearTimeout(handle as number),',
		'}),',
		'(ms) => { _now = ms; },',
		');',
		'export function startWallClock(): () => void {',
		'return clock.start();',
		'}',
		'export function currentGreeting(locale: string): { text: string; punct: string } {',
		'return getGreeting(locale, _now);',
		'}',
		'export function currentQuote(): { text: string; author: string } {',
		'return getTodaysQuote(_now);',
		'}',
	].join('\n');

	it('has source to scan — the normaliser did not eat the file', () => {
		expect(ADAPTER.length).toBeGreaterThan(200);
	});

	it('is exactly this and nothing else', () => {
		expect(ADAPTER).toBe(EXPECTED);
	});
});

/**
 * ChatView wiring. Source-level because the component cannot be imported in
 * vitest either — but narrowed to what a regex can actually hold: the call
 * sites carry no timestamp any more, so the "passed `Date.now()` instead"
 * regression is unexpressible rather than merely forbidden.
 */
describe('ChatView is wired to the clock', () => {
	const RAW = readFileSync(
		fileURLToPath(new URL('../components/ChatView.svelte', import.meta.url)), 'utf-8',
	);
	// Full-line comments only: `//` also appears inside 40 URLs in this file, and
	// stripping those would corrupt the text being searched.
	const SRC = RAW
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/^[ \t]*\/\/.*$/gm, '');

	const occurrences = (needle: string): number => SRC.split(needle).length - 1;

	it('has source to scan — anchored on the markup, not on the import line', () => {
		expect(SRC).toContain('{@const greeting =');
		expect(SRC).toContain('{@const quote =');
	});

	it('takes the greeting from the clock, at every call site', () => {
		expect(occurrences('currentGreeting(')).toBe(1);
		expect(SRC).toMatch(/\{@const greeting = currentGreeting\(getLocale\(\)\)\}/);
	});

	it('takes the quote from the clock, at every call site', () => {
		expect(occurrences('currentQuote(')).toBe(1);
		expect(SRC).toMatch(/\{@const quote = currentQuote\(\)\}/);
	});

	it('never reaches past the store to the pickers', () => {
		// Importing getGreeting/getTodaysQuote here would mean a raw timestamp
		// again, and the argument is where this bug lived.
		expect(SRC).not.toContain('getGreeting');
		expect(SRC).not.toContain('getTodaysQuote');
	});

	it('starts the clock on mount and disposes it on teardown', () => {
		// Commenting these out is the cheapest way to reintroduce the bug, so the
		// comment strip above is load-bearing for this assertion.
		expect(SRC).toMatch(/const\s+stopClock\s*=\s*startWallClock\(\)/);
		expect(SRC).toMatch(/\n\s*stopClock\(\);/);
	});
});
