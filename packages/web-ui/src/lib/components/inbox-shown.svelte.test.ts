import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setLocale, getLocale } from '../i18n.svelte.js';
import { resetSettingsViewer } from '../stores/settings-viewer.svelte.js';

// An item a delivery failure notice created, with a real mail after it: the list row names the
// mail the API sends as `shown` (headline, sender, date, labels), every value from that one mail,
// and the confidential mark with the address only when that mail is sensitive.

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

const SHOWN = { fromAddress: 'anna@kunde.example', fromName: 'Anna Kunde', subject: 'Frage zur Offerte', messageId: '<real@x>', mailDate: '2026-11-22T10:00:00.000Z', sensitive: false };

function notice(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: 'inb_1', tenantId: 'default', accountId: 'info', channel: 'email', threadKey: 't1', bucket: 'requires_user',
		confidence: 1, reasonDe: 'Meldet, dass eine deiner Mails nicht ankam.', classifiedAt: '2026-11-20T09:00:01Z', classifierVersion: 'prefilter',
		unsnoozeOnReply: false, fromAddress: 'mailer-daemon@post.example', fromName: 'Mail Delivery System', subject: 'Undelivered Mail Returned to Sender',
		mailDate: '2026-11-20T09:00:00Z', messageId: '<notice@x>', ruleWithheld: null, prefilterRule: 'bounce', ...over,
	};
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

function row(): HTMLElement {
	return target.querySelector<HTMLElement>('[data-inbox-item-id="inb_1"]')!;
}

describe('InboxView — the row of a notice item with a shown mail', () => {
	it('headline, sender, titles and labels name the shown mail, none names the notice', async () => {
		await renderList([notice({ shown: SHOWN, followUps: { count: 1, latestAt: SHOWN.mailDate, latestFromName: 'Anna Kunde', latestMessageId: 'tm_1' } })]);
		const r = row();
		const headline = r.querySelector('p[title]')!;
		const sender = r.querySelector('span.truncate[title]')!;
		const open = r.querySelector<HTMLButtonElement>('button[aria-label]')!;
		const select = r.querySelector('[aria-label^="Auswählen: "]')!;
		expect({
			headline: headline.querySelector('span.truncate')?.textContent, headlineTitle: headline.getAttribute('title'),
			sender: sender.textContent?.trim(), senderTitle: sender.getAttribute('title'),
			open: open.getAttribute('aria-label'), select: select.getAttribute('aria-label'),
		}).toEqual({
			headline: 'Frage zur Offerte', headlineTitle: 'Frage zur Offerte',
			sender: 'Anna Kunde', senderTitle: 'anna@kunde.example',
			open: 'E-Mail öffnen: Frage zur Offerte', select: 'Auswählen: Frage zur Offerte',
		});
		expect(r.textContent).not.toContain('Undelivered');
		expect(r.textContent).not.toContain('Mail Delivery System');
		// The row's date is the shown mail's (the notice is a day earlier in this locale's short form).
		const day = (iso: string) => new Date(iso).toLocaleDateString('de-CH', { month: 'short', day: 'numeric' });
		expect(r.querySelector('span.tabular-nums')?.textContent?.trim()).toBe(day('2026-11-22T10:00:00.000Z'));
		// The one follow-up is the mail the row shows: no line repeats it.
		expect(byTestId('inbox-follow-up-line')).toBeNull();
		expect(r.querySelector('[aria-label="Vertraulicher Inhalt"]')).toBeNull();
	});

	it('a sensitive shown mail: the address without a name, the confidential mark as subject and as mark', async () => {
		await renderList([notice({ shown: { fromAddress: 'bank@bank.example', messageId: '<real@x>', mailDate: SHOWN.mailDate, sensitive: true } })]);
		const r = row();
		expect(r.querySelector('p[title] span.truncate')?.textContent).toBe('Vertraulicher Inhalt');
		expect(r.querySelector('span.truncate[title]')?.textContent?.trim()).toBe('bank@bank.example');
		expect(r.querySelector('[role="img"][aria-label="Vertraulicher Inhalt"]')).not.toBeNull();
		expect(r.textContent).not.toContain('Undelivered');
	});

	it('several follow-ups: the line still counts them', async () => {
		await renderList([notice({ shown: SHOWN, followUps: { count: 2, latestAt: SHOWN.mailDate, latestFromName: 'Anna Kunde', latestMessageId: 'tm_2' } })]);
		expect(byTestId('inbox-follow-up-line')?.textContent).toBe('2 neue Nachrichten im Thread');
	});

	it('without a shown mail the row is the notice, as before', async () => {
		await renderList([notice()]);
		const r = row();
		expect(r.querySelector('p[title] span.truncate')?.textContent).toBe('Undelivered Mail Returned to Sender');
		expect(r.querySelector('span.truncate[title]')?.textContent?.trim()).toBe('Mail Delivery System');
	});
});
