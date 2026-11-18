import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { t, tf } from '../i18n.svelte.js';
import { resetSettingsViewer } from '../stores/settings-viewer.svelte.js';
import type { BulkRunDetailData, BulkTarget } from './bulk-runs.js';

// A target the owner took out before approving stays named as taken out in every phase, not only
// while approving: after „fertig“ and after a take-back it looked like the targets that were reset.
// The head counts it, so it is not missing from the numbers. An owner's read list is not also told
// it has not started: its own sentence says what comes next. A mandate does not get that sentence
// and keeps the one that says the run has not started.

const CLIENT_ENTRY = join(dirname(createRequire(import.meta.url).resolve('svelte/package.json')), 'src/index-client.js');
type SvelteClient = {
	mount: (c: unknown, o: { target: Element; props?: Record<string, unknown> }) => Record<string, unknown>;
	unmount: (c: Record<string, unknown>) => void;
	flushSync: () => void;
	tick: () => Promise<void>;
};
const { mount, unmount, flushSync, tick } = (await import(/* @vite-ignore */ CLIENT_ENTRY)) as SvelteClient;

const fieldsDiff = (before: string, after: string): BulkTarget['diff'] =>
	({ kind: 'fields', fields: [{ field: 'seo_title', before, after }] }) as BulkTarget['diff'];

function makeRun(o: Partial<BulkRunDetailData> = {}): BulkRunDetailData {
	return {
		id: 'r1', createdAt: '2026-11-13T07:50:00Z', targetSystem: 'http:demo.myshopify.com', phase: 'done', total: 3,
		changes: { update: 2, create: 0, delete: 0, unchanged: 0, invalid: 0 }, applied: 2, failed: 0, conflicts: 0, sentUnknown: 0, undone: 0,
		kind: 'apply', atomic: false, sourceRunId: null, writeMethod: null, probeConfirmed: true, writeForm: 'unmeasured', haltReason: null, haltKey: null,
		costUsd: 0, costCapUsd: null, judge: null, maxTargets: 3, failedOnce: 0, failureLimit: 0, resumeOpen: 0, resumeTries: 0, resumeSends: 0, deselected: 1,
		checksum: null, writeFormNote: null, writeFormConfirmation: null, judgeModel: null, resumesAt: null, probe: null, undoable: 2,
		listFirstPage: null, listStartChecksum: null, listNote: null, listFilters: null, judgeRule: null, judgeRuleHash: null, judgeServedBy: null, judgeOwnKey: false,
		undoneBy: null,
		...o,
	};
}
const tgt = (seq: number, o: Partial<BulkTarget> = {}): BulkTarget =>
	({ seq, key: `gid://shopify/Product/${seq}`, change: 'update', diff: fieldsDiff('', `Neu ${seq}`), error: null, deselected: false, written: true, undone: false, ...o }) as BulkTarget;

let target: HTMLElement;
let component: Record<string, unknown> | undefined;
let run: BulkRunDetailData;
let targets: BulkTarget[];
let viewer: 'owner' | 'mandate';

beforeEach(() => {
	target = document.createElement('div');
	document.body.appendChild(target);
	resetSettingsViewer();
	run = makeRun();
	viewer = 'owner';
	targets = [tgt(1), tgt(2), tgt(3, { deselected: true, written: false })];
	vi.stubGlobal('fetch', vi.fn(async (url: string) => {
		const u = String(url);
		const reply = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
		if (u.endsWith('/config')) return reply({ managed: true, viewer });
		const page = /\/targets\?offset=(\d+)&limit=(\d+)$/.exec(u);
		if (page) return reply({ targets: targets.slice(Number(page[1]), Number(page[1]) + Number(page[2])) });
		return reply(run);
	}));
});

afterEach(() => {
	if (component) unmount(component);
	component = undefined;
	target.remove();
	vi.unstubAllGlobals();
});

async function render(): Promise<void> {
	const { default: BulkRunDetail } = await import('./BulkRunDetail.svelte');
	component = mount(BulkRunDetail, { target, props: { runId: 'r1', onBack: () => {}, onOpen: () => {} } });
	for (let i = 0; i < 10; i++) {
		await new Promise((r) => setTimeout(r, 0));
		await tick();
		flushSync();
	}
}

const rowOf = (seq: number): HTMLElement => {
	const rows = [...target.querySelectorAll('tbody tr')] as HTMLElement[];
	const row = rows.find((r) => r.textContent?.includes(tf('bulk.target.product', { n: String(seq) })));
	if (!row) throw new Error(`no row for target ${seq}`);
	return row;
};

describe('a target the owner took out', () => {
	it('is named as taken out on a run that is done, and only that target', async () => {
		await render();
		expect(rowOf(3).textContent).toContain(t('bulk.deselect.taken_out'));
		expect(rowOf(1).textContent).not.toContain(t('bulk.deselect.taken_out'));
	});

	it('is named as taken out on a run that was taken back', async () => {
		run = makeRun({ phase: 'undone', undone: 2, undoable: 0, undoneBy: { runId: 'u1', at: '2026-11-13T08:00:30.000Z' } });
		targets = [tgt(1, { undone: true }), tgt(2, { undone: true }), tgt(3, { deselected: true, written: false })];
		await render();
		expect(rowOf(3).textContent).toContain(t('bulk.deselect.taken_out'));
		expect(rowOf(1).textContent).not.toContain(t('bulk.deselect.taken_out'));
	});

	it('offers no button to put it back once the run is past approving', async () => {
		await render();
		expect(rowOf(3).querySelector('button')).toBeNull();
		expect(target.textContent).not.toContain(t('bulk.deselect.on'));
	});

	it('names the owner to a mandate', async () => {
		viewer = 'mandate';
		await render();
		expect(rowOf(3).textContent).toContain(t('bulk.deselect.taken_out_mandate'));
		expect(rowOf(3).textContent).not.toContain(t('bulk.deselect.taken_out'));
	});
});

describe('the head of a run', () => {
	it('counts the targets taken out next to the ones written', async () => {
		await render();
		const head = tf('bulk.head.counts_taken_out', { n: '3', a: '2', d: '1', c: '0', f: '0' });
		expect(head).toBe('3 · geschrieben 2 · herausgenommen 1 · Konflikte 0 · fehlgeschlagen 0');
		expect(target.textContent).toContain(head);
	});

	it('has no taken-out part when nothing was taken out', async () => {
		run = makeRun({ deselected: 0, total: 2, maxTargets: 2 });
		targets = [tgt(1), tgt(2)];
		await render();
		expect(target.textContent).toContain(tf('bulk.head.counts', { n: '2', a: '2', c: '0', f: '0' }));
		expect(target.textContent).not.toContain('herausgenommen 0');
	});
});

describe('a planned run', () => {
	it('with a read list says only that the list is read, not that it has not started', async () => {
		run = makeRun({ phase: 'planned', haltKey: 'listed', haltReason: 'listed', applied: 0, deselected: 0, undoable: 0 });
		targets = [tgt(1, { written: false }), tgt(2, { written: false }), tgt(3, { written: false })];
		await render();
		expect(target.textContent).toContain(tf('bulk.start.listed', { n: '3' }));
		expect(target.textContent).not.toContain(t('bulk.awaiting_start'));
	});

	it('with a read list still tells a mandate it has not started, without the owner\'s sentence', async () => {
		viewer = 'mandate';
		run = makeRun({ phase: 'planned', haltKey: 'listed', haltReason: 'listed', applied: 0, deselected: 0, undoable: 0 });
		targets = [tgt(1, { written: false }), tgt(2, { written: false }), tgt(3, { written: false })];
		await render();
		expect(target.textContent).toContain(t('bulk.awaiting_start'));
		expect(target.textContent).not.toContain(tf('bulk.start.listed', { n: '3' }));
	});

	it('that waits for its start still says it has not started', async () => {
		run = makeRun({ phase: 'planned', haltKey: 'awaitingStart', haltReason: 'awaitingStart', applied: 0, deselected: 0, undoable: 0 });
		targets = [];
		await render();
		expect(target.textContent).toContain(t('bulk.awaiting_start'));
	});
});
