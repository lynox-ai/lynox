import { describe, it, expect, vi, afterEach } from 'vitest';
import { isMandateSession, isOwnerSession, loadSettingsViewer, noteSettingsViewer, resetSettingsViewer } from '$lib/stores/settings-viewer.svelte.js';

// Signing in reaches `/app` without a reload (the forms post through `use:enhance`), so whose
// session the pages served before is forgotten when the sign-in page opens: after an expired
// session, someone else may sign in in the same tab.

const CLIENT_ENTRY = vi.hoisted(() => {
	const { createRequire: req } = require('node:module') as typeof import('node:module');
	const { dirname: dir, join: jn } = require('node:path') as typeof import('node:path');
	return jn(dir(req(import.meta.url).resolve('svelte/package.json')), 'src/index-client.js');
});
vi.mock('svelte', async () => import(/* @vite-ignore */ CLIENT_ENTRY));
type SvelteClient = {
	mount: (c: unknown, o: { target: Element; props?: Record<string, unknown> }) => Record<string, unknown>;
	unmount: (c: Record<string, unknown>) => void;
};

let component: Record<string, unknown> | undefined;
let svelte: SvelteClient;
const target = document.createElement('div');

afterEach(() => {
	vi.unstubAllGlobals();
	if (component) svelte.unmount(component);
	component = undefined;
	resetSettingsViewer();
});

describe('the sign-in page', () => {
	it.each(['owner', 'mandate'] as const)('forgets a %s session the pages served before', async (viewer) => {
		svelte = (await import('svelte')) as unknown as SvelteClient;
		noteSettingsViewer({ viewer });
		expect(viewer === 'owner' ? isOwnerSession() : isMandateSession(), 'positive control: the store knew it').toBe(true);
		const { default: Login } = await import('./+page.svelte');
		component = svelte.mount(Login, { target, props: { data: { hasPasskeys: false, isManaged: false }, form: null } });
		expect(isOwnerSession()).toBe(false);
		expect(isMandateSession()).toBe(false);
	});

	it('takes the owner who signs in after a mandate, in the same page load', async () => {
		svelte = (await import('svelte')) as unknown as SvelteClient;
		noteSettingsViewer({ viewer: 'mandate' });
		const { default: Login } = await import('./+page.svelte');
		component = svelte.mount(Login, { target, props: { data: { hasPasskeys: false, isManaged: false }, form: null } });
		// The owner signs in; the next page asks whose session it is.
		vi.stubGlobal('fetch', vi.fn(async () => Response.json({ viewer: 'owner' })));
		await loadSettingsViewer();
		expect(isMandateSession()).toBe(false);
		expect(isOwnerSession()).toBe(true);
	});
});
