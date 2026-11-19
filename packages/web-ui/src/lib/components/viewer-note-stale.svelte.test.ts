import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isOwnerSession, isMandateSession, resetSettingsViewer } from '../stores/settings-viewer.svelte.js';

// A page that reads `GET /api/config` itself must not set whose session it is from a body asked for
// before a sign-in reset. The channels hub stands for the 17 pages that do this; the detector
// next to this file holds them all to `viewerNote()`.

const CLIENT_ENTRY = vi.hoisted(() => {
	const { createRequire: req } = require('node:module') as typeof import('node:module');
	const { dirname: dir, join: jn } = require('node:path') as typeof import('node:path');
	return jn(dir(req(import.meta.url).resolve('svelte/package.json')), 'src/index-client.js');
});
vi.mock('svelte', async () => import(/* @vite-ignore */ CLIENT_ENTRY));
type SvelteClient = {
	mount: (c: unknown, o: { target: Element }) => Record<string, unknown>;
	unmount: (c: Record<string, unknown>) => void;
	flushSync: () => void;
};
const { mount, unmount, flushSync } = (await import(/* @vite-ignore */ CLIENT_ENTRY)) as SvelteClient;

let target: HTMLElement;
let component: Record<string, unknown> | undefined;

/** Mounts the hub with `/config` held; returns the function that lets it answer. */
async function hubWithHeldConfig(): Promise<(body: unknown) => Promise<void>> {
	let release!: (r: Response) => void;
	const held = new Promise<Response>((resolve) => { release = resolve; });
	vi.stubGlobal('fetch', vi.fn(async () => held));
	component = mount((await import('./ChannelHub.svelte')).default, { target });
	flushSync();
	await new Promise((r) => setTimeout(r, 0));
	return async (body) => {
		release(Response.json(body));
		for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
		flushSync();
	};
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
	resetSettingsViewer();
	vi.unstubAllGlobals();
});

describe('a /config body asked for before a reset', () => {
	it('does not set the viewer when it arrives after the reset', async () => {
		const answer = await hubWithHeldConfig();
		resetSettingsViewer();
		await answer({ viewer: 'owner' });
		expect(isOwnerSession()).toBe(false);
		expect(isMandateSession()).toBe(false);
	});

	it('twin: the same body without a reset sets it', async () => {
		const answer = await hubWithHeldConfig();
		await answer({ viewer: 'owner' });
		expect(isOwnerSession()).toBe(true);
	});
});
