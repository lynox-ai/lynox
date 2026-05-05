/**
 * STT auto-send toggle — persistent per-browser preference.
 *
 * Default OFF: transcribed text is placed into the chat input box for review
 * and editing before submit. Whisper / Voxtral output is materially less
 * accurate for non-English (Rafael speaks DE), so the input-box review step
 * catches mis-transcriptions before they hit the LLM.
 *
 * When enabled, the original behavior returns: the transcript is sent to the
 * agent as soon as the SSE stream's `done` lands.
 */

const STORAGE_KEY = 'lynox_voice_autosend_enabled';

function readInitial(): boolean {
	try {
		return typeof localStorage !== 'undefined' && localStorage.getItem(STORAGE_KEY) === '1';
	} catch { return false; }
}

let enabled = $state<boolean>(readInitial());

export function isVoiceAutoSendEnabled(): boolean {
	return enabled;
}

export function toggleVoiceAutoSend(): void {
	enabled = !enabled;
	try {
		if (typeof localStorage === 'undefined') return;
		if (enabled) localStorage.setItem(STORAGE_KEY, '1');
		else localStorage.removeItem(STORAGE_KEY);
	} catch { /* private mode — state lives in memory only */ }
}
