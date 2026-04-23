/**
 * Mistral Voxtral TTS provider.
 *
 * POST https://api.mistral.ai/v1/audio/speech (JSON):
 *   { model, input, voice, stream?: boolean }
 * Auth: Authorization: Bearer <MISTRAL_API_KEY>
 *
 * Plain response:  application/json, body `{"audio_data": "<base64 MP3>"}`.
 * Stream response: text/event-stream, SSE frames:
 *   event: speech.audio.delta
 *   data: {"type":"speech.audio.delta","audio_data":"<base64_chunk>"}
 *
 * Endpoint rejects `language` outright (422 extra_forbidden) — the voice
 * catalog as of Phase 0 is EN-only (en_us + en_gb), so DE text is spoken with
 * an English voice by default. Do not attempt to pass `language`.
 *
 * No usage or rate-limit headers are exposed. Character counting for per-tenant
 * cost attribution happens facade-side. EU-hosted (Mistral La Plateforme, Paris).
 */

import { getErrorMessage } from '../utils.js';
import type {
  AudioChunkCallback,
  SpeakOpts,
  SpeakProvider,
  SpeakResult,
  SpeakStreamMeta,
} from './types.js';

/** Model alias — stays on `-latest` for future-proofing per Phase 0 decision. */
export const VOXTRAL_TTS_MODEL = 'voxtral-mini-tts-latest';

/**
 * Default voice — English, read DE text with a light English accent. Rafael
 * approved on the Phase 0 p300/p3000 DE samples. Swap to `de_*` once Mistral
 * ships a German voice (as of 2026-04-16, catalog is 10× EN voices only).
 */
export const DEFAULT_VOICE = 'en_paul_neutral';

const API_URL = 'https://api.mistral.ai/v1/audio/speech';
// Mistral caps `page_size` at 10 regardless of what we request — confirmed
// 2026-04-21 against the live API. We paginate explicitly to fetch all voices.
const VOICES_BASE_URL = 'https://api.mistral.ai/v1/audio/voices';
// Hard page ceiling so a buggy `total_pages` response can't spin forever.
// 30 voices × 10/page = 3 pages today; 100 pages would be 1000 voices.
const VOICES_MAX_PAGES = 100;

/**
 * Fallback voice catalog for the Settings picker when the live `/v1/audio/voices`
 * call is unreachable. Reflects the 10× EN catalog documented as of 2026-04-16;
 * safe to stay out-of-date because the live fetch overwrites this in the UI the
 * moment Mistral is reachable. `de_*` slugs will appear automatically once the
 * catalog ships them — do not add hardcoded DE entries here.
 */
const FALLBACK_VOICES: ReadonlyArray<VoiceInfo> = [
  { id: 'en_paul_neutral',    language: 'en', description: 'Paul — neutral' },
  { id: 'en_alex_neutral',    language: 'en', description: 'Alex — neutral' },
  { id: 'en_mary_neutral',    language: 'en', description: 'Mary — neutral' },
  { id: 'en_john_neutral',    language: 'en', description: 'John — neutral' },
  { id: 'en_sara_neutral',    language: 'en', description: 'Sara — neutral' },
];

export interface VoiceInfo {
  id: string;
  language?: string;
  description?: string;
}

let _voicesCache: { voices: VoiceInfo[]; expiresAt: number } | null = null;
const VOICES_TTL_MS = 60 * 60_000; // 1 hour

/**
 * Fetch the Mistral Voxtral voice catalog for the Settings → Compliance
 * picker. Returns the cached list inside the 1h TTL; on first call or after
 * expiry, queries `/v1/audio/voices` with a 2s timeout. On any failure
 * (no key, network error, unexpected shape) returns the hardcoded
 * FALLBACK_VOICES so the UI is never voice-pickerless.
 */
/**
 * Parse one page of the Mistral voices response into our VoiceInfo shape.
 * Separated from the pagination loop so the shape-tolerance logic stays
 * readable. Accepts `items` / `data` / `voices` / bare array containers.
 */
function parseVoicesPage(body: unknown): { voices: VoiceInfo[]; totalPages: number } {
  // Mistral's actual response shape (probed 2026-04-21):
  //   { items: [{ slug, name, languages: [...], gender, age, tags, id, ... }], total, page, page_size, total_pages }
  // `slug` is the synthesis-friendly voice selector ('en_paul_neutral').
  // `id` is a provider UUID and not usable as a voice parameter.
  const raw: unknown[] = Array.isArray(body)
    ? body
    : body && typeof body === 'object' && Array.isArray((body as Record<string, unknown>)['items'])
      ? (body as { items: unknown[] }).items
      : body && typeof body === 'object' && Array.isArray((body as Record<string, unknown>)['data'])
        ? (body as { data: unknown[] }).data
        : body && typeof body === 'object' && Array.isArray((body as Record<string, unknown>)['voices'])
          ? (body as { voices: unknown[] }).voices
          : [];
  const totalPages = body && typeof body === 'object' && typeof (body as { total_pages?: unknown }).total_pages === 'number'
    ? (body as { total_pages: number }).total_pages
    : 1;
  const voices = raw.flatMap((entry): VoiceInfo[] => {
    if (!entry || typeof entry !== 'object') return [];
    const e = entry as Record<string, unknown>;
    // Prefer `slug` (Mistral's synthesis selector). Fall back to `voice` or
    // `id` for other provider shapes. Note: Mistral's `id` is a UUID — accept
    // it last, since using it as a voice param would fail.
    const id = typeof e['slug'] === 'string' ? e['slug']
      : typeof e['voice'] === 'string' ? e['voice']
      : typeof e['id'] === 'string' ? e['id']
      : undefined;
    if (!id) return [];
    // `languages` is an array (['en_us']); take the first and normalize
    // 'en_us' → 'en' for the UI. Single-string `language` accepted as fallback.
    const languages = Array.isArray(e['languages']) ? e['languages'] as unknown[] : null;
    const rawLang = languages && typeof languages[0] === 'string' ? languages[0] as string
      : typeof e['language'] === 'string' ? e['language']
      : id.split('_')[0];
    const language = rawLang ? rawLang.split('_')[0] : undefined;
    // `name` is the human-readable label ('Paul - Neutral').
    const description = typeof e['name'] === 'string' ? e['name']
      : typeof e['description'] === 'string' ? e['description']
      : typeof e['display_name'] === 'string' ? e['display_name']
      : undefined;
    return [language !== undefined ? { id, language, ...(description ? { description } : {}) } : { id, ...(description ? { description } : {}) }];
  });
  return { voices, totalPages };
}

export async function listMistralVoices(): Promise<VoiceInfo[]> {
  const now = Date.now();
  if (_voicesCache && _voicesCache.expiresAt > now) return _voicesCache.voices;
  const apiKey = process.env['MISTRAL_API_KEY'];
  if (!apiKey) return [...FALLBACK_VOICES];
  try {
    const controller = new AbortController();
    // 2 s per request × up to MAX_PAGES pages means worst case ~200 s, but in
    // practice the catalog has 3 pages and completes in < 500 ms total.
    // Signal controls the whole loop — if the first page is slow we still
    // bail after 2 s without starting page 2.
    const timer = setTimeout(() => controller.abort(), 2_000);
    const voices: VoiceInfo[] = [];
    try {
      // Fetch page 1 first so we know how many pages exist. Subsequent pages
      // come from the `total_pages` hint. Dedup by id as a belt-and-suspenders
      // measure — Mistral could in principle return overlapping pages.
      const seen = new Set<string>();
      let page = 1;
      let totalPages = 1;
      do {
        const url = `${VOICES_BASE_URL}?page=${page}`;
        const response = await fetch(url, {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${apiKey}` },
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status} on page ${page}`);
        const body: unknown = await response.json();
        const parsed = parseVoicesPage(body);
        for (const v of parsed.voices) {
          if (seen.has(v.id)) continue;
          seen.add(v.id);
          voices.push(v);
        }
        if (page === 1) totalPages = Math.min(parsed.totalPages, VOICES_MAX_PAGES);
        page++;
      } while (page <= totalPages);
    } finally {
      clearTimeout(timer);
    }
    // If Mistral returned an empty first page (mis-deployed shape, etc.) fall
    // back so the UI isn't voice-pickerless.
    const final = voices.length === 0 ? [...FALLBACK_VOICES] : voices;
    _voicesCache = { voices: final, expiresAt: now + VOICES_TTL_MS };
    return final;
  } catch {
    // Cache the fallback briefly too (60 s) so a flapping network doesn't
    // spam Mistral every request.
    _voicesCache = { voices: [...FALLBACK_VOICES], expiresAt: now + 60_000 };
    return [...FALLBACK_VOICES];
  }
}

export function hasMistralVoxtralTts(): boolean {
  return !!process.env['MISTRAL_API_KEY'];
}

interface RequestMeta {
  readonly model: string;
  readonly voice: string;
  readonly characters: number;
}

function buildBody(text: string, opts: SpeakOpts, stream: boolean): { body: string; meta: RequestMeta } {
  const model = opts.model ?? VOXTRAL_TTS_MODEL;
  const voice = opts.voice ?? DEFAULT_VOICE;
  return {
    body: JSON.stringify({ model, input: text, voice, stream }),
    meta: { model, voice, characters: text.length },
  };
}

function logRequest(meta: RequestMeta, latencyMs: number, mode: 'plain' | 'stream', tenantId: string | undefined): void {
  process.stderr.write(
    `[voxtral-tts] ${meta.model} ${mode} ${latencyMs}ms ${meta.characters}chars voice=${meta.voice}${tenantId ? ` tenant=${tenantId}` : ''}\n`,
  );
}

function logError(status: number, statusText: string, body: string, tenantId: string | undefined): void {
  process.stderr.write(
    `[voxtral-tts] ${String(status)} ${statusText}${tenantId ? ` (tenant=${tenantId})` : ''}: ${body.slice(0, 300)}\n`,
  );
}

/** One-shot synthesis. Returns decoded MP3 bytes + telemetry, or null on failure. */
export async function speakMistralVoxtral(text: string, opts: SpeakOpts = {}): Promise<SpeakResult | null> {
  const apiKey = process.env['MISTRAL_API_KEY'];
  if (!apiKey) return null;
  if (!text.trim()) return null;

  const { body, meta } = buildBody(text, opts, false);
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const started = Date.now();

  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body,
      signal: ctrl.signal,
    });
    if (!res.ok) {
      logError(res.status, res.statusText, await res.text().catch(() => ''), opts.tenantId);
      return null;
    }
    const json = (await res.json()) as { audio_data?: unknown };
    if (typeof json.audio_data !== 'string') {
      process.stderr.write('[voxtral-tts] response missing "audio_data"\n');
      return null;
    }
    const mp3 = decodeBase64(json.audio_data);
    const latencyMs = Date.now() - started;
    logRequest(meta, latencyMs, 'plain', opts.tenantId);
    return {
      mp3,
      characters: meta.characters,
      provider: 'mistral-voxtral-tts',
      model: meta.model,
      voice: meta.voice,
      latencyMs,
    };
  } catch (err: unknown) {
    process.stderr.write(`[voxtral-tts] request failed: ${getErrorMessage(err)}\n`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Streaming synthesis. Emits decoded MP3 byte chunks to `onChunk` as they
 * arrive. Returns stream telemetry (including time-to-first-byte) on success,
 * or null on failure. Streaming is mandatory for the PRD's ≤ 1.5 s TTFA target
 * on replies > ~200 chars (plain mode: 2.17 s at 300 chars; stream: 1.25 s).
 */
export async function speakMistralVoxtralStream(
  text: string,
  onChunk: AudioChunkCallback,
  opts: SpeakOpts = {},
): Promise<SpeakStreamMeta | null> {
  const apiKey = process.env['MISTRAL_API_KEY'];
  if (!apiKey) return null;
  if (!text.trim()) return null;

  const { body, meta } = buildBody(text, opts, true);
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const started = Date.now();
  let ttfbMs = 0;

  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${apiKey}`,
        'content-type': 'application/json',
        'accept': 'text/event-stream',
      },
      body,
      signal: ctrl.signal,
    });
    if (!res.ok) {
      logError(res.status, res.statusText, await res.text().catch(() => ''), opts.tenantId);
      return null;
    }
    if (!res.body) {
      process.stderr.write('[voxtral-tts] stream response missing body\n');
      return null;
    }

    for await (const evt of parseSseStream(res.body)) {
      if (evt.event !== 'speech.audio.delta') continue;
      const audio = parseAudioDelta(evt.data);
      if (!audio) continue;
      if (ttfbMs === 0) ttfbMs = Date.now() - started;
      onChunk(audio);
    }
    const latencyMs = Date.now() - started;
    logRequest(meta, latencyMs, 'stream', opts.tenantId);
    return {
      characters: meta.characters,
      provider: 'mistral-voxtral-tts',
      model: meta.model,
      voice: meta.voice,
      latencyMs,
      ttfbMs,
    };
  } catch (err: unknown) {
    process.stderr.write(`[voxtral-tts] stream failed: ${getErrorMessage(err)}\n`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function decodeBase64(s: string): Uint8Array {
  const buf = Buffer.from(s, 'base64');
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

function parseAudioDelta(data: string): Uint8Array | null {
  try {
    const parsed = JSON.parse(data) as { audio_data?: unknown };
    if (typeof parsed.audio_data !== 'string') return null;
    return decodeBase64(parsed.audio_data);
  } catch {
    return null;
  }
}

interface SseEvent { readonly event: string; readonly data: string }

/** Minimal SSE parser over a byte stream. Yields one event per blank-line-delimited frame. */
async function* parseSseStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent, void, void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = findFrameEnd(buf)) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx).replace(/^(?:\r?\n){1,2}/, '');
        const evt = parseFrame(frame);
        if (evt) yield evt;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function findFrameEnd(buf: string): number {
  const a = buf.indexOf('\n\n');
  const b = buf.indexOf('\r\n\r\n');
  if (a < 0) return b;
  if (b < 0) return a;
  return Math.min(a, b);
}

function parseFrame(frame: string): SseEvent | null {
  let event = 'message';
  const dataLines: string[] = [];
  for (const raw of frame.split(/\r?\n/)) {
    if (!raw || raw.startsWith(':')) continue;
    const colon = raw.indexOf(':');
    const field = colon < 0 ? raw : raw.slice(0, colon);
    const value = colon < 0 ? '' : raw.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join('\n') };
}

export const mistralVoxtralTtsProvider: SpeakProvider = {
  name: 'mistral-voxtral-tts',
  get isAvailable() { return hasMistralVoxtralTts(); },
  speak(text: string, opts: SpeakOpts): Promise<SpeakResult | null> {
    return speakMistralVoxtral(text, opts);
  },
  speakStream(text: string, onChunk: AudioChunkCallback, opts: SpeakOpts): Promise<SpeakStreamMeta | null> {
    return speakMistralVoxtralStream(text, onChunk, opts);
  },
};
