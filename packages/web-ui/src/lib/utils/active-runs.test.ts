import { describe, it, expect } from 'vitest';

import { parseActiveRuns, countLiveRuns, selectReattachTarget, shouldRefireOfflineTurn, shouldProbeServerAfterStream } from './active-runs.js';

/**
 * Locks the GET /api/runs/active wire contract shared by the thread-history nav
 * dot and the StatusBar live-run counter: only the three known states count,
 * malformed/older payloads degrade to "no runs" instead of throwing, and the
 * StatusBar count excludes interrupted runs (those are surfaced per-thread).
 */
describe('parseActiveRuns', () => {
	it('returns [] for null/missing/non-array bodies', () => {
		expect(parseActiveRuns(null)).toEqual([]);
		expect(parseActiveRuns(undefined)).toEqual([]);
		expect(parseActiveRuns('nope')).toEqual([]);
		expect(parseActiveRuns({})).toEqual([]);
		expect(parseActiveRuns({ runs: 'not-an-array' })).toEqual([]);
	});

	it('keeps the three known states keyed by threadId', () => {
		const parsed = parseActiveRuns({
			runs: [
				{ threadId: 't1', status: 'running' },
				{ threadId: 't2', status: 'awaiting_input' },
				{ threadId: 't3', status: 'interrupted' },
			],
		});
		expect(parsed).toEqual([
			{ threadId: 't1', status: 'running' },
			{ threadId: 't2', status: 'awaiting_input' },
			{ threadId: 't3', status: 'interrupted' },
		]);
	});

	it('drops rows with an unknown status, missing/empty threadId, or wrong shape', () => {
		const parsed = parseActiveRuns({
			runs: [
				{ threadId: 't1', status: 'done' },        // terminal — should never arrive, dropped
				{ threadId: 't2', status: 'error' },       // ditto
				{ threadId: '', status: 'running' },       // empty id
				{ status: 'running' },                      // no id
				{ threadId: 't5' },                         // no status
				null,                                       // non-object row
				42,                                         // non-object row
				{ threadId: 't8', status: 'running' },     // the one valid row
			],
		});
		expect(parsed).toEqual([{ threadId: 't8', status: 'running' }]);
	});
});

describe('countLiveRuns', () => {
	it('counts running + awaiting_input but NOT interrupted', () => {
		const runs = parseActiveRuns({
			runs: [
				{ threadId: 't1', status: 'running' },
				{ threadId: 't2', status: 'awaiting_input' },
				{ threadId: 't3', status: 'interrupted' },
			],
		});
		expect(countLiveRuns(runs)).toBe(2);
	});

	it('is 0 for an empty list', () => {
		expect(countLiveRuns([])).toBe(0);
	});
});

/**
 * Locks the re-attach target selection used by the client's mid-run SSE-drop
 * recovery (#83): pick THIS thread's still-live run from /api/runs/active,
 * keeping runId + lastPersistedSeq; exclude interrupted (Retry-banner path, no
 * resume); tolerate malformed payloads.
 */
describe('selectReattachTarget', () => {
	it('returns the matching thread\'s running/awaiting_input run with runId + seq', () => {
		expect(selectReattachTarget({ runs: [{ threadId: 't1', runId: 'r1', status: 'running', lastPersistedSeq: 12 }] }, 't1'))
			.toEqual({ runId: 'r1', lastPersistedSeq: 12 });
		expect(selectReattachTarget({ runs: [{ threadId: 't1', runId: 'r1', status: 'awaiting_input', lastPersistedSeq: 3 }] }, 't1'))
			.toEqual({ runId: 'r1', lastPersistedSeq: 3 });
	});

	it('returns null for null/missing/non-array bodies', () => {
		expect(selectReattachTarget(null, 't1')).toBeNull();
		expect(selectReattachTarget(undefined, 't1')).toBeNull();
		expect(selectReattachTarget('nope', 't1')).toBeNull();
		expect(selectReattachTarget({}, 't1')).toBeNull();
		expect(selectReattachTarget({ runs: 'x' }, 't1')).toBeNull();
	});

	it('excludes interrupted, terminal, other-thread, and malformed runs', () => {
		const body = { runs: [
			{ threadId: 't1', runId: 'ri', status: 'interrupted', lastPersistedSeq: 1 }, // no cross-restart resume
			{ threadId: 't1', runId: 'rd', status: 'done', lastPersistedSeq: 1 },        // terminal
			{ threadId: 't2', runId: 'ro', status: 'running', lastPersistedSeq: 1 },     // other thread
			{ threadId: 't1', status: 'running', lastPersistedSeq: 1 },                  // no runId
			{ threadId: 't1', runId: '', status: 'running', lastPersistedSeq: 1 },       // empty runId
			null, 42,
		] };
		expect(selectReattachTarget(body, 't1')).toBeNull();
	});

	it('picks the matching-thread run even amid other rows', () => {
		const body = { runs: [
			{ threadId: 't2', runId: 'ro', status: 'running', lastPersistedSeq: 9 },
			{ threadId: 't1', runId: 'r1', status: 'awaiting_input', lastPersistedSeq: 7 },
		] };
		expect(selectReattachTarget(body, 't1')).toEqual({ runId: 'r1', lastPersistedSeq: 7 });
	});

	it('defaults a missing/non-numeric lastPersistedSeq to 0 (replay from durable start)', () => {
		expect(selectReattachTarget({ runs: [{ threadId: 't1', runId: 'r1', status: 'running' }] }, 't1'))
			.toEqual({ runId: 'r1', lastPersistedSeq: 0 });
		expect(selectReattachTarget({ runs: [{ threadId: 't1', runId: 'r1', status: 'running', lastPersistedSeq: 'x' }] }, 't1'))
			.toEqual({ runId: 'r1', lastPersistedSeq: 0 });
	});
});

describe('shouldRefireOfflineTurn', () => {
	// The turn under discussion was marked failed WITHOUT server confirmation:
	// both probes were blind, which is the ordinary shape of "the network went
	// away" — and that is also the commonest reason the SSE stream dropped. So
	// "failed" was a guess, and acting on it costs a second billed run.

	it('declines when the thread already ends on an assistant message', () => {
		// The run finished inside the drop window and is persisted and billed.
		// Re-sending it IS the duplicate.
		expect(shouldRefireOfflineTurn({ reached: true, lastRole: 'assistant', activeRun: false })).toBe(false);
	});

	it('allows the refire when the server confirms no live run AND a thread still ending on the user', () => {
		expect(shouldRefireOfflineTurn({ reached: true, lastRole: 'user', activeRun: false })).toBe(true);
	});

	it('declines while a run for this thread is still LIVE — the transcript points the wrong way here', () => {
		// The case the transcript alone cannot decide: a run that is still
		// executing has not persisted its assistant message, so the thread
		// legitimately ends on the user turn — identical, by role, to "never
		// started". Acting on that reading re-POSTs into a live run, earns a 409
		// and sends the queue poller round for minutes duplicating the very run
		// it is waiting for. The live-run answer therefore wins over every
		// transcript reading, including the empty one.
		expect(shouldRefireOfflineTurn({ reached: true, lastRole: 'user', activeRun: true })).toBe(false);
		expect(shouldRefireOfflineTurn({ reached: true, lastRole: undefined, activeRun: true })).toBe(false);
	});

	it('declines when the live-run question was never answered', () => {
		// `/runs/active` unreachable → we lack the one fact that can make the
		// transcript misleading. Same asymmetry as an unreachable transcript:
		// declining costs a tap, refiring costs a run.
		expect(shouldRefireOfflineTurn({ reached: true, lastRole: 'user', activeRun: undefined })).toBe(false);
	});

	it('declines while the server is still unreachable — even though nothing contradicts a refire', () => {
		// The asymmetry is the whole point: declining leaves the user's own
		// tap-to-retry on the failed bubble, while refiring on a second guess
		// spends money. `lastRole` is deliberately varied to show the outcome
		// does not depend on it once the probe failed.
		expect(shouldRefireOfflineTurn({ reached: false, lastRole: undefined, activeRun: false })).toBe(false);
		expect(shouldRefireOfflineTurn({ reached: false, lastRole: 'user', activeRun: false })).toBe(false);
		expect(shouldRefireOfflineTurn({ reached: false, lastRole: 'assistant', activeRun: false })).toBe(false);
	});

	it('treats an empty transcript as refireable once the server answered on BOTH probes', () => {
		// A reachable server with no messages at all and no live run means the
		// turn genuinely never landed — the one case the original auto-refire got
		// right, and the one this must keep working. Without it the fix would
		// have swapped "always refires" for "never refires".
		expect(shouldRefireOfflineTurn({ reached: true, lastRole: undefined, activeRun: false })).toBe(true);
	});
});

describe('shouldProbeServerAfterStream', () => {
	// The condition that decides whether a finished SSE read loop asks the server
	// what became of the turn. Everything downstream — the re-attach, the
	// transcript check, `failedOffline`, the failed bubble's tap-to-retry — sits
	// behind it, so when this returns false none of that guard runs at all.

	it('probes when an `error` arrived and nothing else established an end', () => {
		// THE regression. The engine emits `type:'error'` both for a dead turn and
		// for an incident it recovers from (`stream.ts` unparsable tool input →
		// `input:{}` → the turn CONTINUES). Counting `error` as terminal skipped
		// this probe, so a run measured at 152 s with four spawned sub-agents
		// rendered as "not sent — tap to retry": the only offered action was
		// buying a second copy of a turn already being billed.
		// `isStreaming` is false because the error handler clears it to stop the
		// spinner — which is exactly why `sawErrorEvent` has to be its own input.
		expect(shouldProbeServerAfterStream({
			sawDone: false, sawErrorEvent: true, isStreaming: false, userStopped: false,
		})).toBe(true);
	});

	it('probes on a bare transport drop (no terminal event at all)', () => {
		expect(shouldProbeServerAfterStream({
			sawDone: false, sawErrorEvent: false, isStreaming: true, userStopped: false,
		})).toBe(true);
	});

	it('does NOT probe once `done` established a real end', () => {
		// The counter-direction: a fix against "asks too rarely" must not become
		// "asks always". A completed turn costs a needless /runs/active round trip
		// per run, and `done` is the one event that genuinely settles the question.
		expect(shouldProbeServerAfterStream({
			sawDone: true, sawErrorEvent: false, isStreaming: true, userStopped: false,
		})).toBe(false);
		// `done` wins even when an error was also seen earlier in the stream.
		expect(shouldProbeServerAfterStream({
			sawDone: true, sawErrorEvent: true, isStreaming: true, userStopped: false,
		})).toBe(false);
	});

	it('does NOT probe after a deliberate stop', () => {
		// A user stop ends a stream terminal-less, i.e. looks exactly like a drop.
		// Probing would resurrect the turn the user just cancelled.
		expect(shouldProbeServerAfterStream({
			sawDone: false, sawErrorEvent: true, isStreaming: true, userStopped: true,
		})).toBe(false);
		expect(shouldProbeServerAfterStream({
			sawDone: false, sawErrorEvent: false, isStreaming: true, userStopped: true,
		})).toBe(false);
	});

	it('does NOT probe when the loop ended outside a run', () => {
		// Neither streaming nor an error: nothing happened that needs asking about.
		expect(shouldProbeServerAfterStream({
			sawDone: false, sawErrorEvent: false, isStreaming: false, userStopped: false,
		})).toBe(false);
	});
});
