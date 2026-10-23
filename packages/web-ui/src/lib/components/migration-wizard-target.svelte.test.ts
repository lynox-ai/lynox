import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { t } from '../i18n.svelte.js';
import { reset, getStep, getTargetUrl, getMigrationToken } from '../stores/migration.svelte.js';

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

let target: HTMLElement;
let component: Record<string, unknown> | undefined;
let opened: string[];

beforeEach(() => {
	// The wizard's state lives in a module store, so each test starts it over.
	reset();
	target = document.createElement('div');
	document.body.appendChild(target);
	opened = [];
	vi.stubGlobal('fetch', vi.fn(async () =>
		new Response(JSON.stringify({ secrets: 2, databases: ['engine.db'], artifacts: 0, hasConfig: true }), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		})));
	vi.stubGlobal('open', vi.fn((url: string) => { opened.push(String(url)); return null; }));
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

async function openTargetStep(): Promise<void> {
	const { default: MigrationWizard } = await import('./MigrationWizard.svelte');
	component = mount(MigrationWizard, { target });
	await settle();
	const next = [...target.querySelectorAll('button')].find((b) => b.textContent?.trim() === t('migration.next'));
	expect(next, 'the preview step offers its next button').toBeDefined();
	next!.click();
	await settle();
}

describe('the migration wizard asks for a target instance and offers no checkout', () => {
	it('shows the target form at once, without a toggle', async () => {
		await openTargetStep();
		// t() falls back to the key itself, so the heading must be a real translation.
		expect(t('migration.target_title')).not.toBe('migration.target_title');
		expect(target.textContent).toContain(t('migration.target_title'));
		expect(target.querySelector('#target-url')).not.toBeNull();
		expect(target.querySelector('#migration-token')).not.toBeNull();
	});

	it('offers only start and back, opens nothing and names no price', async () => {
		await openTargetStep();
		const buttons = [...target.querySelectorAll('button')];
		// The step keeps its two own buttons: start (disabled until a token is entered) and back.
		expect(buttons.map((b) => b.textContent?.trim())).toEqual([t('migration.start'), t('migration.back')]);
		expect(opened).toEqual([]);
		expect(target.textContent ?? '').not.toMatch(/CHF|checkout/i);
	});
});

describe('a target reaches the wizard only through the form', () => {
	const TOKEN = 'a'.repeat(64);

	function calls(): string[] {
		return (vi.mocked(fetch).mock.calls as Array<[RequestInfo | URL, RequestInit | undefined]>)
			.map(([url, init]) => `${init?.method ?? 'GET'} ${String(url)}`);
	}

	afterEach(() => {
		window.history.replaceState({}, '', '/');
	});

	it('takes nothing from the address, and starts nothing, when the page is opened with target parameters', async () => {
		window.history.replaceState({}, '', `/app/migration?instanceUrl=${encodeURIComponent('https://elsewhere.example')}&migrationToken=${TOKEN}`);
		const { default: MigrationWizard } = await import('./MigrationWizard.svelte');
		component = mount(MigrationWizard, { target });
		await settle();
		expect(getTargetUrl()).toBe('');
		expect(getMigrationToken()).toBe('');
		expect(getStep()).toBe('preview');
		expect(calls().filter((c) => !c.endsWith('/migration/preview'))).toEqual([]);
	});

	it('starts the export once the form is filled and start is pressed', async () => {
		await openTargetStep();
		const url = target.querySelector<HTMLInputElement>('#target-url')!;
		const token = target.querySelector<HTMLInputElement>('#migration-token')!;
		url.value = 'https://target.example';
		url.dispatchEvent(new Event('input', { bubbles: true }));
		token.value = TOKEN;
		token.dispatchEvent(new Event('input', { bubbles: true }));
		await settle();
		const start = [...target.querySelectorAll('button')].find((b) => b.textContent?.trim() === t('migration.start'))!;
		expect(start.disabled).toBe(false);
		start.click();
		await settle();
		expect(calls().some((c) => c.startsWith('POST ') && c.endsWith('/migration/export'))).toBe(true);
		expect(getTargetUrl()).toBe('https://target.example');
	});
});
