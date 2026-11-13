import { describe, it, expect, vi, beforeEach, afterEach, onTestFinished } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { t, tf, getLocale, setLocale } from '../i18n.svelte.js';
import type { BulkRunDetailData, BulkTarget } from './bulk-runs.js';
import { bulkTargetName, bulkTargetLabel } from './bulk-runs.js';

// A Shopify target is named „Produkt <Zahl>“, linked to the product in the store's admin. Before,
// the page showed the raw key `gid://shopify/Product/…`. No title: the engine keeps only the fields
// a run writes in a target's before-image, so a run that writes SEO fields holds no title at all.

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

// The shapes the engine stores (bulk-preview `beforeOverFields`): the before-image holds only the
// fields the run writes. A SEO run holds no title; a run that rewrites the title holds the OLD one.
const seoTarget = (seq: number): BulkTarget =>
	({ ...written(seq, false), before: { absent: false, value: { seo_title: `SEO ${seq}`, seo_description: '' } } }) as unknown as BulkTarget;
const titleTarget = (seq: number, oldTitle: string): BulkTarget =>
	({ ...written(seq, false), diff: fieldsDiff(oldTitle, `Neu ${seq}`), before: { absent: false, value: { title: oldTitle } } }) as unknown as BulkTarget;
const SHOP = 'http:demo.myshopify.com';
const i18nStub = { tf: (k: string, v: Record<string, string>) => `${k}:${v['n']}` };
const adminLinks = (): HTMLAnchorElement[] => [...target.querySelectorAll<HTMLAnchorElement>('[data-testid="bulk-target-admin"]')];

describe('bulkTargetName', () => {
	it('names a Shopify product by its number and the admin link on the run\'s host', () => {
		expect(bulkTargetName(SHOP, { key: 'gid://shopify/Product/42' })).toEqual({ number: '42', adminUrl: 'https://demo.myshopify.com/admin/products/42' });
	});

	it('gives no link and no number to a key that is not exactly a product gid', () => {
		for (const key of ['gid://shopify/Product/42?x=1', 'gid://shopify/ProductVariant/42', 'gid://shopify/Product/', 'gid://shopify/Product/4a2',
			' gid://shopify/Product/42', 'gid://shopify/Product/42\n', 'https://evil.example/gid://shopify/Product/42', 'gid://shopify/Collection/42']) {
			expect(bulkTargetName(SHOP, { key })).toEqual({ number: null, adminUrl: null });
		}
	});

	it('takes the host from the run and only a Shopify store host', () => {
		expect(bulkTargetName('http:evil.example', { key: 'gid://shopify/Product/42' }).adminUrl).toBeNull();
		expect(bulkTargetName('local', { key: 'gid://shopify/Product/42' }).adminUrl).toBeNull();
	});

	it('names it in a sentence as „Produkt <Zahl>“, anything else by its key', () => {
		expect(bulkTargetLabel(SHOP, { key: 'gid://shopify/Product/42' }, i18nStub)).toBe('bulk.target.product:42');
		expect(bulkTargetLabel('local', { key: 'a/b.md' }, i18nStub)).toBe('a/b.md');
	});
});

describe('a Shopify run\'s page', () => {
	it('names each target of a SEO run „Produkt <Zahl>“ with its admin link, in a new tab, and no raw key', async () => {
		run = makeRun({ phase: 'done', undone: 0, undoneBy: null, targetSystem: SHOP, total: 2 });
		targets = [seoTarget(1), seoTarget(2)];
		await render();
		const links = adminLinks();
		expect(links.map((a) => a.getAttribute('href'))).toEqual(['https://demo.myshopify.com/admin/products/1', 'https://demo.myshopify.com/admin/products/2']);
		for (const a of links) {
			expect(a.getAttribute('target')).toBe('_blank');
			expect(a.getAttribute('rel')).toBe('noopener noreferrer');
			// The arrow is not read out; the link reads „Produkt <Zahl>“.
			expect(a.querySelector('[aria-hidden="true"]')?.textContent?.trim()).toBe('↗');
		}
		expect(links[0]!.textContent).toContain(tf('bulk.target.product', { n: '1' }));
		expect(target.textContent).not.toContain('gid://shopify/Product/1');
	});

	it('shows no old title on a run that rewrites the title: the diff shows old and new already', async () => {
		run = makeRun({ phase: 'done', undone: 0, undoneBy: null, targetSystem: SHOP, total: 1 });
		targets = [titleTarget(1, 'Alte Teekanne')];
		await render();
		const cell = adminLinks()[0]!.closest('td')!;
		expect(cell.textContent).not.toContain('Alte Teekanne');
		expect(adminLinks()).toHaveLength(1);
	});

	it('links the probe\'s product in the probe box, also when it is not among the shown targets', async () => {
		run = makeRun({ phase: 'writing', undone: 0, undoneBy: null, targetSystem: SHOP, total: 17, applied: 1,
			haltKey: 'probeRequired', haltReason: 'probeRequired', probe: { key: 'gid://shopify/Product/77', fields: ['seo_title'] } });
		targets = [seoTarget(1)];
		await render();
		const link = target.querySelector<HTMLAnchorElement>('[data-testid="bulk-probe-admin"]');
		expect(link?.getAttribute('href')).toBe('https://demo.myshopify.com/admin/products/77');
		expect(link?.getAttribute('target')).toBe('_blank');
		expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
		expect(link?.textContent).toContain('77');
	});

	it('gives the probe box no link for a key that is not a product gid', async () => {
		run = makeRun({ phase: 'writing', undone: 0, undoneBy: null, targetSystem: SHOP, total: 17, applied: 1,
			haltKey: 'probeRequired', haltReason: 'probeRequired', probe: { key: 'gid://shopify/ProductVariant/77', fields: ['seo_title'] } });
		targets = [seoTarget(1)];
		await render();
		expect(target.querySelector('[data-testid="bulk-probe-admin"]')).toBeNull();
	});

	it('names the products an undo deletes by their admin link too', async () => {
		run = makeRun({ kind: 'undo', phase: 'previewed', undone: 0, undoneBy: null, targetSystem: SHOP, total: 1, applied: 0,
			changes: { update: 0, create: 0, delete: 1, unchanged: 0, invalid: 0 } });
		targets = [{ seq: 1, key: 'gid://shopify/Product/9', change: 'delete', diff: { kind: 'none' }, error: null, deselected: false } as unknown as BulkTarget];
		await render();
		expect(adminLinks().map((a) => a.getAttribute('href'))).toContain('https://demo.myshopify.com/admin/products/9');
		expect(target.textContent).not.toContain('gid://shopify/Product/9');
	});

	it('a local run keeps showing its keys', async () => {
		run = makeRun({ phase: 'done', undone: 0, undoneBy: null, targetSystem: 'workspace' });
		targets = [written(1, false)];
		await render();
		expect(target.querySelector('[data-testid="bulk-target-admin"]')).toBeNull();
		expect(target.textContent).toContain('gid://shopify/Product/1');
	});
});
