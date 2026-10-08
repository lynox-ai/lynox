import type { CapabilityContract, ReviewedGrantStamp } from '../types/capability-contract.js';
import { withAfterUntrusted } from '../types/capability-contract.js';
import type { PlannedPipeline } from '../types/pipeline.js';
import { canonicalJson } from './bulk-ledger.js';
import { isFeatureEnabled } from './features.js';
import { bindWorkflowParameters } from '../orchestrator/workflow-params.js';
import { buildReviewedContract, validateContractAgainstSteps } from '../orchestrator/contract-validation.js';

/**
 * The feature that lets a person grant a saved workflow a `reviewed` contract. Off by
 * default: until the remaining mail-API question is decided, no product path issues such
 * a grant. It closes BOTH requests of the dialog — the preview and the acceptance in the
 * scheduling route — because the acceptance is where the contract is written, and anyone
 * who can call the preview gets the checksum back from it: closing only the preview would
 * leave the acceptance open to the same caller. The checksum binds what was shown; it
 * says nothing about WHO accepted, and no hash key changes that.
 */
export function workflowGrantEnabled(): boolean {
  // The literal, not a constant: the env-ABI drift test reads this call site.
  return isFeatureEnabled('workflow-reviewed-grant');
}

/** What the checksum is computed with: the engine database's keyed hash. */
export interface GrantHasher {
  keyedHash(parts: Iterable<string>): string;
  readonly hashIsKeyed: boolean;
}

/** Everything a person accepted, which the checksum binds. */
export interface GrantChecksumInput {
  contract: CapabilityContract;
  steps: PlannedPipeline['steps'];
  mode: PlannedPipeline['mode'];
  parameters: PlannedPipeline['parameters'];
  boundParams: Readonly<Record<string, unknown>>;
  cron: string;
  afterUntrusted: boolean;
}

/**
 * A value as the database holds it, in canonical JSON. The acceptance may hash an
 * in-memory workflow (the pipeline cache) whose steps carry keys set to `undefined`; the
 * run hashes the blob read back, where `JSON.stringify` dropped them. Hashing the stored
 * form on both sides keeps the two computations over the same bytes.
 */
function storedForm(value: unknown): string {
  return canonicalJson(JSON.parse(JSON.stringify(value ?? null)) as unknown);
}

/**
 * The digest a grant's stamp carries, over contract, steps, mode, parameter list, bound
 * values, cron and the after-untrusted permission. Any path that changes one of them
 * without a new acceptance — known or not, a tool, a migration, a raw write — makes the
 * stamp stop matching, which is what lets the run check stop depending on a list of
 * writers. Over the stored form, so key order and keys holding `undefined` do not matter.
 */
export function grantChecksum(hasher: GrantHasher, input: GrantChecksumInput): { checksum: string; binding: 'keyed' | 'unkeyed' } {
  function* parts(): Generator<string> {
    yield 'workflow-grant-v1';
    yield storedForm(input.contract);
    yield storedForm(input.steps);
    yield input.mode;
    yield storedForm(input.parameters);
    yield storedForm(input.boundParams);
    yield input.cron;
    yield input.afterUntrusted ? 'after-untrusted' : 'clean-only';
  }
  return { checksum: hasher.keyedHash(parts()), binding: hasher.hashIsKeyed ? 'keyed' : 'unkeyed' };
}

/** The schedule a stamp names, as far as the run check needs it. */
export interface GrantTrigger {
  workflowId: string | null;
  cron: string | null;
  paramsJson: string | null;
}

/** How a run was started, as the run check needs to know it. */
export type GrantRunOrigin =
  | { kind: 'schedule'; triggerId: string }
  /** A person pressed Run in the library, over the authenticated route. */
  | { kind: 'library' };

/**
 * The contract a run gets, with the values it must run with — the schedule's, as the
 * person accepted them — or why it gets none (`null`: there was nothing to withhold).
 */
export type GrantDecision =
  | { contract: CapabilityContract; note: null; boundParams: Record<string, unknown> }
  | { contract: undefined; note: string | null };

/** Whether a run's bound values are exactly the ones a grant was accepted with. */
export function sameBoundValues(a: Readonly<Record<string, unknown>>, b: Readonly<Record<string, unknown>>): boolean {
  return storedForm(a) === storedForm(b);
}

/**
 * Letters, marks and symbols that render as nothing: the Hangul and Khmer fillers, the braille
 * blank, the grapheme joiner, the Mongolian and Khmer invisible marks, variation selectors.
 * One set, read by {@link grantName} (removes them) and by the bound-value check (refuses them),
 * so the two cannot drift apart. Exported so a test can walk every member.
 */
export const BLANK_LOOKING = /[\u034f\u115f\u1160\u17b4\u17b5\u180b-\u180f\u2800\u3164\uffa0\ufe00-\ufe0f\u{e0100}-\u{e01ef}]/u;

/**
 * Characters a bound value or a parameter name may not hold under a grant: everything outside
 * letters, marks, digits, punctuation, symbols, spaces, line breaks and tabs, and
 * {@link BLANK_LOOKING}. The grant dialog shows each value as text, and the step model receives
 * it in its context as written, so a value has to read the way it is.
 */
const HIDDEN_IN_VALUE = new RegExp(`${BLANK_LOOKING.source}|[^\\p{L}\\p{M}\\p{N}\\p{P}\\p{S}\\p{Zs}\\n\\t]`, 'u');

/**
 * Why these bound values cannot be granted, or `null`. Names and values both: a name is
 * written by whoever wrote the workflow, and the step model reads it next to its value. A
 * value that is not text is checked as the text the dialog shows for it.
 */
export function hiddenInBoundValues(params: Readonly<Record<string, unknown>>): string | null {
  for (const [name, value] of Object.entries(params)) {
    // A name is shown on one line before its value: a line break or tab in it would show as a
    // space, or start what looks like another row, so names may not hold them.
    if (HIDDEN_IN_VALUE.test(name) || /[\n\t]/.test(name)) return 'A parameter name holds a character that does not show as text. Rename the parameter in the workflow.';
    const shown = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
    if (HIDDEN_IN_VALUE.test(shown)) return `The value of parameter "${name}" holds a character that does not show as text. Enter the value again without it.`;
  }
  return null;
}

/**
 * The test `resolveTaskTemplate` asks of a `{{params…}}` value under a grant: is it exactly the
 * value the person accepted at that path? Walks own properties only, never the prototype, so
 * `{{params.toString}}` is simply not accepted. Equality is the stored form `sameBoundValues`
 * uses.
 */
export function acceptedValueMatcher(accepted: Readonly<Record<string, unknown>>): (path: string, value: unknown) => boolean {
  return (path, value) => {
    const segments = path.split('.');
    if (segments[0] !== 'params' || value === undefined || typeof value === 'function') return false;
    let at: unknown = accepted;
    for (const segment of segments.slice(1)) {
      if (at === null || typeof at !== 'object' || !Object.hasOwn(at, segment)) return false;
      at = (at as Record<string, unknown>)[segment];
    }
    if (at === undefined || typeof at === 'function') return false;
    return storedForm(at) === storedForm(value);
  };
}

function parseParams(json: string | null): Record<string, unknown> | null {
  if (json === null || json === '') return {};
  try {
    const v: unknown = JSON.parse(json);
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/**
 * Whether a saved-workflow run passes its contract on. All of these must hold:
 *  - the contract is `reviewed` (an `authorship` contract has no producer and lifts nothing);
 *  - there is a stamp;
 *  - the run is the schedule the stamp names, or a person started it from the library;
 *  - that schedule still exists and still targets this workflow;
 *  - the checksum recomputed over the workflow as stored and the schedule's cron and values
 *    equals the stamp's. A library start reads both from the schedule, never from the
 *    request.
 * Otherwise the run goes ahead WITHOUT a contract — the default refusal of unattended
 * writes — and the note says why, for the owner's run report.
 */
export function decideRunGrant(
  planned: PlannedPipeline,
  origin: GrantRunOrigin,
  lookupTrigger: (id: string) => GrantTrigger | undefined,
  hasher: GrantHasher | null,
): GrantDecision {
  const contract = planned.capabilityContract;
  if (contract === undefined) return { contract: undefined, note: null };
  const withheld = (why: string): GrantDecision => ({ contract: undefined, note: `Ran without its write grant: ${why}` });
  if (contract.origin !== 'reviewed') return withheld('the grant was never reviewed by a person.');
  const stamp: ReviewedGrantStamp | undefined = planned.reviewedGrant;
  if (stamp === undefined) return withheld('the grant has no record of its acceptance.');
  if (origin.kind === 'schedule' && origin.triggerId !== stamp.triggerId) {
    return withheld('this schedule is not the one the grant was accepted for. Schedule the workflow again from the library to grant it.');
  }
  const trigger = lookupTrigger(stamp.triggerId);
  if (trigger === undefined || trigger.workflowId !== planned.id || trigger.cron === null) {
    return withheld('the schedule the grant was accepted for no longer exists.');
  }
  const boundParams = parseParams(trigger.paramsJson);
  if (boundParams === null) return withheld('the values of the schedule the grant was accepted for cannot be read.');
  if (hasher === null) return withheld('the engine database is not available to check the grant.');
  const { checksum } = grantChecksum(hasher, {
    contract,
    steps: planned.steps,
    mode: planned.mode,
    parameters: planned.parameters ?? [],
    boundParams,
    cron: trigger.cron,
    afterUntrusted: stamp.afterUntrusted,
  });
  if (checksum !== stamp.checksum) {
    return withheld('the workflow, its values or its schedule changed after the grant was accepted. Schedule it again from the library to grant it.');
  }
  return { contract: withAfterUntrusted(contract, stamp.afterUntrusted), note: null, boundParams };
}

/** The grant dialog's request, as it arrives — both at the preview and at the acceptance. */
export interface WorkflowGrantRequest {
  method: unknown;
  host: unknown;
  paths: unknown;
  params: unknown;
  cron: string;
  afterUntrusted: unknown;
}

export type PreparedGrant =
  | {
      ok: true;
      contract: CapabilityContract;
      boundParams: Record<string, unknown>;
      afterUntrusted: boolean;
      checksum: string;
      binding: 'keyed' | 'unkeyed';
      /** One line per enforced (method, URL), the list the person is shown. */
      tuples: string[];
    }
  | { ok: false; error: string };

/**
 * Build what a person is about to accept, the same way for the preview and for the
 * acceptance: bind the values, build the one contract shape from what was typed, and
 * compute the checksum over everything that will be bound. The acceptance compares its
 * own computation with the checksum the preview returned, so what is written is what was
 * shown. Values are bound without the workflow's previous contract: the new contract pins
 * them, and the old one is being replaced.
 */
export function prepareWorkflowGrant(planned: PlannedPipeline, req: WorkflowGrantRequest, hasher: GrantHasher): PreparedGrant {
  if (typeof req.method !== 'string' || typeof req.host !== 'string') {
    return { ok: false, error: 'A grant needs a write method and a host.' };
  }
  if (!Array.isArray(req.paths) || req.paths.length === 0 || !req.paths.every((p): p is string => typeof p === 'string')) {
    return { ok: false, error: 'A grant needs at least one path.' };
  }
  if (req.afterUntrusted !== undefined && typeof req.afterUntrusted !== 'boolean') {
    return { ok: false, error: 'afterUntrusted must be true or false.' };
  }
  if (req.params !== undefined && (typeof req.params !== 'object' || req.params === null || Array.isArray(req.params))) {
    return { ok: false, error: 'Invalid "params" — expected an object of name to value.' };
  }
  const first = bindWorkflowParameters(planned.parameters ?? [], req.params as Record<string, unknown> | undefined, { requireAll: true });
  if (!first.ok) return { ok: false, error: first.error };
  // Bound once more, from its own output: the binder keeps a default as written but coerces
  // a supplied value, and every run re-binds the stored values as supplied. A number
  // parameter defaulting to "10" would otherwise be granted as "10" and run as 10 — refused
  // by its own enum, or read as "other values". After this pass the values are a fixed point.
  const bound = bindWorkflowParameters(planned.parameters ?? [], first.params, { requireAll: true });
  if (!bound.ok) return { ok: false, error: bound.error };
  const hidden = hiddenInBoundValues(bound.params);
  if (hidden !== null) return { ok: false, error: hidden };
  const built = buildReviewedContract({ method: req.method, host: req.host, paths: req.paths }, planned.steps, bound.params);
  if ('error' in built) return { ok: false, error: built.error };
  const invalid = validateContractAgainstSteps({ capabilityContract: built.contract, steps: planned.steps });
  if (invalid !== null) return { ok: false, error: invalid };
  const afterUntrusted = req.afterUntrusted === true;
  const { checksum, binding } = grantChecksum(hasher, {
    contract: built.contract,
    steps: planned.steps,
    mode: planned.mode,
    parameters: planned.parameters ?? [],
    boundParams: bound.params,
    cron: req.cron,
    afterUntrusted,
  });
  const host = built.contract.hostPatterns[0]!;
  const tuples = built.contract.pathPatterns.flatMap((p) => built.contract.httpMethods.map((m) => `${m} https://${host}${p}`));
  return { ok: true, contract: built.contract, boundParams: bound.params, afterUntrusted, checksum, binding, tuples };
}

/**
 * A name typed into the dialog, as stored. Control and line-separator characters become
 * spaces; what stays is letters (with their combining marks, which some scripts need), digits,
 * punctuation, symbols and spaces. Every other character goes: format characters (bidi,
 * zero-width, the tag block), private use, unassigned. So do characters that render as nothing
 * although Unicode files them as letters, marks or symbols: the Hangul fillers, the braille
 * blank, the grapheme joiner, the Mongolian and Khmer invisible marks, variation selectors (an
 * emoji then shows in its text style). A name must keep at least one letter or digit. Trimmed,
 * collapsed, capped at 120 code points. This reads as text; it does not tell look-alike letters
 * from different scripts apart, and does not limit how many marks stack on one letter.
 */
export function grantName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const cleaned = raw
    .normalize('NFC')
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(new RegExp(BLANK_LOOKING.source, 'gu'), '')
    .replace(/[^\p{L}\p{M}\p{N}\p{P}\p{S}\p{Zs}]/gu, '')
    .replace(/\s+/g, ' ').trim();
  const capped = [...cleaned].slice(0, 120).join('').trim();
  return /[\p{L}\p{N}]/u.test(capped) ? capped : undefined;
}

/** What the acceptance needs from the stores; the scheduling route passes the engine's. */
export interface GrantAcceptStores {
  history: {
    setWorkflowReviewedGrant(id: string, contract: CapabilityContract, stamp: ReviewedGrantStamp, confirmedAt: string): boolean;
    deleteTrigger(id: string): boolean;
  };
  taskManager: {
    createPipelineTask(params: { title: string; pipelineId: string; scheduleCron: string; pipelineParams: string }): { id: string };
  };
  hasher: GrantHasher;
}

export type GrantAcceptResult<T> =
  | { ok: true; task: T }
  | { ok: false; status: 400 | 409 | 500; error: string };

/**
 * Accept a grant the person was shown: recompute it from the same request, refuse with 409
 * when the checksum differs from the one the preview returned, then create the schedule
 * FIRST and write contract, stamp (with the schedule's id) and confirm in ONE statement.
 * Both steps are synchronous with nothing awaited between them. If the write fails or
 * throws, the schedule is deleted again rather than left without its grant.
 *
 * The caller has already checked the feature switch, the workflow (template, autonomous)
 * and the cron expression; `by` is the auth origin of the accepting request.
 */
export function acceptWorkflowGrant<T extends { id: string }>(
  planned: PlannedPipeline,
  req: WorkflowGrantRequest & { checksum: unknown; name: unknown; title: string },
  by: string,
  stores: Omit<GrantAcceptStores, 'taskManager'> & { taskManager: { createPipelineTask(params: { title: string; pipelineId: string; scheduleCron: string; pipelineParams: string }): T } },
): GrantAcceptResult<T> {
  const prepared = prepareWorkflowGrant(planned, req, stores.hasher);
  if (!prepared.ok) return { ok: false, status: 400, error: prepared.error };
  if (typeof req.checksum !== 'string' || req.checksum !== prepared.checksum) {
    return { ok: false, status: 409, error: 'The grant changed since it was shown. Review it again before accepting.' };
  }
  const task = stores.taskManager.createPipelineTask({
    title: req.title,
    pipelineId: planned.id,
    scheduleCron: req.cron,
    pipelineParams: JSON.stringify(prepared.boundParams),
  });
  const now = new Date().toISOString();
  const name = grantName(req.name);
  let written = false;
  try {
    written = stores.history.setWorkflowReviewedGrant(planned.id, prepared.contract, {
      by,
      ...(name !== undefined ? { name } : {}),
      at: now,
      checksum: prepared.checksum,
      binding: prepared.binding,
      triggerId: task.id,
      afterUntrusted: prepared.afterUntrusted,
    }, now);
  } catch {
    written = false;
  }
  if (!written) {
    stores.history.deleteTrigger(task.id);
    return { ok: false, status: 500, error: 'The grant could not be saved; nothing was scheduled.' };
  }
  return { ok: true, task };
}
