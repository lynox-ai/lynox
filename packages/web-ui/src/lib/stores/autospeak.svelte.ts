/**
 * Auto-speak toggle — persistent per-browser preference.
 *
 * Default OFF (no surprise audio for first-time users). When enabled, ChatView
 * fires `playSpeech()` on every new assistant reply as streaming completes.
 *
 * One-tap mute: toggling off stops any in-flight playback immediately and
 * prevents the next reply from auto-playing.
 */

import { stopSpeech } from './speak.svelte.js';

const STORAGE_KEY = 'lynox_autospeak_enabled';

function readInitial(): boolean {
	try {
		return typeof localStorage !== 'undefined' && localStorage.getItem(STORAGE_KEY) === '1';
	} catch { return false; }
}

let enabled = $state<boolean>(readInitial());

export function isAutoSpeakEnabled(): boolean {
	return enabled;
}

export function toggleAutoSpeak(): void {
	enabled = !enabled;
	try {
		if (typeof localStorage === 'undefined') return;
		if (enabled) localStorage.setItem(STORAGE_KEY, '1');
		else localStorage.removeItem(STORAGE_KEY);
	} catch { /* private mode — state lives in memory only */ }
	// Toggling off cancels current playback + future auto-speak. The toggle
	// doubles as a one-tap mute per the PRD; matching setAutoSpeak(false) on
	// every dismissal path is less error-prone than wiring a separate mute.
	if (!enabled) stopSpeech();
}
