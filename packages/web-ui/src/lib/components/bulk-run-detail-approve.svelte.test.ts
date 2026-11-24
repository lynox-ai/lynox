import { describe, it, expect, vi, beforeEach, afterEach, onTestFinished } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { t, tf, getLocale, setLocale } from '../i18n.svelte.js';
import { bulkStartButtonKey, type BulkRunDetailData, type BulkTarget } from './bulk-runs.js';
import { resetSettingsViewer } from '../stores/settings-viewer.svelte.js';

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
// A run's own answer, by id, and an answer held back until the test lets it through.
let runsById: Record<string, BulkRunDetailData>;
let holds: Record<string, Promise<void>>;
// A run whose own answer fails: 'status' answers 500, 'throw' never answers.
let failIds: Record<string, 'status' | 'throw'>;
// Who the server says reads the page.
let viewerOf: 'owner' | 'mandate';

beforeEach(() => {
	target = document.createElement('div');
	document.body.appendChild(target);
	run = makeRun();
	targets = TARGETS.map((x) => ({ ...x }));
	posts = [];
	gets = [];
	refuseDeselect = null;
	refuseResume = null;
	runsById = {};
	holds = {};
	failIds = {};
	viewerOf = 'owner';
	vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
		const u = String(url);
		const reply = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
		if (init?.method === 'POST') {
			const body = JSON.parse(String(init.body)) as unknown;
			posts.push({ url: u, body });
			// A held act (`<run>/resume`, `<run>/deselect`, …) answers once the test lets it through.
			const act = /\/bulk\/runs\/([^/?]+)\/(?:.*\/)?([a-z-]+)$/.exec(u);
			if (act && holds[`${act[1]}/${act[2]}`] !== undefined) await holds[`${act[1]}/${act[2]}`];
			const m = /\/targets\/(\d+)\/deselect$/.exec(u);
			if (m && refuseDeselect !== null) return reply({ error: 'engine English', code: refuseDeselect }, 409);
			if (u.endsWith('/resume') && refuseResume !== null) {
				const code = refuseResume;
				// The engine names the run a judged start would end once; the start that names it passes.
				if (code === 'supersede_required') refuseResume = null;
				return reply({ error: 'engine English', code, ...(code === 'supersede_required' ? { supersedable: { id: 'r0', costUsd: 0.5 } } : {}) }, 409);
			}
			if (m) {
				const seq = Number(m[1]);
				targets = targets.map((x) => (x.seq === seq ? { ...x, deselected: true } : x));
				run = { ...run, checksum: 'c2', deselected: run.deselected + 1, changes: { ...run.changes, update: run.changes.update - 1 } };
				return reply({ checksum: 'c2' });
			}
			const back = /\/targets\/(\d+)\/reselect$/.exec(u);
			if (back) {
				const seq = Number(back[1]);
				targets = targets.map((x) => (x.seq === seq ? { ...x, deselected: false } : x));
				run = { ...run, checksum: 'c3', deselected: run.deselected - 1, changes: { ...run.changes, update: run.changes.update + 1 } };
				return reply({ checksum: 'c3' });
			}
			return reply({});
		}
		gets.push(u);
		// The owner's session: the page offers its acts only once the server says so.
		if (u.endsWith('/config')) return reply({ managed: true, viewer: viewerOf });
		// `changed=1`: the page asks for the targets the plan changes first (U-437).
		const page = /\/targets\?offset=(\d+)&limit=(\d+)(&changed=1)?$/.exec(u);
		const pageOf = /\/bulk\/runs\/([^/?]+)\/targets\?/.exec(u)?.[1];
		if (page && pageOf !== undefined && holds[`${pageOf}/targets`] !== undefined) await holds[`${pageOf}/targets`];
		if (page && pageOf !== undefined && failIds[`${pageOf}/targets`] === 'throw') throw new Error('network');
		if (page) return reply({ targets: (page[3] ? targets.filter((x) => x.change !== 'unchanged') : targets).slice(Number(page[1]), Number(page[1]) + Number(page[2])) });
		const id = /\/bulk\/runs\/([^/?]+)$/.exec(u)?.[1];
		// A held run answers once, for the first load that asks; a later load of it goes through.
		if (id !== undefined && holds[id] !== undefined) { const h = holds[id]; delete holds[id]; await h; }
		if (id !== undefined && failIds[id] === 'status') return reply({ error: 'engine English' }, 500);
		if (id !== undefined && failIds[id] === 'throw') throw new Error('network');
		return reply((id !== undefined ? runsById[id] : undefined) ?? run);
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
	it('folds a long filter list until asked, then shows it whole and moves focus to it (ux U-175)', async () => {
		const groups = (n: number, name: string): string[] => Array.from({ length: n }, (_, i) => `${name} ${String(i + 1).padStart(2, '0')}`);
		const before = getLocale();
		setLocale('de');
		onTestFinished(() => setLocale(before));
		run = makeRun({ listFilters: { product_type: groups(50, 'Gruppe'), vendor: groups(7, 'Anbieter') } });
		await render();
		const folded = tf('bulk.list.filter_both', { type: `„Gruppe 01“, „Gruppe 02“, „Gruppe 03“ ${tf('bulk.list.more', { n: '47' })}`, vendor: `„Anbieter 01“, „Anbieter 02“, „Anbieter 03“ ${tf('bulk.list.more', { n: '4' })}` });
		const line = (): HTMLParagraphElement | undefined => [...target.querySelectorAll('p')].find((p) => p.textContent?.startsWith(folded.slice(0, 30)));
		expect(line()!.textContent).toBe(`${folded} ${tf('bulk.list.showAll', { n: '57' })}`);
		buttonByText(tf('bulk.list.showAll', { n: '57' }))!.click();
		await settle();
		const full = tf('bulk.list.filter_both', {
			type: `${groups(49, 'Gruppe').map((g) => `„${g}“`).join(', ')} ${t('bulk.list.or')} „Gruppe 50“`,
			vendor: `${groups(6, 'Anbieter').map((g) => `„${g}“`).join(', ')} ${t('bulk.list.or')} „Anbieter 07“`,
		});
		expect(line()!.textContent).toBe(full);
		expect(buttonByText(tf('bulk.list.showAll', { n: '57' }))).toBeUndefined();
		expect(document.activeElement).toBe(line());
		// The statuses the list reads stand on a line of their own, after the group's: never between it and its button.
		const lines = [...target.querySelectorAll('p')].map((p) => p.textContent);
		expect(lines[lines.indexOf(full) + 1]).toBe(t('bulk.list.any_status'));
	});

	describe('the statuses a store\'s product list reads, where it is approved', () => {
		const texts = (): (string | null)[] => [...target.querySelectorAll('p')].map((p) => p.textContent);
		const german = (): void => {
			const before = getLocale();
			setLocale('de');
			onTestFinished(() => setLocale(before));
		};
		it('names every status for a list without a filter', async () => {
			german();
			run = makeRun({ listFilters: {} });
			await render();
			expect(texts()).toContain('Gelesen wird jedes Produkt des Shops, in jedem Status, auch „Entwurf“ und „archiviert“, und auch Geschenkgutscheine.');
		});
		it('names the status a filter names, on its own line after the group\'s', async () => {
			german();
			run = makeRun({ listFilters: { product_type: 'Tee', status: 'active' } });
			await render();
			const all = texts();
			expect(all[all.indexOf('Gelesen werden nur die Produkte vom Produkttyp „Tee“.') + 1]).toBe('Gelesen werden nur Produkte mit dem Status „aktiv“.');
			expect(target.textContent).not.toContain(t('bulk.list.all_status'));
		});
		it('names the status where a listed run is started, before its list is read', async () => {
			german();
			run = makeRun({ phase: 'planned', haltKey: 'listed', haltReason: 'engine English', total: 1, listFirstPage: 'https://demo.myshopify.com/products.json', listStartChecksum: 'l1', listFilters: { status: 'active' }, changes: { update: 0, create: 0, delete: 0, unchanged: 0, invalid: 0 } });
			await render();
			expect(texts()).toContain('Gelesen werden nur Produkte mit dem Status „aktiv“.');
		});
		it('names no status for a list that is not a store\'s products', async () => {
			german();
			run = makeRun({ listFilters: null });
			await render();
			expect(target.textContent).not.toContain('Status');
		});
	});

	it('shows why lynox leaves a product out, and folds the unchanged one until asked', async () => {
		await render();
		expect(target.textContent).toContain(t('bulk.invalid.not_found'));
		expect(target.innerHTML).toContain('admin/products/1"');
		expect(target.innerHTML).not.toContain('admin/products/2"');
		buttonByText(t('bulk.preview.show_unchanged_one'))!.click();
		await settle();
		expect(target.innerHTML).toContain('admin/products/2"');
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

	it('names each refused field of a Shopify product by its label, as the row above does', async () => {
		const a = '[box a="1&2"]x[/box]';
		const b = '[pbutton]Los[/pbutton]';
		targets = targets.map((x) => (x.seq === 3 ? { ...x, error: 'shortcode_changed', refusedValues: [{ field: 'descriptionHtml', value: a }, { field: 'seo_title', value: b }] } : x));
		await render();
		const names = [...target.querySelectorAll('[data-testid="bulk-refused-field"]')].map((e) => e.textContent?.trim());
		expect(names).toEqual([`${t('bulk.field.shopify.descriptionHtml')}:`, `${t('bulk.field.shopify.seo_title')}:`]);
		expect(target.textContent).not.toContain('descriptionHtml:');
	});

	// The sentence names the field for allowed link domains only where it is a way out: a judged
	// list run on a shop, read by the owner, who alone starts judging (U-157).
	const listed: Partial<BulkRunDetailData> = { judge: { tier: 'standard', unjudged: 0 }, judgeRuleHash: 'h1', list: { state: 'done' }, startDomains: null };
	const linkCases: { name: string; o: Partial<BulkRunDetailData>; viewer: 'owner' | 'mandate'; judged: boolean; domain?: string }[] = [
		{ name: 'a run without a judge', o: {}, viewer: 'owner', judged: false },
		{ name: 'a judged list run, for the owner, to an address the field does not take', o: listed, viewer: 'owner', judged: false, domain: '192.0.2.1' },
		{ name: 'a judged run without a list', o: { judge: { tier: 'standard', unjudged: 0 }, judgeRuleHash: 'h1', list: null }, viewer: 'owner', judged: false },
		{ name: 'a judged list run, for the owner', o: { judge: { tier: 'standard', unjudged: 0 }, judgeRuleHash: 'h1', list: { state: 'done' }, startDomains: null }, viewer: 'owner', judged: true },
		{ name: 'a judged list run, for a mandate', o: { judge: { tier: 'standard', unjudged: 0 }, judgeRuleHash: 'h1', list: { state: 'done' }, startDomains: null }, viewer: 'mandate', judged: false },
	];
	for (const c of linkCases) {
		it(`words a new link domain under the product for ${c.name}${c.judged ? ', naming the field for allowed domains' : ', naming no field for allowed domains'}`, async () => {
			run = makeRun(c.o);
			viewerOf = c.viewer;
			resetSettingsViewer();
			targets = targets.map((x) => (x.seq === 3 ? { ...x, error: 'new_link_domain', linkDomain: c.domain ?? 'video.example' } : x));
			await render();
			const where = t('bulk.invalid.where_shopify');
			const domain = c.domain ?? 'video.example';
			const text = target.textContent ?? '';
			// The domain is named in either sentence (U-311).
			if (c.judged) {
				expect(text).toContain(tf('bulk.invalid.new_link_domain_judged_named', { domain, where }));
				expect(text).not.toContain(tf('bulk.invalid.new_link_domain_named', { domain, where }));
			} else {
				expect(text).toContain(tf('bulk.invalid.new_link_domain_named', { domain, where }));
				expect(text).not.toContain(tf('bulk.invalid.new_link_domain_judged_named', { domain, where }).slice(0, 200));
			}
			resetSettingsViewer();
		});
	}

	it('shows a refused backslash as one backslash in the sentence the owner reads', async () => {
		targets = targets.map((x) => (x.seq === 3 ? { ...x, error: 'url_control_char' } : x));
		await render();
		const text = target.textContent ?? '';
		expect(text).toMatch(/[Bb]ackslash \\[ ,]/);
		expect(text).not.toContain('ackslash \\\\');
	});

	it('approves a run of one target whole, takes the product out against the checksum it showed, and then keeps only why nothing is left', async () => {
		await render();
		// One target to write: no probe first, the approval covers the whole run.
		const approve = buttonByText(t('bulk.approve.write_only'))!;
		expect(approve.disabled).toBe(false);
		expect(target.textContent).toContain(t('bulk.approve.only_one'));
		expect(target.textContent).not.toContain(t('bulk.approve.one_first'));
		expect(buttonByText(t('bulk.approve.write_one'))).toBeUndefined();
		const asked = gets.length;
		buttonByText(t('bulk.deselect.off'))!.click();
		await settle();
		expect(posts).toEqual([{ url: expect.stringMatching(/\/bulk\/runs\/r1\/targets\/1\/deselect$/) as unknown as string, body: { checksum: 'c1' } }]);
		// The run is asked for again (its counts and checksum moved); no page of its targets is.
		expect(gets.slice(asked)).toEqual([expect.stringMatching(/\/bulk\/runs\/r1$/) as unknown as string]);
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
		// Every kind of write counts, as the write counts it: one update and one create are two.
		unmount(component!);
		component = undefined;
		run = makeRun({ targetSystem: 'http:api.example.com', writeForm: 'unmeasured', changes: { update: 1, create: 1, delete: 0, unchanged: 0, invalid: 1 } });
		await render();
		expect(target.textContent).toContain(t('bulk.approve.unmeasured_note'));
		expect(target.textContent).not.toContain(t('bulk.approve.only_one'));
	});

	it('shows no probe step for a run of one target, and the run as the step it writes in', async () => {
		const chips = (): string[] => [...target.querySelectorAll('ol li')].map((li) => li.textContent ?? '');
		const current = (): string | null | undefined => target.querySelector('ol li[aria-current="step"]')?.textContent;
		run = makeRun({ targetSystem: 'http:api.example.com' });
		await render();
		expect(chips()).not.toContain(t('bulk.step.probe'));
		expect(current()).toBe(t('bulk.step.approval'));
		unmount(component!);
		component = undefined;
		run = makeRun({ targetSystem: 'http:api.example.com', phase: 'writing', probe: { key: 'https://api.example.com/items/1', fields: ['title'] }, haltReason: 'x', haltKey: 'maxTargets' });
		await render();
		expect(chips()).not.toContain(t('bulk.step.probe'));
		expect(current()).toBe(t('bulk.step.run'));
		unmount(component!);
		component = undefined;
		run = makeRun({ targetSystem: 'http:api.example.com', changes: { update: 2, create: 0, delete: 0, unchanged: 0, invalid: 1 } });
		await render();
		expect(chips()).toContain(t('bulk.step.probe'));
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
		expect(target.innerHTML).toContain('admin/products/501"');
	});

	it('offers no approval when the pages list fewer targets than the run counts (L1)', async () => {
		run = makeRun({ total: 4 });
		await render();
		expect(target.textContent).toContain(t('common.load_failed'));
		expect(buttonByText(t('bulk.approve.write_one'))).toBeUndefined();
		expect(buttonByText(t('bulk.approve.write_only'))).toBeUndefined();
		expect(target.innerHTML).not.toContain('admin/products/1"');
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
			.map((m) => m.closest('tr')?.querySelector('[data-testid="bulk-target-admin"]')?.getAttribute('href')?.replace(/^https:\/\/[^/]+\/admin\/products\//, 'gid://shopify/Product/') ?? '');
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
		.map((m) => m.closest('tr')?.querySelector('[data-testid="bulk-target-admin"]')?.getAttribute('href')?.replace(/^https:\/\/[^/]+\/admin\/products\//, 'gid://shopify/Product/') ?? '');

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
		.map((m) => m.closest('tr')?.querySelector('[data-testid="bulk-target-admin"]')?.getAttribute('href')?.replace(/^https:\/\/[^/]+\/admin\/products\//, 'gid://shopify/Product/') ?? '');

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
		expect(rows!.querySelector('[data-testid="bulk-field-own-name"]')?.textContent).toBe('note');
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
		.map((m) => m.closest('tr')?.querySelector('[data-testid="bulk-target-admin"]')?.getAttribute('href')?.replace(/^https:\/\/[^/]+\/admin\/products\//, 'gid://shopify/Product/') ?? '');

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
		// The product is named by its admin link; the markup it writes back is listed as text.
		expect(undo[0]!.querySelector('[data-testid="bulk-target-admin"]')?.getAttribute('href')).toBe('https://demo.myshopify.com/admin/products/1');
		expect(codes(undo[0]!)).toEqual(['<script>steal()</script>']);
		expect(undo[0]!.textContent).toContain(t('bulk.markup.restores'));
		expect(undo[0]!.querySelector('[data-testid="bulk-markup-restores-note"]')?.textContent).toBe(t('bulk.markup.restores_note_active'));
		expect(undo[0]!.querySelector('[data-testid="bulk-markup-restores-note"]')?.className).toBe('text-warning');
		expect(target.querySelectorAll('script')).toHaveLength(0);
	});

	it('says of an undo that restores the owner\'s own table only that it was there before', async () => {
		const table = { kind: 'element' as const, namespace: 'html', element: 'table', attributes: [['width', '100%']] as [string, string][], text: null, inTemplate: false };
		run = makeRun({ kind: 'undo', sourceRunId: 'r0', total: 1, changes: { update: 1, create: 0, delete: 0, unchanged: 0, invalid: 0 } });
		targets = [{ seq: 1, key: 'gid://shopify/Product/1', change: 'update', diff: fieldsDiff('Neu', 'Alt'), error: null, deselected: false,
			markupChanges: [{ field: 'descriptionHtml', added: [table], removed: [], addsOutsideAllowlist: true, addsOnlyPassive: true }] }];
		await render();
		const note = target.querySelector('[data-testid="bulk-undo-markup"] [data-testid="bulk-markup-restores-note"]');
		expect(note?.textContent).toBe(t('bulk.markup.restores_note'));
		// Neutral, as the head and the footnote: not a warning about the owner's own table.
		expect(note?.className).toBe('text-text-subtle');
	});
});

describe('the reason under a value lynox leaves out, as the run\'s page words it', () => {
	const invalid = (error: string, o: Partial<BulkTarget> = {}): BulkTarget[] => [
		TARGETS[0]!, { seq: 2, key: 'gid://shopify/Product/2', change: 'invalid', diff: { kind: 'none' } as BulkTarget['diff'], error, deselected: false, ...o },
	];

	it('names the refused domain as text, never as a link (U-311)', async () => {
		run = makeRun({ total: 2, changes: { update: 1, create: 0, delete: 0, unchanged: 0, invalid: 1 } });
		targets = invalid('new_link_domain', { linkDomain: '<a href="https://evil.example">evil.example</a>' } as Partial<BulkTarget>);
		await render();
		expect(target.textContent).toContain('„<a href="https://evil.example">evil.example</a>“');
		expect(target.querySelector('a[href="https://evil.example"]')).toBeNull();
	});

	it('words a cut-off answer of a judge that decides an HTML field as a description to keep by hand', async () => {
		run = makeRun({ total: 2, changes: { update: 1, create: 0, delete: 0, unchanged: 0, invalid: 1 }, judge: {} as BulkRunDetailData['judge'], judgesHtml: true } as Partial<BulkRunDetailData>);
		targets = invalid('cut_off');
		await render();
		expect(target.textContent).toContain(tf('bulk.invalid.cut_off_html', { where: t('bulk.invalid.where_shopify') }));
	});

	it('control: the same cut-off answer of a judge that decides no HTML field keeps the plain sentence', async () => {
		run = makeRun({ total: 2, changes: { update: 1, create: 0, delete: 0, unchanged: 0, invalid: 1 }, judge: {} as BulkRunDetailData['judge'], judgesHtml: false } as Partial<BulkRunDetailData>);
		targets = invalid('cut_off');
		await render();
		expect(target.textContent).toContain(t('bulk.invalid.cut_off'));
		expect(target.textContent).not.toContain(tf('bulk.invalid.cut_off_html', { where: t('bulk.invalid.where_shopify') }));
	});
});

// A hidden character a target adds where text may carry one:
// marked behind its grapheme, with the kind only in the label, a legend over the list, and a
// count wherever the run is approved or its probe confirmed.
describe('a hidden character a target adds in place', () => {
	const marks = (): Element[] => [...target.querySelectorAll('[data-testid="bulk-hidden-mark"]')];
	const count = (): string | null | undefined => target.querySelector('[data-testid="bulk-hidden-count"]')?.textContent;
	const legend = (): Element | null => target.querySelector('[data-testid="bulk-hidden-legend"]');

	it('marks a soft hyphen in a title and in an HTML description, counts the targets, and names the kind only in the label', async () => {
		run = makeRun({ hiddenAddsTargets: 2, total: 2, changes: { update: 2, create: 0, delete: 0, unchanged: 0, invalid: 0 } });
		targets = [
			{ seq: 1, key: 'gid://shopify/Product/1', change: 'update', diff: fieldsDiff('Wasserfilter', 'Wasser\u00adfilter'), error: null, deselected: false,
				hiddenAdds: [{ field: 'title', codePoints: [0x00ad] }] },
			{ seq: 2, key: 'gid://shopify/Product/2', change: 'update', error: null, deselected: false,
				diff: { kind: 'fields', fields: [{ field: 'descriptionHtml', before: '<p>Wasserfilter</p>', after: '<p>Wasser\u00adfilter</p>' }] } as BulkTarget['diff'],
				hiddenAdds: [{ field: 'descriptionHtml', codePoints: [0x00ad] }] },
		];
		await render();
		expect(marks()).toHaveLength(2);
		const label = tf('bulk.hidden.label', { kind: `${t('bulk.hidden.kind.soft_hyphen')} (U+00AD)` });
		for (const m of marks()) {
			expect(m.textContent).toBe(t('bulk.hidden.mark'));
			expect(m.getAttribute('title')).toBe(label);
			expect(m.getAttribute('aria-label')).toBe(label);
		}
		// The code point stands in the label, not in the text the owner reads.
		expect(target.textContent).not.toContain('U+00AD');
		// A Shopify run counts products, as every count beside it.
		expect(count()).toBe(tf('bulk.hidden.count_products', { n: '2' }));
		expect(legend()?.textContent).toBe(t('bulk.hidden.legend'));
	});

	// U-218: a value taken back no longer holds what will be written. Its mark stays, as a
	// record of what was written, but turns grey with it and warns no more; it calls for no legend.
	it('greys the mark of a value taken back, and shows the legend only for a value that still stands', async () => {
		const marked = (seq: number, undone: boolean): BulkTarget => ({ seq, key: `gid://shopify/Product/${String(seq)}`, change: 'update', error: null, deselected: false,
			written: true, undone, diff: fieldsDiff('Wasserfilter', 'Wasser\u00adfilter'), hiddenAdds: [{ field: 'title', codePoints: [0x00ad] }] } as BulkTarget);
		run = makeRun({ phase: 'done', applied: 2, undone: 1, total: 2, changes: { update: 2, create: 0, delete: 0, unchanged: 0, invalid: 0 } });
		targets = [marked(1, true), marked(2, false)];
		await render();
		const [back, stands] = marks();
		expect(back!.className).toContain('text-text-subtle');
		expect(back!.className).not.toContain('warning');
		expect(stands!.className).toContain('text-warning');
		expect(legend()?.textContent).toBe(t('bulk.hidden.legend'));
	});

	it('greys the mark of a text line taken back, too', async () => {
		run = makeRun({ phase: 'done', applied: 1, undone: 1, total: 1, changes: { update: 1, create: 0, delete: 0, unchanged: 0, invalid: 0 } });
		targets = [{ seq: 1, key: 'notes.txt', change: 'update', error: null, deselected: false, written: true, undone: true,
			diff: { kind: 'text', from: 0, removed: ['Ketab'], added: ['Ke\u200ctab'] } as BulkTarget['diff'], hiddenAdds: [{ field: '', codePoints: [0x200c] }] } as BulkTarget];
		await render();
		expect(marks()).toHaveLength(1);
		expect(marks()[0]!.className).toContain('text-text-subtle');
	});

	it('shows no legend where every marked value is taken back', async () => {
		run = makeRun({ phase: 'done', applied: 1, undone: 1, total: 1, changes: { update: 1, create: 0, delete: 0, unchanged: 0, invalid: 0 } });
		targets = [{ seq: 1, key: 'gid://shopify/Product/1', change: 'update', error: null, deselected: false, written: true, undone: true,
			diff: fieldsDiff('Wasserfilter', 'Wasser\u00adfilter'), hiddenAdds: [{ field: 'title', codePoints: [0x00ad] }] } as BulkTarget];
		await render();
		expect(marks()).toHaveLength(1);
		expect(marks()[0]!.className).toContain('text-text-subtle');
		expect(legend()).toBeNull();
	});

	it('marks a new emoji behind the whole emoji, and a single target in the singular', async () => {
		run = makeRun({ hiddenAddsTargets: 1, total: 1, changes: { update: 1, create: 0, delete: 0, unchanged: 0, invalid: 0 } });
		targets = [{ seq: 1, key: 'gid://shopify/Product/1', change: 'update', diff: fieldsDiff('Wasserfilter', 'Wasserfilter ❤\ufe0f'), error: null, deselected: false,
			hiddenAdds: [{ field: 'title', codePoints: [0xfe0f] }] }];
		await render();
		expect(marks()).toHaveLength(1);
		expect(marks()[0]!.closest('ins')?.textContent).toBe(`Wasserfilter \u2764\ufe0f${t('bulk.hidden.mark')}`);
		expect(count()).toBe(t('bulk.hidden.count_products_one'));
	});

	// U-294: a field too large or too complex to check is said to be unchecked, under the field and
	// in a count of its own; it is never counted or marked as one that adds.
	const unchecked = (): Element[] => [...target.querySelectorAll('[data-testid="bulk-unchecked"]')];
	const uncheckedCount = (): string | null | undefined => target.querySelector('[data-testid="bulk-unchecked-count"]')?.textContent;
	it('says under an unchecked field that it was not checked, offers taking the target out, and counts it on its own', async () => {
		run = makeRun({ hiddenAddsTargets: 0, hiddenUncheckedTargets: 2, total: 2, changes: { update: 2, create: 0, delete: 0, unchanged: 0, invalid: 0 } });
		targets = [1, 2].map((seq) => ({ seq, key: `gid://shopify/Product/${String(seq)}`, change: 'update' as const, error: null, deselected: seq === 2,
			diff: { kind: 'fields', fields: [{ field: 'descriptionHtml', before: '<p>a</p>', after: '<p>b</p>' }] } as BulkTarget['diff'],
			hiddenUnchecked: ['descriptionHtml'] }));
		await render();
		expect(unchecked().map((e) => e.textContent)).toEqual([t('bulk.unchecked.field_take_out'), t('bulk.unchecked.field')]);
		expect(uncheckedCount()).toBe(tf('bulk.unchecked.count_products', { n: '2' }));
		// Nothing claims a mark or a character added.
		expect(marks()).toHaveLength(0);
		expect(legend()).toBeNull();
		expect(count()).toBeUndefined();
	});

	it('says nothing of an unchecked field for a run without one', async () => {
		run = makeRun({ hiddenAddsTargets: 0, hiddenUncheckedTargets: 0 });
		await render();
		expect(unchecked()).toHaveLength(0);
		expect(uncheckedCount()).toBeUndefined();
	});

	it('holds the released unchecked sentences word for word, in both languages (U-294)', () => {
		const before = getLocale();
		onTestFinished(() => setLocale(before));
		const released: Record<string, [string, string]> = {
			'bulk.unchecked.count': ['Bei {n} Zielen konnte lynox nicht prüfen, ob sie unsichtbare Zeichen hinzufügen: Ein Feld ist dafür zu gross oder zu komplex aufgebaut. Fehlt bei ihnen eine Markierung, heisst das nicht, dass sie keine hinzufügen.', 'For {n} targets, lynox could not check whether they add invisible characters: a field is too large or too complex for it. If they show no mark, that does not mean they add none.'],
			'bulk.unchecked.count_one': ['Bei 1 Ziel konnte lynox nicht prüfen, ob es unsichtbare Zeichen hinzufügt: Ein Feld ist dafür zu gross oder zu komplex aufgebaut. Fehlt bei ihm eine Markierung, heisst das nicht, dass es keine hinzufügt.', 'For 1 target, lynox could not check whether it adds invisible characters: a field is too large or too complex for it. If it shows no mark, that does not mean it adds none.'],
			'bulk.unchecked.count_products': ['Bei {n} Produkten konnte lynox nicht prüfen, ob sie unsichtbare Zeichen hinzufügen: Ein Feld ist dafür zu gross oder zu komplex aufgebaut. Fehlt bei ihnen eine Markierung, heisst das nicht, dass sie keine hinzufügen.', 'For {n} products, lynox could not check whether they add invisible characters: a field is too large or too complex for it. If they show no mark, that does not mean they add none.'],
			'bulk.unchecked.count_products_one': ['Bei 1 Produkt konnte lynox nicht prüfen, ob es unsichtbare Zeichen hinzufügt: Ein Feld ist dafür zu gross oder zu komplex aufgebaut. Fehlt bei ihm eine Markierung, heisst das nicht, dass es keine hinzufügt.', 'For 1 product, lynox could not check whether it adds invisible characters: a field is too large or too complex for it. If it shows no mark, that does not mean it adds none.'],
			'bulk.unchecked.field': ['lynox konnte nicht prüfen, ob hier unsichtbare Zeichen hinzukommen: Der bisherige oder der neue Inhalt ist dafür zu gross oder zu komplex aufgebaut.', 'lynox could not check whether invisible characters are added here: the current or the new content is too large or too complex for it.'],
			'bulk.unchecked.field_take_out': ['lynox konnte nicht prüfen, ob hier unsichtbare Zeichen hinzukommen: Der bisherige oder der neue Inhalt ist dafür zu gross oder zu komplex aufgebaut. Willst du sichergehen, nimm dieses Ziel aus dem Lauf.', 'lynox could not check whether invisible characters are added here: the current or the new content is too large or too complex for it. To be sure, leave this target out of the run.'],
		};
		for (const [key, [de, en]] of Object.entries(released)) {
			setLocale('de');
			expect(t(key), key).toBe(de);
			setLocale('en');
			expect(t(key), key).toBe(en);
		}
	});

	it('shows no mark, legend or count for a target that adds none', async () => {
		run = makeRun({ hiddenAddsTargets: 0 });
		await render();
		expect(marks()).toHaveLength(0);
		expect(legend()).toBeNull();
		expect(count()).toBeUndefined();
	});

	// At a probe the page loads a first page only, unless a target adds such a character: then it
	// loads all of them, so the count's "marked in the preview" holds for the eighth target too.
	it('counts at a probe\'s confirmation too, and shows a marked target past the first page', async () => {
		const n = 8;
		run = makeRun({ targetSystem: 'http:api.example.com', phase: 'writing', haltKey: 'probeRequired', haltReason: 'engine English', applied: 1,
			probe: { key: 'https://api.example.com/items/1', fields: ['title'] }, hiddenAddsTargets: 1, total: n,
			changes: { update: n, create: 0, delete: 0, unchanged: 0, invalid: 0 } });
		targets = Array.from({ length: n }, (_, i): BulkTarget => ({
			seq: i + 1, key: `https://api.example.com/items/${String(i + 1)}`, change: 'update', error: null, deselected: false,
			diff: fieldsDiff('Ketab', i === n - 1 ? 'Ke\u200ctab' : 'Ketab!'), ...(i === n - 1 ? { hiddenAdds: [{ field: 'title', codePoints: [0x200c] }] } : {}),
		}));
		await render();
		expect(count()).toBe(tf('bulk.hidden.count_one', { n: '1' }));
		expect(marks()).toHaveLength(1);
		expect(marks()[0]!.closest('tr')?.querySelector('code')?.textContent).toBe(`https://api.example.com/items/${String(n)}`);
	});

	it('marks the added lines of a value that is one text', async () => {
		run = makeRun({ targetSystem: 'data_store', hiddenAddsTargets: 1, total: 1, changes: { update: 1, create: 0, delete: 0, unchanged: 0, invalid: 0 } });
		targets = [{ seq: 1, key: 'row-1', change: 'update', error: null, deselected: false,
			diff: { kind: 'text', from: 0, removed: ['Ketab'], added: ['Ke\u200ctab'] } as BulkTarget['diff'], hiddenAdds: [{ field: '', codePoints: [0x200c] }] }];
		await render();
		expect(marks()).toHaveLength(1);
		expect(count()).toBe(tf('bulk.hidden.count_one', { n: '1' }));
	});

	it('marks the value a target refused for its shortcode leaves to the owner to paste', async () => {
		const value = '[gallery ids="1"]<p>Wa\u00adsser</p>';
		run = makeRun({ total: 1, changes: { update: 0, create: 0, delete: 0, unchanged: 0, invalid: 1 } });
		targets = [{ seq: 1, key: 'gid://shopify/Product/1', change: 'invalid', error: 'shortcode_changed', deselected: false, diff: { kind: 'none' } as BulkTarget['diff'],
			refusedValues: [{ field: 'descriptionHtml', value, codePoints: [0x00ad] }] }];
		await render();
		const shown = target.querySelector('[data-testid="bulk-refused-value-text"]');
		expect(shown?.querySelectorAll('[data-testid="bulk-hidden-mark"]')).toHaveLength(1);
		expect(shown?.textContent).toBe(`[gallery ids="1"]<p>Wa\u00ad${t('bulk.hidden.mark')}sser</p>`);
		// The phone has no title to show: the sentence under the field says what a mark means there.
		expect(target.querySelector('[data-testid="bulk-refused-value-hidden"]')?.textContent).toBe(t('bulk.invalid.value_hidden'));
	});

	it('marks a soft hyphen an HTML description holds as its reference', async () => {
		run = makeRun({ hiddenAddsTargets: 1, total: 1, changes: { update: 1, create: 0, delete: 0, unchanged: 0, invalid: 0 } });
		targets = [{ seq: 1, key: 'gid://shopify/Product/1', change: 'update', error: null, deselected: false,
			diff: { kind: 'fields', fields: [{ field: 'descriptionHtml', before: '<p>Wasserfilter</p>', after: '<p>Wasser&shy;filter</p>' }] } as BulkTarget['diff'],
			hiddenAdds: [{ field: 'descriptionHtml', codePoints: [0x00ad], html: true }] }];
		await render();
		expect(marks()).toHaveLength(1);
		expect(marks()[0]!.closest('ins')?.textContent).toBe(`<p>Wasser&shy;${t('bulk.hidden.mark')}filter</p>`);
	});

	it('marks a reference in a value to copy, which is always HTML', async () => {
		run = makeRun({ total: 1, changes: { update: 0, create: 0, delete: 0, unchanged: 0, invalid: 1 } });
		targets = [{ seq: 1, key: 'gid://shopify/Product/1', change: 'invalid', error: 'shortcode_changed', deselected: false, diff: { kind: 'none' } as BulkTarget['diff'],
			refusedValues: [{ field: 'descriptionHtml', value: '[gallery ids="1"]<p>Wa&shy;sser</p>', codePoints: [0x00ad] }] }];
		await render();
		expect(target.querySelector('[data-testid="bulk-refused-value-text"]')?.querySelectorAll('[data-testid="bulk-hidden-mark"]')).toHaveLength(1);
	});

	it('says nothing under a value to copy that carries no mark', async () => {
		run = makeRun({ total: 1, changes: { update: 0, create: 0, delete: 0, unchanged: 0, invalid: 1 } });
		targets = [{ seq: 1, key: 'gid://shopify/Product/1', change: 'invalid', error: 'shortcode_changed', deselected: false, diff: { kind: 'none' } as BulkTarget['diff'],
			refusedValues: [{ field: 'descriptionHtml', value: '[gallery ids="1"]<p>Wasser</p>' }] }];
		await render();
		expect(target.querySelector('[data-testid="bulk-refused-value-text"]')).not.toBeNull();
		expect(target.querySelector('[data-testid="bulk-refused-value-hidden"]')).toBeNull();
	});
});

describe('the allowed link domains of a judged list run', () => {
	const judged = (o: Partial<BulkRunDetailData> = {}): BulkRunDetailData => makeRun({
		phase: 'planned', haltKey: 'listed', haltReason: 'engine English', checksum: null,
		judge: { tier: 'standard', unjudged: 3 }, judgeRuleHash: 'h1',
		judgeServedBy: { provider: 'anthropic', label: 'Modell' },
		judgeRule: { rule: 'Schreib die Beschreibung neu.', schema: { properties: { body_html: { type: 'string' } } }, tier: 'standard' },
		list: { state: 'done' }, startDomains: null,
		...o,
	});
	const field = (): HTMLTextAreaElement | null => target.querySelector('[data-testid="bulk-start-domains"] textarea');
	const type = (el: HTMLInputElement | HTMLTextAreaElement, value: string): void => {
		el.value = value;
		el.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
	};
	const capField = (): HTMLInputElement => target.querySelector('input[inputmode="decimal"]')!;
	const startButton = (): HTMLButtonElement | undefined => buttonByText(t(bulkStartButtonKey(run, 'judge', false) ?? 'bulk.start.judge'));
	const resumes = (): Record<string, unknown>[] => posts.filter((p) => p.url.endsWith('/resume')).map((p) => p.body as Record<string, unknown>);

	it('sends the domains typed in the start field with the judged start', async () => {
		run = judged();
		await render();
		expect(field()).not.toBeNull();
		type(field()!, 'mein-shop.ch\nb.example');
		type(capField(), '5');
		startButton()!.click();
		await settle();
		expect(resumes()).toEqual([{ judgeRuleHash: 'h1', costCapUsd: 5, startDomains: ['mein-shop.ch', 'b.example'] }]);
	});

	it('sends no list when the field is left empty', async () => {
		run = judged();
		await render();
		type(capField(), '5');
		startButton()!.click();
		await settle();
		expect(resumes()).toEqual([{ judgeRuleHash: 'h1', costCapUsd: 5 }]);
	});

	it('holds the start while a line does not read as a domain', async () => {
		run = judged();
		await render();
		type(field()!, 'https://mein-shop.ch/pfad');
		type(capField(), '5');
		expect(startButton()!.disabled).toBe(true);
		expect(target.textContent).toContain(t('bulk.start_domains.invalid'));
		type(field()!, 'mein-shop.ch');
		expect(startButton()!.disabled).toBe(false);
	});

	it('keeps the list when the start names the run it ends, and holds that start on a wrong line', async () => {
		run = judged();
		refuseResume = 'supersede_required';
		await render();
		type(field()!, 'mein-shop.ch');
		type(capField(), '5');
		startButton()!.click();
		await settle();
		const supersede = (): HTMLButtonElement => buttonByText(t(bulkStartButtonKey(run, 'judge', true) ?? 'bulk.start.supersede_yes'))!;
		type(field()!, 'mein-shop.ch/pfad');
		expect(supersede().disabled).toBe(true);
		type(field()!, 'mein-shop.ch');
		supersede().click();
		await settle();
		expect(resumes()).toEqual([
			{ judgeRuleHash: 'h1', costCapUsd: 5, startDomains: ['mein-shop.ch'] },
			{ judgeRuleHash: 'h1', costCapUsd: 5, startDomains: ['mein-shop.ch'], supersedes: 'r0' },
		]);
	});

	it('offers no field on a judged run without a list, which takes none', async () => {
		run = judged({ list: null });
		await render();
		expect(startButton()).toBeDefined();
		expect(target.querySelector('[data-testid="bulk-start-domains"]')).toBeNull();
	});

	it('words a list the engine refuses as fixed in the page\'s own sentence', async () => {
		run = judged();
		refuseResume = 'start_domains_frozen';
		await render();
		type(field()!, 'mein-shop.ch');
		type(capField(), '5');
		startButton()!.click();
		await settle();
		expect(target.textContent).toContain(t('bulk.start_domains.frozen'));
		expect(target.textContent).not.toContain('engine English');
	});

	it('words the engine\'s start_domains_invalid in the page\'s own sentence', async () => {
		run = judged();
		refuseResume = 'start_domains_invalid';
		await render();
		type(field()!, 'mein-shop.ch');
		type(capField(), '5');
		startButton()!.click();
		await settle();
		expect(target.textContent).toContain(t('bulk.start_domains.invalid'));
		expect(target.textContent).not.toContain('engine English');
	});

	// The page opens another run in the same component: what was typed for one run is not the other's.
	async function renderSwitchable(): Promise<(id: string, wait?: boolean) => Promise<void>> {
		const { default: BulkRunDetail } = await import('./BulkRunDetail.svelte');
		const props = $state({ runId: 'r1', onBack: () => {}, onOpen: () => {} });
		component = mount(BulkRunDetail, { target, props });
		await settle();
		return async (id: string, wait = true) => { props.runId = id; if (wait) await settle(); else { await tick(); flushSync(); } };
	}
	const held = (id: string): (() => void) => {
		let release = (): void => {};
		holds[id] = new Promise<void>((r) => { release = r; });
		return () => { delete holds[id]; release(); };
	};
	const resumeUrls = (): string[] => posts.filter((p) => p.url.endsWith('/resume')).map((p) => p.url);

	it('opens another run with its unchanged targets folded, though they were shown on the run before', async () => {
		targets = Array.from({ length: 8 }, (_, i) => ({ ...TARGETS[i === 0 ? 0 : 1]!, seq: i + 1, key: `gid://shopify/Product/${String(i + 1)}` }));
		const done = (id: string): BulkRunDetailData => makeRun({ id, phase: 'done', total: 8, changes: { update: 1, create: 0, delete: 0, unchanged: 7, invalid: 0 } });
		run = done('r1');
		const open = await renderSwitchable();
		runsById['r2'] = done('r2');
		const unfold = (): HTMLButtonElement | undefined => buttonByText(tf('bulk.preview.show_unchanged', { n: '7' }));
		unfold()!.click();
		await settle();
		expect(unfold()).toBeUndefined();
		await open('r2');
		expect(unfold()).toBeDefined();
	});

	it('sends no domains typed for another run with the start of this one', async () => {
		run = judged();
		const open = await renderSwitchable();
		type(field()!, 'mein-shop.ch');
		run = judged({ id: 'r2' });
		await open('r2');
		expect(field()!.value).toBe('');
		type(capField(), '5');
		startButton()!.click();
		await settle();
		expect(resumes()).toEqual([{ judgeRuleHash: 'h1', costCapUsd: 5 }]);
		expect(resumeUrls()).toEqual([expect.stringContaining('/bulk/runs/r2/resume')]);
	});

	it('sends nothing while another run loads, though the page still shows the one before', async () => {
		run = judged();
		const open = await renderSwitchable();
		type(field()!, 'mein-shop.ch');
		type(capField(), '5');
		const release = held('r2');
		run = judged({ id: 'r2' });
		await open('r2', false);
		startButton()!.click();
		await settle();
		expect(resumes()).toEqual([]);
		release();
		await settle();
		expect(field()!.value).toBe('');
		expect(resumes()).toEqual([]);
	});

	for (const fail of ['status', 'throw'] as const) {
		it(`shows no error for the failed late answer (${fail}) of a run the page has left`, async () => {
			run = judged();
			const open = await renderSwitchable();
			const release = held('r2');
			failIds['r2'] = fail;
			await open('r2', false);
			await open('r1');
			release();
			await settle();
			expect(target.textContent).not.toContain(t('common.load_failed'));
			expect(startButton()).toBeDefined();
		});
	}

	it('drops a run the page has left while its targets loaded', async () => {
		run = judged();
		const open = await renderSwitchable();
		const release = held('r2/targets');
		runsById['r2'] = judged({ id: 'r2', judgeRuleHash: 'h2' });
		await open('r2', false);
		await settle();
		await open('r1');
		release();
		await settle();
		type(capField(), '5');
		startButton()!.click();
		await settle();
		expect(resumes()).toEqual([{ judgeRuleHash: 'h1', costCapUsd: 5 }]);
		expect(resumeUrls()).toEqual([expect.stringContaining('/bulk/runs/r1/resume')]);
	});

	it('shows no error for a short target list of a run the page has left', async () => {
		run = judged();
		const open = await renderSwitchable();
		const release = held('r2/targets');
		// A preview loads whole; its list comes back shorter than its count.
		runsById['r2'] = makeRun({ id: 'r2', phase: 'previewed', total: TARGETS.length + 2 });
		await open('r2', false);
		await settle();
		await open('r1');
		release();
		await settle();
		expect(target.textContent).not.toContain(t('common.load_failed'));
		expect(startButton()).toBeDefined();
	});

	it('shows no error for the first load of a run the page left and opened again', async () => {
		run = judged();
		const open = await renderSwitchable();
		runsById['r2'] = judged({ id: 'r2', judgeRuleHash: 'h2' });
		await open('r2');
		const release = held('r1');
		await open('r1', false);
		await open('r2');
		// The second load of r1 answers at once; the first one answers last, with a failure.
		await open('r1');
		expect(startButton()).toBeDefined();
		failIds['r1'] = 'throw';
		release();
		await settle();
		expect(target.textContent).not.toContain(t('common.load_failed'));
		expect(startButton()).toBeDefined();
	});

	it('shows a start refused for a run the page has left neither on the run it shows nor later', async () => {
		run = judged();
		const open = await renderSwitchable();
		runsById['r2'] = judged({ id: 'r2', judgeRuleHash: 'h2' });
		refuseResume = 'planner_unknown';
		const release = held('r1/resume');
		type(capField(), '5');
		startButton()!.click();
		await tick();
		await open('r2');
		release();
		await settle();
		expect(resumeUrls()).toEqual([expect.stringContaining('/bulk/runs/r1/resume')]);
		expect(target.textContent).not.toContain(t('bulk.resume.refused.planner_unknown'));
		// The refusal is r1's: shown nowhere once the page has left r1.
		await open('r1');
		expect(target.textContent).not.toContain(t('bulk.resume.refused.planner_unknown'));
	});

	it('asks to end no other run on a start answered after the page left its run', async () => {
		run = judged();
		const open = await renderSwitchable();
		runsById['r2'] = judged({ id: 'r2', judgeRuleHash: 'h2' });
		refuseResume = 'supersede_required';
		const release = held('r1/resume');
		type(capField(), '5');
		startButton()!.click();
		await tick();
		await open('r2');
		release();
		await settle();
		expect(target.textContent).not.toContain(t('bulk.start.supersede').split('{cost}')[0]!);
	});

	it('shows a take-out refused after the page left its run on neither run', async () => {
		run = makeRun();
		const open = await renderSwitchable();
		runsById['r2'] = makeRun({ id: 'r2' });
		refuseDeselect = 'not_writing';
		const release = held('r1/deselect');
		buttonByText(t('bulk.deselect.off'))!.click();
		await tick();
		await open('r2');
		release();
		await settle();
		expect(posts.map((p) => p.url)).toEqual([expect.stringContaining('/bulk/runs/r1/targets/1/deselect')]);
		expect(target.textContent).not.toContain(t('bulk.deselect.refused.not_writing'));
	});

	it('sends no take-out while another run loads, though the page still shows the one before', async () => {
		run = makeRun();
		const open = await renderSwitchable();
		runsById['r2'] = makeRun({ id: 'r2' });
		const release = held('r2');
		await open('r2', false);
		buttonByText(t('bulk.deselect.off'))!.click();
		await settle();
		expect(posts).toEqual([]);
		release();
		await settle();
		expect(posts).toEqual([]);
	});

	it('leaves a refusal shown on one run behind when another opens', async () => {
		run = makeRun();
		const open = await renderSwitchable();
		runsById['r2'] = makeRun({ id: 'r2' });
		refuseDeselect = 'not_writing';
		buttonByText(t('bulk.deselect.off'))!.click();
		await settle();
		expect(target.textContent).toContain(t('bulk.deselect.refused.not_writing'));
		await open('r2');
		expect(target.textContent).not.toContain(t('bulk.deselect.refused.not_writing'));
	});

	it('appends no page of a run the page has left to the run it shows', async () => {
		targets = Array.from({ length: 8 }, (_, i) => ({ ...TARGETS[1]!, seq: i + 1, key: `gid://shopify/Product/${i + 1}` }));
		run = makeRun({ phase: 'done', total: 8 });
		const open = await renderSwitchable();
		runsById['r2'] = makeRun({ id: 'r2', phase: 'done', total: 8 });
		const showAll = (): HTMLButtonElement | undefined => buttonByText(tf('bulk.preview.show_all', { n: '8' }));
		expect(showAll()).toBeDefined();
		const release = held('r1/targets');
		showAll()!.click();
		await tick();
		await open('r2');
		release();
		await settle();
		// r2 still shows its first page and the button for the rest.
		expect(showAll()).toBeDefined();
	});

	it('shows no failed ask for more of a run the page has left on the run that loads in its place', async () => {
		targets = Array.from({ length: 8 }, (_, i) => ({ ...TARGETS[1]!, seq: i + 1, key: `gid://shopify/Product/${i + 1}` }));
		run = makeRun({ phase: 'done', total: 8 });
		const open = await renderSwitchable();
		runsById['r2'] = makeRun({ id: 'r2', phase: 'done', total: 8 });
		const releaseMore = held('r1/targets');
		failIds['r1/targets'] = 'throw';
		buttonByText(tf('bulk.preview.show_all', { n: '8' }))!.click();
		await tick();
		// r2 loads while r1's ask for more fails.
		const releaseR2 = held('r2');
		await open('r2', false);
		releaseMore();
		await settle();
		expect(target.textContent).not.toContain(t('common.load_failed'));
		releaseR2();
		await settle();
		expect(target.textContent).not.toContain(t('common.load_failed'));
	});

	it('asks for no more of a run while another run loads in its place', async () => {
		targets = Array.from({ length: 8 }, (_, i) => ({ ...TARGETS[1]!, seq: i + 1, key: `gid://shopify/Product/${i + 1}` }));
		run = makeRun({ phase: 'done', total: 8 });
		const open = await renderSwitchable();
		runsById['r2'] = makeRun({ id: 'r2', phase: 'done', total: 8 });
		const showAll = (): HTMLButtonElement | undefined => buttonByText(tf('bulk.preview.show_all', { n: '8' }));
		const release = held('r2');
		await open('r2', false);
		// r1 still shows while r2 loads; its button asks for nothing.
		const asked = gets.length;
		showAll()!.click();
		await tick();
		expect(gets.slice(asked).filter((u) => u.includes('/bulk/runs/r1/'))).toEqual([]);
		release();
		await settle();
		expect(showAll()).toBeDefined();
	});

	it('keeps the failed load of the run it shows, not the refusal of a start on the run before', async () => {
		run = judged();
		const open = await renderSwitchable();
		runsById['r2'] = judged({ id: 'r2', judgeRuleHash: 'h2' });
		refuseResume = 'planner_unknown';
		failIds['r2'] = 'status';
		// The refused start reloads r1; that reload waits while the page moves to r2, whose load fails.
		const release = held('r1');
		type(capField(), '5');
		startButton()!.click();
		await settle();
		await open('r2');
		release();
		await settle();
		expect(target.textContent).toContain(t('common.load_failed'));
		expect(target.textContent).not.toContain(t('bulk.resume.refused.planner_unknown'));
	});

	it('drops the late answer of a run the page has left, and starts the run it shows', async () => {
		run = judged();
		const open = await renderSwitchable();
		const release = held('r2');
		runsById['r2'] = judged({ id: 'r2', judgeRuleHash: 'h2' });
		await open('r2', false);
		await open('r1');
		release();
		await settle();
		type(capField(), '5');
		startButton()!.click();
		await settle();
		expect(resumes()).toEqual([{ judgeRuleHash: 'h1', costCapUsd: 5 }]);
		expect(resumeUrls()).toEqual([expect.stringContaining('/bulk/runs/r1/resume')]);
	});

	it('does not hold the start of this run on a wrong line typed for another', async () => {
		run = judged();
		const open = await renderSwitchable();
		type(field()!, 'mein-shop.ch/pfad');
		run = judged({ id: 'r2' });
		await open('r2');
		expect(target.textContent).not.toContain(t('bulk.start_domains.invalid'));
		type(capField(), '5');
		expect(startButton()!.disabled).toBe(false);
	});

	it('shows the fixed list at a restart of the judge and sends none with it', async () => {
		run = judged({ haltKey: 'unavailable', startDomains: ['mein-shop.ch'] });
		await render();
		expect(field()).toBeNull();
		expect(target.querySelector('[data-testid="bulk-start-domains"]')!.textContent!.trim())
			.toBe(tf('bulk.start_domains.shown', { list: 'mein-shop.ch', store: 'demo.myshopify.com' }));
		buttonByText(t('bulk.restart.judge'))!.click();
		await settle();
		expect(resumes()).toEqual([{ judgeRuleHash: 'h1' }]);
	});

	it('shows the fixed list at a restart over the spend limit and sends none with the higher limit', async () => {
		run = judged({ haltKey: 'costCap', costCapUsd: 1, startDomains: ['mein-shop.ch', 'b.example'] });
		await render();
		expect(field()).toBeNull();
		expect(target.querySelector('[data-testid="bulk-start-domains"]')!.textContent!.trim())
			.toBe(tf('bulk.start_domains.shown', { list: 'mein-shop.ch, b.example', store: 'demo.myshopify.com' }));
		type(capField(), '5');
		buttonByText(t('bulk.restart.judge'))!.click();
		await settle();
		expect(resumes()).toEqual([{ judgeRuleHash: 'h1', costCapUsd: 5 }]);
	});

	it('shows the list in the approval of a judged list run, and none on a run without a list', async () => {
		run = makeRun({ judge: { tier: 'standard', unjudged: 0 }, list: { state: 'done' }, startDomains: ['mein-shop.ch', 'b.example'] });
		await render();
		expect(target.querySelector('[data-testid="bulk-start-domains"]')!.textContent!.trim())
			.toBe(tf('bulk.start_domains.shown', { list: 'mein-shop.ch, b.example', store: 'demo.myshopify.com' }));
		// The approval covers the list as it stands: it sends none of its own. One target to write,
		// so the approval is the whole run's.
		buttonByText(t('bulk.approve.write_only'))!.click();
		await settle();
		const approvals = posts.filter((p) => p.url.endsWith('/approve'));
		expect(approvals).toHaveLength(1);
		expect(approvals[0]!.body).not.toHaveProperty('startDomains');
		unmount(component!);
		component = undefined;
		run = makeRun({ judge: { tier: 'standard', unjudged: 0 }, list: { state: 'done' }, startDomains: null });
		await render();
		expect(target.querySelector('[data-testid="bulk-start-domains"]')!.textContent!.trim())
			.toBe(tf('bulk.start_domains.none', { store: 'demo.myshopify.com' }));
		unmount(component!);
		component = undefined;
		run = makeRun({ judge: { tier: 'standard', unjudged: 0 }, list: null });
		await render();
		expect(target.querySelector('[data-testid="bulk-start-domains"]')).toBeNull();
	});
});

// The halt for an outdated connection consent names the next step once: on the owner's page the box
// below says to plan again, so the halt ends at the reconnect; a mandate's page has no such box, so
// its halt says it.
describe('the next step of a halt for an outdated connection consent', () => {
	// Nothing written yet, or some of the run already written: the two halt sentences.
	const halted = (applied: number): BulkRunDetailData => makeRun({
		targetSystem: 'http:demo.myshopify.com', phase: 'approved', applied, sentUnknown: 0,
		haltReason: 'engine English', haltKey: 'consentOutdated', consentFields: ['descriptionHtml'],
	});
	// Pinned, not read from the keys under test: a halt that drops the step must fail here.
	const planAgain = (): RegExp => (getLocale() === 'de' ? /neu (zu )?planen/ : /plan the run again/);
	// The halt line of the head, not the page: target rows say to plan again for their own reasons.
	const haltLine = (): string => [...target.querySelectorAll('dt')].find((d) => d.textContent === t('bulk.head.halted'))!.nextElementSibling!.textContent!;
	const cases = (['de', 'en'] as const).flatMap((lang) => [0, 1].map((applied) => [lang, applied] as const));
	const inLocale = (lang: 'de' | 'en'): void => {
		const before = getLocale();
		setLocale(lang);
		onTestFinished(() => setLocale(before));
	};

	it.each(cases)('says to plan again in the box below on the owner\'s page, and not in the halt (%s, %i written)', async (lang, applied) => {
		inLocale(lang);
		run = halted(applied);
		await render();
		expect(t('bulk.resume.none')).toMatch(planAgain());
		expect(target.textContent).toContain(t('bulk.resume.none'));
		expect(haltLine()).toContain(t('bulk.consent.field.descriptionHtml'));
		expect(haltLine()).not.toMatch(planAgain());
	});

	// The box is looked for by its words; the owner's case above shows those words are the box's.
	it.each(cases)('says to plan again in the halt on a mandate\'s page, which has no box (%s, %i written)', async (lang, applied) => {
		inLocale(lang);
		viewerOf = 'mandate';
		run = halted(applied);
		await render();
		expect(target.textContent).not.toContain(t('bulk.resume.none'));
		expect(haltLine()).toContain(t('bulk.consent.field.descriptionHtml'));
		expect(haltLine()).toMatch(planAgain());
	});
});

describe('discarding a run before approving it (U-324)', () => {
	it('offers the owner "Discard" on a preview, asks first, and discards only on the confirmation', async () => {
		await render();
		const open = target.querySelector<HTMLButtonElement>('[data-testid="bulk-discard-open"]');
		expect(open?.textContent?.trim()).toBe(t('bulk.discard.button'));
		// Secondary, never red: lynox writes nothing by it.
		expect(open?.className ?? '').not.toMatch(/danger/);
		expect(target.querySelector('[data-testid="bulk-discard-confirm"]')).toBeNull();
		open!.click();
		await settle();
		const box = target.querySelector('[data-testid="bulk-discard"]')!;
		expect(box.textContent).toContain(t('bulk.discard.confirm_title'));
		expect(box.textContent).toContain(t('bulk.discard.confirm_text'));
		expect(posts).toEqual([]);
		// Cancel closes it and sends nothing.
		buttonByText(t('bulk.discard.cancel'))!.click();
		await settle();
		expect(target.querySelector('[data-testid="bulk-discard-confirm"]')).toBeNull();
		expect(posts).toEqual([]);
		target.querySelector<HTMLButtonElement>('[data-testid="bulk-discard-open"]')!.click();
		await settle();
		target.querySelector<HTMLButtonElement>('[data-testid="bulk-discard-confirm"]')!.click();
		await settle();
		expect(posts).toHaveLength(1);
		expect(posts[0]!.url.endsWith('/bulk/runs/r1/discard')).toBe(true);
	});

	it('offers a mandate no discard, and offers none on a run past its approval', async () => {
		viewerOf = 'mandate';
		resetSettingsViewer();
		await render();
		expect(target.querySelector('[data-testid="bulk-discard"]')).toBeNull();
		if (component) unmount(component);
		component = undefined;
		viewerOf = 'owner';
		resetSettingsViewer();
		run = makeRun({ phase: 'approved', maxTargets: 1 });
		await render();
		expect(target.querySelector('[data-testid="bulk-discard"]')).toBeNull();
	});

	it('names a discarded run as discarded, the owner as "you" and anyone else the owner', async () => {
		for (const [viewer, key] of [['owner', 'bulk.halt.discarded'], ['mandate', 'bulk.halt.discarded_mandate']] as const) {
			viewerOf = viewer;
			resetSettingsViewer();
			run = makeRun({ phase: 'aborted', haltReason: 'the owner discarded this run before approving it', haltKey: 'discarded' });
			await render();
			const text = target.textContent ?? '';
			expect([viewer, text.includes(t(key))]).toEqual([viewer, true]);
			// The last step's chip says discarded, not done.
			expect(target.querySelector('[aria-current="step"]')?.textContent).toBe(t('bulk.phase.discarded'));
			expect(target.querySelector('[data-testid="bulk-discard"]')).toBeNull();
			if (component) unmount(component);
			component = undefined;
		}
		resetSettingsViewer();
	});
});

// The start of a judged run (U-333): the fields the judge sets in words, not as the schema, and
// a line under the disabled start button that says what is missing.
describe('the start of a judged run, in words', () => {
	const judged = (o: Partial<BulkRunDetailData> = {}): BulkRunDetailData => makeRun({
		phase: 'planned', haltKey: 'listed', haltReason: 'engine English', checksum: null,
		judge: { tier: 'standard', unjudged: 3 }, judgeRuleHash: 'h1',
		judgeServedBy: { provider: 'anthropic', label: 'Modell' },
		judgeRule: { rule: 'Schreib die Beschreibung neu.', schema: { properties: { body_html: { type: 'string', maxLength: 5000 } } }, tier: 'standard' },
		list: { state: 'done' }, startDomains: null,
		...o,
	});
	const fieldLines = (): string[] => [...target.querySelectorAll('[data-testid="bulk-start-field"]')].map((li) => li.textContent?.trim() ?? '');
	const type = (el: HTMLInputElement | HTMLTextAreaElement, value: string): void => {
		el.value = value;
		el.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
	};
	const capField = (): HTMLInputElement => target.querySelector('input[inputmode="decimal"]')!;
	const domainField = (): HTMLTextAreaElement => target.querySelector('[data-testid="bulk-start-domains"] textarea')!;
	const startButton = (): HTMLButtonElement => buttonByText(t(bulkStartButtonKey(run, 'judge', false) ?? 'bulk.start.judge'))!;
	const hint = (): string | null => target.querySelector('[data-testid="bulk-start-hint"]')?.textContent ?? null;

	it('names each field the judge sets with its shape in words, and shows no schema', async () => {
		run = judged({ judgeRule: { rule: 'r', tier: 'standard', schema: { properties: {
			seo_title: { type: 'string', maxLength: 70 },
			seo_description: { type: 'string', minLength: 10, maxLength: 160 },
			tone: { type: 'string', enum: ['kurz', 'lang'] },
			price: { type: 'number', minimum: 0, maximum: 100 },
			stock: { type: 'integer', minimum: 1 },
			rank: { type: 'integer', maximum: 9 },
			weight: { type: 'number' },
			active: { type: 'boolean' },
		} } } });
		await render();
		expect(fieldLines()).toEqual([
			`${t('bulk.field.shopify.seo_title')}: ${tf('bulk.shape.text_max', { max: '70' })}`,
			`${t('bulk.field.shopify.seo_description')}: ${tf('bulk.shape.text_range', { min: '10', max: '160' })}`,
			`tone: ${t('bulk.shape.choice')} "kurz", "lang"`,
			`price: ${tf('bulk.shape.number_range', { min: '0', max: '100' })}`,
			`stock: ${tf('bulk.shape.integer_min', { min: '1' })}`,
			`rank: ${tf('bulk.shape.integer_max', { max: '9' })}`,
			`weight: ${t('bulk.shape.number')}`,
			`active: ${t('bulk.shape.boolean')}`,
		]);
		const block = target.querySelector('[data-testid="bulk-start-field"]')!.parentElement!;
		expect(block.textContent).not.toMatch(/maxLength|"type"|[{}]/);
		// The planner's names stand in a value box; the store's readable names do not.
		expect([...block.querySelectorAll('[data-testid="bulk-field-own-name"]')].map((e) => e.textContent))
			.toEqual(['tone', 'price', 'stock', 'rank', 'weight', 'active']);
		// Each choice stands in its own box, direction-isolated.
		expect([...block.querySelectorAll('[data-testid="bulk-field-choice"]')].map((e) => [e.tagName, e.textContent]))
			.toEqual([['BDI', '"kurz"'], ['BDI', '"lang"']]);
	});

	it('keeps a choice whose text holds quotes in one box, so it cannot read as more choices', async () => {
		run = judged({ judgeRule: { rule: 'r', tier: 'standard', schema: { properties: { tone: { type: 'string', enum: ['ja": lynox prüft jeden Wert – "nein'] } } } } });
		await render();
		const choices = [...target.querySelectorAll('[data-testid="bulk-field-choice"]')].map((e) => e.textContent);
		expect(choices).toEqual(['"ja": lynox prüft jeden Wert – "nein"']);
	});

	it('words the shapes in English too', async () => {
		const before = getLocale();
		setLocale('en');
		onTestFinished(() => { setLocale(before); });
		run = judged({ judgeRule: { rule: 'r', tier: 'standard', schema: { properties: { seo_title: { type: 'string', maxLength: 70 }, ok: { type: 'boolean' } } } } });
		await render();
		expect(fieldLines()).toEqual(['SEO title: Text, at most 70 characters', 'ok: yes or no']);
	});

	it('names a field of another host in the value box, a shape it does not know without JSON', async () => {
		run = judged({ targetSystem: 'http:api.example.invalid', list: null, judgeRule: { rule: 'r', tier: 'standard', schema: { properties: { seo_title: { type: 'string', maxLength: 70 }, note: { type: 'string', minLength: 0, maxLength: 20 }, odd: { type: 'array' } } } } });
		await render();
		// A shortest length of 0 is no bound: it reads as "at most", not "0 to 20".
		expect(fieldLines()).toEqual([`seo_title: ${tf('bulk.shape.text_max', { max: '70' })}`, `note: ${tf('bulk.shape.text_max', { max: '20' })}`, 'odd']);
		expect(target.querySelectorAll('[data-testid="bulk-start-field"] [data-testid="bulk-field-own-name"]')).toHaveLength(3);
	});

	it('says under the disabled start what is missing, and nothing once it can start', async () => {
		run = judged();
		await render();
		expect(startButton().disabled).toBe(true);
		expect(hint()).toBe(t('bulk.start.hint_cap'));
		expect(startButton().getAttribute('aria-describedby')).toBe('bulk-start-hint');
		expect(target.querySelector('#bulk-start-hint')?.textContent).toBe(t('bulk.start.hint_cap'));

		type(domainField(), 'https://mein-shop.ch/pfad');
		expect(hint()).toBe(t('bulk.start.hint_both'));

		type(capField(), '5');
		expect(startButton().disabled).toBe(true);
		expect(hint()).toBe(t('bulk.start.hint_domains'));

		type(domainField(), 'mein-shop.ch');
		expect(startButton().disabled).toBe(false);
		expect(hint()).toBeNull();
		expect(startButton().hasAttribute('aria-describedby')).toBe(false);
	});

	it('names the domain list, not a marked line, when it holds too many domains', async () => {
		run = judged();
		await render();
		type(capField(), '5');
		type(domainField(), Array.from({ length: 21 }, (_, i) => `d${String(i)}.example`).join('\n'));
		expect(startButton().disabled).toBe(true);
		expect(hint()).toBe(t('bulk.start.hint_domains'));
		expect(hint()).not.toMatch(/markiert|marked/);
	});

	it('says nothing under the start while it is under way, though it empties the cost field', async () => {
		run = judged();
		let release!: () => void;
		await render();
		holds['r1'] = new Promise<void>((r) => { release = r; });
		type(capField(), '5');
		startButton().click();
		for (let i = 0; i < 20 && capField().value !== ''; i++) { await tick(); await Promise.resolve(); }
		flushSync();
		expect(capField().value).toBe('');
		expect(startButton().disabled).toBe(true);
		expect(hint()).toBeNull();
		release();
		await settle();
	});

	it('leaves the cost limit out of the hint while its own line says the amount is wrong', async () => {
		run = judged();
		await render();
		type(capField(), '0');
		expect(startButton().disabled).toBe(true);
		expect(target.textContent).toContain(t('bulk.start.cap_invalid'));
		expect(hint()).toBeNull();

		type(domainField(), 'https://mein-shop.ch/pfad');
		expect(hint()).toBe(t('bulk.start.hint_domains'));
	});

	it('shows the hint on the start that ends another run, too', async () => {
		run = judged();
		refuseResume = 'supersede_required';
		await render();
		type(capField(), '5');
		startButton().click();
		await settle();
		const supersede = buttonByText(t(bulkStartButtonKey(run, 'judge', true) ?? 'bulk.start.supersede_yes'))!;
		expect(hint()).toBeNull();
		type(capField(), '');
		expect(supersede.disabled).toBe(true);
		expect(hint()).toBe(t('bulk.start.hint_cap'));
		expect(supersede.getAttribute('aria-describedby')).toBe('bulk-start-hint');
	});
});

describe('a toggle on the run\'s page', () => {
	it('puts a target back against the checksum the take-out answered, and loads no page of targets for either', async () => {
		await render();
		const asked = gets.length;
		buttonByText(t('bulk.deselect.off'))!.click();
		await settle();
		buttonByText(t('bulk.deselect.on'))!.click();
		await settle();
		expect(posts.map((p) => p.body)).toEqual([{ checksum: 'c1' }, { checksum: 'c2' }]);
		expect(gets.slice(asked).some((u) => /\/targets\?/.test(u))).toBe(false);
		expect(target.textContent).not.toContain(t('bulk.deselect.taken_out'));
		expect(buttonByText(t('bulk.deselect.off'))).toBeDefined();
	});

	for (const [what, change] of [
		['another view took a second target out meanwhile', (r: BulkRunDetailData): BulkRunDetailData => ({ ...r, deselected: r.deselected + 1 })],
		['the run lists another number of targets', (r: BulkRunDetailData): BulkRunDetailData => ({ ...r, total: r.total + 1 })],
		// Another view put one target back and took another out: the counts are as this toggle left
		// them, only the checksum tells the run moved.
		['another view moved a pair of targets that cancels out', (r: BulkRunDetailData): BulkRunDetailData => ({ ...r, checksum: 'c9' })],
	] as const) {
		it(`loads the run whole where ${what}`, async () => {
			await render();
			const asked = gets.length;
			const realFetch = globalThis.fetch;
			vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
				if (init?.method !== 'POST' && posts.length > 0 && /\/bulk\/runs\/r1$/.test(String(url)) && gets.length === asked) run = change(run);
				return realFetch(url, init);
			}));
			buttonByText(t('bulk.deselect.off'))!.click();
			await settle();
			expect(gets.slice(asked).some((u) => /\/targets\?/.test(u))).toBe(true);
		});
	}

	it('loads the run whole where the ask for it fails', async () => {
		await render();
		const asked = gets.length;
		const realFetch = globalThis.fetch;
		let failed = false;
		vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
			if (!failed && init?.method !== 'POST' && posts.length > 0 && /\/bulk\/runs\/r1$/.test(String(url))) {
				failed = true;
				gets.push(String(url));
				return new Response('{}', { status: 502, headers: { 'Content-Type': 'application/json' } });
			}
			return realFetch(url, init);
		}));
		buttonByText(t('bulk.deselect.off'))!.click();
		await settle();
		expect(gets.slice(asked).some((u) => /\/targets\?/.test(u))).toBe(true);
		expect(target.textContent).toContain(t('bulk.deselect.taken_out'));
	});

	it('loads the run whole where the ask for it throws, and shows the toggle', async () => {
		await render();
		const asked = gets.length;
		const realFetch = globalThis.fetch;
		let failed = false;
		vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
			if (!failed && init?.method !== 'POST' && posts.length > 0 && /\/bulk\/runs\/r1$/.test(String(url))) {
				failed = true;
				gets.push(String(url));
				throw new Error('network');
			}
			return realFetch(url, init);
		}));
		buttonByText(t('bulk.deselect.off'))!.click();
		await settle();
		expect(gets.slice(asked).some((u) => /\/targets\?/.test(u))).toBe(true);
		expect(target.textContent).toContain(t('bulk.deselect.taken_out'));
	});

	it('loads the run whole where it is no longer the preview it showed', async () => {
		await render();
		const asked = gets.length;
		const realFetch = globalThis.fetch;
		vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
			// The engine moved the run on between the toggle and the ask: it is approved now.
			if (init?.method !== 'POST' && posts.length > 0 && /\/bulk\/runs\/r1$/.test(String(url))) run = { ...run, phase: 'approved' };
			return realFetch(url, init);
		}));
		buttonByText(t('bulk.deselect.off'))!.click();
		await settle();
		expect(gets.slice(asked).some((u) => /\/targets\?/.test(u))).toBe(true);
	});
});

// U-387: a judged run's verdicts that differ from the rest of it come first, each with its reasons as
// text that does not look clickable, under a line that says this is a reading order, not a check.
describe('verdicts that differ from the rest of the run', () => {
	const outlierCount = (): string | null | undefined => target.querySelector('[data-testid="bulk-outlier-count"]')?.textContent;
	const spread = (): string[] => [...target.querySelectorAll('[data-testid="bulk-outlier-spread"]')].map((e) => e.textContent ?? '');
	const rowNames = (): string[] => [...target.querySelectorAll('tbody tr')].map((r) => r.querySelector('td')?.textContent ?? '');
	const pills = (row: number): string[] => [...target.querySelectorAll('tbody tr')[row]!.querySelectorAll('[data-testid="bulk-outlier"]')].map((e) => e.textContent ?? '');
	const many = (n: number): BulkTarget[] => Array.from({ length: n }, (_, i) => ({
		seq: i + 1, key: `gid://shopify/Product/${String(i + 1)}`, change: 'update' as const, diff: fieldsDiff(`Alt ${String(i + 1)}`, `Neu ${String(i + 1)}`), error: null, deselected: false,
	}));
	const changes = (n: number) => ({ update: n, create: 0, delete: 0, unchanged: 0, invalid: 0 });

	it('lists the flagged verdicts first in their own order, with every reason, and says one that does not stand out can still be wrong', async () => {
		run = makeRun({ total: 25, changes: changes(25), judgeOutliers: { decided: 25, measured: true, spread: [],
			flagged: [{ seq: 7, reasons: ['new_link', 'length_jump'] }, { seq: 19, reasons: ['rare_value'] }] } });
		targets = many(25);
		await render();
		expect(outlierCount()).toBe(tf('bulk.outliers.count', { n: '2' }));
		expect(rowNames().slice(0, 3).map((r) => /(\d+)/.exec(r)?.[1])).toEqual(['7', '19', '1']);
		expect(pills(0)).toEqual([t('bulk.outlier.new_link'), t('bulk.outlier.length_jump')]);
		expect(pills(1)).toEqual([t('bulk.outlier.rare_value')]);
		expect(pills(2)).toEqual([]);
		// Text, never a link.
		expect(target.querySelector('[data-testid="bulk-outlier"] a, [data-testid="bulk-outlier-count"] a')).toBeNull();
	});

	it('says in the singular that one verdict differs', async () => {
		run = makeRun({ total: 25, changes: changes(25), judgeOutliers: { decided: 25, measured: true, spread: [], flagged: [{ seq: 3, reasons: ['changed_fields'] }] } });
		targets = many(25);
		await render();
		expect(outlierCount()).toBe(t('bulk.outliers.count_one'));
	});

	it('says that no verdict differs, and that this is no check, when none is flagged among 20 or more', async () => {
		run = makeRun({ total: 25, changes: changes(25), judgeOutliers: { decided: 25, measured: true, spread: [], flagged: [] } });
		targets = many(25);
		await render();
		expect(outlierCount()).toBe(t('bulk.outliers.none'));
		expect(target.querySelector('[data-testid="bulk-outlier"]')).toBeNull();
	});

	it('tells the owner to read every verdict of a run under 20', async () => {
		run = makeRun({ total: 5, changes: changes(5), judgeOutliers: { decided: 5, measured: false, spread: [], flagged: [] } });
		targets = many(5);
		await render();
		expect(outlierCount()).toBe(t('bulk.outliers.small'));
	});

	it('lists the first 50 of more flagged verdicts first and names how many differ', async () => {
		const flagged = Array.from({ length: 60 }, (_, i) => ({ seq: 100 - i, reasons: ['new_phone' as const] })).sort((a, b) => a.seq - b.seq);
		run = makeRun({ total: 100, changes: changes(100), judgeOutliers: { decided: 100, measured: true, spread: [], flagged } });
		targets = many(100);
		await render();
		expect(outlierCount()).toBe(tf('bulk.outliers.over', { n: '60', first: '50' }));
		// The first 50 flagged (seq 41–90) on top in their own order, then the rest in plan order: 1–40,
		// then 91–100, flagged but not lifted.
		const seqs = rowNames().map((r) => Number(/(\d+)/.exec(r)?.[1]));
		expect(seqs.slice(0, 50)).toEqual(Array.from({ length: 50 }, (_, i) => 41 + i));
		expect(seqs.slice(50, 52)).toEqual([1, 2]);
		expect(seqs.slice(-10)).toEqual(Array.from({ length: 10 }, (_, i) => 91 + i));
		expect(pills(99)).toEqual([t('bulk.outlier.new_phone')]);
	});

	it('names a link many verdicts add on a line of its own, with up to five hosts as text and how many more', async () => {
		const hosts = ['a.example', 'b.example', 'c.example', 'd.example', 'e.example', 'f.example', 'g.example'];
		run = makeRun({ total: 25, changes: changes(25), judgeOutliers: { decided: 25, measured: true, flagged: [],
			spread: [{ kind: 'link', count: 25, hosts }, { kind: 'phone', count: 1, hosts: [] }] } });
		targets = many(25);
		await render();
		expect(spread()).toEqual([
			tf('bulk.outliers.spread.link', { n: '25', hosts: tf('bulk.outliers.spread.link_hosts_more', { hosts: hosts.slice(0, 5).join(', '), k: '2' }) }),
			tf('bulk.outliers.spread.phone_one', { n: '1', hosts: '' }),
		]);
		expect(target.querySelector('[data-testid="bulk-outlier-spread"] a')).toBeNull();
	});

	it('names seven hosts that mark a row, all of them first, and of the others five and how many more, for links and for addresses', async () => {
		const marking = ['m1.example', 'm2.example', 'm3.example', 'm4.example', 'm5.example', 'm6.example', 'm7.example'];
		const others = ['o1.example', 'o2.example', 'o3.example', 'o4.example', 'o5.example', 'o6.example', 'o7.example'];
		run = makeRun({ total: 25, changes: changes(25), judgeOutliers: { decided: 25, measured: true, flagged: [],
			spread: [{ kind: 'link', count: 20, hosts: [...marking, ...others], marked: 7 }, { kind: 'email', count: 20, hosts: [...marking, ...others], marked: 7 }] } });
		targets = many(25);
		await render();
		for (const [i, kind] of (['link', 'email'] as const).entries()) {
			expect(spread()[i], kind).toBe(tf(`bulk.outliers.spread.${kind}`, { n: '20', hosts: tf(`bulk.outliers.spread.${kind}_hosts_more`, { hosts: [...marking, ...others.slice(0, 5)].join(', '), k: '2' }) }));
		}
	});

	it('names twenty hosts that mark a row and counts the rest in a sentence of its own, apart from the others it leaves out', async () => {
		const marking = Array.from({ length: 25 }, (_, i) => `m${String(i + 1)}.example`);
		const others = ['o1.example', 'o2.example', 'o3.example', 'o4.example', 'o5.example', 'o6.example', 'o7.example'];
		run = makeRun({ total: 25, changes: changes(25), judgeOutliers: { decided: 25, measured: true, flagged: [],
			spread: [{ kind: 'link', count: 20, hosts: [...marking, ...others], marked: 25 }, { kind: 'email', count: 20, hosts: [...marking.slice(0, 21), ...others], marked: 21 }] } });
		targets = many(25);
		await render();
		const listed = (n: number) => [...marking.slice(0, n), ...others.slice(0, 5)].join(', ');
		expect(spread()).toEqual([
			tf('bulk.outliers.spread.link', { n: '20', hosts: tf('bulk.outliers.spread.link_hosts_more', { hosts: listed(20), k: '2' }) + tf('bulk.outliers.spread.link_marked_more', { m: '5' }) }),
			tf('bulk.outliers.spread.email', { n: '20', hosts: tf('bulk.outliers.spread.email_hosts_more', { hosts: listed(20), k: '2' }) + t('bulk.outliers.spread.email_marked_more_one') }),
		]);
	});

	it('counts one marking host past twenty in the singular, also when no other host is on the line', async () => {
		const marking = Array.from({ length: 21 }, (_, i) => `m${String(i + 1)}.example`);
		run = makeRun({ total: 25, changes: changes(25), judgeOutliers: { decided: 25, measured: true, flagged: [],
			spread: [{ kind: 'link', count: 21, hosts: marking, marked: 21 }] } });
		targets = many(25);
		await render();
		expect(spread()).toEqual([tf('bulk.outliers.spread.link', { n: '21', hosts: tf('bulk.outliers.spread.link_hosts', { hosts: marking.slice(0, 20).join(', ') }) + t('bulk.outliers.spread.link_marked_more_one') })]);
	});

	it('names the one host that marks a row before seven that do not, and counts only those it leaves out', async () => {
		const others = ['o1.example', 'o2.example', 'o3.example', 'o4.example', 'o5.example', 'o6.example', 'o7.example'];
		run = makeRun({ total: 25, changes: changes(25), judgeOutliers: { decided: 25, measured: true, flagged: [{ seq: 5, reasons: ['new_link'] }],
			spread: [{ kind: 'link', count: 15, hosts: ['selten.example', ...others], marked: 1 }] } });
		targets = many(25);
		await render();
		expect(spread()).toEqual([tf('bulk.outliers.spread.link', { n: '15', hosts: tf('bulk.outliers.spread.link_hosts_more', { hosts: ['selten.example', ...others.slice(0, 5)].join(', '), k: '2' }) })]);
	});

	it('shows a hidden character in a host of that line instead of hiding it', async () => {
		run = makeRun({ total: 25, changes: changes(25), judgeOutliers: { decided: 25, measured: true, flagged: [],
			spread: [{ kind: 'link', count: 25, hosts: ['shop\u200b.example', 'sh\u200cop.example'] }] } });
		targets = many(25);
		await render();
		expect(spread()).toHaveLength(1);
		// A zero-width space, and a joiner that running text may carry between letters: in a host neither is.
		expect(spread()[0]).not.toMatch(/[\u200b\u200c]/u);
		expect(spread()[0]).toContain('⟨U+200B⟩');
		expect(spread()[0]).toContain('⟨U+200C⟩');
	});

	it('states the way out once below two run lines, in the same box as the lines', async () => {
		const closing = (): string[] => [...target.querySelectorAll('[data-testid="bulk-outlier-spread-closing"]')].map((e) => e.textContent ?? '');
		run = makeRun({ total: 25, changes: changes(25), judgeOutliers: { decided: 25, measured: true, flagged: [],
			spread: [{ kind: 'link', count: 20, hosts: ['a.example'] }, { kind: 'email', count: 20, hosts: ['b.example'] }] } });
		targets = many(25);
		await render();
		expect(spread()).toHaveLength(2);
		for (const line of spread()) expect(line).not.toContain(t('bulk.outliers.spread.closing'));
		expect(closing()).toEqual([t('bulk.outliers.spread.closing')]);
		const box = target.querySelector('[data-testid="bulk-outlier-spread-box"]')!;
		expect(box.querySelectorAll('[data-testid="bulk-outlier-spread"]')).toHaveLength(2);
		expect(box.querySelector('[data-testid="bulk-outlier-spread-closing"]')).not.toBeNull();
	});

	it('states the way out once below a single run line too', async () => {
		run = makeRun({ total: 25, changes: changes(25), judgeOutliers: { decided: 25, measured: true, flagged: [],
			spread: [{ kind: 'phone', count: 20, hosts: [] }] } });
		targets = many(25);
		await render();
		expect(spread()).toEqual([tf('bulk.outliers.spread.phone', { n: '20', hosts: '' })]);
		expect([...target.querySelectorAll('[data-testid="bulk-outlier-spread-closing"]')].map((e) => e.textContent)).toEqual([t('bulk.outliers.spread.closing')]);
	});

	it('shows the table on the verdicts of one line alone, says so over the table, and shows all again from the line or from over the table', async () => {
		const filtered = (): string | null | undefined => target.querySelector('[data-testid="bulk-outlier-filtered"]')?.textContent;
		const shows = (): string[] => [...target.querySelectorAll('[data-testid="bulk-outlier-spread-show"]')].map((e) => e.textContent ?? '');
		const seqsShown = (): number[] => rowNames().map((r) => Number(/(\d+)/.exec(r)?.[1]));
		run = makeRun({ total: 25, changes: changes(25), judgeOutliers: { decided: 25, measured: true, flagged: [],
			spread: [{ kind: 'link', count: 3, hosts: ['a.example'], seqs: [3, 5, 7] }, { kind: 'email', count: 1, hosts: ['b.example'], seqs: [2] }] } });
		targets = many(25);
		await render();
		expect(shows()).toEqual([tf('bulk.outliers.spread.show', { n: '3' }), t('bulk.outliers.spread.show_one')]);
		expect(filtered()).toBeUndefined();
		expect(seqsShown()).toHaveLength(25);

		buttonByText(tf('bulk.outliers.spread.show', { n: '3' }))!.click();
		await settle();
		expect(seqsShown()).toEqual([3, 5, 7]);
		expect(filtered()).toBe(`${tf('bulk.outliers.filtered.link', { n: '3' })} ${t('bulk.outliers.spread.show_all')}`);
		expect(shows()).toEqual([t('bulk.outliers.spread.show_all'), t('bulk.outliers.spread.show_one')]);
		// Over the table, not below it.
		const line = target.querySelector('[data-testid="bulk-outlier-filtered"]')!;
		expect(line.compareDocumentPosition(target.querySelector('table')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

		// Another line's button changes the kind shown.
		buttonByText(t('bulk.outliers.spread.show_one'))!.click();
		await settle();
		expect(seqsShown()).toEqual([2]);
		expect(filtered()).toBe(`${t('bulk.outliers.filtered.email_one')} ${t('bulk.outliers.spread.show_all')}`);

		// From over the table: all again, and the focus on the button of that kind in the box.
		(target.querySelector('[data-testid="bulk-outlier-filtered-all"]') as HTMLButtonElement).click();
		await settle();
		expect(seqsShown()).toHaveLength(25);
		expect(filtered()).toBeUndefined();
		expect(document.activeElement).toBe(target.querySelectorAll('[data-testid="bulk-outlier-spread-show"]')[1]);

		// From the line itself: the same button shows all again.
		buttonByText(tf('bulk.outliers.spread.show', { n: '3' }))!.click();
		await settle();
		expect(seqsShown()).toEqual([3, 5, 7]);
		(target.querySelectorAll('[data-testid="bulk-outlier-spread-show"]')[0] as HTMLButtonElement).click();
		await settle();
		expect(seqsShown()).toHaveLength(25);
		expect(filtered()).toBeUndefined();
	});

	it('says at the approval, while the table is filtered, that the approval covers every verdict, and shows all from there', async () => {
		const note = (): string | null | undefined => target.querySelector('[data-testid="bulk-approve-filtered"]')?.textContent;
		run = makeRun({ total: 25, changes: changes(25), judgeOutliers: { decided: 25, measured: true, flagged: [],
			spread: [{ kind: 'link', count: 3, hosts: ['a.example'], seqs: [3, 5, 7] }] } });
		targets = many(25);
		await render();
		expect(note()).toBeUndefined();
		buttonByText(tf('bulk.outliers.spread.show', { n: '3' }))!.click();
		await settle();
		expect(note()).toBe(`${tf('bulk.approve.filtered', { n: '3', m: '25' })} ${t('bulk.outliers.spread.show_all')}`);
		const approveButton = buttonByText(t('bulk.approve.write_one')) ?? buttonByText(t('bulk.approve.approve'));
		(target.querySelector('[data-testid="bulk-approve-filtered-all"]') as HTMLButtonElement).click();
		await settle();
		expect(note()).toBeUndefined();
		expect(rowNames()).toHaveLength(25);
		expect(document.activeElement).toBe(approveButton);
	});

	it('counts the rows the filtered table shows, leaves out the unchanged rows and their button, and offers that button again after', async () => {
		const unchangedButton = (): HTMLButtonElement | undefined => [...target.querySelectorAll('button')]
			.find((b) => [tf('bulk.preview.show_unchanged_one', { n: '1' }), tf('bulk.preview.show_unchanged_targets_one', { n: '1' })].includes(b.textContent?.trim() ?? ''));
		run = makeRun({ total: 25, changes: { update: 24, create: 0, delete: 0, unchanged: 1, invalid: 0 }, judgeOutliers: { decided: 25, measured: true, flagged: [],
			spread: [{ kind: 'link', count: 3, hosts: ['a.example'], seqs: [3, 5, 7] }] } });
		targets = many(25).map((x) => (x.seq === 7 ? { ...x, change: 'unchanged' as const, diff: { kind: 'none' } as BulkTarget['diff'] } : x));
		await render();
		expect(unchangedButton()).toBeDefined();
		buttonByText(tf('bulk.outliers.spread.show', { n: '3' }))!.click();
		await settle();
		expect(rowNames()).toHaveLength(2);
		expect(target.querySelector('[data-testid="bulk-outlier-filtered"]')?.textContent).toBe(`${tf('bulk.outliers.filtered.link', { n: '2' })} ${t('bulk.outliers.spread.show_all')}`);
		expect(unchangedButton()).toBeUndefined();
		(target.querySelector('[data-testid="bulk-outlier-filtered-all"]') as HTMLButtonElement).click();
		await settle();
		expect(unchangedButton()).toBeDefined();
	});

	it('drops the filter once the run is no longer one to approve', async () => {
		const judgedRun = (id: string, phase: BulkRunDetailData['phase']) => makeRun({ id, phase, total: 25, changes: changes(25), judgeOutliers: { decided: 25, measured: true, flagged: [],
			spread: [{ kind: 'link', count: 3, hosts: ['a.example'], seqs: [3, 5, 7] }] } });
		run = judgedRun('r1', 'previewed');
		runsById['r2'] = judgedRun('r2', 'previewed');
		targets = many(25);
		const { default: BulkRunDetail } = await import('./BulkRunDetail.svelte');
		const props = $state({ runId: 'r1', onBack: () => {}, onOpen: () => {} });
		component = mount(BulkRunDetail, { target, props });
		await settle();
		buttonByText(tf('bulk.outliers.spread.show', { n: '3' }))!.click();
		await settle();
		expect(target.querySelector('[data-testid="bulk-outlier-filtered"]')).not.toBeNull();
		props.runId = 'r2';
		await settle();
		runsById['r1'] = judgedRun('r1', 'approved');
		props.runId = 'r1';
		await settle();
		expect(target.querySelector('[data-testid="bulk-outlier-filtered"]')).toBeNull();
	});

	it('counts every verdict of the run at the approval, whether or not the unchanged rows are shown', async () => {
		const note = (): string | null | undefined => target.querySelector('[data-testid="bulk-approve-filtered"]')?.textContent;
		run = makeRun({ total: 25, changes: { update: 24, create: 0, delete: 0, unchanged: 1, invalid: 0 }, judgeOutliers: { decided: 25, measured: true, flagged: [],
			spread: [{ kind: 'link', count: 3, hosts: ['a.example'], seqs: [3, 5, 7] }] } });
		targets = many(25).map((x) => (x.seq === 9 ? { ...x, change: 'unchanged' as const, diff: { kind: 'none' } as BulkTarget['diff'] } : x));
		await render();
		buttonByText(tf('bulk.outliers.spread.show', { n: '3' }))!.click();
		await settle();
		expect(note()).toBe(`${tf('bulk.approve.filtered', { n: '3', m: '25' })} ${t('bulk.outliers.spread.show_all')}`);
		(target.querySelector('[data-testid="bulk-approve-filtered-all"]') as HTMLButtonElement).click();
		await settle();
		[...target.querySelectorAll('button')].find((x) => [t('bulk.preview.show_unchanged_one'), t('bulk.preview.show_unchanged_targets_one')].includes(x.textContent?.trim() ?? ''))!.click();
		await settle();
		expect(rowNames()).toHaveLength(25);
		await settle();
		buttonByText(tf('bulk.outliers.spread.show', { n: '3' }))!.click();
		await settle();
		expect(note()).toBe(`${tf('bulk.approve.filtered', { n: '3', m: '25' })} ${t('bulk.outliers.spread.show_all')}`);
	});

	it('says nothing at the approval when the filtered table shows every verdict', async () => {
		run = makeRun({ total: 3, changes: changes(3), writeForm: 'unmeasured', judgeOutliers: { decided: 3, measured: false, flagged: [],
			spread: [{ kind: 'link', count: 3, hosts: ['a.example'], seqs: [1, 2, 3] }] } });
		targets = many(3);
		await render();
		buttonByText(tf('bulk.outliers.spread.show', { n: '3' }))!.click();
		await settle();
		expect(target.querySelector('[data-testid="bulk-approve-filtered"]')).toBeNull();
	});

	it('puts the focus on the button of the line when the approve button cannot be pressed', async () => {
		run = makeRun({ total: 25, changes: changes(25), writeForm: 'unmeasured', judgeOutliers: { decided: 25, measured: true, flagged: [],
			spread: [{ kind: 'link', count: 3, hosts: ['a.example'], seqs: [3, 5, 7] }] } });
		targets = many(25);
		await render();
		buttonByText(tf('bulk.outliers.spread.show', { n: '3' }))!.click();
		await settle();
		(target.querySelector('[data-testid="bulk-approve-filtered-all"]') as HTMLButtonElement).click();
		await settle();
		expect(document.activeElement).toBe(target.querySelector('[data-testid="bulk-outlier-spread-show"]'));
	});

	it('offers no button on a line whose verdicts the server does not name, or names none of', async () => {
		run = makeRun({ total: 25, changes: changes(25), judgeOutliers: { decided: 25, measured: true, flagged: [],
			spread: [{ kind: 'link', count: 20, hosts: ['a.example'] }, { kind: 'email', count: 20, hosts: ['b.example'], seqs: [] }] } });
		targets = many(25);
		await render();
		expect(spread()).toHaveLength(2);
		expect(target.querySelector('[data-testid="bulk-outlier-spread-show"]')).toBeNull();
	});

	it('shows the table of another run whole, without the line over it, after filtering this one', async () => {
		const judgedRun = (id: string) => makeRun({ id, total: 25, changes: changes(25), judgeOutliers: { decided: 25, measured: true, flagged: [],
			spread: [{ kind: 'link', count: 3, hosts: ['a.example'], seqs: [3, 5, 7] }] } });
		run = judgedRun('r1');
		runsById['r2'] = judgedRun('r2');
		targets = many(25);
		const { default: BulkRunDetail } = await import('./BulkRunDetail.svelte');
		const props = $state({ runId: 'r1', onBack: () => {}, onOpen: () => {} });
		component = mount(BulkRunDetail, { target, props });
		await settle();
		buttonByText(tf('bulk.outliers.spread.show', { n: '3' }))!.click();
		await settle();
		expect(rowNames()).toHaveLength(3);
		props.runId = 'r2';
		await settle();
		expect(target.querySelector('[data-testid="bulk-outlier-filtered"]')).toBeNull();
		expect(rowNames()).toHaveLength(25);
		expect(buttonByText(tf('bulk.outliers.spread.show', { n: '3' }))).toBeDefined();
	});

	it('shows no line and no mark where the run is not one to approve', async () => {
		run = makeRun({ phase: 'approved', total: 25, changes: changes(25), judgeOutliers: { decided: 25, measured: true, spread: [], flagged: [{ seq: 7, reasons: ['new_link'] }] } });
		targets = many(25);
		await render();
		expect(outlierCount()).toBeUndefined();
		expect(target.querySelector('[data-testid="bulk-outlier"]')).toBeNull();
	});
});
