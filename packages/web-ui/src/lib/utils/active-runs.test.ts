import { describe, it, expect } from 'vitest';

import { parseActiveRuns, countLiveRuns } from './active-runs.js';

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
