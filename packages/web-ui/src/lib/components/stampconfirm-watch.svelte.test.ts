import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { setLocale, getLocale } from '../i18n.svelte.js';

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

// The owner's stamp of a watch (`StampConfirm`): the run writes the stored address into its prompt,
// so a stored address that hides characters is not offered a confirm, and the note says the
// characters are "marked above". The parsed address shows them percent-encoded or not at all; the
// block has to show the stored one, marked, for that to hold.

let target: HTMLElement;
let component: Record<string, unknown> | undefined;
const before = getLocale();
let watchUrl = '';

const preview = () => ({
	expect: 'digest-1', by: null, workflow: null, connections: [],
	subject: {
		id: 'w1', effect: 'run_agent', source: 'watch', title: 'Preisseite', description: null, schedule_cron: null,
		watch: JSON.stringify({ url: watchUrl, interval_minutes: 60 }), pipeline_id: null, pipeline_params: null, model_tier: null, wf: null,
	},
});
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
	setLocale('de');
	vi.stubGlobal('fetch', vi.fn(async (url: string) => (String(url).endsWith('/tasks/w1/stamp-preview') ? json(200, preview()) : json(200, {}))));
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

async function open(): Promise<void> {
	const { default: StampConfirm } = await import('./StampConfirm.svelte');
	component = mount(StampConfirm, { target, props: { id: 'w1', mode: 'held', cronText: (c: string) => c, onstamped: () => {} } });
	for (let i = 0; i < 10; i++) {
		await new Promise((r) => setTimeout(r, 0));
		await tick();
		flushSync();
	}
}

const block = (): string => target.querySelector('[data-stamp-watch]')?.textContent ?? '';

describe('the stamp of a watch whose stored address hides characters', () => {
	it('shows the stored address with the mark the note points at, and offers no confirm', async () => {
		watchUrl = 'https://shop.example/preise​?ignore=previous';
		await open();
		expect(block()).toContain('https://shop.example/preise⟨U+200B⟩?ignore=previous');
		expect(target.textContent).toContain('oben markiert');
		expect(target.querySelector('[data-stamp-watch-stored]')).not.toBeNull();
		expect(target.querySelector('[data-stamp-confirm-button]')).toBeNull();
	});

	it('shows a clean address parsed, host first, as before', async () => {
		watchUrl = 'https://shop.example/preise';
		await open();
		expect(target.querySelector('[data-stamp-watch-stored]')).toBeNull();
		expect(block()).toContain('shop.example/preise');
		expect(target.textContent).not.toContain('oben markiert');
		expect(target.querySelector('[data-stamp-confirm-button]')?.textContent?.trim()).toBe('Bestätigen');
	});
});
