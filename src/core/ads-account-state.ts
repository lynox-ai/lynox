/**
 * Pure deterministic account-state classifier.
 *
 * Reads the audit run + KPIs + finding count + verification result,
 * returns a 5-bucket state classification + a short reason. Drives
 * the Strategist Brief: a fresh account needs a Greenfield Plan, a
 * messy account needs a Restructure Roadmap, a high-performing
 * account needs a Watchdog brief, etc.
 *
 * No I/O beyond what the audit engine already produced — this lives
 * downstream of `runAudit` and pulls from the AuditResult.
 */
import type {
  AdsAccountState, CustomerProfileRow,
} from './ads-data-store.js';
import type { AuditResult } from './ads-audit-engine.js';

export interface AccountStateVerdict {
  state: AdsAccountState;
  reason: string;
}

export function classifyAccountState(result: AuditResult): AccountStateVerdict {
  const customer: CustomerProfileRow | null = result.customer;
  const findings = result.findings;
  const kpis = result.kpis;
  const mode = result.mode;

  const highCount = findings.filter(f => f.severity === 'HIGH').length;
  const mediumCount = findings.filter(f => f.severity === 'MEDIUM').length;
  const blockCount = findings.filter(f => f.severity === 'BLOCK').length;

  // Greenfield: zero structural data — no campaigns, no spend.
  if (kpis.clicks === 0 && kpis.impressions === 0 && kpis.spend === 0) {
    return {
      state: 'greenfield',
      reason: 'No spend, no clicks, no impressions in the snapshot — account is empty.',
    };
  }

  // Bootstrap: first cycle OR insufficient data for restructure decisions.
  // Mirrors mode-detector logic: BOOTSTRAP / FIRST_IMPORT modes are by
  // definition "still warming up". Strategist treats them as Setup-phase.
  if (mode.detected === 'BOOTSTRAP' || mode.detected === 'FIRST_IMPORT') {
    return {
      state: 'bootstrap',
      reason: `Mode-detector says ${mode.detected}: ${mode.detectedReason}`,
    };
  }

  // Performance grade — drives the messy/structured/high-perf split.
  // Only meaningful when we have a target_roas to compare against.
  // Without a target, fall back to finding-count heuristics.
  const targetRoas = customer?.target_roas ?? null;
  const actualRoas = kpis.roas;
  const ratio = (targetRoas !== null && targetRoas > 0 && actualRoas !== null && actualRoas > 0)
    ? actualRoas / targetRoas
    : null;

  // High-performance: ROAS ≥ 1.3× target AND no HIGH/BLOCK findings AND
  // ≤ 2 MEDIUM findings. The "leave it alone" zone — Strategist's job
  // is to flag what NOT to touch.
  if (ratio !== null && actualRoas !== null && ratio >= 1.3
    && highCount === 0 && blockCount === 0 && mediumCount <= 2) {
    return {
      state: 'high_performance',
      reason: `ROAS ${actualRoas.toFixed(2)}x is ${(ratio * 100).toFixed(0)}% of target ${targetRoas!.toFixed(2)}x with ${highCount + mediumCount + blockCount} findings — protect-mode.`,
    };
  }

  // Messy: many HIGH findings (≥ 3) OR ROAS < 0.7× target. Account is
  // bleeding budget structurally — Strategist should propose a phased
  // restructure roadmap, not a quick patch.
  if (highCount >= 3 || (ratio !== null && ratio < 0.7) || blockCount > 0) {
    const reasons: string[] = [];
    if (highCount >= 3) reasons.push(`${highCount} HIGH-severity findings`);
    if (blockCount > 0) reasons.push(`${blockCount} BLOCK-severity findings`);
    if (ratio !== null && actualRoas !== null && ratio < 0.7) {
      reasons.push(`ROAS ${actualRoas.toFixed(2)}x under-delivers vs ${targetRoas!.toFixed(2)}x target`);
    }
    return {
      state: 'messy_running',
      reason: `Restructure required: ${reasons.join('; ')}.`,
    };
  }

  // Default: structured + optimizing. ROAS within target band, 0-2
  // HIGH findings, regular cycle work. Strategist proposes incremental
  // tweaks + verifies last cycle's impact.
  const roasLabel = actualRoas !== null && actualRoas > 0
    ? `${actualRoas.toFixed(2)}x` : 'n/a';
  return {
    state: 'structured_optimizing',
    reason: `${highCount} HIGH + ${mediumCount} MEDIUM findings; ROAS ${roasLabel}${ratio !== null ? ` (${(ratio * 100).toFixed(0)}% of target)` : ''}. Incremental optimization mode.`,
  };
}
