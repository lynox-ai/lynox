import { describe, it, expect, vi, beforeEach, afterEach, onTestFinished } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { t, tf, getLocale, setLocale } from '../i18n.svelte.js';
import type { BulkRunDetailData, BulkTarget } from './bulk-runs.js';

// The undo offer and the undo approval name the targets of which it is open whether the change
// arrived apart from the written ones: the head counts only those as written, and the undo reads
// the open ones first. And the resume block says the window first, what may fail hangs on it.

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
		id: 'r1', createdAt: '2026-11-12T07:50:00Z', targetSystem: 'http:demo.myshopify.com', phase: 'aborted', total: 3,
		changes: { update: 2, create: 0, delete: 0, unchanged: 0, invalid: 0 }, applied: 0, failed: 1, conflicts: 0, sentUnknown: 0, undone: 0,
		kind: 'apply', atomic: false, sourceRunId: null, writeMethod: null, probeConfirmed: true, writeForm: 'unmeasured', haltReason: null, haltKey: null,
		costUsd: 0, costCapUsd: null, judge: null, maxTargets: 2, failedOnce: 0, failureLimit: 0, resumeOpen: 0, resumeTries: 0, resumeSends: 0, deselected: 0,
		checksum: null, writeFormNote: null, writeFormConfirmation: null, judgeModel: null, resumesAt: null, probe: null, undoable: 0,
		listFirstPage: null, listStartChecksum: null, listNote: null, listFilters: null, judgeRule: null, judgeRuleHash: null, judgeServedBy: null, judgeOwnKey: false,
		undoneBy: null,
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
	targets = [written(1, false), written(2, false)];
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

const text = (id: string): string | undefined => target.querySelector(`[data-testid="${id}"]`)?.textContent?.replace(/\s+/g, ' ').trim();
const buttons = (): string[] => [...target.querySelectorAll('button')].map((b) => b.textContent?.trim() ?? '');

describe('the undo offer with targets of which it is open whether the change arrived', () => {
	it('with none written, says no target is confirmed as written, and still offers the undo', async () => {
		setLocale('de');
		run = makeRun({ undoable: 1, undoableParts: { written: 0, open: 1 } });
		await render();
		const s = text('bulk-undo-explain');
		expect(s).toBe(tf('bulk.undo.explain_open_only_one', {}));
		expect(s).toMatch(/^Kein Ziel ist als geschrieben bestätigt\./);
		expect(s).not.toContain('jedem geschriebenen Ziel');
		expect(buttons()).toContain(t('bulk.undo.prepare'));
	});

	it('mixed, names the written targets and the open ones apart', async () => {
		setLocale('en');
		onTestFinished(() => setLocale('de'));
		run = makeRun({ phase: 'done', applied: 2, failed: 0, undoable: 3, undoableParts: { written: 2, open: 1 } });
		await render();
		expect(text('bulk-undo-explain')).toBe(tf('bulk.undo.explain_open_one', {}));
		expect(text('bulk-undo-explain')).toContain('For one more target it is unclear whether the change reached the provider.');
	});

	it('is not offered for a run whose only sends the host refused, though the engine counts them', async () => {
		setLocale('de');
		run = makeRun({ undoable: 2, undoableParts: { written: 0, open: 0 } });
		await render();
		expect(text('bulk-undo-explain')).toBeUndefined();
		expect(buttons()).not.toContain(t('bulk.undo.prepare'));
	});

	it('from an engine without the parts, is offered as before', async () => {
		setLocale('de');
		run = makeRun({ undoable: 1 });
		await render();
		expect(text('bulk-undo-explain')).toBe(t('bulk.undo.explain'));
		expect(buttons()).toContain(t('bulk.undo.prepare'));
	});

	it('with only written targets, keeps the sentence as it was', async () => {
		setLocale('de');
		run = makeRun({ phase: 'done', applied: 2, failed: 0, undoable: 2, undoableParts: { written: 2, open: 0 } });
		await render();
		expect(text('bulk-undo-explain')).toBe(t('bulk.undo.explain'));
	});
});

describe('the undo approval with targets that take back a write never confirmed', () => {
	it('does not count them as getting their value back', async () => {
		setLocale('de');
		// A page that loads a run whole shows it only when every target came: three targets for three.
		targets = [written(1, false), written(2, false), written(3, false)];
		run = makeRun({ kind: 'undo', phase: 'previewed', sourceRunId: 'r0', changes: { update: 3, create: 0, delete: 0, unchanged: 0, invalid: 0 }, failed: 0, undoable: 0, undoOpen: 1 });
		await render();
		expect(text('bulk-undo-approve-explain')).toBe('2 geschriebene Ziele bekommen ihren Wert von vorher zurück. Bei einem weiteren Ziel sieht die Rücknahme zuerst nach und setzt nur zurück, wo der Wert aus dem ursprünglichen Lauf steht. Ziele, die seither jemand geändert hat, bleiben, wie sie sind.');
	});

	it('with only such targets, says it checks them first', async () => {
		setLocale('de');
		run = makeRun({ total: 2, kind: 'undo', phase: 'previewed', sourceRunId: 'r0', changes: { update: 2, create: 0, delete: 0, unchanged: 0, invalid: 0 }, failed: 0, undoable: 0, undoOpen: 2 });
		await render();
		expect(text('bulk-undo-approve-explain')).toBe('Bei 2 Zielen sieht die Rücknahme zuerst nach und setzt nur zurück, wo der Wert aus dem ursprünglichen Lauf steht.');
		expect(text('bulk-undo-approve-explain')).not.toContain('zurückbekommen');
	});
});

describe('the resume block after a halt on failures', () => {
	it('says the window first and what may fail then right behind it, in one sentence pair', async () => {
		setLocale('de');
		run = makeRun({
			phase: 'writing', haltKey: 'failureRate', haltReason: 'x', total: 2, changes: { update: 1000, create: 0, delete: 0, unchanged: 0, invalid: 0 },
			maxTargets: 1000, applied: 550, failed: 51, failedOnce: 70, failureLimit: 50, resumeOpen: 398, resumeTries: 398, resumeSends: 398, undoable: 0,
		});
		await render();
		expect(text('bulk-resume-window')).toBe(`${t('bulk.resume.window')} Dabei dürfen noch einmal bis zu 50 Ziele scheitern, oder drei in Folge, bevor der Lauf wieder anhält.`);
		// No sentence of the block starts with the button's word twice any more.
		expect(target.textContent ?? '').not.toContain('Mit dem Weiterschreiben dürfen');
	});
});
