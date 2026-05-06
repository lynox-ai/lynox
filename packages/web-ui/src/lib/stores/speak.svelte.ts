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
import { getLocale } from '../i18n.svelte.js';
import { isIosSafari } from '../utils/ios-safari.js';
import { addToast } from './toast.svelte.js';

export type SpeakState = 'idle' | 'synthesizing' | 'playing';

/**
 * Discriminated error codes returned by `playSpeech` / `playSpeechQueued`.
 * Callers translate these into user-facing strings via i18n so the toast
 * shown to the user explains *what* went wrong (key missing? Mistral 5xx?
 * browser blocked playback?) instead of a generic "Vorlesen fehlgeschlagen".
 *
 * - `unavailable` — server returned 503 (no MISTRAL_API_KEY on this engine).
 * - `too_long`    — server returned 413 (text >SPEAK_MAX_TEXT_CHARS).
 * - `http`        — any other 4xx/5xx; `status` carries the code for diagnostics.
 * - `network`     — fetch threw (DNS, offline, CORS).
 * - `stream`      — SSE parse error mid-stream.
 * - `synth`       — server emitted `{ error: ... }` frame (Mistral synthesis failed).
 * - `empty`       — stream completed without producing any decodable audio.
 * - `blocked`     — Web Audio path failed and the blob fallback couldn't `play()`
 *                   (typically: browser autoplay policy, no user gesture).
 */
export type SpeakError =
  | { readonly code: 'unavailable' }
  | { readonly code: 'too_long' }
  | { readonly code: 'http'; readonly status: number }
  | { readonly code: 'network' }
  | { readonly code: 'stream' }
  | { readonly code: 'synth' }
  | { readonly code: 'empty' }
  | { readonly code: 'blocked' };

let state = $state<SpeakState>('idle');
let activeKey = $state<string | null>(null);

let audioEl: HTMLAudioElement | null = null;
// iOS Safari path: `<video playsinline>` carries the audio because Web
// Audio + `<audio>` both inherit Safari's default AVAudioSession Ambient
// category, which is silent when the device is muted/in Focus mode and
// auto-suspends mid-fetch. Video media elements escape that category in
// every iOS version we support (18+). Lifecycle mirrors `audioEl`: created
// inside the click gesture, primed with a tiny silent data URL so iOS
// records the play() attempt, then re-played with the real MP3 blob once
// the SSE stream completes. Hidden 1×1 in document.body — required for
// iOS to honour play() on a video element (detached elements get clamped).
let videoEl: HTMLVideoElement | null = null;
// Long-lived AudioContext, reused across playbacks. iOS Safari refuses to
// play audio from a context that wasn't constructed inside a synchronous
// click handler — and after the fetch await in `playSpeech`, the user-gesture
// flag is gone. So we lazy-create on the first synchronous prime() call and
// keep the same context alive for all subsequent playbacks. `stopSpeech`
// cancels in-flight sources via the activeSources Set instead of closing
// the context.
let audioContext: AudioContext | null = null;
const activeSources = new Set<AudioBufferSourceNode>();
let abortCtrl: AbortController | null = null;
let objectUrl: string | null = null;
// Per-utterance token. Bumped on every playSpeech / stopSpeech so the
// `ended` listener on a previous utterance's final source bails when a
// newer playback has already taken over. Without this, stop()ing the
// old source dispatches `ended` AFTER state has flipped to 'synthesizing'
// for the new run, and the listener resets it back to 'idle' mid-play
// (since `audioContext === ctx` is unchanged when we keep the context).
let runToken = 0;

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

// 44-byte zero-data WAV at /silent.wav (8 kHz, mono, 8-bit, 0 audio bytes).
// Static asset rather than `data:` URL because the app's CSP
// (`media-src 'self' blob:` in hooks.server.ts) blocks `data:` for media —
// iOS would reject the prime silently and the gesture-priming step would
// no-op without a Console hint. Same-origin static path passes CSP and
// caches across pages.
const SILENT_PLACEHOLDER_URL = '/silent.wav';

function destroyVideoEl(): void {
	if (!videoEl) return;
	try {
		videoEl.pause();
		videoEl.removeAttribute('src');
		videoEl.load();
		videoEl.remove();
	} catch { /* already detached */ }
	videoEl = null;
}

export function stopSpeech(): void {
	// Invalidate any pending `ended` listeners from the previous run. The
	// listener checks the run token against this updated value and bails.
	runToken++;
	if (abortCtrl) { abortCtrl.abort(); abortCtrl = null; }
	if (audioEl) {
		audioEl.pause();
		audioEl.src = '';
		audioEl = null;
	}
	destroyVideoEl();
	// Stop in-flight buffer sources but DO NOT close the AudioContext —
	// closing it would force re-creation on the next playSpeech, which
	// iOS only permits inside a synchronous click handler. By keeping the
	// same context alive we can keep playing audio for the whole session
	// even on auto-speak (where the second-and-later play calls are not
	// on a user-gesture stack).
	for (const src of activeSources) {
		try { src.stop(); src.disconnect(); } catch { /* already stopped */ }
	}
	activeSources.clear();
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
export async function playSpeechQueued(text: string, key: string): Promise<SpeakError | null> {
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
 * iOS-safe AudioContext priming. Must be called SYNCHRONOUSLY from a user
 * gesture (click/tap) — we hoist this to the top of `playSpeech` so it
 * runs before the fetch await, while the gesture flag is still on the
 * call stack. `resume()` is dispatched without await so the gesture is
 * preserved through the call (awaiting a microtask works on Chrome but
 * not iOS Safari). Idempotent: subsequent calls with an already-running
 * context are a no-op; if the context auto-suspended (long idle, tab
 * blur), we attempt to resume.
 *
 * Pre-2026-05-05 the AudioContext was created inside `playViaWebAudio`,
 * after the fetch await — that worked on desktop Chrome but iOS silently
 * muted it because the gesture flag was already consumed. This fix
 * unblocks both the per-message speak button and auto-speak playback on
 * iOS PWA / Safari.
 */
function primeAudio(): AudioContext | null {
	// iOS Safari skips the Web Audio path entirely — see `isIosSafari` and
	// `primeVideoElement` for why. Returning null here makes `playSpeech`
	// dispatch to `playViaVideoElement`.
	if (isIosSafari()) return null;
	const Ctor = getAudioCtxCtor();
	if (!Ctor) return null;
	if (!audioContext) {
		// new AudioContext() can throw on locked-down WebViews + when the
		// page exceeds the per-origin context limit (rare; we never create
		// more than one).
		try { audioContext = new Ctor(); } catch { return null; }
	}
	// resume() is only honoured by iOS while a user-gesture flag is on the
	// call stack. Auto-speak chains land here from a microtask, so a
	// rejection here means "iOS won't let me un-suspend right now". Catch
	// the rejection so `state` doesn't strand at 'synthesizing' / 'playing'
	// when no audio will actually come out — the playSpeech path checks
	// `audioContext.state` after this returns and surfaces 'blocked'.
	if (audioContext.state === 'suspended') {
		audioContext.resume().catch(() => { /* iOS auto-suspend gate */ });
	}
	return audioContext;
}

/**
 * iOS Safari priming: create a hidden `<video playsinline>` and call
 * play() on a 44-byte silent WAV (`/silent.wav`) SYNCHRONOUSLY inside
 * the user-gesture stack. This consumes the gesture flag against the
 * video element, after
 * which iOS treats it as user-activated for the rest of its lifetime —
 * we can swap `src` and call `play()` again from a microtask without
 * iOS rejecting it. Without this prime, `playViaVideoElement` runs into
 * the same auto-suspend / silent-output problem as Web Audio + `<audio>`.
 *
 * Element is appended to document.body because iOS clamps detached media
 * elements (off-DOM `<video>` will not actually emit sound). Hidden via
 * 1×1 + opacity:0 + pointer-events:none so the page layout is unaffected.
 *
 * The `play()` returns a Promise; we deliberately don't await it (would
 * lose the gesture). Catching the rejection keeps the promise chain
 * unhandled-rejection-clean. This is fire-and-forget by design.
 */
function primeVideoElement(): HTMLVideoElement | null {
	if (typeof document === 'undefined') return null;
	if (videoEl) return videoEl;
	const v = document.createElement('video');
	v.setAttribute('playsinline', '');
	v.setAttribute('webkit-playsinline', '');
	v.preload = 'auto';
	v.muted = false;
	v.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;left:-9999px;top:-9999px;';
	v.src = SILENT_PLACEHOLDER_URL;
	document.body.appendChild(v);
	videoEl = v;
	v.play().catch(() => { /* placeholder play may reject; gesture still primed */ });
	return v;
}

/**
 * Start TTS for `text`. Playback begins as soon as audio data is decodable
 * (~100 ms after first chunk on Web Audio path). Returns null on success or
 * a `SpeakError` the caller surfaces via i18n.
 */
export async function playSpeech(text: string, key: string): Promise<SpeakError | null> {
	stopSpeech();
	state = 'synthesizing';
	activeKey = key;

	// iOS-safe: prime the playback target SYNCHRONOUSLY before any await.
	// On iOS Safari we prime a `<video playsinline>` element instead of
	// the AudioContext (which iOS clamps to silent / auto-suspends). On
	// every other browser we prime the AudioContext as before.
	if (isIosSafari()) {
		primeVideoElement();
	} else {
		void primeAudio();
	}

	const ctrl = new AbortController();
	abortCtrl = ctrl;

	let res: Response;
	try {
		// Pass the UI locale so the server-side text-prep picks the right
		// label set ("Tabelle mit N" vs "Table with N") and list joiner.
		// The user's UI language is the truthful signal here — falling back
		// to a stopword vote on every request would be slower and wrong on
		// short replies (e.g. "Ok.").
		res = await fetch(`${getApiBase()}/speak`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ text, lang: getLocale() }),
			signal: ctrl.signal,
		});
	} catch {
		if (ctrl.signal.aborted) return null;
		resetOnError();
		return { code: 'network' };
	}

	if (!res.ok || !res.body) {
		resetOnError();
		if (res.status === 503) return { code: 'unavailable' };
		if (res.status === 413) return { code: 'too_long' };
		return { code: 'http', status: res.status };
	}

	if (videoEl) return playViaVideoElement(res.body, ctrl);
	return audioContext
		? playViaWebAudio(res.body, ctrl)
		: playViaBlob(res.body, ctrl);
}

/**
 * iOS Safari path: collect the SSE MP3 chunks into one blob, then swap
 * the (already-primed) video element's `src` to that blob and call play()
 * a second time. The first play() in `primeVideoElement` consumed the
 * user-gesture; iOS lets us re-trigger play() on the same element later
 * without a fresh gesture. Higher latency than Web Audio (we wait for the
 * full stream) but bypasses the AVAudioSession Ambient + auto-suspend
 * issues that silently kill Web Audio output on iOS Safari.
 */
async function playViaVideoElement(body: ReadableStream<Uint8Array>, ctrl: AbortController): Promise<SpeakError | null> {
	const video = videoEl;
	if (!video) return playViaBlob(body, ctrl);

	const mp3Parts: Uint8Array[] = [];
	let synthFailed = false;

	try {
		for await (const frame of parseSseFrames(body)) {
			if (ctrl.signal.aborted) return null;
			if (frame.error) { synthFailed = true; break; }
			if (frame.chunk) mp3Parts.push(base64ToBytes(frame.chunk));
			if (frame.done) break;
		}
	} catch {
		if (ctrl.signal.aborted) return null;
		resetOnError();
		return { code: 'stream' };
	}

	if (ctrl.signal.aborted) return null;
	if (synthFailed) { resetOnError(); return { code: 'synth' }; }
	if (mp3Parts.length === 0) { resetOnError(); return { code: 'empty' }; }

	const blob = new Blob(mp3Parts as BlobPart[], { type: 'audio/mpeg' });
	const url = URL.createObjectURL(blob);
	objectUrl = url;

	video.onended = () => {
		if (videoEl !== video) return;
		if (objectUrl === url) { URL.revokeObjectURL(url); objectUrl = null; }
		// Tear the element down so the next playSpeech re-primes a fresh
		// one inside its user-gesture stack — keeping the old element alive
		// across utterances would let primeVideoElement's `if (videoEl)
		// return videoEl` short-circuit, and there's no benefit to that
		// since stopSpeech (called at the top of every playSpeech) would
		// destroy it anyway.
		destroyVideoEl();
		state = 'idle';
		activeKey = null;
		abortCtrl = null;
		drainQueue();
	};
	video.onerror = () => { if (videoEl === video) resetOnError(); };

	video.src = url;
	state = 'playing';
	try {
		await video.play();
	} catch {
		resetOnError();
		return { code: 'blocked' };
	}
	return null;
}

async function playViaWebAudio(body: ReadableStream<Uint8Array>, ctrl: AbortController): Promise<SpeakError | null> {
	const ctx = audioContext;
	if (!ctx) return playViaBlob(body, ctrl);
	// `primeAudio` already created + resumed this context inside the user-gesture
	// stack at the top of `playSpeech`. Don't recreate or re-resume here — that
	// extra resume() awaited from outside the gesture is exactly what iOS rejects.

	// If the context is still suspended after the fetch round-trip, primeAudio's
	// `resume()` was rejected (typical when iOS auto-suspended an idle context
	// and the current playback chain is firing from a microtask, not a click).
	// Surface as 'blocked' instead of stranding state at 'synthesizing'.
	if (ctx.state === 'suspended') {
		resetOnError();
		return { code: 'blocked' };
	}

	// Snapshot the run token so the final-source `ended` listener can tell
	// whether it's firing for THIS utterance or a stale stopped one.
	const myRun = ++runToken;

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
		// Track for cancellation by `stopSpeech` (which no longer closes the
		// context). Auto-remove on natural end so the Set doesn't leak.
		activeSources.add(src);
		src.addEventListener('ended', () => activeSources.delete(src));
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
			if (frame.error) { resetOnError(); return { code: 'synth' }; }
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
		return { code: 'stream' };
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
		return { code: 'empty' };
	}

	// Last scheduled buffer: fire the end-of-playback hook when it finishes.
	// Don't null/close the context — keep it alive for the next playSpeech
	// (auto-speak chains this without a user gesture, so reusing a running
	// context is the only path on iOS). Bail if a newer run has taken over —
	// stop() on the cancelled source still dispatches `ended` and would
	// otherwise reset the new run's state.
	finalSource.addEventListener('ended', () => {
		if (runToken !== myRun) return;
		if (audioContext !== ctx) return;
		state = 'idle';
		activeKey = null;
		abortCtrl = null;
		drainQueue();
	});

	return null;
}

async function playViaBlob(body: ReadableStream<Uint8Array>, ctrl: AbortController): Promise<SpeakError | null> {
	const mp3Parts: Uint8Array[] = [];
	let synthFailed = false;

	try {
		for await (const frame of parseSseFrames(body)) {
			if (ctrl.signal.aborted) return null;
			if (frame.error) { synthFailed = true; break; }
			if (frame.chunk) mp3Parts.push(base64ToBytes(frame.chunk));
			if (frame.done) break;
		}
	} catch {
		if (ctrl.signal.aborted) return null;
		resetOnError();
		return { code: 'stream' };
	}

	if (ctrl.signal.aborted) return null;
	if (synthFailed) { resetOnError(); return { code: 'synth' }; }
	if (mp3Parts.length === 0) { resetOnError(); return { code: 'empty' }; }

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
		return { code: 'blocked' };
	}
	return null;
}

function resetOnError(): void {
	if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
	// Stop in-flight sources but keep the AudioContext alive — see stopSpeech.
	for (const src of activeSources) {
		try { src.stop(); src.disconnect(); } catch { /* already stopped */ }
	}
	activeSources.clear();
	audioEl = null;
	destroyVideoEl();
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
