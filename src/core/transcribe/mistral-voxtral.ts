/**
 * Mistral Voxtral Mini Transcribe v2 provider.
 *
 * POST https://api.mistral.ai/v1/audio/transcriptions (multipart):
 *   - file: audio blob (WebM/Opus, MP3, WAV, OGG all accepted)
 *   - model: voxtral-mini-2602
 *   - language: de | en | auto (optional)
 *
 * Auth: x-api-key header (confirmed working in Phase 0 spike).
 *
 * Deliberately sends only documented parameters. `context_biasing`,
 * `prompt`, `temperature`, `hotwords` etc. are either unsupported or silently
 * ignored (verified in Phase 0). Biasing is handled app-side via the glossary
 * post-process — never in the API request.
 *
 * EU-hosted (Mistral La Plateforme, Paris). No US or China-based providers.
 */

import { getErrorMessage } from '../utils.js';
import type { TranscribeOpts, TranscribeProvider } from './types.js';

/** Model ID verified by Phase 0 spike. The docs alias `voxtral-mini-latest` resolves to this on `/audio/transcriptions`. */
export const VOXTRAL_TRANSCRIBE_MODEL = 'voxtral-mini-2602';

const API_URL = 'https://api.mistral.ai/v1/audio/transcriptions';

/** Extension → MIME mapping for the multipart blob content type. */
const MIME_BY_EXT: Record<string, string> = {
  webm: 'audio/webm',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  flac: 'audio/flac',
};

function mimeForFilename(filename: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot < 0) return 'application/octet-stream';
  const ext = filename.slice(dot + 1).toLowerCase();
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

/** Normalize a caller-supplied language hint to what Mistral accepts. */
function normalizeLanguage(lang: string | undefined): string | null {
  if (!lang || lang === 'auto') return null;
  // Accept ISO codes like "de", "en", also full locales like "de-CH" — pass the 2-letter prefix.
  const short = lang.slice(0, 2).toLowerCase();
  return /^[a-z]{2}$/.test(short) ? short : null;
}

function audioBlob(audio: Buffer, mime: string): Blob {
  // Copy into a fresh ArrayBuffer — Node Buffer's ArrayBufferLike type won't
  // widen to Blob's required ArrayBuffer under TS strict.
  const ab = new ArrayBuffer(audio.byteLength);
  new Uint8Array(ab).set(audio);
  return new Blob([ab], { type: mime });
}

export function hasMistralVoxtral(): boolean {
  return !!process.env['MISTRAL_API_KEY'];
}

/**
 * One-shot transcription via Mistral Voxtral Mini Transcribe v2.
 * Returns the raw API text (no glossary post-process applied) or null on failure.
 *
 * Failures are logged to stderr (same pattern as the legacy whisper.cpp path)
 * and surfaced as `null`, so the facade can fall through to the next provider.
 */
export async function transcribeMistralVoxtral(
  audio: Buffer,
  filename: string,
  language?: string | undefined,
  opts?: { tenantId?: string | undefined; timeoutMs?: number | undefined },
): Promise<string | null> {
  const apiKey = process.env['MISTRAL_API_KEY'];
  if (!apiKey) return null;

  const lang = normalizeLanguage(language);
  const mime = mimeForFilename(filename);
  const timeoutMs = opts?.timeoutMs ?? 60_000;

  const form = new FormData();
  form.append('file', audioBlob(audio, mime), filename);
  form.append('model', VOXTRAL_TRANSCRIBE_MODEL);
  if (lang) form.append('language', lang);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  const started = Date.now();
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'x-api-key': apiKey },
      body: form,
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      process.stderr.write(
        `[voxtral] ${String(res.status)} ${res.statusText}${opts?.tenantId ? ` (tenant=${opts.tenantId})` : ''}: ${body.slice(0, 300)}\n`,
      );
      return null;
    }
    const json = (await res.json()) as { text?: unknown };
    if (typeof json.text !== 'string') {
      process.stderr.write('[voxtral] response missing "text" field\n');
      return null;
    }
    const latencyMs = Date.now() - started;
    process.stderr.write(
      `[voxtral] ${VOXTRAL_TRANSCRIBE_MODEL} ${latencyMs}ms${opts?.tenantId ? ` tenant=${opts.tenantId}` : ''} ${(audio.byteLength / 1024).toFixed(1)}KB\n`,
    );
    return json.text.trim() || null;
  } catch (err: unknown) {
    process.stderr.write(`[voxtral] request failed: ${getErrorMessage(err)}\n`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export const mistralVoxtralProvider: TranscribeProvider = {
  name: 'mistral-voxtral',
  get isAvailable() { return hasMistralVoxtral(); },
  async transcribe(buf: Buffer, filename: string, opts: TranscribeOpts): Promise<string | null> {
    return transcribeMistralVoxtral(buf, filename, opts.language, {
      ...(opts.tenantId !== undefined ? { tenantId: opts.tenantId } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    });
  },
  // No native streaming on the transcribe endpoint — facade simulates a
  // single "done" segment after the one-shot call for SSE consumers.
};
