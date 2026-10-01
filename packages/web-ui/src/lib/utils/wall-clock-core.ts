/*
 * The welcome screen's wall clock: scheduling and browser glue, with the
 * browser injected.
 *
 * It lives outside the rune store because that store cannot be tested — the
 * root vitest config has no svelte plugin, so importing a module with a
 * top-level `$state` throws `$state is not defined` (measured, not assumed).
 * Anything guarded only by a regex over source text is guarded by a string
 * count, so as much as possible is moved in here where a test can drive it:
 * the scheduling, the resume handling, AND the browser host itself.
 *
 * What the clock is for: a page resumed after hours. A phone put down at night
 * and picked up at noon fires no timer, because the browser suspends them while
 * the page is hidden — so the resume event, not the timer, is the load-bearing
 * path, and it needs a test that can fail.
 */

/**
 * Milliseconds from a local clock reading to the next full hour.
 *
 * Takes the components rather than a Date so it is pure integer arithmetic with
 * no timezone in it: correct for zones at :30 and :45 offsets, where the next
 * full LOCAL hour is not the next full UTC hour.
 *
 * Always in (0, 3_600_000] for any real clock reading — never 0, which would
 * schedule a zero-delay timer that re-fires immediately. (The bound is a
 * statement about callers: `minutes` comes from `Date#getMinutes`, so it is
 * 0–59. Passing 60 would return 0, and nothing here can.)
 */
export function msToNextHour(minutes: number, seconds: number, millis: number): number {
	const intoHour = minutes * 60_000 + seconds * 1_000 + millis;
	return 3_600_000 - intoHour;
}

/**
 * Milliseconds to the next full LOCAL hour after `nowMs`.
 *
 * Derived from a single timestamp on purpose. An earlier shape asked the host
 * for the time and for its clock components separately, which is two reads of a
 * moving clock: if a boundary fell between them, the tick was aimed a full hour
 * late and the screen showed the wrong slot for an hour — the exact defect this
 * whole module exists to prevent.
 */
export function msToNextHourFrom(nowMs: number): number {
	const d = new Date(nowMs);
	return msToNextHour(d.getMinutes(), d.getSeconds(), d.getMilliseconds());
}

/** The browser surface the clock needs, narrowed to what it actually uses. */
export interface WallClockHost {
	/** Current epoch milliseconds. */
	now(): number;
	setTimer(fn: () => void, ms: number): unknown;
	clearTimer(handle: unknown): void;
	/** Subscribe to "the page came back"; returns an unsubscribe. */
	onResume(handler: () => void): () => void;
}

/** The slice of `document` the browser host touches. Narrow so a test can fake it. */
export interface ResumeDocument {
	readonly visibilityState: string;
	addEventListener(type: string, listener: () => void): void;
	removeEventListener(type: string, listener: () => void): void;
}

/** The slice of the global timer API the browser host touches. */
export interface TimerApi {
	setTimeout(fn: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

/**
 * Build the real browser host.
 *
 * `getDocument` is a thunk, not a value: this module is imported at page load
 * and must not touch `document` then. The chat route is client-only today
 * (`routes/app/+layout.ts` sets `ssr = false`), but ChatView is a package export
 * and a downstream consumer could render it on a server.
 *
 * Resume is BOTH `visibilitychange` (to visible) and `pageshow`. The second is
 * not redundant: a back-forward-cache restore is a resume that does not always
 * arrive as a visibility transition, and bfcache is exactly how a mobile browser
 * brings back a page that has been away for hours.
 */
export function createBrowserHost(getDocument: () => ResumeDocument, timers: TimerApi): WallClockHost {
	return {
		now: () => Date.now(),
		setTimer: (fn, ms) => timers.setTimeout(fn, ms),
		clearTimer: (handle) => timers.clearTimeout(handle),
		onResume: (handler) => {
			const doc = getDocument();
			const onVisibility = (): void => {
				// Only on the way back. Firing on `hidden` would tick at exactly
				// the moment nobody is looking and leave the return unhandled.
				if (doc.visibilityState === 'visible') handler();
			};
			doc.addEventListener('visibilitychange', onVisibility);
			doc.addEventListener('pageshow', handler);
			return () => {
				doc.removeEventListener('visibilitychange', onVisibility);
				doc.removeEventListener('pageshow', handler);
			};
		},
	};
}

export interface WallClock {
	/** Start ticking. Reference-counted: returns a disposer for THIS start. */
	start(): () => void;
}

/**
 * Build a clock that republishes the current time on every hour boundary and
 * whenever the page comes back.
 *
 * Reference-counted because ChatView is a package export: two mounted copies,
 * or a `{#key}` swap whose teardown runs after the new mount, would otherwise
 * let one disposer stop the clock for everyone — silently restoring the bug
 * this module fixes. A disposer is idempotent; calling it twice does not
 * double-decrement.
 */
export function createWallClock(host: WallClockHost, publish: (ms: number) => void): WallClock {
	let timer: unknown = null;
	let unsubscribe: (() => void) | null = null;
	let holders = 0;

	const schedule = (fromMs: number): void => {
		timer = host.setTimer(() => {
			const t = host.now();
			publish(t);
			schedule(t);
		}, msToNextHourFrom(fromMs));
	};

	const stop = (): void => {
		if (timer !== null) {
			host.clearTimer(timer);
			timer = null;
		}
		if (unsubscribe !== null) {
			unsubscribe();
			unsubscribe = null;
		}
	};

	return {
		start(): () => void {
			if (holders === 0) {
				// Subscribe FIRST: if it throws, nothing has been scheduled and
				// there is no orphaned timer to leak.
				unsubscribe = host.onResume(() => {
					const t = host.now();
					publish(t);
					// The pending timer was aimed at a boundary that may have gone
					// by while the page was away; re-aim it at the next one.
					if (timer !== null) host.clearTimer(timer);
					schedule(t);
				});
				const t0 = host.now();
				publish(t0);
				schedule(t0);
			}
			holders++;

			let disposed = false;
			return () => {
				if (disposed) return;
				disposed = true;
				holders--;
				if (holders === 0) stop();
			};
		},
	};
}
