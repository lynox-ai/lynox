import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { resetSettingsViewer } from '../stores/settings-viewer.svelte.js';
import { setLocale } from '../i18n.svelte.js';

const CLIENT_ENTRY = join(dirname(createRequire(import.meta.url).resolve('svelte/package.json')), 'src/index-client.js');
type SvelteClient = {
	mount: (c: unknown, o: { target: Element }) => Record<string, unknown>;
	unmount: (c: Record<string, unknown>) => void;
	flushSync: () => void;
	tick: () => Promise<void>;
};
const { mount, unmount, flushSync, tick } = (await import(/* @vite-ignore */ CLIENT_ENTRY)) as SvelteClient;

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));

// An owner without web push learns that a store's access runs out in the app, before the end
// (U-391): a banner in the shell, one line per store with "Reconnect", and on Settings → APIs a
// line on the store's row. After the end the banner stays; the APIs row says "ended" as before.
// A mandate gets no banner, and on the APIs only the first sentence.

// Ends at noon UTC, so the day is the same in any time zone the test runs in; the dates are written
// out, not derived the way the page derives them.
const soonIso = '2099-01-20T12:00:00.000Z';
const SOON = { de: '20.01.2099', en: '20/01/2099' };
const pastIso = '2020-03-04T12:00:00.000Z';

/** A store as the engine sends it: `ended` from the engine, which the page also reads off the end. */
const shop = (id: string, host: string, at: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
	id, name: `Shop ${id}`, base_url: `https://${host}/admin/api`, description: '', auth: { type: 'oauth2' },
	oauth_grant: { state: 'connected' }, store_access_ends: { host, ended: at === pastIso, at }, ...over,
});

let target: HTMLElement;
let component: Record<string, unknown> | undefined;

const asked: string[] = [];
function serve(viewer: 'owner' | 'mandate' | null, profiles: unknown[], notices: unknown[] = []): void {
	asked.length = 0;
	vi.stubGlobal('fetch', vi.fn(async (url: string) => {
		asked.push(url);
		const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
		if (url.endsWith('/config')) return viewer === null ? new Response('', { status: 503 }) : json({ viewer });
		if (url.endsWith('/connections/records')) return json({ notices });
		return json({ profiles });
	}));
}

beforeEach(() => {
	resetSettingsViewer();
	target = document.createElement('div');
	document.body.appendChild(target);
});
afterEach(() => {
	if (component) unmount(component);
	component = undefined;
	target.remove();
	vi.unstubAllGlobals();
	setLocale('de');
});

async function render(which: 'banner' | 'apis'): Promise<void> {
	const { default: View } = which === 'banner' ? await import('./StoreAccessBanner.svelte') : await import('./ApiStoreView.svelte');
	component = mount(View, { target });
	for (let i = 0; i < 10; i++) {
		await new Promise((r) => setTimeout(r, 0));
		await tick();
		flushSync();
	}
}
const q = (id: string): HTMLElement | null => target.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const all = (id: string): HTMLElement[] => [...target.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
const text = (el: HTMLElement | null): string => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

describe('the shell banner of a store whose access runs out', () => {
	it('shows the owner one line per store before the end, the host in its box and "Reconnect", in German', async () => {
		setLocale('de');
		serve('owner', [shop('a', 'acme.myshopify.com', soonIso), shop('b', 'beta-shop.myshopify.com', soonIso), { id: 'crm', name: 'CRM', base_url: 'https://crm.example', description: '' }]);
		await render('banner');
		expect(all('store-access-line').map(text)).toEqual([
			`Der Zugang von lynox zum Shop acme.myshopify.com läuft am ${SOON.de} ab. Verbinde den Shop vorher neu, damit Läufe und Abfragen weiterlaufen. Erneut verbinden`,
			`Der Zugang von lynox zum Shop beta-shop.myshopify.com läuft am ${SOON.de} ab. Verbinde den Shop vorher neu, damit Läufe und Abfragen weiterlaufen. Erneut verbinden`,
		]);
		expect(all('store-access-host').map(text)).toEqual(['acme.myshopify.com', 'beta-shop.myshopify.com']);
		// A break only after a dot: `<wbr>` there and nowhere else, never at the hyphen.
		// Each piece unbreakable (a browser breaks after a hyphen otherwise), `<wbr>` between them.
		const W = (x: string): string => `<span class="whitespace-nowrap">${x}</span>`;
		expect(all('store-access-host').map((h) => h.innerHTML.replace(/<!---->/g, ''))).toEqual([
			`${W('acme.')}<wbr>${W('myshopify.')}<wbr>${W('com')}`,
			`${W('beta-shop.')}<wbr>${W('myshopify.')}<wbr>${W('com')}`,
		]);
		expect(all('store-access-host').every((h) => !h.className.includes('break-all'))).toBe(true);
		expect(all('store-access-reconnect').map((a) => (a.getAttribute('href') ?? '').replace(/^.*\/oauth\/connect\//, ''))).toEqual(['a', 'b']);
		expect(all('store-access-reconnect').every((a) => (a.getAttribute('href') ?? '').includes('/oauth/connect/'))).toBe(true);
		expect(all('store-access-reconnect').every((a) => a.hasAttribute('data-sveltekit-reload'))).toBe(true);
	});

	it('in English, and after the end it says the access could not be renewed', async () => {
		setLocale('en');
		// A refresh that ended before the end: the engine says `ended` with the end still ahead.
		serve('owner', [shop('a', 'acme.myshopify.com', soonIso), shop('b', 'beta-shop.myshopify.com', soonIso, { oauth_grant: { state: 'refresh-dead' }, store_access_ends: { host: 'beta-shop.myshopify.com', ended: true, at: soonIso } })]);
		await render('banner');
		expect(all('store-access-line').map(text)).toEqual([
			`lynox's access to the store acme.myshopify.com runs out on ${SOON.en}. Reconnect the store before then so runs and requests keep going. Reconnect`,
			'lynox could not renew its access to the store beta-shop.myshopify.com. Runs and requests to the store only work again once you reconnect it. Reconnect',
		]);
	});

	it('an end that passed while the grant still reads connected is an end too, in German, and so is a refresh ended without a known end', async () => {
		setLocale('de');
		const ENDED = (host: string): string => `lynox konnte den Zugang zum Shop ${host} nicht erneuern. Läufe und Abfragen an den Shop gehen erst wieder, wenn du ihn neu verbindest. Erneut verbinden`;
		serve('owner', [shop('a', 'acme.myshopify.com', pastIso, { store_access_ends: { host: 'acme.myshopify.com', at: pastIso } }), { id: 'b', name: 'B', base_url: 'https://b.myshopify.com', description: '', oauth_grant: { state: 'refresh-dead' }, store_access_ends: { host: 'b.myshopify.com', ended: true } }]);
		await render('banner');
		expect(all('store-access-line').map(text)).toEqual([ENDED('acme.myshopify.com'), ENDED('b.myshopify.com')]);
	});

	it('hides until the next load, and comes back on it', async () => {
		serve('owner', [shop('a', 'acme.myshopify.com', soonIso)]);
		await render('banner');
		q('store-access-dismiss')!.click();
		flushSync();
		expect(q('store-access-banner')).toBeNull();
		unmount(component!);
		component = undefined;
		await render('banner');
		expect(q('store-access-banner')).not.toBeNull();
	});

	it('shows a mandate nothing and does not ask for its profiles, shows nothing while no one named the session, and nothing where the engine told no end', async () => {
		serve('mandate', [shop('a', 'acme.myshopify.com', soonIso)]);
		await render('banner');
		expect(q('store-access-banner')).toBeNull();
		expect(asked.some((u) => u.endsWith('/api-profiles'))).toBe(false);
		unmount(component!);
		component = undefined;
		resetSettingsViewer();
		serve(null, [shop('a', 'acme.myshopify.com', soonIso)]);
		await render('banner');
		expect(asked.some((u) => u.endsWith('/api-profiles'))).toBe(true);
		expect(q('store-access-banner')).toBeNull();
		unmount(component!);
		component = undefined;
		resetSettingsViewer();
		serve('owner', [{ id: 'a', name: 'Shop', base_url: 'https://acme.myshopify.com', description: '', oauth_grant: { state: 'connected' } }, shop('b', '', soonIso), shop('c', 'x.myshopify.com', 'not a date'), { id: 'd', name: 'D', base_url: 'https://d.myshopify.com', description: '', store_access_ends: { host: 'd.myshopify.com' } }]);
		await render('banner');
		expect(q('store-access-banner')).toBeNull();
	});
});

describe('the store row on Settings → APIs before the end', () => {
	it('tells the owner the date and the way, with "Reconnect", in German and English', async () => {
		setLocale('de');
		serve('owner', [shop('a', 'acme.myshopify.com', soonIso)]);
		await render('apis');
		expect(text(q('api-access-ends-text'))).toBe(`Der Zugang von lynox zu diesem Shop läuft am ${SOON.de} ab. Verbinde ihn vorher neu, damit Läufe und Abfragen weiterlaufen.`);
		expect(text(q('api-reconnect'))).toBe('Erneut verbinden');
		unmount(component!);
		component = undefined;
		setLocale('en');
		await render('apis');
		expect(text(q('api-access-ends-text'))).toBe(`lynox's access to this store runs out on ${SOON.en}. Reconnect it before then so runs and requests keep going.`);
		expect(text(q('api-reconnect'))).toBe('Reconnect');
	});

	it('tells a mandate only the date, and that reconnecting is not its own', async () => {
		setLocale('de');
		serve('mandate', [shop('a', 'acme.myshopify.com', soonIso, { reader_may_connect: false })]);
		await render('apis');
		expect(text(q('api-access-ends-text'))).toBe(`Der Zugang von lynox zu diesem Shop läuft am ${SOON.de} ab.`);
		expect(q('api-reconnect')).toBeNull();
		expect(q('api-reconnect-not-yours')).not.toBeNull();
		unmount(component!);
		component = undefined;
		setLocale('en');
		await render('apis');
		expect(text(q('api-access-ends-text'))).toBe(`lynox's access to this store runs out on ${SOON.en}.`);
	});

	it('after the refresh ended the row says "ended" as before, once, without the line', async () => {
		serve('owner', [shop('a', 'acme.myshopify.com', soonIso, { oauth_grant: { state: 'refresh-dead' }, store_access_ends: { host: 'acme.myshopify.com', ended: true, at: soonIso } })]);
		await render('apis');
		expect(q('api-access-ends')).toBeNull();
		expect(all('api-access-ended').map(text)).toEqual(['lynox konnte den Zugang zu diesem Shop nicht erneuern.']);
		expect(all('api-reconnect')).toHaveLength(1);
	});

	it('an end passed while the grant still reads connected: the row says "ended" with "Reconnect"', async () => {
		serve('owner', [shop('a', 'acme.myshopify.com', pastIso)]);
		await render('apis');
		expect(all('api-access-ended').map(text)).toEqual(['lynox konnte den Zugang zu diesem Shop nicht erneuern.']);
		expect(text(q('api-reconnect'))).toBe('Erneut verbinden');
		expect(q('api-access-ends-text')).toBeNull();
	});

	it('a store connected again while an erasure stands: the end beside the erasure dates', async () => {
		const notice = { recordId: 1, connectionId: 'a', revokedAt: '2099-01-01T12:00:00.000Z', holdUntil: '2099-01-15T12:00:00.000Z', deadline: '2099-01-31T12:00:00.000Z', reconnected: false };
		serve('owner', [shop('a', 'acme.myshopify.com', soonIso)], [notice]);
		await render('apis');
		expect(q('api-erasure-window')).not.toBeNull();
		expect(text(q('api-access-ends-text'))).toBe(`Der Zugang von lynox zu diesem Shop läuft am ${SOON.de} ab. Verbinde ihn vorher neu, damit Läufe und Abfragen weiterlaufen.`);
	});

	it('a mandate that set the store up gets "Reconnect" under the first sentence', async () => {
		serve('mandate', [shop('a', 'acme.myshopify.com', soonIso, { reader_may_connect: true })]);
		await render('apis');
		expect(text(q('api-access-ends-text'))).toBe(`Der Zugang von lynox zu diesem Shop läuft am ${SOON.de} ab.`);
		expect(text(q('api-reconnect'))).toBe('Erneut verbinden');
		expect(q('api-reconnect-not-yours')).toBeNull();
	});
});
