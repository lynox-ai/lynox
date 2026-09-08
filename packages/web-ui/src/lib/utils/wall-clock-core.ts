/*
 * The scheduling half of the welcome screen's wall clock, with the browser
 * injected.
 *
 * It lives outside the rune store because the store cannot be tested: the root
 * vitest config has no svelte plugin, so importing a module with a top-level
 * `$state` throws `$state is not defined` (measured, not assumed). Everything
 * with a decision in it therefore lives here, and stores/wall-clock.svelte.ts is
 * a thin adapter that supplies the real browser and holds the reactive cell.
 *
 * The split is not cosmetic. The failure this clock exists to prevent is a page
 * resumed after hours — a phone put down at night and picked up at noon — and
 * that path runs through the visibility handler, not the timer, because iOS
 * suspends timers while the page is hidden. Left inside the rune module, the
 * one load-bearing branch would have had no test that could fail.
 */

/**
 * Milliseconds from a local clock reading to the next full hour.
 *
 * Takes the components rather than a Date so it is pure integer arithmetic with
 * no timezone in it: correct for zones at :30 and :45 offsets, where the next
 * full LOCAL hour is not the next full UTC hour.
 *
 * Always in (0, 3_600_000] — never 0, which would schedule a zero-delay timer
 * that re-fires immediately.
 */
export function msToNextHour(minutes: number, seconds: number, millis: number): number {
	const intoHour = minutes * 60_000 + seconds * 1_000 + millis;
	return 3_600_000 - intoHour;
}

/** The browser surface the clock needs, narrowed to what it actually uses. */
export interface WallClockHost {
	/** Current epoch milliseconds. */
	now(): number;
	/** Local wall-clock components of `now()`, for the next-hour computation. */
	clockParts(): { minutes: number; seconds: number; millis: number };
	setTimer(fn: () => void, ms: number): unknown;
	clearTimer(handle: unknown): void;
	/** Subscribe to "the document became visible again"; returns an unsubscribe. */
	onVisible(handler: () => void): () => void;
}

export interface WallClock {
	start(): void;
	stop(): void;
}

/**
 * Build a clock that republishes the current time on every hour boundary and
 * whenever the page comes back into view.
 *
 * `publish` receives the new reading; the adapter writes it into reactive state.
 */
export function createWallClock(host: WallClockHost, publish: (ms: number) => void): WallClock {
	let timer: unknown = null;
	let unsubscribe: (() => void) | null = null;

	const schedule = (): void => {
		const { minutes, seconds, millis } = host.clockParts();
		timer = host.setTimer(() => {
			publish(host.now());
			schedule();
		}, msToNextHour(minutes, seconds, millis));
	};

	return {
		start(): void {
			// Idempotent: a component re-mount (or HMR) must not leave a second
			// timer and a second listener running behind the module-level state.
			if (unsubscribe !== null) return;
			publish(host.now());
			schedule();
			unsubscribe = host.onVisible(() => {
				publish(host.now());
				// The pending timer was aimed at a boundary that may have passed
				// while the page was hidden; re-aim it at the next one.
				if (timer !== null) host.clearTimer(timer);
				schedule();
			});
		},

		stop(): void {
			if (timer !== null) {
				host.clearTimer(timer);
				timer = null;
			}
			if (unsubscribe !== null) {
				unsubscribe();
				unsubscribe = null;
			}
		},
	};
}
