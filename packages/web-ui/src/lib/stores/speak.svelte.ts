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
 * Chunks are concatenated client-side into a single MP3 blob and played via
 * <audio>. MediaSource Extensions would let playback start mid-stream, but
 * that's a Phase 2 optimization — the server-side streaming already buys the
 * ~1 s TTFB win that matters for the 1.5 s p50 target.
 */

import { getApiBase } from '../config.svelte.js';

export type SpeakState = 'idle' | 'synthesizing' | 'playing';

let state = $state<SpeakState>('idle');
let activeKey = $state<string | null>(null);

let audioEl: HTMLAudioElement | null = null;
let abortCtrl: AbortController | null = null;
let objectUrl: string | null = null;

export function getSpeakState(): SpeakState {
	return state;
}

export function isSpeakActive(key: string): boolean {
	return activeKey === key;
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

/**
 * Fetch TTS for `text`, accumulate SSE chunks into a single MP3 blob, then
 * play it. `key` identifies the source (e.g. a message index) so the UI can
 * show the active state next to the right button.
 *
 * Returns null on success, or an error message on failure. Errors are also
 * surfaced via state reset to 'idle' so the caller can toast if it wants.
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

	const mp3Parts: Uint8Array[] = [];
	let errorMsg: string | null = null;

	try {
		for await (const frame of parseSseFrames(res.body)) {
			if (ctrl.signal.aborted) return null;
			if (frame.error) { errorMsg = frame.error; break; }
			if (frame.chunk) {
				mp3Parts.push(base64ToBytes(frame.chunk));
			}
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
			URL.revokeObjectURL(url);
			if (objectUrl === url) objectUrl = null;
			audioEl = null;
			state = 'idle';
			activeKey = null;
			abortCtrl = null;
		}
	};
	audio.onerror = () => {
		if (audioEl === audio) resetOnError();
	};

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
				} catch {
					// skip malformed frame
				}
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
