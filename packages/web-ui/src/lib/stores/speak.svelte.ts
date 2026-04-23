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
 *   - **Web Audio API** (primary, all modern browsers incl. iOS Safari 17+).
 *     Each chunk is handed to `AudioContext.decodeAudioData`, which returns a
 *     real `AudioBuffer` with the MP3's native sample rate. We then schedule
 *     that buffer on an `AudioBufferSourceNode` starting at a running clock
 *     (`nextStartTime`), so playback is gapless and sample-accurate. Starts
 *     ~100 ms after the first chunk decodes. Previous MSE path (removed
 *     2026-04-21) concatenated raw MP3 frames into an `audio/mpeg`
 *     `SourceBuffer` — MSE mis-times multi-stream MP3 and drifted faster +
 *     unintelligible as the reply grew. Web Audio decodes each chunk with
 *     its real header, so the drift is impossible by construction.
 *   - **Blob fallback** (AudioContext-less environments, rare). Chunks are
 *     collected into one MP3 blob, then played at the end of the stream.
 *     Same correctness, higher perceived latency.
 *
 * Accumulator: if `decodeAudioData` rejects on a chunk (cut mid-frame), we
 * buffer those bytes and retry on the next arrival. In practice Mistral
 * sends self-contained frames per delta, so decode succeeds on the first
 * try; the accumulator exists as a belt for provider surprises.
 */

import { getApiBase } from '../config.svelte.js';
import { addToast } from './toast.svelte.js';

export type SpeakState = 'idle' | 'synthesizing' | 'playing';

let state = $state<SpeakState>('idle');
let activeKey = $state<string | null>(null);

let audioEl: HTMLAudioElement | null = null;
let audioContext: AudioContext | null = null;
let abortCtrl: AbortController | null = null;
let objectUrl: string | null = null;

// FIFO queue for `playSpeechQueued` callers (auto-speak per-block playback).
// When the current playback ends, the next entry is dequeued and played.
// Cleared by `stopSpeech` so a manual cancel wipes pending blocks too.
const playbackQueue: Array<{ text: string; key: string }> = [];

function drainQueue(): void {
	const next = playbackQueue.shift();
	if (next) {
		void playSpeech(next.text, next.key);
	}
}

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
	if (audioContext) {
		// Closing an AudioContext implicitly stops every scheduled buffer source —
		// no need to track + stop them individually.
		try { void audioContext.close(); } catch { /* already closed */ }
		audioContext = null;
	}
	if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
	// Manual stop → drop any auto-speak items the user no longer wants.
	playbackQueue.length = 0;
	state = 'idle';
	activeKey = null;
}

/**
 * Enqueue a TTS playback. If idle, fires immediately; if synthesizing or
 * playing, appends to a FIFO queue that drains on playback end. Used by
 * auto-speak so the assistant can speak block-N while the model is still
 * writing block-(N+1) under a tool call. Manual `playSpeech` (speaker
 * button) is unchanged: it interrupts whatever is playing.
 */
export async function playSpeechQueued(text: string, key: string): Promise<string | null> {
	if (state === 'idle') {
		return playSpeech(text, key);
	}
	// De-dupe: skip if this key is already active or queued (rapid re-renders
	// can otherwise enqueue the same block twice).
	if (activeKey === key) return null;
	if (playbackQueue.some(q => q.key === key)) return null;
	playbackQueue.push({ text, key });
	return null;
}

interface WindowWithWebkitAudio extends Window {
	webkitAudioContext?: typeof AudioContext;
}

function getAudioCtxCtor(): typeof AudioContext | null {
	if (typeof window === 'undefined') return null;
	if (typeof AudioContext !== 'undefined') return AudioContext;
	const w = window as WindowWithWebkitAudio;
	return w.webkitAudioContext ?? null;
}

/**
 * Start TTS for `text`. Playback begins as soon as audio data is decodable
 * (~100 ms after first chunk on Web Audio path). Returns null on success or
 * an error message the caller can surface.
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

	return getAudioCtxCtor()
		? playViaWebAudio(res.body, ctrl)
		: playViaBlob(res.body, ctrl);
}

async function playViaWebAudio(body: ReadableStream<Uint8Array>, ctrl: AbortController): Promise<string | null> {
	const Ctor = getAudioCtxCtor();
	if (!Ctor) return playViaBlob(body, ctrl);

	const ctx = new Ctor();
	audioContext = ctx;
	// Chrome's autoplay policy lands fresh contexts in `suspended` unless the
	// originating click bubbled synchronously into the constructor. We're
	// already async (awaited fetch) before this point, so explicitly resume.
	try { await ctx.resume(); } catch { /* ignore — playback may still work */ }

	let nextStartTime = 0;
	let started = false;
	let pending: Uint8Array | null = null;
	let lastSource: AudioBufferSourceNode | null = null;

	const scheduleBuffer = (buf: AudioBuffer): void => {
		if (audioContext !== ctx) return; // stopped meanwhile
		const src = ctx.createBufferSource();
		src.buffer = buf;
		src.connect(ctx.destination);
		// First chunk: anchor the clock to now. Subsequent chunks: tail-to-tail.
		// If `nextStartTime` slipped below `currentTime` (tab blur, decode
		// stall), re-anchor so we don't schedule in the past.
		if (!started) {
			nextStartTime = ctx.currentTime;
			started = true;
			state = 'playing';
		} else if (nextStartTime < ctx.currentTime) {
			nextStartTime = ctx.currentTime;
		}
		src.start(nextStartTime);
		nextStartTime += buf.duration;
		lastSource = src;
	};

	const tryDecode = async (bytes: Uint8Array): Promise<boolean> => {
		// decodeAudioData detaches its input ArrayBuffer — clone into a fresh
		// buffer so the caller's Uint8Array stays usable as an accumulator.
		const copy = new ArrayBuffer(bytes.byteLength);
		new Uint8Array(copy).set(bytes);
		try {
			const buf = await ctx.decodeAudioData(copy);
			scheduleBuffer(buf);
			return true;
		} catch {
			return false;
		}
	};

	try {
		for await (const frame of parseSseFrames(body)) {
			if (ctrl.signal.aborted || audioContext !== ctx) return null;
			if (frame.error) { resetOnError(); return frame.error; }
			if (frame.chunk) {
				const bytes = base64ToBytes(frame.chunk);
				const combined: Uint8Array = pending ? concatBytes(pending, bytes) : bytes;
				const ok = await tryDecode(combined);
				pending = ok ? null : combined;
			}
			if (frame.done) break;
		}
	} catch {
		if (ctrl.signal.aborted) return null;
		resetOnError();
		return 'Stream error';
	}

	// Stream ended — flush any bytes the accumulator still holds.
	if (pending) {
		await tryDecode(pending);
		pending = null;
	}

	// TS's control-flow analysis won't propagate assignments made inside the
	// `scheduleBuffer` closure back to the outer scope, so it narrows
	// `lastSource` to `null` after the `let … = null` initializer. Explicit
	// cast re-opens the union, then the null-check does the real work.
	const finalSource = lastSource as AudioBufferSourceNode | null;
	if (!started || !finalSource) {
		resetOnError();
		return 'No audio received';
	}

	// Last scheduled buffer: fire the end-of-playback hook when it finishes.
	finalSource.onended = () => {
		if (audioContext !== ctx) return;
		audioContext = null;
		state = 'idle';
		activeKey = null;
		abortCtrl = null;
		try { void ctx.close(); } catch { /* already closed */ }
		drainQueue();
	};

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
			drainQueue();
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
	if (audioContext) {
		try { void audioContext.close(); } catch { /* already closed */ }
		audioContext = null;
	}
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

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
	const out = new Uint8Array(a.length + b.length);
	out.set(a, 0);
	out.set(b, a.length);
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
