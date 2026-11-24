import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setLocale, getLocale, t } from '../i18n.svelte.js';
import { resetSettingsViewer } from '../stores/settings-viewer.svelte.js';
import { formatUsdIn } from '../format.js';

// The jump to a new message in the thread always shows where it went, and an empty row of a
// confidential message says why it is empty. The inbox list and reading pane speak the page's
// language and show values whole: the row's select label, its time, the reading pane's date and
// sender address, the zone pills' cut, the status bar's cost.

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
vi.mock('$app/navigation', () => ({ goto: async () => {} }));
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

beforeEach(() => {
	setLocale('de');
	resetSettingsViewer();
	pageUrl.href = 'http://localhost/app/inbox';
	target = document.createElement('div');
	document.body.appendChild(target);
});

afterEach(async () => {
	resetSettingsViewer();
	if (component) unmount(component);
	component = undefined;
	target.remove();
	(await import('../stores/inbox.svelte.js')).closeItem();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	setLocale(localeBefore);
});

async function settle(): Promise<void> {
	for (let i = 0; i < 12; i++) {
		await new Promise((r) => setTimeout(r, 0));
		await tick();
		flushSync();
	}
}

function byTestId(id: string): HTMLElement | null {
	return target.querySelector(`[data-testid="${id}"]`);
}

const CONF_ROW = 'itm_conf';
const ONE = { count: 1, latestAt: '2026-11-04T09:00:00.000Z', latestFromName: undefined, latestMessageId: CONF_ROW };

function item(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: 'inb_1', tenantId: 'default', accountId: 'info', channel: 'email', threadKey: 't1', bucket: 'requires_user',
		confidence: 0.9, reasonDe: 'Kundin fragt nach der Lieferung', classifiedAt: '2026-11-02T09:00:00Z', classifierVersion: 'v1',
		unsnoozeOnReply: true, fromAddress: 'kunde-service@muster-firma.example', fromName: 'Kundin Muster', subject: 'Lieferung',
		mailDate: '2026-11-04T09:00:00Z', messageId: '<first@x>', ruleWithheld: null, ...over,
	};
}

const THREAD = {
	messages: [
		{ id: CONF_ROW, messageId: '<conf@x>', fromAddress: 'kunde@example.com', subject: 'Re: Lieferung', mailDate: '2026-11-04T09:00:00.000Z', direction: 'inbound', fetchedAt: '2026-11-04T09:00:01.000Z', confidential: true },
		{ id: 'itm_empty', messageId: '<empty@x>', fromAddress: 'kunde@example.com', subject: 'Re: Lieferung', mailDate: '2026-11-03T09:00:00.000Z', direction: 'inbound', fetchedAt: '2026-11-03T09:00:01.000Z' },
		{ id: 'itm_first', messageId: '<first@x>', fromAddress: 'kunde@example.com', fromName: 'Kundin Muster', subject: 'Lieferung', snippet: 'Wo bleibt sie?', mailDate: '2026-11-02T08:00:00.000Z', direction: 'inbound', fetchedAt: '2026-11-02T08:00:01.000Z' },
	],
	partial: false,
};

async function renderPane(payload: Record<string, unknown>, thread: unknown = THREAD): Promise<void> {
	vi.stubGlobal('fetch', vi.fn(async (url: string) => {
		const path = String(url).split('?')[0]!;
		if (path.endsWith('/config')) return Response.json({ viewer: 'owner' });
		if (path.endsWith('/full')) return Response.json({ item: payload, body: { md: 'Hallo', source: 'cache' } });
		if (path.endsWith('/thread')) return Response.json(thread);
		return Response.json({ error: 'not found' }, { status: 404 });
	}));
	const store = await import('../stores/inbox.svelte.js');
	const { default: Pane } = await import('./InboxReadingPane.svelte');
	component = mount(Pane, { target });
	await store.openItem('inb_1');
	await settle();
}

async function renderList(items: unknown[]): Promise<void> {
	vi.stubGlobal('fetch', vi.fn(async (url: string) => {
		const u = new URL(String(url), 'http://localhost');
		if (u.pathname.endsWith('/inbox/counts')) return Response.json({ counts: { requires_user: items.length, draft_ready: 0, auto_handled: 0 }, snoozed: 0, rulesPending: 0 });
		if (u.pathname.endsWith('/inbox/items')) return Response.json({ items });
		if (u.pathname.endsWith('/inbox/rules')) return Response.json({ rules: [] });
		if (u.pathname.endsWith('/inbox/cold-start')) return Response.json({ active: [], recent: [] });
		return Response.json({}, { status: 404 });
	}));
	const { default: View } = await import('./InboxView.svelte');
	component = mount(View, { target });
	await settle();
}

function row(id: string): HTMLElement {
	return target.querySelector<HTMLElement>(`[data-thread-message-id="${id}"]`)!;
}

describe('the jump to a new message without content', () => {
	it('brings the message into view, focuses it and marks it after a mouse click, until the next click', async () => {
		const scrolled: Element[] = [];
		// The test DOM has no layout and no scrollIntoView: a stand-in records which element asked.
		const proto = Element.prototype as unknown as { scrollIntoView?: unknown };
		const had = Object.prototype.hasOwnProperty.call(proto, 'scrollIntoView');
		const before = proto.scrollIntoView;
		proto.scrollIntoView = function (this: Element): void { scrolled.push(this); };
		try {
			await renderPane(item({ followUps: ONE }));
			const target_ = row(CONF_ROW);
			expect(target_.getAttribute('data-jump-target')).toBeNull();
			byTestId('inbox-follow-up-jump')!.click();
			await settle();
			expect(scrolled).toContain(target_);
			expect(document.activeElement).toBe(target_);
			expect(target_.getAttribute('data-jump-target')).toBe('true');
			expect(target_.className).toContain('ring-2');
			document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
			await settle();
			expect(target_.getAttribute('data-jump-target')).toBeNull();
			expect(target_.className).not.toMatch(/(^| )ring-2( |$)/);
		} finally {
			if (had) proto.scrollIntoView = before;
			else delete proto.scrollIntoView;
		}
	});

	it('keeps the mark through the jump\'s own press and a touch, and drops it on a mouse press or when the focus leaves', async () => {
		const press = (type: string): void => {
			document.body.dispatchEvent(Object.assign(new Event('pointerdown', { bubbles: true }), { pointerType: type }));
		};
		await renderPane(item({ followUps: ONE }));
		const jump = byTestId('inbox-follow-up-jump')!;
		jump.dispatchEvent(Object.assign(new Event('pointerdown', { bubbles: true }), { pointerType: 'mouse' }));
		jump.click();
		await settle();
		expect(row(CONF_ROW).getAttribute('data-jump-target')).toBe('true');
		press('touch');
		await settle();
		expect(row(CONF_ROW).getAttribute('data-jump-target')).toBe('true');
		press('mouse');
		await settle();
		expect(row(CONF_ROW).getAttribute('data-jump-target')).toBeNull();
		jump.click();
		await settle();
		expect(row(CONF_ROW).getAttribute('data-jump-target')).toBe('true');
		row(CONF_ROW).blur();
		await settle();
		expect(row(CONF_ROW).getAttribute('data-jump-target')).toBeNull();
	});

	it('marks the message again on a second jump', async () => {
		await renderPane(item({ followUps: ONE }));
		byTestId('inbox-follow-up-jump')!.click();
		await settle();
		document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
		await settle();
		byTestId('inbox-follow-up-jump')!.click();
		await settle();
		expect(row(CONF_ROW).getAttribute('data-jump-target')).toBe('true');
	});
});

describe('an empty row in the thread history', () => {
	it('says why it is empty when the message is confidential, DE', async () => {
		await renderPane(item({ followUps: ONE }));
		expect(row(CONF_ROW).querySelector('[data-testid="inbox-thread-message-withheld"]')?.textContent)
			.toBe('Inhalt nicht angezeigt: Die Nachricht hat vertraulichen Inhalt.');
		expect(row('itm_empty').querySelector('[data-testid="inbox-thread-message-withheld"]')).toBeNull();
		expect(row('itm_first').querySelector('[data-testid="inbox-thread-message-withheld"]')).toBeNull();
	});

	it('says why it is empty when the message is confidential, EN', async () => {
		setLocale('en');
		await renderPane(item({ followUps: ONE }));
		expect(row(CONF_ROW).querySelector('[data-testid="inbox-thread-message-withheld"]')?.textContent)
			.toBe('Content not shown: this message has confidential content.');
	});
});

describe('the reading pane head', () => {
	it('dates the mail whose text stands below, not the follow-up that moved the item', async () => {
		setLocale('en');
		await renderPane(item({ followUps: ONE }));
		const d = new Date('2026-11-02T08:00:00.000Z').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
		expect(byTestId('inbox-reading-date')?.textContent).toBe(d);
	});

	it('keeps the sender address whole: it may break after a dot or @, never at a hyphen', async () => {
		await renderPane(item());
		const pieces = [...byTestId('inbox-reading-from-address')!.querySelectorAll(':scope > span')].map((s) => s.textContent);
		expect(pieces).toEqual(['<kunde-service@', 'muster-firma.', 'example>']);
	});
});

describe('the inbox list row', () => {
	function rowTime(iso: string): string {
		const d = new Date(iso);
		const locale = getLocale() === 'de' ? 'de-CH' : 'en-US';
		return d.toDateString() === new Date().toDateString()
			? d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
			: d.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
	}

	it('names the select box in the page language', async () => {
		setLocale('en');
		await renderList([item()]);
		expect(target.querySelector('[aria-label^="Select: "]')?.getAttribute('aria-label')).toBe('Select: Lieferung');
		expect(target.querySelector('[aria-label^="Auswählen"]')).toBeNull();
	});

	it('shows the time of the newest message where it announces one, else that of the item', async () => {
		await renderList([
			item({ id: 'inb_1', mailDate: '2026-10-01T09:00:00Z', followUps: { ...ONE, latestAt: '2026-10-20T15:00:00.000Z' } }),
			item({ id: 'inb_2', threadKey: 't2', mailDate: '2026-10-05T09:00:00Z' }),
			item({ id: 'inb_3', threadKey: 't3', mailDate: '2026-10-07T09:00:00Z', classifierVersion: 'sensitive-follow-up', followUps: { ...ONE, latestAt: '2026-10-21T15:00:00.000Z' } }),
		]);
		const times = [...target.querySelectorAll('[data-inbox-item-id] span.tabular-nums')].map((e) => e.textContent?.trim());
		// The third row shows the raised line, not the follow-up line: its own time stands.
		expect(times).toEqual([rowTime('2026-10-20T15:00:00.000Z'), rowTime('2026-10-05T09:00:00Z'), rowTime('2026-10-07T09:00:00Z')]);
	});

	it('names the sensitive mark in the page language, as an image', async () => {
		setLocale('en');
		await renderList([item({ classifierVersion: 'sensitive-prefilter' })]);
		const mark = target.querySelector('[role="img"][aria-label="Confidential content"]');
		expect(mark?.textContent).toBe('⚠');
	});

	it('marks the zone pills cut at an edge with a fade on that side only', async () => {
		await renderList([item()]);
		const strip = byTestId('inbox-zone-row')!;
		Object.defineProperty(strip, 'clientWidth', { configurable: true, value: 300 });
		Object.defineProperty(strip, 'scrollWidth', { configurable: true, value: 500 });
		strip.scrollLeft = 0;
		strip.dispatchEvent(new Event('scroll'));
		await settle();
		expect(byTestId('inbox-zone-row-cut-end')).not.toBeNull();
		expect(byTestId('inbox-zone-row-cut-start')).toBeNull();
		Object.defineProperty(strip, 'scrollLeft', { configurable: true, value: 200 });
		strip.dispatchEvent(new Event('scroll'));
		await settle();
		expect(byTestId('inbox-zone-row-cut-end')).toBeNull();
		expect(byTestId('inbox-zone-row-cut-start')).not.toBeNull();
	});
});

describe('words of the inbox in DE', () => {
	it('says Posteingang and zurückstellen, and EN keeps Inbox and Snooze', () => {
		setLocale('de');
		expect([t('nav.inbox'), t('inbox.title'), t('inbox.zone_snoozed'), t('inbox.action_snooze'), t('inbox.empty_snoozed'), t('inbox.snooze_cancel')])
			.toEqual(['Posteingang', 'Posteingang', 'Zurückgestellt', 'Zurückstellen', 'Nichts zurückgestellt.', 'Jetzt zurückholen']);
		setLocale('en');
		expect([t('nav.inbox'), t('inbox.action_snooze')]).toEqual(['Inbox', 'Snooze']);
	});
});

describe('the status bar cost', () => {
	it('keeps the dollar sign and writes the number in the page language', () => {
		const nb = (s: string): string => s.replace(/\u00A0/g, ' ');
		expect(nb(formatUsdIn(0.0076, 'de'))).toBe('0,0076 $');
		expect(formatUsdIn(0.0076, 'en')).toBe('$0.0076');
		expect(nb(formatUsdIn(0, 'de'))).toBe('0,00 $');
		expect(formatUsdIn(0, 'en')).toBe('$0.00');
		expect(nb(formatUsdIn(1.5, 'de'))).toBe('1,50 $');
		expect(formatUsdIn(1234.5, 'en')).toBe('$1,234.50');
	});
});
