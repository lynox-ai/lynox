/**
 * Speak (TTS) facade.
 *
 * Public API:
 *   - `speak(text, opts?)` — one-shot synthesis, returns SpeakResult | null.
 *   - `speakStream(text, onChunk, opts?)` — streaming synthesis, emits MP3 byte
 *     chunks via callback, returns stream metadata | null.
 *   - `getActiveSpeakProvider()` — the chosen provider (informational).
 *   - `hasSpeakProvider()` — true when any TTS provider is available.
 *
 * Text prep (Markdown → spoken-text sanitizer) runs before the provider call.
 * Pass `{ skipTextPrep: true }` for bench/debug paths. No glossary layer —
 * unlike STT, there's no mishearing to correct on the output side.
 *
 * Provider selection order:
 *   1. `LYNOX_TTS_PROVIDER` env (`mistral` | `auto`) — explicit override
 *   2. `tts_provider` config (`mistral` | `auto`)
 *   3. auto: Mistral Voxtral TTS if `MISTRAL_API_KEY` is set
 *   4. Otherwise null (callers treat as "no TTS" — PWA toggle hides; HTTP API returns 503)
 */

import { loadConfig } from '../config.js';
import type {
  AudioChunkCallback,
  RichSpeakOpts,
  SpeakOpts,
  SpeakProvider,
  SpeakResult,
  SpeakStreamMeta,
} from './types.js';
import { mistralVoxtralTtsProvider, hasMistralVoxtralTts } from './mistral-voxtral-tts.js';
import { prepareForSpeech } from './text-prep.js';
import { isVoiceLanguageTag, pickVoiceForLanguage } from './voice-for-language.js';
import type { VoiceChoice } from './voice-for-language.js';

export type {
  Lang,
  SpeakOpts,
  RichSpeakOpts,
  SpeakResult,
  SpeakStreamMeta,
  SpeakProvider,
  SpeakProviderName,
  AudioChunkCallback,
} from './types.js';
export {
  mistralVoxtralTtsProvider,
  speakMistralVoxtral,
  speakMistralVoxtralStream,
  hasMistralVoxtralTts,
  listMistralVoices,
  VOXTRAL_TTS_MODEL,
  DEFAULT_VOICE,
} from './mistral-voxtral-tts.js';
export type { VoiceInfo } from './mistral-voxtral-tts.js';
// The shape rule for a voice-language tag, exported so a CALLER can reject early with
// the same rule the sink enforces — one definition, not a second copy per call site.
export { isVoiceLanguageTag } from './voice-for-language.js';
export { prepareForSpeech } from './text-prep.js';

type ProviderChoice = 'mistral' | 'auto';

function readEnvProvider(): ProviderChoice | null {
  const v = process.env['LYNOX_TTS_PROVIDER'];
  if (v === 'mistral' || v === 'auto') return v;
  return null;
}

function readConfigProvider(): ProviderChoice {
  try {
    const cfg = loadConfig() as { tts_provider?: unknown };
    const v = cfg.tts_provider;
    if (v === 'mistral' || v === 'auto') return v;
  } catch {
    // config missing / invalid — fall through to auto
  }
  return 'auto';
}

function resolveProvider(): SpeakProvider | null {
  const choice = readEnvProvider() ?? readConfigProvider();
  if (choice === 'mistral') {
    return mistralVoxtralTtsProvider.isAvailable ? mistralVoxtralTtsProvider : null;
  }
  if (mistralVoxtralTtsProvider.isAvailable) return mistralVoxtralTtsProvider;
  return null;
}

export function getActiveSpeakProvider(): SpeakProvider | null {
  return resolveProvider();
}

export function hasSpeakProvider(): boolean {
  return hasMistralVoxtralTts();
}

/**
 * `resolvedVoice` is passed in rather than read from `opts`, so that the one place
 * which decides a voice is `resolveVoice` and this function stays a mapper. Passing
 * `undefined` keeps the provider's own default, which is what happened before.
 */
function toInternalOpts(opts: RichSpeakOpts, resolvedVoice?: string | undefined): SpeakOpts {
  const out: Record<string, unknown> = {};
  // ⚠ ONLY the resolved voice. This used to fall back to `?? opts.voice`, which re-admitted
  // the RAW, untrimmed value every time selection yielded nothing — so the blank-voice guard
  // in `resolveVoice` closed the suppression half and the provider still received `'  '`.
  // Measured through the facade: `{ voice: '  ' }` reached the Mistral payload as
  // `"voice":"  "` where a voice-less call sends the curated default.
  //
  // The fallback is dead for every legitimate caller — `resolveVoice`'s first branch already
  // returns the explicit voice, trimmed — so it existed solely to undo the guard. And the
  // claim that went with it, "the HTTP route cannot produce it", is false for whitespace:
  // the route drops a falsy `voice` but `'  '` is truthy, and the config path gates on
  // `length > 0` rather than a trim.
  if (resolvedVoice !== undefined) out['voice'] = resolvedVoice;
  if (opts.model !== undefined) out['model'] = opts.model;
  if (opts.tenantId !== undefined) out['tenantId'] = opts.tenantId;
  if (opts.timeoutMs !== undefined) out['timeoutMs'] = opts.timeoutMs;
  return out as SpeakOpts;
}

function prepText(text: string, opts: RichSpeakOpts): string {
  if (opts.skipTextPrep) return text;
  return prepareForSpeech(text, opts.lang ?? 'auto');
}

function hasSpeakableContent(s: string): boolean {
  return /[\p{L}\p{N}]/u.test(s);
}

/**
 * ⭐ THE ONE DECISION POINT for "which voice", and it is deliberately one function so
 * that a change to the rule below changes exactly one place.
 *
 * Resolution order, and each step is a decision already made elsewhere:
 *   1. an explicit `voice` wins — the caller has chosen;
 *   2. no `voiceLanguage` → no selection, the provider's default applies as before;
 *   3. a provider without a catalogue → no selection (the contract makes `listVoices`
 *      optional precisely so this is a normal state, not an error);
 *   4. a catalogue that cannot be fetched → no selection. Synthesis must not fail
 *      because the OPTIONAL step in front of it did.
 *   5. otherwise the deterministic pick.
 *
 * A chosen voice (step 1: the caller's `voice`, which the HTTP route fills from the
 * request, else from the saved voice setting) is used as it is, for every language,
 * and the catalogue is not consulted. That is the rule, not a stopgap.
 *
 * Only when no voice was chosen does the language pick run. If the catalogue then has
 * no voice for the language, this returns no voice, the provider's default reads the
 * text, and a warning says the speaker does not match the text. It does not throw:
 * that would take a working feature away from German users. The current provider's
 * catalogue has no German voice (see `mistral-voxtral-tts.ts`), so German text is read
 * by a voice whose accent is not German.
 */
async function resolveVoice(
  provider: SpeakProvider,
  opts: RichSpeakOpts,
): Promise<string | undefined> {
  // ⚠ An EMPTY voice is not a decision. `opts.voice !== undefined` alone let `voice: ''`
  // both suppress language selection and reach the provider (`opts.voice ?? DEFAULT_VOICE`
  // keeps `''`, since it is nullish-coalescing and `''` is not nullish). The HTTP route
  // cannot produce it, which is exactly why the sink has to: this is the direct-caller
  // class the whole "the sink validates, not only the route" reasoning exists for.
  const chosen = opts.voice?.trim();
  if (chosen !== undefined && chosen !== '') return chosen;
  const wanted = opts.voiceLanguage?.trim();
  if (!wanted) return undefined;
  // ⚠ The SINK validates, not only the route. Everything that keeps this value harmless
  // in the diagnostic below — bounded length, no newline, no quote, no escape sequence —
  // is this check, and it has to be here so it holds for the NEXT caller too. See
  // `isVoiceLanguageTag`.
  if (!isVoiceLanguageTag(wanted)) return undefined;
  if (!provider.listVoices) return undefined;
  // ⚠ The pick is INSIDE the try, not only the fetch. This runs after the route has
  // already written its 200 and begun an SSE stream, and the top-level handler cannot
  // respond once headers are sent — it would log and leave the connection open until the
  // socket times out. The catalogue is parsed by this module today, so a throw is
  // unreachable; `SpeakProvider.listVoices` is a contract another provider can implement,
  // and selection being best-effort has to survive that.
  let choice: VoiceChoice;
  let offered: number;
  try {
    const catalogue = await provider.listVoices();
    offered = catalogue.length;
    choice = pickVoiceForLanguage(catalogue, wanted, provider.defaultVoice);
  } catch {
    // The catalogue reports its own failures; selection must not take synthesis with it.
    return undefined;
  }
  if (choice.matched) return choice.voice;
  // Says WHAT HAPPENED, not that everything is fine: a reassuring line here would
  // teach a rule that does not hold.
  console.warn(
    `[speak] no voice in the ${provider.name} catalogue speaks '${wanted}' ` +
      `(${String(offered)} voices offered). Reading it with the provider's ` +
      'default voice instead — the speaker identity will not match the text.',
  );
  return undefined;
}

/** One-shot synthesis. Returns null when no provider is available or synthesis fails. */
export async function speak(text: string, opts: RichSpeakOpts = {}): Promise<SpeakResult | null> {
  const provider = resolveProvider();
  if (!provider) return null;
  const prepared = prepText(text, opts);
  if (!hasSpeakableContent(prepared)) return null;
  const voice = await resolveVoice(provider, opts);
  return provider.speak(prepared, toInternalOpts(opts, voice));
}

/**
 * Streaming synthesis. Emits MP3 byte chunks to `onChunk` as they arrive from
 * the provider. Returns stream metadata (including ttfbMs) on success, null on
 * failure or when no provider is available. Stream mode is mandatory to meet
 * the ≤ 1.5 s TTFA target on replies > ~200 chars (Phase 0 measured).
 */
export async function speakStream(
  text: string,
  onChunk: AudioChunkCallback,
  opts: RichSpeakOpts = {},
): Promise<SpeakStreamMeta | null> {
  const provider = resolveProvider();
  if (!provider) return null;
  const prepared = prepText(text, opts);
  if (!hasSpeakableContent(prepared)) return null;
  const voice = await resolveVoice(provider, opts);
  return provider.speakStream(prepared, onChunk, toInternalOpts(opts, voice));
}
