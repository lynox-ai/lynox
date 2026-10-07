import type { CapabilityContract, ParamConstraint, HttpMethod } from '../types/capability-contract.js';
import type { InlinePipelineStep } from '../types/pipeline.js';
import { isOverbroadHostPattern } from '../core/pre-approve.js';
import { isMailProviderTarget } from '../core/bulk-mail-targets.js';

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

  if (contract.origin === 'reviewed') {
    const shapeError = reviewedContractShapeError(contract, planned.steps);
    if (shapeError !== null) return `Capability-contract is invalid: ${shapeError}`;
  }

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

/** The write methods a contract has any reason to grant. NOT an equality with
 *  what the autonomous posture denies — that is every method but GET and HEAD.
 *
 *  A deliberate SUBSET of `isWriteMethod` in `http.ts`, not a mirror of it — this
 *  comment said "Mirrors `WRITE_METHODS`" until that list was replaced by a predicate
 *  derived from the `undo` classes.
 *
 *  DELETE is left out on purpose, and NOT because of its undo class — POST is
 *  `none` too and is in this set. PUT/PATCH are the clear half: they overwrite
 *  state a prior read can image. POST is a JUDGEMENT, not a derivation, and the
 *  sibling comment on `undoClassFor` carries the condition this one must not drop:
 *  a POST that created something is compensatable per target, a POST that is an
 *  RPC (send, charge, trigger) is as irreversible as a DELETE, and only the
 *  response can tell them apart. Granting it anyway is the price this set pays
 *  knowingly. DELETE is excluded because putting the state back is not generally
 *  possible at all — the same hedge the sibling carries, and for the same reason:
 *  re-creating the resource needs an id the server usually owns.
 *
 *  So that the next reader does not undo this as a bug: restoring the wider set
 *  here could make an irreversible delete standing-granted with no prompt, once
 *  this producer is wired — see the note below on why nothing calls it today. */
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
 *
 * ⚠ DELIBERATELY UNWIRED. No product path calls this, and that is the decision,
 * not an oversight — do not "finish" it by hooking it into the two sites that
 * stamp `confirmedAt`. A security pass on exactly that wiring found two reasons,
 * both about the INPUT rather than this function:
 *   - a call the http consent gate DENIED is still recorded as a step
 *     (`process-capture.ts:365` filters internal tools only, and a tool-call
 *     record carries no error flag), so minting would turn a refusal into a
 *     standing grant;
 *   - the `inputTemplate` a step carries is written by a MODEL from sanitised
 *     tool OUTPUT (`process-capture.ts:184`), so injected content can choose the
 *     URL that would become grant-defining.
 * A derived grant inherits the trust level of whatever authored the steps, and
 * that is not the user. What a contract may be derived FROM is a converged-PRD
 * question; this function is the part that was answerable at the code.
 *
 * The answer since: from what a person types into the grant dialog, never from
 * recorded steps — not even as a pre-filled suggestion (`buildReviewedContract`).
 * This function stays unwired; an exception would need its own decision that
 * reopens both reasons above.
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
  // What the steps ACTUALLY perform, kept alongside the three sets the contract
  // type can express — see the exactness check below.
  const performed = new Set<string>();

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
    // A `{{ … }}` marker means the URL is not literal, and only ONE of its two
    // forms is caught above: `{{ params.x }}` names a parameter, a step-output
    // reference (`{{ s0.result }}`) names none, so the parameter check never sees
    // it. Minting from it stores the percent-encoded template TEXT as the pattern,
    // which can never match the URL the step resolves at run time — fail-closed,
    // but a grant that reads as granted and is not. Refuse instead of storing it.
    if (rawUrl.includes('{{')) return undefined;
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return undefined;
    }
    // `contractGrants` matches the resolved `hostname` and `pathname` and NOTHING
    // else — never the scheme, never the port. A contract minted from
    // `https://api.example.com:8443/orders` would therefore equally grant
    // `http://api.example.com:9999/orders`: a downgrade to cleartext, and a
    // different service on the same host. No step performs either. The matcher is
    // not the place to fix that — it shipped in B1 and other callers depend on its
    // shape — so the minter refuses the two axes it cannot express, which is what
    // keeps the sentence below true instead of merely intended.
    if (parsed.protocol !== 'https:') return undefined;
    if (parsed.port !== '') return undefined;

    // Those patterns are read as GLOBS, and exactly ONE glob character is both
    // reachable and widening: `*`. `new URL('https://a*b.example.com/x')` parses
    // with hostname `a*b.example.com`, and the grant would then match a wider set
    // than the step it came from, silently.
    //
    // `GLOB_META` refuses `?`, `[` and `]` as well, and the honest reason is not
    // the one this comment used to give. `globToRegex` ESCAPES `[` and `]`, so
    // they are not metacharacters at all; a literal `?` cannot reach `hostname` or
    // `pathname` because it opens the query. What `[`/`]` DO reach is an IPv6
    // literal (`https://[::1]/x` → hostname `[::1]`), and `contractGrants` strips
    // those brackets before matching — so minting the bracketed form yields a
    // pattern that can never match: a grant that reads as granted and is not.
    // Refusing says that at mint time rather than at 3am. (Corrected 2026-09-05
    // after the claim was measured against `globToRegex`.)
    //
    // Deriving a right from steps is only sound while the derived pattern denotes
    // exactly the literal it came from, so refuse rather than escape: a real
    // endpoint does not carry glob metacharacters, and refusing keeps the failure
    // in the one place that already means "a human has to say what is allowed".
    if (GLOB_META.test(parsed.hostname) || GLOB_META.test(parsed.pathname)) return undefined;
    methods.add(rawMethod as HttpMethod);
    hosts.add(parsed.hostname);
    paths.add(parsed.pathname);
    performed.add(`${rawMethod} ${parsed.hostname} ${parsed.pathname}`);
  }

  if (methods.size === 0) return undefined; // read-only workflow — nothing to grant

  // A contract holds methods, hosts and paths as INDEPENDENT lists, and
  // `contractGrants` matches each separately — so the grant is their CROSS
  // PRODUCT. With one host that is exactly the steps; with two hosts and two
  // paths it is four combinations for two steps, and the two the workflow never
  // performs are a widening nobody asked for. The step agent picks its own tool
  // arguments, so that widening is reachable. Mint only where the product
  // collapses onto what the steps actually do — anything else is a set of
  // endpoints a human would have to approve one by one, which is the same line
  // the parameter check draws.
  if (methods.size * hosts.size * paths.size !== performed.size) return undefined;

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

/** What a person types into the grant dialog of a saved workflow: one write verb, one
 *  host, the paths it may write to. Everything else in the contract follows from it. */
export interface ReviewedGrantEntry {
  method: string;
  host: string;
  paths: readonly string[];
}

/** Paths one grant may name. A list longer than a person reads is not a review. */
export const MAX_REVIEWED_PATHS = 20;

/**
 * The host a person typed, normalised the way the request side is (`URL` lowercases the
 * hostname, and `globToRegex` compares case-sensitively), or `null`. A port, a path,
 * credentials, a query or a fragment is refused rather than cut off: what was typed has
 * to be exactly what is granted.
 */
export function normaliseReviewedHost(entry: string): string | null {
  const raw = entry.trim();
  if (raw === '' || /[/?#@\s\\]/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(`https://${raw}`);
  } catch {
    return null;
  }
  if (url.port !== '' || url.username !== '' || url.password !== '') return null;
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') return null;
  if (GLOB_META.test(url.hostname)) return null;
  return url.hostname;
}

/** A path as typed, if it is already the literal a request resolves to: absolute, no
 *  query or fragment, no dot segments, nothing `URL` would re-encode, no glob character. */
function isLiteralReviewedPath(path: string): boolean {
  if (!path.startsWith('/') || /[?#\\]/.test(path) || GLOB_META.test(path)) return false;
  let resolved: string;
  try {
    resolved = new URL(`https://h.invalid${path}`).pathname;
  } catch {
    return false;
  }
  return resolved === path;
}

/**
 * Why a contract does not have the one shape a `reviewed` grant on a saved workflow may
 * have, or `null` when it does. The shape is the bulk run's (`mintBulkContract`), so that
 * the set a person is shown is the set that is enforced:
 *  - `http_request` only, GET plus exactly one of POST, PUT, PATCH (DELETE stays out, as in
 *    `MINTABLE_WRITE_METHODS`);
 *  - one host, literal and lowercase, and no path on it a mail API answers;
 *  - one or more literal paths;
 *  - for every parameter that flows into a tool call, an `enum` of exactly one value, and
 *    no constraint on anything else.
 * The product of methods × host × paths is then finite and equal to the list.
 *
 * Only the save of a WORKFLOW checks this (`validateContractAgainstSteps`). A bulk run's
 * contract is also `reviewed` but is stored on the run and never passes through here.
 */
export function reviewedContractShapeError(contract: CapabilityContract, steps: InlinePipelineStep[] | undefined): string | null {
  if (contract.grantedTools.length !== 1 || contract.grantedTools[0] !== 'http_request') {
    return 'a reviewed grant covers http_request and nothing else.';
  }
  const methods = contract.httpMethods.map((m) => m.toUpperCase());
  const writes = methods.filter((m) => m !== 'GET');
  if (methods.length !== 2 || !methods.includes('GET') || writes.length !== 1 || !MINTABLE_WRITE_METHODS.has(writes[0]!)) {
    return 'a reviewed grant holds GET and exactly one of POST, PUT or PATCH.';
  }
  if (contract.hostPatterns.length !== 1) return 'a reviewed grant names exactly one host.';
  const host = contract.hostPatterns[0]!;
  if (normaliseReviewedHost(host) !== host) return `host "${host}" is not a literal lowercase host name.`;
  const paths = contract.pathPatterns;
  if (paths.length === 0 || paths.length > MAX_REVIEWED_PATHS) {
    return `a reviewed grant names between 1 and ${MAX_REVIEWED_PATHS} paths.`;
  }
  for (const path of paths) {
    if (!isLiteralReviewedPath(path)) return `path "${path}" is not a literal absolute path.`;
    if (isMailProviderTarget(`https://${host}${path}`)) {
      return `https://${host}${path} is a mail API, and mail leaves the instance only once it is confirmed in the chat.`;
    }
  }
  const referenced = new Set<string>();
  for (const step of steps ?? []) {
    for (const p of paramsReferencedInTemplate(step.input_template)) referenced.add(p);
  }
  for (const [name, c] of Object.entries(contract.paramConstraints)) {
    if (!referenced.has(name)) return `parameter "${name}" is constrained but flows into no tool call.`;
    const keys = Object.keys(c).filter((k) => (c as Record<string, unknown>)[k] !== undefined);
    if (keys.length !== 1 || !Array.isArray(c.enum) || c.enum.length !== 1) {
      return `parameter "${name}" must be bound to exactly one value.`;
    }
  }
  for (const name of referenced) {
    if (!(name in contract.paramConstraints)) return `parameter "${name}" flows into a tool call and is not bound to a value.`;
  }
  return null;
}

/**
 * The contract a person's entry grants, with every parameter that reaches a tool call
 * pinned to the value bound for this schedule. Built from the dialog, never from the
 * steps: a recorded step may be a call the consent gate refused, and its template was
 * written by a model. The steps are read only for WHICH parameters need a value.
 */
export function buildReviewedContract(
  entry: ReviewedGrantEntry,
  steps: InlinePipelineStep[] | undefined,
  boundParams: Readonly<Record<string, unknown>>,
): { contract: CapabilityContract } | { error: string } {
  const method = entry.method.trim().toUpperCase();
  if (!MINTABLE_WRITE_METHODS.has(method)) return { error: 'The write method must be POST, PUT or PATCH.' };
  const host = normaliseReviewedHost(entry.host);
  if (host === null) return { error: `"${entry.host}" is not a host name. Enter the host alone, without scheme, port, path or credentials.` };
  const paths = [...new Set(entry.paths.map((p) => p.trim()).filter((p) => p !== ''))];
  const paramConstraints: Record<string, ParamConstraint> = {};
  for (const step of steps ?? []) {
    for (const name of paramsReferencedInTemplate(step.input_template)) {
      const value = boundParams[name];
      if (typeof value !== 'string' && typeof value !== 'number') {
        return { error: `Parameter "${name}" flows into a tool call and needs a text or number value for this schedule.` };
      }
      paramConstraints[name] = { enum: [value] };
    }
  }
  const contract: CapabilityContract = {
    version: 1,
    origin: 'reviewed',
    grantedTools: ['http_request'],
    httpMethods: ['GET', method as HttpMethod],
    hostPatterns: [host],
    pathPatterns: paths,
    paramConstraints,
  };
  const shapeError = reviewedContractShapeError(contract, steps);
  return shapeError === null ? { contract } : { error: shapeError.charAt(0).toUpperCase() + shapeError.slice(1) };
}
