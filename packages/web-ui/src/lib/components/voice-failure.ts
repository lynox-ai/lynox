import { t } from '../i18n.svelte.js';

// The toast for a voice request the server answered with an error status. A 402 is a
// reached AI budget — the instance's daily or monthly cap, or a managed balance for the
// period — and trying again does not help, so it gets its own text. The server's own
// text stays in the 402 body for API callers.

/** The toast for a failed `POST /api/transcribe`. */
export function transcribeFailureText(status: number): string {
	if (status === 503) return t('chat.whisper_unavailable');
	if (status === 402) return t('chat.transcribe_budget');
	return t('chat.transcribe_failed');
}

/** The toast for a `POST /api/speak` that answered with an error status. */
export function speakHttpFailureText(status: number): string {
	if (status === 402) return t('chat.speak_budget');
	return `${t('chat.speak_failed_http')} ${String(status)}`;
}
