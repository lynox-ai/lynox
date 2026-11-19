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

	it('names the changed field by its label, not its raw name, as the sent-unchanged line does', async () => {
		run = makeRun({ phase: 'done', undone: 0, undoneBy: null, targetSystem: SHOP, total: 1 });
		targets = [seoTarget(1)];
		await render();
		const names = [...target.querySelectorAll('[data-testid="bulk-field-name"]')].map((e) => e.textContent?.trim());
		expect(names).toEqual([`${t('bulk.field.shopify.seo_title')}:`]);
		expect(target.textContent).not.toContain('seo_title:');
	});

	it('shows no old title on a run that rewrites the title', async () => {
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

	it('a local run keeps showing its keys and its field names as written', async () => {
		run = makeRun({ phase: 'done', undone: 0, undoneBy: null, targetSystem: 'workspace' });
		targets = [written(1, false)];
		await render();
		expect(target.querySelector('[data-testid="bulk-target-admin"]')).toBeNull();
		expect(target.textContent).toContain('gid://shopify/Product/1');
		expect(target.querySelector('[data-testid="bulk-field-name"]')?.textContent?.trim()).toBe('seo_title:');
		// The name the planner set stands in a value box, so it does not read as a word of lynox's (U-333).
		const box = target.querySelector('[data-testid="bulk-field-name"] [data-testid="bulk-field-own-name"]');
		expect(box?.textContent).toBe('seo_title');
		// A name to check is not paler than the row it stands in: the box sets its own text colour.
		expect(box?.classList.contains('text-text')).toBe(true);
	});

	it('a Shopify field\'s readable name stands as lynox\'s own word, without the value box (U-333)', async () => {
		run = makeRun({ phase: 'done', undone: 0, undoneBy: null });
		targets = [written(1, false)];
		await render();
		expect(target.querySelector('[data-testid="bulk-field-name"]')?.textContent?.trim()).toBe(`${t('bulk.field.shopify.seo_title')}:`);
		expect(target.querySelector('[data-testid="bulk-field-own-name"]')).toBeNull();
	});
});

// A field name the planner set stands in its value box also where the page names it inside a
// sentence (U-333): the head of the markup list, the sent-unchanged line, the probe sentence and the
// sentence of a target refused for a credential in a field it reads. A Shopify field keeps its
// readable name, without a box. The words around the name stay lynox's, in their order.
describe('a field name inside a sentence (U-333)', () => {
	const boxes = (el: Element | null): (string | null)[] => [...(el?.querySelectorAll('[data-testid="bulk-field-own-name"]') ?? [])].map((b) => b.textContent);
	const link = { kind: 'element' as const, namespace: 'html', element: 'a', attributes: [['href', 'https://x.example/']] as [string, string][], text: null, inTemplate: false };
	const withMarkup = (field: string): BulkTarget =>
		({ ...written(1, false), markupChanges: [{ field, added: [link], removed: [], addsOutsideAllowlist: true }] }) as unknown as BulkTarget;

	it('boxes a planner-set name in the head of the markup list, and not a Shopify label', async () => {
		run = makeRun({ phase: 'done', undone: 0, undoneBy: null, targetSystem: 'workspace', total: 1 });
		targets = [withMarkup('body_html')];
		await render();
		const head = target.querySelector('[data-testid="bulk-markup-head"]');
		expect(boxes(head)).toEqual(['body_html']);
		expect(head?.textContent).toBe(tf('bulk.markup.head', { field: 'body_html' }));
		unmount(component!); component = undefined; target.replaceChildren();
		run = makeRun({ phase: 'done', undone: 0, undoneBy: null, targetSystem: SHOP, total: 1 });
		targets = [withMarkup('descriptionHtml')];
		await render();
		const shopHead = target.querySelector('[data-testid="bulk-markup-head"]');
		expect(boxes(shopHead)).toEqual([]);
		expect(shopHead?.textContent).toBe(tf('bulk.markup.head', { field: t('bulk.field.shopify.descriptionHtml') }));
	});

	it('boxes each planner-set name in the sent-unchanged line, a Shopify label stays a word', async () => {
		run = makeRun({ phase: 'done', undone: 0, undoneBy: null, targetSystem: SHOP, total: 1 });
		targets = [{ ...written(1, false), sentUnchanged: ['seo_description', 'custom_note'] } as BulkTarget];
		await render();
		const line = target.querySelector('[data-testid="bulk-sent-unchanged"]');
		expect(boxes(line)).toEqual(['custom_note']);
		expect(line?.textContent).toBe(tf('bulk.preview.sent_unchanged', { fields: `${t('bulk.field.shopify.seo_description')}, custom_note` }));
	});

	it('boxes a planner-set name in the probe sentence, isolated, next to a Shopify label without one', async () => {
		run = makeRun({ phase: 'writing', undone: 0, undoneBy: null, targetSystem: SHOP, total: 17, applied: 1,
			haltKey: 'probeRequired', haltReason: 'probeRequired', probe: { key: 'gid://shopify/Product/77', fields: ['seo_title', 'custom_note'] } });
		targets = [seoTarget(1)];
		await render();
		const sentence = target.querySelector('[data-testid="bulk-probe-explain"]');
		expect(boxes(sentence)).toEqual(['custom_note']);
		// The whole sentence, so the target and the provider around the name are filled in too.
		expect(sentence?.textContent).toBe(tf('bulk.probe.explain', { target: tf('bulk.target.product', { n: '77' }), provider: 'demo.myshopify.com', field: `${t('bulk.field.shopify.seo_title')}, custom_note` }));
		// The box isolates its text, so a name written right to left cannot move the quotes around it.
		expect(sentence?.querySelector('[data-testid="bulk-field-own-name"]')?.tagName).toBe('BDI');
	});

	it('boxes the field that held a credential at each place the refusal names it', async () => {
		run = makeRun({ phase: 'previewed', undone: 0, undoneBy: null, targetSystem: 'workspace', total: 1, applied: 0,
			changes: { update: 0, create: 0, delete: 0, unchanged: 0, invalid: 1 } });
		targets = [{ seq: 1, key: 'k1', change: 'invalid', diff: { kind: 'none' }, error: 'secret_in_context', contextField: 'api_notes', deselected: false } as unknown as BulkTarget];
		await render();
		const text = target.querySelector('[data-testid="bulk-invalid-text"]');
		expect(boxes(text)).toEqual(['api_notes', 'api_notes']);
		expect(text?.textContent).toBe(tf('bulk.invalid.secret_in_context_field', { field: 'api_notes' }));
	});

	it('names a Shopify field that held a credential by its label, without a box', async () => {
		run = makeRun({ phase: 'previewed', undone: 0, undoneBy: null, targetSystem: SHOP, total: 1, applied: 0,
			changes: { update: 0, create: 0, delete: 0, unchanged: 0, invalid: 1 } });
		targets = [{ seq: 1, key: 'gid://shopify/Product/1', change: 'invalid', diff: { kind: 'none' }, error: 'secret_in_context', contextField: 'vendor', deselected: false } as unknown as BulkTarget];
		await render();
		const text = target.querySelector('[data-testid="bulk-invalid-text"]');
		expect(boxes(text)).toEqual([]);
		expect(text?.textContent).toBe(tf('bulk.invalid.secret_in_context', { field: t('bulk.field.shopify.vendor') }));
	});
});

// A key such as `tee-abendruhe` read „tee / -ab / end / ruh / e“ in a narrow column: the key broke
// anywhere. It now breaks only after a hyphen or a dot, and the target column keeps a minimum width
// (U-341).
describe('a target key in the preview', () => {
	const handle = 'tee-abendruhe.sommer-2026';
	it('breaks only after a hyphen or a dot, never inside a word, and keeps the key whole as text', async () => {
		run = makeRun({ phase: 'previewed', undone: 0, undoneBy: null, targetSystem: 'workspace', total: 1, applied: 0,
			changes: { update: 1, create: 0, delete: 0, unchanged: 0, invalid: 0 } });
		targets = [{ seq: 1, key: handle, change: 'update', diff: fieldsDiff('', 'Neu'), error: null, deselected: false } as BulkTarget];
		await render();
		const key = target.querySelector('table [data-testid="bulk-target-key"]');
		expect(key?.textContent).toBe(handle);
		expect(key?.classList.contains('break-all')).toBe(false);
		expect(key?.classList.contains('break-normal')).toBe(true);
		// Each place it may break, and only those: the text before every <wbr> ends in „-“ or „.“.
		const before = [...(key?.childNodes ?? [])].flatMap((n, i, all) => (n.nodeName === 'WBR' ? [all[i - 1]?.textContent ?? ''] : []));
		expect(before).toEqual(['tee-', 'abendruhe.', 'sommer-']);
	});

	it('gives the target column a minimum width', async () => {
		run = makeRun({ phase: 'previewed', undone: 0, undoneBy: null, targetSystem: 'workspace', total: 1, applied: 0,
			changes: { update: 1, create: 0, delete: 0, unchanged: 0, invalid: 0 } });
		targets = [{ seq: 1, key: handle, change: 'update', diff: fieldsDiff('', 'Neu'), error: null, deselected: false } as BulkTarget];
		await render();
		const column = target.querySelector('table th[data-testid="bulk-target-column"]');
		expect(column?.textContent).toBe(t('bulk.head.target'));
		expect(column?.classList.contains('min-w-[8rem]')).toBe(true);
	});
});
