import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// `svelte` resolves to its server entry under node, where `mount` throws. The component is compiled
// for the client, so it is mounted with the client entry, loaded by path.
const CLIENT_ENTRY = join(dirname(createRequire(import.meta.url).resolve('svelte/package.json')), 'src/index-client.js');
type SvelteClient = {
	mount: (c: unknown, o: { target: Element; props?: Record<string, unknown> }) => Record<string, unknown>;
	unmount: (c: Record<string, unknown>) => void;
	flushSync: () => void;
	tick: () => Promise<void>;
};
const { mount, unmount, flushSync, tick } = (await import(/* @vite-ignore */ CLIENT_ENTRY)) as SvelteClient;

// Built at run time, so no literal here has the shape of a credential.
const SECRET = ['typed', 'app', 'secret', String(Date.now())].join('-');

let target: HTMLElement;
let component: Record<string, unknown> | undefined;
let calls: Array<{ url: string; method: string; body: string | undefined }>;
let putStatus: number;
// Answers for the PUTs in order, each used once; when empty, `putStatus` decides.
let putReplies: Array<{ status: number; body: Record<string, unknown> }>;
let getStatus: number;
let getExtra: Record<string, unknown>;

beforeEach(async () => {
	// The texts asserted below are the English ones; the locale otherwise follows the machine.
	(await import('../i18n.svelte.js')).setLocale('en');
	target = document.createElement('div');
	document.body.appendChild(target);
	calls = [];
	putStatus = 200;
	putReplies = [];
	getStatus = 200;
	getExtra = {};
	vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
		const method = init?.method ?? 'GET';
		calls.push({ url: String(url), method, body: typeof init?.body === 'string' ? init.body : undefined });
		if (method === 'PUT') {
			const next = putReplies.shift();
			if (next) return new Response(JSON.stringify(next.body), { status: next.status });
			return new Response(JSON.stringify(putStatus === 200 ? { ok: true } : { error: 'x' }), { status: putStatus });
		}
		if (getStatus !== 200) return new Response(JSON.stringify({ error: 'x' }), { status: getStatus });
		return new Response(JSON.stringify({
			preset: 'shopify', client_id_key: 'SHOPIFY_CLIENT_ID', client_secret_key: 'SHOPIFY_CLIENT_SECRET',
			client_id: null, client_secret_set: false, redirect_uri: 'https://tenant.example/api/oauth/callback',
			reads_other_names: false, ...getExtra,
		}), { status: 200, headers: { 'Content-Type': 'application/json' } });
	}));
});

afterEach(() => {
	if (component) unmount(component);
	component = undefined;
	target.remove();
	vi.unstubAllGlobals();
});

async function settle(): Promise<void> {
	for (let i = 0; i < 10; i++) {
		await new Promise((r) => setTimeout(r, 0));
		await tick();
		flushSync();
	}
}

async function fillAndSave(): Promise<void> {
	const { default: PresetClientForm } = await import('./PresetClientForm.svelte');
	component = mount(PresetClientForm, { target, props: { profileId: 'shop-admin' } });
	await settle();
	const id = target.querySelector<HTMLInputElement>('input[type="text"]')!;
	id.value = 'client-1';
	id.dispatchEvent(new Event('input'));
	const secret = target.querySelector<HTMLInputElement>('[data-testid="preset-client-secret"]')!;
	secret.value = SECRET;
	secret.dispatchEvent(new Event('input'));
	flushSync();
	[...target.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Save')!.click();
	await settle();
}

describe('PresetClientForm', () => {
	it('sends the secret once in the body, and renders it nowhere after the save', async () => {
		await fillAndSave();

		const put = calls.find((c) => c.method === 'PUT');
		expect(JSON.parse(put?.body ?? '{}')).toEqual({ client_id: 'client-1', client_secret: SECRET });
		expect(calls.every((c) => !c.url.includes(SECRET))).toBe(true);
		// The field is gone and nothing on the page holds the value.
		expect(target.querySelector('[data-testid="preset-client-secret"]')).toBeNull();
		expect([...target.querySelectorAll('input')].some((i) => i.value === SECRET)).toBe(false);
		expect(target.innerHTML).not.toContain(SECRET);
		expect(target.textContent).toContain('Client Secret is saved. Its value is not shown.');
		expect(target.textContent).toContain('Saved. You can connect now.');
	});

	it('says that only the owner may enter the app on a 403', async () => {
		putStatus = 403;
		await fillAndSave();

		expect(target.textContent).toContain('Only the owner of this instance can enter the app credentials.');
		expect(target.textContent).not.toContain('Saved. You can connect now.');
	});

	it('asks before replacing the app the other profiles use, and replaces it only on the confirmation', async () => {
		putReplies = [{ status: 409, body: { error: 'x', code: 'replaces_app' } }];
		await fillAndSave();

		expect(target.textContent).toContain('This replaces the app that all Shopify connections on this instance use.');
		expect(target.textContent).not.toContain('Saved. You can connect now.');
		const confirm = [...target.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Replace app');
		expect(confirm, 'confirm button').toBeDefined();
		confirm!.click();
		await settle();

		const puts = calls.filter((c) => c.method === 'PUT').map((c) => JSON.parse(c.body ?? '{}') as Record<string, unknown>);
		expect(puts).toEqual([
			{ client_id: 'client-1', client_secret: SECRET },
			{ client_id: 'client-1', client_secret: SECRET, replace_app: true },
		]);
		expect(target.textContent).toContain('Saved. You can connect now.');
		expect(target.querySelector('[data-testid="preset-client-replace"]')).toBeNull();
	});

	it('shows no form for a profile that reads its app from names of its own', async () => {
		getExtra = { reads_other_names: true };
		const { default: PresetClientForm } = await import('./PresetClientForm.svelte');
		component = mount(PresetClientForm, { target, props: { profileId: 'shop-admin' } });
		await settle();

		expect(target.textContent).toContain('This profile uses app credentials that lynox stored differently in the past.');
		expect(target.querySelector('input')).toBeNull();
	});

	it('shows no form, only the owner-only note, when the engine refuses the read', async () => {
		getStatus = 403;
		const { default: PresetClientForm } = await import('./PresetClientForm.svelte');
		component = mount(PresetClientForm, { target, props: { profileId: 'shop-admin' } });
		await settle();

		expect(target.textContent).toContain('Only the owner of this instance can enter the app credentials.');
		expect(target.querySelector('input')).toBeNull();
	});

	it('keeps password managers away from the secret field', async () => {
		const { default: PresetClientForm } = await import('./PresetClientForm.svelte');
		component = mount(PresetClientForm, { target, props: { profileId: 'shop-admin' } });
		await settle();

		const secret = target.querySelector<HTMLInputElement>('[data-testid="preset-client-secret"]')!;
		expect(secret.getAttribute('autocomplete')).toBe('new-password');
		expect(secret.hasAttribute('data-1p-ignore')).toBe(true);
		expect(secret.getAttribute('data-lpignore')).toBe('true');
	});

	it('names the provider and shows the redirect address', async () => {
		const { default: PresetClientForm } = await import('./PresetClientForm.svelte');
		component = mount(PresetClientForm, { target, props: { profileId: 'shop-admin' } });
		await settle();

		expect(target.textContent).toContain('App credentials for Shopify');
		expect(target.textContent).toContain('https://tenant.example/api/oauth/callback');
	});
});
