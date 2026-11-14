import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { BulkRunDetailData, BulkTarget } from './bulk-runs.js';
import { BULK_FOLLOW_MS, BULK_FOLLOW_MAX_MS, bulkWorkingStep } from './bulk-runs.js';
import { t, tf } from '../i18n.svelte.js';

// While the engine moves a run on by itself, the page keeps the counts and marks of its last load,
// so they agree with each other. Before, nothing showed that anything was happening: a walk saw
// „0 Ziele“ standing while lynox was already writing, and after ten minutes the page stopped
// asking without a word. Now a line names the step the engine works on and says the numbers move
// once it is done, and a sentence says when the page has stopped asking.

const CLIENT_ENTRY = join(dirname(createRequire(import.meta.url).resolve('svelte/package.json')), 'src/index-client.js');
type SvelteClient = {
	mount: (c: unknown, o: { target: Element; props?: Record<string, unknown> }) => Record<string, unknown>;
	unmount: (c: Record<string, unknown>) => void;
	flushSync: () => void;
	tick: () => Promise<void>;
};
const { mount, unmount, flushSync, tick } = (await import(/* @vite-ignore */ CLIENT_ENTRY)) as SvelteClient;

function makeRun(o: Partial<BulkRunDetailData> = {}): BulkRunDetailData {
	return {
		id: 'r1', createdAt: '2026-11-13T12:34:00Z', targetSystem: 'http:demo.myshopify.com', phase: 'planned', total: 0,
		changes: { update: 0, create: 0, delete: 0, unchanged: 0, invalid: 0 }, applied: 0, failed: 0, conflicts: 0, sentUnknown: 0, undone: 0,
		kind: 'apply', atomic: false, sourceRunId: null, writeMethod: null, probeConfirmed: false, writeForm: 'unmeasured', haltReason: null, haltKey: null,
		costUsd: 0, costCapUsd: null, judge: null, maxTargets: null, failedOnce: 0, failureLimit: 0, resumeOpen: 0, resumeTries: 0, resumeSends: 0, deselected: 0,
		checksum: null, writeFormNote: null, writeFormConfirmation: null, judgeModel: null, resumesAt: null, probe: null, undoable: 0,
		listFirstPage: null, listStartChecksum: null, listNote: null, listFilters: null, judgeRule: null, judgeRuleHash: null, judgeServedBy: null, judgeOwnKey: false,
		undoneBy: null,
		...o,
	};
}

let target: HTMLElement;
let component: Record<string, unknown> | undefined;
let run: BulkRunDetailData;
let runAsks: number;
let targetAsks: number;
let posts: string[];
// What the next ask for the run is answered with: 200 with the run, or a refusal.
let runStatus: number;
let retryAfter: string | null;
// Statuses for the next asks, one each, before `runStatus` applies again.
let nextStatuses: number[];
// Statuses for the next asks for targets, one each, before 200 applies again; and each ask's limit.
let targetStatuses: number[];
let targetLimits: number[];
// The run's targets as the engine serves them, page by page.
let allTargets: BulkTarget[];
let r1Fails = false;

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
	target = document.createElement('div');
	document.body.appendChild(target);
	run = makeRun();
	runAsks = 0;
	targetAsks = 0;
	posts = [];
	runStatus = 200;
	retryAfter = null;
	nextStatuses = [];
	targetStatuses = [];
	targetLimits = [];
	allTargets = [];
	r1Fails = false;
	Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
	vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
		const u = String(url);
		const reply = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
		if (u.endsWith('/config')) return reply({ managed: true, viewer: 'owner' });
		if (init?.method === 'POST') { posts.push(u); return reply({}); }
		if (/\/targets\?/.test(u)) {
			targetAsks++;
			targetLimits.push(Number(/limit=(\d+)/.exec(u)?.[1]));
			const ts = targetStatuses.shift() ?? 200;
			if (ts !== 200) return new Response('{}', { status: ts, headers: { 'Content-Type': 'application/json', ...(retryAfter !== null ? { 'Retry-After': retryAfter } : {}) } });
			const off = Number(/offset=(\d+)/.exec(u)?.[1]);
			return reply({ targets: allTargets.slice(off, off + targetLimits.at(-1)!) });
		}
		runAsks++;
		const status = nextStatuses.shift() ?? runStatus;
		if (status !== 200) return new Response(JSON.stringify({ error: 'Too many requests' }), { status, headers: { 'Content-Type': 'application/json', ...(retryAfter !== null ? { 'Retry-After': retryAfter } : {}) } });
		return reply(run);
	}));
});

afterEach(() => {
	if (component) unmount(component);
	component = undefined;
	target.remove();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

async function settle(): Promise<void> {
	for (let i = 0; i < 10; i++) {
		await vi.advanceTimersByTimeAsync(0);
		await tick();
		flushSync();
	}
}

async function render(): Promise<void> {
	const { default: BulkRunDetail } = await import('./BulkRunDetail.svelte');
	component = mount(BulkRunDetail, { target, props: { runId: 'r1', onBack: () => {}, onOpen: () => {} } });
	await settle();
}

/** Let `ms` pass, with the page's answers handled after each ask. */
async function pass(ms: number): Promise<void> {
	await vi.advanceTimersByTimeAsync(ms);
	await settle();
}

const shown = (): string => target.textContent ?? '';


const HOST = 'demo.myshopify.com';
const line = (): string | null => target.querySelector('[data-testid="bulk-working"]')?.textContent ?? null;
const stopped = (): string | null => target.querySelector('[data-testid="bulk-follow-stopped"]')?.textContent ?? null;
const working = (key: string): string => `${tf(key, { provider: HOST })} ${t('bulk.working.numbers')}`;

describe('the step the engine works on', () => {
	it('is the list while its first page is set, the targets without a judge, the judging with one, and the writing once approved', () => {
		const base = { haltKey: null, haltReason: null, listFirstPage: null, judge: null };
		expect(bulkWorkingStep({ ...base, phase: 'planned', listFirstPage: `https://${HOST}/admin/api/2026-10/graphql.json` })).toBe('list');
		expect(bulkWorkingStep({ ...base, phase: 'planned', listFirstPage: 'x', judge: { tier: 'standard', unjudged: 3 } })).toBe('list');
		expect(bulkWorkingStep({ ...base, phase: 'planned' })).toBe('read');
		expect(bulkWorkingStep({ ...base, phase: 'planned', judge: { tier: 'standard', unjudged: 3 } })).toBe('judge');
		expect(bulkWorkingStep({ ...base, phase: 'approved' })).toBe('write');
		expect(bulkWorkingStep({ ...base, phase: 'writing', judge: { tier: 'standard', unjudged: 0 } })).toBe('write');
		expect(bulkWorkingStep({ ...base, phase: 'writing', haltKey: 'unavailable', haltReason: 'unavailable' })).toBeNull();
		expect(bulkWorkingStep({ ...base, phase: 'planned', haltKey: 'awaitingStart', haltReason: 'awaitingStart' })).toBeNull();
		expect(bulkWorkingStep({ ...base, phase: 'previewed' })).toBeNull();
		expect(bulkWorkingStep({ ...base, phase: 'done' })).toBeNull();
	});
});

describe('a run the engine works on', () => {
	it('shows no working line while it reads the list, and the stopped sentence after the follow limit', async () => {
		run = makeRun({ listFirstPage: `https://${HOST}/admin/api/2026-10/graphql.json` });
		await render();
		expect(line()).toBeNull();
		expect(shown()).not.toContain(t('bulk.working.numbers'));
		await pass(BULK_FOLLOW_MAX_MS + BULK_FOLLOW_MS);
		expect(stopped()).toBe('Die Seite fragt nicht mehr nach; lade sie neu, um den Stand zu sehen.');
	});

	it('says lynox reads the targets', async () => {
		await render();
		expect(line()).toBe(`lynox liest die Ziele bei ${HOST} … Die Zahlen hier ändern sich, wenn dieser Schritt fertig ist.`);
	});

	it('says lynox judges the targets', async () => {
		run = makeRun({ judge: { tier: 'standard', unjudged: 4 } });
		await render();
		expect(line()).toBe('lynox beurteilt die Ziele … Die Zahlen hier ändern sich, wenn dieser Schritt fertig ist.');
	});

	it('says lynox writes the new values, approved and while writing', async () => {
		run = makeRun({ phase: 'approved', total: 3, changes: { update: 3, create: 0, delete: 0, unchanged: 0, invalid: 0 } });
		await render();
		expect(line()).toBe(`lynox schreibt die neuen Werte zu ${HOST} … Die Zahlen hier ändern sich, wenn dieser Schritt fertig ist.`);
		run = { ...run, phase: 'writing', applied: 1 };
		await pass(BULK_FOLLOW_MS);
		expect(line()).toBe(working('bulk.working.write'));
	});

	it('keeps the counts of its last load while it writes, and takes the new ones once the run is done', async () => {
		run = makeRun({ phase: 'writing', total: 3, changes: { update: 3, create: 0, delete: 0, unchanged: 0, invalid: 0 } });
		await render();
		const before = tf('bulk.head.counts', { n: '3', a: '0', c: '0', f: '0' });
		expect(shown()).toContain(before);
		run = { ...run, applied: 2 };
		await pass(BULK_FOLLOW_MS);
		expect(shown()).toContain(before);
		expect(line()).toBe(working('bulk.working.write'));
		run = { ...run, phase: 'done', applied: 3 };
		await pass(BULK_FOLLOW_MS);
		expect(shown()).toContain(tf('bulk.head.counts', { n: '3', a: '3', c: '0', f: '0' }));
		expect(line()).toBeNull();
		expect(stopped()).toBeNull();
	});

	it('stays as it is on a 429, with its line and without an error', async () => {
		run = makeRun({ phase: 'writing', total: 3 });
		await render();
		nextStatuses = [429, 429];
		retryAfter = '4';
		await pass(BULK_FOLLOW_MS);
		await pass(10_000);
		expect(line()).toBe(working('bulk.working.write'));
		expect(shown()).not.toContain(t('common.load_failed'));
	});

	it('says the page stopped asking after the follow limit, in place of the line, and asks no more', async () => {
		run = makeRun({ phase: 'writing', total: 3 });
		await render();
		await pass(BULK_FOLLOW_MAX_MS + BULK_FOLLOW_MS);
		expect(stopped()).toBe('Die Seite fragt nicht mehr nach; lade sie neu, um den Stand zu sehen.');
		expect(line()).toBeNull();
		const asks = runAsks;
		await pass(10 * BULK_FOLLOW_MS);
		expect(runAsks).toBe(asks);
	});

	it('shows no working line on an interrupted run, only the line that it resumes later', async () => {
		run = makeRun({ phase: 'writing', total: 3, resumesAt: '2026-11-14T12:00:00.000Z' });
		await render();
		expect(line()).toBeNull();
		expect(shown()).toContain('Unterbrochen. lynox setzt den Lauf ab');
	});

	it('shows no line on a run that waits for the owner, has halted, or is done', async () => {
		for (const o of [
			{ haltKey: 'awaitingStart', haltReason: 'awaitingStart' },
			{ phase: 'writing' as const, haltKey: 'unavailable', haltReason: 'unavailable' },
			{ phase: 'previewed' as const },
			{ phase: 'done' as const },
		]) {
			run = makeRun(o);
			await render();
			expect(line(), JSON.stringify(o)).toBeNull();
			expect(stopped(), JSON.stringify(o)).toBeNull();
			if (component) unmount(component);
			component = undefined;
		}
	});
});
