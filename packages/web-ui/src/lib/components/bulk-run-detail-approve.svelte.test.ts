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
		costUsd: 0, costCapUsd: null, judge: null, maxTargets: null, failedOnce: null, failureLimit: 0, resumeOpen: 0, resumeTries: 0, deselected: 0,
		checksum: 'c1', writeFormNote: null, writeFormConfirmation: null, judgeModel: null, resumesAt: null, probe: null, undoable: 0,
		listFirstPage: null, listStartChecksum: null, listNote: null, judgeRule: null, judgeRuleHash: null, judgeServedBy: null, judgeOwnKey: false,
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
		if (u.endsWith('/config')) return reply({ managed: true });
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
		buttonByText(t('bulk.preview.show_unchanged').replace('{n}', '1'))!.click();
		await settle();
		expect(target.textContent).toContain('Product/2');
	});

	it('takes a product out against the checksum it showed, and then shuts an approval with nothing left', async () => {
		await render();
		const approve = buttonByText(t('bulk.approve.write_one'))!;
		expect(approve.disabled).toBe(false);
		buttonByText(t('bulk.deselect.off'))!.click();
		await settle();
		expect(posts).toEqual([{ url: expect.stringMatching(/\/bulk\/runs\/r1\/targets\/1\/deselect$/) as unknown as string, body: { checksum: 'c1' } }]);
		expect(target.textContent).toContain(t('bulk.deselect.taken_out'));
		expect(buttonByText(t('bulk.deselect.on'))).toBeDefined();
		const shut = buttonByText(t('bulk.approve.write_one'))!;
		expect(shut.disabled).toBe(true);
		expect(shut.getAttribute('aria-describedby')).toBe('bulk-approve-nothing');
		expect(target.querySelector('#bulk-approve-nothing')?.textContent).toBe(t('bulk.nothing.products'));
	});

	it('offers no way out on a product lynox leaves out, and none on an unchanged one', async () => {
		await render();
		buttonByText(t('bulk.preview.show_unchanged').replace('{n}', '1'))!.click();
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

	it('at a probe the server does not offer, says to plan again instead of naming a button', async () => {
		run = makeRun({ phase: 'writing', haltKey: 'probeRequired', haltReason: 'engine English', applied: 1, probe: null });
		await render();
		expect(target.textContent).toContain(t('bulk.halt.probeRequired_replan'));
		expect(target.textContent).not.toContain('engine English');
	});
});
