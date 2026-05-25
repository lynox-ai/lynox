/**
 * tool-call-preview — input-preview formatter for `ToolCallTracker` (H-024).
 *
 * Produces a SHORT, secret-safe string fingerprint of a tool's input that the
 * tracker's pattern detectors (read-sensitive-then-exfil, google-read-then-
 * exfil, burst-HTTP) regex against. Lives on its OWN per-tool dispatch path,
 * so this function must be O(1) and never throw.
 *
 * **CRITICAL — secret safety**:
 *   - `http_request`: include URL ONLY (no body / headers — bodies may carry
 *     auth tokens, API keys).
 *   - `read_file` / `write_file`: include path ONLY (no file content).
 *   - `memory_store` / any tool with a `value` field: never include the value
 *     verbatim — strip it before stringify-fallback.
 *   - Catch-all: truncate to 80 chars after JSON.stringify. The 80-char cap is
 *     the safety net for tools we haven't enumerated yet — long auth tokens
 *     get sliced off mid-string.
 *
 * Preview shapes consumed by `output-guard.ts ToolCallTracker.checkAnomaly`:
 *   - `read_file` / `write_file` → `path` value (regex against `.env`, `.ssh/`)
 *   - `http_request`             → `"<METHOD> <url>"` (URL parsed via split)
 *   - `google_*`                 → `"<action>:<resource>"` (action via split)
 *   - everything else            → first 80 chars of `JSON.stringify(input)`
 */

const PREVIEW_MAX = 80;

/** Fields that often carry secrets and must never appear in the preview. */
const SECRET_VALUE_FIELDS = new Set(['value', 'apiKey', 'api_key', 'token', 'secret', 'password', 'authorization']);

export function formatToolCallPreview(name: string, input: unknown): string {
  // Defensive: input may be anything the LLM emitted (object, primitive, null).
  if (input === null || input === undefined) return '';

  // Specialised shapes that the detectors regex against.
  if (typeof input === 'object') {
    const obj = input as Record<string, unknown>;

    if (name === 'read_file' || name === 'write_file') {
      // Path only — never content. write_file's `content` field can be huge
      // and may contain secrets the agent is exfiltrating.
      const path = typeof obj['path'] === 'string' ? obj['path'] : '';
      return path.slice(0, PREVIEW_MAX);
    }

    if (name === 'http_request') {
      // URL only — body / headers may carry auth tokens. The tracker parses
      // the second whitespace-separated token as a URL.
      const method = typeof obj['method'] === 'string' ? obj['method'] : 'GET';
      const url = typeof obj['url'] === 'string' ? obj['url'] : '';
      return `${method} ${url}`.slice(0, PREVIEW_MAX);
    }

    if (name.startsWith('google_')) {
      // `<action>:<resource>` — only `action` is currently read by the tracker
      // (via `split(':')[0]`), but include resource id when available for
      // future detector refinement. Never include the full request body.
      const action = typeof obj['action'] === 'string' ? obj['action'] : '';
      const resource = (
        typeof obj['id'] === 'string' ? obj['id']
        : typeof obj['threadId'] === 'string' ? obj['threadId']
        : typeof obj['messageId'] === 'string' ? obj['messageId']
        : ''
      );
      return `${action}:${resource}`.slice(0, PREVIEW_MAX);
    }

    // Catch-all: strip known secret-bearing fields BEFORE stringify so the
    // 80-char truncation isn't the only line of defence.
    const safe: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (SECRET_VALUE_FIELDS.has(k)) continue;
      safe[k] = v;
    }
    try {
      return JSON.stringify(safe).slice(0, PREVIEW_MAX);
    } catch {
      return '';
    }
  }

  // Primitives: stringify + truncate.
  try {
    return JSON.stringify(input).slice(0, PREVIEW_MAX);
  } catch {
    return String(input).slice(0, PREVIEW_MAX);
  }
}
