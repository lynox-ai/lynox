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

export type {
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
  VOXTRAL_TTS_MODEL,
  DEFAULT_VOICE,
} from './mistral-voxtral-tts.js';
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

function toInternalOpts(opts: RichSpeakOpts): SpeakOpts {
  const out: Record<string, unknown> = {};
  if (opts.voice !== undefined) out['voice'] = opts.voice;
  if (opts.model !== undefined) out['model'] = opts.model;
  if (opts.tenantId !== undefined) out['tenantId'] = opts.tenantId;
  if (opts.timeoutMs !== undefined) out['timeoutMs'] = opts.timeoutMs;
  return out as SpeakOpts;
}

function prepText(text: string, opts: RichSpeakOpts): string {
  return opts.skipTextPrep ? text : prepareForSpeech(text);
}

function hasSpeakableContent(s: string): boolean {
  return /[\p{L}\p{N}]/u.test(s);
}

/** One-shot synthesis. Returns null when no provider is available or synthesis fails. */
export async function speak(text: string, opts: RichSpeakOpts = {}): Promise<SpeakResult | null> {
  const provider = resolveProvider();
  if (!provider) return null;
  const prepared = prepText(text, opts);
  if (!hasSpeakableContent(prepared)) return null;
  return provider.speak(prepared, toInternalOpts(opts));
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
  return provider.speakStream(prepared, onChunk, toInternalOpts(opts));
}
