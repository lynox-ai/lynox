/**
 * The Mistral preset's endpoint, as the web UI writes and recognises it. Mistral commits to
 * EU/EFTA inference only for its EU regional endpoint, so that is what the preset saves. A
 * config saved before the move still names the global endpoint; the engine reads it as the EU
 * one, and the UI recognises both as the Mistral preset. Mirrors core `MISTRAL_API_BASE`.
 */
export const MISTRAL_API_BASE = 'https://api.eu.mistral.ai/v1';

const MISTRAL_PRESET_BASES: ReadonlySet<string> = new Set([MISTRAL_API_BASE, 'https://api.mistral.ai/v1']);

/** True when a stored `api_base_url` is the Mistral preset's, before or after the move. */
export function isMistralPresetBase(url: string | null | undefined): boolean {
	return typeof url === 'string' && MISTRAL_PRESET_BASES.has(url);
}
