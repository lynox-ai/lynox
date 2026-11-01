import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { readable } from 'svelte/store';
import { t, tf, setLocale, getLocale } from '../i18n.svelte.js';
import { resetSettingsViewer } from '../stores/settings-viewer.svelte.js';
import { BULK_MANDATE_KEYS, bulkMandateI18n, type BulkMerge, type BulkRunDetailData, type BulkTarget } from './bulk-runs.js';

// Every act on a bulk run, and taking a merge back, is the owner's: the routes refuse a mandate.
// A mandate's session reads the runs and the merges without those buttons, and the run's page
// says once who can act. The owner's session keeps every button. A sentence that names an act
// of the owner's ("you approved", "you took out") names the owner to a mandate.

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

function makeRun(o: Partial<BulkRunDetailData> = {}): BulkRunDetailData {
	return {
		id: 'r1', createdAt: '2026-10-28T00:00:00Z', targetSystem: 'http:demo.myshopify.com', phase: 'previewed', total: 1,
		changes: { update: 1, create: 0, delete: 0, unchanged: 0, invalid: 0 }, applied: 0, failed: 0, conflicts: 0, sentUnknown: 0, undone: 0,
		kind: 'apply', atomic: false, sourceRunId: null, writeMethod: null, probeConfirmed: true, writeForm: 'measured', haltReason: null, haltKey: null,
		costUsd: 0, costCapUsd: null, judge: null, maxTargets: null, failedOnce: null, failureLimit: 0, resumeOpen: 0, resumeTries: 0, deselected: 0,
		checksum: 'c1', writeFormNote: null, writeFormConfirmation: null, judgeModel: null, resumesAt: null, probe: null, undoable: 0,
		listFirstPage: null, listStartChecksum: null, listNote: null, judgeRule: null, judgeRuleHash: null, judgeServedBy: null, judgeOwnKey: false,
		...o,
	};
}
const TARGETS: BulkTarget[] = [
	{ seq: 1, key: 'gid://shopify/Product/1', change: 'update', diff: { kind: 'fields', fields: [{ field: 'title', before: 'Alt', after: 'Neu' }] } as BulkTarget['diff'], error: null, deselected: false },
];
const MERGE: BulkMerge = {
	id: 'm1', createdAt: '2026-10-28T00:00:00Z', dupName: 'Anna M.', canonicalName: 'Anna Muster',
	applied: true, inEffect: true, superseded: false, dataStoreRows: 1, threadRows: 0,
};

let target: HTMLElement;
let component: Record<string, unknown> | undefined;
let run: BulkRunDetailData;
let viewer: 'owner' | 'mandate';
let shownTargets: BulkTarget[];

beforeEach(() => {
	target = document.createElement('div');
	document.body.appendChild(target);
	resetSettingsViewer();
	run = makeRun();
	viewer = 'mandate';
	shownTargets = TARGETS;
	vi.stubGlobal('fetch', vi.fn(async (url: string) => {
		const u = String(url);
		const reply = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
		if (u.endsWith('/config')) return reply({ managed: true, viewer });
		if (u.endsWith('/bulk/runs')) return reply({ runs: [run] });
		if (u.endsWith('/merges')) return reply({ merges: [MERGE] });
		const page = /\/targets\?offset=(\d+)&limit=(\d+)$/.exec(u);
		if (page) return reply({ targets: shownTargets.slice(Number(page[1]), Number(page[1]) + Number(page[2])) });
		return reply(run);
	}));
});

afterEach(() => {
	if (component) unmount(component);
	component = undefined;
	target.remove();
	resetSettingsViewer();
	vi.unstubAllGlobals();
});

async function settle(): Promise<void> {
	for (let i = 0; i < 10; i++) {
		await new Promise((r) => setTimeout(r, 0));
		await tick();
		flushSync();
	}
}

async function renderDetail(): Promise<void> {
	const { default: BulkRunDetail } = await import('./BulkRunDetail.svelte');
	component = mount(BulkRunDetail, { target, props: { runId: 'r1', onBack: () => {}, onOpen: () => {} } });
	await settle();
}

async function renderList(): Promise<void> {
	const { default: BulkRunsView } = await import('./BulkRunsView.svelte');
	component = mount(BulkRunsView, { target });
	await settle();
}

const buttonByText = (text: string): HTMLButtonElement | undefined =>
	[...target.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);

describe('a run\'s page as a mandate sees it', () => {
	it('shows a preview without approving or taking a target out, and says who can act', async () => {
		await renderDetail();
		expect(target.textContent).toContain('Product/1');
		expect(buttonByText(t('bulk.approve.approve'))).toBeUndefined();
		expect(buttonByText(t('bulk.deselect.off'))).toBeUndefined();
		expect(target.textContent).toContain(t('bulk.owner_only_notice'));
	});

	it('keeps approving and taking a target out for the owner, without the sentence', async () => {
		viewer = 'owner';
		await renderDetail();
		expect(buttonByText(t('bulk.approve.approve'))).toBeDefined();
		expect(buttonByText(t('bulk.deselect.off'))).toBeDefined();
		expect(target.textContent).not.toContain(t('bulk.owner_only_notice'));
	});

	it('says who starts a run that waits for its start, not which button to press', async () => {
		run = makeRun({ phase: 'planned', haltKey: 'awaitingStart', haltReason: 'engine English', total: 1, changes: { update: 0, create: 0, delete: 0, unchanged: 0, invalid: 0 } });
		await renderDetail();
		expect(buttonByText(t('bulk.start.read'))).toBeUndefined();
		expect(target.textContent).toContain(t('bulk.halt.wait_owner_only'));
		expect(target.textContent).not.toContain(t('bulk.halt.awaitingStart_start').replace('{button}', t('bulk.start.read')));
		expect(target.textContent).not.toContain('engine English');
	});

	it('names the start button to the owner of the same waiting run', async () => {
		viewer = 'owner';
		run = makeRun({ phase: 'planned', haltKey: 'awaitingStart', haltReason: 'engine English', total: 1, changes: { update: 0, create: 0, delete: 0, unchanged: 0, invalid: 0 } });
		await renderDetail();
		expect(buttonByText(t('bulk.start.read'))).toBeDefined();
		expect(target.textContent).toContain(t('bulk.halt.awaitingStart_start').replace('{button}', t('bulk.start.read')));
	});

	it('at a probe, names no step to a mandate, and offers neither confirming nor taking it back', async () => {
		run = makeRun({ phase: 'writing', haltKey: 'probeRequired', haltReason: 'engine English', applied: 1, probeConfirmed: false, probe: { key: 'gid://shopify/Product/1', fields: ['title'] } });
		await renderDetail();
		expect(buttonByText(t('bulk.probe.continue'))).toBeUndefined();
		expect(buttonByText(t('bulk.probe.undo_one'))).toBeUndefined();
		expect(target.textContent).toContain(t('bulk.halt.probeRequired_mandate'));
		expect(target.textContent).not.toContain(t('bulk.halt.probeRequired'));
		expect(target.textContent).not.toContain(t('bulk.halt.probeRequired_confirm'));
	});

	it('does not tell a mandate to check a read list and start it', async () => {
		run = makeRun({ phase: 'planned', haltKey: 'listed', haltReason: 'engine English', total: 1, listFirstPage: 'https://demo.myshopify.com/products.json', listStartChecksum: 'l1', changes: { update: 0, create: 0, delete: 0, unchanged: 0, invalid: 0 } });
		await renderDetail();
		expect(target.textContent).not.toContain(t('bulk.start.listed').replace('{n}', '1'));
		expect(target.textContent).toContain(t('bulk.start.list_note'));
	});
});

describe('the run list as a mandate sees it', () => {
	it('lists a merge without taking it back, and adds no sentence', async () => {
		await renderList();
		expect(target.textContent).toContain('Anna Muster');
		expect(buttonByText(t('bulk.merges.take_back'))).toBeUndefined();
		expect(target.textContent).not.toContain(t('bulk.owner_only_notice'));
	});

	it('offers the owner to take the merge back', async () => {
		viewer = 'owner';
		await renderList();
		expect(buttonByText(t('bulk.merges.take_back'))).toBeDefined();
	});
});

describe('a sentence that names an act of the owner\'s', () => {
	it('has a form naming the owner, in both languages, for every key a mandate reads so', () => {
		const locale = getLocale();
		try {
			for (const lang of ['de', 'en'] as const) {
				setLocale(lang);
				for (const key of BULK_MANDATE_KEYS) {
					const mandate = t(`${key}_mandate`);
					expect(mandate, `${lang} ${key}`).not.toBe(`${key}_mandate`);
					expect(mandate, `${lang} ${key}`).not.toBe(t(key));
					expect(bulkMandateI18n({ t, tf }).t(key), `${lang} ${key}`).toBe(mandate);
				}
				expect(bulkMandateI18n({ t, tf }).t('bulk.halt.wait_owner_only')).toBe(t('bulk.halt.wait_owner_only'));
			}
		} finally {
			setLocale(locale);
		}
	});

	const nothing = { update: 0, create: 0, delete: 0, unchanged: 0, invalid: 0 };
	const cases: { name: string; run: Partial<BulkRunDetailData>; targets?: BulkTarget[]; key: string; vars?: Record<string, string> }[] = [
		{ name: 'lynox skips a target of a preview', run: { total: 2, changes: { ...nothing, update: 1, invalid: 1 } },
			targets: [TARGETS[0]!, { seq: 2, key: 'gid://shopify/Product/2', change: 'invalid', diff: { kind: 'none' } as BulkTarget['diff'], error: 'not_found', deselected: false }],
			key: 'bulk.skipped.products', vars: { n: '1' } },
		{ name: 'lynox skips one target of another host and one was taken out', run: { targetSystem: 'http:api.example.com', total: 3, deselected: 1, changes: { ...nothing, update: 1, invalid: 1 } },
			targets: [
				{ ...TARGETS[0]!, key: 'https://api.example.com/items/1' },
				{ seq: 2, key: 'https://api.example.com/items/2', change: 'invalid', diff: { kind: 'none' } as BulkTarget['diff'], error: 'not_found', deselected: false },
				{ ...TARGETS[0]!, seq: 3, key: 'https://api.example.com/items/3', deselected: true },
			],
			key: 'bulk.skipped.both_targets', vars: { n: '1', m: '1' } },
		{ name: 'a target was taken out', run: { total: 2, deselected: 1, changes: { ...nothing, update: 1 } },
			targets: [TARGETS[0]!, { ...TARGETS[0]!, seq: 2, key: 'gid://shopify/Product/2', deselected: true }],
			key: 'bulk.deselect.taken_out' },
		{ name: 'a judged run reached its spend limit', run: { phase: 'planned', haltKey: 'costCap', haltReason: 'engine English', judge: {} as BulkRunDetailData['judge'], costCapUsd: 2, costUsd: 2, changes: nothing },
			key: 'bulk.halt.costCap', vars: { cap: '2.00', spent: '2.00' } },
		{ name: 'another judged run took its place', run: { phase: 'aborted', haltKey: 'superseded', haltReason: 'engine English', changes: nothing },
			key: 'bulk.halt.superseded' },
		{ name: 'the run changed since it was approved', run: { phase: 'writing', haltKey: 'checksum', haltReason: 'engine English', applied: 0 },
			key: 'bulk.halt.checksum' },
		{ name: 'Shopify writes were switched off while it wrote', run: { phase: 'writing', haltKey: 'shopifyWriteOff', haltReason: 'engine English', applied: 0 },
			key: 'bulk.halt.shopifyWriteOff' },
		{ name: 'the access of whoever planned it ended', run: { phase: 'aborted', haltKey: 'mandateEnded', haltReason: 'engine English', changes: nothing },
			key: 'bulk.halt.mandateEnded' },
		{ name: 'a probe waits for its confirmation', run: { phase: 'writing', haltKey: 'probeRequired', haltReason: 'engine English', applied: 1, probeConfirmed: false, probe: { key: 'gid://shopify/Product/1', fields: ['title'] } },
			key: 'bulk.halt.probeRequired' },
	];

	for (const c of cases) {
		it(`names the owner to a mandate, and keeps "you" for the owner, when ${c.name}`, async () => {
			const text = (key: string): string => (c.vars ? tf(key, c.vars) : t(key));
			const show = async (who: 'owner' | 'mandate'): Promise<string> => {
				resetSettingsViewer();
				viewer = who;
				run = makeRun(c.run);
				shownTargets = c.targets ?? TARGETS;
				await renderDetail();
				const seen = target.textContent ?? '';
				if (component) unmount(component);
				component = undefined;
				return seen;
			};
			const asMandate = await show('mandate');
			expect(asMandate).toContain(text(`${c.key}_mandate`));
			expect(asMandate).not.toContain(text(c.key));
			const asOwner = await show('owner');
			expect(asOwner).toContain(text(c.key));
			// A mandate's form may be the owner's first sentence alone; the owner's full one is asserted above.
			if (!text(c.key).includes(text(`${c.key}_mandate`))) expect(asOwner).not.toContain(text(`${c.key}_mandate`));
		});
	}

	it('tells a mandate on the list who approves and takes back, and the owner that it is them', async () => {
		await renderList();
		expect(target.textContent).toContain(t('bulk.intro_mandate'));
		expect(target.textContent).not.toContain(t('bulk.intro'));
		unmount(component!);
		component = undefined;
		resetSettingsViewer();
		viewer = 'owner';
		await renderList();
		expect(target.textContent).toContain(t('bulk.intro'));
	});
});
