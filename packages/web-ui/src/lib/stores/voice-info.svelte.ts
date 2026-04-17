/**
 * Shared capability probe for /api/voice/info.
 *
 * Both ChatView (speaker button visibility, STT privacy-hint key) and
 * StatusBar (auto-speak toggle visibility) need to know what voice providers
 * are available. Running the probe twice is wasteful — this module owns a
 * single idempotent probe and exposes reactive accessors.
 */

import { getApiBase } from '../config.svelte.js';

export type SttProvider = 'mistral-voxtral' | 'whisper-cpp';

let sttAvailable = $state(false);
let sttProvider = $state<SttProvider | null>(null);
let ttsAvailable = $state(false);
let probed = false;
let inflight: Promise<void> | null = null;

async function doProbe(): Promise<void> {
	try {
		const res = await fetch(`${getApiBase()}/voice/info`);
		if (!res.ok) return;
		const data = (await res.json()) as {
			stt?: { available?: unknown; provider?: unknown } | undefined;
			tts?: { available?: unknown } | undefined;
		};
		const p = data.stt?.provider;
		if (p === 'mistral-voxtral' || p === 'whisper-cpp') sttProvider = p;
		if (data.stt?.available === true) sttAvailable = true;
		if (data.tts?.available === true) ttsAvailable = true;
	} catch {
		/* best-effort — UI stays in the disabled-by-default state on failure */
	}
}

/** Run the probe once per app session. Subsequent calls are no-ops. */
export function ensureVoiceInfoProbed(): Promise<void> {
	if (probed && !inflight) return Promise.resolve();
	if (!inflight) {
		probed = true;
		inflight = doProbe().finally(() => { inflight = null; });
	}
	return inflight;
}

export function isTtsAvailable(): boolean { return ttsAvailable; }
export function isSttAvailable(): boolean { return sttAvailable; }
export function getSttProvider(): SttProvider | null { return sttProvider; }
