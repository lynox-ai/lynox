import { describe, it, expect } from 'vitest';
import { bulkRunHref, carryPlannedBulkRuns, followUpsWithoutRun, plannedBulkRunId } from './planned-bulk-run.js';

const RUN = '3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b';
const OTHER = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

describe('plannedBulkRunId', () => {
	it('takes an id in the ledger\'s form', () => {
		expect(plannedBulkRunId({ runId: RUN })).toBe(RUN);
	});

	it.each([
		['missing', {}],
		['a number', { runId: 7 }],
		['upper-case hex', { runId: RUN.toUpperCase() }],
		['a trailing query', { runId: `${RUN}&x=1` }],
		['a leading path', { runId: `../${RUN}` }],
		['a line break after it', { runId: `${RUN}\n` }],
		['an address', { runId: 'https://evil.example/' }],
	])('refuses anything else (%s)', (_kind, data) => {
		expect(plannedBulkRunId(data)).toBeNull();
	});
});

describe('bulkRunHref', () => {
	it('is the run\'s page under Activity › Bulk runs', () => {
		expect(bulkRunHref(RUN)).toBe(`/app/activity?tab=bulk&run=${RUN}`);
	});
});

describe('followUpsWithoutRun', () => {
	const keep = { label: 'Weitere Produkte', task: 'Plane dasselbe für Hunde' };

	it('drops a chip whose task or label names the run, in any case, and keeps the others', () => {
		const inTask = { label: 'Stand', task: `Zeig Lauf ${RUN}` };
		const inLabel = { label: `Lauf ${RUN.toUpperCase()}`, task: 'Zeig den Stand' };
		expect(followUpsWithoutRun([inTask, keep, inLabel], RUN)).toEqual([keep]);
	});

	it('keeps a chip that names another run, and every chip when no run was planned', () => {
		const other = { label: 'Alter Lauf', task: `Zeig Lauf ${OTHER}` };
		expect(followUpsWithoutRun([other, keep], RUN)).toEqual([other, keep]);
		const withRun = { label: 'Stand', task: `Zeig Lauf ${RUN}` };
		expect(followUpsWithoutRun([withRun, keep], undefined)).toEqual([withRun, keep]);
	});
});

describe('carryPlannedBulkRuns', () => {
	it('gives the run id to the adopted twin of the answer that carried it', () => {
		const local = [
			{ role: 'user', content: 'Plane' },
			{ role: 'assistant', content: 'Geplant.', plannedBulkRunId: RUN },
		];
		const adopted: Array<{ role: string; content: string; plannedBulkRunId?: string }> = [
			{ role: 'user', content: 'Plane' },
			{ role: 'assistant', content: 'Geplant.' },
		];
		carryPlannedBulkRuns(local, adopted);
		expect(adopted[1]!.plannedBulkRunId).toBe(RUN);
		expect(adopted[0]!.plannedBulkRunId).toBeUndefined();
	});

	it('puts it on the twin in the same place, not on an earlier answer with the same text', () => {
		const local = [
			{ role: 'assistant', content: 'Erledigt.' },
			{ role: 'assistant', content: 'Erledigt.', plannedBulkRunId: RUN },
		];
		const adopted: Array<{ role: string; content: string; plannedBulkRunId?: string }> = [
			{ role: 'assistant', content: 'Erledigt.' },
			{ role: 'assistant', content: 'Erledigt.' },
		];
		carryPlannedBulkRuns(local, adopted);
		expect(adopted.map((m) => m.plannedBulkRunId)).toEqual([undefined, RUN]);
	});

	it('puts it nowhere when the answer has no twin', () => {
		const adopted: Array<{ role: string; content: string; plannedBulkRunId?: string }> = [{ role: 'assistant', content: 'Anders.' }];
		carryPlannedBulkRuns([{ role: 'assistant', content: 'Geplant.', plannedBulkRunId: RUN }], adopted);
		expect(adopted[0]!.plannedBulkRunId).toBeUndefined();
	});
});
