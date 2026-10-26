import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const CLIENT_ENTRY = join(dirname(createRequire(import.meta.url).resolve('svelte/package.json')), 'src/index-client.js');
type SvelteClient = {
	mount: (c: unknown, o: { target: Element }) => Record<string, unknown>;
	unmount: (c: Record<string, unknown>) => void;
	flushSync: () => void;
	tick: () => Promise<void>;
};
const { mount, unmount, flushSync, tick } = (await import(/* @vite-ignore */ CLIENT_ENTRY)) as SvelteClient;

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));

// After a provider revoked a profile's grant, the API page says when, offers "Reconnect" (a link
// to the engine's connect route, loaded as a full page), and while an erasure is pending shows
// when it falls and what the owner was told. The notices come from an owner-only route: a refusal
// shows none.

const DAY = 24 * 3600 * 1000;
const revokedAtIso = new Date(Date.now() - DAY).toISOString();
const holdIso = new Date(Date.now() + 13 * DAY).toISOString();
const deadlineIso = new Date(Date.now() + 29 * DAY).toISOString();
const day = (iso: string): string => new Date(iso).toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit', year: 'numeric' });

const revokedProfile = { id: 'crm', name: 'CRM', base_url: 'https://crm.example', description: '', auth: { type: 'oauth2' }, oauth_grant: { state: 'revoked', revoked_at: revokedAtIso } };

let target: HTMLElement;
let component: Record<string, unknown> | undefined;

function serve(profiles: unknown[], records: { status: number; body?: unknown }): void {
	vi.stubGlobal('fetch', vi.fn(async (url: string) => {
		if (url.endsWith('/connections/records')) return new Response(JSON.stringify(records.body), { status: records.status, headers: { 'Content-Type': 'application/json' } });
		return new Response(JSON.stringify({ profiles }), { status: 200, headers: { 'Content-Type': 'application/json' } });
	}));
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

async function render(): Promise<void> {
	const { default: ApiStoreView } = await import('./ApiStoreView.svelte');
	component = mount(ApiStoreView, { target });
	for (let i = 0; i < 10; i++) {
		await new Promise((r) => setTimeout(r, 0));
		await tick();
		flushSync();
	}
}
const q = (id: string): HTMLElement | null => target.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe('a profile its provider revoked', () => {
	it('the owner with a pending erasure: revoked on, the window, the notice, and the button to the engine\'s connect route', async () => {
		serve([revokedProfile], { status: 200, body: { notices: [{ recordId: 7, connectionId: 'crm', holdUntil: holdIso, deadline: deadlineIso }] } });
		await render();
		expect(q('api-revoked')?.textContent).toContain(`Vom Anbieter widerrufen am ${day(revokedAtIso)}`);
		expect(q('api-erasure-window')?.textContent).toBe(`Löschung frühestens am ${day(holdIso)}, spätestens am ${day(deadlineIso)}`);
		expect(q('api-erasure-notice')?.textContent).toContain(`Wir löschen frühestens am ${day(holdIso)} und spätestens am ${day(deadlineIso)}.`);
		expect(q('api-erasure-notice')?.textContent).toContain('Wählst du innerhalb von 14 Tagen nach dem Widerruf beim Profil „Erneut verbinden“');
		const link = q('api-reconnect') as HTMLAnchorElement | null;
		expect(link?.textContent).toBe('Erneut verbinden');
		expect(link?.getAttribute('href')).toBe('/api/oauth/connect/crm');
		expect(link?.hasAttribute('data-sveltekit-reload')).toBe(true);
	});

	it('a refused records route (a mandate): revoked on and the button, no window and no notice', async () => {
		// A refusal is read as no notice, whatever its body holds.
		serve([revokedProfile], { status: 403, body: { notices: [{ recordId: 7, connectionId: 'crm', holdUntil: holdIso, deadline: deadlineIso }] } });
		await render();
		expect(q('api-revoked')).not.toBeNull();
		expect(q('api-reconnect')).not.toBeNull();
		expect(q('api-erasure-window')).toBeNull();
		expect(q('api-erasure-notice')).toBeNull();
	});

	it('a notice whose deadline has passed is not shown', async () => {
		serve([revokedProfile], { status: 200, body: { notices: [{ recordId: 7, connectionId: 'crm', holdUntil: new Date(Date.now() - 16 * DAY).toISOString(), deadline: new Date(Date.now() - 1000).toISOString() }] } });
		await render();
		expect(q('api-revoked')).not.toBeNull();
		expect(q('api-erasure-window')).toBeNull();
	});

	it('two pending erasures of one profile: from the earliest hold to the latest deadline', async () => {
		const laterHold = new Date(Date.now() + 20 * DAY).toISOString();
		const earlierDeadline = new Date(Date.now() + 25 * DAY).toISOString();
		serve([revokedProfile], { status: 200, body: { notices: [
			{ recordId: 7, connectionId: 'crm', holdUntil: laterHold, deadline: earlierDeadline },
			{ recordId: 8, connectionId: 'crm', holdUntil: holdIso, deadline: deadlineIso },
		] } });
		await render();
		expect(q('api-erasure-window')?.textContent).toBe(`Löschung frühestens am ${day(holdIso)}, spätestens am ${day(deadlineIso)}`);
	});

	it('the same two in the other order: the same span', async () => {
		const laterHold = new Date(Date.now() + 20 * DAY).toISOString();
		const earlierDeadline = new Date(Date.now() + 25 * DAY).toISOString();
		serve([revokedProfile], { status: 200, body: { notices: [
			{ recordId: 8, connectionId: 'crm', holdUntil: holdIso, deadline: deadlineIso },
			{ recordId: 7, connectionId: 'crm', holdUntil: laterHold, deadline: earlierDeadline },
		] } });
		await render();
		expect(q('api-erasure-window')?.textContent).toBe(`Löschung frühestens am ${day(holdIso)}, spätestens am ${day(deadlineIso)}`);
	});

	it('a notice of another profile does not show here', async () => {
		serve([revokedProfile], { status: 200, body: { notices: [{ recordId: 7, connectionId: 'other', holdUntil: holdIso, deadline: deadlineIso }] } });
		await render();
		expect(q('api-erasure-window')).toBeNull();
	});

	it('a profile that is not revoked shows none of it', async () => {
		serve([{ ...revokedProfile, oauth_grant: { state: 'connected', revoked_at: revokedAtIso } }], { status: 200, body: { notices: [{ recordId: 7, connectionId: 'crm', holdUntil: holdIso, deadline: deadlineIso }] } });
		await render();
		expect(q('api-revoked')).toBeNull();
		expect(q('api-reconnect')).toBeNull();
	});
});
