import { describe, it, expect } from 'vitest';

import { parseActiveRuns, countLiveRuns, selectReattachTarget } from './active-runs.js';

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
