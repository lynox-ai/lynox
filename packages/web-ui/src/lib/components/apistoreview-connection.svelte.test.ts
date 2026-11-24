import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// `svelte` resolves to its server entry under node, where `mount` throws. The component is compiled
// for the client, so it is mounted with the client entry, loaded by path.
const CLIENT_ENTRY = join(dirname(createRequire(import.meta.url).resolve('svelte/package.json')), 'src/index-client.js');
type SvelteClient = {
	mount: (c: unknown, o: { target: Element }) => Record<string, unknown>;
	unmount: (c: Record<string, unknown>) => void;
	flushSync: () => void;
	tick: () => Promise<void>;
};
const { mount, unmount, flushSync, tick } = (await import(/* @vite-ignore */ CLIENT_ENTRY)) as SvelteClient;

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));

// The line under a connected profile: who connected it and with which provider account. The
// engine leaves the account out for every reader but the owner and whoever connected
// (`account_withheld`); the page says so, instead of calling it unknown or the reader's own.

let target: HTMLElement;
let component: Record<string, unknown> | undefined;

function serve(body: unknown): void {
	vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })));
}

beforeEach(() => {
	target = document.createElement('div');
	document.body.appendChild(target);
});

afterEach(() => {
	if (component) unmount(component);
	component = undefined;
	target.remove();
	vi.unstubAllGlobals();
});

async function lines(grants: Record<string, unknown>[]): Promise<string[]> {
	serve({ profiles: grants.map((g, i) => ({ id: `p${i}`, name: `p${i}`, base_url: 'https://x.example', description: 'd', oauth_grant: g })), importWaiting: [] });
	const { default: ApiStoreView } = await import('./ApiStoreView.svelte');
	component = mount(ApiStoreView, { target });
	for (let i = 0; i < 10; i++) {
		await new Promise((r) => setTimeout(r, 0));
		await tick();
		flushSync();
	}
	return [...target.querySelectorAll<HTMLElement>('[data-testid="api-connection"]')].map((e) => e.textContent?.trim() ?? '');
}

describe('the API page says who connected a profile and with which account', () => {
	it('an account withheld from the reader: the owner\'s connection reads as the owner\'s, the account as not shown', async () => {
		expect(await lines([
			{ connected_by: 'owner', account_withheld: true },
			{ connected_by: 'mandate:tom@example.invalid', account_withheld: true },
		])).toEqual([
			'Verbunden vom Inhaber · Konto für dich ausgeblendet',
			'Verbunden von tom@example.invalid · Konto für dich ausgeblendet',
		]);
	});

	it('an account shown or never recorded reads as before', async () => {
		expect(await lines([
			{ connected_by: 'owner', account: { label: 'a@example.invalid' }, connected_by_reader: true },
			{ connected_by: 'mandate:tom@example.invalid', connected_by_reader: false },
		])).toEqual([
			'Verbunden von dir · Konto: a@example.invalid',
			'Verbunden von tom@example.invalid · Konto unbekannt',
		]);
	});

	it('"by you" follows the engine\'s answer about the reader, not the owner tag', async () => {
		expect(await lines([
			// A helper reading the owner's connection that recorded no account: nothing was withheld.
			{ connected_by: 'owner', connected_by_reader: false },
			// The owner reading the same.
			{ connected_by: 'owner', connected_by_reader: true },
			// A helper reading their own connection.
			{ connected_by: 'mandate:tom@example.invalid', account: { label: 't@example.invalid' }, connected_by_reader: true },
		])).toEqual([
			'Verbunden vom Inhaber · Konto unbekannt',
			'Verbunden von dir · Konto unbekannt',
			'Verbunden von dir · Konto: t@example.invalid',
		]);
	});
});

describe('a profile\'s values in boxes of pieces, for a narrow screen (U-391)', () => {
	const W = (x: string): string => `<span class="inline-block max-w-full break-all">${x}</span>`;
	const html = (id: string): string[] => [...target.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)].map((e) => e.innerHTML.replace(/<!---->/g, ''));

	it('the base URL has `<wbr>` only after a dot or a slash, none at a hyphen; the account is set apart whole in its own box', async () => {
		serve({ profiles: [{ id: 'shop', name: 'Shop', base_url: 'https://acme-store.myshopify.com/admin/api/2025-10', description: '', oauth_grant: { connected_by: 'owner', account: { label: 'acme-store.myshopify.com' }, connected_by_reader: true } }], importWaiting: [] });
		const { default: ApiStoreView } = await import('./ApiStoreView.svelte');
		component = mount(ApiStoreView, { target });
		for (let i = 0; i < 10; i++) {
			await new Promise((r) => setTimeout(r, 0));
			await tick();
			flushSync();
		}
		expect(html('api-base-url')).toEqual([['https://', 'acme-store.', 'myshopify.', 'com/', 'admin/', 'api/', '2025-10'].map(W).join('<wbr>')]);
		// The account is someone else's value: set apart as one value, its box moving to the next line whole.
		const account = target.querySelector<HTMLElement>('[data-testid="api-connection-account"]')!;
		expect([...account.querySelectorAll('bdi[data-foreign-value]')].map((e) => e.textContent)).toEqual(['acme-store.myshopify.com']);
		expect(account.querySelectorAll('wbr').length).toBe(0);
		for (const id of ['api-base-url', 'api-connection-account']) {
			const box = target.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
			expect(box.classList.contains('inline-block') && box.classList.contains('max-w-full'), id).toBe(true);
		}
		expect(target.querySelector('[data-testid="api-connection"]')?.textContent?.trim()).toBe('Verbunden von dir · Konto: acme-store.myshopify.com');
	});

	it('the base URL shows a character that turns text around as its code point, not as the character', async () => {
		const rlo = String.fromCharCode(0x202e);
		serve({ profiles: [{ id: 'crm', name: 'CRM', base_url: `https://crm.example/${rlo}v2`, description: '' }], importWaiting: [] });
		const { default: ApiStoreView } = await import('./ApiStoreView.svelte');
		component = mount(ApiStoreView, { target });
		for (let i = 0; i < 10; i++) {
			await new Promise((r) => setTimeout(r, 0));
			await tick();
			flushSync();
		}
		const url = target.querySelector<HTMLElement>('[data-testid="api-base-url"]')!.textContent ?? '';
		expect(url.includes(rlo)).toBe(false);
		expect(url).toContain('U+202E');
		expect(url.startsWith('https://crm.example/')).toBe(true);
	});
});
