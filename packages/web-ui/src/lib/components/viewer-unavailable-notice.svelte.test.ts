import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { t, setLocale, getLocale } from '../i18n.svelte.js';
import { resetSettingsViewer } from '../stores/settings-viewer.svelte.js';

// ux U-117: when the page asked whose session it is and the first request and every retry went
// unanswered, the owner is not left without the actions and without a reason: the page says once
// that it could not load completely. Not while it waits, not after an answer.

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
const localeBefore = getLocale();

/** The rules page; `/config` answers with `config(n)` on its n-th request. */
async function rulesPage(config: (n: number) => Response): Promise<void> {
	let asked = 0;
	vi.stubGlobal('fetch', vi.fn(async (url: string) => {
		const path = String(url).split('?')[0]!;
		if (path.endsWith('/config')) return config(++asked);
		if (path.endsWith('/inbox/rules')) return Response.json({ rules: [{ id: 'r1', tenantId: 'default', accountId: 'info', matcherKind: 'from', matcherValue: 'news@shop.example', bucket: 'auto_handled', action: 'archive', source: 'user', createdAt: '2026-10-01T00:00:00Z' }] });
		if (path.endsWith('/mail/accounts')) return Response.json({ accounts: [{ id: 'info', displayName: 'Info', address: 'info@example.com', isDefault: true }] });
		if (path.endsWith('/inbox/counts')) return Response.json({ counts: {} });
		return Response.json({ error: 'not found' }, { status: 404 });
	}));
	component = mount((await import('./RulesView.svelte')).default, { target });
	await advance(0);
}

async function advance(ms: number): Promise<void> {
	await vi.advanceTimersByTimeAsync(ms);
	flushSync();
}

const notice = (): Element | null => target.querySelector('[data-testid="viewer-unavailable"]');
const down = (): Response => Response.json({ error: 'unavailable' }, { status: 503 });

beforeEach(() => {
	vi.useFakeTimers();
	setLocale('de');
	resetSettingsViewer();
	target = document.createElement('div');
	document.body.appendChild(target);
});

afterEach(() => {
	if (component) unmount(component);
	component = undefined;
	target.remove();
	resetSettingsViewer();
	vi.useRealTimers();
	vi.unstubAllGlobals();
	setLocale(localeBefore);
});

describe('the sentence when whose session it is stays unknown', () => {
	it('appears once every try went unanswered, and not while the page still tries', async () => {
		await rulesPage(down);
		expect(notice()).toBeNull();
		await advance(1_000 + 3_000);
		expect(notice()).toBeNull();
		await advance(10_000);
		expect(target.querySelectorAll('[data-testid="viewer-unavailable"]')).toHaveLength(1);
		expect(notice()?.textContent?.trim()).toBe(t('settings.viewer_unavailable'));
		expect(notice()?.textContent?.trim()).toBe('Diese Seite konnte nicht vollständig geladen werden. Lade sie neu.');
	});

	it('does not appear when the second request is answered', async () => {
		await rulesPage((n) => (n === 1 ? down() : Response.json({ viewer: 'owner' })));
		await advance(60_000);
		expect(notice()).toBeNull();
		// Positive control: the answer arrived, the owner's add is there.
		expect([...target.querySelectorAll('button')].map((b) => b.textContent?.trim())).toContain(t('inbox.rules_add'));
	});

	it.each([
		['MailSettings', () => import('./MailSettings.svelte')],
		['RulesView', () => import('./RulesView.svelte')],
		['GoogleSettings', () => import('./GoogleSettings.svelte')],
		['ApiStoreView', () => import('./ApiStoreView.svelte')],
		['OnboardingSettings', () => import('./OnboardingSettings.svelte')],
		['BackupsView', () => import('./BackupsView.svelte')],
	] as const)('stands at the top of %s once every try went unanswered', async (_name, load) => {
		// Each list answers empty; `/config` never answers.
		const lists: Record<string, unknown> = {
			'/mail/accounts': { accounts: [] }, '/mail/presets': { presets: [], accountTypes: [] },
			'/api-profiles': { profiles: [], importWaiting: [] }, '/connections/records': { records: [] },
			'/inbox/rules': { rules: [] }, '/inbox/counts': { counts: {} }, '/backups': { backups: [] },
		};
		vi.stubGlobal('fetch', vi.fn(async (url: string) => {
			const path = String(url).split('?')[0]!;
			if (path.endsWith('/config')) return down();
			const key = Object.keys(lists).find((k) => path.endsWith(k));
			return Response.json(key === undefined ? {} : lists[key]);
		}));
		component = mount((await load()).default, { target });
		await advance(60_000);
		expect(target.querySelectorAll('[data-testid="viewer-unavailable"]')).toHaveLength(1);
	});
});
