import { webhookAwaitsStampReason } from './worker-notices.js';
import type { PlannedPipeline } from '../types/pipeline.js';
import { inferPipelineMode } from '../orchestrator/human-in-the-loop.js';
import { storedForm, type GrantHasher } from './workflow-grant.js';
import { isMandateTag, type PlanAuthorship } from './request-principal.js';

/**
 * The owner's stamp on a workflow, bound to what it runs.
 * `confirmedAt` alone is a time: it says someone stamped, not what. The stamp beside it carries
 * the digest of the definition as stamped, so a change by any writer (a tool, a backfill, a
 * restored file, a raw edit) makes it stop holding, and the run check does not depend on a list
 * of writers. `at` repeats `confirmedAt`: a writer that moves one without the other breaks the stamp.
 */
export interface WorkflowStamp {
  readonly at: string;
  readonly digest: string;
  readonly binding: 'keyed' | 'unkeyed';
}

/**
 * Fill the defaults a stored definition may lack (rows from before the fields existed). Every
 * reader that judges a definition goes through this, so the digest at stamping and at the run
 * check is taken over the same form. Mutates and returns the input.
 */
export function withWorkflowDefaults(planned: PlannedPipeline): PlannedPipeline {
  planned.template ??= false;
  planned.parameters ??= [];
  planned.on_failure ??= 'stop';
  // A blob without a step list (hand-written, unreadable) is judged as one with none.
  if (planned.mode === undefined) planned.mode = inferPipelineMode(Array.isArray(planned.steps) ? planned.steps : []);
  return planned;
}

/**
 * The digest over what a run of the workflow does: its id, steps (the task text and a captured
 * step's literal call alike), mode, parameters, failure strategy, limits and contract. Name,
 * goal, the `executed` flag and the stamp itself are left out: they change nothing that runs.
 */
export function workflowStampDigest(hasher: GrantHasher, planned: PlannedPipeline): { digest: string; binding: 'keyed' | 'unkeyed' } {
  const copy = structuredClone(planned);
  // A blob without a step list (unreadable or hand-written) is digested as one with none, so
  // the digest never throws; such a workflow has nothing a stamp could hold over anyway.
  if (!Array.isArray(copy.steps)) copy.steps = [];
  const p = withWorkflowDefaults(copy);
  function* parts(): Generator<string> {
    yield 'workflow-stamp-v1';
    yield p.id;
    yield storedForm(p.steps);
    yield p.mode;
    yield storedForm(p.parameters);
    yield p.on_failure ?? 'stop';
    yield storedForm(p.limits);
    yield storedForm(p.capabilityContract);
  }
  return { digest: hasher.keyedHash(parts()), binding: hasher.hashIsKeyed ? 'keyed' : 'unkeyed' };
}

/** The stamp a definition carries, or null when it has none or it does not parse. */
export function stampOf(planned: PlannedPipeline): WorkflowStamp | null {
  const s = (planned as { stamp?: unknown }).stamp;
  if (s === null || typeof s !== 'object') return null;
  const { at, digest, binding } = s as Record<string, unknown>;
  if (typeof at !== 'string' || typeof digest !== 'string' || (binding !== 'keyed' && binding !== 'unkeyed')) return null;
  return { at, digest, binding };
}

/**
 * Whether the owner's stamp on this definition holds: a stamp is there, names the same time as
 * `confirmedAt`, was taken with this engine's hash, and its digest is the one of the definition
 * as it stands. Without a hasher nothing holds. A stamp without a digest does not hold either:
 * the boot pass gave every stamp from before the digest one, once (`stampExistingWorkflows`).
 */
export function workflowStampHolds(hasher: GrantHasher | null, planned: PlannedPipeline): boolean {
  if (hasher === null || typeof planned.confirmedAt !== 'string' || planned.confirmedAt === '') return false;
  const s = stampOf(planned);
  if (s === null || s.at !== planned.confirmedAt) return false;
  const now = workflowStampDigest(hasher, planned);
  return s.binding === now.binding && s.digest === now.digest;
}

/**
 * Where a workflow stands for an unattended run:
 * - `holds`: the owner's stamp holds, it runs.
 * - `awaits_owner_stamp`: a mandate set up or changed it (taken over or not) and the owner has not
 *   stamped its steps, or a stamp is there that does not hold (the steps changed after it). It waits for the owner to look at its
 *   steps and stamp them; nothing switches its schedule off.
 * - `unconfirmed`: the owner's own workflow, never stamped. The run check's older branch.
 */
export type WorkflowStampState = 'holds' | 'awaits_owner_stamp' | 'unconfirmed';

/**
 * Whether a mandate ever set up or changed the workflow, taken over or not. A takeover covers the
 * marks of a plan so it runs as the owner's, but the owner never saw the steps in it
 * (`plan-takeover.ts` shows the workflow by name): such steps still need the owner's own stamp act.
 */
export function mandateTouched(a: PlanAuthorship): boolean {
  return isMandateTag(a.created_by) || isMandateTag(a.mandate_editor);
}

export function workflowStampState(hasher: GrantHasher | null, planned: PlannedPipeline, authorship: PlanAuthorship | undefined): WorkflowStampState {
  if (workflowStampHolds(hasher, planned)) return 'holds';
  if (authorship !== undefined && mandateTouched(authorship)) return 'awaits_owner_stamp';
  return planned.confirmedAt ? 'awaits_owner_stamp' : 'unconfirmed';
}

/**
 * The stamp to write for `planned` at `at`, or null when the stamp it carries already holds: a
 * stamp over unchanged steps moves nothing, so the lists of the workflow's schedules, bound to
 * this digest, stay valid (`plan-stamp.ts`).
 */
export function nextWorkflowStamp(hasher: GrantHasher, planned: PlannedPipeline, at: string): WorkflowStamp | null {
  if (workflowStampHolds(hasher, planned)) return null;
  const { digest, binding } = workflowStampDigest(hasher, planned);
  return { at, digest, binding };
}

/** What a run reads the stamp's state from: the run history, which holds the engine's hash and
 *  the workflow's marks (`RunHistory.workflowStampState`). */
export interface WorkflowStampSource {
  getRunHistory(): { workflowStampState(planned: PlannedPipeline): WorkflowStampState } | null;
}

/** {@link workflowStampState} for `planned` as the engine holds it. Without a run history nothing holds. */
export function workflowStampStateOf(engine: WorkflowStampSource, planned: PlannedPipeline): WorkflowStampState {
  return engine.getRunHistory()?.workflowStampState(planned) ?? workflowStampState(null, planned, undefined);
}

/** Why a workflow that waits for the owner's stamp did not run. Read by the owner and by an agent. */
export function workflowAwaitsStampResult(id: string): string {
  return `Not run: workflow "${id}" waits for its owner to review its steps — they were set up or changed by someone you let in, or changed after you stamped them. Review its steps under Automation → Workflows and stamp them; it runs after that.`;
}

/** Why a webhook's event of a workflow that waits for the owner's stamp was dropped (the notice
 *  tables read it back, `worker-notices.ts`). */
export function WEBHOOK_AWAITS_STAMP_REASON(id: string): string {
  return webhookAwaitsStampReason(id);
}

/**
 * The runner's own check, asked of the workflow exactly as it reads it: no edit can fall
 * between it and the run (`runSavedWorkflow`'s `checkWorkflow`). Null: it may run.
 */
export function workflowStampRefusal(engine: WorkflowStampSource, planned: PlannedPipeline): string | null {
  const state = workflowStampStateOf(engine, planned);
  if (state === 'holds') return null;
  return state === 'awaits_owner_stamp'
    ? workflowAwaitsStampResult(planned.id)
    : `Not run: workflow "${planned.id}" needs first-run confirmation by the owner.`;
}

/** A copy of `planned` carrying the owner's stamp over its steps as they are, at `at`. */
export function withOwnerStamp<T extends PlannedPipeline>(hasher: GrantHasher, planned: T, at: string): T {
  const { digest, binding } = workflowStampDigest(hasher, planned);
  return { ...planned, confirmedAt: at, stamp: { at, digest, binding } };
}
