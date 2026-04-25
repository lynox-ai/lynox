/**
 * One-shot Mistral account health check fired at engine startup.
 *
 * Background: Voxtral STT/TTS and Mistral Large 3 (eu-sovereign mode) all
 * call api.mistral.ai. Without this check, the only signal of a depleted
 * account / expired key was the user clicking the speaker button, getting
 * a generic toast, and the operator hunting stderr for the actual reason.
 * Rafael hit exactly that on 2026-04-24 — Mistral budget had bottomed out
 * and TTS silently failed in production.
 *
 * This module hits GET /v1/models once at startup with a 5 s timeout and
 * surfaces the account-health signals (invalid key, no credits, rate
 * limit) as Bugsink warnings + stderr lines so the operator sees the
 * problem in the logs instead of via customer reports.
 *
 * Best-effort: a network glitch must NOT block engine start, and the
 * check is silent on success / when no key is configured.
 */

import { captureError } from './error-reporting.js';
import { getErrorMessage } from './utils.js';

const MODELS_URL = 'https://api.mistral.ai/v1/models';
const TIMEOUT_MS = 5_000;

export type MistralHealthStatus =
  | { readonly status: 'ok' }
  | { readonly status: 'no_key' }
  | { readonly status: 'invalid_key'; readonly httpStatus: number }
  | { readonly status: 'no_credits'; readonly httpStatus: number }
  | { readonly status: 'rate_limited'; readonly httpStatus: number }
  | { readonly status: 'http_error'; readonly httpStatus: number; readonly body: string }
  | { readonly status: 'network_error'; readonly message: string };

/**
 * Probe Mistral's `/v1/models` endpoint with the configured API key.
 * Returns a structured status; the caller decides whether to log/report.
 * Never throws; aborts after `TIMEOUT_MS`.
 *
 * Status mapping:
 *   - HTTP 200       → `ok`
 *   - HTTP 401       → `invalid_key` (Mistral rejects the bearer token)
 *   - HTTP 402       → `no_credits` (Payment Required — account depleted)
 *   - HTTP 429       → `rate_limited` (per-minute or quota cap hit)
 *   - other 4xx/5xx  → `http_error` (with truncated body)
 *   - fetch threw    → `network_error`
 */
export async function checkMistralAccountHealth(): Promise<MistralHealthStatus> {
  const apiKey = process.env['MISTRAL_API_KEY'];
  if (!apiKey || apiKey.length === 0) return { status: 'no_key' };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(MODELS_URL, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${apiKey}` },
      signal: ctrl.signal,
    });
    if (res.ok) return { status: 'ok' };
    if (res.status === 401) return { status: 'invalid_key', httpStatus: 401 };
    if (res.status === 402) return { status: 'no_credits', httpStatus: 402 };
    if (res.status === 429) return { status: 'rate_limited', httpStatus: 429 };
    const body = await res.text().catch(() => '');
    return { status: 'http_error', httpStatus: res.status, body: body.slice(0, 200) };
  } catch (err) {
    return { status: 'network_error', message: getErrorMessage(err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run the health check and surface failures via stderr + Bugsink.
 * Best-effort, non-throwing — safe to call in startup callbacks.
 *
 * `ok`, `no_key`, and `network_error` stay silent: a successful probe
 * needs no log; no key means nothing to check; network jitter at startup
 * is too noisy to warrant a Bugsink event.
 */
export async function reportMistralAccountHealth(): Promise<void> {
  let result: MistralHealthStatus;
  try {
    result = await checkMistralAccountHealth();
  } catch {
    // checkMistralAccountHealth never throws by design, but the type
    // system can't prove it across the boundary — defensive belt.
    return;
  }
  switch (result.status) {
    case 'ok':
    case 'no_key':
    case 'network_error':
      return;
    case 'invalid_key':
      process.stderr.write(
        '[mistral-health] MISTRAL_API_KEY rejected (HTTP 401). Voxtral STT/TTS and Mistral-mode LLM calls will fail. Update the key in your config or env.\n',
      );
      captureError(new Error('Mistral health check: API key invalid (401)'));
      return;
    case 'no_credits':
      process.stderr.write(
        '[mistral-health] Mistral account has no remaining credits (HTTP 402). Voxtral STT/TTS and Mistral-mode LLM calls will fail until the account is topped up.\n',
      );
      captureError(new Error('Mistral health check: account out of credits (402)'));
      return;
    case 'rate_limited':
      process.stderr.write(
        '[mistral-health] Mistral rate limit hit at startup (HTTP 429). May be transient; check the dashboard if it persists.\n',
      );
      captureError(new Error('Mistral health check: rate limited at startup (429)'));
      return;
    case 'http_error':
      process.stderr.write(
        `[mistral-health] Mistral /v1/models returned HTTP ${String(result.httpStatus)}: ${result.body}\n`,
      );
      captureError(new Error(`Mistral health check: HTTP ${String(result.httpStatus)}`));
      return;
  }
}
