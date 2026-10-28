/**
 * The actor trail for a mandate's writes INSIDE the instance (PRD customer-granted-operator-access
 * §3.6): a memory, a table, a task, an API profile. The outward trail (`Agent._beginOutwardTrail`)
 * records what a call sends out; this records what a handler changes here.
 *
 * Each listed place where a writer's handler changes something is one `site`
 * (`INSTANCE_WRITE_SITES`), and the handler wraps the block from its first change to its
 * return in {@link withInstanceWrite}:
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
 *    outcome unknown;
 *  - a block that runs its changes through `w.run` adds what their typed results prove:
 *    `wrote=all` or `wrote=part`, and `created=` with an engine-chosen id. A result proves a
 *    change or nothing, never that nothing changed, so a row without `wrote=` still reads "may
 *    have written".
 *
 * Who acts is fixed when the agent builds the call's slot, never read when the block settles: a
 * session resets its agent's principal per run, and an abandoned call can end in the next one.
 * The owner leaves no row, and its target and kind are never evaluated. Every other principal
 * kind is recorded, a kind added later included.
 *
 * A row names the store, ids, counts and fixed words. A table and a contact are named by
 * their kind only: a table's name is content.
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
  /** The steps the site is there for: all of them changed is `wrote=all`, fewer is `wrote=part`. */
  readonly main?: readonly string[] | undefined;
}

/** What one step's typed result proves: a change, or nothing either way. Never "no change". */
export type InstanceStepNote = 'changed' | 'unknown';
export type InstanceDecoder<V> = (v: V) => InstanceStepNote;

/**
 * Handed to a site's block. `run` calls `call` exactly as the block would and gives its value
 * back unchanged — a sync value sync, a native promise as that same promise, a throw as that
 * same throw — and notes what `decode` reads from the value. A step that throws or rejects is
 * noted as thrown. Any other thenable is noted as unknown and not touched: reading it could run
 * it twice. A promise the block does not await may settle after the outcome row; its note then
 * comes too late, and the row says less, never more. For the owner it only calls.
 */
export interface InstanceWriteReport {
  run<V>(step: string, call: () => V, decode: InstanceDecoder<Awaited<V>>): V;
  /**
   * The id of the object `step` created: written only when that step noted a change, and only in
   * the shape of an engine-chosen id.
   */
  created(step: string, id: string): void;
}

// The decoders a site may read a step with. Each says `changed` only for a value that proves a
// write, and `unknown` for anything else, `undefined` included.
/** For a method that throws or writes: its return is the write. */
export const ifReturned: InstanceDecoder<unknown> = () => 'changed';
export const ifTrue: InstanceDecoder<unknown> = (v) => (v === true ? 'changed' : 'unknown');
export const ifPositive: InstanceDecoder<unknown> = (v) => (typeof v === 'number' && v > 0 ? 'changed' : 'unknown');
export const ifNonNull: InstanceDecoder<unknown> = (v) => (v !== null && v !== undefined ? 'changed' : 'unknown');
export const ifOk: InstanceDecoder<unknown> = (v) => (field(v, 'ok') === true ? 'changed' : 'unknown');
/** `inserted` and `updated` of a datastore write; its `errors` hold warnings too, so they prove nothing. */
export const ifCounts: InstanceDecoder<unknown> = (v) => (count(field(v, 'inserted')) + count(field(v, 'updated')) > 0 ? 'changed' : 'unknown');
/** A knowledge write: an inserted entry carries no `deduped`; one found already stored is not proven changed. */
export const ifNotDeduped: InstanceDecoder<unknown> = (v) => (typeof field(v, 'id') === 'string' && field(v, 'deduped') !== true ? 'changed' : 'unknown');
export const ifCreated: InstanceDecoder<unknown> = (v) => (field(v, 'created') === true ? 'changed' : 'unknown');
export const ifEmptiedAny: InstanceDecoder<unknown> = (v) => (listLength(field(v, 'emptied')) > 0 ? 'changed' : 'unknown');
/** A list of the ids a step moved or retired: one id is a write, an empty list is none. */
export const ifNonEmptyList: InstanceDecoder<unknown> = (v) => (listLength(v) > 0 ? 'changed' : 'unknown');

function field(v: unknown, name: string): unknown {
  return (v as Record<string, unknown> | null | undefined)?.[name];
}
function count(v: unknown): number {
  return typeof v === 'number' ? v : 0;
}
function listLength(v: unknown): number {
  return Array.isArray(v) ? v.length : 0;
}

/** Engine-chosen ids: a uuid, its eight-character prefix, a media output name. */
const ENGINE_ID = /^(?:[0-9a-f]{8}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|media_\d+_[0-9a-f]+(?:\.[a-z0-9]{1,8})?)$/;

type StepNote = { readonly step: string; readonly note: InstanceStepNote | 'threw' };

/**
 * What the outcome row may add to 1a's `returned`/`failed`: `all` when every main step noted a
 * change, `part` when some step did and not every main step, or a step threw, or the block
 * threw. `part` says "wrote, not all of it proven", not "wrote a part": a move whose target
 * already held the line proves only its delete. `null` when no step proved a change: the row
 * then says exactly what it said without steps.
 */
export function instanceWrote(notes: readonly StepNote[], main: readonly string[], blockThrew: boolean): 'all' | 'part' | null {
  if (!notes.some(n => n.note === 'changed')) return null;
  if (blockThrew || notes.some(n => n.note === 'threw')) return 'part';
  const allMain = main.length > 0 && main.every(m => notes.some(n => n.step === m && n.note === 'changed'));
  return allMain ? 'all' : 'part';
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

type Opened = {
  readonly trail: InstanceTrail; readonly action: string; readonly target: string; readonly correlationId: string;
  readonly store: InstanceStore; readonly pairs: InstanceTargetPairs; readonly main: readonly string[];
};

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
    const pairs = spec.target?.() ?? [];
    opened = {
      trail, action: instanceAction(spec.site, kind),
      target: fitInstanceTarget(spec.store, pairs), correlationId: newCorrelationId(),
      store: spec.store, pairs, main: spec.main ?? [],
    };
    if (trail.log === null) refuse();
    trail.log.record({ principal: trail.principal, correlationId: opened.correlationId, action: opened.action, target: opened.target, phase: 'attempt', runId: trail.runId });
  } catch {
    refuse();
  }
  return opened;
}

/** The steps a block noted. What a step notes after the outcome row is read by nothing. */
class Report implements InstanceWriteReport {
  readonly notes: StepNote[] = [];
  createdBy: { readonly step: string; readonly id: string } | undefined;

  run<V>(step: string, call: () => V, decode: InstanceDecoder<Awaited<V>>): V {
    let v: V;
    try {
      v = call();
    } catch (err) {
      this.note(step, 'threw');
      throw err;
    }
    if (v instanceof Promise) {
      // Noted on the side; the block gets the promise it would have had, rejection included.
      v.then((settled: Awaited<V>) => { this.note(step, readSafely(decode, settled)); }, () => { this.note(step, 'threw'); });
      return v;
    }
    if (isThenable(v)) {
      this.note(step, 'unknown');
      return v;
    }
    this.note(step, readSafely(decode, v as Awaited<V>));
    return v;
  }

  created(step: string, id: string): void {
    if (ENGINE_ID.test(id)) this.createdBy = { step, id };
  }

  /** The created id, when the step that created it noted a change. */
  provenCreated(): string | undefined {
    const c = this.createdBy;
    return c !== undefined && this.notes.some(n => n.step === c.step && n.note === 'changed') ? c.id : undefined;
  }

  private note(step: string, note: StepNote['note']): void {
    this.notes.push({ step, note });
  }
}

function readSafely<V>(decode: InstanceDecoder<V>, v: V): InstanceStepNote {
  try {
    return decode(v);
  } catch {
    return 'unknown';
  }
}

/**
 * The outcome row: the attempt's pairs, led by `wrote=` and `created=` when a step proved a
 * change, and fitted again so the count of held-back pairs stays right. Without a proven change
 * both lead pairs are empty and the target is the attempt's, byte for byte. A failure to write
 * it changes nothing: the attempt stands alone.
 */
function close(o: Opened, phase: 'returned' | 'failed', report: Report): void {
  try {
    const wrote = instanceWrote(report.notes, o.main, phase === 'failed');
    const target = fitInstanceTarget(o.store, [['wrote', wrote ?? undefined], ['created', wrote === null ? undefined : report.provenCreated()], ...o.pairs]);
    o.trail.log?.record({ principal: o.trail.principal, correlationId: o.correlationId, action: o.action, target, phase, runId: o.trail.runId });
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
export function withInstanceWrite<T>(by: InstanceWriter, spec: InstanceWriteSpec, fn: (w: InstanceWriteReport) => T): T {
  const opened = open(by, spec);
  // The owner's block runs its steps all the same; it has no row to note them in.
  const report = new Report();
  if (opened === null) return fn(report);
  let result: T;
  try {
    result = fn(report);
  } catch (err) {
    close(opened, 'failed', report);
    throw err;
  }
  if (isThenable(result)) {
    return Promise.resolve(result).then(
      (v) => { close(opened, 'returned', report); return v; },
      (err: unknown) => { close(opened, 'failed', report); throw err; },
    ) as T;
  }
  close(opened, 'returned', report);
  return result;
}
