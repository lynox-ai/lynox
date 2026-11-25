import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { noteSettingsViewer, resetSettingsViewer } from '../stores/settings-viewer.svelte.js';
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

// Ends at noon UTC, so the day is the same in every time zone within 12 hours of UTC (the test runs
// in UTC or Central Europe); the dates are written out, not derived the way the page derives them.
const soonIso = '2099-01-20T12:00:00.000Z';
const SOON = { de: '20. Januar 2099', en: 'January 20, 2099' };
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
		// Break points only after a dot: `<wbr>` there and nowhere else, so not at the hyphen while a
		// piece fits on a line. Each piece its own box, broken inside only when longer than a line.
		// That a fitting piece stays whole is a rendering fact jsdom cannot check; this pins the markup.
		const W = (x: string): string => `<span class="inline-block max-w-full break-all">${x}</span>`;
		expect(all('store-access-host').map((h) => h.innerHTML.replace(/<!---->/g, ''))).toEqual([
			`${W('acme.')}<wbr>${W('myshopify.')}<wbr>${W('com')}`,
			`${W('beta-shop.')}<wbr>${W('myshopify.')}<wbr>${W('com')}`,
		]);
		// The box is an inline-block up to the line's width, so the host can move to the next line whole (U-391).
		expect(all('store-access-host').every((h) => h.classList.contains('inline-block') && h.classList.contains('max-w-full'))).toBe(true);
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

	it('takes the engine\'s word that the access ended, though the end is still ahead on this browser\'s clock', async () => {
		setLocale('en');
		serve('owner', [shop('a', 'acme.myshopify.com', soonIso, { store_access_ends: { host: 'acme.myshopify.com', ended: true, at: soonIso } })]);
		await render('banner');
		expect(text(q('store-access-line'))).toBe('lynox could not renew its access to the store acme.myshopify.com. Runs and requests to the store only work again once you reconnect it. Reconnect');
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

	it('shows a mandate nothing and does not ask for its profiles, shows nothing until the server names the owner, and nothing where the engine told no end', async () => {
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
		// The server names the owner late (a retry): the banner shows then, without a new load.
		noteSettingsViewer({ viewer: 'owner' });
		flushSync();
		expect(all('store-access-line')).toHaveLength(1);
		noteSettingsViewer({ viewer: 'mandate' });
		flushSync();
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

	it('a store connected again while an erasure stands: the end beside the erasure dates, with one "Reconnect"', async () => {
		const notice = { recordId: 1, connectionId: 'a', revokedAt: '2099-01-01T12:00:00.000Z', holdUntil: '2099-01-15T12:00:00.000Z', deadline: '2099-01-31T12:00:00.000Z', reconnected: false };
		serve('owner', [shop('a', 'acme.myshopify.com', soonIso)], [notice]);
		await render('apis');
		expect(q('api-erasure-window')).not.toBeNull();
		expect(text(q('api-access-ends-text'))).toBe(`Der Zugang von lynox zu diesem Shop läuft am ${SOON.de} ab. Verbinde ihn vorher neu, damit Läufe und Abfragen weiterlaufen.`);
		// The one "Reconnect" is the erasure view's; the line adds none.
		expect(all('api-reconnect')).toHaveLength(1);
		expect(q('api-access-ends')!.querySelector('[data-testid="api-reconnect"]')).toBeNull();
	});

	it('a refresh that ended while an erasure past its hold stands: "ended" and its own "Reconnect" beside the dates', async () => {
		const notice = { recordId: 1, connectionId: 'a', revokedAt: '2020-01-01T12:00:00.000Z', holdUntil: '2020-01-15T12:00:00.000Z', deadline: '2099-01-31T12:00:00.000Z', reconnected: false };
		serve('owner', [shop('a', 'acme.myshopify.com', soonIso, { oauth_grant: { state: 'refresh-dead' }, store_access_ends: { host: 'acme.myshopify.com', ended: true, at: soonIso } })], [notice]);
		await render('apis');
		expect(q('api-erasure-window')).not.toBeNull();
		expect(all('api-access-ended').map(text)).toEqual(['lynox konnte den Zugang zu diesem Shop nicht erneuern.']);
		// The one "Reconnect" is the line's own: the erasure view past its hold offers none.
		expect(all('api-reconnect')).toHaveLength(1);
		expect(q('api-access-ends')!.querySelectorAll('[data-testid="api-reconnect"]')).toHaveLength(1);
	});

	it('a mandate that set the store up gets "Reconnect" under the first sentence', async () => {
		serve('mandate', [shop('a', 'acme.myshopify.com', soonIso, { reader_may_connect: true })]);
		await render('apis');
		expect(text(q('api-access-ends-text'))).toBe(`Der Zugang von lynox zu diesem Shop läuft am ${SOON.de} ab.`);
		expect(text(q('api-reconnect'))).toBe('Erneut verbinden');
		expect(q('api-reconnect-not-yours')).toBeNull();
	});
});

describe('the shell banner in a tab that stays open past an end', () => {
	// The clock of this test: two minutes before the first store's end. Each minute the banner looks
	// whether an end it was told of has come since its last answer, and only then asks again.
	const T0 = Date.parse('2099-01-20T11:58:00.000Z');
	const END_A = '2099-01-20T11:59:30.000Z';
	const END_B = '2099-01-20T12:00:30.000Z';
	const RENEWED = '2099-02-20T12:00:00.000Z';
	const SOON_LINE = (host: string, day: string): string => `Der Zugang von lynox zum Shop ${host} läuft am ${day} ab. Verbinde den Shop vorher neu, damit Läufe und Abfragen weiterlaufen. Erneut verbinden`;
	const ENDED_LINE = (host: string): string => `lynox konnte den Zugang zum Shop ${host} nicht erneuern. Läufe und Abfragen an den Shop gehen erst wieder, wenn du ihn neu verbindest. Erneut verbinden`;
	const A = (at: string, ended = false): Record<string, unknown> => shop('a', 'acme.myshopify.com', at, { store_access_ends: { host: 'acme.myshopify.com', ended, at } });
	const B = shop('b', 'beta-shop.myshopify.com', END_B, { store_access_ends: { host: 'beta-shop.myshopify.com', ended: false, at: END_B } });

	/** Each question for the profiles takes the next answer: a list, a status, or 'hang' (it waits until aborted). */
	let answers: (unknown[] | number | 'hang')[];
	let questions: number;
	/** Each ask for the viewer takes the next: a body, or 'hang'; the owner once the list is empty. */
	let configs: (Record<string, unknown> | 'hang')[];
	let configAsks: number;
	/** How far the clock moves while the engine answers a question for the profiles, one per question. */
	let answerTakes: number[];
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
		vi.setSystemTime(T0);
		setLocale('de');
		questions = 0;
		answers = [];
		configs = [];
		configAsks = 0;
		answerTakes = [];
		vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
			const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
			if (url.endsWith('/config')) {
				configAsks++;
				const c = configs.shift() ?? { viewer: 'owner' };
				if (c === 'hang') return new Promise<Response>(() => undefined);
				return json(c);
			}
			questions++;
			vi.setSystemTime(Date.now() + (answerTakes.shift() ?? 0));
			const next = answers.shift() ?? 500;
			if (next === 'hang') {
				return new Promise<Response>((_, reject) => { init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))); });
			}
			if (typeof next === 'number') return new Response('{}', { status: next, headers: { 'Content-Type': 'application/json' } });
			return json({ profiles: next });
		}));
	});
	afterEach(() => { vi.useRealTimers(); });

	async function settle(): Promise<void> {
		for (let i = 0; i < 10; i++) {
			await vi.advanceTimersByTimeAsync(0);
			await tick();
			flushSync();
		}
	}
	async function open(): Promise<void> {
		const { default: View } = await import('./StoreAccessBanner.svelte');
		component = mount(View, { target });
		await settle();
	}
	async function minutes(n: number): Promise<void> {
		for (let i = 0; i < n; i++) {
			await vi.advanceTimersByTimeAsync(60_000);
			await settle();
		}
	}
	const shown = (): string[] => all('store-access-line').map(text);

	it('while a question is open the date stays, and another store\'s end asks once the question has cleared', async () => {
		answers = [[A(END_A), B], 'hang', [A(RENEWED), B]];
		await open();
		expect(questions).toBe(1);
		expect(shown()).toEqual([SOON_LINE('acme.myshopify.com', '20. Januar 2099'), SOON_LINE('beta-shop.myshopify.com', '20. Januar 2099')]);
		// 11:59: nothing has come yet.
		await minutes(1);
		expect(questions).toBe(1);
		// 12:00: A's end has come; the question goes out and gets no answer.
		await minutes(1);
		expect(questions).toBe(2);
		expect(shown()).toEqual([SOON_LINE('acme.myshopify.com', '20. Januar 2099'), SOON_LINE('beta-shop.myshopify.com', '20. Januar 2099')]);
		// A line drawn again while the question is open (another language) still reads the ends as of the last answer.
		setLocale('en');
		await settle();
		expect(shown()[0]).toBe('lynox\'s access to the store acme.myshopify.com runs out on January 20, 2099. Reconnect the store before then so runs and requests keep going. Reconnect');
		setLocale('de');
		await settle();
		// 12:00:15 the open question is given up; nothing flips.
		await vi.advanceTimersByTimeAsync(15_000);
		await settle();
		expect(shown()).toEqual([SOON_LINE('acme.myshopify.com', '20. Januar 2099'), SOON_LINE('beta-shop.myshopify.com', '20. Januar 2099')]);
		// 12:01:15: A's end and now B's have come since the last answer; one question asks for both.
		await minutes(1);
		expect(questions).toBe(3);
		expect(shown()).toEqual([SOON_LINE('acme.myshopify.com', '20. Februar 2099'), ENDED_LINE('beta-shop.myshopify.com')]);
	});

	it('an end the engine renewed meanwhile shows the new date, never "ended"', async () => {
		answers = [[A(END_A)], [A(RENEWED)]];
		await open();
		await minutes(2);
		expect(questions).toBe(2);
		expect(shown()).toEqual([SOON_LINE('acme.myshopify.com', '20. Februar 2099')]);
		await minutes(5);
		expect(questions).toBe(2);
		expect(shown()).toEqual([SOON_LINE('acme.myshopify.com', '20. Februar 2099')]);
	});

	it('an end the engine confirms reads ended, and the banner asks no more for it', async () => {
		answers = [[A(END_A)], [A(END_A, true)]];
		await open();
		await minutes(2);
		expect(questions).toBe(2);
		expect(shown()).toEqual([ENDED_LINE('acme.myshopify.com')]);
		await minutes(10);
		expect(questions).toBe(2);
		expect(shown()).toEqual([ENDED_LINE('acme.myshopify.com')]);
	});

	it('an end that comes while the engine answers is not called ended: the time is the question\'s, and the next minute asks again', async () => {
		// The first answer takes 45 s; A's end comes 20 s into it.
		const END_IN_ANSWER = '2099-01-20T11:58:20.000Z';
		answerTakes = [45_000];
		answers = [[A(END_IN_ANSWER)], [A(RENEWED)]];
		await open();
		expect(shown()).toEqual([SOON_LINE('acme.myshopify.com', '20. Januar 2099')]);
		await minutes(1);
		expect(questions).toBe(2);
		expect(shown()).toEqual([SOON_LINE('acme.myshopify.com', '20. Februar 2099')]);
	});

	it('a viewer ask that hangs holds no question: after a short wait the profiles are asked, as for a viewer not named yet', async () => {
		// The engine names no viewer at first (an older answer); the next ask for it hangs.
		configs = [{}, 'hang'];
		answers = [[A(END_A)], [A(RENEWED)]];
		await open();
		expect(configAsks).toBe(1);
		expect(questions).toBe(1);
		// 12:00: A's end has come; the viewer is asked again and gets no answer.
		await minutes(2);
		expect(configAsks).toBe(2);
		expect(questions).toBe(1);
		// 12:00:05 the profiles are asked without it.
		await vi.advanceTimersByTimeAsync(5_000);
		await settle();
		expect(questions).toBe(2);
		expect(configAsks).toBe(2);
	});


	it('a question that fails changes nothing, and the next minute asks again', async () => {
		answers = [[A(END_A)], 500, [A(RENEWED)]];
		await open();
		await minutes(2);
		expect(questions).toBe(2);
		expect(shown()).toEqual([SOON_LINE('acme.myshopify.com', '20. Januar 2099')]);
		await minutes(1);
		expect(questions).toBe(3);
		expect(shown()).toEqual([SOON_LINE('acme.myshopify.com', '20. Februar 2099')]);
	});
});
