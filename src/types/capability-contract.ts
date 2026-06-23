// === Capability Contract (reserved seam — Slice A1) ===

/**
 * Capability contract for a saved workflow — the explicit grant that authorises
 * a headless (`autonomous`) run to perform the outbound writes the default
 * autonomous posture otherwise denies (http POST/PUT/PATCH, non-workspace
 * writes, …; see `permission-guard.ts`).
 *
 * **RESERVED SEAM (this is Slice A1).** The field + its threading exist now so
 * the enforcement point (`isDangerous`, `core/agent.ts`) carries the contract
 * alongside `autonomy` / `preApproval`, but A1 attaches **no enforcement
 * logic**: a `null` / `undefined` contract means "no grant", i.e. the safe
 * autonomous-deny default (PRD §4.2 S7). Slice B fills in the real shape
 * (declared-at-save, first-run-confirmed, method + path pinned, params
 * constrained at bind) and wires it into `isDangerous`.
 *
 * The single `version` field is the anchor the append-only audit trail stamps
 * onto each allow/block decision ("was this op permitted at run time", PRD §4.3
 * S5) — Slice B grows the grant fields beneath it.
 */
export interface CapabilityContract {
  /** Contract schema version, stamped into each audit decision (Slice B / S5). */
  version: number;
  // Slice B: grantedTools, httpMethods, hostPatterns, pathPatterns, paramConstraints…
}
