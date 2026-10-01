/**
 * Classify an LLM provider failure as a BILLING / quota stop.
 *
 * This is the class of failure that (a) does not heal on retry, (b) hits every
 * tenant sharing that provider account at once, and (c) today surfaces ONLY as a
 * per-request error the tenant sees as a broken chat — `/api/health` stays green
 * because the engine is fine, its upstream is not. On managed hosting the control
 * plane pays the LLM bill, so a suspended/credit-exhausted provider account is a
 * full outage for every tenant on it, invisible to us until a customer reports it.
 *
 * This module is the FIRST half of closing that gap: it turns the raw provider
 * error into a typed {@link RunFailure}. `agent.ts` records it, `session.ts` puts
 * it on the `RunContext`, and the managed hook reports it to the CP as an incident
 * (see managed-hook.ts) — which alerts naming the provider on the FIRST tenant
 * failure, not a fleet-wide pattern.
 *
 * Measured error shapes (fast-bench live runs 2026-08-09/10; the tests quote the
 * real bodies):
 *   - Fireworks: HTTP 412 PRECONDITION_FAILED — "Account … is suspended, possibly
 *     due to reaching the monthly spending limit or failure to pay past invoices".
 *   - Anthropic: HTTP 400 invalid_request_error — "Your credit balance is too low
 *     to access the Anthropic API".
 *   - Mistral: no documented billing code (its docs list only 429 for limits), so
 *     it is caught by the generic 402 / vocabulary path and measured as a follow-up.
 *
 * DEFENCE (why `host` is a parameter, not read from the error): body vocabulary is
 * trusted ONLY from a vetted provider host. `host` is where WE sent the request —
 * a config value, not attacker-controlled — so a custom/BYOK endpoint cannot forge
 * a billing incident by returning "suspended" in its body. Status-only signals
 * (402 Payment Required) are read on any host; the CP alert path additionally
 * fires only for a managed provider_type, so even a forged status is a log line at
 * worst on a BYOK instance.
 */

/** A provider billing/quota stop — the one failure kind this module recognises. */
export interface ProviderBillingFailure {
  kind: 'provider_billing';
  /** The host the failing request targeted, so the CP alert can name the provider. */
  providerHost: string;
  /** The HTTP status that carried the signal. */
  status: number;
}

/** The union of run-failure classes surfaced on `RunContext.failure`. One today. */
export type RunFailure = ProviderBillingFailure;

/** Hosts whose error BODY we trust for billing-vocabulary classification. */
const BILLING_TRUSTED_HOSTS: ReadonlySet<string> = new Set([
  'api.anthropic.com',
  'api.mistral.ai',
  'api.fireworks.ai',
]);

/**
 * Billing / quota vocabulary — matched ONLY against a trusted host's body. Kept
 * to durable phrases a provider uses for an account-level money stop; deliberately
 * NOT "quota" alone (a per-minute rate limit says "quota" too and is a retryable
 * 429, which the caller excludes by status before this ever runs).
 */
const BILLING_VOCAB =
  /\b(?:suspended|insufficient\s+(?:credit|balance|funds)|credit\s+balance\s+is\s+too\s+low|spending\s+limit|past\s+due|unpaid\s+invoice|payment\s+required)\b/i;

/** Upper bound on the error text scanned for billing vocabulary. A provider's
 *  money-stop phrase is at the front of the body; a multi-MB echoed body must not
 *  be scanned (or copied) in full. */
const MAX_SCAN_CHARS = 8192;

/**
 * The HTTP status carried by the two error shapes the engine throws for an LLM
 * call — cheaply, without touching the body:
 *   - the OpenAI-compatible adapter's `Error("OpenAI-compatible API error <status>: …")`
 *     (openai-adapter.ts) — status is the leading 3-digit group;
 *   - the Anthropic SDK `APIError` — a numeric `.status` (duck-typed so this module
 *     stays dependency-free and cheap to test).
 * Anything else yields `undefined`, which never classifies.
 */
function readStatus(err: Error): number | undefined {
  const adapter = /^OpenAI-compatible API error (\d{3})\b/.exec(err.message);
  if (adapter) return Number(adapter[1]);
  const e = err as { status?: unknown };
  return typeof e.status === 'number' ? e.status : undefined;
}

/**
 * The text scanned for billing vocabulary — message + any parsed provider body —
 * bounded to {@link MAX_SCAN_CHARS}. Built ONLY when the trusted-host vocabulary
 * branch is actually reached, so the common 402/412/untrusted paths never pay for
 * it (a large echoed body would otherwise be copied then discarded).
 */
function readScanText(err: Error): string {
  const adapter = /^OpenAI-compatible API error \d{3}: ([\s\S]*)$/.exec(err.message);
  if (adapter) return (adapter[1] ?? '').slice(0, MAX_SCAN_CHARS);
  let text = err.message;
  const e = err as { error?: unknown };
  if (e.error !== undefined && text.length < MAX_SCAN_CHARS) {
    try { text += ' ' + JSON.stringify(e.error); } catch { /* body not serialisable — message alone */ }
  }
  return text.slice(0, MAX_SCAN_CHARS);
}

/**
 * Classify `err` (from an LLM call to `host`) as a provider billing stop, or
 * `null` if it is not one. `host` is the request's target hostname (lower-case),
 * a trusted config value — see the module docstring.
 *
 * A 429 is never billing: it is a retryable rate limit, and the retry layer has
 * already decided a terminal failure by the time this runs — but excluded here
 * too so a body that happens to say "spending limit" on a 429 cannot flip it.
 *
 * NB: this answers "is this a billing failure?" semantically; it does NOT decide
 * whether to ALERT on it. The managed hook gates emission on the control plane
 * actually funding this instance, so a BYOK tenant's own-account 402 never raises
 * a pooled-provider alert.
 */
export function classifyProviderFailure(err: unknown, host: string): RunFailure | null {
  if (!(err instanceof Error)) return null;
  const status = readStatus(err);
  if (status === undefined || status === 429) return null;

  const billing = (): RunFailure => ({ kind: 'provider_billing', providerHost: host, status });

  // 1. 402 Payment Required — unambiguous, host-independent (a status, not a body).
  if (status === 402) return billing();

  // 2. Fireworks signals a suspended/unpaid account with 412 PRECONDITION_FAILED.
  if (host === 'api.fireworks.ai' && status === 412) return billing();

  // 3. A trusted provider's 4xx (not 429) whose body carries billing vocabulary —
  //    covers Anthropic 400 "credit balance is too low" and Mistral's undocumented
  //    shape. Untrusted hosts never reach this branch, so the body (which they can
  //    influence) is never trusted, and the scan text is built only here.
  if (BILLING_TRUSTED_HOSTS.has(host) && status >= 400 && status < 500 && BILLING_VOCAB.test(readScanText(err))) {
    return billing();
  }

  return null;
}
