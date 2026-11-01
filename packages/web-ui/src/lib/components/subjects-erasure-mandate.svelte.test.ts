import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Erasing a person from the subjects page: both erasure routes are the
// owner's. The owner gets the button; a mandate, who may be the one a person asks, is told to pass
// the request on; while the server has not said whose session it is, neither shows.

// The client entry stands in for `svelte`, so mounting and the component's effects share one instance.
const CLIENT_ENTRY = vi.hoisted(() => {
	const { createRequire: req } = require('node:module') as typeof import('node:module');
	const { dirname: dir, join: jn } = require('node:path') as typeof import('node:path');
	return jn(dir(req(import.meta.url).resolve('svelte/package.json')), 'src/index-client.js');
});
vi.mock('svelte', async () => import(/* @vite-ignore */ CLIENT_ENTRY));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
type SvelteClient = {
	mount: (c: unknown, o: { target: Element }) => Record<string, unknown>;
	unmount: (c: Record<string, unknown>) => void;
	flushSync: () => void;
};

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const settle = async (): Promise<void> => { for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0)); };

let svelte: SvelteClient;
let target: HTMLElement;
let component: Record<string, unknown> | undefined;
let t: (key: string) => string;
let configGate: Promise<void>;

/** Mounts the page for `viewer` and opens the one person on it. */
async function openPersonAs(viewer: 'mandate' | 'owner'): Promise<void> {
	vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
		const path = String(input).split('?')[0]!;
		if (path.endsWith('/config')) { await configGate; return json({ viewer }); }
		if (path.endsWith('/subjects')) return json({ subjects: [{ id: 's1', kind: 'person', name: 'Anna Muster' }], total: 1 });
		return json({ timeline: [], memories: [], tasks: [] });
	}));
	const { default: SubjectsView } = await import('./SubjectsView.svelte');
	component = svelte.mount(SubjectsView, { target });
	svelte.flushSync();
	await settle();
	const row = [...target.querySelectorAll('button')].find((b) => b.textContent?.includes('Anna Muster'));
	expect(row, 'positive control: the person is listed').toBeDefined();
	row!.click();
	await settle();
	svelte.flushSync();
}

const eraseButton = (): Element | undefined => [...target.querySelectorAll('button')].find((b) => b.textContent?.includes(t('erasure.open')));

beforeEach(async () => {
	svelte = (await import('svelte')) as unknown as SvelteClient;
	(await import('../stores/settings-viewer.svelte.js')).resetSettingsViewer();
	({ t } = await import('../i18n.svelte.js'));
	(await import('../i18n.svelte.js')).setLocale('de');
	target = document.createElement('div');
	document.body.appendChild(target);
	configGate = Promise.resolve();
});

afterEach(() => {
	if (component) svelte.unmount(component);
	component = undefined;
	target.remove();
	vi.unstubAllGlobals();
});

describe('SubjectsView and erasing a person', () => {
	it('tells a mandate to pass the request on, without the button', async () => {
		await openPersonAs('mandate');
		expect(eraseButton()).toBeUndefined();
		expect(target.querySelector('[data-testid="erasure-owner-only"]')?.textContent).toBe(t('erasure.owner_only_notice'));
	});

	it('gives the owner the button, without the sentence', async () => {
		await openPersonAs('owner');
		expect(eraseButton()).toBeDefined();
		expect(target.querySelector('[data-testid="erasure-owner-only"]')).toBeNull();
	});

	it('shows neither while the server has not said whose session it is', async () => {
		let release!: () => void;
		configGate = new Promise((r) => { release = r; });
		await openPersonAs('owner');
		expect(eraseButton()).toBeUndefined();
		expect(target.querySelector('[data-testid="erasure-owner-only"]')).toBeNull();
		release();
		await settle();
		svelte.flushSync();
		expect(eraseButton(), 'twin: the answer arrives and the owner gets the button').toBeDefined();
	});
});
