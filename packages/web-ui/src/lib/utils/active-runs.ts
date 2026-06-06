/**
 * Shared parser for the GET /api/runs/active wire shape.
 *
 * Two consumers must agree on exactly which run states count and how the
 * envelope is read: the thread-history nav dot (threads.svelte.ts) and the
 * StatusBar live-run counter. Centralising the parse here keeps that contract
 * in one place — and, unlike the `$state`-bearing `.svelte.ts` store, this is a
 * plain module that can be unit-tested directly.
 *
 * `done`/`error` runs are already removed from the registry server-side, so the
 * only states that ever arrive are the three below. Anything else (a future
 * status, a malformed row) is dropped rather than trusted.
 */

/** The run states the UI surfaces. `awaiting_input` is derived server-side from
 * a pending prompt; `interrupted` is a run the engine restart killed. */
export type ActiveRunStatus = 'running' | 'awaiting_input' | 'interrupted';

export interface ActiveRun {
	threadId: string;
	status: ActiveRunStatus;
}

function isActiveRunStatus(s: unknown): s is ActiveRunStatus {
	return s === 'running' || s === 'awaiting_input' || s === 'interrupted';
}

/**
 * Normalise the `/api/runs/active` JSON body into typed entries, dropping any
 * row without a thread id or with an unknown status. Tolerant of `null`,
 * missing `runs`, and non-object rows so a malformed/older payload degrades to
 * "no active runs" rather than throwing in the poll loop.
 */
export function parseActiveRuns(body: unknown): ActiveRun[] {
	if (typeof body !== 'object' || body === null) return [];
	const runs = (body as { runs?: unknown }).runs;
	if (!Array.isArray(runs)) return [];
	const out: ActiveRun[] = [];
	for (const r of runs) {
		if (typeof r !== 'object' || r === null) continue;
		const { threadId, status } = r as { threadId?: unknown; status?: unknown };
		if (typeof threadId === 'string' && threadId.length > 0 && isActiveRunStatus(status)) {
			out.push({ threadId, status });
		}
	}
	return out;
}

/** Count of runs that are actively executing (running + awaiting_input).
 * Interrupted runs are surfaced per-thread in the nav, not counted as "live". */
export function countLiveRuns(runs: ActiveRun[]): number {
	return runs.filter((r) => r.status === 'running' || r.status === 'awaiting_input').length;
}
