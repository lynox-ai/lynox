import { describe, it, expect, vi, beforeEach, afterEach, onTestFinished } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { t, tf, getLocale, setLocale } from '../i18n.svelte.js';
import type { BulkRunDetailData, BulkTarget } from './bulk-runs.js';
import { bulkHaltHeadKey } from './bulk-runs.js';

// A run that is not loaded whole opens on the targets its plan changes, so what it wrote is on its
// page however late in the run it comes, and the button that shows the unchanged ones counts them
// as the run's own counts do (U-437). Before, the page loaded the first six targets by plan order
// and folded the unchanged ones away: a run that wrote its 14th of 17 showed no row at all.

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
		id: 'r1', createdAt: '2026-11-12T07:50:00Z', targetSystem: 'http:demo.myshopify.com', phase: 'undone', total: 2,
		changes: { update: 2, create: 0, delete: 0, unchanged: 0, invalid: 0 }, applied: 2, failed: 0, conflicts: 0, sentUnknown: 0, undone: 2,
		kind: 'apply', atomic: false, sourceRunId: null, writeMethod: null, probeConfirmed: true, writeForm: 'unmeasured', haltReason: null, haltKey: null,
		costUsd: 0, costCapUsd: null, judge: null, maxTargets: 2, failedOnce: 0, failureLimit: 0, resumeOpen: 0, resumeTries: 0, resumeSends: 0, deselected: 0,
		checksum: null, writeFormNote: null, writeFormConfirmation: null, judgeModel: null, resumesAt: null, probe: null, undoable: 0,
		listFirstPage: null, listStartChecksum: null, listNote: null, listFilters: null, judgeRule: null, judgeRuleHash: null, judgeServedBy: null, judgeOwnKey: false,
		undoneBy: { runId: 'u1', at: '2026-11-12T08:00:30.000Z' },
		...o,
	};
}
const SHOP = 'http:demo.myshopify.com';
const fieldsOf = (seq: number): BulkTarget['diff'] => fieldsDiff('', `Neu ${seq}`);
const writtenAt = (seq: number): BulkTarget =>
	({ seq, key: `gid://shopify/Product/${seq}`, change: 'update', diff: fieldsOf(seq), error: null, deselected: false, written: true, undone: false }) as BulkTarget;
const unchangedAt = (seq: number): BulkTarget =>
	({ seq, key: `gid://shopify/Product/${seq}`, change: 'unchanged', diff: { kind: 'none' }, error: null, deselected: false, written: false, undone: false }) as unknown as BulkTarget;
/** A done run of 17 targets that wrote only its 14th, as run 61f2e307 on a staging store did. */
function doneRun(): void {
	run = makeRun({ phase: 'done', undone: 0, undoneBy: null, targetSystem: SHOP, total: 17, applied: 1,
		changes: { update: 1, create: 0, delete: 0, unchanged: 16, invalid: 0 },
		heads: { deselected: 0, invalid: 0, unchanged: 16, takenBack: 0, written: 1, settled: 0, conflict: 0, unclear: 0, failed: 0, open: 0 } });
	targets = Array.from({ length: 17 }, (_, i) => (i + 1 === 14 ? writtenAt(14) : unchangedAt(i + 1)));
}

let target: HTMLElement;
let component: Record<string, unknown> | undefined;
let run: BulkRunDetailData;
let targets: BulkTarget[];
let asked: string[];
let fail: boolean;

beforeEach(() => {
	setLocale('de');
	target = document.createElement('div');
	document.body.appendChild(target);
	run = makeRun();
	targets = [];
	asked = [];
	fail = false;
	vi.stubGlobal('fetch', vi.fn(async (url: string) => {
		const u = String(url);
		const reply = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
		if (u.endsWith('/config')) return reply({ managed: true, viewer: 'owner' });
		const page = /\/targets\?offset=(\d+)&limit=(\d+)(&changed=1)?$/.exec(u);
		if (page) {
			asked.push(u.slice(u.indexOf('/targets')));
			// As the engine serves it: the changed targets, the written ones first; otherwise plan order.
			const from = page[3] ? targets.filter((x) => x.change !== 'unchanged').sort((a, b) => Number(b.written === true) - Number(a.written === true) || a.seq - b.seq) : targets;
			if (fail && !page[3]) throw new Error('network');
			return reply({ targets: from.slice(Number(page[1]), Number(page[1]) + Number(page[2])) });
		}
		return reply(run);
	}));
});

afterEach(() => {
	if (component) unmount(component);
	component = undefined;
	target.remove();
	vi.unstubAllGlobals();
});

async function settle(): Promise<void> {
	for (let i = 0; i < 10; i++) {
		await new Promise((r) => setTimeout(r, 0));
		await tick();
		flushSync();
	}
}
async function render(): Promise<void> {
	const { default: BulkRunDetail } = await import('./BulkRunDetail.svelte');
	component = mount(BulkRunDetail, { target, props: { runId: 'r1', onBack: () => {}, onOpen: () => {} } });
	await settle();
}
const rows = (): string[] => [...target.querySelectorAll<HTMLAnchorElement>('[data-testid="bulk-target-admin"]')].map((a) => a.getAttribute('href')!.replace(/.*\//, ''));
const button = (text: string): HTMLButtonElement | undefined => [...target.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === text);
const counts = (): string => target.querySelector('[data-testid="bulk-counts"]')?.textContent ?? '';

describe('the page of a run that wrote a target late in its plan', () => {
	it('shows the written target with its change, and counts the unchanged ones as the head does', async () => {
		doneRun();
		await render();
		expect(rows()).toEqual(['14']);
		expect(target.textContent).toContain('Neu 14');
		expect(target.textContent).toContain(tf('bulk.preview.title', { k: '1', n: '17' }));
		expect(counts()).toContain('16 unverändert');
		expect(button(tf('bulk.preview.show_unchanged', { n: '16' }))).toBeDefined();
		expect(asked).toEqual(['/targets?offset=0&limit=6&changed=1']);
	});

	it('loads the run whole when the owner shows the unchanged targets, in plan order, each once', async () => {
		doneRun();
		await render();
		button(tf('bulk.preview.show_unchanged', { n: '16' }))!.click();
		await settle();
		expect(rows()).toEqual(Array.from({ length: 17 }, (_, i) => String(i + 1)));
		expect(asked.slice(1)).toEqual(['/targets?offset=0&limit=500']);
	});

	it('unfolds a preview loaded whole without asking for it again', async () => {
		doneRun();
		run = { ...run, phase: 'previewed', applied: 0 };
		await render();
		expect(asked).toEqual(['/targets?offset=0&limit=500']);
		button(tf('bulk.preview.show_unchanged', { n: '16' }))!.click();
		await settle();
		expect(rows()).toEqual(Array.from({ length: 17 }, (_, i) => String(i + 1)));
		expect(asked).toEqual(['/targets?offset=0&limit=500']);
	});

	it('loads the run whole from the start when the owner shows all, the unchanged ones still folded', async () => {
		doneRun();
		await render();
		button(tf('bulk.preview.show_all', { n: '17' }))!.click();
		await settle();
		expect(rows()).toEqual(['14']);
		expect(target.textContent).toContain(tf('bulk.preview.title', { k: '17', n: '17' }));
		expect(button(tf('bulk.preview.show_unchanged', { n: '16' }))).toBeDefined();
		expect(asked.slice(1)).toEqual(['/targets?offset=0&limit=500']);
	});

	it('opens a run whose plan changes nothing on its first page, so its unchanged targets can be shown', async () => {
		doneRun();
		run = { ...run, applied: 0, changes: { ...run.changes, update: 0, unchanged: 17 } };
		targets = Array.from({ length: 17 }, (_, i) => unchangedAt(i + 1));
		await render();
		expect(asked).toEqual(['/targets?offset=0&limit=6&changed=1', '/targets?offset=0&limit=6']);
		expect(button(tf('bulk.preview.show_unchanged', { n: '6' }))).toBeDefined();
		button(tf('bulk.preview.show_unchanged', { n: '6' }))!.click();
		await settle();
		expect(rows()).toEqual(['1', '2', '3', '4', '5', '6']);
	});

	it('opens a run that changes every target on the written ones first, however late in the plan', async () => {
		doneRun();
		run = { ...run, changes: { ...run.changes, update: 17, unchanged: 0 } };
		targets = Array.from({ length: 17 }, (_, i) => ({ ...writtenAt(i + 1), written: i + 1 === 14 || i + 1 === 16 }));
		await render();
		expect(rows()).toEqual(['14', '16', '1', '2', '3', '4']);
		expect(asked).toEqual(['/targets?offset=0&limit=6&changed=1']);
		// Nothing unchanged to fold.
		expect([...target.querySelectorAll('button')].some((b) => /unveränderte/.test(b.textContent ?? ''))).toBe(false);
	});

	it('control: a run that left nothing unchanged and wrote nothing opens on its first page in plan order', async () => {
		doneRun();
		run = { ...run, applied: 0, changes: { ...run.changes, update: 17, unchanged: 0 } };
		targets = Array.from({ length: 17 }, (_, i) => ({ ...writtenAt(i + 1), written: false }));
		await render();
		expect(rows()).toEqual(['1', '2', '3', '4', '5', '6']);
		expect(asked).toEqual(['/targets?offset=0&limit=6']);
	});

	it('keeps the fold and says so when loading the unchanged targets fails', async () => {
		doneRun();
		await render();
		fail = true;
		button(tf('bulk.preview.show_unchanged', { n: '16' }))!.click();
		await settle();
		expect(rows()).toEqual(['14']);
		expect(button(tf('bulk.preview.show_unchanged', { n: '16' }))).toBeDefined();
		expect(target.textContent).toContain(t('common.load_failed'));
		// The failed ask left the fold closed: once the whole run loads, its unchanged targets stay folded.
		fail = false;
		button(tf('bulk.preview.show_all', { n: '17' }))!.click();
		await settle();
		expect(rows()).toEqual(['14']);
		expect(button(tf('bulk.preview.show_unchanged', { n: '16' }))).toBeDefined();
	});
});

describe('a run that waits for its start', () => {
	it('names its sentence the next step, not a halt; a halted run stays halted', async () => {
		expect(bulkHaltHeadKey({ phase: 'planned', haltKey: 'awaitingStart' })).toBe('bulk.head.next');
		expect(bulkHaltHeadKey({ phase: 'planned', haltKey: 'listed' })).toBe('bulk.head.next');
		expect(bulkHaltHeadKey({ phase: 'writing', haltKey: 'unavailable' })).toBe('bulk.head.halted');
		expect(bulkHaltHeadKey({ phase: 'planned', haltKey: 'unavailable' })).toBe('bulk.head.halted');
		run = makeRun({ phase: 'planned', undone: 0, undoneBy: null, targetSystem: SHOP, total: 0, applied: 0, haltKey: 'awaitingStart', haltReason: 'awaiting start',
			changes: { update: 0, create: 0, delete: 0, unchanged: 0, invalid: 0 } });
		await render();
		const labels = [...target.querySelectorAll('dt')].map((d) => d.textContent?.trim());
		expect(labels).toContain('Nächster Schritt');
		expect(labels).not.toContain('Angehalten');
	});
});

describe('the approval of an undo', () => {
	it('says one target in the singular and several in the plural', () => {
		expect(tf('bulk.undo.approve_explain_one', { n: '1' })).toBe('1 Ziel bekommt seinen Wert von vorher zurück. Hat es seither jemand geändert, bleibt es, wie es ist.');
		setLocale('en');
		expect(tf('bulk.undo.approve_explain_one', { n: '1' })).toBe('1 target gets its previous value back. If someone has changed it since then, it stays as it is.');
		expect(tf('bulk.undo.approve_explain', { n: '3' })).toMatch(/^3 targets get their previous value back/);
	});

	it('shows the singular on the page of an undo of one target', async () => {
		run = makeRun({ kind: 'undo', phase: 'previewed', sourceRunId: 's1', undone: 0, undoneBy: null, targetSystem: SHOP, total: 1, applied: 0,
			changes: { update: 1, create: 0, delete: 0, unchanged: 0, invalid: 0 } });
		targets = [writtenAt(1)];
		await render();
		expect(target.textContent).toContain(t('bulk.undo.approve_explain_one'));
		expect(target.textContent).not.toContain('1 Ziele');
	});
});
