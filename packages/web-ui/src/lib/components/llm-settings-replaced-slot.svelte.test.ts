import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { t, setLocale, getLocale } from '../i18n.svelte.js';
import { resetSettingsViewer } from '../stores/settings-viewer.svelte.js';

// ux U-118: when a tier's stored model is one this version no longer knows, the engine runs the
// strategy's model in its place and GET /api/config reports it (`replaced_tier_slots`). The page
// says so at that tier, in the names it shows: the owner with how to change it, a mandate without.

// As in settings-read-only: the client entry of `svelte`, loaded by path, mounts the component.
const CLIENT_ENTRY = join(dirname(createRequire(import.meta.url).resolve('svelte/package.json')), 'src/index-client.js');
type SvelteClient = {
	mount: (c: unknown, o: { target: Element }) => Record<string, unknown>;
	unmount: (c: Record<string, unknown>) => void;
	flushSync: () => void;
	tick: () => Promise<void>;
};
const { mount, unmount, flushSync, tick } = (await import(/* @vite-ignore */ CLIENT_ENTRY)) as SvelteClient;

let target: HTMLElement;
let component: Record<string, unknown> | undefined;
const localeBefore = getLocale();

beforeEach(() => {
	setLocale('de');
	resetSettingsViewer();
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

const anthropic = {
	provider: 'anthropic', display_name: 'Anthropic (Claude)', requires_base_url: false, requires_region: false,
	default_residency: 'US (Anthropic)', vault_slot: 'ANTHROPIC_API_KEY',
	models: [{ id: 'claude-opus-5', tier: 'opus', label: 'Claude Opus 5', context_window: 1_000_000, pricing: { input: 5, output: 25 }, residency: 'US' }],
	main_chat_models: [{ id: 'claude-opus-5', tier: 'deep' }],
};
const PRESET = {
	'max-quality': {
		name: 'max-quality', available: true,
		tiers: [
			{ tier: 'fast', model_id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
			{ tier: 'balanced', model_id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
			{ tier: 'deep', model_id: 'claude-opus-5', label: 'Claude Opus 5' },
		],
	},
};
const REPLACED = [{ tier: 'deep', model_id: 'claude-retired-model', runs: 'claude-opus-5' }];

async function render(viewer: 'owner' | 'mandate', replaced: unknown[] | undefined, extra: Record<string, unknown> = {}): Promise<void> {
	const config = {
		provider: 'anthropic', default_tier: 'deep', routing_mode: 'hybrid', tier_preset: 'max-quality',
		available_tier_presets: PRESET, managed: 'self-host', viewer,
		tier_set: { deep: { provider: 'anthropic', model_id: 'claude-retired-model' } },
		...(replaced ? { replaced_tier_slots: replaced } : {}),
		...extra,
	};
	vi.stubGlobal('fetch', vi.fn(async (url: string) => {
		const path = String(url).split('?')[0]!;
		if (path.endsWith('/llm/catalog')) return Response.json({ providers: [anthropic] });
		if (path.endsWith('/config')) return Response.json(config);
		if (path.endsWith('/secrets/status')) return Response.json({ configured: { api_key: true } });
		return Response.json({});
	}));
	const { default: Page } = await import('./LLMSettings.svelte');
	component = mount(Page, { target });
	for (let i = 0; i < 10; i++) {
		await new Promise((r) => setTimeout(r, 0));
		await tick();
		flushSync();
	}
}

const lines = (): string[] => [...target.querySelectorAll('[data-replaced-slot]')].map((el) => el.textContent?.trim() ?? '');

describe('a tier that runs another model than the stored one (ux U-118)', () => {
	it('the owner reads it at that tier, with the names the page shows and how to change it', async () => {
		await render('owner', REPLACED);
		expect(lines()).toEqual(['Das Modell claude-retired-model gibt es in dieser Version nicht mehr. Die Stufe „Tief“ läuft deshalb mit Claude Opus 5. Wähle hier ein anderes Modell, wenn du das nicht willst.']);
		// At the tier: the line follows that tier's row in the strategy's detail.
		const el = target.querySelector('[data-replaced-slot="deep"]')!;
		expect(el.previousElementSibling?.textContent).toContain(t('llm.tier.deep'));
	});

	it('a mandate reads the first two sentences only', async () => {
		await render('mandate', REPLACED);
		// Positive control in the same render: the mandate's read-only view is the one on screen.
		expect(target.querySelector('[data-testid="read-only-rows"]')).not.toBeNull();
		expect(lines()).toEqual(['Das Modell claude-retired-model gibt es in dieser Version nicht mehr. Die Stufe „Tief“ läuft deshalb mit Claude Opus 5.']);
	});

	it('no line when nothing is replaced, for either viewer', async () => {
		await render('owner', undefined);
		// Positive control: the strategy's tier detail is rendered, only the line is absent.
		expect(target.textContent).toContain('Claude Opus 5');
		expect(lines()).toEqual([]);
		unmount(component!);
		component = undefined;
		resetSettingsViewer();
		await render('mandate', []);
		expect(target.querySelector('[data-testid="read-only-rows"]')).not.toBeNull();
		expect(lines()).toEqual([]);
	});

	it('without a strategy detail to sit beside, the owner still reads it under the strategy cards', async () => {
		await render('owner', REPLACED, { tier_preset: null, available_tier_presets: {} });
		expect(lines()).toEqual(['Das Modell claude-retired-model gibt es in dieser Version nicht mehr. Die Stufe „Tief“ läuft deshalb mit claude-opus-5. Wähle hier ein anderes Modell, wenn du das nicht willst.']);
	});

	it('the English line', async () => {
		setLocale('en');
		await render('owner', REPLACED);
		expect(lines()).toEqual(['The model claude-retired-model is no longer available in this version, so the “Deep” tier runs with Claude Opus 5. Choose another model here if you do not want that.']);
	});
});
