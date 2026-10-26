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

// A settings item whose page only the owner may read is shown only once that page's API answers:
// a helper is not offered an item that leads only to a refusal.

let target: HTMLElement;
let component: Record<string, unknown> | undefined;
let trailStatus = 200;
let trailDown = false;
let trailPending = false;

beforeEach(() => {
	vi.stubGlobal('fetch', vi.fn(async (url: string) => {
		const u = String(url);
		if (u.includes('/access-trail') && trailDown) throw new TypeError('network down');
		if (u.includes('/access-trail') && trailPending) return new Promise<Response>(() => {});
		if (u.includes('/access-trail')) return new Response(JSON.stringify({ entries: [], before: null, complete: true }), { status: trailStatus });
		if (u.endsWith('/config')) return new Response(JSON.stringify({ managed: false }), { status: 200 });
		return new Response(JSON.stringify({}), { status: 200 });
	}));
	// The index asks for the viewport to hide mobile-only items; a desktop width here.
	vi.stubGlobal('matchMedia', (q: string) => ({ matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {} }));
	target = document.createElement('div');
	document.body.appendChild(target);
});

afterEach(() => {
	if (component) unmount(component);
	component = undefined;
	target.remove();
	vi.unstubAllGlobals();
	trailDown = false;
	trailPending = false;
});

async function render(): Promise<void> {
	const { default: SettingsIndex } = await import('./SettingsIndex.svelte');
	component = mount(SettingsIndex, { target });
	for (let i = 0; i < 10; i++) {
		await new Promise((r) => setTimeout(r, 0));
		await tick();
		flushSync();
	}
}

const hrefs = (): string[] => [...target.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '');

describe('the instance log item in settings', () => {
	it('is shown to the owner, whose session the log answers', async () => {
		trailStatus = 200;
		await render();
		expect(hrefs()).toContain('/app/settings/account/access-log');
	});

	it('is not shown to a helper, whose session the log refuses', async () => {
		trailStatus = 403;
		await render();
		expect(hrefs()).not.toContain('/app/settings/account/access-log');
		unmount(component!);
		trailStatus = 401;
		await render();
		expect(hrefs(), 'a session that is not accepted').not.toContain('/app/settings/account/access-log');
		// The control: the items around it are there.
		expect(hrefs()).toContain('/app/settings/account/security');
	});

	it('stays shown to the owner when the log has a passing error: only a refusal hides it', async () => {
		trailStatus = 500;
		await render();
		expect(hrefs()).toContain('/app/settings/account/access-log');
		unmount(component!);
		trailDown = true;
		await render();
		expect(hrefs(), 'a request that did not arrive').toContain('/app/settings/account/access-log');
		for (const status of [429, 503]) {
			unmount(component!);
			trailDown = false;
			trailStatus = status;
			await render();
			expect(hrefs(), `a ${String(status)}`).toContain('/app/settings/account/access-log');
		}
	});

	it('is not shown while the log has not answered yet', async () => {
		trailPending = true;
		await render();
		expect(hrefs()).not.toContain('/app/settings/account/access-log');
		expect(hrefs(), 'the control: the index itself is there').toContain('/app/settings/account/security');
	});
});
