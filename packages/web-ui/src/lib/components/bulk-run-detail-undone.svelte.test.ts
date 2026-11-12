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

	it('greys a target the owner took out before the write: on a run taken back it was never live', async () => {
		const out = { ...written(3, false), written: false, deselected: true } as BulkTarget;
		targets = [written(1, true), out];
		await render();
		const [, never] = afters();
		expect(never!.classList.contains('text-text-subtle')).toBe(true);
		expect(never!.classList.contains('text-success')).toBe(false);
	});

	it('on a run that is only done, a target taken out keeps its colour', async () => {
		run = makeRun({ phase: 'done', undone: 0, undoneBy: null });
		targets = [written(1, false), { ...written(3, false), written: false, deselected: true } as BulkTarget];
		await render();
		expect(afters()[1]!.classList.contains('text-success')).toBe(true);
	});

	it('shows the before-value of a target taken back as the value that holds again, not struck out; a live one tinted, not struck', async () => {
		const back = { ...written(1, true), diff: fieldsDiff('Alt 1', 'Neu 1') } as BulkTarget;
		const live = { ...written(2, false), diff: fieldsDiff('Alt 2', 'Neu 2') } as BulkTarget;
		const text = { ...written(3, true), diff: { kind: 'text', from: 0, removed: ['Alt 3'], added: ['Neu 3'] } } as BulkTarget;
		const liveText = { ...written(4, false), diff: { kind: 'text', from: 0, removed: ['Alt 4'], added: ['Neu 4'] } } as BulkTarget;
		targets = [back, live, text, liveText];
		await render();
		const befores = [...target.querySelectorAll<HTMLElement>('[data-testid="bulk-before"]')];
		expect(befores.map((el) => [el.tagName, el.textContent?.trim()])).toEqual([['SPAN', 'Alt 1'], ['DEL', 'Alt 2'], ['SPAN', '- Alt 3'], ['DEL', '- Alt 4']]);
		expect(['no-underline', 'bg-danger/10'].every((c) => befores[3]!.classList.contains(c))).toBe(true);
		expect(befores[0]!.classList.contains('text-text')).toBe(true);
		expect(befores[0]!.classList.contains('text-danger')).toBe(false);
		expect(befores[1]!.classList.contains('text-danger')).toBe(true);
		// Marked by a tint, not struck: a line through a „1“ reads as „4“.
		expect(['no-underline', 'bg-danger/10'].every((c) => befores[1]!.classList.contains(c))).toBe(true);
		expect(befores[2]!.classList.contains('text-text')).toBe(true);
	});

	it('greys every mark beside a target taken back, and only there: the whole row is a record', async () => {
		const marks = { seoEntityFields: ['seo_title'], shopAddedMarkup: true } as Partial<BulkTarget>;
		const rewrote = { hostRewrote: true } as Partial<BulkTarget>;
		targets = [{ ...written(1, true), ...marks } as BulkTarget, { ...written(2, false), ...marks } as BulkTarget,
			{ ...written(3, true), ...rewrote } as BulkTarget, { ...written(4, false), ...rewrote } as BulkTarget];
		await render();
		const grey = (el: Element | undefined): boolean => el!.classList.contains('text-text-subtle') && el!.classList.contains('bg-bg-muted');
		for (const id of ['bulk-seo-entity', 'bulk-shop-added-markup', 'bulk-host-rewrote']) {
			const [back, live] = [...target.querySelectorAll(`[data-testid="${id}"]`)];
			expect(grey(back), id).toBe(true);
			expect(grey(live), id).toBe(false);
		}
		const [seoLive] = [...target.querySelectorAll('[data-testid="bulk-seo-entity"]')].slice(1);
		expect(seoLive!.classList.contains('text-warning')).toBe(true);
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
		// The count leads and the time closes the sentence, so no line breaks between „09:00:“ and „2“.
		expect(line?.textContent?.trim()).toMatch(new RegExp(`^2 Ziele haben ihren Wert von vorher zurück\\. Zurückgenommen am ${date.replace(/\./g, '\\.')} um ${time}\\.`));
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
