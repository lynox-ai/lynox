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

// A profile card's head: its name, a chip that names how it signs in (never the engine's raw auth
// type), its address and who connected it. Its free description is not in the head, where it
// stood without a label; the opened card shows it under one.

let target: HTMLElement;
let component: Record<string, unknown> | undefined;

const LONG = 'Shopify Admin API für den Laden acme-store, Produkte und SEO-Texte, gelesen und geschrieben über die verbundene App';

const PROFILES = [
	{ id: 'shop', name: 'Shopify acme-store', base_url: 'https://acme-store.myshopify.com/admin/api/2025-10', description: 'Shop', auth: { type: 'oauth2', oauth: { preset_id: 'shopify' } }, built_in_provider: 'Shopify' },
	// A preset id the engine does not know: the list names no provider, so the chip names none.
	{ id: 'look', name: 'Lookalike', base_url: 'https://lookalike.example', description: 'L', auth: { type: 'oauth2', oauth: { preset_id: 'google' } }, built_in_provider: null },
	{ id: 'own', name: 'Eigene App', base_url: 'https://own.example', description: LONG, auth: { type: 'oauth2' } },
	{ id: 'crm', name: 'CRM', base_url: 'https://crm.example', description: 'CRM', auth: { type: 'bearer', vault_keys: ['CRM_KEY'] }, endpoints: [{ method: 'GET', path: '/contacts', description: 'list' }] },
	{ id: 'open', name: 'Open', base_url: 'https://open.example', description: 'Offen', auth: { type: 'none' } },
	{ id: 'odd', name: 'Odd', base_url: 'https://odd.example', description: 'Odd', auth: { type: 'digest' } },
];

async function settle(): Promise<void> {
	for (let i = 0; i < 10; i++) {
		await new Promise((r) => setTimeout(r, 0));
		await tick();
		flushSync();
	}
}

beforeEach(async () => {
	target = document.createElement('div');
	document.body.appendChild(target);
	vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ profiles: PROFILES, importWaiting: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
	const { default: ApiStoreView } = await import('./ApiStoreView.svelte');
	component = mount(ApiStoreView, { target });
	await settle();
});

afterEach(() => {
	if (component) unmount(component);
	component = undefined;
	target.remove();
	vi.unstubAllGlobals();
});

function card(name: string): HTMLElement {
	const head = [...target.querySelectorAll<HTMLElement>('span.font-medium')].find((s) => s.textContent?.trim() === name);
	if (!head) throw new Error(`no card ${name}`);
	return head.closest<HTMLElement>('div.rounded-\\[var\\(--radius-md\\)\\]')!;
}

function headButton(name: string): HTMLButtonElement {
	return card(name).querySelector<HTMLButtonElement>('button')!;
}

function chip(name: string): string | null {
	return card(name).querySelector('[data-testid="api-auth-chip"]')?.textContent?.trim() ?? null;
}

describe('an API profile card says how the profile signs in, and labels its description', () => {
	it('the chip names the way, by the provider\'s display name where there is one', () => {
		expect(chip('Shopify acme-store')).toBe('Anmeldung über Shopify');
		expect(chip('Eigene App')).toBe('Anmeldung beim Anbieter');
		expect(chip('CRM')).toBe('API-Schlüssel');
		expect(chip('Lookalike')).toBe('Anmeldung beim Anbieter');
	});

	// From 360 px on a chip on two lines does not read as a chip, and on the head's hover and open
	// surface (bg-bg-muted) a chip of that same surface disappears: it keeps one line there, and its own border.
	it('the chip keeps one line from 360 px on, wraps rather than being cut below, moves under the name whole, and stands apart from the head', () => {
		const el = card('Shopify acme-store').querySelector<HTMLElement>('[data-testid="api-auth-chip"]')!;
		expect(el.classList.contains('whitespace-nowrap')).toBe(true);
		expect(el.classList.contains('border')).toBe(true);
		expect(el.classList.contains('bg-bg-muted')).toBe(false);
		expect(el.classList.contains('bg-bg')).toBe(true);
		// Narrower than the chip (below 360 px): it wraps at its spaces rather than being cut, and the
		// head may shrink below the chip, so the card's buttons stay in view.
		expect(el.classList.contains('max-[360px]:whitespace-normal')).toBe(true);
		expect(el.classList.contains('truncate')).toBe(false);
		expect(el.classList.contains('max-w-full')).toBe(true);
		expect(el.getAttribute('title')).toBe('Anmeldung über Shopify');
		expect(headButton('Shopify acme-store').classList.contains('min-w-0')).toBe(true);
		expect(card('Shopify acme-store').querySelector('[data-testid="api-card-title"]')!.classList.contains('flex-wrap')).toBe(true);
	});

	it('no sign-in and an unknown type have no chip, and no card shows a raw auth type', () => {
		expect(chip('Open')).toBeNull();
		expect(chip('Odd')).toBeNull();
		const text = target.textContent ?? '';
		for (const raw of ['oauth2', 'bearer', 'digest', 'none']) expect(text).not.toContain(raw);
	});

	it('the closed card carries no description, labelled or not', () => {
		for (const name of ['Shopify acme-store', 'Eigene App', 'CRM']) {
			expect(card(name).querySelector('[data-testid="api-description"]')).toBeNull();
		}
		expect([...target.querySelectorAll('p')].some((p) => p.textContent?.trim() === 'Shop')).toBe(false);
		expect(target.textContent).not.toContain(LONG);
	});

	it('the opened card shows the description whole under its label, with or without endpoints', async () => {
		expect(headButton('Eigene App').getAttribute('aria-expanded')).toBe('false');
		headButton('Eigene App').click();
		await settle();
		expect(headButton('Eigene App').getAttribute('aria-expanded')).toBe('true');
		expect(card('Eigene App').querySelector('[data-testid="api-description"]')?.textContent?.trim()).toBe(`Beschreibung: ${LONG}`);
		// Only the opened card.
		expect(card('Shopify acme-store').querySelector('[data-testid="api-description"]')).toBeNull();

		headButton('CRM').click();
		await settle();
		expect(card('CRM').querySelector('[data-testid="api-description"]')?.textContent?.trim()).toBe('Beschreibung: CRM');
		expect(card('CRM').textContent).toContain('/contacts');
		expect(card('Eigene App').querySelector('[data-testid="api-description"]')).toBeNull();
	});
});
