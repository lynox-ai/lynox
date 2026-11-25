/**
 * The owner's takeover of a workflow a mandate set up or changed, from the library: the way out
 * once that mandate's access ended, without a paused plan to take over.
 *
 * It is one act: the owner looks at the steps and takes the workflow over. The commit covers every
 * mandate mark on the workflow (`COVER_FROM_MARKS`), releases the paused plans no member holds any
 * more, and stamps the steps as they are (`WorkflowStore.stampCurrent`), so a run from the library
 * then runs as the owner. Everything the preview shows is bound by its digest; the commit refuses
 * anything that moved since.
 *
 * Which workflows can be taken over: the decision is read at the mark `planMandate` picks (the
 * editor's before the creator's), and only with a proven end (`principalHasEnded`): there is no
 * pause here, so no renewal to recognise. A renewed grant is live, the workflow runs as that
 * mandate again, and there is nothing to take over. When the decision allows it, every mark is
 * covered, a live creator's too (`workflowCover`): covering only the ended editor would hand the
 * work to a member who was none before.
 *
 * Built on `takeover-core.ts`, like the plan takeover.
 */
import { createHash } from 'node:crypto';
import { newCorrelationId } from './audit-log.js';
import { isMandateConnection, type ApiStore } from './api-store.js';
import { canonicalHost } from './canonical-host.js';
import type { StampEntry } from './plan-run-context.js';
import { connectionShown } from './profile-secret-view.js';
import { stampFromRow } from './plan-stamp.js';
import {
  MANDATE_TAG_PREFIX, OWNER_PRINCIPAL, creatorCovered, editorCovered, isMandateTag, planAuthorshipOf, principalHasEnded, principalTag,
  type RequestPrincipal,
} from './request-principal.js';
import {
  COVER_FROM_MARKS, commitTakeover, coverAuditTarget, coverEffects, marksOf, release, releasedForDigest,
  workflowConfirmedAt, workflowCover, workflowRowOf,
  type TakeoverCoreDeps, type TakeoverMemberChange, type WorkflowRow,
} from './takeover-core.js';
import type { TriggerStore } from './trigger-store.js';
import type { GrantHasher } from './workflow-grant.js';
import { nextWorkflowStamp, withWorkflowDefaults, workflowStampDigest } from './workflow-stamp.js';
import type { WorkflowStore } from './workflow-store.js';
import type { PlannedPipeline } from '../types/pipeline.js';
import type { TriggerRecord } from '../types/index.js';

/** The digest's own domain, so neither a stamp digest nor a plan takeover's passes for this one. */
export const WORKFLOW_TAKEOVER_DIGEST_PREFIX = 'lynox:workflow-takeover:v1';

/** Why a workflow cannot be taken over, before anything is written. */
export type WorkflowTakeoverRefusal = 'unreadable' | 'nothing_to_take_over' | 'mandate_live' | 'running';

export interface WorkflowTakeoverDeps extends TakeoverCoreDeps {
  readonly triggers: Pick<TriggerStore, 'getById' | 'endWait' | 'getStampConnections'>;
  /** The owner's stamp over the steps, written on the same engine.db connection as `db`. */
  readonly workflows: Pick<WorkflowStore, 'stampCurrent'>;
  /** The engine's keyed hash, the one the stamp's digest is taken with. */
  readonly hasher: GrantHasher;
  /** The connections; null when the store is not there, which shows none. */
  readonly profiles: Pick<ApiStore, 'knownProfiles' | 'getByHostname'> | null;
}

/** A mandate mark on the workflow the takeover covers (one an earlier takeover covered is not shown), as the owner is shown it. */
export interface WorkflowTakeoverMark {
  readonly name: string;
  readonly role: 'workflow-created' | 'workflow-edited';
  /** `principalHasEnded`: false for a member that still has access, whose mark is covered too. */
  readonly ended: boolean;
  /** A mark without a grant id: whose access it was cannot be told, and it counts as ended. */
  readonly undetermined?: true;
}

/** A connection a covered mark's mandate made, which a run as the owner does not use. */
export interface WorkflowTakeoverConnection {
  readonly profileId: string;
  /** The service, as the plan takeover names it (`connectionShown`). */
  readonly provider: string;
  readonly account: string | null;
  /** The address of the mandate that connected it. */
  readonly by: string;
}

export interface WorkflowTakeoverPreview {
  readonly expect: string;
  readonly workflow: { readonly id: string; readonly name: string };
  /** The definition as stored, with its defaults filled as the stamp reads it (`withWorkflowDefaults`): what the preview shows. */
  readonly planned: PlannedPipeline;
  readonly marks: readonly WorkflowTakeoverMark[];
  readonly memberChanges: readonly TakeoverMemberChange[];
  readonly alsoReleased: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  /** Paused plans that stay paused: a member still holds them (their own mark); each is taken over on its own. */
  readonly stillPaused: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  /** Plans whose list of allowed connections lapses with the new stamp. */
  readonly lapsing: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  readonly connections: readonly WorkflowTakeoverConnection[];
  /**
   * Captured steps whose call goes to a profile some mandate connected (whoever it was), with that
   * profile; `null` for a step whose target is set only when it runs, while a connection of a covered
   * mark's mandate is in play: it may use one. `null` never means a step goes to no such profile.
   */
  readonly foreignConnectionSteps: ReadonlyArray<{ readonly step: string; readonly profileId: string | null }>;
}

export type WorkflowTakeoverPreviewResult =
  | { readonly kind: 'preview'; readonly preview: WorkflowTakeoverPreview }
  | { readonly kind: 'refused'; readonly refusal: WorkflowTakeoverRefusal }
  | { readonly kind: 'not_found' };

export type WorkflowTakeoverResult =
  | { readonly kind: 'taken_over'; readonly id: string; readonly runsAs: string }
  | { readonly kind: 'refused'; readonly refusal: WorkflowTakeoverRefusal | 'changed' | 'prompts' | 'unrecorded' | 'stamp_refused' }
  | { readonly kind: 'not_found' };

/** The workflow store refused the stamp inside the transaction: everything is rolled back. */
class StampRefused extends Error {}

/** Everything the takeover decides, from one synchronous read. */
export interface WorkflowTakeoverState {
  readonly wf: WorkflowRow;
  readonly planned: PlannedPipeline;
  readonly runsAs: RequestPrincipal;
  readonly marks: readonly WorkflowTakeoverMark[];
  readonly memberChanges: readonly TakeoverMemberChange[];
  readonly released: readonly TriggerRecord[];
  readonly stillPaused: readonly TriggerRecord[];
  readonly lapsing: ReadonlyArray<{ readonly trigger: TriggerRecord; readonly entries: readonly StampEntry[] }>;
  readonly connections: readonly (WorkflowTakeoverConnection & { readonly grant: string })[];
  readonly foreignConnectionSteps: ReadonlyArray<{ readonly step: string; readonly profileId: string | null }>;
  /** The digest of the steps as they are, the stamp is held to. */
  readonly stampDigest: string;
  /** The grant ids of the mandate marks the takeover covers that were not covered yet, for the audit row. */
  readonly coveredMandates: readonly string[];
  readonly expect: string;
}

/** The tool whose call the runtime sends with a profile's connection (`http.ts`). */
const REQUEST_TOOL = 'http_request';
/** The tool that plans a bulk run; its writes go with the connection of `target_host` (`worker-loop.ts`). */
const BULK_TOOL = 'bulk_plan';
/** A placeholder a captured call resolves raw when it runs (`contract-validation.ts`). */
const PLACEHOLDER = '{{';

/**
 * Where a captured step's call goes, read off the call: a host, `'at_run'` when a placeholder
 * stands where the host is decided, or `null` for a call that uses no connection. A placeholder
 * resolves raw, so one anywhere before the path (scheme, user info, host, port) can move the host:
 * that call's target is set only when it runs.
 */
function stepTarget(step: unknown): { readonly host: string } | 'at_run' | null {
  if (step === null || typeof step !== 'object') return null;
  const { tool, input_template: input } = step as { tool?: unknown; input_template?: unknown };
  if (input === null || typeof input !== 'object') return null;
  if (tool === BULK_TOOL) {
    const host = (input as Record<string, unknown>)['target_host'];
    if (typeof host !== 'string') return null;
    if (host.includes(PLACEHOLDER)) return 'at_run';
    const canonical = canonicalHost(host);
    return canonical === null ? null : { host: canonical };
  }
  if (tool !== REQUEST_TOOL) return null;
  const url = (input as Record<string, unknown>)['url'];
  if (typeof url !== 'string') return null;
  // The part that decides the host: everything up to the path. Without a scheme, all of it.
  const scheme = url.indexOf('://');
  const path = scheme === -1 ? -1 : url.slice(scheme + 3).search(/[/?#\\]/);
  const head = scheme === -1 || path === -1 ? url : url.slice(0, scheme + 3 + path);
  if (head.includes(PLACEHOLDER)) return 'at_run';
  try {
    return { host: new URL(url).hostname };
  } catch {
    return null;
  }
}

/**
 * Reads the workflow and decides. Synchronous, so a caller in a transaction reads one state.
 * Returns a refusal for a workflow that cannot be taken over; throws nothing.
 */
export function workflowTakeoverOf(deps: WorkflowTakeoverDeps, wfId: string): WorkflowTakeoverState | WorkflowTakeoverRefusal | 'not_found' {
  const db = deps.db;
  let wf: WorkflowRow | undefined;
  try {
    wf = workflowRowOf(db, wfId);
  } catch {
    return 'unreadable';
  }
  if (wf === undefined || wf.id !== wfId) return 'not_found';
  const isLive = deps.isLive;
  const { wfMark, coverWorkflow, runsAs } = workflowCover(planAuthorshipOf(wf), new Set(), null, isLive);
  if (wfMark === undefined) return 'nothing_to_take_over';
  if (!coverWorkflow) return 'mandate_live';

  let planned: PlannedPipeline;
  try {
    const parsed: unknown = JSON.parse(wf.definition_json);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return 'unreadable';
    planned = parsed as PlannedPipeline;
  } catch {
    return 'unreadable';
  }

  const now = deps.now?.() ?? new Date();
  const effects = coverEffects(deps, wf.id, null, wfMark, now);
  if (effects === 'running') return 'running';
  const { memberChanges, released } = effects;

  // Every mandate mark is covered (`COVER_FROM_MARKS`), whichever the decision read. A mark an
  // earlier takeover covered is the owner's already: it is not shown, and not recorded again.
  const authorship = planAuthorshipOf(wf);
  const marks: WorkflowTakeoverMark[] = [];
  const grantEmail = new Map<string, string>();
  const markCols: Array<{ tag: string | null; id: string | null; role: WorkflowTakeoverMark['role']; covered: boolean }> = [
    { tag: wf.created_by ?? null, id: wf.created_mandate_id ?? null, role: 'workflow-created', covered: creatorCovered(authorship) },
    { tag: wf.mandate_editor ?? null, id: wf.mandate_editor_id ?? null, role: 'workflow-edited', covered: editorCovered(authorship) },
  ];
  for (const m of markCols) {
    if (!isMandateTag(m.tag) || m.covered) continue;
    const email = m.tag!.slice(MANDATE_TAG_PREFIX.length);
    if (m.id === null || m.id === '') {
      marks.push({ name: email, role: m.role, ended: true, undetermined: true });
      continue;
    }
    grantEmail.set(m.id, email);
    marks.push({ name: email, role: m.role, ended: principalHasEnded({ kind: 'mandate', email, mandateId: m.id }, isLive) });
  }
  const coveredMandates = [...grantEmail.keys()].sort();

  // The other plans on the workflow: paused ones the cover does not release stay paused.
  const releasedIds = new Set(released.map((r) => r.id));
  const onWorkflow = db.prepare("SELECT id FROM triggers WHERE target_workflow_id = ? AND status != 'completed' ORDER BY id")
    .all(wf.id) as Array<{ id: string }>;
  const plans = onWorkflow.map(({ id }) => deps.triggers.getById(id)).filter((t): t is TriggerRecord => t !== undefined);
  const stillPaused = plans.filter((t) => t.paused_at !== undefined && !releasedIds.has(t.id));

  // A new stamp moves `confirmedAt`, and every list of allowed connections made against the old
  // one stops holding (`stampFromRow`). A stamp that already holds moves nothing.
  const stampDigest = workflowStampDigest(deps.hasher, planned).digest;
  const stampMoves = nextWorkflowStamp(deps.hasher, planned, now.toISOString()) !== null;
  const lapsing: Array<{ trigger: TriggerRecord; entries: readonly StampEntry[] }> = [];
  if (stampMoves) {
    const wfAt = workflowConfirmedAt(wf);
    for (const t of plans) {
      const s = deps.triggers.getStampConnections(t.id);
      const entries = s === undefined ? null : stampFromRow(s.stampConnections, s.confirmedAt, wfAt);
      if (entries !== null) lapsing.push({ trigger: t, entries });
    }
  }

  // The connections of the mandates whose marks are covered, by grant id: a run as the owner does
  // not reach them. A consent without a grant id cannot be told to be theirs, and gets no line.
  const connections: Array<WorkflowTakeoverConnection & { grant: string }> = [];
  const foreignConnectionSteps: Array<{ step: string; profileId: string | null }> = [];
  if (deps.profiles !== null) {
    for (const p of deps.profiles.knownProfiles()) {
      const grant = p.oauth_grant?.connected_mandate_id;
      if (!isMandateConnection(p) || grant === undefined) continue;
      const by = grantEmail.get(grant);
      // The provider is read here, with the rest: a profile gone or moved by the commit is `changed`.
      if (by !== undefined) connections.push({ profileId: p.id, grant, provider: connectionShown(p).provider, account: p.oauth_grant?.account?.label ?? null, by });
    }
    connections.sort((a, b) => (a.profileId < b.profileId ? -1 : a.profileId > b.profileId ? 1 : 0));
    // A step whose target can be read off its call is marked when that target is a mandate's
    // connection. One whose target is set only when it runs may reach one: it is marked, without a
    // profile, as long as a connection of a covered mark's mandate is in play.
    const steps: unknown[] = Array.isArray(planned.steps) ? planned.steps : [];
    for (const st of steps) {
      const id = (st as { id?: unknown }).id;
      if (typeof id !== 'string') continue;
      const target = stepTarget(st);
      if (target === 'at_run') {
        if (connections.length > 0) foreignConnectionSteps.push({ step: id, profileId: null });
        continue;
      }
      const p = target === null ? undefined : deps.profiles.getByHostname(target.host);
      if (p !== undefined && isMandateConnection(p)) foreignConnectionSteps.push({ step: id, profileId: p.id });
    }
  }

  const expect = createHash('sha256').update(JSON.stringify([
    WORKFLOW_TAKEOVER_DIGEST_PREFIX,
    wf.id,
    createHash('sha256').update(wf.definition_json).digest('hex'),
    marksOf(wf), markCols.map((m) => m.covered),
    coverWorkflow, principalTag(runsAs),
    memberChanges, releasedForDigest(released),
    stillPaused.map((t) => [t.id, t.title]),
    lapsing.map((l) => [l.trigger.id, l.trigger.title, l.entries]),
    marks.map((m) => [m.role, m.name, m.ended, m.undetermined === true]),
    connections.map((c) => [c.profileId, c.grant, c.account, c.provider]),
    foreignConnectionSteps.map((f) => [f.step, f.profileId]),
  ])).digest('hex');

  return {
    wf, planned, runsAs, marks, memberChanges, released, stillPaused, lapsing, connections, foreignConnectionSteps,
    stampDigest, coveredMandates, expect,
  };
}

/** What the owner is shown before taking the workflow over: one read, no await. */
export function workflowTakeoverPreview(deps: WorkflowTakeoverDeps, wfId: string): WorkflowTakeoverPreviewResult {
  const s = workflowTakeoverOf(deps, wfId);
  if (s === 'not_found') return { kind: 'not_found' };
  if (typeof s === 'string') return { kind: 'refused', refusal: s };
  const brief = (t: TriggerRecord): { id: string; title: string } => ({ id: t.id, title: t.title });
  return {
    kind: 'preview',
    preview: {
      expect: s.expect,
      workflow: { id: s.wf.id, name: s.wf.name },
      planned: withWorkflowDefaults(structuredClone(s.planned)),
      marks: s.marks,
      memberChanges: s.memberChanges,
      alsoReleased: s.released.map(brief),
      stillPaused: s.stillPaused.map(brief),
      lapsing: s.lapsing.map((l) => brief(l.trigger)),
      connections: s.connections.map(({ profileId, provider, account, by }) => ({ profileId, provider, account, by })),
      foreignConnectionSteps: s.foreignConnectionSteps,
    },
  };
}

/**
 * Takes the workflow over, against the digest the owner was shown (`expect`), through
 * `commitTakeover`: the prompts of the plans it releases are settled first, then one immediate
 * engine.db transaction decides again and writes the cover, the releases, the owner's stamp over
 * the steps and the audit row. A stamp the store refuses (the steps moved under it) rolls all of
 * it back as `stamp_refused`.
 */
export function takeOverWorkflow(deps: WorkflowTakeoverDeps, wfId: string, expect: string): WorkflowTakeoverResult {
  try {
    return commitWorkflowTakeover(deps, wfId, expect);
  } catch (err: unknown) {
    if (err instanceof StampRefused) return { kind: 'refused', refusal: 'stamp_refused' };
    throw err;
  }
}

function commitWorkflowTakeover(deps: WorkflowTakeoverDeps, wfId: string, expect: string): WorkflowTakeoverResult {
  return commitTakeover(deps, expect, () => {
    const s = workflowTakeoverOf(deps, wfId);
    if (s === 'not_found') return { stop: { kind: 'not_found' } as WorkflowTakeoverResult };
    if (typeof s === 'string') return { stop: { kind: 'refused', refusal: s } as WorkflowTakeoverResult };
    return { ok: s };
  },
  (s) => s.released.map((r) => r.id),
  (s, now, record): WorkflowTakeoverResult => {
    const nowS = Math.floor(now.getTime() / 1000);
    deps.db.prepare(`UPDATE workflows SET ${COVER_FROM_MARKS} WHERE id = ?`).run(nowS, s.wf.id);
    for (const t of s.released) release(deps, t, now);
    if (!deps.workflows.stampCurrent(s.wf.id, now.toISOString(), s.stampDigest)) throw new StampRefused('the stamp could not be written');
    record({
      principal: OWNER_PRINCIPAL, action: 'workflow.takeover', phase: 'done', correlationId: newCorrelationId(),
      target: coverAuditTarget(`workflow=${s.wf.id}`, s.coveredMandates, s.released),
    });
    return { kind: 'taken_over', id: s.wf.id, runsAs: principalTag(OWNER_PRINCIPAL) };
  });
}
