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

const DAY = 24 * 3600 * 1000;
const soonIso = new Date(Date.now() + 10 * DAY).toISOString();
const pastIso = new Date(Date.now() - DAY).toISOString();
const de = (iso: string): string => new Date(iso).toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit', year: 'numeric' });
const en = (iso: string): string => new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });

const shop = (id: string, host: string, at: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
	id, name: `Shop ${id}`, base_url: `https://${host}/admin/api`, description: '', auth: { type: 'oauth2' },
	oauth_grant: { state: 'connected' }, store_access_ends: { host, at }, ...over,
});

let target: HTMLElement;
let component: Record<string, unknown> | undefined;

function serve(viewer: 'owner' | 'mandate', profiles: unknown[]): void {
	vi.stubGlobal('fetch', vi.fn(async (url: string) => {
		const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
		if (url.endsWith('/config')) return json({ viewer });
		if (url.endsWith('/connections/records')) return json({ notices: [] });
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
			`Der Zugang von lynox zum Shop acme.myshopify.com läuft am ${de(soonIso)} ab. Verbinde den Shop vorher neu, damit Läufe und Abfragen weiterlaufen. Erneut verbinden`,
			`Der Zugang von lynox zum Shop beta-shop.myshopify.com läuft am ${de(soonIso)} ab. Verbinde den Shop vorher neu, damit Läufe und Abfragen weiterlaufen. Erneut verbinden`,
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
		serve('owner', [shop('a', 'acme.myshopify.com', soonIso), shop('b', 'beta-shop.myshopify.com', pastIso, { oauth_grant: { state: 'refresh-dead' } })]);
		await render('banner');
		expect(all('store-access-line').map(text)).toEqual([
			`lynox's access to the store acme.myshopify.com runs out on ${en(soonIso)}. Reconnect the store before then so runs and requests keep going. Reconnect`,
			'lynox could not renew its access to the store beta-shop.myshopify.com. Runs and requests to the store only work again once you reconnect it. Reconnect',
		]);
	});

	it('an end that passed while the grant still reads connected is an end too, in German', async () => {
		setLocale('de');
		serve('owner', [shop('a', 'acme.myshopify.com', pastIso)]);
		await render('banner');
		expect(text(q('store-access-line'))).toBe('lynox konnte den Zugang zum Shop acme.myshopify.com nicht erneuern. Läufe und Abfragen an den Shop gehen erst wieder, wenn du ihn neu verbindest. Erneut verbinden');
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

	it('shows a mandate nothing, and nothing where the engine told no end', async () => {
		serve('mandate', [shop('a', 'acme.myshopify.com', soonIso)]);
		await render('banner');
		expect(q('store-access-banner')).toBeNull();
		unmount(component!);
		component = undefined;
		resetSettingsViewer();
		serve('owner', [{ id: 'a', name: 'Shop', base_url: 'https://acme.myshopify.com', description: '', oauth_grant: { state: 'connected' } }, shop('b', '', soonIso), shop('c', 'x.myshopify.com', 'not a date')]);
		await render('banner');
		expect(q('store-access-banner')).toBeNull();
	});
});

describe('the store row on Settings → APIs before the end', () => {
	it('tells the owner the date and the way, with "Reconnect", in German and English', async () => {
		setLocale('de');
		serve('owner', [shop('a', 'acme.myshopify.com', soonIso)]);
		await render('apis');
		expect(text(q('api-access-ends-text'))).toBe(`Der Zugang von lynox zu diesem Shop läuft am ${de(soonIso)} ab. Verbinde ihn vorher neu, damit Läufe und Abfragen weiterlaufen.`);
		expect(text(q('api-reconnect'))).toBe('Erneut verbinden');
		unmount(component!);
		component = undefined;
		setLocale('en');
		await render('apis');
		expect(text(q('api-access-ends-text'))).toBe(`lynox's access to this store runs out on ${en(soonIso)}. Reconnect it before then so runs and requests keep going.`);
		expect(text(q('api-reconnect'))).toBe('Reconnect');
	});

	it('tells a mandate only the date, and that reconnecting is not its own', async () => {
		setLocale('de');
		serve('mandate', [shop('a', 'acme.myshopify.com', soonIso, { reader_may_connect: false })]);
		await render('apis');
		expect(text(q('api-access-ends-text'))).toBe(`Der Zugang von lynox zu diesem Shop läuft am ${de(soonIso)} ab.`);
		expect(q('api-reconnect')).toBeNull();
		expect(q('api-reconnect-not-yours')).not.toBeNull();
		unmount(component!);
		component = undefined;
		setLocale('en');
		await render('apis');
		expect(text(q('api-access-ends-text'))).toBe(`lynox's access to this store runs out on ${en(soonIso)}.`);
	});

	it('after the end the row says "ended" as before, without the line', async () => {
		serve('owner', [shop('a', 'acme.myshopify.com', pastIso, { oauth_grant: { state: 'refresh-dead' } })]);
		await render('apis');
		expect(q('api-access-ends')).toBeNull();
		expect(q('api-access-ended')).not.toBeNull();
	});
});
