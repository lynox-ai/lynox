import { describe, it, expect, vi, beforeEach, afterEach, onTestFinished } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { t, tf, getLocale, setLocale } from '../i18n.svelte.js';
import type { BulkRunDetailData, BulkTarget } from './bulk-runs.js';

// The page of a run an undo took back: it reads as the list reads it („zurückgenommen“), says when
// and how many targets have their value back, links the undo, and greys the values that are no
// longer live. Before, the chip said „fertig“ and the after-values stayed green.

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
const written = (seq: number, undone: boolean): BulkTarget =>
	({ seq, key: `gid://shopify/Product/${seq}`, change: 'update', diff: fieldsDiff('', `Neu ${seq}`), error: null, deselected: false, written: true, undone }) as BulkTarget;

let target: HTMLElement;
let component: Record<string, unknown> | undefined;
let run: BulkRunDetailData;
let targets: BulkTarget[];
let opened: string[];

beforeEach(() => {
	target = document.createElement('div');
	document.body.appendChild(target);
	run = makeRun();
	targets = [written(1, true), written(2, true)];
	opened = [];
	vi.stubGlobal('fetch', vi.fn(async (url: string) => {
		const u = String(url);
		const reply = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
		if (u.endsWith('/config')) return reply({ managed: true, viewer: 'owner' });
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
	component = mount(BulkRunDetail, { target, props: { runId: 'r1', onBack: () => {}, onOpen: (id: string) => opened.push(id) } });
	for (let i = 0; i < 10; i++) {
		await new Promise((r) => setTimeout(r, 0));
		await tick();
		flushSync();
	}
}

const current = (): string | undefined => target.querySelector('[aria-current="step"]')?.textContent?.trim();
const afters = (): HTMLElement[] => [...target.querySelectorAll<HTMLElement>('[data-testid="bulk-after"]')];

describe('an undone run’s page', () => {
	it('shows the same chip as the list (bulk.phase.undone), not „fertig“', async () => {
		await render();
		// The list renders `bulk.phase.${run.phase}` (BulkRunsView); the detail's current step must say the same.
		expect(current()).toBe(t(`bulk.phase.${run.phase}`));
		expect(current()).not.toBe(t('bulk.step.done'));
	});

	it('a run that is done still reads „fertig“', async () => {
		run = makeRun({ phase: 'done', undone: 0, undoneBy: null });
		targets = [written(1, false), written(2, false)];
		await render();
		expect(current()).toBe(t('bulk.step.done'));
		expect(target.querySelector('[data-testid="bulk-undone"]')).toBeNull();
		expect(afters().every((el) => el.classList.contains('text-success'))).toBe(true);
	});

	it('greys the after-values the undo took back, and only those', async () => {
		targets = [written(1, true), written(2, false)];
		await render();
		const [taken, live] = afters();
		expect(taken!.classList.contains('text-text-subtle')).toBe(true);
		expect(taken!.classList.contains('text-success')).toBe(false);
		expect(live!.classList.contains('text-success')).toBe(true);
	});

	it('says when and how many, and opens the undo', async () => {
		const before = getLocale();
		setLocale('de');
		onTestFinished(() => setLocale(before));
		await render();
		const d = new Date('2026-11-12T08:00:30.000Z');
		const date = d.toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit', year: 'numeric' });
		const time = d.toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' });
		const line = target.querySelector('[data-testid="bulk-undone"]');
		expect(line?.textContent).toContain(tf('bulk.undone.sentence', { date, time, n: '2' }));
		[...line!.querySelectorAll('button')].find((b) => b.textContent?.trim() === t('bulk.undone.open'))!.click();
		expect(opened).toEqual(['u1']);
	});

	it('one target reads in the singular', async () => {
		const before = getLocale();
		setLocale('de');
		onTestFinished(() => setLocale(before));
		run = makeRun({ undone: 1, total: 1, applied: 1 });
		targets = [written(1, true)];
		await render();
		expect(target.querySelector('[data-testid="bulk-undone"]')?.textContent).toContain('1 Ziel hat seinen Wert von vorher zurück.');
	});
});

describe('the undo’s explanation', () => {
	it('promises no preview it does not show', () => {
		const before = getLocale();
		onTestFinished(() => setLocale(before));
		setLocale('de');
		expect(t('bulk.undo.explain')).not.toMatch(/Vorschau/);
		expect(t('bulk.undo.explain')).toContain('wie viele Ziele ihren Wert von vorher zurückbekommen');
		setLocale('en');
		expect(t('bulk.undo.explain')).not.toMatch(/preview/i);
		expect(t('bulk.undo.explain')).toContain('how many targets get their previous value back');
	});
});
