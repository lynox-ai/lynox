import type { CapabilityContract, ParamConstraint, HttpMethod } from '../types/capability-contract.js';
import type { InlinePipelineStep } from '../types/pipeline.js';
import { isOverbroadHostPattern } from '../core/pre-approve.js';

/**
 * Base `params.<name>` reference. Captures the base name up to the next path
 * separator (`.`), the closing brace, or whitespace — the SAME segment the
 * runtime resolves: `resolveInputTemplate` → `getByPath` splits the path on `.`
 * ONLY, so the base param key is everything after `params.` up to the first `.`,
 * INCLUDING non-word chars (`-`, `$`, unicode). The capture class MUST match
 * that, not `[a-zA-Z0-9_]+`: a narrower class makes a param named e.g.
 * `target-host`, `data$x`, or a leading-non-ASCII `δata` capture the wrong
 * prefix (or, leading-special, NOTHING) → its reference is invisible to the
 * validator → it slips past fail-closed UNCONSTRAINED, reopening the S1 body-
 * exfil vector (release-harden 2026-06-24). A nested `{{params.customer.id}}`
 * still captures the base `customer` (stops at the `.`) — correct, getByPath
 * re-targets through it, so constraining `customer` covers it.
 */
const PARAM_REF = /\{\{\s*params\.([^.}\s]+)/g;

/** A constraint is *effective* only if it actually narrows the value — an empty
 * `{}` or `{ enum: [] }` constrains nothing, which would silently re-open the
 * S1 vector the contract exists to close, so it must NOT count as "constrained". */
export function isEffectiveConstraint(c: ParamConstraint | undefined): boolean {
  if (!c) return false;
  return (
    (Array.isArray(c.enum) && c.enum.length > 0) ||
    c.regex !== undefined ||
    c.min !== undefined ||
    c.max !== undefined
  );
}

/** Collect every `params.<name>` referenced anywhere inside a step's literal
 * input template (the values that resolve RAW into the executed tool call). */
function paramsReferencedInTemplate(template: Record<string, unknown> | undefined): Set<string> {
  const found = new Set<string>();
  if (!template) return found;
  const walk = (v: unknown): void => {
    if (typeof v === 'string') {
      for (const m of v.matchAll(PARAM_REF)) found.add(m[1]!);
    } else if (Array.isArray(v)) {
      for (const item of v) walk(item);
    } else if (v !== null && typeof v === 'object') {
      for (const val of Object.values(v as Record<string, unknown>)) walk(val);
    }
  };
  walk(template);
  return found;
}

/**
 * Fail-closed save-time validation of a workflow's capability contract (PRD
 * §4.2/§8.3, decision D2). A contract-governed workflow may re-target raw
 * parameters into its literal tool calls (`input_template`, resolved without a
 * data boundary by `resolveInputTemplate`). To close the S1 body-exfil vector —
 * a re-target param picking *which* tenant data is sent to an otherwise-allowed
 * host — **every parameter that flows into a tool call must declare a
 * constraint**. If any doesn't, the contract is rejected here at save (surfaced
 * to the human at the consent surface, Slice B2), not silently allowed at run.
 *
 * No contract → returns null (an ungoverned workflow is unaffected; this is why
 * wiring it at the save chokepoint can't regress existing playbooks). Returns an
 * error string when the contract is invalid, otherwise null.
 */
export function validateContractAgainstSteps(planned: {
  capabilityContract?: CapabilityContract | undefined;
  steps?: InlinePipelineStep[] | undefined;
}): string | null {
  const contract = planned.capabilityContract;
  if (!contract) return null;

  // Reject a match-(nearly)-anything host grant (`hostPatterns: ['*']`/`['**']`):
  // it would let a contract-governed autonomous run reach ANY host (fleet-wide
  // egress), which no pinned-host contract should authorise. Uses the SAME matcher
  // the dispatch-time check uses (`globToRegex`), so it can't drift from enforcement.
  const overbroadHosts = (contract.hostPatterns ?? []).filter(isOverbroadHostPattern);
  if (overbroadHosts.length > 0) {
    return (
      `Capability-contract is invalid: host pattern(s) ${overbroadHosts.join(', ')} match ` +
      `effectively any host. A contract-governed workflow must pin specific hosts so an ` +
      `unattended run cannot redirect an outbound call to an arbitrary destination.`
    );
  }

  // Only an *effective* constraint counts — a vacuous `{}`/`{ enum: [] }` entry
  // would pass a key-presence check yet enforce nothing at bind (fail-open).
  const constrained = new Set(
    Object.entries(contract.paramConstraints ?? {})
      .filter(([, c]) => isEffectiveConstraint(c))
      .map(([name]) => name),
  );
  const referenced = new Set<string>();
  for (const step of planned.steps ?? []) {
    for (const p of paramsReferencedInTemplate(step.input_template)) referenced.add(p);
  }

  const unconstrained = [...referenced].filter(p => !constrained.has(p));
  if (unconstrained.length > 0) {
    return (
      `Capability-contract is invalid: parameter(s) ${unconstrained.join(', ')} flow into a ` +
      `tool call but declare no constraint (enum/regex/min-max). A contract-governed workflow ` +
      `must constrain every re-targetable parameter so a run cannot redirect an outbound call.`
    );
  }
  return null;
}

/** The methods the default autonomous posture denies, i.e. the only ones a
 *  contract has any reason to grant. Mirrors `WRITE_METHODS` in `http.ts`. */
const MINTABLE_WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH']);

/** Characters `globToRegex` gives meaning to. A pattern containing one no longer
 *  denotes the literal it was derived from. */
const GLOB_META = /[*?[\]]/;

/**
 * Derive a capability contract from a workflow's steps — the producer Slice B1
 * left out ("no product path writes a contract onto a saved workflow yet").
 *
 * It mints for exactly one shape and refuses every other, and the refusal is the
 * interesting half: **a contract can only be derived when the outbound write is
 * fully literal.** The moment a `{{ params.x }}` reaches a step's tool call, the
 * grant would have to state WHICH values are admissible — and that is a human
 * judgement the template does not carry. `validateContractAgainstSteps` already
 * refuses a contract that leaves such a parameter unconstrained, and it refuses
 * a vacuous constraint too, so a minter that guessed would either wedge saving
 * or fail open. Returning `undefined` keeps the workflow exactly as it is today:
 * unattended writes stay denied until a human declares the constraints.
 *
 * That boundary is not a limitation of this function. It is where authorship
 * stops being sufficient — the same line the product draws between "the user
 * built this themselves" and "someone accepted what it may do".
 *
 * Returns `undefined` when there is nothing to grant, when any step's call is
 * parameterised, or when a write target is not a literal absolute URL.
 */
export function mintContractFromSteps(steps: InlinePipelineStep[] | undefined): CapabilityContract | undefined {
  if (!steps || steps.length === 0) return undefined;

  // Parameterised anywhere → not derivable. Checked across ALL steps, not just
  // the writing one: a param that reaches any tool call is the case the grant
  // cannot describe, and scoping this to http steps would mint a contract whose
  // own save validator then rejects it.
  for (const step of steps) {
    if (paramsReferencedInTemplate(step.input_template).size > 0) return undefined;
  }

  const methods = new Set<HttpMethod>();
  const hosts = new Set<string>();
  const paths = new Set<string>();

  for (const step of steps) {
    if (step.tool !== 'http_request') continue;
    const template = step.input_template;
    if (!template) continue;
    const rawMethod = typeof template['method'] === 'string' ? template['method'].toUpperCase() : 'GET';
    if (!MINTABLE_WRITE_METHODS.has(rawMethod)) continue;
    const rawUrl = template['url'];
    // A non-literal target cannot be pinned, and an unpinned host is exactly the
    // fleet-wide grant the validator rejects — refuse the whole contract rather
    // than mint a partial one that silently omits a write the workflow performs.
    if (typeof rawUrl !== 'string') return undefined;
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return undefined;
    }
    // The minter writes these patterns and `contractGrants` reads them as GLOBS
    // (`globToRegex`: `*`, `**`, `?`, `[…]`). A literal URL is allowed to contain
    // those characters — `new URL('https://a*b.example.com/x')` parses, hostname
    // `a*b.example.com` — and the grant would then match a WIDER set than the
    // step it was derived from, silently. Deriving from steps is only sound while
    // the derived pattern denotes exactly the literal it came from, so refuse
    // rather than escape: a real endpoint does not carry glob metacharacters, and
    // refusing keeps the failure in the one place that already means "a human has
    // to say what is allowed".
    if (GLOB_META.test(parsed.hostname) || GLOB_META.test(parsed.pathname)) return undefined;
    methods.add(rawMethod as HttpMethod);
    hosts.add(parsed.hostname);
    paths.add(parsed.pathname);
  }

  if (methods.size === 0) return undefined; // read-only workflow — nothing to grant

  return {
    version: 1,
    origin: 'authorship',
    grantedTools: ['http_request'],
    httpMethods: [...methods],
    hostPatterns: [...hosts],
    pathPatterns: [...paths],
    // Empty by construction: the parameter check above guarantees no
    // re-targetable parameter exists, which is the only thing constraints bind.
    paramConstraints: {},
  };
}
