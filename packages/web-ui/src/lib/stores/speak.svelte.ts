/**
 * Speak (TTS) playback store.
 *
 * Single-playback rule: starting a new utterance cancels any previous fetch
 * and stops any currently-playing audio. Only one message can be in
 * synthesizing or playing state at a time across the whole UI.
 *
 * Transport: POST /api/speak (SSE). Frames:
 *   { status: 'synthesizing' }   — TTFB signal, fire once
 *   { chunk: '<base64 MP3>' }    — repeated
 *   { done: true, ... }          — final
 *   { error: '...' }             — on failure
 *
 * Playback strategy — two paths selected by browser capability:
 *
 *   - **MSE progressive** (Chrome/Edge/Firefox; iOS Safari 17.1+). Each
 *     SSE chunk is `appendBuffer()`'d onto a MediaSource-backed <audio>,
 *     so playback starts ~100 ms after the first chunk arrives — a second
 *     after the click, independent of total reply length. This is the fast
 *     path and matches what the user expects from a "read aloud" button.
 *   - **Blob fallback** (older Safari, rare MSE-less browsers). Chunks are
 *     collected into a single MP3 blob, then played at the end of the
 *     stream. Same correctness, higher perceived latency — user waits the
 *     full stream duration before audio starts.
 *
 * Capability detection is synchronous at call time (`MediaSource.isTypeSupported`).
 * If MSE throws mid-stream we return an error rather than falling back —
 * re-fetching would double the Mistral bill, and graceful errors are cheap.
 */

import { getApiBase } from '../config.svelte.js';
import { addToast } from './toast.svelte.js';

export type SpeakState = 'idle' | 'synthesizing' | 'playing';

let state = $state<SpeakState>('idle');
let activeKey = $state<string | null>(null);

let audioEl: HTMLAudioElement | null = null;
let abortCtrl: AbortController | null = null;
let objectUrl: string | null = null;

const PRIVACY_HINT_KEY = 'lynox_tts_privacy_seen';
const PRIVACY_HINT_DURATION_MS = 8000;

export function getSpeakState(): SpeakState {
	return state;
}

export function isSpeakActive(key: string): boolean {
	return activeKey === key;
}

/**
 * Surface the "Audio is synthesized by Mistral (Paris, EU)" privacy hint
 * once per browser on the first TTS playback. Caller passes the translated
 * string so this store doesn't need to pull in the i18n module.
 */
export function maybeShowPrivacyHint(translatedHint: string): void {
	try {
		if (typeof localStorage === 'undefined') return;
		if (localStorage.getItem(PRIVACY_HINT_KEY)) return;
		addToast(translatedHint, 'info', PRIVACY_HINT_DURATION_MS);
		localStorage.setItem(PRIVACY_HINT_KEY, '1');
	} catch { /* localStorage unavailable — skip silently */ }
}

export function stopSpeech(): void {
	if (abortCtrl) { abortCtrl.abort(); abortCtrl = null; }
	if (audioEl) {
		audioEl.pause();
		audioEl.src = '';
		audioEl = null;
	}
	if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
	state = 'idle';
	activeKey = null;
}

function canUseMse(): boolean {
	try {
		return typeof MediaSource !== 'undefined'
			&& typeof MediaSource.isTypeSupported === 'function'
			&& MediaSource.isTypeSupported('audio/mpeg');
	} catch { return false; }
}

/**
 * Start TTS for `text`. Playback begins as soon as audio data is decodable
 * (MSE path: ~100 ms after first chunk; Blob path: after full stream).
 * Returns null on success or an error message the caller can surface.
 */
export async function playSpeech(text: string, key: string): Promise<string | null> {
	stopSpeech();
	state = 'synthesizing';
	activeKey = key;

	const ctrl = new AbortController();
	abortCtrl = ctrl;

	let res: Response;
	try {
		res = await fetch(`${getApiBase()}/speak`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ text }),
			signal: ctrl.signal,
		});
	} catch {
		if (ctrl.signal.aborted) return null;
		resetOnError();
		return 'Network error';
	}

	if (!res.ok || !res.body) {
		resetOnError();
		return `HTTP ${res.status}`;
	}

	return canUseMse()
		? playViaMse(res.body, ctrl)
		: playViaBlob(res.body, ctrl);
}

async function playViaMse(body: ReadableStream<Uint8Array>, ctrl: AbortController): Promise<string | null> {
	const audio = new Audio();
	audioEl = audio;
	const ms = new MediaSource();
	const url = URL.createObjectURL(ms);
	objectUrl = url;
	audio.src = url;

	audio.onended = () => {
		if (audioEl === audio) {
			if (objectUrl === url) { URL.revokeObjectURL(url); objectUrl = null; }
			audioEl = null;
			state = 'idle';
			activeKey = null;
			abortCtrl = null;
		}
	};
	audio.onerror = () => { if (audioEl === audio) resetOnError(); };
	audio.onplaying = () => { if (audioEl === audio) state = 'playing'; };

	let sb: SourceBuffer | null = null;
	const queue: Uint8Array[] = [];
	let streamEnded = false;
	let sourceOpenErr: string | null = null;

	const flush = (): void => {
		if (!sb || sb.updating) return;
		const next = queue.shift();
		if (next) {
			try { sb.appendBuffer(next as BufferSource); } catch { /* malformed chunk — skip */ }
			return;
		}
		if (streamEnded && ms.readyState === 'open') {
			try { ms.endOfStream(); } catch { /* already ended / closed */ }
		}
	};

	const sourceOpen = new Promise<void>((resolve) => {
		ms.addEventListener('sourceopen', () => {
			try {
				sb = ms.addSourceBuffer('audio/mpeg');
				sb.addEventListener('updateend', flush);
			} catch (e) {
				sourceOpenErr = e instanceof Error ? e.message : 'MediaSource setup failed';
			}
			resolve();
		}, { once: true });
	});

	// Kick off playback — browser waits on the MediaSource until buffered.
	audio.play().catch(() => {
		if (audioEl === audio && !ctrl.signal.aborted) resetOnError();
	});

	await sourceOpen;
	if (sourceOpenErr) { resetOnError(); return sourceOpenErr; }

	try {
		for await (const frame of parseSseFrames(body)) {
			if (ctrl.signal.aborted) return null;
			if (frame.error) { resetOnError(); return frame.error; }
			if (frame.chunk) {
				queue.push(base64ToBytes(frame.chunk));
				flush();
			}
			if (frame.done) break;
		}
	} catch {
		if (ctrl.signal.aborted) return null;
		resetOnError();
		return 'Stream error';
	}

	streamEnded = true;
	flush();
	return null;
}

async function playViaBlob(body: ReadableStream<Uint8Array>, ctrl: AbortController): Promise<string | null> {
	const mp3Parts: Uint8Array[] = [];
	let errorMsg: string | null = null;

	try {
		for await (const frame of parseSseFrames(body)) {
			if (ctrl.signal.aborted) return null;
			if (frame.error) { errorMsg = frame.error; break; }
			if (frame.chunk) mp3Parts.push(base64ToBytes(frame.chunk));
			if (frame.done) break;
		}
	} catch {
		if (ctrl.signal.aborted) return null;
		resetOnError();
		return 'Stream error';
	}

	if (ctrl.signal.aborted) return null;
	if (errorMsg) { resetOnError(); return errorMsg; }
	if (mp3Parts.length === 0) { resetOnError(); return 'No audio received'; }

	const blob = new Blob(mp3Parts as BlobPart[], { type: 'audio/mpeg' });
	const url = URL.createObjectURL(blob);
	objectUrl = url;

	const audio = new Audio(url);
	audioEl = audio;
	audio.onended = () => {
		if (audioEl === audio) {
			if (objectUrl === url) { URL.revokeObjectURL(url); objectUrl = null; }
			audioEl = null;
			state = 'idle';
			activeKey = null;
			abortCtrl = null;
		}
	};
	audio.onerror = () => { if (audioEl === audio) resetOnError(); };

	state = 'playing';
	try {
		await audio.play();
	} catch {
		resetOnError();
		return 'Playback blocked';
	}
	return null;
}

function resetOnError(): void {
	if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
	audioEl = null;
	abortCtrl = null;
	state = 'idle';
	activeKey = null;
}

function base64ToBytes(b64: string): Uint8Array {
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

interface SseFrame { status?: string; chunk?: string; done?: boolean; error?: string }

async function* parseSseFrames(stream: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame, void, void> {
	const reader = stream.getReader();
	const decoder = new TextDecoder('utf-8');
	let buf = '';
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			buf += decoder.decode(value, { stream: true });
			let idx: number;
			while ((idx = findFrameEnd(buf)) >= 0) {
				const frame = buf.slice(0, idx);
				buf = buf.slice(idx).replace(/^(?:\r?\n){1,2}/, '');
				const data = extractDataPayload(frame);
				if (!data) continue;
				try {
					yield JSON.parse(data) as SseFrame;
				} catch { /* skip malformed frame */ }
			}
		}
	} finally {
		reader.releaseLock();
	}
}

function findFrameEnd(buf: string): number {
	const a = buf.indexOf('\n\n');
	const b = buf.indexOf('\r\n\r\n');
	if (a < 0) return b;
	if (b < 0) return a;
	return Math.min(a, b);
}

function extractDataPayload(frame: string): string | null {
	const lines: string[] = [];
	for (const raw of frame.split(/\r?\n/)) {
		if (raw.startsWith('data:')) lines.push(raw.slice(5).replace(/^ /, ''));
	}
	return lines.length > 0 ? lines.join('\n') : null;
}
