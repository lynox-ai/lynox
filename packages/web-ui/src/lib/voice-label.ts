/**
 * How the voice settings name a voice: the name the provider gives it, and in
 * brackets its language, named in the language of the interface — never its id or a
 * language code where a name exists. The picker, the summary row and the hint under
 * the picker all name a voice this way, so the same voice reads the same everywhere.
 */

export interface VoiceEntry {
	id: string;
	language?: string;
	description?: string;
}

/**
 * The voice the engine reads with when the model cannot speak the chosen one
 * (`DEFAULT_VOICE`, `src/core/speak/mistral-voxtral-tts.ts`). Kept in step with it by
 * `voice-label.test.ts`, which reads that file.
 */
export const DEFAULT_TTS_VOICE = 'en_paul_neutral';

/** A language code as a name in `locale` (`en` → `Englisch` in German), or the code when there is none. */
export function languageName(code: string, locale: string): string {
	try {
		return new Intl.DisplayNames([locale], { type: 'language' }).of(code) ?? code;
	} catch {
		return code;
	}
}

/** `Paul - Neutral (Englisch)`: the provider's name, else the id; the language in brackets when it is known. */
export function voiceLabel(voice: VoiceEntry, locale: string): string {
	const name = voice.description?.trim() || voice.id;
	return voice.language ? `${name} (${languageName(voice.language, locale)})` : name;
}

/**
 * The default voice as the hint under the picker names it: its name when the list
 * gives one, and its language — from the list, else from the id's first part
 * (`en_paul_neutral` → `en`).
 */
export function defaultVoice(voices: readonly VoiceEntry[], locale: string): { name?: string; language: string } {
	const entry = voices.find((v) => v.id === DEFAULT_TTS_VOICE);
	const code = entry?.language ?? DEFAULT_TTS_VOICE.split('_')[0] ?? 'en';
	const name = entry?.description?.trim();
	return name ? { name, language: languageName(code, locale) } : { language: languageName(code, locale) };
}
