import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { readable } from 'svelte/store';
import { t, getLocale, setLocale } from '../i18n.svelte.js';
import { resetSettingsViewer } from '../stores/settings-viewer.svelte.js';
import type { BulkRunDetailData, BulkTarget } from './bulk-runs.js';

// lynox writes a judged run's rule, from the owner's words or from data it read. Where the owner
// starts the judging and where they approve its values, the page shows the rule and says who wrote
// it (U-335). A run without a judge has no rule and no sentence; a mandate is shown neither.

vi.mock('$app/stores', () => ({ page: readable({ url: new URL('http://localhost/app/activity?tab=bulk') }) }));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));

// `svelte` resolves to its server entry under node, where `mount` throws. The component is compiled
// for the client, so it is mounted with the client entry, loaded by path.
const CLIENT_ENTRY = join(dirname(createRequire(import.meta.url).resolve('svelte/package.json')), 'src/index-client.js');
type SvelteClient = {
	mount: (c: unknown, o: { target: Element; props?: Record<string, unknown> }) => Record<string, unknown>;
	unmount: (c: Record<string, unknown>) => void;
	flushSync: () => void;
	tick: () => Promise<void>;
};
const { mount, unmount, flushSync, tick } = (await import(/* @vite-ignore */ CLIENT_ENTRY)) as SvelteClient;

const RULE = 'Schreib für jedes Produkt einen SEO-Titel im Ton des Shops.';
const judged: Partial<BulkRunDetailData> = {
	judge: { tier: 'standard', unjudged: 0 }, judgeRuleHash: 'h1', judgeOwnKey: false,
	judgeServedBy: { provider: 'anthropic', label: 'Claude Sonnet' } as BulkRunDetailData['judgeServedBy'],
	judgeRule: { rule: RULE, schema: { properties: { seo_title: { type: 'string', maxLength: 70 } } }, tier: 'standard' } as BulkRunDetailData['judgeRule'],
};
/** A judged run waiting for its judging to start, its list read. */
const atStart: Partial<BulkRunDetailData> = { ...judged, phase: 'planned', haltKey: 'listed', haltReason: 'listed', checksum: null, total: 1, list: { state: 'done' } };

function makeRun(o: Partial<BulkRunDetailData> = {}): BulkRunDetailData {
	return {
		id: 'r1', createdAt: '2026-11-18T00:00:00Z', targetSystem: 'http:demo.myshopify.com', phase: 'previewed', total: 1,
		changes: { update: 1, create: 0, delete: 0, unchanged: 0, invalid: 0 }, applied: 0, failed: 0, conflicts: 0, sentUnknown: 0, undone: 0,
		kind: 'apply', atomic: false, sourceRunId: null, writeMethod: null, probeConfirmed: true, writeForm: 'measured', haltReason: null, haltKey: null,
		costUsd: 0, costCapUsd: null, judge: null, maxTargets: null, failedOnce: null, failureLimit: 0, resumeOpen: 0, resumeTries: 0, resumeSends: 0, deselected: 0,
		checksum: 'c1', writeFormNote: null, writeFormConfirmation: null, judgeModel: null, resumesAt: null, probe: null, undoable: 0,
		listFirstPage: null, listStartChecksum: null, listNote: null, listFilters: null, judgeRule: null, judgeRuleHash: null, judgeServedBy: null, judgeOwnKey: false,
		...o,
	};
}
const TARGETS: BulkTarget[] = [
	{ seq: 1, key: 'gid://shopify/Product/1', change: 'update', diff: { kind: 'fields', fields: [{ field: 'seo_title', before: 'Alt', after: 'Neu' }] } as BulkTarget['diff'], error: null, deselected: false },
];

let target: HTMLElement;
let component: Record<string, unknown> | undefined;
let run: BulkRunDetailData;
let viewer: 'owner' | 'mandate';
let locale: ReturnType<typeof getLocale>;

beforeEach(() => {
	locale = getLocale();
	setLocale('de');
	target = document.createElement('div');
	document.body.appendChild(target);
	resetSettingsViewer();
	viewer = 'owner';
	vi.stubGlobal('fetch', vi.fn(async (url: string) => {
		const u = String(url);
		const reply = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
		if (u.endsWith('/config')) return reply({ managed: true, viewer });
		const page = /\/targets\?offset=(\d+)&limit=(\d+)$/.exec(u);
		if (page) return reply({ targets: run.phase === 'previewed' ? TARGETS : [] });
		return reply(run);
	}));
});

afterEach(() => {
	if (component) unmount(component);
	component = undefined;
	target.remove();
	resetSettingsViewer();
	setLocale(locale);
	vi.unstubAllGlobals();
});

async function settle(): Promise<void> {
	for (let i = 0; i < 10; i++) {
		await new Promise((r) => setTimeout(r, 0));
		await tick();
		flushSync();
	}
}

async function render(o: Partial<BulkRunDetailData>): Promise<string> {
	run = makeRun(o);
	const { default: BulkRunDetail } = await import('./BulkRunDetail.svelte');
	component = mount(BulkRunDetail, { target, props: { runId: 'r1', onBack: () => {}, onOpen: () => {} } });
	await settle();
	return target.textContent ?? '';
}

const drafted = (): string[] => [...target.querySelectorAll('[data-testid="bulk-rule-drafted"]')].map((p) => p.textContent ?? '');

describe('a judged run says lynox wrote its rule', () => {
	it('says so under the rule where the owner starts the judging', async () => {
		const text = await render(atStart);
		expect(text).toContain(RULE);
		expect(drafted()).toEqual([t('bulk.start.rule_drafted')]);
	});

	it('shows the rule above the preview where the owner approves, and says so under it', async () => {
		await render(judged);
		const box = target.querySelector('[data-testid="bulk-approve-rule"]');
		expect(box?.textContent).toContain(RULE);
		expect(drafted()).toEqual([t('bulk.approve.rule_drafted')]);
		// Above the preview's list, not after it.
		const list = target.querySelector('table')!;
		expect(box!.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});

	it('reads in English as approved', async () => {
		setLocale('en');
		await render(judged);
		expect(drafted()).toEqual(['lynox wrote this rule. Check that it says what you want before you approve.']);
		unmount(component!);
		component = undefined;
		await render(atStart);
		expect(drafted()).toEqual(['lynox wrote this rule. Check that it says what you want before you start judging.']);
	});

	it('control: a run without a judge has no rule and no sentence, at its approval', async () => {
		await render({});
		expect(target.querySelector('[data-testid="bulk-approve-rule"]')).toBeNull();
		expect(drafted()).toEqual([]);
	});

	it('shows a mandate neither the rule nor the sentence at the approval', async () => {
		viewer = 'mandate';
		await render(judged);
		expect(target.querySelector('[data-testid="bulk-approve-rule"]')).toBeNull();
		expect(drafted()).toEqual([]);
	});
});
