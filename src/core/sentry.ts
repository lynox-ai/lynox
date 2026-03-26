/**
 * Sentry integration — opt-in error reporting.
 * Activated by LYNOX_SENTRY_DSN env var or config.sentry_dsn.
 * No DSN is hardcoded — if absent, all functions are safe no-ops.
 */

import type { LynoxError } from './errors.js';

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
 * Initialize Sentry. Safe to call multiple times — only first call has effect.
 * Returns true if Sentry was activated.
 */
export async function initSentry(dsn?: string | undefined): Promise<boolean> {
  if (_initialized) return _enabled;
  _initialized = true;

  const resolvedDsn = dsn ?? process.env['LYNOX_SENTRY_DSN'];
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
        return breadcrumb;
      },

      beforeSend(event) {
        // Strip request bodies (may contain user prompts)
        if (event.request) {
          delete event.request.data;
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

export function installGlobalHandlers(): void {
  if (!_enabled || !_sentry) return;
  const Sentry = _sentry;

  process.on('uncaughtException', (error) => {
    Sentry.captureException(error);
    void Sentry.flush(2000).finally(() => {
      process.exit(1);
    });
  });

  process.on('unhandledRejection', (reason) => {
    Sentry.captureException(reason);
  });
}

// ── Shutdown ──

export async function shutdownSentry(): Promise<void> {
  if (!_enabled || !_sentry) return;
  try {
    await _sentry.flush(5000);
    await _sentry.close();
  } catch {
    // best-effort
  }
}

/** Whether Sentry is currently active. */
export function isSentryEnabled(): boolean {
  return _enabled;
}

/** @internal Reset state for testing. */
export function _resetForTesting(): void {
  _initialized = false;
  _enabled = false;
  _sentry = null;
}
