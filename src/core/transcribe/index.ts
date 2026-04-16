/**
 * Transcription facade.
 *
 * Public API:
 *   - `transcribeAudio(buffer, filename, language?)` — drop-in replacement for
 *     the legacy export. Unchanged signature so the existing HTTP API and
 *     Telegram call sites continue working with no code change. Gets the core
 *     glossary automatically; session glossary requires the richer entry below.
 *   - `transcribeAudioStream(buffer, filename, onSegment, language?)` — same
 *     story for SSE callers.
 *   - `transcribe(buffer, filename, opts)` / `transcribeWithStream(...)` —
 *     richer entry points that accept a `session` (for session glossary),
 *     `tenantId`, `timeoutMs`. Used by the online integration test and by any
 *     caller that wants the full two-layer glossary.
 *   - `HAS_WHISPER` — back-compat availability flag used by HTTP API / Telegram
 *     to decide whether to accept voice uploads at all.
 *   - `getActiveTranscribeProvider()` — the chosen provider (informational).
 *
 * Provider selection order:
 *   1. `LYNOX_TRANSCRIBE_PROVIDER` env (`mistral` | `whisper`) — explicit override
 *   2. `transcription_provider` config (`mistral` | `whisper` | `auto`)
 *   3. auto: Mistral if `MISTRAL_API_KEY` is set, else whisper.cpp
 *   4. Otherwise null (callers handle "no transcription" the same as before)
 */

import { loadConfig } from '../config.js';
import type {
  RichTranscribeOpts,
  SegmentCallback,
  TranscribeOpts,
  TranscribeProvider,
  TranscribeSessionContext,
} from './types.js';
import { mistralVoxtralProvider, hasMistralVoxtral } from './mistral-voxtral.js';
import { whisperCppProvider, hasWhisperCpp } from './whisper-cpp.js';
import { CORE_GLOSSARY } from './glossary/core-terms.js';
import { applyGlossary, applySessionGlossary } from './glossary/apply.js';
import { buildSessionGlossary } from './glossary/session-builder.js';

export type {
  TranscribeOpts,
  RichTranscribeOpts,
  SegmentCallback,
  TranscribeProvider,
  TranscribeSessionContext,
} from './types.js';
export { mistralVoxtralProvider, transcribeMistralVoxtral, VOXTRAL_TRANSCRIBE_MODEL, hasMistralVoxtral } from './mistral-voxtral.js';
export { whisperCppProvider, transcribeWhisperCpp, transcribeWhisperCppStream, hasWhisperCpp } from './whisper-cpp.js';
export { CORE_GLOSSARY } from './glossary/core-terms.js';
export type { GlossaryTerm } from './glossary/core-terms.js';
export { applyGlossary, applySessionGlossary, DEFAULT_STOP_LIST } from './glossary/apply.js';
export { buildSessionGlossary, SessionGlossaryCache } from './glossary/session-builder.js';
export type { SessionSources, BuildGlossaryOptions } from './glossary/session-builder.js';
export { extractSessionContext } from './session-context.js';
export type { ExtractOptions } from './session-context.js';

// ── Provider resolution ────────────────────────────────────────────────────

type ProviderChoice = 'mistral' | 'whisper' | 'auto';

function readEnvProvider(): ProviderChoice | null {
  const v = process.env['LYNOX_TRANSCRIBE_PROVIDER'];
  if (v === 'mistral' || v === 'whisper' || v === 'auto') return v;
  return null;
}

function readConfigProvider(): ProviderChoice {
  try {
    const cfg = loadConfig() as { transcription_provider?: unknown };
    const v = cfg.transcription_provider;
    if (v === 'mistral' || v === 'whisper' || v === 'auto') return v;
  } catch {
    // config missing / invalid — fall through to auto
  }
  return 'auto';
}

function resolveProvider(): TranscribeProvider | null {
  const choice = readEnvProvider() ?? readConfigProvider();
  if (choice === 'mistral') {
    return mistralVoxtralProvider.isAvailable ? mistralVoxtralProvider : null;
  }
  if (choice === 'whisper') {
    return whisperCppProvider.isAvailable ? whisperCppProvider : null;
  }
  // auto
  if (mistralVoxtralProvider.isAvailable) return mistralVoxtralProvider;
  if (whisperCppProvider.isAvailable) return whisperCppProvider;
  return null;
}

/** Which provider `transcribe()` would use right now (informational). */
export function getActiveTranscribeProvider(): TranscribeProvider | null {
  return resolveProvider();
}

/**
 * True when *any* provider is available. Preserves the semantics of the legacy
 * `HAS_WHISPER` export (voice upload is accepted) without locking callers to
 * the whisper-specific name — new code should prefer `hasTranscribeProvider()`.
 */
export function hasTranscribeProvider(): boolean {
  return hasMistralVoxtral() || hasWhisperCpp();
}

/** Back-compat: existing callers check this before accepting voice input. */
export const HAS_WHISPER = hasTranscribeProvider();

// ── Glossary pipeline ──────────────────────────────────────────────────────

function buildSessionTerms(session: TranscribeSessionContext | undefined): string[] {
  if (!session) return [];
  return buildSessionGlossary({
    ...(session.contactNames !== undefined ? { contactNames: session.contactNames } : {}),
    ...(session.apiProfileNames !== undefined ? { apiProfileNames: session.apiProfileNames } : {}),
    ...(session.workflowNames !== undefined ? { workflowNames: session.workflowNames } : {}),
    ...(session.threadTitles !== undefined ? { threadTitles: session.threadTitles } : {}),
    ...(session.kgEntityLabels !== undefined ? { kgEntityLabels: session.kgEntityLabels } : {}),
  });
}

function postProcess(text: string, opts: RichTranscribeOpts): string {
  if (opts.skipGlossary) return text;
  const withCore = applyGlossary(text, CORE_GLOSSARY);
  const sessionTerms = buildSessionTerms(opts.session);
  if (sessionTerms.length === 0) return withCore;
  return applySessionGlossary(withCore, sessionTerms);
}

// ── Public entry points ────────────────────────────────────────────────────

function toInternalOpts(opts: RichTranscribeOpts): TranscribeOpts {
  // Strip the glossary / session fields — providers don't need them.
  const out: Record<string, unknown> = {};
  if (opts.language !== undefined) out['language'] = opts.language;
  if (opts.tenantId !== undefined) out['tenantId'] = opts.tenantId;
  if (opts.timeoutMs !== undefined) out['timeoutMs'] = opts.timeoutMs;
  return out as TranscribeOpts;
}

/**
 * Rich entry point: pick a provider, transcribe, apply core + session glossary.
 * Returns null when no provider is available or the provider returns null.
 */
export async function transcribe(
  buffer: Buffer,
  filename: string,
  opts: RichTranscribeOpts = {},
): Promise<string | null> {
  const provider = resolveProvider();
  if (!provider) return null;
  const raw = await provider.transcribe(buffer, filename, toInternalOpts(opts));
  if (!raw) return null;
  return postProcess(raw, opts);
}

/**
 * Streaming variant. Falls back to one-shot + single final segment emit for
 * providers without native streaming (Mistral). Whisper streams natively.
 */
export async function transcribeWithStream(
  buffer: Buffer,
  filename: string,
  onSegment: SegmentCallback,
  opts: RichTranscribeOpts = {},
): Promise<string | null> {
  const provider = resolveProvider();
  if (!provider) return null;

  const internal = toInternalOpts(opts);

  if (provider.transcribeStream) {
    // Pass-through stream. Glossary is applied only to the final text the
    // provider returns — mid-stream segments are emitted raw to keep "typing"
    // latency low. Worst case: the user briefly sees "Setup-Result" before the
    // final transcript replaces it with "Setup Wizard". Acceptable trade-off.
    const raw = await provider.transcribeStream(buffer, filename, onSegment, internal);
    if (!raw) return null;
    return postProcess(raw, opts);
  }

  // Provider has no native stream — tell the caller we're starting, await the
  // one-shot result, then emit the (post-processed) transcript as a single
  // final segment. Matches the whisper.cpp contract the HTTP API is built for.
  onSegment('');
  const raw = await provider.transcribe(buffer, filename, internal);
  if (!raw) return null;
  const processed = postProcess(raw, opts);
  onSegment(processed);
  return processed;
}

// ── Legacy drop-in exports ─────────────────────────────────────────────────

/**
 * Legacy signature preserved for HTTP API and Telegram bot.
 * Uses core glossary automatically; session glossary requires `transcribe()`.
 */
export async function transcribeAudio(
  buffer: Buffer,
  filename: string,
  language?: string,
): Promise<string | null> {
  return transcribe(buffer, filename, language !== undefined ? { language } : {});
}

/**
 * Legacy streaming signature preserved for HTTP API (SSE).
 */
export async function transcribeAudioStream(
  buffer: Buffer,
  filename: string,
  onSegment: SegmentCallback,
  language?: string,
): Promise<string | null> {
  return transcribeWithStream(buffer, filename, onSegment, language !== undefined ? { language } : {});
}
