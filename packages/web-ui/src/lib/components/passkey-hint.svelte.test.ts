import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { getLocale, setLocale } from '../i18n.svelte.js';

// The component is compiled for the client, so it is mounted with the client entry, loaded by path.
const CLIENT_ENTRY = join(dirname(createRequire(import.meta.url).resolve('svelte/package.json')), 'src/index-client.js');
type SvelteClient = {
	mount: (c: unknown, o: { target: Element; props?: Record<string, unknown> }) => Record<string, unknown>;
	unmount: (c: Record<string, unknown>) => void;
	flushSync: () => void;
	tick: () => Promise<void>;
};
const { mount, unmount, flushSync, tick } = (await import(/* @vite-ignore */ CLIENT_ENTRY)) as SvelteClient;

let target: HTMLElement;
let component: Record<string, unknown> | undefined;
const before = getLocale();

beforeEach(() => {
	localStorage.removeItem('lynox_passkey_dismissed');
	vi.stubGlobal('PublicKeyCredential', function PublicKeyCredential() {});
	vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ supported: true, canRegister: true, hasPasskeys: false }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
	target = document.createElement('div');
	document.body.appendChild(target);
});
afterEach(() => {
	if (component) unmount(component);
	component = undefined;
	target.remove();
	vi.unstubAllGlobals();
	setLocale(before);
});

async function open(lang: 'de' | 'en'): Promise<HTMLElement | null> {
	setLocale(lang);
	const { default: PasskeyPrompt } = await import('./PasskeyPrompt.svelte');
	component = mount(PasskeyPrompt, { target });
	for (let i = 0; i < 10; i++) { await tick(); await new Promise((r) => setTimeout(r, 0)); flushSync(); }
	return target.querySelector<HTMLElement>('[data-passkey-hint]');
}

describe('the passkey hint is a strip in the flow (U-454)', () => {
	it('is not fixed or floating, so it covers nothing, and says one sentence with its two buttons (DE)', async () => {
		const hint = await open('de');
		expect(hint).not.toBeNull();
		for (const c of ['fixed', 'absolute', 'sticky', 'z-50', 'shadow-2xl']) expect(hint?.classList.contains(c)).toBe(false);
		expect(hint?.querySelector('p')?.textContent).toBe('Schneller anmelden mit einem Passkey: Face ID oder Fingerabdruck statt E-Mail-Code.');
		expect(hint?.querySelector('[data-passkey-setup]')?.textContent?.trim()).toBe('Einrichten');
		expect(hint?.querySelector('[data-passkey-later]')?.textContent?.trim()).toBe('Später');
		expect(hint?.querySelector('svg')).toBeNull();
	});

	it('says it in English', async () => {
		const hint = await open('en');
		expect(hint?.querySelector('p')?.textContent).toBe('Sign in faster with a passkey: Face ID or fingerprint instead of the email code.');
		expect(hint?.querySelector('[data-passkey-setup]')?.textContent?.trim()).toBe('Set up');
		expect(hint?.querySelector('[data-passkey-later]')?.textContent?.trim()).toBe('Later');
	});

	it('stays away once dismissed with "Later"', async () => {
		const hint = await open('de');
		(hint?.querySelector('[data-passkey-later]') as HTMLButtonElement).click();
		flushSync();
		expect(target.querySelector('[data-passkey-hint]')).toBeNull();
		expect(localStorage.getItem('lynox_passkey_dismissed')).toBe('1');
	});
});
