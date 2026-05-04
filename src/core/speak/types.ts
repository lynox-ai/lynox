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
   * Web UI / Telegram callers should pass the user's UI locale.
   */
  readonly lang?: Lang | 'auto' | undefined;
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

export interface SpeakProvider {
  readonly name: SpeakProviderName;
  readonly isAvailable: boolean;
  speak(text: string, opts: SpeakOpts): Promise<SpeakResult | null>;
  speakStream(text: string, onChunk: AudioChunkCallback, opts: SpeakOpts): Promise<SpeakStreamMeta | null>;
}
