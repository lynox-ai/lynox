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

/** Count of runs that are actively executing (`running`). A run awaiting the user is not
 * working — lynox waits for them — so it shows only as the nav dot of its thread, where it is
 * answered; a scheduled task's question can wait up to a day. Interrupted runs are surfaced
 * per-thread in the nav too, not counted as "live". */
export function countLiveRuns(runs: ActiveRun[]): number {
	return runs.filter((r) => r.status === 'running').length;
}

/** A live run this client can re-attach to after its own `/run` SSE dropped
 * mid-run: the run for THIS thread that is still running/awaiting the user.
 * `interrupted` is excluded — there is no cross-restart resume, so it gets the
 * Retry banner path, not a re-attach. */
export interface ReattachTarget {
	runId: string;
	lastPersistedSeq: number;
	/** Whether the run is working or waits for the user's answer. */
	status: 'running' | 'awaiting_input';
}

/**
 * What a re-attach attempt actually established.
 *
 * `no-run` and `unreachable` used to be the same `false`, and the caller drew
 * "the run never started" from it. They are opposite facts: `no-run` means the
 * server ANSWERED and has nothing live (so the turn either never started or
 * already finished), while `unreachable` means we learned nothing at all —
 * which is the ordinary situation when an SSE stream drops because the network
 * went away, i.e. precisely when the conflation fires.
 */
export type ReattachOutcome = 'took-over' | 'no-run' | 'unreachable';

/**
 * May a turn that was marked failed WITHOUT server confirmation be re-sent
 * automatically on reconnect?
 *
 * Pure so it can be tested without a store, a network, or a browser. The rule
 * is default-deny in both unhappy directions, because the cost is asymmetric:
 * declining to auto-refire leaves the user's own tap-to-retry — which the
 * failed bubble already offers — while re-firing a turn the server already
 * answered runs and BILLS it a second time.
 */
/**
 * After the SSE read loop ends: must the client ASK THE SERVER what became of
 * this turn, or is its fate already established?
 *
 * Pure for the same reason as {@link shouldRefireOfflineTurn} — this is the
 * condition a duplicate-billing bug hides in, and it must be assertable without
 * a store, a browser or a network.
 *
 * The rule, and the one that changed on 2026-08-23: `done` is the ONLY event
 * that establishes an end. `error` does not, because one channel carried two
 * meanings — a dead turn (`agent.ts` iteration limit) and a non-fatal incident
 * the engine recovers from (`stream.ts` unparsable tool input, which substitutes
 * `input:{}` and continues). The wire now carries a `fatal` flag that separates
 * them, and this rule deliberately does NOT depend on it: asking the server is
 * correct for both, so the probe stays the wider net and the flag can be adopted
 * without this predicate changing meaning. Treating `error` as terminal skipped
 * the probe entirely, so a run that was still executing — measured at 152 s
 * with four spawned sub-agents — rendered as "not sent, tap to retry", offering
 * the user a second purchase of a turn already being billed.
 */
export function shouldProbeServerAfterStream(state: {
	/** A terminal `done` event arrived. */
	sawDone: boolean;
	/** An `error` event arrived — says nothing about whether the run ended. */
	sawErrorEvent: boolean;
	/** The store still considered itself streaming when the loop ended. */
	isStreaming: boolean;
	/** The user pressed stop for THIS run epoch. */
	userStopped: boolean;
}): boolean {
	// A deliberate stop is not a drop and never a failure.
	if (state.userStopped) return false;
	// `done` means the run reached a real end; nothing to ask.
	if (state.sawDone) return false;
	// `isStreaming` is the ordinary "we were mid-run" signal. `sawErrorEvent` is
	// named SEPARATELY because the error handler clears `isStreaming` to stop the
	// spinner — without this disjunct the probe would be unreachable for exactly
	// the case it exists for.
	return state.isStreaming || state.sawErrorEvent;
}

export function shouldRefireOfflineTurn(probe: {
	/** Did the transcript probe actually reach the server AND parse? */
	reached: boolean;
	/** Role of the last persisted message, when it did. */
	lastRole: string | undefined;
	/**
	 * Is a run for THIS thread still live server-side? Asked because the
	 * transcript alone cannot answer it: a run that is still executing has not
	 * persisted its assistant message yet, so the thread legitimately ends on the
	 * user turn — indistinguishable from "never started" by role alone. Acting on
	 * that reading re-POSTs into a live run, earns a 409, and sends the queue
	 * poller round for minutes until the run it is duplicating finally ends.
	 * `undefined` = not asked / could not be asked, which is treated as blind.
	 */
	activeRun?: boolean | undefined;
}): boolean {
	// A live run settles it before any transcript reasoning: the turn is not
	// lost, it is in progress. This check comes FIRST because the transcript
	// evidence in that situation actively points the wrong way.
	if (probe.activeRun === true) return false;
	// Still blind: an auto-refire here would be the same guess that created the
	// problem, only now it costs a run.
	if (!probe.reached) return false;
	// Never asked whether a run is live → we do not know the one fact that can
	// make the transcript misleading. Default-deny, same asymmetry as above.
	if (probe.activeRun === undefined) return false;
	// The thread ends on an assistant message: the turn was answered and billed
	// inside the drop window. Re-sending it is the duplicate.
	return probe.lastRole !== 'assistant';
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
				status,
			};
		}
	}
	return null;
}

/** A failure note as the transcript carries it on a display-only assistant row. */
export interface TurnNote {
	code: string;
	detail?: string;
}

/**
 * The note an ended run left at the end of the transcript, read from the
 * `/threads/:id/messages` body — or null when the thread does not end on one.
 *
 * Asked after a stream ended without a terminal event while the turn had already
 * rendered something (thinking, text, tool calls). The server writes a note when
 * a run stops early (interrupted, a loop break, a cap), but the `/run` stream of an
 * aborted run ends without `done`, so the note never reaches the live client; only
 * a reload showed it. Whatever the note is, a reload would show the same row.
 *
 * `localUserTurns` counts the user messages this client shows that the server
 * holds too (the caller leaves out queued and unsent ones). The note must belong
 * to THIS turn, and the only proof the transcript offers is that its user rows are
 * the client's user rows: fewer means it ends on an EARLIER turn, more means
 * someone else (another tab, another device) sent into the thread since, and the
 * note may be theirs. Both are refused, never guessed — the cost of refusing is
 * today's behaviour (no note until a reload). Blank user rows are left out of the
 * server's count, because the client drops them too (they are ask_user answers).
 */
export function trailingTurnNote(body: unknown, localUserTurns: number): TurnNote | null {
	if (typeof body !== 'object' || body === null) return null;
	const rows = (body as { messages?: unknown }).messages;
	if (!Array.isArray(rows) || rows.length === 0) return null;
	const last: unknown = rows[rows.length - 1];
	if (typeof last !== 'object' || last === null) return null;
	const { role, note } = last as { role?: unknown; note?: unknown };
	if (role !== 'assistant' || typeof note !== 'object' || note === null) return null;
	const { code, detail } = note as { code?: unknown; detail?: unknown };
	if (typeof code !== 'string' || code.length === 0) return null;
	const userRows = rows.filter((r) => {
		if (typeof r !== 'object' || r === null) return false;
		const { role: rr, content } = r as { role?: unknown; content?: unknown };
		return rr === 'user' && typeof content === 'string' && content.trim().length > 0;
	}).length;
	if (userRows !== localUserTurns) return null;
	return typeof detail === 'string' ? { code, detail } : { code };
}

/**
 * Put `note` as its own row right after the turn's bubble at `afterIdx`, unless
 * that row already carries it. The bubble itself is left as it is: the server
 * does not persist an answer the abort cut off, so replacing the bubble with the
 * transcript would delete text the user has already read.
 *
 * Idempotent so that no path can stack the same note twice under one bubble.
 * Today the caller runs once per turn; the check is the guard for the day a
 * second pass appears. A later reconcile or reload replaces the rows from the
 * server, which holds the note once. Returns whether a row was added.
 */
export function appendNoteOnce<M extends { role: string; content: string; note?: TurnNote | undefined }>(
	rows: M[],
	afterIdx: number,
	note: TurnNote,
	make: (note: TurnNote) => M,
): boolean {
	const next = rows[afterIdx + 1];
	if (next && next.role === 'assistant' && next.note?.code === note.code) return false;
	rows.splice(afterIdx + 1, 0, make(note));
	return true;
}
