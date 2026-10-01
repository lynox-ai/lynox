/**
 * TTS provider interface.
 *
 * Facade applies Markdown → spoken-text pre-processing before the provider call.
 * The provider only speaks to its API with documented parameters. Character
 * counting for cost attribution happens facade-side (the Mistral endpoint
 * surfaces no usage headers — verified Phase 0).
 *
 * Phase 1 ships a single provider (Mistral Voxtral TTS). The SpeakProvider
 * abstraction exists for symmetry with `src/core/transcribe/` and to keep the
 * door open for a browser Web Speech API fallback without restructuring the
 * facade (per PRD: "fallback is browser Web Speech API, not another cloud vendor").
 */

/**
 * Source-text language for the Markdown → spoken-text pre-processor.
 * Lives here (not in `text-prep.ts`) so the entire speak public surface —
 * options + provider interface + language tag — is in one file.
 */
export type Lang = 'de' | 'en';

export interface SpeakOpts {
  readonly voice?: string | undefined;
  readonly model?: string | undefined;
  readonly tenantId?: string | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface RichSpeakOpts extends SpeakOpts {
  readonly skipTextPrep?: boolean | undefined;
  /**
   * Source-text language for the Markdown → spoken-text pre-processor.
   * Determines table/list summary labels and the list joiner. `'auto'`
   * (or omitted) runs a stopword vote that defaults to `'en'` on tie.
   * Web UI / PWA callers should pass the user's UI locale.
   */
  readonly lang?: Lang | 'auto' | undefined;
  /**
   * Language the VOICE should speak, as a tag from the provider's catalogue
   * (`'de'`, `'en'`, `'fr'`, `'en_gb'` — the head is what is compared).
   *
   * ⚠ Deliberately NOT `Lang`, and not the same field as `lang` above. `lang` is the
   * source-text language for the pre-processor and is binary by design; this is the
   * catalogue's vocabulary, which already has values `Lang` cannot express. One
   * request may well carry both, derived from one caller-supplied value — two roles,
   * two fields, rather than one value asked to mean two things.
   *
   * Ignored when `voice` is given: an explicit voice is a decision already made.
   */
  readonly voiceLanguage?: string | undefined;
}

export type AudioChunkCallback = (chunk: Uint8Array) => void;

export interface SpeakResult {
  readonly mp3: Uint8Array;
  readonly characters: number;
  readonly provider: SpeakProviderName;
  readonly model: string;
  readonly voice: string;
  readonly latencyMs: number;
}

export interface SpeakStreamMeta {
  readonly characters: number;
  readonly provider: SpeakProviderName;
  readonly model: string;
  readonly voice: string;
  readonly latencyMs: number;
  readonly ttfbMs: number;
}

export type SpeakProviderName = 'mistral-voxtral-tts';

/**
 * One entry of a provider's voice catalogue. MOVED here from
 * `mistral-voxtral-tts.ts` (which re-exports it, so no importer changes) because
 * `SpeakProvider.listVoices` below is part of the contract and a contract cannot
 * name a type that lives inside one implementation.
 *
 * `language` is a 2-letter head: the Mistral fetch normalises `en_us` → `en`. That
 * is a DIFFERENT vocabulary from `Lang` above — `Lang` is the pre-processor's, this
 * is the provider catalogue's, and it already contains values `Lang` cannot express
 * (`fr`). Keeping them apart is the point; collapsing them would push the
 * catalogue's vocabulary into text preparation and into `src/core/transcribe/`.
 */
export interface VoiceInfo {
  id: string;
  language?: string;
  description?: string;
}

export interface SpeakProvider {
  readonly name: SpeakProviderName;
  readonly isAvailable: boolean;
  speak(text: string, opts: SpeakOpts): Promise<SpeakResult | null>;
  speakStream(text: string, onChunk: AudioChunkCallback, opts: SpeakOpts): Promise<SpeakStreamMeta | null>;
  /**
   * The provider's voice catalogue, when it has one. OPTIONAL on purpose: a
   * provider without a catalogue (browser `SpeechSynthesis`, say) is still a valid
   * provider, and language-based selection simply does not apply to it. A caller
   * must therefore treat its absence as "no selection", never as an error.
   */
  listVoices?(): Promise<VoiceInfo[]>;
}
