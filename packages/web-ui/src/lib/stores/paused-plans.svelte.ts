// How many plans wait for the owner's takeover, for the dot at "Automation" in the navigation
// (ux UX-032: a paused plan must be visible without the push).
//
// `GET /api/triggers/paused-count` answers `{ viewer, count }`; `count` is null for anyone but the
// owner, since a helper is not told about plans another helper's end paused. Asked once on mount;
// polled afterwards only while the latest answer names the owner, and only while the tab is
// visible. With the pause off, the count is 0 and no dot shows.

import { getApiBase } from '../config.svelte.js';

/** How often the owner's session asks while the page is open. */
export const PAUSED_PLANS_POLL_MS = 60_000;
/** How often a mount without any answer yet asks again. */
export const PAUSED_PLANS_RETRIES = 3;

let count = $state<number | null>(null);

/** The badge: paused plans, for the owner, or null when there is nothing to show. */
export function getPausedPlansBadge(): number | null {
	return count !== null && count > 0 ? count : null;
}

let generation = 0;
let askNow: (() => Promise<void>) | null = null;

/** Ask again now, e.g. after a takeover, so the dot follows without waiting for the poll. */
export function refreshPausedPlans(): void {
	void askNow?.();
}

/** Starts the count for this mount; returns a stop function. */
export function startPausedPlansNav(intervalMs = PAUSED_PLANS_POLL_MS): () => void {
	const mount = ++generation;
	count = null;
	let stopped = false;
	let reading = false;
	let answered = false;
	let failures = 0;
	let timer: ReturnType<typeof setInterval> | null = null;
	const onVisible = (): void => { if (document.visibilityState === 'visible') void ask(); };
	const startPoll = (): void => {
		if (timer !== null) return;
		timer = setInterval(() => { if (document.visibilityState === 'visible') void ask(); }, intervalMs);
		document.addEventListener('visibilitychange', onVisible);
	};
	const stopPoll = (): void => {
		if (timer !== null) clearInterval(timer);
		timer = null;
		document.removeEventListener('visibilitychange', onVisible);
	};

	async function ask(): Promise<void> {
		if (reading || stopped) return;
		reading = true;
		let answer: { viewer?: unknown; count?: unknown } | null = null;
		try {
			const res = await fetch(`${getApiBase()}/triggers/paused-count`);
			if (res.ok) answer = (await res.json()) as { viewer?: unknown; count?: unknown };
		} catch {
			answer = null;
		} finally {
			reading = false;
		}
		if (mount !== generation || stopped) return;
		// A failed read shows no number. Before any answer it is asked again on the poll, a few
		// times only: a helper's session would write each read to the owner's trail.
		if (answer === null) {
			count = null;
			if (!answered) { if (++failures <= PAUSED_PLANS_RETRIES) startPoll(); else stopPoll(); }
			return;
		}
		answered = true;
		if (answer.viewer !== 'owner') { count = null; stopPoll(); return; }
		count = typeof answer.count === 'number' && Number.isInteger(answer.count) && answer.count >= 0 ? answer.count : null;
		startPoll();
	}

	askNow = ask;
	void ask();
	return () => {
		stopped = true;
		stopPoll();
		if (askNow === ask) askNow = null;
	};
}
