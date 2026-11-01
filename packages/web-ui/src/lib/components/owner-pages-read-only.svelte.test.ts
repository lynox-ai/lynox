import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { t, tf, setLocale, getLocale } from '../i18n.svelte.js';
import { resetSettingsViewer } from '../stores/settings-viewer.svelte.js';

// ux U-109: the settings pages that save through their own owner-only routes, not `/config`.
// In a mandate's session a page with nothing the mandate may read is left out (heading only, and
// not in the navigation); a page it may read shows its values as text, without the form, and a
// page with parts of the mandate's own keeps those parts. Each page is mounted once per viewer.

// `svelte` resolves to its server entry under node, where `mount` throws and `onDestroy` has no
// context. The components are compiled for the client, so the client entry, loaded by path, stands
// in for `svelte` here: for mounting, and for the lifecycle calls the pages make themselves.
const CLIENT_ENTRY = vi.hoisted(() => {
	const { createRequire: req } = require('node:module') as typeof import('node:module');
	const { dirname: dir, join: jn } = require('node:path') as typeof import('node:path');
	return jn(dir(req(import.meta.url).resolve('svelte/package.json')), 'src/index-client.js');
});
vi.mock('svelte', async () => import(/* @vite-ignore */ CLIENT_ENTRY));
type SvelteClient = {
	mount: (c: unknown, o: { target: Element; props?: Record<string, unknown> }) => Record<string, unknown>;
	unmount: (c: Record<string, unknown>) => void;
	flushSync: () => void;
	tick: () => Promise<void>;
};
const { mount, unmount, flushSync, tick } = (await import(/* @vite-ignore */ CLIENT_ENTRY)) as SvelteClient;

type Viewer = 'mandate' | 'owner';
/** What each GET answers, by the end of its path; a function answers with its own Response. */
type Routes = Record<string, unknown>;

let target: HTMLElement;
let component: Record<string, unknown> | undefined;
const localeBefore = getLocale();
/** Every request a page sent other than a GET. */
let writes: string[];

beforeEach(() => {
	setLocale('de');
	resetSettingsViewer();
	writes = [];
	target = document.createElement('div');
	document.body.appendChild(target);
});

afterEach(() => {
	// A retry of an unanswered `/config` must not outlive the test.
	resetSettingsViewer();
	if (component) unmount(component);
	component = undefined;
	target.remove();
	vi.unstubAllGlobals();
	setLocale(localeBefore);
});

async function settle(): Promise<void> {
	for (let i = 0; i < 10; i++) {
		await new Promise((r) => setTimeout(r, 0));
		await tick();
		flushSync();
	}
}

/** The owner's list of secrets, refused to a mandate as the server does (`ownerOnly('list the secrets')`). */
const secretsFor = (viewer: Viewer, names: string[]) => () =>
	viewer === 'owner' ? Response.json({ names }) : Response.json({ error: 'Only the owner of this instance can list the secrets.' }, { status: 403 });

async function render(load: () => Promise<{ default: unknown }>, routes: Routes): Promise<void> {
	vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
		const path = String(url).split('?')[0]!;
		if (init?.method !== undefined && init.method !== 'GET') {
			writes.push(`${init.method} ${path}`);
			return Response.json({ error: 'Only the owner of this instance can do this.' }, { status: 403 });
		}
		const key = Object.keys(routes).find((k) => path.endsWith(k));
		if (key === undefined) return Response.json({ error: 'not found' }, { status: 404 });
		const answer = routes[key];
		return typeof answer === 'function' ? (answer as () => Response)() : Response.json(answer);
	}));
	const { default: Page } = await load();
	component = mount(Page, { target });
	await settle();
}

/**
 * `GET /api/config` held until `release()`: the page as it stands while the server has not said
 * whose session it is, then as the owner once it has.
 */
function heldConfig(): { route: () => Promise<Response>; release: () => void } {
	let release!: () => void;
	const gate = new Promise<void>((r) => { release = r; });
	return { route: async () => { await gate; return Response.json({ viewer: 'owner' }); }, release: () => release() };
}

function fields(): number {
	return target.querySelectorAll('input, select, textarea').length;
}
function buttonTexts(): string[] {
	return [...target.querySelectorAll('button')].map((b) => b.textContent?.trim() ?? '');
}
function notice(): Element | null {
	return target.querySelector('[data-testid="owner-only-notice"]');
}

describe('SecretsView (Settings › Keys)', () => {
	const load = () => import('./SecretsView.svelte');
	const routes = (viewer: Viewer) => ({ '/config': { viewer }, '/secrets': secretsFor(viewer, ['STRIPE_KEY']) });

	it('shows a mandate its heading only: no list, no form, no refusal', async () => {
		await render(load, routes('mandate'));
		expect(target.textContent).toContain(t('secrets.title'));
		expect(fields()).toBe(0);
		expect(buttonTexts()).toEqual([]);
		expect(target.textContent).not.toContain(t('secrets.no_admin'));
		expect(target.textContent).not.toContain('STRIPE_KEY');
		expect(writes).toEqual([]);
	});

	it('keeps the owner\'s list and form', async () => {
		await render(load, routes('owner'));
		expect(target.textContent).toContain('STRIPE_KEY');
		expect(fields()).toBeGreaterThan(0);
	});
});

describe('KeysView', () => {
	const load = () => import('./KeysView.svelte');
	const routes = (viewer: Viewer) => ({ '/config': { viewer }, '/secrets': secretsFor(viewer, ['ANTHROPIC_API_KEY']) });

	it('shows a mandate its heading only: no list, no form, no load error', async () => {
		await render(load, routes('mandate'));
		expect(target.textContent).toContain(t('keys.title'));
		expect(fields()).toBe(0);
		expect(buttonTexts()).toEqual([]);
		expect(target.textContent).not.toContain(t('common.load_failed'));
		expect(writes).toEqual([]);
	});

	it('keeps the owner\'s form', async () => {
		await render(load, routes('owner'));
		expect(target.textContent).toContain('ANTHROPIC_API_KEY');
		expect(fields()).toBeGreaterThan(0);
	});
});

describe('CalendarSettings', () => {
	const load = () => import('./CalendarSettings.svelte');
	const routes = (viewer: Viewer) => ({ '/config': { viewer }, '/secrets': secretsFor(viewer, ['CALENDAR_FEED_MAIN']) });

	it('shows a mandate its heading only: no feeds, no form, no load error', async () => {
		await render(load, routes('mandate'));
		expect(target.textContent).toContain(t('calendar.title'));
		expect(fields()).toBe(0);
		expect(buttonTexts()).toEqual([]);
		expect(target.textContent).not.toContain(t('calendar.where_title'));
		expect(target.textContent).not.toContain(t('calendar.load_failed'));
		expect(writes).toEqual([]);
	});

	it('keeps the owner\'s feeds and form', async () => {
		await render(load, routes('owner'));
		expect(target.textContent).toContain('MAIN');
		expect(fields()).toBeGreaterThan(0);
	});
});

describe('MailSettings', () => {
	const load = () => import('./MailSettings.svelte');
	const account = {
		id: 'info-example-com', displayName: 'Info — example.com', address: 'info@example.com', preset: 'custom',
		imap: { host: 'imap.example.com', port: 993, secure: true }, smtp: { host: 'smtp.example.com', port: 465, secure: true },
		hasCredentials: true, isDefault: false, type: 'personal', authType: 'imap', persona: '', receiveOnly: false,
	};
	const routes = (viewer: Viewer) => ({
		'/config': { viewer },
		'/mail/presets': { presets: [], accountTypes: [] },
		'/mail/accounts': { accounts: [account] },
	});

	it('shows a mandate the accounts as text under the sentence that names who connects one', async () => {
		await render(load, routes('mandate'));
		const sentence = target.querySelector('[data-testid="mail-owner-only"]');
		expect(sentence?.textContent?.trim()).toBe(tf('mail.owner_only_notice', { label: t('settings.channels.mail') }));
		// The sentence names a label the mandate can see: the page's own heading.
		expect(sentence?.textContent).toContain('„E-Mail“');
		expect(target.textContent).toContain('info@example.com');
		expect(sentence!.compareDocumentPosition(target.querySelector('[data-testid="mail-account-list"]')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(target.querySelector('[data-testid="mail-add-button"]')).toBeNull();
		expect(target.querySelector(`[data-testid="mail-delete-${account.id}"]`)).toBeNull();
		expect(target.querySelector(`[data-testid="mail-default-${account.id}"]`)).toBeNull();
		expect(fields()).toBe(0);
		expect(buttonTexts()).toEqual([]);
		expect(writes).toEqual([]);
	});

	it('offers no add, default or delete when the server has not said whose session it is', async () => {
		// The page waits for the answer before it lists; with none, the list shows without the owner's acts.
		await render(load, { ...routes('owner'), '/config': () => Response.json({ error: 'unavailable' }, { status: 503 }) });
		expect(target.textContent).toContain('info@example.com');
		expect(target.querySelector('[data-testid="mail-add-button"]')).toBeNull();
		expect(target.querySelector(`[data-testid="mail-delete-${account.id}"]`)).toBeNull();
		expect(target.querySelector(`[data-testid="mail-default-${account.id}"]`)).toBeNull();
		expect(target.querySelector('[data-testid="mail-owner-only"]')).toBeNull();
	});

	it('keeps the owner\'s add, default and delete', async () => {
		await render(load, routes('owner'));
		expect(target.querySelector('[data-testid="mail-owner-only"]')).toBeNull();
		expect(target.querySelector('[data-testid="mail-add-button"]')).not.toBeNull();
		expect(target.querySelector(`[data-testid="mail-delete-${account.id}"]`)).not.toBeNull();
		expect(target.querySelector(`[data-testid="mail-default-${account.id}"]`)).not.toBeNull();
	});
});

describe('RulesView (Settings › Email › Rules)', () => {
	const load = () => import('./RulesView.svelte');
	const rule = {
		id: 'r1', tenantId: 'default', accountId: 'info', matcherKind: 'from', matcherValue: 'news@shop.example',
		bucket: 'auto_handled', action: 'archive', source: 'user', createdAt: '2026-10-01T00:00:00Z',
	};
	const routes = (viewer: Viewer) => ({
		'/config': { viewer },
		'/inbox/counts': { counts: {} },
		'/mail/accounts': { accounts: [{ id: 'info', displayName: 'Info', address: 'info@example.com', isDefault: true }] },
		'/inbox/rules': { rules: [rule] },
	});

	it('shows a mandate the rules under the notice, without add or delete', async () => {
		await render(load, routes('mandate'));
		expect(notice()?.textContent?.trim()).toBe(t('settings.owner_only_notice'));
		expect(target.textContent).toContain('news@shop.example');
		expect(buttonTexts()).not.toContain(t('inbox.rules_add'));
		expect(target.querySelector(`button[aria-label="${t('inbox.rules_delete')}"]`)).toBeNull();
		expect(target.querySelector('form')).toBeNull();
		expect(writes).toEqual([]);
	});

	it('offers no add or delete until the server said it is the owner\'s session', async () => {
		const config = heldConfig();
		await render(load, { ...routes('owner'), '/config': config.route });
		expect(target.textContent).toContain('news@shop.example');
		expect(buttonTexts()).not.toContain(t('inbox.rules_add'));
		expect(target.querySelector(`button[aria-label="${t('inbox.rules_delete')}"]`)).toBeNull();
		config.release();
		await settle();
		expect(buttonTexts()).toContain(t('inbox.rules_add'));
		expect(target.querySelector(`button[aria-label="${t('inbox.rules_delete')}"]`)).not.toBeNull();
	});

	it('keeps the owner\'s add and delete', async () => {
		await render(load, routes('owner'));
		expect(notice()).toBeNull();
		expect(target.textContent).toContain('news@shop.example');
		expect(buttonTexts()).toContain(t('inbox.rules_add'));
		expect(target.querySelector(`button[aria-label="${t('inbox.rules_delete')}"]`)).not.toBeNull();
	});
});

describe('GoogleSettings', () => {
	const load = () => import('./GoogleSettings.svelte');
	const routes = (viewer: Viewer) => ({
		'/config': { viewer },
		'/google/status': { available: true, authenticated: true, scopes: ['https://www.googleapis.com/auth/gmail.readonly'] },
	});

	it('shows a mandate what the connection covers under the notice, without a button', async () => {
		await render(load, routes('mandate'));
		const shown = target.querySelector('[data-testid="google-read-only"]');
		expect(shown).not.toBeNull();
		expect(notice()?.textContent?.trim()).toBe(t('settings.owner_only_notice'));
		expect(shown!.textContent).toContain('Gmail');
		expect(target.textContent).toContain(t('integrations.connected'));
		expect(buttonTexts()).toEqual([]);
		expect(fields()).toBe(0);
		expect(writes).toEqual([]);
	});

	it('offers no control until the server said it is the owner\'s session', async () => {
		const config = heldConfig();
		await render(load, { ...routes('owner'), '/config': config.route });
		expect(buttonTexts()).toEqual([]);
		expect(fields()).toBe(0);
		config.release();
		await settle();
		expect(buttonTexts().length).toBeGreaterThan(0);
	});

	it('keeps the owner\'s controls', async () => {
		await render(load, routes('owner'));
		expect(target.querySelector('[data-testid="google-read-only"]')).toBeNull();
		expect(notice()).toBeNull();
		expect(buttonTexts().length).toBeGreaterThan(0);
	});
});

describe('ApiStoreView (Settings › API profiles)', () => {
	const load = () => import('./ApiStoreView.svelte');
	const revoked = { state: 'revoked', revoked_at: '2026-10-01T00:00:00Z' };
	const own = { id: 'crm', name: 'CRM', base_url: 'https://crm.example', description: '', auth: { type: 'oauth2' }, oauth_grant: revoked };
	const foreign = { id: 'erp', name: 'ERP', base_url: 'https://erp.example', description: '', auth: { type: 'oauth2', oauth: { preset_id: 'google' } }, oauth_grant: revoked };
	const routes = (viewer: Viewer) => ({
		'/config': { viewer },
		'/api-profiles': {
			profiles: [
				{ ...own, reader_may_connect: true },
				{ ...foreign, reader_may_connect: viewer === 'owner' },
			],
			importWaiting: [{ file: 'shop.json', reason: 'malformed', deleteId: 'shop' }],
		},
		// The app credentials of the built-in provider: the server refuses them to a mandate
		// (`ownerOnly('see the app credentials of a built-in provider')`).
		'/client': () => viewer === 'owner'
			? Response.json({ preset: 'google', client_id: null, client_secret_set: false, redirect_uri: 'https://app.example/cb' })
			: Response.json({ error: 'Only the owner of this instance can see the app credentials.' }, { status: 403 }),
	});
	const reconnect = (profileName: string): Element | null =>
		[...target.querySelectorAll('[data-testid="api-reconnect"]')].find((a) => a.closest('div.rounded-\\[var\\(--radius-md\\)\\]')?.textContent?.includes(profileName)) ?? null;

	it('shows a mandate the sentence, no delete, and the connect link only on a profile it set up', async () => {
		await render(load, routes('mandate'));
		expect(target.querySelector('[data-testid="apis-owner-only"]')?.textContent?.trim()).toBe(t('apis.owner_only_notice'));
		expect(buttonTexts()).not.toContain(t('apis.delete'));
		expect(reconnect('CRM')).not.toBeNull();
		expect(reconnect('ERP')).toBeNull();
		expect(target.querySelectorAll('[data-testid="api-reconnect"]').length).toBe(1);
		// Where the link is missing, the line says why: once, on the profile the mandate did not set up.
		const why = [...target.querySelectorAll('[data-testid="api-reconnect-not-yours"]')];
		expect(why.map((p) => p.textContent?.trim())).toEqual([t('apis.reconnect_not_yours')]);
		expect(why[0]!.closest('div.rounded-\\[var\\(--radius-md\\)\\]')?.textContent).toContain('ERP');
		// The built-in provider's app credentials are the owner's: no form on the foreign profile,
		// and not its own owner-only line either, which the page's sentence already says.
		expect(target.querySelector('[data-testid="preset-client-form"]')).toBeNull();
		expect(target.textContent).not.toContain(t('integrations.preset_client_owner_only'));
		expect(fields()).toBe(0);
		// Setting up and managing in chat stay the mandate's.
		expect(buttonTexts()).toContain(`+ ${t('apis.create_in_chat')}`);
		// The files the import waits on are the owner's to repair or delete.
		expect(target.querySelector('[data-testid="api-import-waiting"]')).toBeNull();
		expect(writes).toEqual([]);
	});

	it('offers no delete, app credentials or file repair until the server said it is the owner\'s session', async () => {
		const config = heldConfig();
		await render(load, { ...routes('owner'), '/config': config.route });
		expect(target.textContent, 'positive control: the profiles are listed').toContain('CRM');
		expect(target.textContent).toContain('ERP');
		expect(buttonTexts()).not.toContain(t('apis.delete'));
		expect(target.querySelector('[data-testid="preset-client-form"]')).toBeNull();
		expect(target.querySelector('[data-testid="api-import-waiting"]')).toBeNull();
		config.release();
		await settle();
		expect(buttonTexts().filter((b) => b === t('apis.delete')).length).toBe(2);
		expect(target.querySelector('[data-testid="preset-client-form"]')).not.toBeNull();
		expect(target.querySelector('[data-testid="api-import-waiting"]')).not.toBeNull();
	});

	it('keeps the owner\'s delete and connect links on every profile', async () => {
		await render(load, routes('owner'));
		expect(target.querySelector('[data-testid="apis-owner-only"]')).toBeNull();
		expect(buttonTexts().filter((b) => b === t('apis.delete')).length).toBe(2);
		expect(target.querySelectorAll('[data-testid="api-reconnect"]').length).toBe(2);
		expect(target.querySelector('[data-testid="preset-client-form"]')).not.toBeNull();
		expect(target.querySelector('[data-testid="api-import-waiting"]')).not.toBeNull();
		expect(target.querySelector('[data-testid="api-reconnect-not-yours"]')).toBeNull();
	});
});

describe('OnboardingSettings (Settings › Account › Onboarding)', () => {
	const load = () => import('./OnboardingSettings.svelte');
	const routes = (viewer: Viewer) => ({
		'/config': { viewer },
		'/onboarding/status': { knowledgeDone: true, knowledgeThreadId: null, skipped: false, pushNudge: null, firstSessionAt: null, degraded: false },
	});

	it('shows a mandate the status under the notice, without the restart button', async () => {
		await render(load, routes('mandate'));
		expect(notice()?.textContent?.trim()).toBe(t('settings.owner_only_notice'));
		expect(target.textContent).toContain(t('onboard.relayer_status_done'));
		expect(buttonTexts()).not.toContain(t('onboard.relayer_restart'));
		expect(writes).toEqual([]);
	});

	it('offers no restart until the server said it is the owner\'s session', async () => {
		const config = heldConfig();
		await render(load, { ...routes('owner'), '/config': config.route });
		expect(buttonTexts()).not.toContain(t('onboard.relayer_restart'));
		config.release();
		await settle();
		expect(buttonTexts()).toContain(t('onboard.relayer_restart'));
	});

	it('keeps the owner\'s restart button', async () => {
		await render(load, routes('owner'));
		expect(notice()).toBeNull();
		expect(buttonTexts()).toContain(t('onboard.relayer_restart'));
	});
});

describe('Navigation', () => {
	// The settings index asks whether it runs as an installed app; jsdom has no `matchMedia`.
	beforeEach(() => {
		Object.defineProperty(window, 'matchMedia', {
			configurable: true,
			value: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
		});
	});
	afterEach(() => {
		Reflect.deleteProperty(window, 'matchMedia');
	});
	const indexRoutes = (viewer: Viewer) => ({ '/config': { managed: null, viewer }, '/health': { version: '0.0.0-test' } });
	const hubRoutes = (viewer: Viewer) => ({ '/config': { viewer, capabilities: { has_calendar: true } } });
	const KEYS = 'a[href="/app/settings/llm/keys"]';
	const CALENDAR = 'a[href="/app/settings/channels/calendar"]';

	it('leaves the keys page out of a mandate\'s settings index', async () => {
		await render(() => import('./SettingsIndex.svelte'), indexRoutes('mandate'));
		expect(target.querySelector(KEYS)).toBeNull();
		// Twin within the same session: a page the mandate may read stays.
		expect(target.querySelector('a[href="/app/settings/apis"]')).not.toBeNull();
	});

	it('keeps it in the owner\'s', async () => {
		await render(() => import('./SettingsIndex.svelte'), indexRoutes('owner'));
		expect(target.querySelector(KEYS)).not.toBeNull();
	});

	it('leaves the calendar out of a mandate\'s channel list', async () => {
		await render(() => import('./ChannelHub.svelte'), hubRoutes('mandate'));
		expect(target.querySelector(CALENDAR)).toBeNull();
		expect(target.querySelector('a[href="/app/settings/channels/mail"]')).not.toBeNull();
	});

	it('keeps it in the owner\'s', async () => {
		await render(() => import('./ChannelHub.svelte'), hubRoutes('owner'));
		expect(target.querySelector(CALENDAR)).not.toBeNull();
	});
});
