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
