import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { setLocale } from '../i18n.svelte.js';

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

// GoogleSettings imports `onDestroy` from `svelte`, which under node is the server entry and
// throws outside a server render. Point the bare import at the same client entry `mount` uses.
vi.mock('svelte', async () => {
	const { createRequire: req } = await import('node:module');
	const path = await import('node:path');
	const entry = path.join(path.dirname(req(import.meta.url).resolve('svelte/package.json')), 'src/index-client.js');
	return (await import(/* @vite-ignore */ entry)) as Record<string, unknown>;
});

/**
 * The confirmation for a parked Google claim names the account before anything
 * is claimed. Connect waits while the account is looked up, is offered for a named
 * account and, as a fallback, when there is no answer, and is not offered at all
 * when the grant names no account. A link someone
 * else started lands on this page too; the account is what tells the two apart,
 * so a quick click must not confirm before the name is on screen.
 */

let target: HTMLElement;
let component: Record<string, unknown> | undefined;
/** Paths of every POST, in order. */
let posts: Array<{ path: string; body: unknown }>;
let releasePreview: (r: Response) => void;
/** What `/api/google/status` answers. */
let status: Record<string, unknown>;

beforeEach(() => {
	setLocale('en');
	target = document.createElement('div');
	document.body.appendChild(target);
	posts = [];
	status = {};
	window.history.replaceState({}, '', '/app/settings/channels/google?google_oauth=nonce-9');
	vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
		const u = String(url);
		if (init?.method === 'POST') {
			posts.push({ path: u.replace(/^.*\/api/, ''), body: JSON.parse(String(init.body ?? '{}')) as unknown });
			if (u.endsWith('/google/claim-managed/preview')) {
				return new Promise<Response>((resolve) => { releasePreview = resolve; });
			}
		}
		if (u.endsWith('/google/status')) return new Response(JSON.stringify(status), { status: 200, headers: { 'Content-Type': 'application/json' } });
		return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
	}));
});

afterEach(() => {
	if (component) unmount(component);
	component = undefined;
	target.remove();
	vi.unstubAllGlobals();
	window.history.replaceState({}, '', '/');
});

async function settle(): Promise<void> {
	for (let i = 0; i < 10; i++) {
		await new Promise((r) => setTimeout(r, 0));
		await tick();
		flushSync();
	}
}

async function render(): Promise<void> {
	const { default: GoogleSettings } = await import('./GoogleSettings.svelte');
	component = mount(GoogleSettings, { target });
	await settle();
}

function button(label: string): HTMLButtonElement {
	const found = [...target.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
	if (!found) throw new Error(`no button "${label}"`);
	return found;
}

const answer = (body: unknown): Response =>
	new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

function hasButton(label: string): boolean {
	return [...target.querySelectorAll('button')].some((b) => b.textContent?.trim() === label);
}

describe('the Google claim confirmation', () => {
	it('asks for the account first, holds Connect until it answers, then names it and claims on Connect', async () => {
		await render();
		expect(posts.map((p) => p.path)).toEqual(['/google/claim-managed/preview']);
		expect(posts[0]?.body).toEqual({ claim_nonce: 'nonce-9' });
		expect(target.textContent).toContain('Checking which one it is');
		expect(button('Connect').disabled).toBe(true);

		releasePreview(answer({ email: 'owner@example.com' }));
		await settle();
		expect(target.querySelector('bdi')?.textContent).toBe('owner@example.com');
		expect(target.textContent).toContain('The Google account owner@example.com is waiting to be connected');
		expect(target.textContent).toContain('Only confirm if this is your account');
		expect(button('Connect').disabled).toBe(false);

		button('Connect').click();
		await settle();
		expect(posts.map((p) => p.path)).toEqual(['/google/claim-managed/preview', '/google/claim-managed']);
		expect(posts[1]?.body).toEqual({ claim_nonce: 'nonce-9' });
	});

	// Only a brokered instance hears "unnamed" from the control plane.
	it('offers no Connect when the grant names no account', async () => {
		status = { available: true, authenticated: false, managed_broker: true, broker_available: true };
		await render();
		releasePreview(answer({ unnamed: true }));
		await settle();
		expect(target.textContent).toContain('We could not confirm which one it is');
		expect(hasButton('Connect')).toBe(false);
		expect(hasButton('Cancel')).toBe(true);
		expect(target.textContent).toContain('cancel and start it again with “Connect with Google”');
		expect(hasButton('Connect with Google')).toBe(true);
	});

	// Connected, the page shows Disconnect and no Connect with Google: the hint names the way that exists.
	it('on an instance already connected, the hint for an unnamed grant goes through Disconnect', async () => {
		status = { available: true, authenticated: true, managed_broker: true, broker_available: true };
		await render();
		releasePreview(answer({ unnamed: true }));
		await settle();
		expect(target.textContent).toContain('Cancel. The account connected so far stays connected.');
		expect(target.textContent).not.toContain('cancel and start it again');
		expect(hasButton('Connect with Google')).toBe(false);
		expect(hasButton('Disconnect')).toBe(true);
	});

	it('says it cannot name the account when there is no answer to go by, and still lets the user decide', async () => {
		await render();
		releasePreview(answer({}));
		await settle();
		expect(target.textContent).not.toContain('Checking which one it is');
		expect(target.textContent).toContain('A Google account is waiting to be connected to this instance. Connect it?');
		expect(target.textContent).toContain('We cannot show you which account it is');
		expect(button('Connect').disabled).toBe(false);
	});

	it('claims nothing on Cancel', async () => {
		await render();
		releasePreview(answer({ email: 'owner@example.com' }));
		await settle();
		button('Cancel').click();
		await settle();
		expect(posts.map((p) => p.path)).toEqual(['/google/claim-managed/preview']);
		expect(target.textContent).not.toContain('owner@example.com');
	});
});
