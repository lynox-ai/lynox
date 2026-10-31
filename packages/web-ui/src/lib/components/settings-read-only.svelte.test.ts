import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { t, setLocale, getLocale } from '../i18n.svelte.js';
import { resetSettingsViewer } from '../stores/settings-viewer.svelte.js';

// ux U-104: in a mandate's session every settings page shows its values as text under a fixed
// notice, instead of fields whose save the server refuses (PUT /api/config is the owner's). In the
// owner's session the page keeps its fields. Each page is mounted twice, once per viewer.

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

function stubFetch(routes: Routes): void {
	vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
		const path = String(url).split('?')[0]!;
		if (init?.method !== undefined && init.method !== 'GET') {
			writes.push(`${init.method} ${path}`);
			return Response.json({ error: 'Only the owner of this instance can change the configuration.' }, { status: 403 });
		}
		const key = Object.keys(routes).find((k) => path.endsWith(k));
		if (key === undefined) return Response.json({ error: 'not found' }, { status: 404 });
		const answer = routes[key];
		return typeof answer === 'function' ? (answer as () => Response)() : Response.json(answer);
	}));
}

async function render(load: () => Promise<{ default: unknown }>, routes: Routes, props?: Record<string, unknown>): Promise<void> {
	stubFetch(routes);
	const { default: Page } = await load();
	component = mount(Page, { target, ...(props ? { props } : {}) });
	await settle();
}

/** The read-only rows as "Label: value" lines. */
function rows(): string[] {
	return [...target.querySelectorAll('[data-testid="read-only-rows"] > div')].map((row) =>
		`${row.querySelector('dt')?.textContent?.trim() ?? ''} ${row.querySelector('dd')?.textContent?.trim() ?? ''}`);
}
function line(label: string, value: string): string {
	return `${label}: ${value}`;
}
function notice(): Element | null {
	return target.querySelector('[data-testid="owner-only-notice"]');
}
function fields(): number {
	return target.querySelectorAll('input, select, textarea').length;
}
function buttonTexts(): string[] {
	return [...target.querySelectorAll('button')].map((b) => b.textContent?.trim() ?? '');
}

/** What a mandate's page must show: the notice above rows, and nothing to type into or save. */
function expectMandateView(saveText: string): void {
	const shown = notice();
	expect(shown?.textContent?.trim()).toBe(t('settings.owner_only_notice'));
	const rowsEl = target.querySelector('[data-testid="read-only-rows"]');
	expect(rowsEl).not.toBeNull();
	// The notice comes first.
	expect(shown!.compareDocumentPosition(rowsEl!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	expect(fields()).toBe(0);
	expect(buttonTexts()).not.toContain(saveText);
	expect(target.querySelectorAll('[role="switch"]').length).toBe(0);
	expect(writes).toEqual([]);
}

/** What an owner's page must show: no notice, no rows, and its fields. */
function expectOwnerView(): void {
	expect(notice()).toBeNull();
	expect(target.querySelector('[data-testid="read-only-rows"]')).toBeNull();
	expect(fields() + target.querySelectorAll('[role="switch"]').length).toBeGreaterThan(0);
}

const SELF_HOST = 'self-host';

describe('LLMMemoryView', () => {
	const load = () => import('./LLMMemoryView.svelte');
	const config = (viewer: Viewer) => ({ '/config': { memory_extraction: true, memory_half_life_days: 45, viewer } });

	it('shows a mandate the two dials as text', async () => {
		await render(load, config('mandate'));
		// Here, in the test body: the notice is what a mandate's page shows first.
		expect(notice()?.textContent?.trim()).toBe(t('settings.owner_only_notice'));
		expect(target.querySelector('[data-testid="read-only-rows"]')).not.toBeNull();
		expectMandateView(t('llm.save'));
		expect(rows()).toEqual([line(t('config.memory_extraction'), t('settings.value_on')), line(t('config.memory_half_life'), '45')]);
	});

	it('keeps the owner\'s fields', async () => {
		await render(load, config('owner'));
		expectOwnerView();
		expect(buttonTexts()).toContain(t('llm.save'));
	});
});

describe('WorkspaceUpdatesView', () => {
	const load = () => import('./WorkspaceUpdatesView.svelte');
	const config = (viewer: Viewer) => ({ '/config': { update_check: true, managed: SELF_HOST, viewer } });

	it('shows a mandate the update check as text', async () => {
		await render(load, config('mandate'));
		// Here, in the test body: the notice is what a mandate's page shows first.
		expect(notice()?.textContent?.trim()).toBe(t('settings.owner_only_notice'));
		expect(target.querySelector('[data-testid="read-only-rows"]')).not.toBeNull();
		expectMandateView(t('settings.save'));
		expect(rows()).toEqual([line(t('system.update_label'), t('settings.value_on'))]);
	});

	it('keeps the owner\'s checkbox', async () => {
		await render(load, config('owner'));
		expectOwnerView();
	});
});

describe('SystemSettings', () => {
	const load = () => import('./SystemSettings.svelte');
	const routes = (viewer: Viewer) => ({ '/config': { update_check: false, managed: SELF_HOST, viewer }, '/vault/key': { configured: true } });

	it('shows a mandate the update check as text, and no way to reveal the vault key or the token', async () => {
		await render(load, routes('mandate'));
		// Here, in the test body: the notice is what a mandate's page shows first.
		expect(notice()?.textContent?.trim()).toBe(t('settings.owner_only_notice'));
		expect(target.querySelector('[data-testid="read-only-rows"]')).not.toBeNull();
		expectMandateView(t('settings.save'));
		expect(rows()).toEqual([line(t('system.update_label'), t('settings.value_off'))]);
		expect(buttonTexts()).not.toContain(t('system.vault_reveal'));
		expect(buttonTexts()).not.toContain(t('system.token_reveal'));
	});

	it('keeps the owner\'s checkbox and reveal buttons', async () => {
		await render(load, routes('owner'));
		expectOwnerView();
		expect(buttonTexts()).toContain(t('system.vault_reveal'));
	});
});

describe('WorkspaceLimitsView', () => {
	const load = () => import('./WorkspaceLimitsView.svelte');
	const config = (viewer: Viewer) => ({
		'/config': { max_monthly_cost_usd: 50, max_daily_cost_usd: 5, max_http_requests_per_hour: 300, managed: SELF_HOST, viewer },
	});

	it('shows a mandate the limits as text, and an empty one as not set', async () => {
		await render(load, config('mandate'));
		// Here, in the test body: the notice is what a mandate's page shows first.
		expect(notice()?.textContent?.trim()).toBe(t('settings.owner_only_notice'));
		expect(target.querySelector('[data-testid="read-only-rows"]')).not.toBeNull();
		expectMandateView(t('cost_limits.save'));
		expect(rows()).toEqual([
			line(t('config.monthly_limit'), '50'),
			line(t('config.daily_limit'), '5'),
			line(t('config.session_limit'), t('settings.value_not_set')),
			line(t('config.http_rate_limit'), '300'),
		]);
	});

	it('keeps the owner\'s fields and save', async () => {
		await render(load, config('owner'));
		expectOwnerView();
		expect(buttonTexts()).toContain(t('cost_limits.save'));
	});
});

describe('PrivacyDataSettings', () => {
	const load = () => import('./PrivacyDataSettings.svelte');
	const config = (viewer: Viewer) => ({
		'/config': { managed: SELF_HOST, bugsink_enabled: false, bugsink_dsn_configured: true, debug_wire_capture: true, viewer },
	});

	it('shows a mandate the two switches as text, and no delete request', async () => {
		await render(load, config('mandate'));
		// Here, in the test body: the notice is what a mandate's page shows first.
		expect(notice()?.textContent?.trim()).toBe(t('settings.owner_only_notice'));
		expect(target.querySelector('[data-testid="read-only-rows"]')).not.toBeNull();
		expectMandateView(t('settings.save'));
		expect(rows()).toEqual([line(t('privacy.bugsink_label'), t('settings.value_off')), line(t('privacy.wire_capture_label'), t('settings.value_on'))]);
		expect(buttonTexts()).not.toContain(t('privacy.delete_button'));
	});

	it('keeps the owner\'s checkboxes', async () => {
		await render(load, config('owner'));
		expectOwnerView();
		expect(buttonTexts()).toContain(t('privacy.delete_button'));
	});
});

describe('ToolToggles', () => {
	const load = () => import('./ToolToggles.svelte');
	const routes = (viewer: Viewer) => ({
		'/tools/available': { tools: [{ name: 'web_research', description: 'Search the web.' }, { name: 'bash', description: 'Run a shell command.' }] },
		'/config': { disabled_tools: ['bash'], viewer },
	});

	it('shows a mandate each tool as on or off', async () => {
		await render(load, routes('mandate'));
		// Here, in the test body: the notice is what a mandate's page shows first.
		expect(notice()?.textContent?.trim()).toBe(t('settings.owner_only_notice'));
		expect(target.querySelector('[data-testid="read-only-rows"]')).not.toBeNull();
		expectMandateView(t('settings.save'));
		expect(rows()).toEqual([line('web_research', t('settings.value_on')), line('bash', t('settings.value_off'))]);
	});

	it('keeps the owner\'s switches', async () => {
		await render(load, routes('owner'));
		expectOwnerView();
		expect(target.querySelectorAll('[role="switch"]').length).toBe(2);
	});
});

describe('VoiceSettings', () => {
	const load = () => import('./VoiceSettings.svelte');
	const mistral = { id: 'mistral', name: 'Mistral Voxtral (Paris, EU)', available: true };
	const routes = (viewer: Viewer) => ({
		'/voice/info': {
			speech_service_off: false,
			stt: { available: true, provider: 'mistral', config_value: 'mistral', env_override: null, providers: [{ id: 'auto', name: 'Auto', available: true }, mistral] },
			tts: { available: true, provider: 'mistral', config_value: null, config_voice: 'paul', env_override: null, voices: [{ id: 'paul', language: 'de' }], providers: [{ id: 'auto', name: 'Auto', available: true }, mistral] },
		},
		'/config': { transcription_provider: 'mistral', tts_provider: 'auto', tts_voice: 'paul', viewer },
	});

	it('shows a mandate the chosen providers by their visible names, not their codes', async () => {
		await render(load, routes('mandate'));
		// Here, in the test body: the notice is what a mandate's page shows first.
		expect(notice()?.textContent?.trim()).toBe(t('settings.owner_only_notice'));
		expect(target.querySelector('[data-testid="read-only-rows"]')).not.toBeNull();
		expectMandateView(t('voice.save'));
		expect(rows()).toEqual([
			line(t('voice.stt_heading'), 'Mistral Voxtral (Paris, EU)'),
			line(t('voice.tts_heading'), 'Auto'),
			line(t('voice.tts_voice'), 'paul (de)'),
		]);
	});

	it('keeps the owner\'s pickers', async () => {
		await render(load, routes('owner'));
		expectOwnerView();
		expect(buttonTexts()).toContain(t('voice.save'));
	});
});

describe('BackupsView', () => {
	const load = () => import('./BackupsView.svelte');
	const backup = { backup_id: 'b1', version: '2.17.0', created_at: '2026-10-30T08:00:00Z', encrypted: true, files: [{ path: 'history.db', size_bytes: 2048 }], checksum: 'x' };
	const routes = (viewer: Viewer) => ({
		'/backups': { backups: [backup] },
		'/config': { backup_retention_days: 14, backup_encrypt: true, managed: SELF_HOST, viewer },
	});

	it('shows a mandate the list and the settings as text, without create, restore or save', async () => {
		await render(load, routes('mandate'));
		// Here, in the test body: the notice is what a mandate's page shows first.
		expect(notice()?.textContent?.trim()).toBe(t('settings.owner_only_notice'));
		expect(target.querySelector('[data-testid="read-only-rows"]')).not.toBeNull();
		expectMandateView(t('settings.save'));
		expect(rows()).toEqual([line(t('config.backup_retention'), '14'), line(t('config.backup_encrypt'), t('settings.value_on'))]);
		expect(buttonTexts()).toEqual([]);
		// The list is a read and stays.
		expect(target.textContent).toContain('v2.17.0');
	});

	it('keeps the owner\'s fields, create and restore', async () => {
		await render(load, routes('owner'));
		expectOwnerView();
		expect(buttonTexts()).toEqual(expect.arrayContaining([t('backups.create'), t('backups.restore'), t('settings.save')]));
	});
});

describe('NotificationsSettings', () => {
	const load = () => import('./NotificationsSettings.svelte');
	const routes = (viewer: Viewer) => ({
		'/inbox/notification-prefs': {
			inboxPushEnabled: true,
			quietHours: { enabled: true, start: '22:00', end: '07:00', tz: 'Europe/Zurich' },
			perMinute: 2,
			perHour: 20,
			accounts: [],
		},
		'/config': { managed: 'hosted', escalation_mail: false, viewer },
	});
	// The push store asks whether the app runs installed; jsdom has no `matchMedia`.
	beforeEach(() => {
		Object.defineProperty(window, 'matchMedia', {
			configurable: true,
			value: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
		});
	});
	afterEach(() => {
		Reflect.deleteProperty(window, 'matchMedia');
	});

	it('shows a mandate the push settings and the escalation mail as text', async () => {
		await render(load, routes('mandate'));
		// Here, in the test body: the notice is what a mandate's page shows first.
		expect(notice()?.textContent?.trim()).toBe(t('settings.owner_only_notice'));
		expect(target.querySelector('[data-testid="read-only-rows"]')).not.toBeNull();
		expectMandateView(t('settings.save'));
		expect(rows()).toEqual([
			line(t('integrations.push_inbox_toggle'), t('settings.value_on')),
			line(t('integrations.push_quiet_hours_toggle'), `${t('settings.value_on')} (${t('integrations.push_quiet_hours_from')} 22:00 ${t('integrations.push_quiet_hours_to')} 07:00, Europe/Zurich)`),
			line(t('integrations.push_throttle_title'), `2 ${t('integrations.push_throttle_per_minute')}, 20 ${t('integrations.push_throttle_per_hour')}`),
			line(t('notifications.escalation_mail_heading'), t('settings.value_off')),
		]);
	});

	it('leaves a mandate its own push on this device, with the owner\'s part below the notice', async () => {
		// Push on this device is the mandate's own: /push/subscribe is not owner-only, and the
		// subscription ends with the grant. The page is mixed, so the notice covers only the rest.
		vi.stubGlobal('PushManager', function PushManager() {});
		vi.stubGlobal('Notification', { permission: 'default' });
		Object.defineProperty(navigator, 'serviceWorker', {
			configurable: true,
			value: { ready: Promise.resolve({ pushManager: { getSubscription: async () => null } }) },
		});
		try {
			await render(load, routes('mandate'));
			const enable = [...target.querySelectorAll('button')].find((b) => b.textContent?.trim() === t('integrations.push_enable'));
			expect(enable).toBeDefined();
			expect(enable!.disabled).toBe(false);
			const shown = notice();
			expect(shown).not.toBeNull();
			// The notice sits below the mandate's own part, above the owner's.
			expect(enable!.compareDocumentPosition(shown!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
			expect(rows()).toContain(line(t('notifications.escalation_mail_heading'), t('settings.value_off')));
		} finally {
			Reflect.deleteProperty(navigator, 'serviceWorker');
		}
	});

	it('keeps the owner\'s escalation mail checkbox', async () => {
		await render(load, routes('owner'));
		expectOwnerView();
		expect(target.querySelector('[data-escalation-mail] input[type="checkbox"]')).not.toBeNull();
	});
});

describe('SearchSettings', () => {
	const load = () => import('./SearchSettings.svelte');
	const routes = (viewer: Viewer) => ({
		// Set only by the environment: the config file has no URL, the status read names it.
		'/config': { managed: SELF_HOST, viewer },
		// A mandate may read the status too (`READS`), as the owner's card does.
		'/secrets/status': viewer === 'owner'
			? { configured: { search: false, api_key: true, searxng: false }, searxng_url: null }
			: { configured: { search: false, api_key: true, searxng: true }, searxng_url: 'http://u:pw@searx.internal:8888/?token=abc' },
	});

	it('shows a mandate the SearXNG URL as text, without save, removal or check', async () => {
		await render(load, routes('mandate'));
		// Here, in the test body: the notice is what a mandate's page shows first.
		expect(notice()?.textContent?.trim()).toBe(t('settings.owner_only_notice'));
		expect(target.querySelector('[data-testid="read-only-rows"]')).not.toBeNull();
		expectMandateView(t('settings.save'));
		// The owner entered the URL; a mandate reads where it points, not its credentials or query.
		expect(rows()).toEqual([line(t('integrations.searxng_label'), 'http://searx.internal:8888')]);
		expect(target.textContent).not.toContain('pw@');
		expect(target.textContent).not.toContain('token=abc');
		expect(buttonTexts()).toEqual([]);
	});

	it('keeps the owner\'s URL field', async () => {
		await render(load, routes('owner'));
		expectOwnerView();
		expect(target.querySelector('#searxng-url')).not.toBeNull();
	});
});

describe('LLMAdvancedView', () => {
	const load = () => import('./LLMAdvancedView.svelte');
	const activeModel = {
		id: 'claude-sonnet-4-6', tier: 'sonnet', provider: 'anthropic', contextWindow: 1_000_000, defaultMaxOutput: 64_000, maxContinuations: 3,
		features: { vision: true, extendedThinking: true, toolUse: true, promptCaching: true, pdfInput: true }, uiLabel: 'Claude Sonnet 4.6',
	};
	const config = (viewer: Viewer) => ({ '/config': { effort_level: 'medium', thinking_mode: 'disabled', managed: SELF_HOST, active_model: activeModel, viewer } });

	it('shows a mandate each choice by its visible option text, not its code', async () => {
		await render(load, config('mandate'));
		// Here, in the test body: the notice is what a mandate's page shows first.
		expect(notice()?.textContent?.trim()).toBe(t('settings.owner_only_notice'));
		expect(target.querySelector('[data-testid="read-only-rows"]')).not.toBeNull();
		expectMandateView(t('llm.save'));
		expect(rows()).toEqual([
			line(t('config.effort'), t('config.effort_medium')),
			line(t('config.thinking'), t('config.thinking_disabled')),
			line(t('config.embedding_provider'), t('config.embedding_onnx')),
		]);
	});

	it('leaves the notice to the page it is embedded in', async () => {
		await render(load, config('mandate'), { embedded: true });
		expect(notice()).toBeNull();
		expect(rows().length).toBe(3);
		expect(fields()).toBe(0);
	});

	it('keeps the owner\'s selects', async () => {
		await render(load, config('owner'));
		expectOwnerView();
		expect(buttonTexts()).toContain(t('llm.save'));
	});
});

describe('LLMSettings', () => {
	const load = () => import('./LLMSettings.svelte');
	// A key-shaped marker, built at run time so no key-shaped literal sits in the source.
	const KEY_MARKER = ['sk', 'ant', 'api03', 'readonly', 'marker'].join('-');
	const anthropic = {
		provider: 'anthropic', display_name: 'Anthropic (Claude)', requires_base_url: false, requires_region: false,
		default_residency: 'US (Anthropic)', vault_slot: 'ANTHROPIC_API_KEY',
		models: [
			{ id: 'claude-sonnet-4-6', tier: 'sonnet', label: 'Claude Sonnet 4.6', context_window: 1_000_000, pricing: { input: 3, output: 15 }, residency: 'US' },
			{ id: 'claude-opus-4-7', tier: 'opus', label: 'Claude Opus 4.7', context_window: 1_000_000, pricing: { input: 5, output: 25 }, residency: 'US' },
		],
		main_chat_models: [{ id: 'claude-sonnet-4-6', tier: 'balanced' }, { id: 'claude-opus-4-7', tier: 'deep' }],
	};
	const routes = (viewer: Viewer) => ({
		'/llm/catalog': { providers: [anthropic] },
		// A body that carries a key where none belongs: the read-only view must not show it.
		'/config': {
			provider: 'anthropic', default_tier: 'deep', routing_mode: 'standard', tier_preset: null, available_tier_presets: {},
			managed: SELF_HOST, api_key: KEY_MARKER, tier_set: { deep: { provider: 'anthropic', model_id: 'claude-opus-4-7', api_key: KEY_MARKER } }, viewer,
		},
		'/secrets/status': viewer === 'owner' ? { configured: { api_key: true } } : () => Response.json({ error: 'owner only' }, { status: 403 }),
	});

	it('shows a mandate strategy, provider and model by their visible names', async () => {
		await render(load, routes('mandate'));
		// Here, in the test body: the notice is what a mandate's page shows first.
		expect(notice()?.textContent?.trim()).toBe(t('settings.owner_only_notice'));
		expect(target.querySelector('[data-testid="read-only-rows"]')).not.toBeNull();
		expectMandateView(t('llm.save'));
		expect(rows()).toEqual([
			line(t('llm.preset.heading'), t('llm.preset.standard')),
			line(t('llm.provider_heading'), 'Anthropic (Claude)'),
			line(t('llm.main_model.heading'), 'Claude Opus 4.7'),
			line(t('llm.residency'), 'US (Anthropic)'),
		]);
	});

	it('never shows a mandate a key, and offers no connection test (it calls a model)', async () => {
		await render(load, routes('mandate'));
		expect(target.textContent).not.toContain(KEY_MARKER);
		expect(target.textContent).not.toContain(t('llm.api_key'));
		expect(buttonTexts()).not.toContain(t('llm.test_connection'));
		expect(target.querySelector('input[type="password"]')).toBeNull();
	});

	it('keeps the owner\'s key field, tiles and connection test', async () => {
		await render(load, routes('owner'));
		expectOwnerView();
		expect(target.querySelector('input[type="password"]')).not.toBeNull();
		expect(buttonTexts()).toContain(t('llm.test_connection'));
	});
});

describe('endpointText — an endpoint the owner entered, as a mandate reads it', () => {
	it('keeps scheme, host and path, and drops credentials, a query and a fragment', async () => {
		const { endpointText } = await import('./settings-readonly/values.js');
		expect(endpointText('https://user:secret@api.example.com/v1?key=abc#x')).toBe('https://api.example.com/v1');
		expect(endpointText('http://localhost:11434')).toBe('http://localhost:11434');
		// Not a URL the browser parses: the same parts go by the last `@` and the first `?` or `#`.
		expect(endpointText('u:p@ss@h.example.com/v1?k=1')).toBe('h.example.com/v1');
		expect(endpointText('')).toBe(t('settings.value_not_set'));
		expect(endpointText(null)).toBe(t('settings.value_not_set'));
	});
});

describe('SetupBanner', () => {
	const load = () => import('./SetupBanner.svelte');
	// No key on this instance. A mandate may read the status (`READS`), so the banner has to ask
	// whose session it is: setting up the provider is the owner's.
	const routes = (viewer: Viewer) => ({
		'/secrets/status': { provider: 'anthropic', managed: null, configured: { api_key: false } },
		'/config': { managed: SELF_HOST, viewer },
	});

	it('shows a mandate no banner and no key wizard when no key is set', async () => {
		await render(load, routes('mandate'));
		expect(document.body.innerHTML).not.toContain('Claude (Anthropic)');
		expect(target.textContent).not.toContain(t('banner.api_key_missing'));
		expect(fields()).toBe(0);
		expect(writes).toEqual([]);
	});

	it('opens the owner the key wizard when no key is set', async () => {
		// Not dismissed before: the wizard opens straight away, at the provider choice.
		await render(load, routes('owner'));
		expect(document.body.innerHTML).toContain('Claude (Anthropic)');
	});
});

describe('WorkspaceSecurityView', () => {
	const load = () => import('./WorkspaceSecurityView.svelte');
	const routes = (viewer: Viewer) => ({
		'/config': { managed: SELF_HOST, viewer },
		'/vault/key': { configured: true },
	});

	it('shows a mandate only the notice: both values are secrets, and no reveal button', async () => {
		await render(load, routes('mandate'));
		expect(notice()?.textContent?.trim()).toBe(t('settings.owner_only_notice'));
		expect(buttonTexts()).toEqual([]);
		expect(writes).toEqual([]);
	});

	it('keeps the owner\'s reveal buttons', async () => {
		await render(load, routes('owner'));
		expect(notice()).toBeNull();
		expect(buttonTexts().length).toBeGreaterThan(0);
	});
});
