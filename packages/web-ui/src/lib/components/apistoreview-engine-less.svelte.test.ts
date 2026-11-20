import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { resetSettingsViewer } from '../stores/settings-viewer.svelte.js';

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

// An engine that started without engine.db refuses every delete of an API profile with a 409 and the
// code `engine_less`; the page says why in its own language. Any other failure keeps the plain line.
// The sentences are written out here, not read from the table.

const ENGINE_LESS = 'Nicht gelöscht: Die Engine ist ohne engine.db gestartet, und bis sie neu startet und wieder alle ihre Dateien öffnen kann, lässt sich keine API-Verbindung löschen.';
const FAILED = 'Löschen fehlgeschlagen.';

let target: HTMLElement;
let component: Record<string, unknown> | undefined;

const PROFILE = { id: 'bexio', name: 'bexio', base_url: 'https://api.bexio.com', description: 'Buchhaltung' };

/** The page's reads, and a DELETE answered with `status` and `body`. */
function serve(status: number, body: unknown): void {
	vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
		const path = String(url).split('?')[0]!;
		const json = (b: unknown, s = 200): Response => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
		if (init?.method === 'DELETE') return json(body, status);
		if (path.endsWith('/config')) return json({ viewer: 'owner' });
		if (path.endsWith('/api-profiles')) return json({ profiles: [PROFILE] });
		return json({});
	}));
	vi.stubGlobal('confirm', () => true);
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
});

async function settle(): Promise<void> {
	for (let i = 0; i < 10; i++) {
		await new Promise((r) => setTimeout(r, 0));
		await tick();
		flushSync();
	}
}

async function deleteBexio(): Promise<string> {
	const { default: ApiStoreView } = await import('./ApiStoreView.svelte');
	component = mount(ApiStoreView, { target });
	await settle();
	const button = target.querySelector<HTMLButtonElement>('button[aria-label="Löschen"]');
	if (button === null) throw new Error('fixture: no delete button');
	button.click();
	await settle();
	return target.textContent ?? '';
}

describe('the API page on an engine without engine.db', () => {
	it('says why a delete was refused when the engine sends the code', async () => {
		serve(409, { error: 'This engine started without engine.db, so lynox does not remove API connections now.', code: 'engine_less' });
		const text = await deleteBexio();
		expect(text).toContain(ENGINE_LESS);
		expect(text).not.toContain(FAILED);
		// The profile stays listed.
		expect(text).toContain('https://api.bexio.com');
	});

	it('keeps the plain line for a refusal without the code', async () => {
		serve(409, { error: 'Something else.' });
		const text = await deleteBexio();
		expect(text).toContain(FAILED);
		expect(text).not.toContain(ENGINE_LESS);
	});
});
