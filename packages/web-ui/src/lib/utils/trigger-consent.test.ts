import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineDb } from '../../../../../src/core/engine-db.js';
import { TriggerStore, type TriggerRow } from '../../../../../src/core/trigger-store.js';
import { awaitsConfirmation, confirmationOutcome, displaySafe, instructionOf, watchOf } from './trigger-consent.js';

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

describe('instructionOf — what the run is told, not what the row shows', () => {
	it('is title and description together, the way the engine composes them', () => {
		expect(instructionOf({ title: 'Mahnungen', description: 'Ab 14 Tagen, als Entwurf.' }))
			.toBe('Mahnungen\n\nAb 14 Tagen, als Entwurf.');
	});

	it('is the title alone when there is no description — the case the view used to show nothing for', () => {
		expect(instructionOf({ title: 'Mahnungen' })).toBe('Mahnungen');
		expect(instructionOf({ title: 'Mahnungen', description: '' })).toBe('Mahnungen');
		expect(instructionOf({ title: 'Mahnungen', description: '   ' })).toBe('Mahnungen');
	});

	it('does not repeat a description that only echoes the title', () => {
		expect(instructionOf({ title: 'Mahnungen', description: ' Mahnungen ' })).toBe('Mahnungen');
	});
});

describe('watchOf — the page a watch would fetch, and how often', () => {
	it('reads the url and the interval out of the stored config', () => {
		expect(watchOf({ watch_config: JSON.stringify({ url: 'https://example.com/preise', interval_minutes: 60, selector: '.p' }) }))
			.toEqual({ url: 'https://example.com/preise', intervalMinutes: 60 });
	});

	it('gives the url alone when the config carries no usable interval', () => {
		expect(watchOf({ watch_config: '{"url":"https://example.com"}' })).toEqual({ url: 'https://example.com' });
		expect(watchOf({ watch_config: '{"url":"https://example.com","interval_minutes":"60"}' })).toEqual({ url: 'https://example.com' });
	});

	it('yields nothing rather than an empty label', () => {
		expect(watchOf({})).toBeUndefined();
		expect(watchOf({ watch_config: '' })).toBeUndefined();
		expect(watchOf({ watch_config: '{"url":""}' })).toBeUndefined();
		expect(watchOf({ watch_config: '{"url":123}' })).toBeUndefined();
		expect(watchOf({ watch_config: '{"selector":".p"}' })).toBeUndefined();
	});

	it('survives a config that is not JSON at all', () => {
		expect(watchOf({ watch_config: 'https://example.com' })).toBeUndefined();
		expect(watchOf({ watch_config: '{broken' })).toBeUndefined();
	});

	it('cuts a url that would push the button off the screen', () => {
		// Nothing bounds this string on the way in, and the block renders it next to
		// the Confirm button: an unbounded one buries the thing being agreed to.
		const long = `https://example.com/${'a'.repeat(5000)}`;
		const shown = watchOf({ watch_config: JSON.stringify({ url: long }) })?.url ?? '';
		expect(shown.length).toBeLessThan(200);
		expect(shown.endsWith('\u2026')).toBe(true);
		expect(long.startsWith(shown.slice(0, -1))).toBe(true);
	});

	it('cuts on code points, so a surrogate pair is not halved', () => {
		const url = `https://example.com/${'\uD83D\uDCC8'.repeat(400)}`;
		const shown = watchOf({ watch_config: JSON.stringify({ url }) })?.url ?? '';
		expect(shown).not.toContain('\uFFFD');
		expect([...shown].every((c) => c.codePointAt(0) !== 0xD83D)).toBe(true);
	});
});

describe('displaySafe', () => {
	it('drops the overrides and isolates that reverse what a sentence says', () => {
		expect(displaySafe('Zahle \u202Eeuro 10\u202C aus')).toBe('Zahle euro 10 aus');
		expect(displaySafe('a\u2066b\u2069c')).toBe('abc');
		expect(displaySafe('a\u202Ab\u202Bc\u202Dd')).toBe('abcd');
	});

	it('drops the invisible spaces that hide a clause inside a full-looking sentence', () => {
		expect(displaySafe('l\u00f6sch\u200Be alles')).toBe('l\u00f6sche alles');
		expect(displaySafe('a\uFEFFb')).toBe('ab');
	});

	it('keeps the line breaks and tabs the instruction is written with', () => {
		expect(displaySafe('Schritt 1\nSchritt 2\n\tEinschub')).toBe('Schritt 1\nSchritt 2\n\tEinschub');
	});

	it('drops the control characters that are not breaks', () => {
		expect(displaySafe('a\u0000b\u001Bc\u007Fd\u2028e')).toBe('abcde');
	});

	it('keeps what a language needs to spell its own words', () => {
		// The narrower class, and the reason it is narrower: stripping these made the
		// text wrong in the languages that use them. LRM/RLM order digits around a
		// right-to-left word; ZWNJ separates Persian letters into a different word;
		// ZWJ is what holds an emoji sequence together.
		expect(displaySafe('\u05D0\u05D1\u05D9 \u200E+41 79 123')).toBe('\u05D0\u05D1\u05D9 \u200E+41 79 123');
		expect(displaySafe('\u0645\u06CC\u200C\u0631\u0648\u062F')).toBe('\u0645\u06CC\u200C\u0631\u0648\u062F');
		expect(displaySafe('\uD83D\uDC68\u200D\uD83D\uDC69\u200D\uD83D\uDC67')).toBe('\uD83D\uDC68\u200D\uD83D\uDC69\u200D\uD83D\uDC67');
		expect(displaySafe('\uD83C\uDFF3\uFE0F\u200D\uD83C\uDF08')).toBe('\uD83C\uDFF3\uFE0F\u200D\uD83C\uDF08');
	});

	it('leaves ordinary text alone, umlauts and emoji included', () => {
		expect(displaySafe('Pr\u00fcfe \u201eDebitoren\u201c \u2014 14 Tage \u00b7 \uD83D\uDCC8'))
			.toBe('Pr\u00fcfe \u201eDebitoren\u201c \u2014 14 Tage \u00b7 \uD83D\uDCC8');
	});
});

/**
 * The view and the scheduler must agree on which triggers wait FOR CONSENT.
 * This is a Node-side test, so it runs the engine's own store: every row in the
 * first case is due in every respect except consent (enabled, open,
 * `next_run_at` in the past), so the only thing that keeps one out of `getDue`
 * is the consent rule — and the view has to call exactly those rows waiting.
 *
 * That matrix varies ONE axis, effect × confirmation. The second case is the
 * other direction and the weaker claim, which is all that holds in general: a
 * trigger the view calls waiting is never due. A paused one is held back for a
 * second reason, and the view is not entitled to say what happens after a
 * confirmation there — which is what the toast used to get wrong.
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

	it('and what the block PROMISES after confirming is what the scheduler then does', () => {
		// The claim this pins is the one the first version got wrong twice: it told
		// the owner of a paused, completed or never-scheduled trigger that it would
		// run "shortly after you confirm". Here the test does the confirming — it
		// stamps the consent through the store and asks the scheduler whether the
		// row runs, at the moment the block names.
		const dir = mkdtempSync(join(tmpdir(), 'lynox-trigger-consent-'));
		dirs.push(dir);
		const engine = new EngineDb(join(dir, 'engine.db'), '');
		engines.push(engine);
		const store = new TriggerStore(engine);
		const FUTURE = '2027-01-01T00:00:00.000Z';
		const LATER = '2030-01-01T00:00:00.000Z';
		const base = {
			title: 'x', description: '', source: 'cron' as TriggerRow['source'], effect: 'run_agent' as TriggerRow['effect'],
			conditionJson: JSON.stringify({ schedule_cron: '0 9 * * *', watch_config: null }),
			paramsJson: '{}', retryCount: 0, confirmedAt: null,
		};
		const rows: TriggerRow[] = [
			{ ...base, id: 'due', status: 'open', enabled: true, nextRunAt: PAST },
			{ ...base, id: 'scheduled', status: 'open', enabled: true, nextRunAt: FUTURE },
			{ ...base, id: 'paused', status: 'open', enabled: false, nextRunAt: PAST },
			{ ...base, id: 'completed', status: 'completed', enabled: true, nextRunAt: PAST },
			{ ...base, id: 'waiting', status: 'waiting', enabled: true, nextRunAt: PAST },
			{ ...base, id: 'no-next-run', status: 'open', enabled: true, nextRunAt: null },
			{
				...base, id: 'failed-once', status: 'failed', enabled: true, nextRunAt: PAST,
				conditionJson: JSON.stringify({ schedule_cron: null, watch_config: null }),
			},
		];
		for (const row of rows) store.upsert(row);

		const listed = JSON.parse(JSON.stringify(store.listFiltered())) as Array<{
			id: string; status?: string; enabled?: number; next_run_at?: string; schedule_cron?: string;
		}>;
		expect(listed).toHaveLength(rows.length);

		// The block speaks BEFORE the confirmation, so its promise is read first.
		const promised = new Map(listed.map((t) => [t.id, confirmationOutcome(t, Date.parse('2026-09-22T12:00:00.000Z'))]));
		expect([...promised.values()].filter((o) => o === 'due-now')).toHaveLength(1);
		expect([...promised.values()].filter((o) => o === 'scheduled')).toHaveLength(1);
		expect([...promised.values()].filter((o) => o === 'paused')).toHaveLength(1);
		expect([...promised.values()].filter((o) => o === 'not-scheduled')).toHaveLength(4);

		// …then the consent is actually given, and the scheduler is asked.
		for (const row of rows) store.setConfirmedAt(row.id, CONFIRMED);
		const dueNow = new Set(store.getDue('2026-09-22T12:00:00.000Z').map((t) => t.id));
		const dueLater = new Set(store.getDue(LATER).map((t) => t.id));

		const broken: string[] = [];
		for (const [id, outcome] of promised) {
			if (outcome === 'due-now' && !dueNow.has(id)) broken.push(`${id}: promised a run now, scheduler holds it back`);
			if (outcome === 'scheduled' && (dueNow.has(id) || !dueLater.has(id))) broken.push(`${id}: promised a run at its date, scheduler disagrees`);
			if ((outcome === 'paused' || outcome === 'not-scheduled') && (dueNow.has(id) || dueLater.has(id))) {
				broken.push(`${id}: promised nothing, scheduler runs it`);
			}
		}
		expect(broken).toEqual([]);
	});

	it('and a trigger the view calls waiting is never due, whatever else holds it back', () => {
		const dir = mkdtempSync(join(tmpdir(), 'lynox-trigger-consent-'));
		dirs.push(dir);
		const engine = new EngineDb(join(dir, 'engine.db'), '');
		engines.push(engine);
		const store = new TriggerStore(engine);

		// The second reasons, beside consent, that keep a row out of `getDue`. The
		// row the equality case above pins is the ONE combination where consent is
		// the only one — these are the rest, and the view may not speak for them.
		const base = {
			title: 'x', description: '', source: 'cron' as TriggerRow['source'], effect: 'run_agent' as TriggerRow['effect'],
			conditionJson: JSON.stringify({ schedule_cron: '0 9 * * *', watch_config: null }),
			paramsJson: '{}', retryCount: 0, nextRunAt: PAST,
		};
		const rows: TriggerRow[] = [
			{ ...base, id: 'paused-unconfirmed', status: 'open', enabled: false, confirmedAt: null },
			{ ...base, id: 'paused-confirmed', status: 'open', enabled: false, confirmedAt: CONFIRMED },
			{ ...base, id: 'completed-unconfirmed', status: 'completed', enabled: true, confirmedAt: null },
			{ ...base, id: 'no-next-run-unconfirmed', status: 'open', enabled: true, confirmedAt: null, nextRunAt: null },
		];
		for (const row of rows) store.upsert(row);

		const listed = JSON.parse(JSON.stringify(store.listFiltered())) as Array<{
			id: string; effect?: string; confirmed_at?: string | null;
		}>;
		expect(listed).toHaveLength(rows.length);
		const due = new Set(store.getDue().map((t) => t.id));
		// None of these is due — so this case cannot tell a broken predicate from a
		// working one on its own, and it is not asked to. It holds the one direction
		// that must never break: waiting means not running.
		expect(due.size).toBe(0);
		expect(listed.filter((t) => awaitsConfirmation(t) && due.has(t.id))).toEqual([]);
		// …and it really does call three of them waiting, so the filter is not empty.
		expect(listed.filter((t) => awaitsConfirmation(t)).map((t) => t.id).sort())
			.toEqual(['completed-unconfirmed', 'no-next-run-unconfirmed', 'paused-unconfirmed']);
	});
});
