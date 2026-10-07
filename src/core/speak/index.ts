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
 * that the open question below changes exactly one place.
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
 * ⚠⚠ OPEN, AND NOT DECIDED HERE: what should happen when the catalogue has no voice
 * for the requested language. Today that is not a corner case — it is the GERMAN
 * case, every time, because the provider has no German voice at all. The behaviour
 * of this branch therefore IS the answer to "browser `SpeechSynthesis` or a second
 * provider", and that is a product decision, not this function's.
 *
 * Until it is made, this falls back to the provider's default voice AND says so. That
 * is strictly today's behaviour plus a diagnostic — the surface reads German text with
 * an English speaker voice — so it adds no
 * promise. Throwing instead would take a working feature away from German users,
 * which is the wrong direction for an unanswered question.
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
