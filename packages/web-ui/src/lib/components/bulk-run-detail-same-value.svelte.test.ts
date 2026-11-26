import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { t, tf } from '../i18n.svelte.js';
import { resetSettingsViewer } from '../stores/settings-viewer.svelte.js';
import type { BulkRunDetailData, BulkTarget } from './bulk-runs.js';
import { bulkChoiceFields, bulkSameValueOthers } from './bulk-runs.js';

// A judge can give different products one new value: three products got one SEO title in a
// preview, and each row showed alone. The preview now marks every target whose new value in a
// field another target also gets, and says above the list how many there are. On a run without a
// judge, a field in which every target that writes it gets one value is the order („set every SEO
// title to …“), not a duplicate, and is not marked; a judged run has no such order.

const CLIENT_ENTRY = join(dirname(createRequire(import.meta.url).resolve('svelte/package.json')), 'src/index-client.js');
type SvelteClient = {
	mount: (c: unknown, o: { target: Element; props?: Record<string, unknown> }) => Record<string, unknown>;
	unmount: (c: Record<string, unknown>) => void;
	flushSync: () => void;
	tick: () => Promise<void>;
};
const { mount, unmount, flushSync, tick } = (await import(/* @vite-ignore */ CLIENT_ENTRY)) as SvelteClient;

const fields = (...f: [string, unknown][]): BulkTarget['diff'] =>
	({ kind: 'fields', fields: f.map(([field, after]) => ({ field, before: 'alt', after })) }) as BulkTarget['diff'];

function makeRun(o: Partial<BulkRunDetailData> = {}): BulkRunDetailData {
	return {
		id: 'r1', createdAt: '2026-11-14T07:50:00Z', targetSystem: 'http:demo.myshopify.com', phase: 'previewed', total: 4,
		changes: { update: 4, create: 0, delete: 0, unchanged: 0, invalid: 0 }, applied: 0, failed: 0, conflicts: 0, sentUnknown: 0, undone: 0,
		kind: 'apply', atomic: false, sourceRunId: null, writeMethod: null, probeConfirmed: false, writeForm: 'unmeasured', haltReason: null, haltKey: null,
		costUsd: 0, costCapUsd: null, judge: null, maxTargets: 4, failedOnce: 0, failureLimit: 0, resumeOpen: 0, resumeTries: 0, resumeSends: 0, deselected: 0,
		checksum: 'c1', writeFormNote: null, writeFormConfirmation: null, judgeModel: null, resumesAt: null, probe: null, undoable: 0,
		listFirstPage: null, listStartChecksum: null, listNote: null, listFilters: null, judgeRule: null, judgeRuleHash: null, judgeServedBy: null, judgeOwnKey: false,
		undoneBy: null,
		...o,
	};
}
const tgt = (seq: number, diff: BulkTarget['diff'], o: Partial<BulkTarget> = {}): BulkTarget =>
	({ seq, key: `gid://shopify/Product/${seq}`, change: 'update', diff, error: null, deselected: false, ...o }) as BulkTarget;

const SAME = 'Wasserstoff Gas kaufen';
let target: HTMLElement;
let component: Record<string, unknown> | undefined;
let run: BulkRunDetailData;
let targets: BulkTarget[];

beforeEach(() => {
	target = document.createElement('div');
	document.body.appendChild(target);
	resetSettingsViewer();
	run = makeRun();
	targets = [tgt(1, fields(['seo_title', SAME])), tgt(2, fields(['seo_title', SAME])), tgt(3, fields(['seo_title', SAME])), tgt(4, fields(['seo_title', 'Sauerstoff Gas']))];
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
	component = mount(BulkRunDetail, { target, props: { runId: 'r1', onBack: () => {}, onOpen: () => {} } });
	for (let i = 0; i < 10; i++) {
		await new Promise((r) => setTimeout(r, 0));
		await tick();
		flushSync();
	}
}

const rowOf = (seq: number): HTMLElement => {
	const rows = [...target.querySelectorAll('tbody tr')] as HTMLElement[];
	const row = rows.find((r) => r.textContent?.includes(tf('bulk.target.product', { n: String(seq) })));
	if (!row) throw new Error(`no row for target ${seq}`);
	return row;
};
const chipOf = (seq: number): string | null => rowOf(seq).querySelector('[data-testid="bulk-same-value"]')?.textContent ?? null;

describe('a preview where several targets get one new value', () => {
	it('marks each of three targets with the same value as the same as 2 others, and not the target with its own', async () => {
		await render();
		for (const seq of [1, 2, 3]) expect(chipOf(seq)).toBe('gleich wie bei 2 anderen');
		expect(chipOf(4)).toBeNull();
	});

	it('says the chip and the sentence in English', async () => {
		localStorage.setItem('lynox-locale', 'en');
		const { setLocale } = await import('../i18n.svelte.js');
		setLocale('en');
		try {
			await render();
			expect(chipOf(1)).toBe('same as 2 others');
			expect(target.querySelector('[data-testid="bulk-same-value-count"]')?.textContent).toBe('3 products get the same value as another product. They are marked in the preview.');
		} finally {
			setLocale('de');
			localStorage.removeItem('lynox-locale');
		}
	});

	it('names the number of products above the preview', async () => {
		await render();
		expect(target.querySelector('[data-testid="bulk-same-value-count"]')?.textContent).toBe('3 Produkte bekommen denselben Wert wie ein anderes Produkt. Sie sind in der Vorschau markiert.');
	});

	it('says "one other" for a pair', async () => {
		targets = [tgt(1, fields(['seo_title', SAME])), tgt(2, fields(['seo_title', SAME])), tgt(4, fields(['seo_title', 'Sauerstoff Gas']))];
		run = makeRun({ total: 3, maxTargets: 3 });
		await render();
		expect(chipOf(1)).toBe(t('bulk.target.same_value_one'));
		expect(chipOf(1)).toBe('gleich wie bei einem anderen');
	});

	it('names targets, not products, on a run that does not write a Shopify store', async () => {
		run = makeRun({ targetSystem: 'data_store' });
		targets = targets.map((x) => ({ ...x, key: `row-${x.seq}` }));
		await render();
		expect(target.querySelector('[data-testid="bulk-same-value-count"]')?.textContent).toBe(tf('bulk.preview.same_value_targets', { n: '3' }));
	});

	it('shows neither mark nor sentence when every value is its own', async () => {
		targets = [tgt(1, fields(['seo_title', 'A'])), tgt(2, fields(['seo_title', 'B']))];
		run = makeRun({ total: 2, maxTargets: 2 });
		await render();
		expect(target.querySelector('[data-testid="bulk-same-value"]')).toBeNull();
		expect(target.querySelector('[data-testid="bulk-same-value-count"]')).toBeNull();
	});

	it('shows neither mark nor sentence when every product gets the one value the run sets', async () => {
		targets = [1, 2, 3, 4].map((seq) => tgt(seq, fields(['seo_title', 'Direkt vom Hof'])));
		await render();
		expect(target.querySelector('[data-testid="bulk-same-value"]')).toBeNull();
		expect(target.querySelector('[data-testid="bulk-same-value-count"]')).toBeNull();
	});

	it('marks every target of a judged run that gives all of them one value', async () => {
		run = makeRun({ judge: { tier: 'standard', unjudged: 0 } });
		targets = [1, 2, 3, 4].map((seq) => tgt(seq, fields(['seo_title', SAME])));
		await render();
		for (const seq of [1, 2, 3, 4]) expect(chipOf(seq)).toBe('gleich wie bei 3 anderen');
		expect(target.querySelector('[data-testid="bulk-same-value-count"]')?.textContent).toBe('4 Produkte bekommen denselben Wert wie ein anderes Produkt. Sie sind in der Vorschau markiert.');
	});

	it('does not mark the common choice from a fixed list of a judged run, nor count it above the preview, and still marks a text two targets share', async () => {
		run = makeRun({
			judge: { tier: 'standard', unjudged: 0 },
			judgeRule: { rule: 'Ordne jedes Produkt einer Art zu und gib ihm einen Titel.', schema: { properties: { product_type: { type: 'string', enum: ['Shampoo', 'Spülung'] }, seo_title: { type: 'string', maxLength: 70 } } }, tier: 'standard' },
		});
		targets = [
			tgt(1, fields(['product_type', 'Shampoo'], ['seo_title', SAME])),
			tgt(2, fields(['product_type', 'Shampoo'], ['seo_title', SAME])),
			tgt(3, fields(['product_type', 'Shampoo'], ['seo_title', 'Sauerstoff Gas'])),
			tgt(4, fields(['product_type', 'Spülung'], ['seo_title', 'Stickstoff Gas'])),
		];
		await render();
		// The two that share a title are marked for the title alone, not as the same as 2 others for the choice.
		expect([1, 2, 3, 4].map(chipOf)).toEqual(['gleich wie bei einem anderen', 'gleich wie bei einem anderen', null, null]);
		expect(target.querySelector('[data-testid="bulk-same-value-count"]')?.textContent).toBe('2 Produkte bekommen denselben Wert wie ein anderes Produkt. Sie sind in der Vorschau markiert.');
	});

	it('does not mark a run that is past its preview', async () => {
		run = makeRun({ phase: 'done', applied: 4 });
		await render();
		expect(target.querySelector('[data-testid="bulk-same-value"]')).toBeNull();
		expect(target.querySelector('[data-testid="bulk-same-value-count"]')).toBeNull();
	});
});

// A run without a judge unless a test says otherwise.
const same = (ts: BulkTarget[], o: { judged?: boolean; choiceFields?: ReadonlySet<string> } = {}): Map<number, number> =>
	bulkSameValueOthers(ts, { judged: false, ...o });

describe('which targets share a value', () => {
	it('compares within one field only', () => {
		const m = same([tgt(1, fields(['seo_title', 'X'])), tgt(2, fields(['seo_description', 'X'])), tgt(3, fields(['seo_title', 'Y']))]);
		expect(m.size).toBe(0);
	});

	it('leaves out a target the owner took out, and one that writes nothing', () => {
		const m = same([
			tgt(1, fields(['seo_title', 'X'])),
			tgt(2, fields(['seo_title', 'X']), { deselected: true }),
			tgt(3, fields(['seo_title', 'X']), { change: 'unchanged' }),
			tgt(4, fields(['seo_title', 'X']), { change: 'invalid' }),
			tgt(7, fields(['seo_title', 'X']), { change: 'delete' }),
			tgt(5, fields(['seo_title', 'Y'])),
		]);
		expect(m.size).toBe(0);
		expect(same([tgt(1, fields(['seo_title', 'X'])), tgt(5, fields(['seo_title', 'X']), { change: 'create' }), tgt(6, fields(['seo_title', 'Y']))]).get(1)).toBe(1);
	});

	it('does not count empty or missing values as one value', () => {
		const m = same([tgt(1, fields(['seo_title', ''])), tgt(2, fields(['seo_title', ''])), tgt(3, fields(['seo_title', '  '])), tgt(4, fields(['seo_title', '  '])), tgt(5, fields(['seo_title', null])), tgt(6, fields(['seo_title', null]))]);
		expect(m.size).toBe(0);
	});

	it('gives a target that shares two fields its largest group', () => {
		const m = same([
			tgt(1, fields(['seo_description', 'D'], ['seo_title', 'T'])),
			tgt(2, fields(['seo_description', 'D'], ['seo_title', 'T'])),
			tgt(3, fields(['seo_description', 'D'])),
			tgt(4, fields(['seo_description', 'E'], ['seo_title', 'U'])),
		]);
		// The larger group (description, 3 targets) comes first; the smaller (title, 2) must not replace it.
		expect(m.get(1)).toBe(2);
		expect(m.get(2)).toBe(2);
		expect(m.get(3)).toBe(2);
	});

	it('marks an image\'s alt text like any other text', () => {
		expect(same([tgt(1, fields(['alt', 'Produktbild'])), tgt(2, fields(['alt', 'Produktbild'])), tgt(3, fields(['alt', 'Snowboard von vorn']))]).get(1)).toBe(1);
	});

	it('marks only text values, not a list, a number or a flag', () => {
		const other = {};
		const odd = (v: unknown): BulkTarget => tgt(9, fields(['f', v]));
		expect(same([tgt(1, fields(['f', ['a']])), tgt(2, fields(['f', ['a']])), odd(['b'])], other).size).toBe(0);
		expect(same([tgt(1, fields(['f', 5])), tgt(2, fields(['f', 5])), odd(6)], other).size).toBe(0);
		expect(same([tgt(1, fields(['f', true])), tgt(2, fields(['f', true])), odd(false)], other).size).toBe(0);
		expect(same([tgt(1, fields(['f', 'a'])), tgt(2, fields(['f', 'a'])), odd('b')], other).get(1)).toBe(1);
		// A target that writes no text there does not count toward „every target gets one value“.
		expect(same([tgt(1, fields(['f', 'a'])), tgt(2, fields(['f', 'a'])), odd(['b'])], other).size).toBe(0);
	});

	it('marks one value that every target of a judged run gets', () => {
		const all = [1, 2, 3].map((seq) => tgt(seq, fields(['seo_title', 'The Collection Snowboard online kaufen'])));
		expect(same(all).size).toBe(0);
		const m = same(all, { judged: true });
		expect([...m.entries()]).toEqual([[1, 2], [2, 2], [3, 2]]);
	});

	it('keeps a field whose name holds a NUL apart from another field and value', () => {
		const m = same([tgt(1, fields(['a\u0000b', 'c'])), tgt(2, fields(['a', 'b\u0000c']))]);
		expect(m.size).toBe(0);
	});

	it('compares the exact text', () => {
		expect(same([tgt(1, fields(['seo_title', 'Gas'])), tgt(2, fields(['seo_title', 'gas']))]).size).toBe(0);
	});

	it('does not mark one value that every writing target gets, and does mark it once one target differs', () => {
		const all = Array.from({ length: 17 }, (_, i) => tgt(i + 1, fields(['seo_title', 'Direkt vom Hof'])));
		expect(same(all).size).toBe(0);
		const oneDiffers = [...all.slice(0, 16), tgt(17, fields(['seo_title', 'Anders']))];
		const m = same(oneDiffers);
		expect(m.size).toBe(16);
		expect(m.get(1)).toBe(15);
		expect(m.has(17)).toBe(false);
	});

	it('counts a target that clears the field as writing it', () => {
		const m = same([tgt(1, fields(['seo_title', 'X'])), tgt(2, fields(['seo_title', 'X'])), tgt(3, fields(['seo_title', '']))]);
		expect(m.get(1)).toBe(1);
	});

	it('leaves the one differing target out of the writers once the owner took it out', () => {
		const m = same([tgt(1, fields(['seo_title', 'X'])), tgt(2, fields(['seo_title', 'X'])), tgt(3, fields(['seo_title', 'Y']), { deselected: true })]);
		expect(m.size).toBe(0);
	});

	it('marks a part group in one field while another field holds one value for all', () => {
		const m = same([
			tgt(1, fields(['seo_title', 'Hof'], ['seo_description', 'D'])),
			tgt(2, fields(['seo_title', 'Hof'], ['seo_description', 'D'])),
			tgt(3, fields(['seo_title', 'Hof'], ['seo_description', 'E'])),
		]);
		expect(m.get(1)).toBe(1);
		expect(m.get(2)).toBe(1);
		expect(m.has(3)).toBe(false);
	});

	it('does not count a field filled from a fixed list of choices, and counts the other fields as before', () => {
		const ts = [
			tgt(1, fields(['product_type', 'Shampoo'], ['seo_title', 'X'])),
			tgt(2, fields(['product_type', 'Shampoo'], ['seo_title', 'X'])),
			tgt(3, fields(['product_type', 'Shampoo'], ['seo_title', 'Y'])),
		];
		const m = same(ts, { judged: true, choiceFields: new Set(['product_type']) });
		expect([...m.entries()]).toEqual([[1, 1], [2, 1]]);
		// Without the choice field left out, all three share it.
		expect(same(ts, { judged: true }).get(3)).toBe(2);
	});
});

describe('which fields a judge fills from a fixed list', () => {
	it('names a text field with choices, and not a free text, a number or a run without a rule', () => {
		const schema = { properties: { product_type: { type: 'string', enum: ['Shampoo', 'Spülung'] }, seo_title: { type: 'string', maxLength: 70 }, rank: { type: 'number' }, empty: { type: 'string', enum: [] } } };
		expect([...bulkChoiceFields({ schema })]).toEqual(['product_type']);
		expect(bulkChoiceFields(null).size).toBe(0);
	});
});
