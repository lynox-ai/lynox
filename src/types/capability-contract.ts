// === Capability Contract (Slice B — the unattended-write grant) ===

/** HTTP methods a contract can pin for `http_request`. */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';

/**
 * Per-parameter constraint applied at bind time (`bindWorkflowParameters`),
 * BEFORE the value is substituted raw into a step's literal tool call
 * (`resolveInputTemplate`, `orchestrator/context.ts` — no data boundary). This
 * is the defence for the S1 body-exfil case the host/method/path pin can't
 * catch: a re-target body param that selects *which* tenant data is POSTed to an
 * otherwise-allowed host. A contract-governed workflow must declare a constraint
 * for every re-targetable parameter that flows into a tool call (enforced at
 * save by `validateContractAgainstSteps`) — fail-closed, PRD §4.2/§8.3.
 *
 * All fields optional; the ones present are ALL enforced (AND-combined).
 */
export interface ParamConstraint {
  /** Allow-list of exact values (string or number, compared with ===). An empty
   *  array admits nothing (deny-all), never everything. */
  enum?: ReadonlyArray<string | number> | undefined;
  /** Regex source; the engine anchors it to a FULL match (`^(?:…)$`), so the
   *  value's whole string form must satisfy it (no substring match). */
  regex?: string | undefined;
  /** Inclusive numeric lower bound (applies only to a `type:'number'` param). */
  min?: number | undefined;
  /** Inclusive numeric upper bound (applies only to a `type:'number'` param). */
  max?: number | undefined;
}

/**
 * Capability contract for a saved workflow — the explicit, human-confirmed grant
 * that authorises a headless (`autonomous`) run to perform the outbound writes
 * the default autonomous posture otherwise denies (http POST/PUT/PATCH; see
 * `permission-guard.ts`). Stored on the `PlannedPipeline` JSON blob (PRD §8.1),
 * declared at save, confirmed once by a human at promote-to-cron (Slice B2).
 *
 * **Additive grant, never a lift of a `[BLOCKED]` critical.** A present contract
 * lifts a *warn-level* autonomous denial for an explicitly declared
 * `(tool, method, host, path)` tuple — and only that tuple. It does NOT restrict
 * otherwise-allowed benign ops (the default posture already does that), and it
 * never lifts a `[BLOCKED]` critical (CRITICAL_BASH, sensitive-path, http
 * DELETE) — those keep their marker and fall through exactly like a pre-approval
 * can't override a critical. A `null`/`undefined` contract = the safe
 * autonomous-deny default (PRD §4.2 S7).
 *
 * Enforced per-tool-call at `isDangerous` (`tools/permission-guard.ts`), carried
 * there beside `autonomy`/`preApproval` via `RunManifestOptions.capabilityContract`
 * → `new Agent` → the danger check. The grant requires host AND path AND method
 * to all match, so a re-target param that resolved into a different
 * host/path/method is NOT granted → stays denied (the S1 fix the host-only
 * `applyHostPolicy` misses).
 */
export interface CapabilityContract {
  /** Contract schema version, stamped into each audit decision (PRD §4.3 S5). */
  version: number;
  /**
   * Tools the contract grants warn-level autonomous writes for (e.g.
   * `['http_request']`). B1 knows how to grant `http_request` (the documented
   * exfil vector) among them; a tool not listed here is never granted.
   */
  grantedTools: string[];
  /** Methods `http_request` may use under this grant (pins the method, S1). */
  httpMethods: HttpMethod[];
  /** Glob patterns the request hostname must match (pins the host, S1). */
  hostPatterns: string[];
  /** Glob patterns the request pathname must match (pins the path, S1). */
  pathPatterns: string[];
  /** Per-parameter bind-time constraints, keyed by parameter name (S1). */
  paramConstraints: Record<string, ParamConstraint>;
}
