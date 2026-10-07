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
 * the default autonomous posture otherwise denies (http writes — the guard denies
 * every method but GET and HEAD; see `permission-guard.ts`). Stored on the
 * `PlannedPipeline` JSON blob (PRD §8.1),
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
 * `assertHostPolicy` misses).
 */
/**
 * How a contract came to exist. It is NOT a permission level — it never widens what
 * the tuple grants — it is the answer to "did a human look at it?", which the grant
 * alone cannot express. It narrows in one place: `contractGrants` holds a `reviewed`
 * grant to the URL rules the person was shown (https, no port, no credentials, no
 * query, no fragment), which the tuple does not carry.
 *
 *  - `authorship`: derived automatically at save time from a workflow the user
 *    built in their own session. Note what the engine no longer does: saving used
 *    to stamp `confirmedAt` on these same grounds, and that stopped, because the
 *    tool doing the saving is called by the model. Authorship-as-authorisation is
 *    defensible for an instance someone builds for themselves; it is NOT a review,
 *    and it is no longer how a workflow becomes runnable unattended.
 *  - `reviewed`: a human was shown the set of writes the grant enforces and accepted
 *    it, and the acceptance is stamped with who, when and a checksum over what was
 *    shown, on the object that carries the contract. Two paths produce it: a bulk
 *    run's approval (`mintBulkContract`, the stamp on the run) and the grant dialog
 *    of a saved workflow (`buildReviewedContract`, the stamp beside the contract on
 *    the workflow), the latter only while its feature switch is on.
 *
 * Absent on contracts that predate the field and on imported ones (an import
 * deliberately arrives without a grant at all). Absent means "not recorded" —
 * never "reviewed".
 */
export type ContractOrigin = 'authorship' | 'reviewed';

export interface CapabilityContract {
  /** Contract schema version, stamped into each audit decision (PRD §4.3 S5). */
  version: number;
  /** How this grant came to be — see `ContractOrigin`. Optional: legacy and
   *  imported contracts carry none, and absent must not read as reviewed. */
  origin?: ContractOrigin | undefined;
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

/**
 * Whether a contract handed to a run may still lift a refusal after the run has read
 * external content. Held under a module-private symbol rather than a field: a symbol does
 * not survive JSON, so a stored, imported or hand-written contract can never carry it. Only
 * {@link withAfterUntrusted}, called by the run that verified the stamp, puts it there, and
 * it then travels the whole chain to the step agents on the same object.
 */
const AFTER_UNTRUSTED: unique symbol = Symbol('capabilityContract.afterUntrusted');

/** A copy of `contract` that may lift refusals after external content when `allowed`. */
export function withAfterUntrusted(contract: CapabilityContract, allowed: boolean): CapabilityContract {
  return Object.freeze({ ...contract, [AFTER_UNTRUSTED]: allowed });
}

/** True only for a contract {@link withAfterUntrusted} marked as allowed. */
export function liftsAfterUntrusted(contract: CapabilityContract): boolean {
  return (contract as CapabilityContract & { [AFTER_UNTRUSTED]?: boolean })[AFTER_UNTRUSTED] === true;
}

/**
 * The acceptance of a `reviewed` contract on a saved workflow, stored beside the contract
 * (not in it: the checksum covers the contract, so it cannot live inside it).
 */
export interface ReviewedGrantStamp {
  /** The auth origin of the accepting request (`local`, `bearer:user`, `cookie:<tag>` …) — measured. */
  by: string;
  /** A name typed into the dialog. Declared, not proven; absent when none was typed. */
  name?: string | undefined;
  /** When the grant was accepted (ISO 8601). */
  at: string;
  /** Digest over contract, steps, mode, parameters, bound values, cron and `afterUntrusted`. */
  checksum: string;
  /** `keyed` = HMAC under the vault key; `unkeyed` = plain SHA-256, which binds nothing a database writer cannot recompute. */
  binding: 'keyed' | 'unkeyed';
  /** The schedule this acceptance created. Any other schedule runs without the contract. */
  triggerId: string;
  /** May the contract still lift a refusal after the run has read external content? */
  afterUntrusted: boolean;
}

/**
 * The contract that governs a tool call dispatched now, as the agent decides it — or why
 * none does: `none` (the run has no contract) or `untrusted` (it has one, but the run read
 * external content before this call and the grant does not cover that case).
 */
export type GoverningContract =
  | { contract: CapabilityContract; withheld: null }
  | { contract: undefined; withheld: 'none' | 'untrusted' };
