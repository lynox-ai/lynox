import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { readable } from 'svelte/store';
import { t, getLocale, setLocale } from '../i18n.svelte.js';
import { resetSettingsViewer } from '../stores/settings-viewer.svelte.js';
import { bulkVisibleText, type BulkRunDetailData, type BulkTarget } from './bulk-runs.js';

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

// Judging again after a halt goes on with the same rule: the owner sees it as at the first start,
// with a sentence that says it goes on.
describe('a judged run that judges again shows its rule as at the start', () => {
	const halted = (haltKey: string): Partial<BulkRunDetailData> => ({ ...judged, phase: 'planned', haltKey, haltReason: haltKey, checksum: null, total: 1, costCapUsd: 1 });

	it('shows the rule and the start sentence where the owner judges again after a halt', async () => {
		await render(halted('unavailable'));
		expect(target.querySelector('[data-testid="bulk-restart-rule"]')?.textContent).toContain(RULE);
		expect(drafted()).toEqual([t('bulk.restart.rule_drafted')]);
		expect(target.textContent).toContain(t('bulk.restart.judge'));
	});

	it('shows them too where judging again needs a higher cost cap', async () => {
		await render(halted('costCap'));
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

	it('reads in English as approved where judging goes on', async () => {
		setLocale('en');
		await render(halted('unavailable'));
		expect(drafted()).toEqual(['lynox wrote this rule. Check that it says what you want before you continue judging.']);
	});

	it('control: a judged run whose rule did not reach the page shows no empty box', async () => {
		await render({ ...halted('unavailable'), judgeRule: null });
		expect(target.textContent).toContain(t('bulk.restart.judge'));
		expect(target.querySelector('[data-testid="bulk-restart-rule"]')).toBeNull();
	});
});

// The agent writes the rule, up to the engine's 4000 characters and possibly from data it read. At
// each of the three places the rule sits in one box of bounded height that scrolls on its own, so a
// long rule with many empty lines leaves the sentence under it and the preview or the button after
// it in the page; a word without spaces breaks inside the box. The whole rule stays in the box. While
// lines lie below the box's edge, a fade and a button under the box say how many (U-416): a rule
// cannot hide its real instruction under empty lines from an owner who never scrolls.
describe('a long rule stays in a bounded box at every place it is shown', () => {
	const LONG = (`${'W'.repeat(300)}\n` + 'Regel\n\n\n\n\n'.repeat(700)).slice(0, 4000);
	const longRule = { ...judged.judgeRule!, rule: LONG } as BulkRunDetailData['judgeRule'];
	const FOLLOWING = Node.DOCUMENT_POSITION_FOLLOWING;
	const LONG_LINES = bulkVisibleText(LONG).split('\n').length;

	// jsdom lays nothing out, so the layout is given here: the box is 192 pixels high, each rule line
	// 20 (the fallback line height, as jsdom computes none), stacked from the box's top and moved up
	// by its scroll. Nine lines are then wholly in view, and the tenth is cut at the edge.
	const BOX = 192;
	const LINE = 20;
	const scrollTops = new WeakMap<Element, number>();
	// Each line's place in its box, read once: a 4000-character rule has thousands of lines.
	const lineIndex = new WeakMap<Element, number>();
	const isBox = (el: Element): boolean => el.getAttribute('data-testid') === 'bulk-rule-box';
	const content = (el: Element): number => el.querySelectorAll('[data-rule-line]').length * LINE;
	const rect = (top: number, bottom: number): DOMRect => ({ top, bottom, left: 0, right: 0, x: 0, y: top, width: 0, height: bottom - top, toJSON: () => ({}) }) as DOMRect;
	const layout: Record<string, PropertyDescriptor> = {
		scrollHeight: { configurable: true, get(this: HTMLElement) { return isBox(this) ? content(this) : 0; } },
		clientHeight: { configurable: true, get(this: HTMLElement) { return isBox(this) ? Math.min(BOX, content(this)) : 0; } },
		scrollTop: {
			configurable: true,
			get(this: HTMLElement) { return scrollTops.get(this) ?? 0; },
			set(this: HTMLElement, v: number) { scrollTops.set(this, Math.max(0, Math.min(v, this.scrollHeight - this.clientHeight))); },
		},
		getBoundingClientRect: {
			configurable: true, writable: true,
			value(this: HTMLElement): DOMRect {
				if (isBox(this)) return rect(0, this.clientHeight);
				const owner = this.closest('[data-testid="bulk-rule-box"]');
				if (this.hasAttribute('data-rule-line') && owner) {
					if (!lineIndex.has(this)) owner.querySelectorAll('[data-rule-line]').forEach((l, n) => lineIndex.set(l, n));
					const i = lineIndex.get(this)!;
					const top = i * LINE - (owner as HTMLElement).scrollTop;
					return rect(top, top + LINE);
				}
				return rect(0, 0);
			},
		},
		scrollBy: {
			configurable: true, writable: true,
			value(this: HTMLElement, o: ScrollToOptions): void {
				this.scrollTop = this.scrollTop + (o.top ?? 0);
				this.dispatchEvent(new Event('scroll'));
			},
		},
	};
	const saved = new Map<string, PropertyDescriptor | undefined>();
	beforeEach(() => {
		for (const [name, d] of Object.entries(layout)) {
			saved.set(name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name) ?? Object.getOwnPropertyDescriptor(Element.prototype, name));
			Object.defineProperty(HTMLElement.prototype, name, d);
		}
	});
	afterEach(() => {
		for (const name of saved.keys()) delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
		saved.clear();
	});

	const readMore = (): HTMLButtonElement | null => target.querySelector('[data-testid="bulk-rule-read-more"]');
	const moreText = (n: number): string => (n === 1 ? t('bulk.rule_read_more_one') : t('bulk.rule_read_more').replace('{n}', String(n)));

	function boundedBox(place: string): Element {
		const box = target.querySelector(`[data-testid="${place}"] [data-testid="bulk-rule-box"]`);
		expect(box, place).not.toBeNull();
		const cls = box!.className.split(/\s+/);
		// Bounded height with its own scrolling, and a long word breaks inside the box.
		expect(cls).toEqual(expect.arrayContaining(['max-h-48', 'overflow-y-auto', '[overflow-wrap:anywhere]', 'whitespace-pre-wrap']));
		// The scrolling region can be reached and scrolled from the keyboard, and is named.
		expect(box!.getAttribute('role')).toBe('region');
		expect(box!.getAttribute('tabindex')).toBe('0');
		expect(box!.getAttribute('aria-label')).toBe(t('bulk.start.rule'));
		// The whole rule, every empty line kept.
		expect(LONG.length).toBe(4000);
		expect([...box!.querySelectorAll('[data-rule-line]')].map((l) => l.textContent).join('\n')).toBe(bulkVisibleText(LONG));
		// The lines below the edge are counted, and the fade and the button say so; the button's
		// name is its visible text, the arrow is not read out.
		const more = target.querySelector(`[data-testid="${place}"] [data-testid="bulk-rule-read-more"]`);
		expect(more, `${place} read-more button`).not.toBeNull();
		expect(more!.textContent).toBe(`${moreText(LONG_LINES - 9)} ↓`);
		expect(more!.getAttribute('aria-label')).toBeNull();
		expect(more!.querySelector('[aria-hidden="true"]')?.textContent).toBe('↓');
		expect(more!.className.split(/\s+/)).toContain('whitespace-nowrap');
		expect(target.querySelector(`[data-testid="${place}"] [data-testid="bulk-rule-fade"]`)).not.toBeNull();
		// The sentence that says lynox wrote it comes after the box and its button, inside the same place.
		const sentence = target.querySelector(`[data-testid="${place}"] [data-testid="bulk-rule-drafted"]`)!;
		expect(box!.compareDocumentPosition(more!) & FOLLOWING).toBeTruthy();
		expect(more!.compareDocumentPosition(sentence) & FOLLOWING).toBeTruthy();
		return box!;
	}
	const buttonAfter = (box: Element, label: string): boolean =>
		[...target.querySelectorAll('button')].some((b) => b.textContent?.trim() === label && (box.compareDocumentPosition(b) & FOLLOWING) !== 0);

	it('where the owner starts the judging, with the start button after it', async () => {
		await render({ ...atStart, judgeRule: longRule });
		const box = boundedBox('bulk-start-rule');
		expect(buttonAfter(box, t('bulk.start.judge'))).toBe(true);
	});

	it('where the owner approves, with the preview after it', async () => {
		await render({ ...judged, judgeRule: longRule });
		const box = boundedBox('bulk-approve-rule');
		expect(box.compareDocumentPosition(target.querySelector('table')!) & FOLLOWING).toBeTruthy();
	});

	it('where the owner judges again after a halt, with the button after it', async () => {
		await render({ ...judged, judgeRule: longRule, phase: 'planned', haltKey: 'unavailable', haltReason: 'unavailable', checksum: null, total: 1, costCapUsd: 1 });
		const box = boundedBox('bulk-restart-rule');
		expect(buttonAfter(box, t('bulk.restart.judge'))).toBe(true);
	});

	it('reads on by the box less one line, counts down, and goes away at the end', async () => {
		await render({ ...atStart, judgeRule: longRule });
		const box = target.querySelector<HTMLElement>('[data-testid="bulk-rule-box"]')!;
		readMore()!.click();
		// 192 less one line of 20: the tenth line, cut at the edge, now stands whole at the top.
		expect(box.scrollTop).toBe(BOX - LINE);
		await vi.waitFor(() => expect(readMore()?.textContent).toBe(`${moreText(LONG_LINES - 18)} ↓`));
		box.scrollTop = box.scrollHeight;
		box.dispatchEvent(new Event('scroll'));
		await vi.waitFor(() => expect(readMore()).toBeNull());
		expect(target.querySelector('[data-testid="bulk-rule-fade"]')).toBeNull();
	});

	it('names one hidden line in the singular, and reads in English', async () => {
		setLocale('en');
		await render({ ...atStart, judgeRule: { ...longRule!, rule: Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n') } });
		expect(readMore()?.textContent).toBe('Read 1 more line ↓');
		unmount(component!);
		component = undefined;
		await render({ ...atStart, judgeRule: longRule });
		expect(readMore()?.textContent).toBe(`Read ${LONG_LINES - 9} more lines ↓`);
	});

	it('control: a short rule that fits the box has no fade and no button', async () => {
		await render({ ...atStart });
		expect(target.querySelector('[data-testid="bulk-start-rule"] [data-testid="bulk-rule-box"]')).not.toBeNull();
		expect(readMore()).toBeNull();
		expect(target.querySelector('[data-testid="bulk-rule-fade"]')).toBeNull();
	});
});
