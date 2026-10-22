/**
 * The actor trail for a mandate's writes INSIDE the instance (PRD customer-granted-operator-access
 * §3.6): a memory, a table, a task, an API profile. The outward trail (`Agent._beginOutwardTrail`)
 * records what a call sends out; this records what a handler changes here.
 *
 * Every place a handler changes something is one `site` (`INSTANCE_WRITE_SITES`), and the
 * handler wraps the block from its first change to its return in {@link withInstanceWrite}:
 *  - the `attempt` row is written synchronously before the block starts, outside any
 *    transaction, so it is committed before the first change;
 *  - when it cannot be written (no log, the insert threw, or the target or kind could not be
 *    read) the block does not run, the call's slot is poisoned and every later write of the call
 *    is refused too. The dispatch then answers with `INSTANCE_WRITE_UNRECORDED`, whatever the
 *    handler made of the throw. The refusal comes before the block runs, so no `catch` inside a
 *    block can take it;
 *  - after the block one outcome row: `returned` when it returned, `failed` when it threw.
 *    Neither says that anything was written: a block that returned can have written nothing,
 *    and one that threw can have written a part. An attempt without an outcome was tried, its
 *    outcome unknown.
 *
 * Who acts is fixed when the agent builds the call's slot, never read when the block settles: a
 * session resets its agent's principal per run, and an abandoned call can end in the next one.
 * The owner leaves no row, and its target and kind are never evaluated. Every other principal
 * kind is recorded, a kind added later included.
 *
 * A row names the store and ids only, never content and never a name (a table's name is
 * content until it has an opaque id).
 */
import { type AuditLog, INSTANCE_WRITE_UNRECORDED, TARGET_MAX, namedTarget, newCorrelationId } from './audit-log.js';
import { currentInstanceTrail, inCallSlot, isInstanceRefused, noteInstanceRefused, type InstanceTrail } from './call-connection.js';
import type { InstanceWriteSite } from './mandate-tool-lock.js';
import { isOwnerPrincipal, type RequestPrincipal } from './request-principal.js';

/** What the block is about to do, as an attempt: never a result. */
export type InstanceVerb = 'create' | 'change' | 'delete' | 'save' | 'move';

/** The store the block writes first. Side effects in other stores belong to the same site. */
export type InstanceStore = 'knowledge' | 'memory' | 'memory_block' | 'subjects' | 'threads' | 'data_store'
  | 'contacts' | 'artifacts' | 'files' | 'tasks' | 'workflows' | 'api_profiles';

/** `name=value` pairs of ids, counts and fixed words only. */
export type InstanceTargetPairs = ReadonlyArray<readonly [string, string | number | undefined]>;

export interface InstanceWriteSpec {
  readonly site: InstanceWriteSite;
  /** A function where reading it needs a store: it is evaluated for a recorded principal only. */
  readonly kind: InstanceVerb | (() => InstanceVerb);
  readonly store: InstanceStore;
  /** Evaluated for a recorded principal only, after the handler's own checks. */
  readonly target?: (() => InstanceTargetPairs) | undefined;
}

/** What a writer needs to name its actor when it runs outside a call's slot. */
export interface InstanceWriter {
  readonly principal?: RequestPrincipal | undefined;
  readonly currentRunId?: string | undefined;
  readonly toolContext?: { readonly auditLog?: AuditLog | null | undefined } | undefined;
}

/** Thrown in place of the block when its row could not be written: the block did not run. */
export class InstanceWriteUnrecorded extends Error {
  constructor() { super(INSTANCE_WRITE_UNRECORDED); this.name = 'InstanceWriteUnrecorded'; }
}

/**
 * The trail for a call by `by` of `tool`: `'exempt'` for the owner, `'unnamed'` when `by` names
 * no principal, otherwise who acts, in which run, into which log — read now. The agent calls it
 * when it builds a call's slot; a write outside a slot calls it at the attempt.
 */
export function instanceTrailFor(by: InstanceWriter, tool: string): InstanceTrail | 'exempt' | 'unnamed' {
  // A writer that names no principal has no actor a row could name: its writes are refused.
  if (by.principal === undefined) return 'unnamed';
  if (isOwnerPrincipal(by.principal)) return 'exempt';
  return { log: by.toolContext?.auditLog ?? null, principal: by.principal, runId: by.currentRunId, tool };
}

/** The row's action: the site, then the verb. */
export function instanceAction(site: InstanceWriteSite, kind: InstanceVerb): string {
  return `instance:${site}:${kind}`;
}

/**
 * The row's target: the store, then as many whole pairs as fit `TARGET_MAX` once escaped, and
 * how many more. The bound in `AuditLog.record` cuts without a mark, so the list is fitted here,
 * with room for the count held back at its largest (the shape of `cp-trail.ts`).
 */
export function fitInstanceTarget(store: InstanceStore, pairs: InstanceTargetPairs): string {
  const shownPairs = pairs.filter(p => p[1] !== undefined && p[1] !== '');
  const parts = shownPairs.map(p => namedTarget([p]));
  const all = [store, ...parts].join(' ');
  if (all.length <= TARGET_MAX) return all;
  const room = TARGET_MAX - store.length - ` +${String(parts.length)} more`.length;
  const shown: string[] = [];
  let used = 0;
  for (const part of parts) {
    const add = 1 + part.length;
    if (used + add > room) break;
    shown.push(part);
    used += add;
  }
  const more = parts.length - shown.length;
  return `${[store, ...shown].join(' ')}${more > 0 ? ` +${String(more)} more` : ''}`;
}

type Opened = { readonly trail: InstanceTrail; readonly action: string; readonly target: string; readonly correlationId: string };

function refuse(): never {
  noteInstanceRefused();
  throw new InstanceWriteUnrecorded();
}

/** Writes the attempt row, or refuses. `null` for the owner: no row. */
function open(by: InstanceWriter, spec: InstanceWriteSpec): Opened | null {
  if (isInstanceRefused()) throw new InstanceWriteUnrecorded();
  const fromSlot = currentInstanceTrail();
  const trail = fromSlot ?? (inCallSlot() ? instanceTrailFor(by, '(slot without a trail)') : instanceTrailFor(by, '(outside a call)'));
  if (trail === 'exempt') return null;
  if (trail === 'unnamed') refuse();
  let opened: Opened;
  try {
    const kind = typeof spec.kind === 'function' ? spec.kind() : spec.kind;
    opened = {
      trail, action: instanceAction(spec.site, kind),
      target: fitInstanceTarget(spec.store, spec.target?.() ?? []), correlationId: newCorrelationId(),
    };
    if (trail.log === null) refuse();
    trail.log.record({ principal: trail.principal, correlationId: opened.correlationId, action: opened.action, target: opened.target, phase: 'attempt', runId: trail.runId });
  } catch {
    refuse();
  }
  return opened;
}

/** The outcome row. A failure to write it changes nothing: the attempt stands alone. */
function close(o: Opened, phase: 'returned' | 'failed'): void {
  try {
    o.trail.log?.record({ principal: o.trail.principal, correlationId: o.correlationId, action: o.action, target: o.target, phase, runId: o.trail.runId });
  } catch { /* the attempt row stands alone */ }
}

function isThenable(v: unknown): v is PromiseLike<unknown> {
  return (typeof v === 'object' || typeof v === 'function') && v !== null && typeof (v as { then?: unknown }).then === 'function';
}

/**
 * Run `fn` — one site's block, from its first change to its return — after its `attempt` row.
 * For the owner `fn` runs as it is. Throws {@link InstanceWriteUnrecorded} without running
 * `fn` when the row cannot be written; the outcome row follows `fn`'s own settling.
 */
export function withInstanceWrite<T>(by: InstanceWriter, spec: InstanceWriteSpec, fn: () => T): T {
  const opened = open(by, spec);
  if (opened === null) return fn();
  let result: T;
  try {
    result = fn();
  } catch (err) {
    close(opened, 'failed');
    throw err;
  }
  if (isThenable(result)) {
    return Promise.resolve(result).then(
      (v) => { close(opened, 'returned'); return v; },
      (err: unknown) => { close(opened, 'failed'); throw err; },
    ) as T;
  }
  close(opened, 'returned');
  return result;
}
