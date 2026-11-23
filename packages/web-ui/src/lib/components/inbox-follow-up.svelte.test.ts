import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setLocale, getLocale } from '../i18n.svelte.js';
import { resetSettingsViewer } from '../stores/settings-viewer.svelte.js';

// An open item whose thread got mail after its own: the list row says so in place of nothing (the
// raised line wins), a label that stands for the row puts it before the first mail's words, and
// the reading pane says from whom and when, with a jump to the new mail in the thread history.

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

const LATEST_ROW = 'itm_new';
const ONE = { count: 1, latestAt: '2026-11-04T09:00:00.000Z', latestFromName: 'Kundin Muster', latestMessageId: LATEST_ROW };

function item(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: 'inb_1', tenantId: 'default', accountId: 'info', channel: 'email', threadKey: 't1', bucket: 'requires_user',
		confidence: 0.9, reasonDe: 'Kundin fragt nach der Lieferung', classifiedAt: '2026-11-04T09:00:00Z', classifierVersion: 'v1',
		unsnoozeOnReply: true, fromAddress: 'kunde@example.com', fromName: 'Kundin Muster', subject: 'Lieferung',
		mailDate: '2026-11-04T09:00:00Z', messageId: '<first@x>', ruleWithheld: null, ...over,
	};
}

const THREAD = {
	messages: [
		{ id: LATEST_ROW, messageId: '<follow@x>', fromAddress: 'kunde@example.com', fromName: 'Kundin Muster', subject: 'Re: Lieferung', snippet: 'Immer noch nicht da.', mailDate: '2026-11-04T09:00:00.000Z', direction: 'inbound', fetchedAt: '2026-11-04T09:00:01.000Z' },
		{ id: 'itm_first', messageId: '<first@x>', fromAddress: 'kunde@example.com', fromName: 'Kundin Muster', subject: 'Lieferung', snippet: 'Wo bleibt sie?', mailDate: '2026-11-03T08:00:00.000Z', direction: 'inbound', fetchedAt: '2026-11-03T08:00:01.000Z' },
	],
	partial: false,
};

function date(iso: string): string {
	const locale = getLocale() === 'de' ? 'de-CH' : 'en-US';
	return new Date(iso).toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

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

describe('InboxReadingPane — the notice above the item own mail', () => {
	it('one follow-up, DE: from whom and when, and that the entry was not sorted again', async () => {
		await renderPane(item({ followUps: ONE }));
		expect(byTestId('inbox-follow-up-notice-text')?.textContent)
			.toBe(`Neue Nachricht von Kundin Muster · ${date(ONE.latestAt)}. lynox hat den Eintrag nicht neu eingeordnet.`);
		expect(byTestId('inbox-follow-up-jump')?.textContent?.trim()).toBe('Zur neuen Nachricht');
	});

	it('one follow-up, EN', async () => {
		setLocale('en');
		await renderPane(item({ followUps: ONE }));
		expect(byTestId('inbox-follow-up-notice-text')?.textContent)
			.toBe(`New message from Kundin Muster · ${date(ONE.latestAt)}. lynox did not sort this entry again.`);
		expect(byTestId('inbox-follow-up-jump')?.textContent?.trim()).toBe('Go to the new message');
	});

	it('several, the newest sensitive: the count, no name', async () => {
		await renderPane(item({ followUps: { ...ONE, count: 3, latestFromName: undefined } }));
		expect(byTestId('inbox-follow-up-notice-text')?.textContent)
			.toBe(`3 neue Nachrichten im Thread, die neueste gesendet am ${date(ONE.latestAt)}. lynox hat den Eintrag nicht neu eingeordnet.`);
	});

	it('one sensitive: no name', async () => {
		await renderPane(item({ followUps: { ...ONE, latestFromName: undefined } }));
		expect(byTestId('inbox-follow-up-notice-text')?.textContent)
			.toBe(`Neue Nachricht im Thread, gesendet am ${date(ONE.latestAt)}. lynox hat den Eintrag nicht neu eingeordnet.`);
	});

	it('several and one sensitive, EN', async () => {
		setLocale('en');
		await renderPane(item({ followUps: { ...ONE, count: 2, latestFromName: undefined } }));
		expect(byTestId('inbox-follow-up-notice-text')?.textContent)
			.toBe(`2 new messages in the thread, the latest sent ${date(ONE.latestAt)}. lynox did not sort this entry again.`);
	});

	it('the jump opens the new mail in the thread history and moves the focus to it', async () => {
		await renderPane(item({ followUps: ONE }));
		const row = target.querySelector<HTMLElement>(`[data-thread-message-id="${LATEST_ROW}"]`)!;
		expect(row.querySelector('[aria-expanded]')?.getAttribute('aria-expanded')).toBe('false');
		byTestId('inbox-follow-up-jump')!.click();
		await settle();
		expect(row.querySelector('[aria-expanded]')?.getAttribute('aria-expanded')).toBe('true');
		expect(document.activeElement).toBe(row);
	});

	it('no jump when the new mail is not in the loaded history, and no notice without follow-ups', async () => {
		await renderPane(item({ followUps: { ...ONE, latestMessageId: 'itm_elsewhere' } }));
		expect(byTestId('inbox-follow-up-notice')).not.toBeNull();
		expect(byTestId('inbox-follow-up-jump')).toBeNull();
		if (component) unmount(component);
		component = undefined;
		(await import('../stores/inbox.svelte.js')).closeItem();
		await renderPane(item());
		expect(byTestId('inbox-follow-up-notice')).toBeNull();
	});
});

describe('InboxView — the row of an item with follow-ups', () => {
	it('shows the line, one and many, and none without follow-ups', async () => {
		await renderList([
			item({ id: 'inb_1', followUps: ONE }),
			item({ id: 'inb_2', threadKey: 't2', followUps: { ...ONE, count: 2 } }),
			item({ id: 'inb_3', threadKey: 't3' }),
		]);
		const lines = [...target.querySelectorAll('[data-testid="inbox-follow-up-line"]')].map((e) => e.textContent);
		expect(lines).toEqual(['Neue Nachricht im Thread', '2 neue Nachrichten im Thread']);
	});

	it('the raised line wins over the follow-up line', async () => {
		await renderList([item({ followUps: ONE, classifierVersion: 'sensitive-follow-up' })]);
		expect(byTestId('inbox-follow-up-line')).toBeNull();
		expect(target.textContent).toContain('Wieder hier: Eine neue Nachricht in diesem Verlauf hat vertraulichen Inhalt.');
	});

	it('without a subject, the open button label puts the line before the reason; the visible headline stays the reason', async () => {
		await renderList([item({ followUps: ONE, subject: '', snippet: undefined })]);
		const open = target.querySelector<HTMLButtonElement>('button[aria-label*="Kundin fragt"]')!;
		expect(open.getAttribute('aria-label')).toContain('Neue Nachricht im Thread · Kundin fragt nach der Lieferung');
		expect(open.querySelector('span.truncate')?.textContent).toBe('Kundin fragt nach der Lieferung');
		expect(byTestId('inbox-follow-up-line')?.textContent).toBe('Neue Nachricht im Thread');
	});

	it('without a subject, the headline title and the select box label put the line before the reason', async () => {
		await renderList([item({ followUps: ONE, subject: '  ', snippet: undefined })]);
		expect(target.querySelector('p[title]')?.getAttribute('title')).toBe('Neue Nachricht im Thread · Kundin fragt nach der Lieferung');
		const select = target.querySelector('[aria-label^="Auswählen: "]');
		expect(select?.getAttribute('aria-label')).toBe('Auswählen: Neue Nachricht im Thread · Kundin fragt nach der Lieferung');
	});

	it('without follow-ups, title and labels stay as they were', async () => {
		await renderList([item({ subject: '', snippet: undefined })]);
		expect(target.querySelector('p[title]')?.getAttribute('title')).toBe('Kundin fragt nach der Lieferung');
		expect(target.querySelector('[aria-label^="Auswählen: "]')?.getAttribute('aria-label')).toBe('Auswählen: Kundin fragt nach der Lieferung');
	});

	it('with a subject, the open button label still names the new mail first', async () => {
		await renderList([item({ followUps: ONE })]);
		const open = [...target.querySelectorAll<HTMLButtonElement>('button[aria-label]')].find((b) => b.getAttribute('aria-label')?.includes('Lieferung'))!;
		expect(open.getAttribute('aria-label')).toMatch(/: Neue Nachricht im Thread · Lieferung$/);
	});
});
