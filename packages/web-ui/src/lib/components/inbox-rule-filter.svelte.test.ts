import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { t, tf, setLocale, getLocale } from '../i18n.svelte.js';

// The inbox filtered to one rule's items ("Mail from this rule"), and the count of proposals
// waiting for confirmation next to the rules entry, on the rail (md+) and in the mobile pills.

const CLIENT_ENTRY = vi.hoisted(() => {
	const { createRequire: req } = require('node:module') as typeof import('node:module');
	const { dirname: dir, join: jn } = require('node:path') as typeof import('node:path');
	return jn(dir(req(import.meta.url).resolve('svelte/package.json')), 'src/index-client.js');
});
vi.mock('svelte', async () => import(/* @vite-ignore */ CLIENT_ENTRY));
vi.mock('./MarkdownRenderer.svelte', () => ({ default: () => {} }));
const pageUrl = vi.hoisted(() => ({ href: 'http://localhost/app/inbox' }));
vi.mock('$app/stores', async () => {
	const { readable } = await import('svelte/store');
	return { page: { subscribe: (run: (v: { url: URL }) => void) => readable({ url: new URL(pageUrl.href) }).subscribe(run) } };
});
const gotoSpy = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock('$app/navigation', () => ({ goto: async (...args: unknown[]) => { gotoSpy.calls.push(args); } }));
type SvelteClient = {
	mount: (c: unknown, o: { target: Element; props?: Record<string, unknown> }) => Record<string, unknown>;
	unmount: (c: Record<string, unknown>) => void;
	flushSync: () => void;
	tick: () => Promise<void>;
};
const { mount, unmount, flushSync, tick } = (await import(/* @vite-ignore */ CLIENT_ENTRY)) as SvelteClient;

let target: HTMLElement;
let component: Record<string, unknown> | undefined;
const localeBefore = getLocale();
/** Every GET of the items list, as its query. */
let itemQueries: URLSearchParams[];

beforeEach(() => {
	setLocale('de');
	itemQueries = [];
	gotoSpy.calls = [];
	pageUrl.href = 'http://localhost/app/inbox';
	target = document.createElement('div');
	document.body.appendChild(target);
});

afterEach(() => {
	if (component) unmount(component);
	component = undefined;
	target.remove();
	vi.unstubAllGlobals();
	setLocale(localeBefore);
});

async function settle(): Promise<void> {
	for (let i = 0; i < 12; i++) {
		await new Promise((r) => setTimeout(r, 0));
		await tick();
		flushSync();
	}
}

const filed = {
	id: 'inb_1', tenantId: 'default', accountId: 'info', channel: 'email', threadKey: 't1', bucket: 'auto_handled',
	confidence: 1, reasonDe: 'Regel: Newsletter', classifiedAt: '2026-11-05T08:00:00Z', classifierVersion: 'rule:rul_c1',
	unsnoozeOnReply: true, fromAddress: 'news@shop.example', subject: 'Unser Herbst-Newsletter', matchedRuleId: 'rul_c1', ruleWithheld: null,
};

interface Answers {
	rulesPending?: number;
	/** Read on every counts request, so a test can change them between loads. */
	counts?: { requires_user: number; draft_ready: number; auto_handled: number };
	items?: unknown[];
	rules?: unknown[];
}

async function render(a: Answers = {}): Promise<void> {
	vi.stubGlobal('fetch', vi.fn(async (url: string) => {
		const u = new URL(String(url), 'http://localhost');
		if (u.pathname.endsWith('/inbox/counts')) return Response.json({ counts: { ...(a.counts ?? { requires_user: 0, draft_ready: 0, auto_handled: 1 }) }, snoozed: 0, rulesPending: a.rulesPending ?? 0 });
		if (u.pathname.endsWith('/inbox/items')) {
			itemQueries.push(u.searchParams);
			return Response.json({ items: u.searchParams.get('ruleId') === null || a.items === undefined ? [filed] : a.items });
		}
		if (u.pathname.endsWith('/inbox/rules')) return Response.json({ rules: a.rules ?? [] });
		if (u.pathname.endsWith('/inbox/cold-start')) return Response.json({ active: [], recent: [] });
		if (u.pathname.includes('/inbox/undo/')) return Response.json({ undone: 1 });
		return Response.json({}, { status: 404 });
	}));
	const { default: View } = await import('./InboxView.svelte');
	component = mount(View, { target });
	await settle();
}

function byTestId(id: string): HTMLElement | null {
	return target.querySelector(`[data-testid="${id}"]`);
}

describe('InboxView — filtered to one rule', () => {
	const rule = { id: 'rul_c1', tenantId: 'default', accountId: 'info', matcherKind: 'from', matcherValue: 'news@shop.example', bucket: 'auto_handled', action: 'archive', source: 'on_demand', createdAt: '2026-10-01T00:00:00Z', name: 'Newsletter', confirmedAt: '2026-10-01T00:00:00Z' };

	it('asks for the rule\'s items in the bucket it files into and names the rule in the chip', async () => {
		pageUrl.href = 'http://localhost/app/inbox?ruleId=rul_c1&accountId=info&zone=auto_handled';
		await render({ rules: [rule] });
		const last = itemQueries.at(-1)!;
		expect(last.get('ruleId')).toBe('rul_c1');
		expect(last.get('bucket')).toBe('auto_handled');
		expect(byTestId('inbox-rule-filter')?.textContent).toContain(tf('inbox.rule_filter_chip', { name: 'Newsletter' }));
		expect(byTestId('inbox-rule-filter')?.textContent).toContain('Regel: Newsletter');
		expect(target.textContent).toContain('Unser Herbst-Newsletter');
	});

	it('names the rule by its id while its name is not known', async () => {
		pageUrl.href = 'http://localhost/app/inbox?ruleId=rul_c1';
		await render();
		expect(byTestId('inbox-rule-filter')?.textContent).toContain('Regel: rul_c1');
	});

	it('says no mail of the rule is in the inbox when its list is empty, and offers no cold start', async () => {
		pageUrl.href = 'http://localhost/app/inbox?ruleId=rul_c1&accountId=info&zone=auto_handled';
		await render({ rules: [rule], items: [] });
		expect(target.textContent).toContain(t('inbox.rule_filter_empty'));
		expect(target.textContent).not.toContain(t('inbox.empty_handled'));
		expect(target.textContent).not.toContain(t('inbox.cold_start_trigger_button'));
	});

	it('clears the filter: all items again, the chip gone, the address without the rule', async () => {
		pageUrl.href = 'http://localhost/app/inbox?ruleId=rul_c1&accountId=info&zone=auto_handled';
		await render({ rules: [rule], items: [] });
		const clear = [...target.querySelectorAll('button')].find((b) => b.textContent?.trim() === t('inbox.rule_filter_clear'));
		clear!.click();
		await settle();
		expect(byTestId('inbox-rule-filter')).toBeNull();
		expect(itemQueries.at(-1)!.get('ruleId')).toBeNull();
		expect(target.textContent).toContain('Unser Herbst-Newsletter');
		expect(gotoSpy.calls.at(-1)?.[0]).toBe('/app/inbox');
	});

	it('clears the filter on the way to the snoozed list, which cannot be filtered by rule', async () => {
		pageUrl.href = 'http://localhost/app/inbox?ruleId=rul_c1&accountId=info&zone=auto_handled';
		await render({ rules: [rule] });
		expect(byTestId('inbox-rule-filter')).not.toBeNull();
		const snoozed = [...target.querySelectorAll('button')].find((b) => b.textContent?.includes(t('inbox.zone_snoozed')));
		snoozed!.click();
		await settle();
		expect(byTestId('inbox-rule-filter')).toBeNull();
		const store = await import('../stores/inbox.svelte.js');
		expect(store.getInboxRuleFilter()).toBeNull();
		const last = itemQueries.at(-1)!;
		expect(last.get('snoozedOnly')).toBe('true');
		expect(last.get('ruleId')).toBeNull();
		expect(gotoSpy.calls.at(-1)?.[0]).toBe('/app/inbox');
	});

	it('keeps the filter on a later load of the list, such as after an undo', async () => {
		pageUrl.href = 'http://localhost/app/inbox?ruleId=rul_c1&accountId=info&zone=auto_handled';
		await render({ rules: [rule] });
		const before = itemQueries.length;
		const store = await import('../stores/inbox.svelte.js');
		expect(await store.undoBulk('blk_1', 'auto_handled')).toBe(true);
		await settle();
		expect(itemQueries.length).toBeGreaterThan(before);
		const last = itemQueries.at(-1)!;
		expect(last.get('bucket')).toBe('auto_handled');
		expect(last.get('ruleId')).toBe('rul_c1');
		expect(byTestId('inbox-rule-filter')?.textContent).toContain('Regel: Newsletter');
	});

	it('ignores an id the server would refuse', async () => {
		pageUrl.href = 'http://localhost/app/inbox?ruleId=nope&zone=auto_handled';
		await render();
		expect(byTestId('inbox-rule-filter')).toBeNull();
		expect(itemQueries.every((q) => q.get('ruleId') === null)).toBe(true);
		// Without a filter the zone of the link does not apply either.
		expect(itemQueries.at(-1)!.get('bucket')).toBe('requires_user');
	});

	it('has no chip and no filter without a rule in the address', async () => {
		await render();
		expect(byTestId('inbox-rule-filter')).toBeNull();
		expect(itemQueries.every((q) => q.get('ruleId') === null)).toBe(true);
	});
});

describe('InboxView — waiting proposals next to the rules entry', () => {
	it('counts them on the rail and in the mobile pills, read as a sentence', async () => {
		await render({ rulesPending: 3 });
		expect(byTestId('rules-pending-badge')?.textContent?.trim()).toBe('3');
		const pill = byTestId('inbox-pill-rules') as HTMLAnchorElement | null;
		expect(pill?.getAttribute('href')).toBe('/app/inbox/rules');
		expect(pill?.textContent).toContain(t('inbox.rules_link'));
		expect(pill?.textContent).toContain('3');
		const spoken = [...target.querySelectorAll('.sr-only')].map((e) => e.textContent?.trim());
		expect(spoken.filter((s) => s === '3 Vorschläge warten auf Bestätigung')).toHaveLength(2);
	});

	it('says one in the singular', async () => {
		await render({ rulesPending: 1 });
		const spoken = [...target.querySelectorAll('.sr-only')].map((e) => e.textContent?.trim());
		expect(spoken.filter((s) => s === t('inbox.rules_pending_count_one'))).toHaveLength(2);
	});

	// jsdom does no layout, so the overlap seen at 390 px cannot be measured here. What can be
	// held is its cause: in a scrolling row every child must keep its width, or the flex row
	// squeezes it below its content and the next child is drawn over it.
	it('keeps every child of the scrolling mobile row at its own width', async () => {
		await render({ rulesPending: 2 });
		const row = byTestId('inbox-pill-rules')?.parentElement;
		expect(row?.className).toContain('overflow-x-auto');
		const children = [...(row?.children ?? [])];
		expect(children.map((c) => c.getAttribute('role') ?? c.getAttribute('data-testid'))).toEqual(['tablist', 'inbox-pill-rules']);
		for (const child of children) expect(child.classList.contains('shrink-0')).toBe(true);
	});

	it('shows no count while none waits, and the pill still leads to the rules', async () => {
		await render({ rulesPending: 0 });
		expect(byTestId('rules-pending-badge')).toBeNull();
		expect(byTestId('inbox-pill-rules')?.getAttribute('href')).toBe('/app/inbox/rules');
		expect(target.querySelectorAll('.sr-only').length).toBe(0);
	});
});

describe('InboxView — the mobile zone pills keep the active one in view', () => {
	// jsdom does no layout. A small one stands in: the row is 390 px wide with 16 px padding, a pill
	// is 8 px per character of its text (a count badge widens it) plus 24, 4 px apart. Only the row
	// scrolls, sideways (`scrollLeft`); nothing asks the page to scroll an element into view.
	const PAD = 16;
	const ROW_WIDTH = 390;
	const positions = new WeakMap<Element, number>();
	const descriptors = new Map<string, PropertyDescriptor | undefined>();
	let scrollIntoViewCalls: number;
	let originalScrollIntoView: typeof Element.prototype.scrollIntoView;

	const isPill = (el: Element): boolean => el.matches('[role="tablist"] > button[data-zone]');
	const isRow = (el: Element): boolean => el.querySelector(':scope > [data-testid="inbox-pill-rules"]') !== null;
	const pillWidth = (el: Element): number => 8 * (el.textContent ?? '').replace(/\s+/g, ' ').trim().length + 24;
	function pillLeft(el: Element): number {
		let left = PAD;
		for (let prev = el.previousElementSibling; prev !== null; prev = prev.previousElementSibling) left += pillWidth(prev) + 4;
		return left;
	}

	function stub(name: 'offsetLeft' | 'offsetWidth' | 'clientWidth' | 'scrollLeft', get: (el: HTMLElement) => number | undefined, set?: (el: HTMLElement, v: number) => void): void {
		const own = Object.getOwnPropertyDescriptor(HTMLElement.prototype, name);
		descriptors.set(name, own);
		const original = own ?? Object.getOwnPropertyDescriptor(Element.prototype, name);
		Object.defineProperty(HTMLElement.prototype, name, {
			configurable: true,
			get(this: HTMLElement) { return get(this) ?? (original?.get?.call(this) as number); },
			set(this: HTMLElement, v: number) { if (set !== undefined) set(this, v); else original?.set?.call(this, v); },
		});
	}

	beforeEach(() => {
		stub('offsetLeft', (el) => (isPill(el) ? pillLeft(el) : undefined));
		stub('offsetWidth', (el) => (isPill(el) ? pillWidth(el) : undefined));
		stub('clientWidth', (el) => (isRow(el) ? ROW_WIDTH : undefined));
		stub('scrollLeft', (el) => positions.get(el) ?? 0, (el, v) => { positions.set(el, v); });
		scrollIntoViewCalls = 0;
		originalScrollIntoView = Element.prototype.scrollIntoView;
		Element.prototype.scrollIntoView = function () { scrollIntoViewCalls++; };
	});
	afterEach(() => {
		for (const [name, own] of descriptors) {
			if (own !== undefined) Object.defineProperty(HTMLElement.prototype, name, own);
			else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
		}
		descriptors.clear();
		Element.prototype.scrollIntoView = originalScrollIntoView;
		expect(scrollIntoViewCalls).toBe(0);
	});

	function row(): HTMLElement {
		const r = byTestId('inbox-pill-rules')?.parentElement;
		expect(r?.className).toContain('overflow-x-auto');
		return r!;
	}
	function pill(zone: string): HTMLElement {
		return row().querySelector<HTMLElement>(`[data-zone="${zone}"]`)!;
	}
	/** True when the pill lies whole inside the row's visible part. */
	function fullyInView(zone: string): boolean {
		const p = pill(zone);
		return p.offsetLeft >= row().scrollLeft && p.offsetLeft + p.offsetWidth <= row().scrollLeft + ROW_WIDTH;
	}

	it('brings "Erledigt heute" into view on arrival from a rule, once the counts stand', async () => {
		pageUrl.href = 'http://localhost/app/inbox?ruleId=rul_c1&accountId=info&zone=auto_handled';
		await render();
		expect(pill('auto_handled').textContent).toContain('Erledigt heute');
		// The badge has arrived and widened the pill; without a scroll it would end past the edge.
		expect(pill('auto_handled').textContent).toContain('1');
		expect(pill('auto_handled').offsetLeft + pill('auto_handled').offsetWidth).toBeGreaterThan(ROW_WIDTH);
		expect(row().scrollLeft).toBeGreaterThan(0);
		expect(fullyInView('auto_handled')).toBe(true);
	});

	it('brings the new pill into view when the zone changes, in both directions', async () => {
		pageUrl.href = 'http://localhost/app/inbox?ruleId=rul_c1&accountId=info&zone=auto_handled';
		await render();
		const before = row().scrollLeft;
		pill('snoozed').click();
		await settle();
		expect(row().scrollLeft).toBeGreaterThan(before);
		expect(fullyInView('snoozed')).toBe(true);
		pill('requires_user').click();
		await settle();
		expect(row().scrollLeft).toBe(pill('requires_user').offsetLeft);
		expect(fullyInView('requires_user')).toBe(true);
	});

	it('leaves the row where it is when the counts change later', async () => {
		const counts = { requires_user: 0, draft_ready: 0, auto_handled: 1 };
		pageUrl.href = 'http://localhost/app/inbox?ruleId=rul_c1&accountId=info&zone=auto_handled';
		await render({ counts });
		// The owner swipes the row back to its start.
		row().scrollLeft = 0;
		counts.auto_handled = 12;
		counts.requires_user = 3;
		const store = await import('../stores/inbox.svelte.js');
		expect(await store.loadInboxCounts()).toBe(true);
		await settle();
		// The change reached the pills (positive control) ...
		expect(pill('auto_handled').textContent).toContain('12');
		expect(pill('requires_user').textContent).toContain('3');
		// ... and the row did not move.
		expect(row().scrollLeft).toBe(0);
	});

	it('waits for the web font before the first reveal, which widens the pills', async () => {
		let fontsIn: () => void = () => {};
		const ready = new Promise<void>((resolve) => { fontsIn = resolve; });
		Object.defineProperty(document, 'fonts', { configurable: true, value: { ready } });
		try {
			pageUrl.href = 'http://localhost/app/inbox?ruleId=rul_c1&accountId=info&zone=auto_handled';
			await render();
			expect(row().scrollLeft).toBe(0);
			fontsIn();
			await settle();
			expect(fullyInView('auto_handled')).toBe(true);
		} finally {
			delete (document as unknown as Record<string, unknown>)['fonts'];
		}
	});
});
