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

	it('says where the owner approves that a rule taken from an artifact came from it, its title set apart', async () => {
		await render({ ...judged, ruleFromArtifact: { title: 'Regeln » Shop' } });
		const origin = target.querySelector('[data-testid="bulk-approve-rule"] [data-testid="bulk-rule-from-artifact"]')!;
		const boxes = [...origin.querySelectorAll('[data-foreign-value]')];
		expect(boxes).toHaveLength(1);
		expect((origin.textContent ?? '').replace(boxes[0]!.textContent ?? '', '{title}')).toBe(t('bulk.approve.rule_from_artifact'));
		expect(drafted()).toEqual([]);
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

// Judging again after a halt goes on with the same rule: the owner sees it as at the first start,
// with a sentence that says it goes on.
describe('a judged run that judges again shows its rule as at the start', () => {
	const halted = (haltKey: string): Partial<BulkRunDetailData> => ({ ...judged, phase: 'planned', haltKey, haltReason: haltKey, checksum: null, total: 1, costCapUsd: 1 });

	it('shows the rule and the restart\'s sentence where the owner judges again after a halt', async () => {
		await render(halted('unavailable'));
		expect(target.querySelector('[data-testid="bulk-restart-rule"]')?.textContent).toContain(RULE);
		expect(drafted()).toEqual([t('bulk.restart.rule_drafted')]);
		expect(target.textContent).toContain(t('bulk.restart.judge'));
	});

	it('shows them too where judging again needs a higher cost cap', async () => {
		await render(halted('costCap'));
		// The page is at judging again with a new cap, not plain judging again.
		expect(target.textContent).toContain(t('bulk.restart.cap_whole'));
		expect(target.querySelector('[data-testid="bulk-restart-rule"]')?.textContent).toContain(RULE);
		expect(drafted()).toEqual([t('bulk.restart.rule_drafted')]);
	});

	it('control: a run without a judge that reads again shows no rule and no sentence', async () => {
		await render({ phase: 'planned', haltKey: 'unavailable', haltReason: 'unavailable', checksum: null, total: 1 });
		expect(target.textContent).toContain(t('bulk.restart.read'));
		expect(target.querySelector('[data-testid="bulk-restart-rule"]')).toBeNull();
		expect(drafted()).toEqual([]);
	});

	it('control: a judged run that reads on in its list shows no rule yet, as at its first start', async () => {
		await render({ ...halted('unavailable'), listFirstPage: 'p2' });
		expect(target.textContent).toContain(t('bulk.restart.list'));
		expect(target.querySelector('[data-testid="bulk-restart-rule"]')).toBeNull();
		expect(drafted()).toEqual([]);
	});

	it('shows a mandate neither the rule nor the sentence where the run would judge again', async () => {
		viewer = 'mandate';
		await render(halted('unavailable'));
		// The page reached the mandate's view, not an empty one.
		expect(target.textContent).toContain(t('bulk.owner_only_notice'));
		expect(target.querySelector('[data-testid="bulk-restart-rule"]')).toBeNull();
		expect(drafted()).toEqual([]);
	});

	it('shows a mandate no artifact title either where the run would judge again', async () => {
		viewer = 'mandate';
		await render({ ...halted('unavailable'), ruleFromArtifact: { title: 'Regeln » Shop' } });
		expect(target.textContent).toContain(t('bulk.owner_only_notice'));
		expect(target.querySelector('[data-testid="bulk-rule-from-artifact"]')).toBeNull();
		expect(target.textContent).not.toContain('Regeln » Shop');
	});

	it('reads in English as approved where judging goes on', async () => {
		setLocale('en');
		await render(halted('unavailable'));
		expect(drafted()).toEqual(['lynox wrote this rule. Check that it says what you want before you continue judging.']);
	});

	it('without an artifact keeps the very element it had, under the rule', async () => {
		await render(halted('unavailable'));
		const box = target.querySelector('[data-testid="bulk-restart-rule"]')!;
		// As before the artifact case came in: one paragraph, its test id and classes, the restart's own sentence.
		expect(box.lastElementChild?.outerHTML).toBe(`<p class="text-sm text-text-muted mt-1" data-testid="bulk-rule-drafted">${t('bulk.restart.rule_drafted')}</p>`);
		expect(box.querySelector('[data-testid="bulk-rule-from-artifact"]')).toBeNull();
	});

	it('says where judging goes on that a rule taken from an artifact came from it, its title set apart', async () => {
		await render({ ...halted('unavailable'), ruleFromArtifact: { title: 'Regeln » Shop' } });
		const origin = target.querySelector('[data-testid="bulk-restart-rule"] [data-testid="bulk-rule-from-artifact"]')!;
		const boxes = [...origin.querySelectorAll('[data-foreign-value]')];
		expect(boxes).toHaveLength(1);
		expect(boxes[0]!.textContent).toContain('Regeln » Shop');
		expect((origin.textContent ?? '').replace(boxes[0]!.textContent ?? '', '{title}')).toBe(t('bulk.restart.rule_from_artifact'));
		expect(drafted()).toEqual([]);
	});

	it('says so without a title where the artifact had none, also in English', async () => {
		await render({ ...halted('costCap'), ruleFromArtifact: {} });
		const origin = (): string => target.querySelector('[data-testid="bulk-restart-rule"] [data-testid="bulk-rule-from-artifact"]')?.textContent ?? '';
		expect(origin()).toBe(t('bulk.restart.rule_from_artifact_untitled'));
		expect(drafted()).toEqual([]);
		unmount(component!);
		component = undefined;
		setLocale('en');
		await render({ ...halted('unavailable'), ruleFromArtifact: {} });
		expect(origin()).toBe('This rule is taken word for word from a saved artifact. Check that it says what you want before you continue the judging.');
		unmount(component!);
		component = undefined;
		await render({ ...halted('unavailable'), ruleFromArtifact: { title: 'Shop rules' } });
		const box = target.querySelector('[data-testid="bulk-restart-rule"] [data-testid="bulk-rule-from-artifact"] [data-foreign-value]')!;
		expect(origin().replace(box.textContent ?? '', '{title}')).toBe('This rule is taken word for word from {title} under Artifacts. Check that it says what you want before you continue the judging.');
	});

	it('control: a judged run whose rule did not reach the page shows no empty box', async () => {
		await render({ ...halted('unavailable'), judgeRule: null });
		expect(target.textContent).toContain(t('bulk.restart.judge'));
		expect(target.querySelector('[data-testid="bulk-restart-rule"]')).toBeNull();
	});
});
