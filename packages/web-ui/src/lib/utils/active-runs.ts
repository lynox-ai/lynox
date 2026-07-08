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

/** A live run this client can re-attach to after its own `/run` SSE dropped
 * mid-run: the run for THIS thread that is still running/awaiting the user.
 * `interrupted` is excluded — there is no cross-restart resume, so it gets the
 * Retry banner path, not a re-attach. */
export interface ReattachTarget {
	runId: string;
	lastPersistedSeq: number;
}

/**
 * Pick the re-attach target for `threadId` from the `/api/runs/active` body, or
 * null if none. Same envelope tolerance as `parseActiveRuns` (null/missing
 * `runs`/non-object rows degrade to null, never throw), but keeps `runId` +
 * `lastPersistedSeq` (which `parseActiveRuns` drops) so the caller can open
 * `GET /runs/:runId/stream?since=`. A non-numeric `lastPersistedSeq` falls back
 * to 0 (replay from the durable start).
 */
export function selectReattachTarget(body: unknown, threadId: string): ReattachTarget | null {
	if (typeof body !== 'object' || body === null) return null;
	const runs = (body as { runs?: unknown }).runs;
	if (!Array.isArray(runs)) return null;
	for (const r of runs) {
		if (typeof r !== 'object' || r === null) continue;
		const { runId, threadId: tid, status, lastPersistedSeq } = r as {
			runId?: unknown; threadId?: unknown; status?: unknown; lastPersistedSeq?: unknown;
		};
		if (tid === threadId && typeof runId === 'string' && runId.length > 0
			&& (status === 'running' || status === 'awaiting_input')) {
			return {
				runId,
				lastPersistedSeq: typeof lastPersistedSeq === 'number' && Number.isFinite(lastPersistedSeq)
					? lastPersistedSeq : 0,
			};
		}
	}
	return null;
}
