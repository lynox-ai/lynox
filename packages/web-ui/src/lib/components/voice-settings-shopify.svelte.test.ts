import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { t, setLocale, getLocale } from '../i18n.svelte.js';

// `svelte` resolves to its server entry under node, where `mount` throws. The component is compiled
// for the client, so it is mounted with the client entry, loaded by path.
const CLIENT_ENTRY = join(dirname(createRequire(import.meta.url).resolve('svelte/package.json')), 'src/index-client.js');
type SvelteClient = {
	mount: (c: unknown, o: { target: Element }) => Record<string, unknown>;
	unmount: (c: Record<string, unknown>) => void;
	tick: () => Promise<void>;
};
const { mount, unmount, tick } = (await import(/* @vite-ignore */ CLIENT_ENTRY)) as SvelteClient;

// ux U-074: on an instance connected to a Shopify store no text goes to a speech service. The
// voice settings say so instead of the privacy notes, which name Mistral.

let target: HTMLElement;
let component: Record<string, unknown> | undefined;
const before = getLocale();

/** What GET /api/voice/info answers: with the switch on, Mistral is unavailable and `auto` only
 *  where it resolves to something (whisper.cpp for dictation, nothing for speech output). */
function voiceInfo(speechServiceOff: boolean, sttAvailable: boolean): unknown {
	const mistral = { id: 'mistral', name: 'Mistral Voxtral (Paris, EU)', available: !speechServiceOff };
	return {
		speech_service_off: speechServiceOff,
		stt: {
			available: sttAvailable, provider: sttAvailable ? 'whisper-cpp' : null, config_value: null, env_override: null,
			providers: [{ id: 'auto', name: 'Auto', available: !speechServiceOff || sttAvailable }, mistral, { id: 'whisper', name: 'whisper.cpp (local)', available: sttAvailable }],
		},
		tts: {
			available: !speechServiceOff, provider: null, voices: [], config_value: null, config_voice: null, env_override: null,
			providers: [{ id: 'auto', name: 'Auto', available: !speechServiceOff }, mistral],
		},
	};
}

async function render(info: unknown): Promise<string> {
	vi.stubGlobal('fetch', vi.fn(async (url: string) =>
		new Response(JSON.stringify(String(url).endsWith('/voice/info') ? info : {}), { status: 200, headers: { 'Content-Type': 'application/json' } })));
	const { default: VoiceSettings } = await import('./VoiceSettings.svelte');
	component = mount(VoiceSettings, { target });
	for (let i = 0; i < 10; i++) { await tick(); await new Promise((r) => setTimeout(r, 0)); }
	return target.textContent ?? '';
}

beforeEach(() => {
	setLocale('de');
	target = document.createElement('div');
	document.body.appendChild(target);
});

afterEach(() => {
	if (component) unmount(component);
	component = undefined;
	target.remove();
	vi.unstubAllGlobals();
	setLocale(before);
});

describe('voice settings on an instance connected to a Shopify store', () => {
	it('say why reading aloud is off, and do not claim that text goes to Mistral', async () => {
		const text = await render(voiceInfo(true, true));
		expect(text).toContain(t('voice.tts_off_shopify'));
		expect(text).not.toContain(t('voice.tts_privacy'));
		expect(text).not.toContain(t('voice.stt_off_shopify'));
		expect(text).not.toContain(t('voice.stt_privacy'));
		expect(text).toContain(t('voice.stt_local_shopify'));
	});

	it('on a managed instance do not say that voice runs on Mistral', async () => {
		const info = voiceInfo(true, true) as { stt: Record<string, unknown>; tts: Record<string, unknown> };
		info.stt['locked'] = true;
		info.tts['locked'] = true;
		const text = await render(info);
		expect(text).not.toContain(t('voice.managed_locked'));
		expect(text).toContain(t('voice.tts_off_shopify'));
	});

	it('add why dictation is off when the instance has no speech recognition of its own', async () => {
		const text = await render(voiceInfo(true, false));
		expect(target.querySelectorAll('section')[0]?.textContent).toContain(t('voice.stt_off_shopify'));
		// ux U-074: dictation has its own sentence, not the one about reading aloud.
		expect(target.querySelectorAll('section')[0]?.textContent).not.toContain(t('voice.tts_off_shopify'));
		expect(text).not.toContain(t('voice.stt_privacy'));
	});

	it('offer no picker and no save where nothing can be chosen', async () => {
		await render(voiceInfo(true, false));
		expect(target.querySelectorAll('select')).toHaveLength(0);
		expect(target.querySelector('button')).toBeNull();
	});

	it('with whisper.cpp on the instance offer dictation only, set to auto', async () => {
		await render(voiceInfo(true, true));
		const selects = target.querySelectorAll('select');
		expect(selects).toHaveLength(1);
		expect(selects[0]!.value).toBe('auto');
		expect(target.querySelector('button')?.textContent).toContain(t('voice.save'));
	});

	it('elsewhere keep the privacy notes and say nothing of a store', async () => {
		const text = await render(voiceInfo(false, true));
		expect(target.querySelectorAll('select')).toHaveLength(2);
		expect(text).toContain(t('voice.tts_privacy'));
		expect(text).toContain(t('voice.stt_privacy'));
		expect(text).not.toContain(t('voice.tts_off_shopify'));
	});

	it('elsewhere on a managed instance keep the managed note', async () => {
		const info = voiceInfo(false, true) as { stt: Record<string, unknown>; tts: Record<string, unknown> };
		info.stt['locked'] = true;
		const text = await render(info);
		expect(text).toContain(t('voice.managed_locked'));
	});
});
