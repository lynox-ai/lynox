import { describe, it, expect, vi, beforeEach, afterEach, onTestFinished } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { t, tf, getLocale, setLocale } from '../i18n.svelte.js';
import type { BulkRunDetailData, BulkTarget } from './bulk-runs.js';
import { bulkTargetName, bulkTargetLabel } from './bulk-runs.js';

// A Shopify target is named by its product's title from its before-image, with its number linked to
// the store's admin. Before, the page showed the raw key `gid://shopify/Product/…`.

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

const withTitle = (seq: number, title: unknown): BulkTarget =>
	({ ...written(seq, false), before: { absent: false, value: { title, seo_title: '' } } }) as BulkTarget;
const SHOP = 'http:demo.myshopify.com';
const i18nStub = { tf: (k: string, v: Record<string, string>) => `${k}:${v['n']}` };

describe('bulkTargetName', () => {
	it('names a Shopify product by its title, its number and the admin link on the run\'s host', () => {
		const n = bulkTargetName(SHOP, { key: 'gid://shopify/Product/42', before: { absent: false, value: { title: 'Teekanne' } } });
		expect(n).toEqual({ title: 'Teekanne', number: '42', adminUrl: 'https://demo.myshopify.com/admin/products/42' });
	});

	it('gives no link and no number to a key that is not exactly a product gid', () => {
		for (const key of ['gid://shopify/Product/42?x=1', 'gid://shopify/ProductVariant/42', 'gid://shopify/Product/', 'gid://shopify/Product/4a2',
			' gid://shopify/Product/42', 'gid://shopify/Product/42\n', 'https://evil.example/gid://shopify/Product/42', 'gid://shopify/Collection/42']) {
			expect(bulkTargetName(SHOP, { key, before: { absent: false, value: { title: 'X' } } })).toEqual({ title: null, number: null, adminUrl: null });
		}
	});

	it('takes the host from the run and only a Shopify store host; the shop\'s data never sets it', () => {
		expect(bulkTargetName('http:evil.example', { key: 'gid://shopify/Product/42' }).adminUrl).toBeNull();
		expect(bulkTargetName('local', { key: 'gid://shopify/Product/42' }).adminUrl).toBeNull();
		const n = bulkTargetName(SHOP, { key: 'gid://shopify/Product/42', before: { absent: false, value: { title: 'X', onlineStoreUrl: 'https://evil.example', host: 'evil.example' } } });
		expect(n.adminUrl).toBe('https://demo.myshopify.com/admin/products/42');
	});

	it('shows the title as text with its hidden characters as marks', () => {
		const n = bulkTargetName(SHOP, { key: 'gid://shopify/Product/42', before: { absent: false, value: { title: '<b>Tee</b>\u200bkanne\u202e' } } });
		expect(n.title).toContain('<b>Tee</b>');
		expect(n.title).not.toContain('\u200b');
		expect(n.title).not.toContain('\u202e');
	});

	it('falls back to the number where the run holds no title, and fetches it from nowhere else', () => {
		for (const before of [undefined, null, { absent: true }, { absent: false, value: null }, { absent: false, value: { title: '' } }, { absent: false, value: { title: '  ' } }, { absent: false, value: { title: 7 } }]) {
			const n = bulkTargetName(SHOP, { key: 'gid://shopify/Product/42', before });
			expect(n.title).toBeNull();
			expect(n.number).toBe('42');
		}
		expect(bulkTargetLabel(SHOP, { key: 'gid://shopify/Product/42' }, i18nStub)).toBe('bulk.target.product:42');
		expect(bulkTargetLabel('local', { key: 'a/b.md' }, i18nStub)).toBe('a/b.md');
	});
});

describe('a Shopify run\'s page', () => {
	it('shows the title as text (no markup rendered) and links the number to the admin in a new tab', async () => {
		run = makeRun({ phase: 'done', undone: 0, undoneBy: null, targetSystem: SHOP, total: 2 });
		targets = [withTitle(1, '<b>Tee</b>\u200bkanne'), withTitle(2, '')];
		await render();
		const titles = [...target.querySelectorAll<HTMLElement>('[data-testid="bulk-target-title"]')];
		expect(titles).toHaveLength(1);
		expect(titles[0]!.querySelector('b')).toBeNull();
		expect(titles[0]!.textContent).toContain('<b>Tee</b>');
		expect(titles[0]!.textContent).not.toContain('\u200b');
		const links = [...target.querySelectorAll<HTMLAnchorElement>('[data-testid="bulk-target-admin"]')];
		expect(links.map((a) => a.getAttribute('href'))).toEqual(['https://demo.myshopify.com/admin/products/1', 'https://demo.myshopify.com/admin/products/2']);
		for (const a of links) {
			expect(a.getAttribute('target')).toBe('_blank');
			expect(a.getAttribute('rel')).toBe('noopener noreferrer');
		}
		expect(target.textContent).not.toContain('gid://shopify/Product/1');
	});

	it('a local run keeps showing its keys', async () => {
		run = makeRun({ phase: 'done', undone: 0, undoneBy: null, targetSystem: 'workspace' });
		targets = [written(1, false)];
		await render();
		expect(target.querySelector('[data-testid="bulk-target-admin"]')).toBeNull();
		expect(target.textContent).toContain('gid://shopify/Product/1');
	});
});
