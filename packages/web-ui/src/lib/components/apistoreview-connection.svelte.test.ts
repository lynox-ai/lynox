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
