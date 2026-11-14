/**
 * Control-plane proxy for the Usage Dashboard (Phase 3 of
 * prd/usage-dashboard.md).
 *
 * Managed instances ask the control plane for their tier budget + Stripe
 * billing period so the dashboard can show "$18 of $30 included" instead
 * of the local "$18 spent" view (which has no notion of included credit).
 *
 * Non-managed instances, or managed instances where the CP is unreachable,
 * get a null response — the caller falls back to the local budget view.
 * CP unavailability must NOT break the dashboard — best-effort is the
 * contract.
 */

import type { UsageSummaryResponse } from '../contract/http.js';

const CP_SUMMARY_TIMEOUT_MS = 5_000;

/** Pre-contract public name for the wire shape — now sourced from `src/contract/http.ts`. */
export type ControlPlaneUsageSummary = UsageSummaryResponse;

/**
 * Fetch the control-plane view of this instance's usage. Returns null on
 * any failure (not managed, missing env vars, network, non-ok response,
 * unexpected shape). All logging is stderr — never throws to the caller.
 */
export async function fetchControlPlaneUsageSummary(): Promise<ControlPlaneUsageSummary | null> {
  const controlPlaneUrl = process.env['LYNOX_MANAGED_CONTROL_PLANE_URL'] ?? '';
  const instanceId = process.env['LYNOX_MANAGED_INSTANCE_ID'] ?? '';
  const secret = process.env['LYNOX_HTTP_SECRET'] ?? '';
  if (!controlPlaneUrl || !instanceId || !secret) return null;

  const url = `${controlPlaneUrl}/internal/usage/${instanceId}/summary`;
  try {
    const res = await fetch(url, {
      headers: { 'x-instance-secret': secret },
      signal: AbortSignal.timeout(CP_SUMMARY_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    // Minimal shape validation — accept anything the CP returns, reject
    // obviously broken responses. The engine proxies trusted CP data so
    // strict validation here isn't required for security, just correctness.
    if (!body || typeof body !== 'object' || typeof (body as { managed: unknown }).managed !== 'boolean') {
      return null;
    }
    return body as ControlPlaneUsageSummary;
  } catch {
    return null;
  }
}

/**
 * The used amount a managed instance shows for the current window.
 *
 * The control plane's `used_cents` counts the Stripe billing period it sends
 * along. Only then is it the same window as the engine's local sum, and only
 * then may it lift that sum (an engine younger than the billing cycle, after a
 * migration or restore, would otherwise under-report). Without a period the
 * engine counts the calendar month, and a figure counted over some other window
 * must not replace it: the local sum stands.
 */
export function managedUsedCents(localUsedCents: number, cp: ControlPlaneUsageSummary | null): number {
  if (!cp?.managed || !cp.period) return localUsedCents;
  return Math.max(localUsedCents, cp.used_cents ?? 0);
}
