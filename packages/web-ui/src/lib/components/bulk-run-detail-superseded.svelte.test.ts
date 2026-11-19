import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { t, getLocale, setLocale } from '../i18n.svelte.js';
import type { BulkRunDetailData, BulkTarget } from './bulk-runs.js';

// A judged run the owner replaced by starting another one in its place says so in its halt line, and
// links the run that took its place, as an undone run links its undo (U-353). Without the id (an older
// engine, or a run replaced before the engine kept it) the sentence stands alone.

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
		id: 'r1', createdAt: '2026-11-12T07:50:00Z', targetSystem: 'http:demo.myshopify.com', phase: 'aborted', total: 2,
		changes: { update: 2, create: 0, delete: 0, unchanged: 0, invalid: 0 }, applied: 0, failed: 0, conflicts: 0, sentUnknown: 0, undone: 0,
		kind: 'apply', atomic: false, sourceRunId: null, writeMethod: null, probeConfirmed: true, writeForm: 'unmeasured', haltReason: 'the owner started another run with a judge in its place', haltKey: 'superseded', supersededBy: 'r2',
		costUsd: 0, costCapUsd: null, judge: null, maxTargets: 2, failedOnce: 0, failureLimit: 0, resumeOpen: 0, resumeTries: 0, resumeSends: 0, deselected: 0,
		checksum: null, writeFormNote: null, writeFormConfirmation: null, judgeModel: null, resumesAt: null, probe: null, undoable: 0,
		listFirstPage: null, listStartChecksum: null, listNote: null, listFilters: null, judgeRule: null, judgeRuleHash: null, judgeServedBy: null, judgeOwnKey: false,
		undoneBy: null,
		...o,
	};
}
const planned = (seq: number): BulkTarget =>
	({ seq, key: `gid://shopify/Product/${seq}`, change: 'update', diff: fieldsDiff('', `Neu ${seq}`), error: null, deselected: false, written: false, undone: false }) as BulkTarget;

let target: HTMLElement;
let component: Record<string, unknown> | undefined;
let run: BulkRunDetailData;
let targets: BulkTarget[];
let opened: string[];
let locale: ReturnType<typeof getLocale>;

beforeEach(() => {
	target = document.createElement('div');
	document.body.appendChild(target);
	run = makeRun();
	targets = [planned(1), planned(2)];
	opened = [];
	locale = getLocale();
	setLocale('de');
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
	setLocale(locale);
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

const link = (): HTMLButtonElement | null => target.querySelector<HTMLButtonElement>('[data-testid="bulk-superseded-open"]');

describe('a replaced run’s page', () => {
	it('links the run that took its place from its halt line, and opens it', async () => {
		await render();
		const button = link()!;
		expect(button.textContent?.trim()).toBe('Zum neueren Lauf');
		// The link stands in the halt line, next to the sentence that names the other run.
		expect(button.closest('dd')!.textContent).toContain('Du hast an seiner Stelle einen anderen Lauf gestartet');
		button.click();
		expect(opened).toEqual(['r2']);
	});

	it('reads in English as approved', async () => {
		setLocale('en');
		await render();
		expect(link()!.textContent?.trim()).toBe('Go to the newer run');
	});

	it('stands without a link when the engine sent no id, or an older engine sent none at all', async () => {
		run = makeRun({ supersededBy: null });
		await render();
		expect(link()).toBeNull();
		expect(target.textContent).toContain('Du hast an seiner Stelle einen anderen Lauf gestartet');
		unmount(component!);
		component = undefined;
		const { supersededBy: _gone, ...older } = makeRun();
		run = older as BulkRunDetailData;
		await render();
		expect(link()).toBeNull();
	});

	it('links nothing on a run that ended for another reason, even with an id', async () => {
		run = makeRun({ haltKey: 'discarded', haltReason: 'the owner discarded it', supersededBy: 'r2' });
		await render();
		expect(link()).toBeNull();
	});
});
