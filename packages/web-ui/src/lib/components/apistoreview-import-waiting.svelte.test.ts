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

// The API page shows the files the import of the earlier profiles waits on, as the engine lists
// them (`importWaiting` on `GET /api/api-profiles`): which file, why, and how it is deleted. While
// one is listed, none of those profiles are there, so the page says so where they are missing.

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

async function render(): Promise<HTMLElement | null> {
	const { default: ApiStoreView } = await import('./ApiStoreView.svelte');
	component = mount(ApiStoreView, { target });
	for (let i = 0; i < 10; i++) {
		await new Promise((r) => setTimeout(r, 0));
		await tick();
		flushSync();
	}
	return target.querySelector<HTMLElement>('[data-testid="api-import-waiting"]');
}

describe('the API page shows the files the import waits on', () => {
	it('a file listed: the notice, the file name, why, and the id that deletes it', async () => {
		serve({ profiles: [], importWaiting: [{ file: 'shop.json', reason: 'malformed', deleteId: 'shop' }] });
		const box = await render();
		expect(box?.textContent).toContain('Die API-Profile von vor der Umstellung auf engine.db sind noch nicht übernommen');
		expect(box?.textContent).toContain('shop.json ist kein gültiges JSON. Löschen im Chat mit der ID shop.');
	});

	it('a file whose name is no id: removed by hand', async () => {
		serve({ profiles: [], importWaiting: [{ file: 'my shop.json', reason: 'not_a_profile', deleteId: null }] });
		const box = await render();
		expect(box?.textContent).toContain('my shop.json ist kein lesbares API-Profil');
		expect(box?.textContent).toContain('Der Dateiname ist keine ID: die Datei von Hand aus dem Ordner entfernen.');
	});

	it('nothing listed, or a server without the field: no notice', async () => {
		serve({ profiles: [], importWaiting: [] });
		expect(await render()).toBeNull();
		unmount(component!);
		component = undefined;
		serve({ profiles: [] });
		expect(await render()).toBeNull();
	});
});
