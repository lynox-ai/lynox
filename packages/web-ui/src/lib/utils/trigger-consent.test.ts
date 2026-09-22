import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineDb } from '../../../../../src/core/engine-db.js';
import { TriggerStore, type TriggerRow } from '../../../../../src/core/trigger-store.js';
import { awaitsConfirmation } from './trigger-consent.js';

describe('awaitsConfirmation', () => {
	it('is true for an agent run with no confirmation, whether the field is absent or null', () => {
		expect(awaitsConfirmation({ effect: 'run_agent' })).toBe(true);
		expect(awaitsConfirmation({ effect: 'run_agent', confirmed_at: undefined })).toBe(true);
		expect(awaitsConfirmation({ effect: 'run_agent', confirmed_at: null })).toBe(true);
	});

	it('is false once the agent run is confirmed', () => {
		expect(awaitsConfirmation({ effect: 'run_agent', confirmed_at: '2026-09-22T10:00:00.000Z' })).toBe(false);
	});

	it('is false for every other effect, confirmed or not', () => {
		for (const effect of ['run_workflow', 'backup', 'notify', undefined]) {
			expect(awaitsConfirmation({ effect })).toBe(false);
		}
	});
});

/**
 * The view and the scheduler must agree on which triggers wait. This is a
 * Node-side test, so it runs the engine's own store: every row below is due in
 * every respect except consent (enabled, open, `next_run_at` in the past), so
 * the only thing that keeps one out of `getDue` is the consent rule — and the
 * view has to call exactly those rows waiting.
 *
 * The records go through `listFiltered`, the query behind `GET /api/triggers`,
 * and through a JSON round trip, because that is the shape the view receives:
 * an unset `confirmed_at` arrives absent, not as `null`.
 *
 * `later_effect` stands for an effect that does not exist yet. The scheduler's
 * query gates only `run_agent` today — a workflow run has a second gate of its
 * own inside `executePipeline`, which is not this question — and if the query's
 * rule is ever turned around to "every effect except these", that row stops
 * being due and the test fails.
 */
describe('the view calls exactly the triggers the scheduler holds back waiting', () => {
	const dirs: string[] = [];
	const engines: EngineDb[] = [];
	const PAST = '2020-01-01T00:00:00.000Z';
	const CONFIRMED = '2026-06-01T00:00:00.000Z';

	afterEach(() => {
		for (const e of engines) { try { e.close(); } catch { /* already closed */ } }
		engines.length = 0;
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
		dirs.length = 0;
	});

	it('for every effect, with and without confirmation', () => {
		const dir = mkdtempSync(join(tmpdir(), 'lynox-trigger-consent-'));
		dirs.push(dir);
		const engine = new EngineDb(join(dir, 'engine.db'), '');
		engines.push(engine);
		const store = new TriggerStore(engine);
		// A workflow trigger references a real workflow row (foreign key).
		engine.getDb().prepare("INSERT INTO workflows (id, name, definition_json) VALUES ('wf', 'W', '{}')").run();

		const effects = ['run_agent', 'run_workflow', 'backup', 'notify', 'later_effect'];
		for (const effect of effects) {
			for (const confirmedAt of [null, CONFIRMED]) {
				const row: TriggerRow = {
					id: `${effect}-${confirmedAt ? 'confirmed' : 'unconfirmed'}`,
					title: 'x', description: '', source: 'cron', effect: effect as TriggerRow['effect'],
					conditionJson: JSON.stringify({ schedule_cron: '0 9 * * *', watch_config: null }),
					paramsJson: '{}', status: 'open', enabled: true, retryCount: 0,
					nextRunAt: PAST, confirmedAt,
					...(effect === 'run_workflow' ? { targetWorkflowId: 'wf' } : {}),
				};
				store.upsert(row);
			}
		}

		const listed = JSON.parse(JSON.stringify(store.listFiltered())) as Array<{
			id: string; effect?: string; confirmed_at?: string | null;
		}>;
		const due = new Set(store.getDue().map((t) => t.id));

		// Both sides of the rule have to be present, or the comparison below
		// could pass over a store that returned nothing or everything.
		expect(listed).toHaveLength(effects.length * 2);
		expect(due.size).toBeGreaterThan(0);
		expect(due.size).toBeLessThan(listed.length);

		const disagreements = listed
			.filter((t) => awaitsConfirmation(t) !== !due.has(t.id))
			.map((t) => `${t.id}: view says ${awaitsConfirmation(t) ? 'waiting' : 'runs'}, scheduler says ${due.has(t.id) ? 'due' : 'held back'}`);
		expect(disagreements).toEqual([]);
	});
});
