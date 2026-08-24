/**
 * Bugsink integration — opt-in error reporting.
 * Activated by LYNOX_BUGSINK_DSN env var or config.bugsink_dsn.
 * No DSN is hardcoded — if absent, all functions are safe no-ops.
 *
 * Uses @sentry/node SDK (Bugsink is Sentry SDK compatible).
 */

import type { LynoxError } from './errors.js';
import { maskSecretPatterns } from './secret-store.js';

/**
 * Mask credential shapes in a string bound for the error reporter.
 *
 * Fail-CLOSED on its own failure, and the choice matters: if the masker throws,
 * returning the raw text would ship the very credential this exists to catch,
 * while dropping the whole event would lose an error report to a bug in a
 * scrubber. So the field — and only the field — is replaced with a marker. The
 * report still arrives, minus the string that could not be cleared.
 */
function maskSecretText(text: string): string {
  try {
    // `includeGeneric` on purpose: an error report is machine-read, not prose,
    // so a long opaque token that turns out to be a hash costs a little
    // diagnostic detail while one that turns out to be a credential costs the
    // credential. Measured 2026-08-24 — without it a 64-hex instance secret
    // passed through untouched.
    return maskSecretPatterns(text, { includeGeneric: true });
  } catch {
    return '[redacted: masking failed]';
  }
}

/**
 * Mask every string inside an arbitrary structure, in place where possible.
 *
 * Sentry events carry credential-shaped values in more places than the message:
 * breadcrumb `data` (the http integration writes the raw query string there),
 * `extra`, `tags`, `contexts`. Walking them is cheaper than enumerating which
 * key names are safe — an allowlist of key names is the per-instance shape, and
 * the set of keys grows with every integration.
 *
 * Depth-capped because event payloads are attacker-influenced in shape as well
 * as content, and a cyclic or absurdly nested object must not turn the reporting
 * path into a hang.
 */
function maskDeep(value: unknown, depth = 0): unknown {
  if (depth > 6) return value;
  if (typeof value === 'string') return maskSecretText(value);
  if (Array.isArray(value)) return value.map((v) => maskDeep(v, depth + 1));
  if (value !== null && typeof value === 'object') {
    const out = value as Record<string, unknown>;
    for (const [k, v] of Object.entries(out)) out[k] = maskDeep(v, depth + 1);
    return out;
  }
  return value;
}

let _initialized = false;
let _enabled = false;

// Cached module reference to avoid repeated dynamic imports in hot paths
let _sentry: typeof import('@sentry/node') | null = null;

/** Keys in LynoxError.context that are safe to send as extras (no PII). */
const SAFE_CONTEXT_KEYS = new Set([
  'tool', 'toolName', 'model', 'tier', 'pipeline', 'stepId',
  'taskId', 'scopeType', 'scopeId', 'collection', 'status',
  'runId', 'sessionId', 'duration', 'durationMs', 'retryCount',
]);

/**
 * Initialize Bugsink error reporting. Safe to call multiple times — only first call has effect.
 * Returns true if error reporting was activated.
 */
export async function initErrorReporting(dsn?: string | undefined): Promise<boolean> {
  if (_initialized) return _enabled;
  _initialized = true;

  const resolvedDsn = dsn ?? process.env['LYNOX_BUGSINK_DSN'];
  if (!resolvedDsn) return false;

  try {
    const Sentry = await import('@sentry/node');
    _sentry = Sentry;

    // Read version from package.json at runtime
    let version = 'unknown';
    try {
      const { readFileSync } = await import('node:fs');
      const { join, dirname } = await import('node:path');
      const { fileURLToPath } = await import('node:url');
      const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: string };
      version = pkg.version ?? 'unknown';
    } catch {
      // Best-effort version detection
    }

    Sentry.init({
      dsn: resolvedDsn,
      release: `lynox@${version}`,
      environment: process.env['NODE_ENV'] ?? 'production',
      sampleRate: 1.0,
      tracesSampleRate: 0,     // No performance tracing (cost + PII)
      attachStacktrace: true,
      maxBreadcrumbs: 50,

      beforeBreadcrumb(breadcrumb) {
        if (breadcrumb.data) {
          delete breadcrumb.data['prompt'];
          delete breadcrumb.data['response'];
          delete breadcrumb.data['content'];
          delete breadcrumb.data['message'];
        }
        // A breadcrumb message is free text from whoever added it. The two this
        // module adds carry only tool and model names, but nothing stops another
        // caller from interpolating something credential-shaped.
        if (typeof breadcrumb.message === 'string') {
          breadcrumb.message = maskSecretText(breadcrumb.message);
        }
        // The four deletes above are a key-name denylist and the http
        // integration does not use those names — it writes `http.query`. Walk
        // whatever is left rather than growing the list.
        if (breadcrumb.data !== undefined) {
          breadcrumb.data = maskDeep(breadcrumb.data, 0) as typeof breadcrumb.data;
        }
        return breadcrumb;
      },

      beforeSend(event) {
        // Strip request bodies (may contain user prompts) AND the three fields
        // that carry credentials outright. The @sentry/node http integration is
        // on by default and attaches headers, cookies and the query string; the
        // SDK's own source notes that gating them on `sendDefaultPii` is a
        // future change, so today they ship regardless. `cookie` carries the
        // live session token and `authorization` carries a bearer — either is
        // enough to act as the user, so a read of the error store would be an
        // account takeover. They go entirely rather than masked: a masked
        // session cookie has no diagnostic value anyway.
        if (event.request) {
          delete event.request.data;
          delete event.request.cookies;
          delete event.request.headers;
          if (typeof event.request.query_string === 'string') {
            event.request.query_string = maskSecretText(event.request.query_string);
          }
        }

        // Scrubbing here is a DENYLIST over named fields, and `captureException`
        // ships `error.message` verbatim — so a credential interpolated into an
        // error string left the instance untouched. `maskSecretPatterns` already
        // existed in secret-store.ts and simply was not applied on this path;
        // this is a wiring gap, not a new mechanism.
        //
        // What this covers and what it does NOT, stated rather than implied: it
        // masks credential SHAPES (provider keys, JWTs, bearer tokens). It does
        // not mask PII — names, addresses, mail subjects — and deliberately so.
        // That would need a denylist over free text, whose form space is
        // unbounded while the set of `throw new Error(`…${…}`)` sites that feed
        // it keeps growing (208 across 40 files, measured 2026-08-24). Bugsink
        // is first-party and self-hosted, so a stripped stack trace is a
        // diagnostic loss we inflict on ourselves with no third party on the
        // other side. Whether to take that trade is a risk decision, tracked in
        // the register rather than settled here.
        for (const value of event.exception?.values ?? []) {
          if (typeof value.value === 'string') value.value = maskSecretText(value.value);
        }
        // The structured carriers. `breadcrumbs[].data` is where the http
        // integration puts the raw query string, and `extra`/`tags`/`contexts`
        // are free-form by design.
        for (const crumb of event.breadcrumbs ?? []) {
          if (crumb.data !== undefined) crumb.data = maskDeep(crumb.data, 0) as typeof crumb.data;
          if (typeof crumb.message === 'string') crumb.message = maskSecretText(crumb.message);
        }
        if (event.extra !== undefined) event.extra = maskDeep(event.extra, 0) as typeof event.extra;
        if (event.tags !== undefined) event.tags = maskDeep(event.tags, 0) as typeof event.tags;
        if (event.contexts !== undefined) event.contexts = maskDeep(event.contexts, 0) as typeof event.contexts;

        if (typeof event.message === 'string') {
          event.message = maskSecretText(event.message);
        } else if (event.message !== undefined) {
          const m = event.message as { message?: string; formatted?: string };
          if (typeof m.message === 'string') m.message = maskSecretText(m.message);
          if (typeof m.formatted === 'string') m.formatted = maskSecretText(m.formatted);
        }
        return event;
      },
    });

    _enabled = true;
    return true;
  } catch {
    _enabled = false;
    return false;
  }
}

// ── Breadcrumbs ──

/** Add a tool call breadcrumb. NO input data (may contain PII). */
export function addToolBreadcrumb(toolName: string, success: boolean, durationMs: number): void {
  if (!_enabled || !_sentry) return;
  _sentry.addBreadcrumb({
    category: 'tool',
    message: `${toolName} ${success ? 'OK' : 'FAIL'}`,
    level: success ? 'info' : 'warning',
    data: { tool: toolName, duration_ms: Math.round(durationMs), success },
  });
}

/** Add an LLM call breadcrumb. NO prompt content — only model + token counts. */
export function addLLMBreadcrumb(model: string, inputTokens: number, outputTokens: number): void {
  if (!_enabled || !_sentry) return;
  _sentry.addBreadcrumb({
    category: 'llm',
    message: `${model} in=${String(inputTokens)} out=${String(outputTokens)}`,
    level: 'info',
    data: { model, input_tokens: inputTokens, output_tokens: outputTokens },
  });
}

// ── Error capture ──

/** Capture a LynoxError with structured tags. */
export function captureLynoxError(error: LynoxError): void {
  if (!_enabled || !_sentry) return;
  const Sentry = _sentry;
  Sentry.withScope((scope) => {
    scope.setTag('error.code', error.code);
    scope.setTag('error.type', error.name);
    if (error.context) {
      for (const [k, v] of Object.entries(error.context)) {
        if (SAFE_CONTEXT_KEYS.has(k)) {
          scope.setExtra(k, v);
        }
      }
    }
    Sentry.captureException(error);
  });
}

/** Capture any generic error. */
export function captureError(error: unknown): void {
  if (!_enabled || !_sentry) return;
  _sentry.captureException(error);
}

// ── User Feedback (for /bug command) ──

export async function captureUserFeedback(opts: {
  name: string;
  comments: string;
}): Promise<string | null> {
  if (!_enabled || !_sentry) return null;
  try {
    const Sentry = _sentry;
    const eventId = Sentry.captureMessage('User bug report', 'info');
    Sentry.captureFeedback({
      name: opts.name,
      message: opts.comments,
      associatedEventId: eventId,
    });
    return eventId;
  } catch {
    return null;
  }
}

// ── Global handlers ──
//
// Tracked as named refs so a runtime opt-out (Settings → Privacy → Bugsink)
// can fully detach Sentry from the process. Without the refs, the uncaught
// exception handler would survive teardown and still call `process.exit(1)`
// after Sentry was closed — turning a recoverable opt-out into a crash.

let _uncaughtHandler: ((error: Error) => void) | null = null;
let _rejectionHandler: ((reason: unknown) => void) | null = null;

export function installGlobalHandlers(): void {
  if (!_enabled || !_sentry) return;
  if (_uncaughtHandler !== null) return;  // idempotent — re-init in same process keeps single handler
  const Sentry = _sentry;

  _uncaughtHandler = (error) => {
    Sentry.captureException(error);
    void Sentry.flush(2000).finally(() => {
      process.exit(1);
    });
  };
  _rejectionHandler = (reason) => {
    Sentry.captureException(reason);
  };

  process.on('uncaughtException', _uncaughtHandler);
  process.on('unhandledRejection', _rejectionHandler);
}

export function uninstallGlobalHandlers(): void {
  if (_uncaughtHandler !== null) {
    process.off('uncaughtException', _uncaughtHandler);
    _uncaughtHandler = null;
  }
  if (_rejectionHandler !== null) {
    process.off('unhandledRejection', _rejectionHandler);
    _rejectionHandler = null;
  }
}

// ── Shutdown ──

export async function shutdownErrorReporting(): Promise<void> {
  // Detach process listeners FIRST so a flush-time exception can't re-enter
  // the now-closing Sentry instance.
  uninstallGlobalHandlers();
  if (_sentry) {
    try {
      await _sentry.flush(5000);
      await _sentry.close();
    } catch {
      // best-effort
    }
  }
  // Reset state so a subsequent toggle false→true can re-initialise — without
  // this, `_initialized` would gate `initErrorReporting()` and silently no-op.
  _initialized = false;
  _enabled = false;
  _sentry = null;
}

/** Whether Bugsink error reporting is currently active. */
export function isErrorReportingEnabled(): boolean {
  return _enabled;
}

/** @internal Reset state for testing. */
export function _resetForTesting(): void {
  _initialized = false;
  _enabled = false;
  _sentry = null;
}
