/**
 * Voice-message prefix handling.
 *
 * Voice-recorded user messages are stored as `🎤 <text>` so the source-of-truth
 * (DB row, chat history JSON, exports) preserves the affordance. The emoji
 * itself is colourful in every system font, which clashes with the otherwise
 * monochrome UI. Render-time we detect the prefix and replace it with the
 * stroked microphone SVG used elsewhere in the app — see `MIC_SVG_PATH`.
 *
 * The prefix is a constant so we can change the marker without grepping
 * across components.
 */
export const VOICE_PREFIX = '🎤 ';

/** SVG path for the same outlined microphone used in the chat composer. */
export const MIC_SVG_PATH =
	'M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z';

export function hasVoicePrefix(text: string | undefined | null): boolean {
	return typeof text === 'string' && text.startsWith(VOICE_PREFIX);
}

export function stripVoicePrefix(text: string): string {
	return text.startsWith(VOICE_PREFIX) ? text.slice(VOICE_PREFIX.length) : text;
}
