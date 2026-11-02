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
	refreshFails = false;
	refreshHangs = null;
	keepOnPut = false;
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
let refreshFails = false;
let refreshHangs: Promise<void> | null = null;
let keepOnPut = false;
const REPLACED = [{ tier: 'deep', model_id: 'claude-retired-model', runs: 'claude-opus-5' }];

async function render(viewer: 'owner' | 'mandate', replaced: unknown[] | undefined, extra: Record<string, unknown> = {}): Promise<void> {
	const config = {
		provider: 'anthropic', default_tier: 'deep', routing_mode: 'hybrid', tier_preset: 'max-quality',
		available_tier_presets: PRESET, managed: 'self-host', viewer,
		tier_set: { deep: { provider: 'anthropic', model_id: 'claude-retired-model' } },
		...(replaced ? { replaced_tier_slots: replaced } : {}),
		...extra,
	};
	let put = false;
	vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
		const path = String(url).split('?')[0]!;
		if (refreshHangs && init?.method !== 'PUT' && path.endsWith('/config') && put) {
			// The answer describes the config as it was when asked, and arrives when the test says so.
			const asked = JSON.parse(JSON.stringify(config)) as unknown;
			await refreshHangs;
			return Response.json(asked);
		}
		if (refreshFails && init?.method !== 'PUT' && path.endsWith('/config') && put) return new Response('', { status: 500 });
		if (init?.method === 'PUT') {
			put = true;
			// The saved config no longer carries the retired model, so the engine replaces nothing.
			if (path.endsWith('/config') && !keepOnPut) delete (config as Record<string, unknown>)['replaced_tier_slots'];
			return Response.json({ ok: true });
		}
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

async function settle(): Promise<void> {
	for (let i = 0; i < 10; i++) {
		await new Promise((r) => setTimeout(r, 0));
		await tick();
		flushSync();
	}
}
const radios = (): HTMLButtonElement[] => [...target.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
const card = (label: string): HTMLButtonElement => radios().find((b) => b.textContent?.includes(label))!;
const lines = (): string[] => [...target.querySelectorAll('[data-replaced-slot]')].map((el) => el.textContent?.trim() ?? '');

describe('a tier that runs another model than the stored one (ux U-118)', () => {
	it('the owner reads it at that tier, with the names the page shows and how to change it', async () => {
		await render('owner', REPLACED);
		expect(lines()).toEqual(['Das Modell claude-retired-model gibt es in dieser Version nicht mehr. Die Stufe „Tief“ läuft deshalb mit Claude Opus 5. Willst du das nicht, wähle „Eigene“ und dort ein anderes Modell für diese Stufe.']);
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
		// The stored preset is not among the ones the server offers, so there is no detail panel.
		await render('owner', REPLACED, { available_tier_presets: {} });
		expect(target.querySelector('[role="radio"][aria-checked="true"]')).not.toBeNull();
		expect(lines()).toEqual(['Das Modell claude-retired-model gibt es in dieser Version nicht mehr. Die Stufe „Tief“ läuft deshalb mit claude-opus-5. Willst du das nicht, wähle „Eigene“ und dort ein anderes Modell für diese Stufe.']);
	});

	it('the English line', async () => {
		setLocale('en');
		await render('owner', REPLACED);
		expect(lines()).toEqual(['The model claude-retired-model is no longer available in this version, so the “Deep” tier runs with Claude Opus 5. If you do not want that, choose “Custom” and pick another model for this tier.']);
	});
	it('while another card is only being tried, the line leaves; back on the stored one, it returns', async () => {
		await render('owner', REPLACED);
		const stored = radios().find((b) => b.getAttribute('aria-checked') === 'true')!;
		expect(lines()).toHaveLength(1);
		card(t('llm.preset.custom')).click();
		await settle();
		expect(card(t('llm.preset.custom')).getAttribute('aria-checked')).toBe('true');
		expect(lines()).toEqual([]);
		stored.click();
		await settle();
		expect(lines()).toHaveLength(1);
	});

	it('after a save the page asks the engine again, and the line leaves once nothing is replaced', async () => {
		await render('owner', REPLACED);
		const stored = radios().find((b) => b.getAttribute('aria-checked') === 'true')!;
		// Try another card and come back: the page has something to save, on the same strategy.
		card(t('llm.preset.custom')).click();
		await settle();
		stored.click();
		await settle();
		expect(lines()).toHaveLength(1);
		const save = [...target.querySelectorAll('button')].find((b) => b.textContent?.trim() === t('llm.save'))!;
		expect(save).toBeDefined();
		save.click();
		await settle();
		const fetchMock = fetch as unknown as { mock: { calls: [string, RequestInit?][] } };
		expect(fetchMock.mock.calls.some(([u, i]) => i?.method === 'PUT' && String(u).endsWith('/config'))).toBe(true);
		expect(lines()).toEqual([]);
	});

	it('a replaced tier the strategy detail has no row for still gets its line there', async () => {
		const twoRows = { 'max-quality': { ...PRESET['max-quality'], tiers: PRESET['max-quality'].tiers.filter((x) => x.tier !== 'deep') } };
		await render('owner', REPLACED, { available_tier_presets: twoRows });
		// Positive control: the detail panel is on screen, without a deep row.
		expect(target.textContent).toContain('Claude Sonnet 5');
		expect(lines()).toEqual(['Das Modell claude-retired-model gibt es in dieser Version nicht mehr. Die Stufe „Tief“ läuft deshalb mit claude-opus-5. Willst du das nicht, wähle „Eigene“ und dort ein anderes Modell für diese Stufe.']);
	});
	it('after a save to another preset, the old line leaves even when the engine cannot be asked again', async () => {
		const efficient = { name: 'efficient', available: true, tiers: [{ tier: 'deep', model_id: 'claude-sonnet-5', label: 'Claude Sonnet 5' }] };
		await render('owner', REPLACED, { available_tier_presets: { ...PRESET, efficient } });
		expect(lines()).toHaveLength(1);
		refreshFails = true;
		card(t('llm.preset.efficient')).click();
		await settle();
		expect(card(t('llm.preset.efficient')).getAttribute('aria-checked')).toBe('true');
		const save = [...target.querySelectorAll('button')].find((b) => b.textContent?.trim() === t('llm.save'))!;
		save.click();
		await settle();
		const fetchMock = fetch as unknown as { mock: { calls: [string, RequestInit?][] } };
		expect(fetchMock.mock.calls.some(([u, i]) => i?.method === 'PUT' && String(u).endsWith('/config'))).toBe(true);
		// Positive control: the new preset's detail is on screen, and it is the stored one now.
		expect(target.textContent).toContain('Claude Sonnet 5');
		// The page did ask again after the save, and that request failed (the mock answers it 500).
		const calls = fetchMock.mock.calls.map(([u, i]) => `${i?.method ?? 'GET'} ${String(u).split('?')[0]}`);
		const putAt = calls.findIndex((c) => c.startsWith('PUT ') && c.endsWith('/config'));
		expect(calls.slice(putAt + 1).some((c) => c.startsWith('GET ') && c.endsWith('/config'))).toBe(true);
		// The line said "runs with Claude Opus 5", what max-quality ran; under efficient that is false.
		expect(lines()).toEqual([]);
	});
	it('under a locked provider the owner reads the first two sentences only: no card leads to Custom there', async () => {
		await render('owner', REPLACED, { locks: { provider: { reason: 'Set by the operator.' } } });
		// Positive control: the strategy cards are there and every one is disabled.
		expect(radios().length).toBeGreaterThan(0);
		expect(radios().every((b) => b.disabled)).toBe(true);
		expect(lines()).toEqual(['Das Modell claude-retired-model gibt es in dieser Version nicht mehr. Die Stufe „Tief“ läuft deshalb mit Claude Opus 5.']);
	});
	it('an answer to an earlier save that arrives after a later one is not taken', async () => {
		const efficient = { name: 'efficient', available: true, tiers: [{ tier: 'deep', model_id: 'claude-sonnet-5', label: 'Claude Sonnet 5' }] };
		await render('owner', REPLACED, { available_tier_presets: { ...PRESET, efficient } });
		keepOnPut = true;
		const stored = radios().find((b) => b.getAttribute('aria-checked') === 'true')!;
		const saveButton = (): HTMLButtonElement =>
			[...target.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === t('llm.save'))!;
		// Save 1, on max-quality: its re-check is asked now (while max-quality still replaces deep) and held back.
		card(t('llm.preset.custom')).click();
		await settle();
		stored.click();
		await settle();
		let answer!: () => void;
		refreshHangs = new Promise<void>((r) => { answer = r; });
		saveButton().click();
		await settle();
		// Save 2, to efficient: its own re-check fails.
		refreshHangs = null;
		refreshFails = true;
		card(t('llm.preset.efficient')).click();
		await settle();
		saveButton().click();
		await settle();
		const fetchMock = fetch as unknown as { mock: { calls: [string, RequestInit?][] } };
		expect(fetchMock.mock.calls.filter(([u, i]) => i?.method === 'PUT' && String(u).endsWith('/config'))).toHaveLength(2);
		expect(lines()).toEqual([]);
		// Now the answer to save 1 arrives. It describes max-quality; under efficient it is false.
		answer();
		await settle();
		// Positive control: efficient's detail with a deep row is on screen, where the line would sit.
		expect(target.textContent).toContain('Claude Sonnet 5');
		expect(lines()).toEqual([]);
	});
});
