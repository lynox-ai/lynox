import { describe, it, expect, vi, afterEach } from 'vitest';

// ux U-074: the chat hides the mic exactly when the instance sends no audio to a speech service
// and has no speech recognition of its own (`ChatView.svelte › micHidden`). The store reads both
// from /api/voice/info once per app session, so each case loads a fresh module.

async function probe(info: unknown): Promise<typeof import('./voice-info.svelte.js')> {
	vi.resetModules();
	vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(info), { status: 200, headers: { 'Content-Type': 'application/json' } })));
	const store = await import('./voice-info.svelte.js');
	await store.ensureVoiceInfoProbed();
	return store;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('voice info store', () => {
	it('reports an instance connected to a Shopify store without speech recognition', async () => {
		const store = await probe({ speech_service_off: true, stt: { available: false, provider: null }, tts: { available: false } });
		expect(store.isSpeechServiceOff()).toBe(true);
		expect(store.isSttAvailable()).toBe(false);
		expect(store.isTtsAvailable()).toBe(false);
	});

	it('keeps dictation on such an instance when whisper.cpp runs there', async () => {
		const store = await probe({ speech_service_off: true, stt: { available: true, provider: 'whisper-cpp' }, tts: { available: false } });
		expect(store.isSpeechServiceOff()).toBe(true);
		expect(store.isSttAvailable()).toBe(true);
		expect(store.getSttProvider()).toBe('whisper-cpp');
	});

	it('says nothing of a store elsewhere, or when an older engine sends no flag', async () => {
		const store = await probe({ stt: { available: true, provider: 'mistral-voxtral' }, tts: { available: true } });
		expect(store.isSpeechServiceOff()).toBe(false);
	});
});
