import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { t, tf } from '../i18n.svelte.js';
import type { BulkRunDetailData, BulkTarget } from './bulk-runs.js';

// The approval of a preview: the owner sees every target, why lynox leaves one out, can take one
// out of the write, and cannot press an approval the engine would refuse for want of a target.

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

const fieldsDiff = (before: string, after: string): BulkTarget['diff'] =>
	({ kind: 'fields', fields: [{ field: 'title', before, after }] }) as BulkTarget['diff'];

function makeRun(o: Partial<BulkRunDetailData> = {}): BulkRunDetailData {
	return {
		id: 'r1', createdAt: '2026-10-28T00:00:00Z', targetSystem: 'http:demo.myshopify.com', phase: 'previewed', total: 3,
		changes: { update: 1, create: 0, delete: 0, unchanged: 1, invalid: 1 }, applied: 0, failed: 0, conflicts: 0, sentUnknown: 0, undone: 0,
		kind: 'apply', atomic: false, sourceRunId: null, writeMethod: null, probeConfirmed: false, writeForm: 'measured', haltReason: null, haltKey: null,
		costUsd: 0, costCapUsd: null, judge: null, maxTargets: null, failedOnce: null, failureLimit: 0, resumeOpen: 0, resumeTries: 0, resumeSends: 0, deselected: 0,
		checksum: 'c1', writeFormNote: null, writeFormConfirmation: null, judgeModel: null, resumesAt: null, probe: null, undoable: 0,
		listFirstPage: null, listStartChecksum: null, listNote: null, listFilters: null, judgeRule: null, judgeRuleHash: null, judgeServedBy: null, judgeOwnKey: false,
		...o,
	};
}
const TARGETS: BulkTarget[] = [
	{ seq: 1, key: 'gid://shopify/Product/1', change: 'update', diff: fieldsDiff('Alt', 'Neu'), error: null, deselected: false },
	{ seq: 2, key: 'gid://shopify/Product/2', change: 'unchanged', diff: { kind: 'none' } as BulkTarget['diff'], error: null, deselected: false },
	{ seq: 3, key: 'gid://shopify/Product/3', change: 'invalid', diff: { kind: 'none' } as BulkTarget['diff'], error: 'not_found', deselected: false },
];

let target: HTMLElement;
let component: Record<string, unknown> | undefined;
let run: BulkRunDetailData;
let targets: BulkTarget[];
let posts: { url: string; body: unknown }[];
let gets: string[];
let refuseDeselect: string | null;
let refuseResume: string | null;

beforeEach(() => {
	target = document.createElement('div');
	document.body.appendChild(target);
	run = makeRun();
	targets = TARGETS.map((x) => ({ ...x }));
	posts = [];
	gets = [];
	refuseDeselect = null;
	refuseResume = null;
	vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
		const u = String(url);
		const reply = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
		if (init?.method === 'POST') {
			const body = JSON.parse(String(init.body)) as unknown;
			posts.push({ url: u, body });
			const m = /\/targets\/(\d+)\/deselect$/.exec(u);
			if (m && refuseDeselect !== null) return reply({ error: 'engine English', code: refuseDeselect }, 409);
			if (u.endsWith('/resume') && refuseResume !== null) return reply({ error: 'engine English', code: refuseResume }, 409);
			if (m) {
				const seq = Number(m[1]);
				targets = targets.map((x) => (x.seq === seq ? { ...x, deselected: true } : x));
				run = { ...run, checksum: 'c2', deselected: run.deselected + 1, changes: { ...run.changes, update: run.changes.update - 1 } };
				return reply({ checksum: 'c2' });
			}
			return reply({});
		}
		gets.push(u);
		// The owner's session: the page offers its acts only once the server says so.
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

const buttonByText = (text: string): HTMLButtonElement | undefined =>
	[...target.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);

describe('approving a preview', () => {
	it('shows why lynox leaves a product out, and folds the unchanged one until asked', async () => {
		await render();
		expect(target.textContent).toContain(t('bulk.invalid.not_found'));
		expect(target.textContent).toContain('Product/1');
		expect(target.textContent).not.toContain('Product/2');
		buttonByText(t('bulk.preview.show_unchanged_one'))!.click();
		await settle();
		expect(target.textContent).toContain('Product/2');
	});

	it('folds the one unchanged target of another host under a button in the singular', async () => {
		run = makeRun({ targetSystem: 'http:api.example.com' });
		targets = targets.map((x) => ({ ...x, key: `https://api.example.com/items/${String(x.seq)}` }));
		await render();
		expect(target.textContent).not.toContain('items/2');
		buttonByText(t('bulk.preview.show_unchanged_targets_one'))!.click();
		await settle();
		expect(target.textContent).toContain('items/2');
	});

	it('shows a description lynox does not write for a shortcode, whole, under the reason (1130)', async () => {
		const planned = '<p>Neu</p>[button url="https://shop.example.com/sale?cat=tee&size=m"]Zum Angebot[/button]';
		// The fixture's third product, refused for the shortcode instead of not being found.
		targets = targets.map((x) => (x.seq === 3 ? { ...x, error: 'shortcode_changed', refusedValues: [{ field: 'descriptionHtml', value: planned }] } : x));
		await render();
		const blocks = target.querySelectorAll('[data-testid="bulk-refused-value-text"]');
		expect(blocks, 'one block, for the shortcode target only').toHaveLength(1);
		expect(target.textContent).toContain(t('bulk.invalid.shortcode_changed').slice(0, 40));
		expect(blocks[0]!.textContent).toBe(planned);
		// One field refused: no field name over the block, as ux released it.
		expect(target.textContent).not.toContain('descriptionHtml:');
	});

	it('shows each refused field under its name when a product has more than one (1130)', async () => {
		const a = '[box a="1&2"]x[/box]';
		const b = '[pbutton url="/b?x=1&y=2"]Los[/pbutton]';
		targets = targets.map((x) => (x.seq === 3 ? { ...x, error: 'shortcode_changed', refusedValues: [{ field: 'description', value: a }, { field: 'short_description', value: b }] } : x));
		await render();
		const blocks = [...target.querySelectorAll('[data-testid="bulk-refused-value-text"]')].map((e) => e.textContent);
		expect(blocks).toEqual([a, b]);
		expect(target.textContent).toContain('description:');
		expect(target.textContent).toContain('short_description:');
	});

	it('says a run of one target is done after it, takes the product out against the checksum it showed, and then keeps only why nothing is left', async () => {
		await render();
		// One target to write: the first write is the whole run.
		const approve = buttonByText(t('bulk.approve.write_only'))!;
		expect(approve.disabled).toBe(false);
		expect(target.textContent).toContain(t('bulk.approve.only_one'));
		expect(target.textContent).not.toContain(t('bulk.approve.one_first'));
		expect(buttonByText(t('bulk.approve.write_one'))).toBeUndefined();
		buttonByText(t('bulk.deselect.off'))!.click();
		await settle();
		expect(posts).toEqual([{ url: expect.stringMatching(/\/bulk\/runs\/r1\/targets\/1\/deselect$/) as unknown as string, body: { checksum: 'c1' } }]);
		expect(target.textContent).toContain(t('bulk.deselect.taken_out'));
		expect(buttonByText(t('bulk.deselect.on'))).toBeDefined();
		// Nothing left to write: the sentence and a way back, no button that cannot act and no note on a write.
		const block = [...target.querySelectorAll('h2')].find((h) => h.textContent === t('bulk.approve.title'))!.parentElement!;
		expect(block.querySelector('#bulk-approve-nothing')?.textContent).toBe(t('bulk.nothing.products'));
		expect([...block.querySelectorAll('button')].map((b) => b.textContent?.trim())).toEqual([t('bulk.not_now')]);
		for (const key of ['bulk.approve.only_one', 'bulk.approve.one_first', 'bulk.approve.shopify_visible']) expect(block.textContent).not.toContain(t(key));
	});

	it('keeps only why nothing is left on an unchecked filtered run: no note, no confirmation, no filter', async () => {
		run = makeRun({ targetSystem: 'http:api.example.com', writeForm: 'unmeasured', listFilters: { product_type: 'Tee' }, total: 1, changes: { update: 0, create: 0, delete: 0, unchanged: 0, invalid: 1 } });
		targets = [{ seq: 1, key: 'https://api.example.com/items/1', change: 'invalid', diff: { kind: 'none' } as BulkTarget['diff'], error: 'not_found', deselected: false }];
		await render();
		const block = [...target.querySelectorAll('h2')].find((h) => h.textContent === t('bulk.approve.title'))!.parentElement!;
		expect(block.querySelector('#bulk-approve-nothing')).not.toBeNull();
		expect(block.querySelectorAll('input')).toHaveLength(0);
		for (const key of ['bulk.approve.unmeasured_note', 'bulk.approve.unmeasured_note_one', 'bulk.approve.unmeasured_confirm']) expect(block.textContent).not.toContain(t(key));
		expect(block.textContent).not.toContain('Tee');
	});

	it('cuts the unchecked note to its first two sentences at one target to write, and keeps it whole at two', async () => {
		const unchecked = (update: number): BulkRunDetailData => makeRun({ targetSystem: 'http:api.example.com', writeForm: 'unmeasured', changes: { update, create: 0, delete: 0, unchanged: 0, invalid: 3 - update } });
		run = unchecked(1);
		targets = targets.map((x) => ({ ...x, key: `https://api.example.com/items/${String(x.seq)}` }));
		await render();
		expect(target.textContent).toContain(t('bulk.approve.unmeasured_note_one'));
		expect(target.textContent).not.toContain(t('bulk.approve.unmeasured_note'));
		expect(target.textContent).toContain(t('bulk.approve.only_one'));
		unmount(component!);
		component = undefined;
		run = unchecked(2);
		targets = targets.map((x) => (x.seq === 2 ? { ...x, change: 'update', diff: TARGETS[0]!.diff } : x));
		await render();
		expect(target.textContent).toContain(t('bulk.approve.unmeasured_note'));
		expect(target.textContent).toContain(t('bulk.approve.one_first'));
	});

	it('writes one target first and leaves the rest to approve when there are two', async () => {
		run = makeRun({ changes: { update: 2, create: 0, delete: 0, unchanged: 0, invalid: 1 } });
		targets = targets.map((x) => (x.seq === 2 ? { ...x, change: 'update', diff: TARGETS[0]!.diff } : x));
		await render();
		expect(target.textContent).toContain(t('bulk.approve.one_first'));
		expect(target.textContent).not.toContain(t('bulk.approve.only_one'));
		expect(buttonByText(t('bulk.approve.write_one'))?.disabled).toBe(false);
		expect(buttonByText(t('bulk.approve.write_only'))).toBeUndefined();
	});

	it('offers no way out on a product lynox leaves out, and none on an unchanged one', async () => {
		await render();
		buttonByText(t('bulk.preview.show_unchanged_one'))!.click();
		await settle();
		expect([...target.querySelectorAll('button')].filter((b) => b.textContent?.trim() === t('bulk.deselect.off'))).toHaveLength(1);
	});

	it('loads every target of a preview before it offers the approval, page by page', async () => {
		targets = Array.from({ length: 501 }, (_, i) => ({ ...TARGETS[0]!, seq: i + 1, key: `gid://shopify/Product/${i + 1}` }));
		run = makeRun({ total: 501, changes: { update: 501, create: 0, delete: 0, unchanged: 0, invalid: 0 } });
		await render();
		expect(gets.filter((u) => u.includes('/targets?'))).toEqual([
			expect.stringMatching(/offset=0&limit=500$/), expect.stringMatching(/offset=500&limit=500$/),
		]);
		expect(target.textContent).toContain('Product/501');
	});

	it('offers no approval when the pages list fewer targets than the run counts (L1)', async () => {
		run = makeRun({ total: 4 });
		await render();
		expect(target.textContent).toContain(t('common.load_failed'));
		expect(buttonByText(t('bulk.approve.write_one'))).toBeUndefined();
		expect(buttonByText(t('bulk.approve.write_only'))).toBeUndefined();
		expect(target.textContent).not.toContain('Product/1');
	});

	it('words a refused take-out by its code, not by the engine\'s English (U-040)', async () => {
		refuseDeselect = 'not_writing';
		await render();
		buttonByText(t('bulk.deselect.off'))!.click();
		await settle();
		expect(target.textContent).toContain(t('bulk.deselect.refused.not_writing'));
		expect(target.textContent).not.toContain('engine English');
	});

	it('shows the engine\'s text for a refusal it has no sentence for', async () => {
		refuseDeselect = 'something_else';
		await render();
		buttonByText(t('bulk.deselect.off'))!.click();
		await settle();
		expect(target.textContent).toContain('engine English');
	});
});

// 660b: a halted run no one can be shown to have planned is refused a resume by its code; the
// page words it (ux U-052), and tells the owner to have it planned again.
describe('writing on a halted run', () => {
	const halted = (): BulkRunDetailData => makeRun({
		targetSystem: 'workspace', phase: 'writing', total: 1, haltKey: 'runUnrecorded', haltReason: 'engine reason',
		changes: { update: 1, create: 0, delete: 0, unchanged: 0, invalid: 0 }, probeConfirmed: true,
	});

	it('words a refusal for want of a planner by its code, not by the engine\'s English', async () => {
		run = halted();
		refuseResume = 'planner_unknown';
		await render();
		buttonByText(t('bulk.resume.write'))!.click();
		await settle();
		expect(posts.map((p) => p.url)).toEqual([expect.stringMatching(/\/bulk\/runs\/r1\/resume$/)]);
		expect(target.textContent).toContain(t('bulk.resume.refused.planner_unknown'));
		expect(target.textContent).not.toContain('engine English');
	});

	it('control: another refusal still shows the engine\'s text', async () => {
		run = halted();
		refuseResume = 'checksum';
		await render();
		buttonByText(t('bulk.resume.write'))!.click();
		await settle();
		expect(target.textContent).toContain('engine English');
	});

	// U-127: where writing on would send nothing and only read targets an earlier send left
	// unclear, the button says so, and the resume carries no new maximum.
	it('offers to check, not to write on, where the next pass would only read the unclear target', async () => {
		run = makeRun({
			phase: 'writing', total: 3, haltKey: 'failureRate', haltReason: 'engine reason', maxTargets: 1, probeConfirmed: false,
			changes: { update: 3, create: 0, delete: 0, unchanged: 0, invalid: 0 }, sentUnknown: 1, resumeOpen: 3, resumeTries: 1, resumeSends: 0,
		});
		await render();
		expect(buttonByText(t('bulk.resume.write'))).toBeUndefined();
		expect(target.textContent).not.toContain(t('bulk.resume.window'));
		expect(target.textContent).toContain(tf('bulk.resume.check_before', { provider: 'demo.myshopify.com' }));
		buttonByText(t('bulk.resume.check'))!.click();
		await settle();
		expect(posts).toEqual([{ url: expect.stringMatching(/\/bulk\/runs\/r1\/resume$/), body: { checksum: 'c1' } }]);
	});

	it('says the run sends nothing more where every target left changed at the provider, and offers no button', async () => {
		run = makeRun({
			phase: 'writing', total: 3, haltKey: 'failureRate', haltReason: 'engine reason', maxTargets: 1, probeConfirmed: false,
			changes: { update: 1, create: 0, delete: 0, unchanged: 0, invalid: 0 }, sentUnknown: 0, conflicts: 1, resumeOpen: 1, resumeTries: 1, resumeSends: 0,
		});
		await render();
		expect(target.textContent).toContain(tf('bulk.resume.nothing_left', { provider: 'demo.myshopify.com' }));
		// The conflict is worded as of the last read, not as a target lynox did not write.
		expect(target.textContent).toContain(t('bulk.conflicts_one'));
		expect(buttonByText(t('bulk.resume.write'))).toBeUndefined();
		expect(buttonByText(t('bulk.resume.check'))).toBeUndefined();
		expect(target.textContent).not.toContain(t('bulk.resume.window'));
	});

	it('control: with a target left to send, the same halt writes on', async () => {
		run = makeRun({
			phase: 'writing', total: 3, haltKey: 'failureRate', haltReason: 'engine reason', maxTargets: 1, probeConfirmed: false,
			changes: { update: 3, create: 0, delete: 0, unchanged: 0, invalid: 0 }, sentUnknown: 1, resumeOpen: 3, resumeTries: 1, resumeSends: 1,
		});
		await render();
		expect(buttonByText(t('bulk.resume.check'))).toBeUndefined();
		expect(buttonByText(t('bulk.resume.write'))).toBeDefined();
		expect(target.textContent).toContain(t('bulk.resume.window'));
	});
});

// A run halted on markup its store added to a written description: the page names it in its own
// words, marks the product, wherever it sits in the list, and offers writing on.
describe('a run halted on markup its store added', () => {
	it('marks exactly the product the store changed, past the first page, and offers writing on', async () => {
		run = makeRun({
			phase: 'writing', haltKey: 'markupAddedByShop', haltReason: 'engine English', applied: 8, probeConfirmed: true, total: 9, shopAddedMarkup: 1,
			changes: { update: 9, create: 0, delete: 0, unchanged: 0, invalid: 0 },
		});
		targets = Array.from({ length: 9 }, (_, i): BulkTarget => ({
			seq: i + 1, key: `gid://shopify/Product/${String(i + 1)}`, change: 'update', diff: fieldsDiff('A', 'B'), error: null, deselected: false,
			written: i < 8, ...(i === 7 ? { shopAddedMarkup: true as const } : {}),
		}));
		await render();
		const marked = [...target.querySelectorAll('[data-testid="bulk-shop-added-markup"]')]
			.map((m) => m.closest('tr')?.querySelector('code')?.textContent ?? '');
		expect(marked).toEqual(['gid://shopify/Product/8']);
		expect(target.textContent).toContain(t('bulk.halt.markupAddedByShop'));
		expect(target.textContent).toContain(t('bulk.halt.markupAddedByShop_before'));
		expect(target.textContent).not.toContain('engine English');
		expect(buttonByText(t('bulk.resume.write'))).toBeDefined();
	});

	it('still loads the marked product past the first page once another halt replaced the reason', async () => {
		run = makeRun({
			phase: 'writing', haltKey: 'unavailable', haltReason: 'engine English', applied: 8, probeConfirmed: true, total: 9, shopAddedMarkup: 1,
			changes: { update: 9, create: 0, delete: 0, unchanged: 0, invalid: 0 },
		});
		targets = Array.from({ length: 9 }, (_, i): BulkTarget => ({
			seq: i + 1, key: `gid://shopify/Product/${String(i + 1)}`, change: 'update', diff: fieldsDiff('A', 'B'), error: null, deselected: false,
			written: i < 8, ...(i === 7 ? { shopAddedMarkup: true as const } : {}),
		}));
		await render();
		expect(target.querySelectorAll('[data-testid="bulk-shop-added-markup"]')).toHaveLength(1);
	});
});

// A run whose store kept descriptions otherwise than sent, without outside markup: counted and
// named, not halted — one line on the run, a neutral mark on each product, wherever it sits.
describe('a run whose store kept descriptions otherwise than sent', () => {
	const rewritten = (marked: number[], extra: Partial<BulkTarget> = {}): void => {
		run = makeRun({
			phase: 'done', applied: 9, probeConfirmed: true, total: 9, hostRewrote: marked.length,
			changes: { update: 9, create: 0, delete: 0, unchanged: 0, invalid: 0 },
		});
		targets = Array.from({ length: 9 }, (_, i): BulkTarget => ({
			seq: i + 1, key: `gid://shopify/Product/${String(i + 1)}`, change: 'update', diff: fieldsDiff('A', 'B'), error: null, deselected: false,
			written: true, ...(marked.includes(i + 1) ? { hostRewrote: true as const, ...extra } : {}),
		}));
	};
	const markedKeys = (): string[] => [...target.querySelectorAll('[data-testid="bulk-host-rewrote"]')]
		.map((m) => m.closest('tr')?.querySelector('code')?.textContent ?? '');

	it('names one product in the singular, and marks it past the first page', async () => {
		rewritten([8]);
		await render();
		expect(target.querySelector('[data-testid="bulk-host-rewrote-count"]')?.textContent).toBe(t('bulk.run.host_rewrote_one'));
		expect(markedKeys()).toEqual(['gid://shopify/Product/8']);
	});

	it('names three products with their number, and marks each', async () => {
		rewritten([2, 5, 9]);
		await render();
		expect(target.querySelector('[data-testid="bulk-host-rewrote-count"]')?.textContent).toBe(tf('bulk.run.host_rewrote', { n: '3' }));
		expect(markedKeys()).toEqual(['gid://shopify/Product/2', 'gid://shopify/Product/5', 'gid://shopify/Product/9']);
	});

	it('shows no line on a run with none, and only the red mark on a product the store added markup to', async () => {
		rewritten([]);
		await render();
		expect(target.querySelector('[data-testid="bulk-host-rewrote-count"]')).toBeNull();
		rewritten([3], { shopAddedMarkup: true });
		await render();
		expect(target.querySelectorAll('[data-testid="bulk-host-rewrote"]')).toHaveLength(0);
		expect(target.querySelectorAll('[data-testid="bulk-shop-added-markup"]')).toHaveLength(1);
	});
});

// An atomic run that rolled back: the page says why in its own words, marks the targets the
// rollback left, and offers neither writing on nor an undo the engine would refuse.
describe('an atomic run that rolled back', () => {
	const aborted = (haltKey: string): BulkRunDetailData => makeRun({
		phase: 'aborted', atomic: true, haltKey, haltReason: 'engine English', applied: 2, failed: 1, undone: 1, undoable: 1,
		changes: { update: 3, create: 0, delete: 0, unchanged: 0, invalid: 0 },
	});
	const ROLLED: BulkTarget[] = [
		{ seq: 1, key: 'gid://shopify/Product/1', change: 'update', diff: fieldsDiff('A', 'B'), error: null, deselected: false, written: true, undone: false },
		{ seq: 2, key: 'gid://shopify/Product/2', change: 'update', diff: fieldsDiff('C', 'D'), error: null, deselected: false, written: true, undone: true },
		{ seq: 3, key: 'gid://shopify/Product/3', change: 'update', diff: fieldsDiff('E', 'F'), error: 'write failed', deselected: false, written: false, undone: false },
	];
	const marked = (): string[] => [...target.querySelectorAll('[data-testid="bulk-rollback-left"]')]
		.map((m) => m.closest('tr')?.querySelector('code')?.textContent ?? '');

	it('marks exactly the target the rollback left, with its own sentence and no way on', async () => {
		run = aborted('atomicRollbackIncomplete');
		targets = ROLLED.map((x) => ({ ...x }));
		await render();
		expect(marked()).toEqual(['gid://shopify/Product/1']);
		expect(target.textContent).toContain(t('bulk.halt.atomicRollbackIncomplete'));
		expect(target.textContent).not.toContain('engine English');
		expect(buttonByText(t('bulk.resume.write'))).toBeUndefined();
		expect(buttonByText(t('bulk.undo.prepare'))).toBeUndefined();
	});

	it('loads every target of a run whose rollback left one, so a mark past the first page is seen', async () => {
		run = { ...aborted('atomicStoppedRollbackIncomplete'), total: 9, changes: { update: 9, create: 0, delete: 0, unchanged: 0, invalid: 0 } };
		targets = Array.from({ length: 9 }, (_, i): BulkTarget => ({
			seq: i + 1, key: `gid://shopify/Product/${String(i + 1)}`, change: 'update', diff: fieldsDiff('A', 'B'), error: null, deselected: false,
			written: true, undone: i !== 7,
		}));
		await render();
		expect(marked()).toEqual(['gid://shopify/Product/8']);
	});

	it('marks nothing after a rollback that completed', async () => {
		run = aborted('atomicTimeRolledBack');
		targets = ROLLED.map((x) => ({ ...x }));
		await render();
		expect(marked()).toEqual([]);
		expect(target.textContent).toContain(t('bulk.halt.atomicTimeRolledBack'));
		expect(buttonByText(t('bulk.undo.prepare'))).toBeUndefined();
	});
});

// A halt the page has its own sentence for shows it, and a halt that sends the owner to support
// offers a mail with the run and host already in the subject.
describe('the sentence and the way on for a halt', () => {
	const mailtos = (): HTMLAnchorElement[] => [...target.querySelectorAll('a')].filter((a) => a.getAttribute('href')?.startsWith('mailto:'));

	it('offers a mail to support next to a planned run\'s blocked-host sentence', async () => {
		run = makeRun({ phase: 'planned', haltKey: 'blocked', haltReason: 'engine English' });
		await render();
		const [link, ...rest] = mailtos();
		expect(rest).toHaveLength(0);
		expect(link!.textContent?.trim()).toBe(t('bulk.halt.support_mail'));
		const href = new URL(link!.getAttribute('href')!);
		expect(href.pathname).toBe('support@lynox.ai');
		expect(href.searchParams.get('subject')).toContain('r1');
		expect(href.searchParams.get('subject')).toContain('demo.myshopify.com');
		// The address stays readable in the sentence: without a mail program the link does nothing.
		expect(target.textContent).toContain('support@lynox.ai');
	});

	it('offers it too where writing on waits for Shopify writes to be turned on', async () => {
		run = makeRun({ phase: 'writing', haltKey: 'shopifyWriteOff', haltReason: 'engine English', probeConfirmed: true, applied: 1 });
		await render();
		expect(mailtos()).toHaveLength(1);
	});

	it('offers no mail on a halt whose sentence does not send the owner to support', async () => {
		run = makeRun({ phase: 'planned', haltKey: 'unavailable', haltReason: 'engine English' });
		await render();
		expect(mailtos()).toHaveLength(0);
	});

	it('names the start button a waiting run shows, by the button\'s own label', async () => {
		run = makeRun({ phase: 'planned', haltKey: 'awaitingStart', haltReason: 'engine English' });
		await render();
		const label = t('bulk.start.read');
		expect(buttonByText(label)).toBeDefined();
		expect(target.textContent).toContain(t('bulk.halt.awaitingStart_start').replace('{button}', label));
		expect(target.textContent).not.toContain('engine English');
	});

	it('at a probe the server offers, names the panel\'s own button', async () => {
		run = makeRun({ phase: 'writing', haltKey: 'probeRequired', haltReason: 'engine English', applied: 1, probe: { key: 'gid://shopify/Product/1', fields: ['title'] } });
		await render();
		expect(buttonByText(t('bulk.probe.continue'))).toBeDefined();
		expect(target.textContent).toContain(t('bulk.halt.probeRequired_confirm'));
		expect(target.textContent).not.toContain('engine English');
	});

	it('tells someone other than the owner that only the owner can start a judged run', async () => {
		run = makeRun({ phase: 'planned', haltKey: 'awaitingStart', haltReason: 'engine English', judge: {} as BulkRunDetailData['judge'],
			judgeServedBy: { provider: 'anthropic', label: 'm' } as unknown as BulkRunDetailData['judgeServedBy'], judgeRule: null });
		await render();
		expect(target.textContent).toContain(t('bulk.halt.wait_owner_only'));
		expect(buttonByText(t('bulk.start.judge'))).toBeUndefined();
	});

	// sec-core / U-127: a probe found as planned after an unclear send is not one lynox can say it
	// wrote, so it is explained in its own words; a written probe keeps the old ones.
	const middle = (key: string): string => t(key).split('{target}')[1]!.split('{provider}')[0]!;
	for (const fields of [['title'], []]) {
		const whole = fields.length === 0;
		it(`explains a probe found after an unclear send in its own words${whole ? ', whole target' : ''}`, async () => {
			run = makeRun({ phase: 'writing', haltKey: 'probeRequired', haltReason: 'engine English', applied: 1, probe: { key: 'gid://shopify/Product/1', fields, found: true } });
			await render();
			expect(target.textContent).toContain(middle(whole ? 'bulk.probe.explain_found_whole' : 'bulk.probe.explain_found'));
			expect(target.textContent).not.toContain(t(whole ? 'bulk.probe.explain_whole' : 'bulk.probe.explain').split('{target}')[0]!);
		});
		it(`control: a written probe keeps the old words${whole ? ', whole target' : ''}`, async () => {
			run = makeRun({ phase: 'writing', haltKey: 'probeRequired', haltReason: 'engine English', applied: 1, probe: { key: 'gid://shopify/Product/1', fields, found: false } });
			await render();
			expect(target.textContent).toContain(t(whole ? 'bulk.probe.explain_whole' : 'bulk.probe.explain').split('{target}')[0]!);
			expect(target.textContent).not.toContain(middle(whole ? 'bulk.probe.explain_found_whole' : 'bulk.probe.explain_found'));
		});
	}

	it('shows before the start the fields the judge only reads: readable on a store, the owner\'s column names elsewhere (U-140)', async () => {
		const judged = (o: Partial<BulkRunDetailData>): BulkRunDetailData => makeRun({
			phase: 'planned', haltKey: 'awaitingStart', haltReason: 'engine English', judge: {} as BulkRunDetailData['judge'],
			judgeServedBy: { provider: 'anthropic', label: 'm' } as unknown as BulkRunDetailData['judgeServedBy'], ...o,
		});
		const rule = { rule: 'Write SEO texts.', schema: { properties: { seo_title: { type: 'string', maxLength: 70 } } }, tier: 'fast' };
		run = judged({ judgeRule: { ...rule, context: ['vendor', 'tags'] } });
		await render();
		const list = target.querySelector('[data-testid="bulk-start-context"]');
		expect(list).not.toBeNull();
		expect(list!.textContent).toContain(t('bulk.start.context_fields'));
		expect([...list!.querySelectorAll('li')].map((li) => li.textContent?.trim())).toEqual([t('bulk.field.shopify.vendor'), t('bulk.field.shopify.tags')]);
		expect(list!.textContent).toContain(tf('bulk.start.context_explain', { provider: 'Anthropic' }).slice(0, 20));
		unmount(component!);
		component = undefined;

		run = judged({ targetSystem: 'data_store', judgeRule: { ...rule, context: ['note'] } });
		await render();
		const rows = target.querySelector('[data-testid="bulk-start-context"]');
		expect(rows!.querySelector('code')?.textContent).toBe('note');
		unmount(component!);
		component = undefined;

		// Twin: a rule without a context shows no such list.
		run = judged({ judgeRule: rule });
		await render();
		expect(target.querySelector('[data-testid="bulk-start-context"]')).toBeNull();
		expect(target.textContent).toContain(t('bulk.start.fields'));
	});

	it('at a probe the server does not offer, says to plan again instead of naming a button', async () => {
		run = makeRun({ phase: 'writing', haltKey: 'probeRequired', haltReason: 'engine English', applied: 1, probe: null });
		await render();
		expect(target.textContent).toContain(t('bulk.halt.probeRequired_replan'));
		expect(target.textContent).not.toContain('engine English');
	});
});

// A preview whose SEO text gains an &: a theme may show it as `&amp;`. A note above the list and a
// mark on each product; nothing is refused, and a product the owner takes out is not counted.
describe('a preview whose SEO text gains an &', () => {
	const gaining = (marked: number[], deselected: number[] = [], o: Partial<BulkRunDetailData> = {}): void => {
		run = makeRun({ total: 4, changes: { update: 4, create: 0, delete: 0, unchanged: 0, invalid: 0 }, ...o });
		targets = Array.from({ length: 4 }, (_, i): BulkTarget => ({
			seq: i + 1, key: `gid://shopify/Product/${String(i + 1)}`, change: 'update', diff: fieldsDiff('A', 'B'), error: null,
			deselected: deselected.includes(i + 1), ...(marked.includes(i + 1) ? { seoEntityFields: ['seo_title'] } : {}),
		}));
	};
	const line = (): string | null | undefined => target.querySelector('[data-testid="bulk-seo-entity-count"]')?.textContent;
	const markedKeys = (): string[] => [...target.querySelectorAll('[data-testid="bulk-seo-entity"]')]
		.map((m) => m.closest('tr')?.querySelector('code')?.textContent ?? '');

	it('names two products with their number, marks each, and shows the entity as text', async () => {
		gaining([1, 3]);
		await render();
		expect(line()).toBe(tf('bulk.preview.seo_entity', { n: '2' }));
		expect(line()).toContain('&amp;');
		expect(markedKeys()).toEqual(['gid://shopify/Product/1', 'gid://shopify/Product/3']);
	});

	it('names one product in the singular, and does not count one the owner took out, which keeps its mark', async () => {
		gaining([1, 3], [3]);
		await render();
		expect(line()).toBe(t('bulk.preview.seo_entity_one'));
		// The taken-out product keeps its mark, as the reason it was taken out.
		expect(markedKeys()).toEqual(['gid://shopify/Product/1', 'gid://shopify/Product/3']);
	});

	it('shows no line where every marked product is taken out, and keeps their marks', async () => {
		gaining([1, 3], [1, 3]);
		await render();
		expect(line()).toBeUndefined();
		expect(markedKeys()).toEqual(['gid://shopify/Product/1', 'gid://shopify/Product/3']);
	});

	it('shows no line where none gains one, nor on a run that is not awaiting approval', async () => {
		gaining([]);
		await render();
		expect(line()).toBeUndefined();
		gaining([2], [], { phase: 'done', applied: 4, probeConfirmed: true });
		await render();
		expect(line()).toBeUndefined();
		expect(markedKeys()).toEqual(['gid://shopify/Product/2']);
	});
});

// The markup a planned value adds and removes in an HTML field, listed as code text under the
// target (1010): set as text, never rendered, so a link or a script in it shows and does not act.
describe('the markup a target changes (1010)', () => {
	const link = { kind: 'element' as const, namespace: 'html', element: 'a', attributes: [['href', 'https://evil.example/x?a=1&b=2']] as [string, string][], text: null, inTemplate: false };
	const image = { kind: 'element' as const, namespace: 'html', element: 'img', attributes: [['src', '/a.jpg']] as [string, string][], text: null, inTemplate: false };
	const script = { kind: 'element' as const, namespace: 'html', element: 'script', attributes: [] as [string, string][], text: 'steal()', inTemplate: false };
	const codes = (block: Element): (string | null)[] => [...block.querySelectorAll('code')].map((c) => c.textContent);

	it('lists what a write adds and removes as text, and renders none of it', async () => {
		targets = targets.map((x) => (x.seq === 1 ? { ...x, markupChanges: [{ field: 'descriptionHtml', added: [link], removed: [image], addsOutsideAllowlist: true }] } : x));
		await render();
		const blocks = target.querySelectorAll('[data-testid="bulk-markup"]');
		expect(blocks, 'one list, for the target that changes markup').toHaveLength(1);
		expect(codes(blocks[0]!)).toEqual(['<a href="https://evil.example/x?a=1&b=2">', '<img src="/a.jpg">']);
		expect(blocks[0]!.textContent).toContain(t('bulk.markup.added'));
		expect(blocks[0]!.textContent).toContain(t('bulk.markup.removed'));
		// Code text, not markup: no link to the domain, no image.
		expect(target.querySelectorAll('a[href*="evil.example"]')).toHaveLength(0);
		expect(blocks[0]!.querySelectorAll('a, img')).toHaveLength(0);
		// A write is not an undo: no sentence about markup from before the run.
		expect(target.querySelector('[data-testid="bulk-markup-restores-note"]')).toBeNull();
	});

	it('sets a space between an item and the note that it lies in a template', async () => {
		const templated = { kind: 'element' as const, namespace: 'html', element: 'p', attributes: [['class', 'x']] as [string, string][], text: null, inTemplate: true };
		targets = targets.map((x) => (x.seq === 1 ? { ...x, markupChanges: [{ field: 'descriptionHtml', added: [templated], removed: [], addsOutsideAllowlist: true }] } : x));
		await render();
		expect(target.querySelector('[data-testid="bulk-markup"]')!.textContent).toContain(`<p class="x"> ${t('bulk.markup.in_template')}`);
	});

	it('lists on an undo what it writes back, and says where that lies outside the allowlist', async () => {
		run = makeRun({ kind: 'undo', sourceRunId: 'r0', total: 1, changes: { update: 1, create: 0, delete: 0, unchanged: 0, invalid: 0 } });
		targets = [{ seq: 1, key: 'gid://shopify/Product/1', change: 'update', diff: fieldsDiff('Neu', 'Alt'), error: null, deselected: false,
			markupChanges: [{ field: 'descriptionHtml', added: [script], removed: [], addsOutsideAllowlist: true }] }];
		await render();
		const undo = target.querySelectorAll('[data-testid="bulk-undo-markup"]');
		expect(undo).toHaveLength(1);
		expect(codes(undo[0]!)).toEqual(['gid://shopify/Product/1', '<script>steal()</script>']);
		expect(undo[0]!.textContent).toContain(t('bulk.markup.restores'));
		expect(undo[0]!.querySelector('[data-testid="bulk-markup-restores-note"]')?.textContent).toBe(t('bulk.markup.restores_note'));
		expect(target.querySelectorAll('script')).toHaveLength(0);
	});
});
