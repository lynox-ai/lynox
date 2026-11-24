import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { BulkRunDetailData, BulkTarget } from './bulk-runs.js';
import { BULK_FOLLOW_MS, BULK_FOLLOW_MAX_MS, bulkWorkingStep, bulkWorkingLine, bulkHeadCounts } from './bulk-runs.js';
import { t, tf } from '../i18n.svelte.js';
import { formatCost } from '../format.js';

// While the engine moves a run on by itself, a line names the step it works on, with the run's
// numbers where the engine counts them, and the head takes the counts of each ask. Before, nothing
// showed that anything was happening: a walk saw „0 Ziele“ standing while lynox was already
// writing, a running undo looked like a finished one, and after ten minutes the page stopped
// asking without a word. While the list is read, the title and the head show a dash; until the
// run writes, the head names only the number of targets, not a written count that reads as done.
// A sentence says when the page has stopped asking.

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
// While set, the run's answer arrives but its body is read only once this settles.
let holdBody: Promise<void> | null = null;

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
	holdBody = null;
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
		const res = reply(run);
		if (holdBody !== null) {
			const hold = holdBody;
			const snap = run;
			res.json = async () => { await hold; return snap; };
		}
		return res;
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
const counts = (): string | null => target.querySelector('[data-testid="bulk-counts"]')?.textContent ?? null;
const title = (): string | null => target.querySelector('[data-testid="bulk-title"]')?.textContent ?? null;
const stopped = (): string | null => target.querySelector('[data-testid="bulk-follow-stopped"]')?.textContent ?? null;
const UPDATES = (n: number) => ({ update: n, create: 0, delete: 0, unchanged: 0, invalid: 0 });

describe('the step the engine works on', () => {
	it('is the list while its first page is set, the targets without a judge, the judging with one, the writing once approved, and the taking back for an undo', () => {
		const base = { haltKey: null, haltReason: null, listFirstPage: null, judge: null, kind: 'apply' as const };
		expect(bulkWorkingStep({ ...base, phase: 'planned', listFirstPage: `https://${HOST}/admin/api/2026-10/graphql.json` })).toBe('list');
		expect(bulkWorkingStep({ ...base, phase: 'planned', listFirstPage: 'x', judge: { tier: 'standard', unjudged: 3 } })).toBe('list');
		expect(bulkWorkingStep({ ...base, phase: 'planned' })).toBe('read');
		expect(bulkWorkingStep({ ...base, phase: 'planned', judge: { tier: 'standard', unjudged: 3 } })).toBe('judge');
		expect(bulkWorkingStep({ ...base, phase: 'approved' })).toBe('write');
		expect(bulkWorkingStep({ ...base, phase: 'writing', judge: { tier: 'standard', unjudged: 0 } })).toBe('write');
		expect(bulkWorkingStep({ ...base, phase: 'writing', kind: 'undo' })).toBe('undo');
		expect(bulkWorkingStep({ ...base, phase: 'approved', kind: 'undo' })).toBe('undo');
		expect(bulkWorkingStep({ ...base, phase: 'writing', haltKey: 'unavailable', haltReason: 'unavailable' })).toBeNull();
		expect(bulkWorkingStep({ ...base, phase: 'writing', kind: 'undo', haltKey: 'unavailable', haltReason: 'unavailable' })).toBeNull();
		expect(bulkWorkingStep({ ...base, phase: 'planned', haltKey: 'awaitingStart', haltReason: 'awaitingStart' })).toBeNull();
		expect(bulkWorkingStep({ ...base, phase: 'previewed' })).toBeNull();
		expect(bulkWorkingStep({ ...base, phase: 'done' })).toBeNull();
	});

	it('counts the verdicts out of what the judge reads, and the written targets out of every target the run plans to write', () => {
		const r = { applied: 2, changes: { ...UPDATES(3), create: 1, delete: 1, unchanged: 4, invalid: 2 }, judge: { tier: 'fast', unjudged: 3, judged: 4 } };
		expect(bulkWorkingLine('judge', r)).toEqual({ key: 'bulk.working.judge', params: { k: '4', n: '7' } });
		expect(bulkWorkingLine('judge', { ...r, judge: { tier: 'fast', unjudged: 3 } })).toEqual({ key: 'bulk.working.judge_open', params: {} });
		expect(bulkWorkingLine('write', r)).toEqual({ key: 'bulk.working.write', params: { a: '2', n: '5' } });
		// Targets found as planned count as applied without taking from an approval's maximum: the
		// count stays within the targets the run plans, never above them.
		expect(bulkWorkingLine('write', { ...r, applied: 5 })).toEqual({ key: 'bulk.working.write', params: { a: '5', n: '5' } });
		expect(bulkWorkingLine('undo', r)).toEqual({ key: 'bulk.working.undo', params: { a: '2', n: '5' } });
		expect(bulkWorkingLine('list', r)).toEqual({ key: 'bulk.working.list', params: {} });
		expect(bulkWorkingLine('read', r)).toEqual({ key: 'bulk.working.read', params: {} });
	});
});

describe('a run the engine works on', () => {
	it('says lynox reads the list, with a dash for the counts and the title, and the stopped sentence after the follow limit', async () => {
		run = makeRun({ total: 0, changes: UPDATES(0), listFirstPage: `https://${HOST}/admin/api/2026-10/graphql.json` });
		await render();
		expect(line()).toBe('lynox liest die Liste …');
		expect(counts()).toBe('–');
		expect(title()).toMatch(/^– Ziele · /);
		await pass(BULK_FOLLOW_MAX_MS + BULK_FOLLOW_MS);
		expect(stopped()).toBe('Die Seite fragt nicht mehr nach; lade sie neu, um den Stand zu sehen.');
	});

	it('says lynox reads the targets, with their number in the head and the title but no written count that reads as done', async () => {
		run = makeRun({ total: 4, changes: UPDATES(4) });
		await render();
		expect(line()).toBe(`lynox liest die Ziele bei ${HOST} …`);
		expect(counts()).toBe('4');
		expect(title()).toMatch(/^4 Ziele · /);
		expect(shown()).not.toContain('geschrieben 0');
	});

	it('says lynox judges, with the verdicts so far out of the targets it reads, moves with each ask, and the head names only the targets', async () => {
		run = makeRun({ total: 5, judge: { tier: 'standard', unjudged: 4, judged: 1 } });
		await render();
		expect(line()).toBe('lynox urteilt … 1 von 5');
		run = { ...run, judge: { tier: 'standard', unjudged: 1, judged: 4 } };
		await pass(BULK_FOLLOW_MS);
		expect(line()).toBe('lynox urteilt … 4 von 5');
		expect(counts()).toBe('5');
		expect(title()).toMatch(/^5 Ziele · /);
	});

	it('says lynox judges without numbers where the engine does not count the verdicts', async () => {
		run = makeRun({ judge: { tier: 'standard', unjudged: 4 } });
		await render();
		expect(line()).toBe('lynox urteilt …');
	});

	it('says lynox writes, with the written targets out of those it writes, approved and while writing, and the head moves too', async () => {
		run = makeRun({ phase: 'approved', total: 4, changes: { ...UPDATES(3), unchanged: 1 } });
		await render();
		expect(line()).toBe('lynox schreibt … 0 von 3');
		run = { ...run, phase: 'writing', applied: 2 };
		await pass(BULK_FOLLOW_MS);
		expect(line()).toBe('lynox schreibt … 2 von 3');
		expect(counts()).toBe(tf('bulk.head.counts', { n: '4', a: '2', c: '0', f: '0' }));
	});

	it('says lynox takes back an undo with its numbers, so a running undo does not look finished, and the head counts what it took back', async () => {
		run = makeRun({ kind: 'undo', sourceRunId: 'r0', phase: 'writing', total: 3, changes: UPDATES(3), applied: 1 });
		await render();
		expect(line()).toBe('lynox nimmt zurück … 1 von 3');
		expect(counts()).toBe('3 · zurückgenommen 1 · Konflikte 0 · fehlgeschlagen 0');
		run = { ...run, applied: 2 };
		await pass(BULK_FOLLOW_MS);
		expect(line()).toBe('lynox nimmt zurück … 2 von 3');
		expect(counts()).toBe('3 · zurückgenommen 2 · Konflikte 0 · fehlgeschlagen 0');
	});

	it('takes the whole run once it is done, and shows no line then', async () => {
		run = makeRun({ phase: 'writing', total: 3, changes: UPDATES(3) });
		await render();
		run = { ...run, phase: 'done', applied: 3 };
		await pass(BULK_FOLLOW_MS);
		expect(counts()).toBe(tf('bulk.head.counts', { n: '3', a: '3', c: '0', f: '0' }));
		expect(line()).toBeNull();
		expect(stopped()).toBeNull();
	});

	it('loads the run anew when it moves on from reading the list, and then judges with its numbers', async () => {
		run = makeRun({ listFirstPage: `https://${HOST}/admin/api/2026-10/graphql.json` });
		await render();
		expect(line()).toBe('lynox liest die Liste …');
		const asks = targetAsks;
		run = { ...run, listFirstPage: null, total: 4, changes: UPDATES(4), judge: { tier: 'standard', unjudged: 3, judged: 1 } };
		await pass(BULK_FOLLOW_MS);
		expect(line()).toBe('lynox urteilt … 1 von 4');
		expect(counts()).toBe('4');
		// Loaded anew, its targets with it.
		expect(targetAsks).toBeGreaterThan(asks);
	});

	it('loads the run anew when it jumps to writing between two asks, so the line counts its planned targets', async () => {
		run = makeRun({ total: 3, judge: { tier: 'standard', unjudged: 3, judged: 0 } });
		await render();
		run = { ...run, phase: 'writing', changes: UPDATES(3), applied: 1, judge: { tier: 'standard', unjudged: 0, judged: 3 } };
		await pass(BULK_FOLLOW_MS);
		expect(line()).toBe('lynox schreibt … 1 von 3');
	});

	it('drops an answer that arrives after the page is gone, and loads nothing for it', async () => {
		run = makeRun({ total: 3, judge: { tier: 'standard', unjudged: 3, judged: 0 } });
		await render();
		let release!: () => void;
		holdBody = new Promise((r) => { release = r; });
		// The answer names another step, which would load the run anew.
		run = { ...run, phase: 'writing', changes: UPDATES(3), applied: 1, judge: { tier: 'standard', unjudged: 0, judged: 3 } };
		await pass(BULK_FOLLOW_MS);
		const asks = runAsks;
		const tAsks = targetAsks;
		expect(asks).toBeGreaterThan(1);
		if (component) unmount(component);
		component = undefined;
		holdBody = null;
		release();
		await pass(BULK_FOLLOW_MS);
		expect(runAsks).toBe(asks);
		expect(targetAsks).toBe(tAsks);
	});

	it('takes the cost and a pause with each ask while the run works', async () => {
		run = makeRun({ total: 4, costUsd: 0.1, costCapUsd: 1, judge: { tier: 'standard', unjudged: 3, judged: 1 } });
		await render();
		expect(shown()).toContain(`${formatCost(0.1)} / ${formatCost(1)}`);
		run = { ...run, costUsd: 0.4, judge: { tier: 'standard', unjudged: 2, judged: 2 } };
		await pass(BULK_FOLLOW_MS);
		expect(shown()).toContain(`${formatCost(0.4)} / ${formatCost(1)}`);
		run = { ...run, resumesAt: '2026-11-14T12:00:00.000Z' };
		await pass(BULK_FOLLOW_MS);
		expect(line()).toBeNull();
		expect(shown()).toContain('Unterbrochen. lynox setzt den Lauf ab');
	});

	it('says it in English too', async () => {
		const { setLocale } = await import('../i18n.svelte.js');
		setLocale('en');
		try {
			run = makeRun({ kind: 'undo', sourceRunId: 'r0', phase: 'writing', total: 3, changes: UPDATES(3), applied: 1 });
			await render();
			expect(line()).toBe('lynox is undoing … 1 of 3');
		} finally { setLocale('de'); }
	});

	it('stays as it is on a 429, with its line and without an error', async () => {
		run = makeRun({ phase: 'writing', total: 3, changes: UPDATES(3) });
		await render();
		nextStatuses = [429, 429];
		retryAfter = '4';
		await pass(BULK_FOLLOW_MS);
		await pass(10_000);
		expect(line()).toBe('lynox schreibt … 0 von 3');
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

	it('shows no line on a run that waits for the owner, has halted, or is done, and its counts once it has written', async () => {
		for (const o of [
			{ haltKey: 'awaitingStart', haltReason: 'awaitingStart' },
			{ phase: 'writing' as const, haltKey: 'unavailable', haltReason: 'unavailable' },
			{ phase: 'writing' as const, kind: 'undo' as const, haltKey: 'unavailable', haltReason: 'unavailable' },
			{ phase: 'previewed' as const },
			{ phase: 'done' as const },
		]) {
			// A preview loads every target to be approved; this one has none to load.
			const n = 'phase' in o && o.phase === 'previewed' ? 0 : 2;
			run = makeRun({ total: n, ...o });
			await render();
			expect(line(), JSON.stringify(o)).toBeNull();
			expect(stopped(), JSON.stringify(o)).toBeNull();
			// Before the run writes (waiting to start, previewed), only the number of targets stands.
			const wrote = 'phase' in o && o.phase !== 'previewed';
			expect(counts(), JSON.stringify(o)).toBe(wrote ? tf('kind' in o ? 'bulk.head.counts_undo' : 'bulk.head.counts', { n: String(n), a: '0', c: '0', f: '0' }) : String(n));
			if (component) unmount(component);
			component = undefined;
		}
	});

	it('names only the targets in the head until the run writes, at the approval too, and the counts once one failed, conflicts or is written before', async () => {
		run = makeRun({ phase: 'approved', total: 3, changes: UPDATES(3), haltKey: 'awaitingStart', haltReason: 'awaitingStart' });
		await render();
		expect(counts()).toBe('3');
		if (component) unmount(component);
		component = undefined;
		// A target failed while the run was still approved: the counts stand, it has begun to write.
		run = makeRun({ phase: 'approved', total: 3, changes: UPDATES(3), failed: 1, haltKey: 'unavailable', haltReason: 'unavailable' });
		await render();
		expect(counts()).toBe(tf('bulk.head.counts', { n: '3', a: '0', c: '0', f: '1' }));
		// Each count on its own opens the counts: a conflict the read found, a target written.
		const i18n = { t, tf };
		const before = { kind: 'apply' as const, phase: 'planned' as const, total: 3, applied: 0, conflicts: 0, failed: 0 };
		expect(bulkHeadCounts(null, before, i18n)).toBe('3');
		expect(bulkHeadCounts(null, { ...before, conflicts: 1 }, i18n)).toBe(tf('bulk.head.counts', { n: '3', a: '0', c: '1', f: '0' }));
		expect(bulkHeadCounts(null, { ...before, phase: 'approved', applied: 1 }, i18n)).toBe(tf('bulk.head.counts', { n: '3', a: '1', c: '0', f: '0' }));
	});
});
