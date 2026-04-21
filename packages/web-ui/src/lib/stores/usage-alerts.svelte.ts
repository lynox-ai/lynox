/**
 * Usage budget threshold alerts (Phase 4 of prd/usage-dashboard.md).
 *
 * Fires toasts when the user crosses 80 % / 95 % of their budget so they see
 * the warning *before* the next run 5xxs on budget exhaustion. Checks run
 * after every run (triggered from chat.svelte.ts `done` event) with a 30 s
 * cache on the backend — cheap. Each threshold fires at most once per
 * billing period; the "period" key is the period_start_iso from
 * /api/usage/summary, so a new month naturally resets the alerts.
 *
 * Skips silently when budget_cents is 0 (Managed tier before Phase 3 proxy
 * lands, or Self-Host without a configured monthly limit).
 */

import { getApiBase } from '../config.svelte.js';
import { t } from '../i18n.svelte.js';
import { addToast } from './toast.svelte.js';

interface UsageSummary {
  period: { start_iso: string };
  used_cents: number;
  budget_cents: number;
}

const STORAGE_KEY = 'lynox_usage_threshold_fired';
const THRESHOLDS = [80, 95] as const;

// Map: period_start_iso → highest percent threshold already fired this period.
// Persisted so a page reload doesn't re-alert the user.
function loadFired(): Map<string, number> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Map();
    const obj = JSON.parse(raw) as Record<string, number>;
    return new Map(Object.entries(obj));
  } catch {
    return new Map();
  }
}

function saveFired(fired: Map<string, number>): void {
  try {
    const obj: Record<string, number> = {};
    // Keep only the two most recent periods so the map doesn't grow forever
    // on long-running sessions. Sort by period_start_iso desc, take top 2.
    const keep = [...fired.entries()].sort((a, b) => b[0].localeCompare(a[0])).slice(0, 2);
    for (const [k, v] of keep) obj[k] = v;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
  } catch {
    // localStorage can throw in private mode / disabled — the alert will
    // just fire again next time instead of being de-duped. No user harm.
  }
}

// Don't hit the API more than once every 30 s regardless of how fast runs
// complete — aligns with the backend's 30 s TTL cache so the rate doesn't
// beat the cache anyway.
const MIN_CHECK_INTERVAL_MS = 30_000;
let _lastCheckAtMs = 0;
let _inflight: Promise<void> | null = null;

export async function checkUsageThreshold(): Promise<void> {
  if (_inflight) return _inflight;
  const now = Date.now();
  if (now - _lastCheckAtMs < MIN_CHECK_INTERVAL_MS) return;
  _lastCheckAtMs = now;

  _inflight = (async () => {
    try {
      const res = await fetch(`${getApiBase()}/usage/summary?period=current`);
      if (!res.ok) return;
      const summary = (await res.json()) as UsageSummary;
      if (summary.budget_cents <= 0) return; // no limit set → nothing to alert on
      const pct = (summary.used_cents / summary.budget_cents) * 100;
      const period = summary.period.start_iso;
      const fired = loadFired();
      const alreadyFired = fired.get(period) ?? 0;
      // Find the highest threshold this run crossed that hasn't fired yet.
      const toFire = THRESHOLDS.filter(th => pct >= th && alreadyFired < th).pop();
      if (toFire === undefined) return;
      // Toast store only knows 'success' | 'error' | 'info'. 95 % is urgent
      // enough for the red (error) style; 80 % is informational.
      const kind = toFire >= 95 ? 'error' : 'info';
      const key = toFire >= 95 ? 'usage.toast_95_pct' : 'usage.toast_80_pct';
      addToast(t(key), kind, 6_000);
      fired.set(period, toFire);
      saveFired(fired);
    } catch {
      // Usage endpoint is best-effort from the UI side — a fetch failure
      // should never surface as a user-visible error. The next run will
      // try again after the rate-limit window.
    } finally {
      _inflight = null;
    }
  })();

  return _inflight;
}
