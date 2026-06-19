/**
 * Structured raw-error extraction for a failed run's debug-export `error_text`.
 *
 * `response_text` already stores the human-readable error message; this captures
 * the fields that distinguish provider failure CLASSES — HTTP status, the
 * provider error type, the parsed response body, and any wrapped `cause` — so a
 * debugger can tell a 429 (rate limit) from a 400 (bad request) from an
 * `overloaded_error`. The SDK error objects (Anthropic `APIError`, the
 * OpenAI-compatible path for Mistral) carry `status` / `error` / `code`; a
 * `LynoxError` carries `code` / `context`; an `ExecutionError` may wrap the
 * original provider error as `cause`.
 *
 * This module only SHAPES the detail into bounded JSON. Secret-safety is layered
 * elsewhere: the column is encrypted at rest (run-history `_enc`) and the
 * debug-export scrubs the whole bundle with `maskSecretPatterns` before it
 * leaves the engine.
 */

import { LynoxError } from './errors.js';

/** Hard cap so a giant/echoed provider body can't bloat the row. */
export const ERROR_DETAIL_MAX_CHARS = 8192;

export function extractErrorDetail(err: unknown): string {
  const out: Record<string, unknown> = {};

  if (err instanceof Error) {
    out['name'] = err.name;
    out['message'] = err.message;
    // SDK/provider errors hang structured fields off the Error instance.
    const e = err as {
      status?: unknown; code?: unknown; type?: unknown; error?: unknown; cause?: unknown;
    };
    if (e.status !== undefined) out['status'] = e.status;
    if (e.code !== undefined) out['code'] = e.code;
    if (e.type !== undefined) out['type'] = e.type;
    if (e.error !== undefined) out['error'] = e.error; // parsed provider body
    if (err instanceof LynoxError && err.context !== undefined) out['context'] = err.context;
    if (e.cause instanceof Error) {
      const c = e.cause as { status?: unknown; error?: unknown };
      out['cause'] = {
        name: e.cause.name,
        message: e.cause.message,
        ...(c.status !== undefined ? { status: c.status } : {}),
        ...(c.error !== undefined ? { error: c.error } : {}),
      };
    } else if (e.cause !== undefined) {
      out['cause'] = String(e.cause);
    }
  } else if (typeof err === 'string') {
    out['raw'] = err;
  } else {
    // Plain object / unknown — best-effort structured copy, else stringify.
    try { out['raw'] = JSON.parse(JSON.stringify(err)); } catch { out['raw'] = String(err); }
  }

  let s: string;
  try { s = JSON.stringify(out); } catch { s = String(err); }
  if (s.length > ERROR_DETAIL_MAX_CHARS) s = s.slice(0, ERROR_DETAIL_MAX_CHARS) + '…[truncated]';
  return s;
}
