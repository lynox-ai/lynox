/**
 * The bulk-run ledger (PRD bulk-changes-reversible §3.1): one row per run that applies
 * a rule to N targets, one row per target holding the before-image read at dry-run
 * time and the after-state the rule would produce.
 *
 * Two surfaces with a hard line between them:
 * - {@link BulkLedger.getStatus} / {@link BulkLedger.listRuns} return COUNTERS and
 *   PHASES only. They are what the model sees (`bulk_status`, the `bulk_plan` result).
 * - {@link BulkLedger.getPreview} returns decrypted before/after/diff per target. It is
 *   the owner's view of a run and must never be wired to a model-facing tool:
 *   before-images are customer data, and a target file may be externally authored.
 *
 * Nothing here writes to a target system either. Approval ({@link BulkLedger.approve}),
 * the per-target claim and outcome, and planning an undo are ledger writes; the effect
 * that touches targets is `bulk-apply.ts`, run by the worker off the trigger the
 * approval arms.
 */
import { isMailProviderTarget } from './bulk-mail-targets.js';
import { randomUUID } from 'node:crypto';
import type { EngineDb } from './engine-db.js';
import type { UndoKind } from '../types/index.js';
import { TriggerStore, bulkPreviewTriggerId } from './trigger-store.js';
import { OWNER_PRINCIPAL, isMandateTag, isOwnerPrincipal, principalFromTag, principalTag, type RequestPrincipal } from './request-principal.js';
import type { ExternalImage, ExternalPlanned } from './bulk-external.js';
import { mergeConnections, type AttachedConnection } from './bulk-connection.js';
import { SHOPIFY_MEDIA_LIST_FORM, type BulkListSource, type BulkListSourceForm } from './bulk-list.js';
import { checkMarkup, droppedTagsOf, endsClosed, htmlFieldsOfListForm, markupChangesOf, type FieldMarkupChange, type MarkupRefusal } from './bulk-html.js';
import { canonicalHtml, htmlEqual } from './html-tree.js';
import { isShopifyStoreHostName, mediaImageGidNumber, productGidNumber, type ShopifyWrite, type ShopifyWriteForm } from './shopify-graphql.js';
import { shopifyBulkReadEnabled, shopifyPairedAfter } from './bulk-shopify.js';
import { BULK_MAX_TARGETS, BULK_MAX_TOTAL_BYTES, BulkSourceError } from './bulk-plan.js';
import type { CapabilityContract } from '../types/capability-contract.js';
import { isMeasuredWriteForm, writeFormOf } from './bulk-write-forms.js';
import { judgeAfterBound, normalizeJudgeRule, type JudgeRule } from './bulk-judge-rule.js';
import type { ModelTier } from '../types/index.js';
import { containRunFromRun, containRunFromThread } from './containment.js';
import type { ContainmentMirror } from './history-markers.js';
import { isSharedSuffix } from './public-suffix.js';

/** A target's stored `read_*` or `write_*` pair (engine.db v43). */
interface ConnectionColumns {
  read_connection_id: string | null;
  read_grant_id: string | null;
  write_connection_id: string | null;
  write_grant_id: string | null;
}

/** A stored pair as a connection: none when no connection was recorded. */
function connectionOf(id: string | null, grantId: string | null): AttachedConnection | null {
  return id === null ? null : { id, grantId };
}

/** Local target systems a run can plan and write. An external run's system is
 *  `http:<host>` ({@link BulkLedger.recordExternalPlan}); it is planned and previewed,
 *  not written yet. Memory and artifacts are not built (PRD §4 D; §3.1 lists the set). */
export type BulkTargetSystem = 'workspace' | 'data_store';

/** The run's lifecycle (PRD §3.1). A local dry run is recorded straight as `previewed`;
 *  an external one is `planned` until its preview effect has read every target. */
export type BulkPhase = 'planned' | 'previewed' | 'approved' | 'writing' | 'done' | 'aborted' | 'undone';
/** `delete` is only ever planned by an undo: taking back a created target removes it. */
export type BulkChange = 'update' | 'create' | 'delete' | 'unchanged' | 'invalid';
export type BulkRunKind = 'apply' | 'undo';

/** What was at the target before: absent (the rule would create it) or a value. */
export type BeforeImage = { absent: true } | { absent: false; value: unknown };

/** One target as planned. `invalid` targets carry an `error` category and no after. */
export type PlannedTarget =
  | { key: string; before: BeforeImage; after: unknown }
  | { key: string; invalid: BulkInvalidReason };

/**
 * Why a target could not be planned. A FIXED vocabulary on purpose: the count per
 * reason is what the model is told, and a free-text reason would carry the target's
 * own (possibly externally authored) strings into the model's context.
 */
export type BulkInvalidReason =
  | 'path_outside_workspace'
  /** exists but is not a readable regular file (a directory, a device, no permission) */
  | 'unreadable'
  | 'target_too_large'
  | 'after_not_text'
  /** the file's bytes are not UTF-8, so no text before-image would be its real content */
  | 'not_text'
  | 'unknown_column'
  /** a `subject` column: converting it would create a subject, which a dry run must not */
  | 'subject_column'
  | 'bad_value'
  | 'bad_key'
  // External targets (`http:<host>`):
  /** not an HTTPS URL on the run's host without port, user info, query or fragment */
  | 'bad_url'
  /** the after-state is not a non-empty JSON object */
  | 'after_not_object'
  /** a field of the after-state or of the target is not a JSON scalar */
  | 'field_not_scalar'
  /** the target lacks a field the run would write, so undo could not restore it */
  | 'field_missing'
  /** the target is not a JSON object */
  | 'before_not_object'
  /** the target does not exist — a PATCH cannot create it */
  | 'not_found'
  /** the target answered with a redirect, which a run never follows */
  | 'redirect'
  /** the target's body is not JSON */
  | 'not_json'
  /** the host refused to serve the target, or failed to */
  | 'read_failed'
  /** the after-state holds something shaped like a credential */
  | 'secret_in_after'
  /** The target's address looks like it carries a secret; it is never requested. */
  | 'secret_in_target'
  /** The target is a mail provider's API (`isMailProviderTarget`); a bulk run never writes one. */
  | 'mail_api'
  /** The after-state sets a field whose value sets off an effect at the provider
   *  (`OUTBOUND_EFFECT_FIELDS`); a bulk run never writes one. */
  | 'effect_field'
  // Elements of a list source (`bulk-list.ts`):
  /** the list element is not a JSON object */
  | 'list_item_not_object'
  /** the list element has no id field */
  | 'list_item_no_id'
  /** the element's id is not a whole number or a plain token, so it cannot be an address */
  | 'list_item_bad_id'
  /** the element's address would lie outside the list's path */
  | 'list_item_outside_list'
  /** the target read at the element's address is not the element that was listed */
  | 'list_item_mismatch'
  /** a product held more media than its list page reads: those past it are not listed */
  | 'list_item_truncated'
  /** An undo would write back an `actual` whose read-back held markup the write never sent
   *  (`shop_added_markup`, PRD shopify-preset §21.2 item 7 (b)): never the owner's state. */
  | 'shop_added_markup'
  // A run with a judge (`bulk_judge`, PRD bulk-loop §3.1):
  /** the target's current state holds something shaped like a credential, so it is not sent to a model */
  | 'secret_in_before'
  /** the model's reply was cut off before its verdict was complete */
  | 'cut_off'
  /** the model's verdict did not fit the rule's schema */
  | 'verdict_invalid'
  /** the verdict said to change the target (`keep: false`) and gave no new values */
  | 'verdict_without_after'
  // What a value may not add over the before-image (PRD shopify-preset §20.2 item 5,
  // `bulk-html.ts`). Every code of `MarkupRefusal` is one of these; the type below holds it so.
  /** a verdict for a text field that is not HTML adds `<`, `>` or a tag (S20-2) */
  | 'markup_in_text'
  /** a value adds a hidden character its field did not hold as often (M5) */
  | 'hidden_char'
  /** an HTML value adds an element outside the allowlist */
  | 'element_not_allowed'
  /** an HTML value adds an attribute outside the allowlist */
  | 'attribute_not_allowed'
  /** an HTML value changes the content of code its field holds (a `script`, a `style`) */
  | 'content_changed'
  /** an HTML value adds or changes a comment */
  | 'comment_added'
  /** an HTML value adds an image */
  | 'new_img'
  /** an HTML value links to a domain that is neither the store's, its field's, nor on the start list */
  | 'new_link_domain'
  /** an HTML value holds a link whose scheme is not https, http or a checked mailto */
  | 'url_scheme'
  /** an HTML value holds a link with a control character, U+FFFD or a backslash */
  | 'url_control_char'
  /** an HTML value whose serialised form parses to another tree, or that ends open */
  | 'not_canonical';

/** Every markup refusal is a reason a target can record. */
const _markupRefusalsAreReasons: MarkupRefusal extends BulkInvalidReason ? true : never = true;
void _markupRefusalsAreReasons;

/** A deselect or reselect: the run's new checksum, or why nothing moved. `not_writing`: the
 *  target does not write (deselect) or is not deselected (reselect). */
export type BulkSelectOutcome =
  | { ok: true; checksum: string }
  | { ok: false; reason: 'not_found' | 'wrong_phase' | 'atomic_undo' | 'checksum' | 'not_writing' };

export interface BulkRunStatus {
  id: string;
  createdAt: string;
  /** Wider than {@link BulkTargetSystem} on purpose: the column is meant to hold the
   *  systems not built yet (`http:<host>`, …), and a status read must not break on them. */
  targetSystem: string;
  phase: BulkPhase;
  undo: UndoKind | 'mixed';
  total: number;
  /** Targets of a `planned` external run not read yet. Their change is not known, so
   *  {@link changes} counts them as `update` until the read decides. */
  unread: number;
  /** Per change, the targets the owner did not take out (a deselected target is counted only
   *  in {@link deselected}, so an `update` taken out does not read as one that will be written). */
  changes: Record<BulkChange, number>;
  /** Targets the owner took out of the run before approving it (PRD shopify-preset §20.2 item 4). */
  deselected: number;
  invalidReasons: Partial<Record<BulkInvalidReason, number>>;
  applied: number;
  /** Of {@link applied}, the targets found already holding their planned value that this run
   *  never sent its write verb to: someone else set the value. They take no place of the cap. */
  foundAsPlanned: number;
  /** Written targets whose read-back held markup the write never sent (`shop_added_markup`). The
   *  page loads every target while one is marked, whatever the run halted on since. */
  shopAddedMarkup: number;
  /** Written targets whose store kept an HTML field otherwise than sent, within what the run may
   *  write (`host_rewrote`): counted and named, not halted (PRD shopify-preset §21.2 item 6). */
  hostRewrote: number;
  /** Targets whose write failed and that stand failed now. A resume tries them again, except
   *  one that failed on what it would send (`secret`), which stays failed and stays counted. */
  failed: number;
  /** The most different targets the approval lets the write verb reach; null before an approval. */
  maxTargets: number | null;
  /** Targets that failed in at least one pass, whether or not a later pass wrote them. Null for a
   *  run approved before this was recorded: its earlier passes are not known, so a page says
   *  "at least {@link failed}" instead. */
  failedOnce: number | null;
  /** How many targets may fail in one pass without the failure-rate halt; the next failure
   *  halts it ({@link bulkFailureLimit}). */
  failureLimit: number;
  /** The targets a resume tries again: writing, not written, not taken back, and not failed on
   *  what they would send (`secret`). Every failure of the next pass is one of these, so it
   *  bounds that pass's failures — the cap does not, a target can fail before it is sent to.
   *  A bound, not a forecast: a target a dead loop claimed under {@link BULK_CLAIM_STALE_MS} ago
   *  waits for a later pass. */
  resumeOpen: number;
  /** Of {@link resumeOpen}, the most the next pass may send the write verb to under the run's
   *  current cap ({@link bulkWriteCap}); a resume with a new maximum changes it. Fewer are sent
   *  to when targets fail before the send, are found already written, or were left unclear by
   *  an earlier send ({@link sentUnknown}); a target found so and never sent to takes no place,
   *  so the pass reads on to the next one. Below
   *  {@link resumeOpen} when the cap stops the pass first. */
  resumeTries: number;
  /** Targets not written because they no longer held their expected state (§3.5). */
  conflicts: number;
  /** Targets of an external run that a send reached without a clear answer, and that are not
   *  written, taken back or a conflict: the change may have arrived, so the run does not send
   *  to them again. Counted from the halt that left them so, not only once a later pass has
   *  recorded them `sent_unknown`. */
  sentUnknown: number;
  /** Applied targets taken back since — by an undo run, or an atomic run's rollback. */
  undone: number;
  kind: BulkRunKind;
  atomic: boolean;
  sourceRunId: string | null;
  /** An external run's write verb, from its contract; null for a local run. */
  writeMethod: string | null;
  /** An external run may be approved for more than one target (a probe is confirmed for
   *  its host and verb, or it is local). */
  probeConfirmed: boolean;
  /** An external run's write form ({@link writeFormOf}): `unmeasured` when any target is a form
   *  nobody has measured; approving it then takes an explicit confirmation, and it writes one
   *  target first in every run. Null for a local run and for a list not read yet. For the owner's surfaces only: the
   *  text the model reads (`formatStatus` in the bulk tools) does not print it. */
  writeForm: 'measured' | 'unmeasured' | null;
  /** `keyed`: the approval checksum is an HMAC under the vault key, so only the engine can
   *  produce one that matches. `unkeyed` (no vault key): plain SHA-256 — it still detects
   *  a run that changed by accident, but whoever can write the engine database can change
   *  the run and recompute it, so it does not bind the approval to what was shown. */
  checksumBinding: 'keyed' | 'unkeyed';
  /** Relayed to the model by `bulk_status`, so only ENGINE-authored text may ever be
   *  written here — a {@link BULK_HALT_REASONS} value, never an API response or error. */
  haltReason: string | null;
  /** A list run's source and how far its read got; null on any other run. Planner-authored
   *  and engine-counted only — nothing the list's provider returned. */
  list: BulkListStatus | null;
  /** Model spend booked for this run, in USD (PRD bulk-loop §3.3): what the calls were
   *  charged at, not the estimate made before each call. A model without a registered
   *  price is charged at the fallback rate, so there the booking is an estimate too.
   *  0 for a run that called no model. */
  costUsd: number;
  /** The most this run may spend on model calls, set by the owner at the start of a run
   *  with a judge; null when none was set. */
  costCapUsd: number | null;
  /** A run whose after-states a model decides (`bulk_judge`, PRD bulk-loop §3.1): its tier and
   *  how many targets have no verdict yet. Null on every other run. Counts only — the rule's
   *  text is the owner's, shown by the owner's route, never in a status. */
  judge: { tier: ModelTier; unjudged: number } | null;
  /** The link domains the owner allowed at the start of a judged run, besides the store's own
   *  (PRD shopify-preset §20.2 item 5, S20-4); null where none were given. */
  startDomains: string[] | null;
}

export interface BulkListStatus {
  state: ListState;
  path: string;
  filters: Record<string, string>;
  idField: string;
  /** Null for a Shopify list, which only reads. */
  method: string | null;
  after: ExternalImage;
  pagesRead: number;
}

/** Shown wherever a run is approved or its checksum presented, when the instance has no
 *  vault key: the weaker variant runs, but it says so (the same rule as an unencrypted
 *  backup). */
export const BULK_UNKEYED_CHECKSUM_NOTE =
  'This instance has no vault key, so the approval checksum is a plain SHA-256: it catches a run that ' +
  'changed by accident, but whoever can write the engine database can change the run and recompute it. ' +
  'It does not bind your approval to what you were shown. Set a vault key for a checksum that does.';

/**
 * Why a run stopped short. FIXED texts: `halt_reason` reaches the model through
 * `bulk_status`, and anything else written there — an error message, a file's content
 * — would carry a target's strings into the model's context.
 */
export const BULK_HALT_REASONS = {
  awaitingStart: 'waiting for the owner to start reading the targets',
  failureRate: 'more than 5 % of the targets failed',
  consecutiveFailures: 'three targets in a row failed',
  timeBudget: 'the run used up its time budget',
  expired: 'the approval expired',
  checksum: 'the run no longer matches what was approved',
  maxTargets: 'the approved maximum number of targets is reached',
  probeRequired: 'more targets need a confirmed probe for this write form',
  atomicRolledBack: 'a target of an atomic run could not be written; the targets written before it were rolled back',
  atomicRollbackIncomplete: 'a target of an atomic run could not be written, and rolling back the ones written before it did not complete',
  atomicStoppedRolledBack: 'the owner stopped an atomic run; the targets written before the stop were rolled back',
  atomicStoppedRollbackIncomplete: 'the owner stopped an atomic run, and rolling back the targets written before the stop did not complete',
  atomicTimeRolledBack: 'an atomic run used up its time budget; the targets written before were rolled back',
  atomicTimeRollbackIncomplete: 'an atomic run used up its time budget, and rolling back the targets written before did not complete',
  unavailable: 'the target system is not available',
  credential: 'the access credential for this host cannot be attached',
  unauthorized: 'the host did not accept the stored credential',
  blocked: 'the network policy does not allow this host',
  contract: 'a target lies outside the run\'s contract',
  stoppedByOwner: 'the owner stopped the run',
  mandateEnded: 'the access that planned this run has ended before it was approved',
  unrecorded: 'a read for this run could not be recorded in the instance\'s log, so it was not sent',
  runUnrecorded: 'this run could not be recorded in the instance\'s log, so nothing was read or written',
  // A list source (`bulk-list.ts`):
  listed: 'the list is read; waiting for the owner to review its targets and start reading them',
  listNotAList: 'a page of the list is not a JSON array',
  listUnreadable: 'a page of the list could not be read',
  listTooLarge: 'the list is longer, or larger, than a bulk run may hold',
  listNoProgress: 'a full page of the list held no target not seen before',
  listFormWithdrawn: 'the list\'s path is no longer one a bulk run may read',
  // A Shopify store's list and before-images, read through its GraphQL API (`bulk-shopify.ts`):
  listOrder: 'a page of the list did not continue in id order after the last id read',
  listReadFailed: 'the store answered a page of the list with an error',
  shopInactive: 'the store is closed or frozen',
  formCost: 'the store refused a read as too costly for one request',
  shopifyReadOff: 'reading a Shopify store in a bulk run is switched off on this instance',
  shopifyWriteOff: 'writing to a Shopify store in a bulk run is switched off on this instance',
  // Fixed like every reason: the target is named by its mark (`shop_added_markup`), not here.
  markupAddedByShop: 'the store kept a written description with markup the run did not send',
  // A run with a judge (`bulk_judge`, PRD bulk-loop §3.1):
  superseded: 'the owner started another run with a judge in its place',
  costCap: 'the run reached the model spend limit set at its start',
  spendLimit: 'the daily or monthly spending limit is reached',
  creditRefused: 'the model call was refused: no credit, or the control plane could not be reached',
  judgeModel: 'the provider or endpoint that serves this run has no judge model, or the operator does not allow it',
} as const;
export type BulkHaltReason = (typeof BULK_HALT_REASONS)[keyof typeof BULK_HALT_REASONS];

/** Per-target failure codes. Fixed for the same reason as {@link BULK_HALT_REASONS}.
 *  `redirect`: an external target answered a write with a redirect, which is never followed.
 *  `sent_unknown`: an external target an earlier send reached without a clear answer, and
 *  that still holds what the run expected; it is not sent to again. */
export type BulkTargetError = 'conflict' | 'write_failed' | 'path_changed' | 'redirect' | 'secret' | 'sent_unknown';

/** The target errors that are a failed write: every {@link BulkTargetError} but `conflict`,
 *  which is not a failure (§3.5), and `sent_unknown`, which records no new attempt: the send
 *  that left it unclear was counted as a failure, halted the run, or belonged to a loop that
 *  died. Not `read_failed`, a read in planning that is tried again. */
const WRITE_FAILURES = ['write_failed', 'path_changed', 'redirect', 'secret'] as const satisfies readonly BulkTargetError[];
/** Target errors that are not a failure and are not counted (see {@link WRITE_FAILURES}). */
const NOT_FAILURES = ['conflict', 'sent_unknown'] as const satisfies readonly BulkTargetError[];
// A new target error must be placed in one of the two, or this does not compile.
const writeFailuresComplete: [Exclude<BulkTargetError, (typeof NOT_FAILURES)[number] | (typeof WRITE_FAILURES)[number]>] extends [never] ? true : false = true;
void writeFailuresComplete;
// Only on a target still to write: an invalid one carries its plan-time reason in the same
// column, and `redirect` is a plan-time reason too; a written one is not failed, whatever a
// loop that lost its claim recorded on it.
const WRITE_FAILED_SQL = `(change != 'invalid' AND applied_at IS NULL AND error IN (${WRITE_FAILURES.map((e) => `'${e}'`).join(', ')}))`;
// A target the next pass will not send to: a send to it ended without a clear answer, it is not
// written or taken back, and it is not a conflict, which the owner sees as one. Read off the
// count the check in the write loop reads, not off `sent_unknown`: right after the halt that
// left it unclear it still carries that send's own failure. Only an external run's targets: a
// local writer's outcome is always known, and its sends are counted all the same. Not a target a
// loop holds: it is being sent to now, and its answer may still come. Every way a pass leaves a
// target (written, failed, halted, released) gives the claim back; only a loop that died keeps
// it, and that target counts once a later pass has read it.
const UNCLEAR_SQL = "(unknown_sends > 0 AND applied_at IS NULL AND undone_at IS NULL AND claimed_at IS NULL AND (error IS NULL OR error != 'conflict'))";

/** The failure-rate halt (PRD §3.4): a pass halts once more than this share of the run's
 *  writing targets failed in it. */
const HALT_FAILURE_SHARE = 0.05;

/**
 * How many targets may fail in one pass before the failure-rate halt: the halt fires on the
 * next one. The one computation of it — the effect halts on it and the status shows it, so the
 * number the owner reads is the halt's own, not a second copy of the arithmetic.
 */
export function bulkFailureLimit(writing: number): number {
  return Math.floor(writing * HALT_FAILURE_SHARE);
}

/**
 * The most different targets a pass may send the write verb to, or null for no bound: the
 * approval's maximum, and one target while the run's probe does not hold. The one computation
 * of it — the effect caps on it and the status counts the targets a resume may still send to.
 */
export function bulkWriteCap(maxTargets: number | null, probeHolds: boolean): number | null {
  return probeHolds ? maxTargets : Math.min(maxTargets ?? 1, 1);
}

/** What an external target held right after the run wrote it, over the fields it wrote.
 *  `estimated`: the read-back failed and this is what was sent — an undo then finds a
 *  target the host normalised as a conflict, the safe direction. */
export interface ActualImage { value: unknown; estimated: boolean }

/** Per target, the unit of a run's time budget and of its approval window. */
export const BULK_TARGET_BUDGET_MS = 5_000;
/** A claim older than this is taken to belong to a dead loop. Longer than one target's
 *  budget, so a slow write is not mistaken for a dead one. */
export const BULK_CLAIM_STALE_MS = 30_000;
/** The approval window: N targets × the per-target budget, plus this, capped at a day. */
export const BULK_APPROVAL_SLACK_MS = 15 * 60_000;
export const BULK_APPROVAL_MAX_MS = 24 * 60 * 60_000;

/** Dry runs kept that were never approved. Recording another drops the oldest beyond
 *  this: a preview holds nothing to undo, and without a cap repeated calls would grow
 *  engine.db without bound. Approved runs are not touched — their retention is §3.1's.
 *  Undo previews are not touched either: only the owner's route plans one, and the
 *  model's `bulk_plan` calls must not be able to drop the undo the owner is about to
 *  approve. */
export const BULK_MAX_PREVIEWED_RUNS = 10;

/** The runs {@link BULK_MAX_PREVIEWED_RUNS} counts and a new planning may drop: unapproved apply
 *  runs, previewed or still to be read, and ones replaced by another judged start. A run whose
 *  judge was started holds paid verdicts: not dropped for a newer plan (PRD bulk-loop §3.1) — its
 *  end is the owner's start of another one (superseded, which then joins this set) or the
 *  retention sweep. "Started" is the limit being set, not spend above zero: a run whose first call
 *  is in flight has spent nothing yet. */
const PRUNABLE_RUNS = `kind = 'apply' AND (
     (phase IN ('previewed','planned') AND NOT (judge_rule IS NOT NULL AND cost_cap_usd IS NOT NULL))
     OR (phase = 'aborted' AND halt_reason = '${BULK_HALT_REASONS.superseded}'))`;

/**
 * A planning by someone other than the owner that the cap of unapproved runs refuses (660b): the
 * runs over it are not its own to drop. `waiting` counts the previews waiting for the owner's
 * approval, whoever planned them — a number, never which runs. The text is ux's (U-052); the model
 * reads it.
 */
export class BulkPreviewCapError extends Error {
  constructor(readonly waiting: number) {
    super((waiting > 0
      ? `${String(waiting)} previews are already waiting for approval. A new one is possible only once the owner approves some.`
      : 'Too many bulk runs are being prepared on this instance right now. A new one is possible only once the owner starts or approves waiting runs, or plans a new one. Ask the owner.')
      + ' Tell the user that in one sentence; do not try again in this run.');
    this.name = 'BulkPreviewCapError';
  }
}

/** How long a started, unapproved judged run is kept (PRD bulk-loop §3.1): its
 *  before-images were sent to a model and are held encrypted until the owner approves the run or
 *  this runs out. */
export const BULK_JUDGED_RETENTION_MS = 30 * 24 * 60 * 60_000;
/** A run never approved: still before its approval, or ended there — replaced by another
 *  judged start, or planned under an access that ended. */
const UNAPPROVED_JUDGED = `(phase IN ('planned','previewed')
  OR (phase = 'aborted' AND halt_reason IN ('${BULK_HALT_REASONS.superseded}', '${BULK_HALT_REASONS.mandateEnded}')))`;

/** The most link domains an owner gives at a judged run's start. */
export const BULK_START_DOMAINS_MAX = 20;

const HOST_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/**
 * A start list as the ledger keeps it, or null: at most {@link BULK_START_DOMAINS_MAX} host
 * names, each with a dot, no wildcard, no port, no address literal, in the form a URL's
 * hostname takes (lowercase, Punycode), without duplicates and sorted. The link check matches a
 * host exactly or at a dot boundary, so `example.ch` covers its subdomains already — and for the
 * same reason a shared suffix (`co.uk`, `myshopify.com`) is refused: it would cover every name
 * under it. That refusal is a net, not a fence (see public-suffix.ts).
 */
export function normalizeStartDomains(domains: unknown): string[] | null {
  if (!Array.isArray(domains)) return null;
  const out = new Set<string>();
  for (const d of domains) {
    // A host name only: no path, query, port, credentials, wildcard or space to hide another
    // host behind.
    if (typeof d !== 'string' || d.length === 0 || d.length > 253 || /[/?#@:\\*%\s]/.test(d)) return null;
    let host: string;
    try {
      // Lowercase and Punycode, as the link check sees a URL's host.
      host = new URL(`https://${d}/`).hostname;
    } catch {
      return null;
    }
    const labels = host.split('.');
    if (host.length > 253 || labels.length < 2 || !labels.every((l) => HOST_LABEL.test(l)) || /^\d+$/.test(labels[labels.length - 1]!)) return null;
    // Allowing a shared suffix would allow every name under it (`myshopify.com`, `co.uk`).
    if (isSharedSuffix(host)) return null;
    out.add(host);
    // Counted as stored: a duplicate does not count twice.
    if (out.size > BULK_START_DOMAINS_MAX) return null;
  }
  return [...out].sort();
}

/** A spend limit as the start takes it: finite, above zero, in whole cents: spend shown
 *  rounded down beside a limit with a fraction of a cent would read an overrun limit as below it. */
export function isWholeCents(usd: number): boolean {
  if (!Number.isFinite(usd) || usd <= 0) return false;
  const cents = usd * 100;
  return Math.abs(cents - Math.round(cents)) < 1e-6;
}

/** A judged run as its judge reads it. Not model-facing. */
export interface BulkJudgeRun {
  id: string;
  kind: BulkRunKind;
  targetSystem: string;
  targetCollection: string | null;
  phase: BulkPhase;
  haltReason: string | null;
  rule: JudgeRule;
  costUsd: number;
  costCapUsd: number | null;
  /** The run's list is still to be read: the judge does not run yet. */
  listPending: boolean;
  /** The form of the run's list, or null for a run without one: it names the HTML fields. */
  listForm: BulkListSourceForm | null;
  /** The link domains the owner gave at the start (`startDomainsOf`). */
  startDomains: string[];
}

export type TargetDiff =
  | { kind: 'none' }
  /** One hunk: lines [from, from+removed.length) of before become `added`. Common
   *  prefix and suffix are trimmed, so the hunk may be wider than a minimal diff, but
   *  applying it to before always yields after. */
  | { kind: 'text'; from: number; removed: string[]; added: string[] }
  | { kind: 'fields'; fields: { field: string; before: unknown; after: unknown }[] };

export interface PreviewTarget {
  seq: number;
  key: string;
  /** External targets: fields the write sends although their value does not change —
   *  because the source named them, or the provider requires them on every edit. Shown so
   *  an owner does not read them as a mistake; the undo writes them back too. */
  sentUnchanged?: string[] | undefined;
  change: BulkChange;
  undo: UndoKind | null;
  before: BeforeImage | null;
  after: unknown;
  diff: TargetDiff;
  /** How many fields the write changes — the number the owner checks a judged run by (PRD
   *  bulk-loop §4). A text value counts as one. Null for a judged run's target
   *  that has no verdict yet: its after-state is not decided. */
  changedFields: number | null;
  error: string | null;
  /** Per HTML field an `update` target changes: the elements and comments its after-state adds
   *  and removes, each with its full value (PRD shopify-preset §20.2 item 5, M3). Computed here
   *  from the parser's tree, so the view shows it and computes nothing. */
  markupChanges?: FieldMarkupChange[] | undefined;
  /** Written, and its read-back held markup the write never sent (PRD shopify-preset §21.2
   *  item 6): the target the halt `markupAddedByShop` is about. Set only where it holds. */
  shopAddedMarkup?: true | undefined;
  /** Written, and the store kept an HTML field otherwise than sent, within what the run may write:
   *  counted and named, not halted. Set only where it holds. */
  hostRewrote?: true | undefined;
  /** The owner took this target out of the write before approving (`deselectTarget`). */
  deselected: boolean;
  /** This run wrote the target: recorded as applied, and not found already as planned. */
  written: boolean;
  /** A rollback or an undo took this run's write back (`undone_at`). After a rollback that did
   *  not complete, a target that is `written` and not `undone` is one lynox left as it was. */
  undone: boolean;
}

interface RunRow {
  id: string; created_at: string; target_system: string; phase: BulkPhase; undo: UndoKind | 'mixed';
  targets_total: number; targets_applied: number; targets_failed: number; halt_reason: string | null;
  atomic: number; kind: BulkRunKind; source_run_id: string | null; target_collection: string | null;
  rule_hash: string; approval_checksum: string | null; max_targets: number | null; expires_at: string | null;
  contract_json: string | null; created_by: string | null; principal: string | null; mandate_id: string | null;
  list_source: string | null; list_state: ListState | null; list_page: number; list_calls: number; list_bytes: number;
  list_last_id: number;
  cost_usd: number; cost_cap_usd: number | null;
  judge_rule: string | null; judge_rule_hash: string | null; judge_started_at: string | null;
  start_domains: string | null;
}

/** Where the read of a run's list stands: `pending` while it is read, `done` once its targets
 *  and write contract stand. NULL on a run without a list source. */
export type ListState = 'pending' | 'done';

/** A list run as its read needs it. */
export interface BulkListRun {
  id: string;
  host: string;
  source: BulkListSource;
  state: ListState;
  /** The last page whose elements are recorded; the next read is this plus one. */
  page: number;
  calls: number;
  bytes: number;
  /** The last id a Shopify list read recorded (0 before its first page, and on any other list). */
  lastId: number;
  phase: BulkPhase;
  haltReason: string | null;
  contractJson: string | null;
}

/** What one page of the list adds, as the read hands it to the ledger. */
export type ListPageItem = { key: string; id: string } | { invalid: BulkInvalidReason };

/**
 * What decides whether a run's planner still stands behind it (§3.13 B7): whether a mandate's
 * grant is live, and who a conversation belongs to. Both live outside engine.db's bulk tables
 * — the ends in `mandate_ends`, the conversations in history.db — so the engine passes them in.
 */
export interface BulkOwnership {
  isLive(mandateId: string): boolean;
  /** Who started the conversation with this id: its `created_by` (history.db v57), or
   *  undefined when there is no such conversation or it records nobody. */
  threadCreator(threadId: string): string | null | undefined;
  /** Whether the conversations can be read at all. When they cannot, a run from before v31
   *  cannot be placed: it is refused, and left for a later sweep rather than ended. */
  readonly threadsKnown: boolean;
}

/**
 * When the engine began to refuse a mandate's request in a conversation it did not start
 * (H2c, core a0bb9895, first released in v2.15.4 at 2026-10-12T09:33:19Z). From then on a
 * run planned in the owner's conversation is the owner's; before, that does not follow.
 * In `datetime('now')`'s form, which is what `bulk_runs.created_at` holds.
 */
export const BULK_OWNER_THREADS_SINCE = '2026-10-12 09:33:19';

/** The two planner columns of a new run: its tag, and the grant a mandate planned it under. */
function planner(p: RequestPrincipal): [string, string | null] {
  return [principalTag(p), p.kind === 'mandate' ? p.mandateId ?? null : null];
}

/**
 * The delegated session that planned a run, or null when the owner did: a mandate's tag, with
 * its grant when the row names one. A run from before v31 names no planner and is the owner's
 * here; whether it may still run is {@link plannerHasEnded}'s question.
 */
export function delegatedPlannerOf(row: Pick<RunRow, 'principal' | 'mandate_id'>): RequestPrincipal | null {
  if (row.principal === null || !isMandateTag(row.principal)) return null;
  const p = principalFromTag(row.principal);
  if (p.kind !== 'mandate') return null;
  return row.mandate_id === null ? p : { ...p, mandateId: row.mandate_id };
}

/**
 * Whether the planner of an unapproved run no longer stands behind it (§3.13 B7):
 * - a run a mandate planned, once its grant is not live (ended, revoked, unknown, or none named);
 * - a run from before v31, which names no planner: the owner's only when it was planned in a
 *   conversation the owner started, after {@link BULK_OWNER_THREADS_SINCE}; every other one,
 *   because who planned it cannot be shown.
 * The owner's own runs never end this way. A planner tag that is neither the owner's nor a
 * mandate's counts as ended.
 */
export function plannerHasEnded(
  row: Pick<RunRow, 'principal' | 'mandate_id' | 'created_by' | 'created_at'>,
  own: BulkOwnership,
): boolean {
  const owner = principalTag(OWNER_PRINCIPAL);
  if (row.principal !== null) {
    if (row.principal === owner) return false;
    if (!isMandateTag(row.principal)) return true;
    return row.mandate_id === null || !own.isLive(row.mandate_id);
  }
  if (row.created_by === null || row.created_at <= BULK_OWNER_THREADS_SINCE) return true;
  return own.threadCreator(row.created_by) !== owner;
}

/**
 * Whether no one can be shown as the planner of an approved run (660b): not the owner's tag, no
 * mandate's tag (so no trail names anyone, {@link delegatedPlannerOf}), and not a run from before
 * v31 that {@link plannerHasEnded} places in the owner's conversation. Such a run writes without a
 * row whoever planned it, so it is not resumed. A mandate's run stays resumable even once its
 * grant ended: it names its planner, and its approval was the owner's act. The conversations
 * being unreadable counts against a run from before v31 only.
 */
export function plannerUnshown(
  row: Pick<RunRow, 'principal' | 'mandate_id' | 'created_by' | 'created_at'>,
  own: BulkOwnership,
): boolean {
  if (row.principal === principalTag(OWNER_PRINCIPAL)) return false;
  if (row.principal !== null) return delegatedPlannerOf(row) === null;
  if (!own.threadsKnown) return true;
  return plannerHasEnded(row, own);
}

/** An external run as its preview effect reads it. Not model-facing. */
export interface BulkRunForPreview {
  id: string;
  kind: BulkRunKind;
  targetSystem: string;
  phase: BulkPhase;
  haltReason: string | null;
  contractJson: string | null;
  /** The delegated session that planned the run, or null for the owner's own: its reads are
   *  recorded in the actor trail under this principal (`ExternalClientDeps.recordRead`). */
  delegatedPlanner: RequestPrincipal | null;
}

/** The write verb an external run's stored contract grants besides GET, or null. Read
 *  here rather than imported: the ledger must not depend on the writer's module. */
function parseContractMethods(json: string | null): string | null {
  if (json === null) return null;
  try {
    const methods = (JSON.parse(json) as { httpMethods?: unknown }).httpMethods;
    if (!Array.isArray(methods)) return null;
    const writes = methods.filter((m) => m !== 'GET');
    return writes.length === 1 && typeof writes[0] === 'string' ? writes[0] : null;
  } catch {
    return null;
  }
}

/** The kind of resource a target URL path names: the path without its last segment —
 *  `/2.0/article/7` → `/2.0/article/`. One host serves many kinds (bexio: articles and
 *  contacts), and a verb that keeps unsent fields on one may replace the resource on another,
 *  so a probe vouches for its kind only. */
export function resourceKindOf(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed.slice(0, trimmed.lastIndexOf('/') + 1);
}

/** Marks a probe written to an unmeasured target in `bulk_host_probes.kind`. A kind is a path
 *  and starts with `/`, so a marked one never equals a plain one. */
const UNMEASURED_PROBE = 'unmeasured:';
/** The method a Shopify run's probe is filed under: its form writes with a `POST` to the store's endpoint. */
const SHOPIFY_PROBE_METHOD = 'POST';

/** The before-image an external undo writes, cut to the fields its source sent to that target.
 *  A before-image is read over exactly those fields today (`beforeOverFields`); this holds it so
 *  where an image was stored wider. */
function onlySentFields(before: BeforeImage, sent: BeforeImage): BeforeImage {
  if (before.absent || sent.absent || !isPlainRecord(before.value) || !isPlainRecord(sent.value)) return before;
  const keep = new Set(Object.keys(sent.value));
  return { absent: false, value: Object.fromEntries(Object.entries(before.value).filter(([k]) => keep.has(k))) };
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The target paths an external run's stored contract grants. */
function parseContractPaths(json: string | null): string[] {
  if (json === null) return [];
  try {
    const paths = (JSON.parse(json) as { pathPatterns?: unknown }).pathPatterns;
    return Array.isArray(paths) ? paths.filter((p): p is string => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * A run of the family under root `?1`, other than `?2`, that may write. Exported for the test
 * that holds the lookup to its index (`idx_bulk_runs_source`, engine.db v17).
 */
export const OPEN_IN_FAMILY_SQL =
  `WITH RECURSIVE fam(id) AS (SELECT ? UNION SELECT r.id FROM bulk_runs r JOIN fam ON r.source_run_id = fam.id)
   SELECT b.id FROM bulk_runs b JOIN fam ON b.id = fam.id
   WHERE b.phase IN ('approved','writing') AND b.halt_reason IS NULL AND b.id IS NOT ? LIMIT 1`;

/** Why a run may not start writing because of an undo — see `BulkLedger.writeBlocked`. */
export type UndoRefusal = 'undo_open' | 'source_running' | 'undo_stale';

/** A run whose own loop has stopped and is not started again unless a human resumes it. */
function isStopped(r: { phase: BulkPhase; halt_reason: string | null }): boolean {
  return r.phase === 'done' || r.phase === 'aborted' || (r.phase === 'writing' && r.halt_reason !== null);
}

/** An external run's target system, `http:<host>`. */
export function externalHostOf(targetSystem: string): string | null {
  return targetSystem.startsWith('http:') ? targetSystem.slice('http:'.length) : null;
}

/**
 * Whether an external run's stored contract grants a write to a mail provider's API. Read
 * from the contract — its host and every target path, in clear — so it holds for a run
 * planned before mail targets were refused at planning, too.
 */
export function contractWritesMail(targetSystem: string, contractJson: string | null): boolean {
  const host = externalHostOf(targetSystem);
  if (host === null) return false;
  return parseContractPaths(contractJson).some((path) => isMailProviderTarget(`https://${host}${path}`));
}

/** A run as the effect loop reads it. Not model-facing. */
export interface BulkRunForApply {
  id: string;
  kind: BulkRunKind;
  targetSystem: string;
  targetCollection: string | null;
  atomic: boolean;
  phase: BulkPhase;
  approvalChecksum: string | null;
  maxTargets: number | null;
  expiresAt: string | null;
  applied: number;
  /** Targets failed in this pass — what the failure-rate halt counts. A resume sets it back. */
  failed: number;
  haltReason: string | null;
  sourceRunId: string | null;
  /** The contract an external run was planned with; null for a local run. */
  contractJson: string | null;
  /** As {@link BulkRunForPreview.delegatedPlanner}. */
  delegatedPlanner: RequestPrincipal | null;
}

/** One target as the effect loop writes it: the state it must find, the state it writes. */
export interface ApplyTarget {
  seq: number;
  key: string;
  change: 'update' | 'create' | 'delete';
  /** The state the target must hold for the write to go ahead. */
  expected: BeforeImage;
  /** The state the write produces; absent for a `delete`. */
  after: BeforeImage;
  sourceSeq: number | null;
}

/** Changes that write. `unchanged` and `invalid` targets are never touched. */
const WRITING_CHANGES = "('update','create','delete')";
/** The one definition of a target that writes: a writing change the owner did not take out
 *  before approving (PRD shopify-preset §20.2 item 4). Every query that selects or counts
 *  writing targets is built on it, so none can miss a deselected one. */
const WRITING_SQL = `change IN ${WRITING_CHANGES} AND deselected_at IS NULL`;
// The targets a resume tries again (`resume` clears every error but `secret`, `listPending`
// then takes the unwritten ones that are not taken back), a target a live claim still holds
// included. Under `WRITING_SQL`.
const RESUMABLE_SQL = "(applied_at IS NULL AND undone_at IS NULL AND (error IS NULL OR error != 'secret'))";

/** After the applied count: how many of those targets already held their value and were sent
 *  nothing, so a count above the approved maximum does not read as a broken cap. */
export function bulkFoundAsPlannedNote(found: number): string {
  return found > 0 ? ` (${String(found)} already held the planned value and were sent nothing)` : '';
}

/**
 * The source targets an undo takes back: applied and not taken back since — and, for an
 * external run, a target whose write failed. A request to a host can land although its
 * answer never came back (a timeout after it went out), so such a target may hold what the
 * source wrote. The undo reads it before writing, like every target, and finds out.
 */
function undoEligible(external: boolean): string {
  // `write_sent`, not `error = 'write_failed'`: a resume clears the error, and a retry that
  // then meets a conflict leaves no error of that kind, while the first write may stand.
  // A target found already holding its value and never sent to (`found_unsent`) is not taken
  // back: the run did not change it, and its undo would overwrite whoever did.
  return `undone_at IS NULL AND ${WRITING_SQL} AND ((applied_at IS NOT NULL AND found_unsent = 0)${external ? ' OR write_sent = 1' : ''})`;
}

/** Per-target undo class, derived from what is there: creating is compensatable,
 *  overwriting needs the before-image. */
function undoFor(before: BeforeImage): UndoKind {
  return before.absent ? 'compensatable' : 'restorable';
}

/** Canonical JSON: object keys sorted, so equal values hash and compare equal. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

/**
 * Whether two values are the same, byte for byte over canonical JSON — except a run's HTML fields
 * (`htmlFieldsOf`) of two objects, compared under `htmlEqual` where both sides are text (PRD
 * shopify-preset §21.2 item 5): a store re-serialises a description, so its reformatting is no
 * change, while one changed character, element or attribute still is. Only where both sides end
 * closed (`endsClosed`) and hold the same stretches the parser drops (`droppedTagsOf`): the tree
 * never sees a tag left open at the end, a `<body onload>` or a stray end tag, which the page runs
 * all the same, so such a value compares byte for byte. A field one side holds and the other does
 * not differs; every other field stays byte-equal.
 */
export function sameValue(a: unknown, b: unknown, htmlFields: readonly string[] = []): boolean {
  const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (htmlFields.length === 0 || !isObject(a) || !isObject(b)) return canonicalJson(a) === canonicalJson(b);
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (Object.hasOwn(a, k) !== Object.hasOwn(b, k)) return false;
    const x = a[k];
    const y = b[k];
    const same = htmlFields.includes(k) && typeof x === 'string' && typeof y === 'string' && endsClosed(x) && endsClosed(y)
      && sameStrings(droppedTagsOf(x), droppedTagsOf(y))
      ? htmlEqual(x, y) : canonicalJson(x) === canonicalJson(y);
    if (!same) return false;
  }
  return true;
}

/** Whether two lists hold the same strings, each as often (order aside). */
function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const x = [...a].sort();
  const y = [...b].sort();
  return x.every((v, i) => v === y[i]);
}

/** What the rule would do to one target; `htmlFields` compare under `htmlEqual` ({@link sameValue}). */
export function classifyChange(before: BeforeImage, after: unknown, htmlFields: readonly string[] = []): BulkChange {
  if (before.absent) return 'create';
  return sameValue(before.value, after, htmlFields) ? 'unchanged' : 'update';
}

/** The diff between a before-image and the planned after-state. Text is diffed by
 *  line; a row (plain object) by field, over the fields the after-state names. */
export function diffTarget(before: BeforeImage, after: unknown): TargetDiff {
  const prior = before.absent ? undefined : before.value;
  if (typeof after === 'string' && (prior === undefined || typeof prior === 'string')) {
    const a = prior === undefined ? [] : prior.split('\n');
    const b = after.split('\n');
    if (prior !== undefined && prior === after) return { kind: 'none' };
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    let endA = a.length;
    let endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
    return { kind: 'text', from: start, removed: a.slice(start, endA), added: b.slice(start, endB) };
  }
  if (after !== null && typeof after === 'object' && !Array.isArray(after)) {
    const priorObj = prior !== null && typeof prior === 'object' && !Array.isArray(prior)
      ? prior as Record<string, unknown> : {};
    const fields = Object.keys(after as Record<string, unknown>).sort()
      .filter((f) => canonicalJson(priorObj[f]) !== canonicalJson((after as Record<string, unknown>)[f]))
      .map((f) => ({ field: f, before: priorObj[f], after: (after as Record<string, unknown>)[f] }));
    return fields.length === 0 ? { kind: 'none' } : { kind: 'fields', fields };
  }
  return canonicalJson(prior) === canonicalJson(after)
    ? { kind: 'none' }
    : { kind: 'fields', fields: [{ field: '', before: prior, after }] };
}

/** The (key, after) pairs that make up a rule as planned, in key order, so the same
 *  rule planned twice yields the same sequence. */
function* rulePairs(
  targetSystem: string, scope: string,
  targets: readonly ({ key: string; after: unknown } | { key: string; invalid: BulkInvalidReason })[],
): Generator<string> {
  yield targetSystem;
  yield scope;
  const sorted = [...targets].sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  for (const t of sorted) {
    yield t.key;
    yield 'invalid' in t ? '' : canonicalJson(t.after);
  }
}

export class BulkLedger {
  /** `mirror`: history.db's copy of the thread containment (`history-markers.ts`), read with engine.db's when a run is planned from a thread. */
  constructor(private readonly engineDb: EngineDb, private readonly mirror: ContainmentMirror | null) {}

  /**
   * Record a dry run: the run in phase `previewed` and every target with its
   * before-image, planned after-state and change class, in one transaction. Writes
   * only the ledger — never a target.
   */
  recordDryRun(params: {
    createdBy: string | undefined;
    /** The chat the run is planned from, read through `chatThreadOf` (a spawned child's or a
     *  workflow step's chat too, which `createdBy` does not carry). When it is contained, the run
     *  is contained for the same connections in the transaction that inserts it. */
    planningThread?: string | undefined;
    /** Who planned it: the request's principal. Required, so every run says (§3.13 B7). */
    principal: RequestPrincipal;
    targetSystem: BulkTargetSystem;
    scope: string;
    targets: readonly PlannedTarget[];
    /** The data-store collection the run writes; null for workspace runs. */
    targetCollection?: string | null | undefined;
    atomic?: boolean | undefined;
    /** A rule a model applies per target (`bulk_judge`, PRD bulk-loop §3.1). The run then lands
     *  `planned` and halted until the owner starts it, every target planned with
     *  {@link judgeTemplate} as its after-state until its verdict; a data-store run only. */
    judge?: JudgeRule | undefined;
  }): BulkRunStatus {
    if (params.judge !== undefined && params.targetSystem !== 'data_store') {
      // A workspace target is text, not fields: a verdict over F has nothing to replace in it.
      throw new Error('A judged bulk run needs a data-store or an external target system.');
    }
    // Key uniqueness lives here, not in the schema: `target_key` is stored encrypted
    // (see engine-db v13), so no index could enforce it.
    const seen = new Set<string>();
    for (const t of params.targets) {
      if (seen.has(t.key)) throw new Error('A bulk plan names the same target twice.');
      seen.add(t.key);
    }
    const db = this.engineDb.getDb();
    const id = randomUUID();
    const undoKinds = new Set<UndoKind>();
    for (const t of params.targets) if (!('invalid' in t)) undoKinds.add(undoFor(t.before));
    const runUndo: UndoKind | 'mixed' = undoKinds.size === 1 ? [...undoKinds][0]! : undoKinds.size === 0 ? 'none' : 'mixed';

    const judged = params.judge !== undefined;
    const insertRun = db.prepare(
      `INSERT INTO bulk_runs (id, created_by, rule_hash, target_system, undo, phase, targets_total, atomic, target_collection,
         principal, mandate_id, halt_reason, judge_rule, judge_rule_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertTarget = db.prepare(
      `INSERT INTO bulk_targets (run_id, seq, target_key, change, undo, before, after_planned, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    db.transaction(() => {
      const own = this.capRoomFor(params.principal);
      // Contained before the row it governs, in the same transaction (`containment.ts`).
      containRunFromThread(db, this.mirror, params.planningThread, id);
      insertRun.run(
        // Keyed: a plain hash over (key, after) pairs would let a copy of the file confirm
        // guessed keys — the very values `target_key` is encrypted to protect.
        id, params.createdBy ?? null, this.engineDb.keyedHash(rulePairs(params.targetSystem, params.scope, params.targets)),
        params.targetSystem, runUndo,
        // A judged run is read as planned, and waits for the owner's start: its calls cost money.
        judged ? 'planned' : 'previewed',
        params.targets.length, params.atomic === true ? 1 : 0, params.targetCollection ?? null,
        ...planner(params.principal),
        judged ? BULK_HALT_REASONS.awaitingStart : null,
        ...this.judgeColumns(params.judge),
      );
      params.targets.forEach((t, seq) => {
        const key = this.engineDb.enc(t.key);
        if ('invalid' in t) {
          insertTarget.run(id, seq, key, 'invalid', null, null, null, t.invalid);
          return;
        }
        insertTarget.run(
          // Until its verdict, a judged target's change is not known: `update`, as an unread one.
          id, seq, key, judged ? 'update' : classifyChange(t.before, t.after), undoFor(t.before),
          this.engineDb.enc(JSON.stringify(t.before)), this.engineDb.enc(JSON.stringify(t.after ?? null)), null,
        );
      });
      this.pruneUnapproved(params.principal, own, id);
    })();
    return this.getStatus(id)!;
  }

  /** The two judge columns of a new run: the rule encrypted, and its keyed hash. */
  private judgeColumns(judge: JudgeRule | undefined): [string | null, string | null] {
    if (judge === undefined) return [null, null];
    const text = canonicalJson(judge);
    return [this.engineDb.enc(text), this.engineDb.keyedHash(['bulk-judge-rule-v1', text])];
  }

  /**
   * Whether a new unapproved run of this planner fits under {@link BULK_MAX_PREVIEWED_RUNS}, asked
   * in the planning's transaction before its run is inserted. The owner's planning always fits: it
   * drops the oldest over the cap, whoever planned them, as before. Anyone else's (660b) may drop
   * only runs of its own planner, so it throws {@link BulkPreviewCapError} when those are too few
   * to make room — a preview cannot be discarded by hand, so dropping the owner's for it would
   * leave the owner nothing to approve. Returns how many of its own the planning will drop.
   */
  private capRoomFor(principal: RequestPrincipal): number {
    if (isOwnerPrincipal(principal)) return 0;
    const db = this.engineDb.getDb();
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM bulk_runs WHERE ${PRUNABLE_RUNS}`).get() as { n: number }).n;
    const over = total + 1 - BULK_MAX_PREVIEWED_RUNS;
    if (over <= 0) return 0;
    const [tag, mandateId] = planner(principal);
    const own = (db.prepare(`SELECT COUNT(*) AS n FROM bulk_runs WHERE ${PRUNABLE_RUNS} AND principal = ? AND mandate_id IS ?`)
      .get(tag, mandateId) as { n: number }).n;
    if (own >= over) return over;
    // The runs that wait on the owner's approval, not the whole set the cap counts: that also
    // holds runs still to be started and ones replaced by another start.
    const waiting = (db.prepare(`SELECT COUNT(*) AS n FROM bulk_runs WHERE kind = 'apply' AND phase = 'previewed'`).get() as { n: number }).n;
    throw new BulkPreviewCapError(waiting);
  }

  /**
   * Drop the oldest unapproved apply runs beyond {@link BULK_MAX_PREVIEWED_RUNS}:
   * previewed ones, and `planned` external ones whose preview is still reading. A dropped
   * planned run's preview trigger goes with it, in the caller's transaction (plan §6
   * Q3(b)); an effect already running finds no run on its next target and stops.
   * The owner's planning drops over all planners; anyone else's drops `own` runs of its own
   * planner, which {@link capRoomFor} counted before the new run was inserted (never that one).
   */
  private pruneUnapproved(principal: RequestPrincipal, own = 0, newRun: string | null = null): void {
    const db = this.engineDb.getDb();
    const [tag, mandateId] = planner(principal);
    const doomed = isOwnerPrincipal(principal)
      ? db.prepare(
        `SELECT id FROM bulk_runs WHERE ${PRUNABLE_RUNS} AND id NOT IN (
           SELECT id FROM bulk_runs WHERE ${PRUNABLE_RUNS}
           ORDER BY created_at DESC, rowid DESC LIMIT ?)`,
      ).all(BULK_MAX_PREVIEWED_RUNS) as { id: string }[]
      : own <= 0 ? []
      : db.prepare(
        `SELECT id FROM bulk_runs WHERE ${PRUNABLE_RUNS} AND principal = ? AND mandate_id IS ? AND id IS NOT ?
         ORDER BY created_at ASC, rowid ASC LIMIT ?`,
      ).all(tag, mandateId, newRun, own) as { id: string }[];
    const triggers = new TriggerStore(this.engineDb);
    const drop = db.prepare('DELETE FROM bulk_runs WHERE id = ?');
    for (const { id } of doomed) {
      triggers.remove(bulkPreviewTriggerId(id));
      drop.run(id);
    }
  }

  /**
   * Record an external plan (`http:<host>`, plan B §3): the run in phase `planned`, its
   * contract, every target with its after-state and no before-image — in one transaction
   * (plan §6 Q3(a)). Sends nothing, and arms nothing: the run is halted with
   * {@link BULK_HALT_REASONS.awaitingStart} until the owner starts the read through
   * {@link resumePreview}. Every read carries the host's stored credential and may cost
   * money on a per-call profile, so its start is a human step, like an approval — the
   * host budget stays as a second line. While another external run is reading, a second
   * plan is refused: an ordering rule, not a cap.
   */
  recordExternalPlan(params: {
    createdBy: string | undefined;
    /** The chat the run is planned from, read through `chatThreadOf` (a spawned child's or a
     *  workflow step's chat too, which `createdBy` does not carry). When it is contained, the run
     *  is contained for the same connections in the transaction that inserts it. */
    planningThread?: string | undefined;
    /** Who planned it: the request's principal. Required, so every run says (§3.13 B7). */
    principal: RequestPrincipal;
    host: string;
    targets: readonly ExternalPlanned[];
    contract: CapabilityContract;
    /** A rule a model applies per target; the targets are planned with its template. */
    judge?: JudgeRule | undefined;
  }): { ok: true; status: BulkRunStatus } | { ok: false; reason: 'external_in_progress' } {
    const seen = new Set<string>();
    for (const t of params.targets) {
      if (seen.has(t.key)) throw new Error('A bulk plan names the same target twice.');
      seen.add(t.key);
    }
    const db = this.engineDb.getDb();
    const id = randomUUID();
    const targetSystem = `http:${params.host}`;
    const valid = params.targets.some((t) => !('invalid' in t));
    const insertTarget = db.prepare(
      `INSERT INTO bulk_targets (run_id, seq, target_key, change, undo, before, after_planned, error)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
    );
    const recorded = db.transaction((): boolean => {
      this.haltDeadReads();
      const reading = db.prepare(
        `SELECT COUNT(*) AS n FROM bulk_runs WHERE phase = 'planned' AND halt_reason IS NULL AND target_system LIKE 'http:%'`,
      ).get() as { n: number };
      if (reading.n > 0) return false;
      const own = this.capRoomFor(params.principal);
      containRunFromThread(db, this.mirror, params.planningThread, id);
      db.prepare(
        `INSERT INTO bulk_runs (id, created_by, rule_hash, target_system, undo, phase, targets_total, atomic, contract_json, halt_reason,
           principal, mandate_id, judge_rule, judge_rule_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id, params.createdBy ?? null,
        this.engineDb.keyedHash(rulePairs(targetSystem, params.host, params.targets)),
        // Nothing valid to read: the run is complete as planned.
        targetSystem, valid ? 'restorable' : 'none', valid ? 'planned' : 'previewed', params.targets.length,
        JSON.stringify(params.contract),
        // The start gate: nothing is read until the owner starts it (resumePreview). A plan
        // is what the model can make; a request with the host's credential is not.
        valid ? BULK_HALT_REASONS.awaitingStart : null,
        ...planner(params.principal),
        ...this.judgeColumns(params.judge),
      );
      params.targets.forEach((t, seq) => {
        const key = this.engineDb.enc(t.key);
        if ('invalid' in t) {
          insertTarget.run(id, seq, key, 'invalid', null, null, t.invalid);
          return;
        }
        // `update` until the preview reads the target; `unread` in the status says so.
        insertTarget.run(id, seq, key, 'update', 'restorable', this.engineDb.enc(JSON.stringify(t.after)), null);
      });
      this.pruneUnapproved(params.principal, own, id);
      return true;
    })();
    if (!recorded) return { ok: false, reason: 'external_in_progress' };
    return { ok: true, status: this.getStatus(id)! };
  }

  /**
   * Record an external plan whose targets come from a list (PRD bulk-loop §3.2): the run in
   * `planned` with no target yet, its list source and its READ contract (GET on the list's
   * path), halted with {@link BULK_HALT_REASONS.awaitingStart} — always, though it holds no
   * target: a list plan has none until it is read, and a run that is not halted counts as
   * reading. Nothing is sent until the owner starts it ({@link resumePreview}) with the
   * checksum of what they were shown ({@link listStartChecksum}).
   */
  recordExternalListPlan(params: {
    createdBy: string | undefined;
    /** The chat the run is planned from, read through `chatThreadOf` (a spawned child's or a
     *  workflow step's chat too, which `createdBy` does not carry). When it is contained, the run
     *  is contained for the same connections in the transaction that inserts it. */
    planningThread?: string | undefined;
    principal: RequestPrincipal;
    host: string;
    source: BulkListSource;
    readContract: CapabilityContract;
    /** A rule a model applies per listed target; `source.after` is then its template. */
    judge?: JudgeRule | undefined;
  }): { ok: true; status: BulkRunStatus } | { ok: false; reason: 'external_in_progress' } {
    const db = this.engineDb.getDb();
    const id = randomUUID();
    const targetSystem = `http:${params.host}`;
    const sourceJson = canonicalJson(params.source);
    const recorded = db.transaction((): boolean => {
      this.haltDeadReads();
      const reading = db.prepare(
        `SELECT COUNT(*) AS n FROM bulk_runs WHERE phase = 'planned' AND halt_reason IS NULL AND target_system LIKE 'http:%'`,
      ).get() as { n: number };
      if (reading.n > 0) return false;
      const own = this.capRoomFor(params.principal);
      containRunFromThread(db, this.mirror, params.planningThread, id);
      db.prepare(
        `INSERT INTO bulk_runs (id, created_by, rule_hash, target_system, undo, phase, targets_total, atomic, contract_json, halt_reason,
           principal, mandate_id, list_source, list_state, judge_rule, judge_rule_hash)
         VALUES (?, ?, ?, ?, 'restorable', 'planned', 0, 0, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      ).run(
        id, params.createdBy ?? null,
        // Until the list is read there are no (key, after) pairs: the rule is the source itself.
        // `finishList` rewrites it over the pairs, which is what `approve` and `resume` compare.
        this.engineDb.keyedHash(['bulk-list-rule-v1', targetSystem, sourceJson]),
        targetSystem, JSON.stringify(params.readContract), BULK_HALT_REASONS.awaitingStart,
        ...planner(params.principal), this.engineDb.enc(sourceJson),
        ...this.judgeColumns(params.judge),
      );
      this.pruneUnapproved(params.principal, own, id);
      return true;
    })();
    if (!recorded) return { ok: false, reason: 'external_in_progress' };
    return { ok: true, status: this.getStatus(id)! };
  }

  /**
   * The checksum the owner's start of a list read must present: over the run's system, its
   * list source and its read contract — what the start sends requests for, with the host's
   * credential. Null unless the run's list is still to be read.
   */
  listStartChecksum(runId: string): string | null {
    const run = this.runRow(runId);
    if (!run || run.list_state !== 'pending' || run.list_source === null) return null;
    // A judged list's start also binds its rule: the owner who starts the list read starts the
    // run whose rule they were shown (PRD bulk-loop §3.1).
    return this.engineDb.keyedHash([
      'bulk-list-start-v1', run.target_system, this.engineDb.dec(run.list_source), run.contract_json ?? '',
      ...(run.judge_rule_hash !== null ? ['judge', run.judge_rule_hash] : []),
    ]);
  }

  /** A run whose list is being read, or null. */
  getListRun(runId: string): BulkListRun | null {
    const r = this.runRow(runId);
    if (!r || r.list_source === null || r.list_state === null) return null;
    const host = externalHostOf(r.target_system);
    if (host === null) return null;
    return {
      id: r.id, host, source: JSON.parse(this.engineDb.dec(r.list_source)) as BulkListSource, state: r.list_state,
      page: r.list_page, calls: r.list_calls, bytes: r.list_bytes, lastId: r.list_last_id, phase: r.phase, haltReason: r.halt_reason,
      contractJson: r.contract_json,
    };
  }

  /**
   * Count one request of a list read before it is sent, up to `max`. False when the run has
   * spent its requests, or is no longer reading its list — then nothing may be sent.
   */
  takeListCall(runId: string, max: number): boolean {
    return this.engineDb.getDb().prepare(
      `UPDATE bulk_runs SET list_calls = list_calls + 1
       WHERE id = ? AND phase = 'planned' AND halt_reason IS NULL AND list_state = 'pending' AND list_calls < ?`,
    ).run(runId, max).changes === 1;
  }

  /** Give back a request {@link takeListCall} counted that was never sent: the profile's own
   *  rate limit answered before it left. Without this, a slow profile limit spends the cap. */
  returnListCall(runId: string): void {
    this.engineDb.getDb().prepare(`UPDATE bulk_runs SET list_calls = list_calls - 1 WHERE id = ?`).run(runId);
  }

  /**
   * Record one page of a run's list, in one transaction, only as the page after the last one
   * recorded and only while the run is reading its list — so two loops, or a loop after a
   * lost lease, cannot record a page twice. A key seen before (the list moved under the read)
   * is passed over. An element without a usable id becomes an `invalid` target under an
   * engine-made key, never one built from the provider's text. `too_large` when the targets,
   * or their after-states, would pass the run's caps; then nothing is recorded. `lastId`, for a
   * list read by id (Shopify), is where the next page starts; it is written with the page, under
   * the same guard, so a page and its cursor are recorded together or not at all.
   */
  recordListPage(runId: string, page: { page: number; items: readonly ListPageItem[]; bytes: number; lastId?: number }):
    { ok: true; added: number; total: number } | { ok: false; reason: 'moved' | 'too_large' } {
    const db = this.engineDb.getDb();
    return db.transaction((): { ok: true; added: number; total: number } | { ok: false; reason: 'moved' | 'too_large' } => {
      const run = db.prepare(
        `SELECT * FROM bulk_runs WHERE id = ? AND phase = 'planned' AND halt_reason IS NULL AND list_state = 'pending' AND list_page = ?`,
      ).get(runId, page.page - 1) as RunRow | undefined;
      if (!run || run.list_source === null) return { ok: false, reason: 'moved' };
      const source = JSON.parse(this.engineDb.dec(run.list_source)) as BulkListSource;
      const afterText = JSON.stringify(source.after);
      // Keys are stored encrypted, so no index can say which are known: read them back.
      const known = new Set((db.prepare(`SELECT target_key FROM bulk_targets WHERE run_id = ? AND change != 'invalid'`)
        .all(runId) as { target_key: string }[]).map((r) => this.engineDb.dec(r.target_key)));
      const fresh: { key: string; error: BulkInvalidReason | null }[] = [];
      page.items.forEach((item, index) => {
        if ('invalid' in item) fresh.push({ key: `#${String(page.page)}.${String(index)}`, error: item.invalid });
        else if (!known.has(item.key)) {
          known.add(item.key);
          fresh.push({ key: item.key, error: null });
        }
      });
      const total = run.targets_total + fresh.length;
      const valid = known.size;
      // A judged run's after-state is decided later: what each target may take is the verdict's
      // byte bound, not the template's size — so the cap cannot fail after calls were paid.
      const perTarget = run.judge_rule !== null
        ? judgeAfterBound(this.judgeRuleOf(run).schema)
        : Buffer.byteLength(afterText, 'utf8');
      if (total > BULK_MAX_TARGETS || valid * perTarget > BULK_MAX_TOTAL_BYTES) {
        return { ok: false, reason: 'too_large' };
      }
      const insert = db.prepare(
        `INSERT INTO bulk_targets (run_id, seq, target_key, change, undo, before, after_planned, error)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
      );
      const encAfter = this.engineDb.enc(afterText);
      fresh.forEach((t, i) => {
        const seq = run.targets_total + i;
        if (t.error !== null) insert.run(runId, seq, this.engineDb.enc(t.key), 'invalid', null, null, t.error);
        else insert.run(runId, seq, this.engineDb.enc(t.key), 'update', 'restorable', encAfter, null);
      });
      db.prepare(`UPDATE bulk_runs SET list_page = ?, list_bytes = list_bytes + ?, targets_total = ?, list_last_id = COALESCE(?, list_last_id) WHERE id = ?`)
        .run(page.page, page.bytes, total, page.lastId ?? null, runId);
      return { ok: true, added: fresh.filter((t) => t.error === null).length, total };
    })();
  }

  /**
   * Close the read of a run's list: its write contract over the keys now known (`mint`, the
   * caller's — `mintBulkContract`), its rule over the (key, after) pairs, and a halt
   * ({@link BULK_HALT_REASONS.listed}) so the owner sees how many targets the list holds
   * before any of them is read. A list with no usable target ends the run as planned, with
   * nothing to read. One transaction, only while the run is reading its list.
   */
  finishList(runId: string, mint: (keys: readonly string[]) => CapabilityContract): 'listed' | 'empty' | 'moved' {
    const db = this.engineDb.getDb();
    return db.transaction((): 'listed' | 'empty' | 'moved' => {
      const run = db.prepare(
        `SELECT * FROM bulk_runs WHERE id = ? AND phase = 'planned' AND halt_reason IS NULL AND list_state = 'pending'`,
      ).get(runId) as RunRow | undefined;
      const host = run ? externalHostOf(run.target_system) : null;
      if (!run || host === null) return 'moved';
      const rows = db.prepare(`SELECT target_key, change, after_planned FROM bulk_targets WHERE run_id = ? ORDER BY seq`)
        .all(runId) as { target_key: string; change: BulkChange; after_planned: string | null }[];
      const targets = rows.map((r) => {
        const key = this.engineDb.dec(r.target_key);
        return r.change === 'invalid' || r.after_planned === null
          ? { key, invalid: 'list_item_bad_id' as BulkInvalidReason }
          : { key, after: JSON.parse(this.engineDb.dec(r.after_planned)) as unknown };
      });
      const keys = targets.filter((t) => !('invalid' in t)).map((t) => t.key);
      const empty = keys.length === 0;
      db.prepare(
        `UPDATE bulk_runs SET contract_json = ?, rule_hash = ?, list_state = 'done', phase = ?, undo = ?, halt_reason = ?
         WHERE id = ?`,
      ).run(
        JSON.stringify(mint(keys)), this.engineDb.keyedHash(rulePairs(run.target_system, host, targets)),
        empty ? 'previewed' : 'planned', empty ? 'none' : 'restorable', empty ? null : BULK_HALT_REASONS.listed, runId,
      );
      return empty ? 'empty' : 'listed';
    })();
  }

  /** The read phase's trigger (`bulkPreviewTriggerId`): `bulk_preview`, or `bulk_judge` for a
   *  judged run past its list — never both in one run at once. */
  private armPreviewTrigger(runId: string, now: number, effect: 'bulk_preview' | 'bulk_judge' = 'bulk_preview'): string {
    return new TriggerStore(this.engineDb).armBulkEffect({
      runId,
      effect,
      // Engine text only: a trigger title is listed to the model by task_list.
      title: effect === 'bulk_judge' ? `Bulk judge ${runId}` : `Bulk preview ${runId}`,
      nextRunAt: new Date(now).toISOString(),
    });
  }

  /**
   * End every unapproved run whose planner has ended ({@link plannerHasEnded}): phase
   * `aborted`, halted with {@link BULK_HALT_REASONS.mandateEnded}, and a planned run's preview
   * trigger removed with it. Approved runs are the owner's act and stay. Returns how many ended.
   */
  expireEndedPlanners(own: BulkOwnership): number {
    const rows = this.engineDb.getDb().prepare(
      `SELECT id, principal, mandate_id, created_by, created_at FROM bulk_runs WHERE phase IN ('planned','previewed')`,
    ).all() as Pick<RunRow, 'id' | 'principal' | 'mandate_id' | 'created_by' | 'created_at'>[];
    let ended = 0;
    for (const row of rows) {
      if (row.principal === null && !own.threadsKnown) continue;
      if (plannerHasEnded(row, own) && this.endRun(row.id)) ended += 1;
    }
    return ended;
  }

  /**
   * Whether this run is refused because its planner has ended. The run is then ended as
   * {@link expireEndedPlanners} ends it; a run from before v31 while the conversations cannot be
   * read is refused and left as it is.
   */
  endIfPlannerEnded(runId: string, own: BulkOwnership): boolean {
    const row = this.runRow(runId);
    if (!row || !plannerHasEnded(row, own)) return false;
    if (row.principal === null && !own.threadsKnown) return row.phase === 'planned' || row.phase === 'previewed';
    return this.endRun(runId);
  }

  /** Whether this run is refused a resume because no one can be shown as its planner ({@link plannerUnshown}).
   *  Only a run a resume could move on: any other is `resume`'s own refusal to give. Ends nothing. */
  resumeRefusedForPlanner(runId: string, own: BulkOwnership): boolean {
    const row = this.runRow(runId);
    return row !== undefined && (row.phase === 'approved' || row.phase === 'writing') && plannerUnshown(row, own);
  }

  /** Ends an unapproved run; its own phase guard is what keeps an approved run, the owner's act, as it is. */
  private endRun(runId: string): boolean {
    const db = this.engineDb.getDb();
    return db.transaction((): boolean => {
      const res = db.prepare(
        `UPDATE bulk_runs SET phase = 'aborted', halt_reason = ? WHERE id = ? AND phase IN ('planned','previewed')`,
      ).run(BULK_HALT_REASONS.mandateEnded, runId);
      if (res.changes !== 1) return false;
      new TriggerStore(this.engineDb).remove(bulkPreviewTriggerId(runId));
      return true;
    })();
  }

  /** Counters and phase of one run. No target key, value or diff. */
  getStatus(runId: string): BulkRunStatus | null {
    this.freeDeadReads(runId);
    const row = this.engineDb.getDb().prepare('SELECT * FROM bulk_runs WHERE id = ?').get(runId) as RunRow | undefined;
    return row ? this.toStatus(row) : null;
  }

  /**
   * {@link haltDeadReads} for a read that counts no slot: the status and list reads, and a start
   * before it reads its own run. Writes only when a dead run is there, so a read of a live
   * one stays a read; then under the write lock, IMMEDIATE, so a write from another process
   * between the check and the halt cannot fail it (the halt re-selects what it halts).
   */
  private freeDeadReads(onlyRunId?: string): void {
    if (this.deadReads(onlyRunId).length === 0) return;
    this.engineDb.getDb().transaction(() => this.haltDeadReads(onlyRunId)).immediate();
  }

  /**
   * Halt, with {@link BULK_HALT_REASONS.unavailable}, an external run that holds the read slot
   * (`planned`, not halted) while no read trigger is left to go on with it: the trigger was
   * deleted, or it ended without moving the run — a throw before the read began, a crash
   * between recording a pause and re-arming for it, the feature switched off under it. Such a
   * run blocked every other external plan and could not be resumed, since only a halted run
   * is. Halted, the owner resumes it like any other halt.
   *
   * "No read trigger left" is {@link TriggerStore.isLive} on the run's
   * {@link bulkPreviewTriggerId}, the tick's own predicate: a trigger re-armed for later, or
   * one whose run holds a live lease and has not recorded yet, is live, and its run is left
   * alone. Runs in the caller's transaction, beside the read it guards, so the run it halts is
   * the one it selected as unhalted: idempotent, and a reason already set stays. `onlyRunId`
   * limits it to one run.
   */
  private haltDeadReads(onlyRunId?: string): void {
    const halt = this.engineDb.getDb().prepare('UPDATE bulk_runs SET halt_reason = ? WHERE id = ?');
    for (const id of this.deadReads(onlyRunId)) halt.run(BULK_HALT_REASONS.unavailable, id);
  }

  /** The external runs that hold the read slot with no live read trigger (see {@link haltDeadReads}). */
  private deadReads(onlyRunId?: string): string[] {
    const db = this.engineDb.getDb();
    const reading = `SELECT id FROM bulk_runs WHERE phase = 'planned' AND halt_reason IS NULL AND target_system LIKE 'http:%'`;
    const rows = (onlyRunId === undefined
      ? db.prepare(reading).all()
      : db.prepare(`${reading} AND id = ?`).all(onlyRunId)) as { id: string }[];
    if (rows.length === 0) return [];
    const triggers = new TriggerStore(this.engineDb);
    const now = new Date().toISOString();
    return rows.map((r) => r.id).filter((id) => !triggers.isLive(bulkPreviewTriggerId(id), now));
  }

  /** The most recent runs, newest first, as counters. */
  listRuns(limit = 10): BulkRunStatus[] {
    this.freeDeadReads();
    const rows = this.engineDb.getDb()
      .prepare('SELECT * FROM bulk_runs ORDER BY created_at DESC, rowid DESC LIMIT ?')
      .all(Math.max(1, Math.min(limit, 50))) as RunRow[];
    return rows.map((r) => this.toStatus(r));
  }

  /**
   * The owner's view of a run: per target the before-image, the planned after-state and
   * their diff, in plan order. Its one caller is the human-facing route
   * `GET /api/bulk/runs/:id/targets`. NEVER wire this to a model-facing tool (see the
   * module comment).
   */
  getPreview(runId: string, opts: { offset?: number | undefined; limit?: number | undefined } = {}): PreviewTarget[] {
    const rows = this.engineDb.getDb().prepare(
      // `written` is the rollback's own set (`listAppliedDesc`) without the `undone_at` test.
      `SELECT seq, target_key, change, undo, before, after_planned, error, judged_at, deselected_at,
         (applied_at IS NOT NULL AND found_unsent = 0 AND ${WRITING_SQL}) AS written, undone_at IS NOT NULL AS undone,
         shop_added_markup, host_rewrote
       FROM bulk_targets WHERE run_id = ? ORDER BY seq LIMIT ? OFFSET ?`,
    ).all(runId, Math.max(1, Math.min(opts.limit ?? 500, 500)), Math.max(0, opts.offset ?? 0)) as {
      seq: number; target_key: string; change: BulkChange; undo: UndoKind | null;
      before: string | null; after_planned: string | null; error: string | null; judged_at: string | null;
      deselected_at: string | null; written: number; undone: number; shop_added_markup: number; host_rewrote: number;
    }[];
    const run = this.runRow(runId);
    const external = externalHostOf(run?.target_system ?? '') !== null;
    const judged = (run?.judge_rule ?? null) !== null;
    // An undo's list is what it restores: the HTML fields of the run its family started from.
    const htmlFields = this.htmlFieldsOf(runId);
    return rows.map((r) => {
      const before = r.before === null ? null : JSON.parse(this.engineDb.dec(r.before)) as BeforeImage;
      // A judged target without its verdict holds the template (every field null), not a plan:
      // shown as no after-state, never as a write that empties every field.
      const undecided = judged && r.judged_at === null && r.change !== 'invalid';
      const after: unknown = undecided || r.after_planned === null ? null : JSON.parse(this.engineDb.dec(r.after_planned));
      const prior = before !== null && !before.absent ? before.value : null;
      const sentUnchanged = external && prior !== null && typeof prior === 'object' && after !== null && typeof after === 'object'
        ? Object.keys(after).sort().filter((f) => canonicalJson((prior as Record<string, unknown>)[f]) === canonicalJson((after as Record<string, unknown>)[f]))
        : undefined;
      const diff: TargetDiff = before === null || undecided ? { kind: 'none' } : diffTarget(before, after);
      const markupChanges = r.change === 'update' && after !== null && typeof after === 'object'
        ? htmlFields.flatMap((f) => {
          const next = (after as Record<string, unknown>)[f];
          const was = prior !== null && typeof prior === 'object' ? (prior as Record<string, unknown>)[f] : null;
          if (typeof next !== 'string' || next === was) return [];
          const c = markupChangesOf(f, typeof was === 'string' ? was : null, next);
          return c.added.length + c.removed.length > 0 ? [c] : [];
        })
        : [];
      return {
        seq: r.seq, key: this.engineDb.dec(r.target_key), change: r.change, undo: r.undo, before, after, diff,
        changedFields: undecided ? null : diff.kind === 'none' ? 0 : diff.kind === 'text' ? 1 : diff.fields.length,
        error: r.error, deselected: r.deselected_at !== null, written: r.written === 1, undone: r.undone === 1,
        ...(r.shop_added_markup === 1 ? { shopAddedMarkup: true as const } : {}),
        ...(r.host_rewrote === 1 ? { hostRewrote: true as const } : {}),
        ...(sentUnchanged !== undefined ? { sentUnchanged } : {}),
        ...(markupChanges.length > 0 ? { markupChanges } : {}),
      };
    });
  }

  private toStatus(row: RunRow): BulkRunStatus {
    const db = this.engineDb.getDb();
    const changes: Record<BulkChange, number> = { update: 0, create: 0, delete: 0, unchanged: 0, invalid: 0 };
    for (const c of db.prepare('SELECT change, COUNT(*) AS n FROM bulk_targets WHERE run_id = ? AND deselected_at IS NULL GROUP BY change')
      .all(row.id) as { change: BulkChange; n: number }[]) changes[c.change] = c.n;
    const deselected = (db.prepare('SELECT COUNT(*) AS n FROM bulk_targets WHERE run_id = ? AND deselected_at IS NOT NULL')
      .get(row.id) as { n: number }).n;
    const invalidReasons: Partial<Record<BulkInvalidReason, number>> = {};
    for (const e of db.prepare(
      `SELECT error, COUNT(*) AS n FROM bulk_targets WHERE run_id = ? AND change = 'invalid' GROUP BY error`,
    ).all(row.id) as { error: BulkInvalidReason; n: number }[]) invalidReasons[e.error] = e.n;
    const outcome = db.prepare(
      `SELECT SUM(error = 'conflict') AS conflicts, SUM(${WRITE_FAILED_SQL}) AS failed, SUM(undone_at IS NOT NULL) AS undone, SUM(found_unsent = 1 AND write_sent = 0) AS foundAsPlanned,
         SUM(change != 'invalid' AND before IS NULL) AS unread, SUM(shop_added_markup) AS shopAddedMarkup, SUM(host_rewrote) AS hostRewrote,
         SUM(${UNCLEAR_SQL}) AS sentUnknown
       FROM bulk_targets WHERE run_id = ?`,
    ).get(row.id) as { conflicts: number | null; failed: number | null; undone: number | null; foundAsPlanned: number | null; unread: number | null; shopAddedMarkup: number | null; hostRewrote: number | null; sentUnknown: number | null };
    const pass = db.prepare(
      `SELECT COUNT(*) AS writing, SUM(failed_once IS NULL) AS unknown, SUM(failed_once = 1) AS failedOnce,
         SUM(${RESUMABLE_SQL}) AS open, SUM(${RESUMABLE_SQL} AND write_sent = 1) AS openSent
       FROM bulk_targets WHERE run_id = ? AND ${WRITING_SQL}`,
    ).get(row.id) as { writing: number; unknown: number | null; failedOnce: number | null; open: number | null; openSent: number | null };
    const open = pass.open ?? 0;
    const openSent = pass.openSent ?? 0;
    const cap = bulkWriteCap(row.max_targets, this.probeHolds(row));
    // A target already sent to takes nothing from the cap; one never sent to takes a place.
    const resumeTries = cap === null ? open : openSent + Math.min(open - openSent, Math.max(0, cap - this.sentCount(row.id)));
    return {
      id: row.id, createdAt: row.created_at, targetSystem: row.target_system, phase: row.phase, undo: row.undo,
      total: row.targets_total, unread: row.phase === 'planned' ? outcome.unread ?? 0 : 0, changes, deselected, invalidReasons,
      // The targets failed now, read off the targets like the conflicts — not `targets_failed`,
      // the halt's count of this pass, which a resume sets back while a `secret` target stays failed.
      applied: row.targets_applied, foundAsPlanned: outcome.foundAsPlanned ?? 0, shopAddedMarkup: outcome.shopAddedMarkup ?? 0, hostRewrote: outcome.hostRewrote ?? 0, failed: outcome.failed ?? 0,
      conflicts: outcome.conflicts ?? 0, undone: outcome.undone ?? 0,
      sentUnknown: externalHostOf(row.target_system) === null ? 0 : outcome.sentUnknown ?? 0,
      maxTargets: row.max_targets,
      failedOnce: (pass.unknown ?? 0) > 0 ? null : pass.failedOnce ?? 0,
      failureLimit: bulkFailureLimit(pass.writing), resumeOpen: open, resumeTries,
      kind: row.kind, atomic: row.atomic === 1, sourceRunId: row.source_run_id,
      writeMethod: externalHostOf(row.target_system) === null ? null : parseContractMethods(row.contract_json),
      probeConfirmed: this.probeHolds(row),
      writeForm: this.writeFormOfRun(row),
      checksumBinding: this.engineDb.hashIsKeyed ? 'keyed' : 'unkeyed',
      haltReason: row.halt_reason,
      list: this.listStatus(row),
      costUsd: row.cost_usd,
      costCapUsd: row.cost_cap_usd,
      startDomains: this.startDomainsOfRow(row),
      judge: row.judge_rule === null ? null : {
        tier: this.judgeRuleOf(row).tier,
        unjudged: (db.prepare(
          `SELECT COUNT(*) AS n FROM bulk_targets WHERE run_id = ? AND change != 'invalid' AND judged_at IS NULL`,
        ).get(row.id) as { n: number }).n,
      },
    };
  }

  /** A judged run's rule, decrypted. Only for a row whose `judge_rule` is set. */
  private judgeRuleOf(row: Pick<RunRow, 'judge_rule'>): JudgeRule {
    return JSON.parse(this.engineDb.dec(row.judge_rule!)) as JudgeRule;
  }

  /** Why planning would refuse a judged run's stored rule today, or null. */
  private judgeRuleRefusal(row: Pick<RunRow, 'judge_rule'>): string | null {
    try {
      normalizeJudgeRule(this.judgeRuleOf(row));
      return null;
    } catch (err: unknown) {
      if (err instanceof BulkSourceError) return err.message;
      throw err;
    }
  }

  /** What a list run's owner is shown before starting it: the source as the planner gave it. */
  private listStatus(row: RunRow): BulkListStatus | null {
    if (row.list_source === null || row.list_state === null) return null;
    const source = JSON.parse(this.engineDb.dec(row.list_source)) as BulkListSource;
    return {
      state: row.list_state, path: source.path, filters: source.filters, idField: source.idField,
      method: source.method, after: source.after, pagesRead: row.list_page,
    };
  }

  private runRow(runId: string): RunRow | undefined {
    return this.engineDb.getDb().prepare('SELECT * FROM bulk_runs WHERE id = ?').get(runId) as RunRow | undefined;
  }

  // ── Approval ────────────────────────────────────────────────────────────────

  /**
   * The approval checksum (PRD §3.1 `approval_checksum`): a digest over everything
   * an apply would do — the run's kind, system, collection, atomicity and source run,
   * and per target its key, change, before-image and planned after-state, in seq order.
   * The owner's view shows it, approving has to present it, and the effect recomputes
   * it before it writes: a ledger that changed after approval is refused, not applied.
   * It binds only with a vault key (HMAC); without one it is plain SHA-256, and the
   * status says so ({@link BulkRunStatus.checksumBinding}).
   */
  computeChecksum(runId: string): string | null {
    const run = this.runRow(runId);
    if (!run) return null;
    // Iterated, not loaded: a run's images can reach 32 MB before encryption.
    const rows = this.engineDb.getDb().prepare(
      'SELECT seq, target_key, change, before, after_planned, deselected_at FROM bulk_targets WHERE run_id = ? ORDER BY seq',
    ).iterate(runId) as IterableIterator<{ seq: number; target_key: string; change: string; before: string | null; after_planned: string | null; deselected_at: string | null }>;
    const db = this.engineDb;
    function* parts(): Generator<string> {
      yield 'bulk-approval-v1';
      yield run!.kind;
      yield run!.target_system;
      yield run!.target_collection ?? '';
      yield String(run!.atomic);
      yield run!.source_run_id ?? '';
      yield run!.rule_hash;
      // Only where there is one, so a local run's digest is what it was before contracts
      // existed — an approved run must not halt on an upgrade.
      if (run!.contract_json !== null) {
        yield 'contract';
        yield run!.contract_json;
      }
      // Only on a list run, so every other run's digest is what it was before lists existed.
      if (run!.list_source !== null) {
        yield 'list';
        yield db.dec(run!.list_source);
      }
      // Only on a judged run: the owner approves the verdicts and the rule that made them.
      if (run!.judge_rule_hash !== null) {
        yield 'judge';
        yield run!.judge_rule_hash;
      }
      // Only where the owner gave one: the link domains a verdict may add.
      if (run!.start_domains !== null) {
        yield 'start_domains';
        yield db.dec(run!.start_domains);
      }
      for (const r of rows) {
        yield String(r.seq);
        yield db.dec(r.target_key);
        yield r.change;
        yield r.before === null ? '' : db.dec(r.before);
        yield r.after_planned === null ? '' : db.dec(r.after_planned);
        // Only where there is one, so a run without a deselected target hashes as before
        // deselecting existed. Unambiguous: the next row's part is a number, never this word.
        if (r.deselected_at !== null) yield 'deselected';
      }
    }
    return this.engineDb.keyedHash(parts());
  }

  /** The key of the run's first writing target, or null. For the approval route's check
   *  that an external run can reach its host — a key only, never a value. */
  firstWritingKey(runId: string): string | null {
    const r = this.engineDb.getDb().prepare(
      `SELECT target_key FROM bulk_targets WHERE run_id = ? AND ${WRITING_SQL} ORDER BY seq LIMIT 1`,
    ).get(runId) as { target_key: string } | undefined;
    return r ? this.engineDb.dec(r.target_key) : null;
  }

  /**
   * Whether this run may write more than one target: a local run always; an external one
   * only once its host and write verb have a probe the owner confirmed ({@link confirmProbe}).
   * No provider documents whether its update verb keeps the fields a write does not send.
   * If it does not, every target of a wide run loses them, and the undo cannot bring them
   * back — it knows only the fields it wrote.
   */
  private probeHolds(run: RunRow): boolean {
    const host = externalHostOf(run.target_system);
    if (host === null) return true;
    // A Shopify run writes through its form; the form is its kind, and no form of a store is
    // measured yet, so the probe must be this run's own (PRD shopify-preset §16.3 item 4).
    const form = this.shopifyFormOfRun(run);
    if (form !== null) {
      if (run.kind === 'undo') return true;
      return this.engineDb.getDb().prepare('SELECT 1 FROM bulk_host_probes WHERE host = ? AND method = ? AND kind = ? AND run_id = ?')
        .get(host, SHOPIFY_PROBE_METHOD, `${UNMEASURED_PROBE}${form}`, run.id) !== undefined;
    }
    const method = parseContractMethods(run.contract_json);
    const kinds = [...new Set(parseContractPaths(run.contract_json).map(resourceKindOf))];
    if (method === null || kinds.length === 0) return false;
    // An undo writes only to targets its source wrote, with the form and the verb the source
    // already used on them: whatever that verb does to unsent fields, the source did it first.
    // A probe for the undo would only block it without measuring anything, and an undo cannot
    // be a probe itself — also where the source's probe no longer holds.
    if (run.kind === 'undo') return true;
    const paths = parseContractPaths(run.contract_json);
    const probed = this.engineDb.getDb().prepare('SELECT run_id FROM bulk_host_probes WHERE host = ? AND method = ? AND kind = ?');
    const own = this.engineDb.getDb().prepare('SELECT 1 FROM bulk_host_probes WHERE host = ? AND method = ? AND kind = ? AND run_id = ?');
    // Every kind of resource the run writes needs its own probe. Where the run writes an
    // unmeasured form of that kind, nobody knows whether a second run acts like the first:
    // the probe must be this run's, and it must have been written to an unmeasured target.
    return kinds.every((kind) => {
      if (paths.some((p) => resourceKindOf(p) === kind && !isMeasuredWriteForm(host, p, method))) {
        return own.get(host, method, `${UNMEASURED_PROBE}${kind}`, run.id) !== undefined;
      }
      const row = probed.get(host, method, kind) as { run_id: string } | undefined;
      return row !== undefined && this.probeWroteMeasuredForm(row.run_id, host, method, kind);
    });
  }

  /**
   * Whether the probe run wrote its one target in a measured form of this kind. A probe
   * confirmed before the write forms were told apart was filed under the plain kind wherever
   * it landed, also on an unmeasured path, and must not widen a measured run. Read from the
   * target itself, not from the row's kind; a probe whose target is gone vouches for nothing.
   * The probe target is the run's first applied one: {@link confirmProbe} takes a run with
   * exactly one applied target, and the run usually goes on wide after that.
   */
  private probeWroteMeasuredForm(probeRunId: string, host: string, method: string, kind: string): boolean {
    const first = this.engineDb.getDb().prepare(
      'SELECT target_key FROM bulk_targets WHERE run_id = ? AND applied_at IS NOT NULL AND found_unsent = 0 ORDER BY applied_at, seq LIMIT 1',
    ).get(probeRunId) as { target_key: string } | undefined;
    if (!first) return false;
    let path: string;
    try {
      path = new URL(this.engineDb.dec(first.target_key)).pathname;
    } catch {
      return false;
    }
    return resourceKindOf(path) === kind && isMeasuredWriteForm(host, path, method);
  }

  /** {@link probeHolds} for the effect loop: an external run without a probe that holds writes
   *  one target at most, whatever cap it was approved or resumed with. */
  probeHoldsFor(runId: string): boolean {
    const run = this.runRow(runId);
    return run !== undefined && this.probeHolds(run);
  }

  /**
   * The write form of a Shopify run, or null for any other run: a run on a store host whose
   * contract does not name exactly one write verb ({@link parseContractMethods} null) — none, as
   * `bulk_plan` stores it, but also several or an unreadable list. Such a run reads and writes only
   * through the engine's GraphQL documents (`shopify-graphql.ts`); one whose contract grants any
   * write verb gets no apply grant (`withShopifyApply` refuses it), so it writes nothing. A run on a
   * store host that names one verb is an ordinary one.
   */
  private shopifyFormOfRun(run: RunRow): ShopifyWriteForm | null {
    const host = externalHostOf(run.target_system);
    if (host === null || !isShopifyStoreHostName(host)) return null;
    return parseContractMethods(run.contract_json) === null ? this.shopifyFormOfFamily(run) : null;
  }

  /**
   * The form a Shopify run's targets are written with, from the list its family was planned from:
   * the run's own list source, or for an undo the one of the run it takes back. A store's images
   * are written with `shopify_media_alt`; anything else on a store host with `shopify_product`.
   */
  private shopifyFormOfFamily(run: RunRow): ShopifyWriteForm {
    return this.listFormOfFamily(run) === SHOPIFY_MEDIA_LIST_FORM ? 'shopify_media_alt' : 'shopify_product';
  }

  /**
   * The fields of a run whose values are HTML (PRD shopify-preset §21.2 item 2): those of the list
   * form its family was planned from — for an undo, and an undo of an undo, the run the family
   * started from (`source_run_id`, upward). A product of a Shopify run holds its description as
   * HTML whatever the list form says, and whether one is found (sec-core F6): the form may add HTML
   * fields, never take that one away.
   */
  htmlFieldsOf(runId: string): readonly string[] {
    const run = this.runRow(runId);
    if (!run) return [];
    const fields = new Set(htmlFieldsOfListForm(this.listFormOfFamily(run)));
    if (this.shopifyFormOfRun(run) === 'shopify_product') for (const f of htmlFieldsOfListForm('shopify')) fields.add(f);
    return [...fields];
  }

  /**
   * The fields a run compares under `htmlEqual` rather than byte for byte (PRD shopify-preset §21.2
   * item 5): the HTML fields of a Shopify product run, its undos included. A WooCommerce run keeps
   * today's comparison (§21.4, N5): its store's rewriting is not measured.
   */
  comparedAsHtml(runId: string): readonly string[] {
    const run = this.runRow(runId);
    return run !== undefined && this.shopifyFormOfRun(run) === 'shopify_product' ? this.htmlFieldsOf(runId) : [];
  }

  /** The list source form of a run, or of the first run up its `source_run_id` chain that has one; null without. */
  private listFormOfFamily(run: RunRow): BulkListSourceForm | null {
    let current: RunRow | undefined = run;
    // Bounded: a chain is one run per undo or redo, and a cycle must not hang the caller.
    for (let depth = 0; current !== undefined && depth < 64; depth++) {
      if (current.list_source !== null) return (JSON.parse(this.engineDb.dec(current.list_source)) as BulkListSource).form;
      current = current.source_run_id === null ? undefined : this.runRow(current.source_run_id);
    }
    return null;
  }

  /** A Shopify apply run while this instance does not read stores in bulk runs: it is not
   *  approved or resumed, and its apply halts before it writes, so that switching the reads off
   *  stops its writes as well. An undo is exempt: it only takes back what an approved run wrote. */
  private isShopifyRunSwitchedOff(run: RunRow): boolean {
    return run.kind === 'apply' && this.shopifyFormOfRun(run) !== null && !shopifyBulkReadEnabled();
  }

  /** {@link isShopifyRunSwitchedOff} by id, for the apply effect: asked on every pass. */
  isWriteSwitchedOff(runId: string): boolean {
    const run = this.runRow(runId);
    return run !== undefined && this.isShopifyRunSwitchedOff(run);
  }

  /** {@link writeFormOf} over the run's stored contract; null for a local run, and for a list
   *  not read yet (its contract only reads, so its write form is not known), and for a run that
   *  only reads. */
  private writeFormOfRun(run: RunRow): 'measured' | 'unmeasured' | null {
    const host = externalHostOf(run.target_system);
    if (host === null || run.list_state === 'pending') return null;
    // A Shopify run writes through its form, and no store form is measured yet.
    if (this.shopifyFormOfRun(run) !== null) return 'unmeasured';
    return writeFormOf(host, parseContractPaths(run.contract_json), parseContractMethods(run.contract_json));
  }

  /**
   * The owner confirms a probe: an external apply run wrote exactly one target with its
   * verb, and the owner checked on the provider's side that the target kept the fields the
   * write did not send. From then on runs of a measured form ({@link writeFormOf}) to that host
   * with that verb, over targets of that kind ({@link resourceKindOf}), may be approved or
   * resumed for more than one target. A probe written to an unmeasured target is kept apart
   * ({@link UNMEASURED_PROBE}): it widens only the run that wrote it, and never a measured run.
   * A target found already holding its value was not written and proves nothing, so it does
   * not count.
   */
  confirmProbe(runId: string, params: { confirmedBy?: string | undefined; now?: number | undefined } = {}):
    { ok: true } | { ok: false; reason: 'not_found' | 'not_a_probe' } {
    const probe = this.probeCandidate(runId);
    if (probe === 'not_found') return { ok: false, reason: 'not_found' };
    if (probe === null) return { ok: false, reason: 'not_a_probe' };
    const { host, method, key, form } = probe;
    const kind = form !== null ? `${UNMEASURED_PROBE}${form}` : ((path: string) => `${isMeasuredWriteForm(host, path, method) ? '' : UNMEASURED_PROBE}${resourceKindOf(path)}`)(new URL(key).pathname);
    this.engineDb.getDb().prepare(
      `INSERT INTO bulk_host_probes (host, method, kind, run_id, confirmed_by, confirmed_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (host, method, kind) DO UPDATE SET run_id = excluded.run_id, confirmed_by = excluded.confirmed_by, confirmed_at = excluded.confirmed_at`,
    ).run(host, method, kind, runId, params.confirmedBy ?? null, new Date(params.now ?? Date.now()).toISOString());
    return { ok: true };
  }

  /** The target {@link confirmProbe} would accept as this run's probe, with its host and
   *  verb: an external apply run that stopped with exactly one applied target, and that one
   *  written. 'not_found' for no such run; null for a run that holds no probe. */
  private probeCandidate(runId: string): { host: string; method: string; key: string; form: ShopifyWriteForm | null } | 'not_found' | null {
    const run = this.runRow(runId);
    if (!run) return 'not_found';
    const host = externalHostOf(run.target_system);
    const form = this.shopifyFormOfRun(run);
    const method = form !== null ? SHOPIFY_PROBE_METHOD : parseContractMethods(run.contract_json);
    if (host === null || method === null || run.kind !== 'apply') return null;
    const stopped = run.phase === 'done' || (run.phase === 'writing' && run.halt_reason !== null);
    const applied = (this.engineDb.getDb().prepare(
      'SELECT target_key, result FROM bulk_targets WHERE run_id = ? AND applied_at IS NOT NULL AND found_unsent = 0',
    ).all(runId) as { target_key: string; result: string | null }[]);
    const only = applied[0];
    if (!stopped || applied.length !== 1 || !only || only.result === null || this.engineDb.dec(only.result) !== 'written') return null;
    return { host, method, key: this.engineDb.dec(only.target_key), form };
  }

  /** The key of the target {@link confirmProbe} would accept for this run, or null. For the
   *  owner's page: it offers the confirmation only where the confirmation can succeed. */
  probeKey(runId: string): string | null {
    const probe = this.probeCandidate(runId);
    return probe === null || probe === 'not_found' ? null : probe.key;
  }

  /** How many of the run's targets an undo would take back now — for an external run that
   *  includes a failed write, which may have landed ({@link undoEligible}). */
  countUndoable(runId: string): number {
    const run = this.runRow(runId);
    if (!run) return 0;
    return (this.engineDb.getDb().prepare(
      `SELECT COUNT(*) AS n FROM bulk_targets WHERE run_id = ? AND ${undoEligible(externalHostOf(run.target_system) !== null)}`,
    ).get(runId) as { n: number }).n;
  }

  /** Targets the run writes: `update`, `create`, `delete`. */
  countWriting(runId: string): number {
    return (this.engineDb.getDb().prepare(
      `SELECT COUNT(*) AS n FROM bulk_targets WHERE run_id = ? AND ${WRITING_SQL}`,
    ).get(runId) as { n: number }).n;
  }

  private approvalWindow(writing: number, now: number): string {
    return new Date(now + Math.min(writing * BULK_TARGET_BUDGET_MS + BULK_APPROVAL_SLACK_MS, BULK_APPROVAL_MAX_MS)).toISOString();
  }

  private armTrigger(run: RunRow, now: number): string {
    return new TriggerStore(this.engineDb).armBulkEffect({
      runId: run.id,
      effect: run.kind === 'undo' ? 'bulk_undo' : 'bulk_apply',
      // Engine text only: a trigger title is listed to the model by task_list.
      title: run.kind === 'undo' ? `Bulk undo ${run.id}` : `Bulk run ${run.id}`,
      nextRunAt: new Date(now).toISOString(),
    });
  }

  /**
   * Take one target out of a previewed run before approving it, or put it back (PRD
   * shopify-preset §20.2 item 4). The target keeps its after-state; only its mark changes, and
   * every query on {@link WRITING_SQL} then leaves it out, the write and the undo included.
   * A compare-and-set on the checksum the owner saw: a change since then refuses, so two views
   * cannot deselect against different states. Not on the undo of an atomic run, which restores
   * all of its targets or none. The caller is the owner-only route; nothing model-facing reaches it.
   */
  deselectTarget(runId: string, seq: number, params: { checksum: string; now?: number | undefined }): BulkSelectOutcome {
    return this.setSelected(runId, seq, false, params);
  }

  /** Put a deselected target back into the run; see {@link deselectTarget}. */
  reselectTarget(runId: string, seq: number, params: { checksum: string; now?: number | undefined }): BulkSelectOutcome {
    return this.setSelected(runId, seq, true, params);
  }

  private setSelected(runId: string, seq: number, selected: boolean, params: { checksum: string; now?: number | undefined }): BulkSelectOutcome {
    const db = this.engineDb.getDb();
    return db.transaction((): BulkSelectOutcome => {
      const run = this.runRow(runId);
      if (!run) return { ok: false, reason: 'not_found' };
      if (run.phase !== 'previewed') return { ok: false, reason: 'wrong_phase' };
      if (run.kind === 'undo' && run.atomic === 1) return { ok: false, reason: 'atomic_undo' };
      if (params.checksum !== this.computeChecksum(runId)) return { ok: false, reason: 'checksum' };
      const at = new Date(params.now ?? Date.now()).toISOString();
      const moved = selected
        ? db.prepare(`UPDATE bulk_targets SET deselected_at = NULL WHERE run_id = ? AND seq = ? AND change IN ${WRITING_CHANGES} AND deselected_at IS NOT NULL`).run(runId, seq)
        : db.prepare(`UPDATE bulk_targets SET deselected_at = ? WHERE run_id = ? AND seq = ? AND ${WRITING_SQL}`).run(at, runId, seq);
      if (moved.changes !== 1) return { ok: false, reason: 'not_writing' };
      return { ok: true, checksum: this.computeChecksum(runId)! };
    }).immediate();
  }

  /**
   * Approve a previewed run (PRD §3.4): phase `approved`, the checksum the approver was
   * shown, a target cap and an expiry, and — in the same transaction — the trigger whose
   * effect writes it, due at once. The caller is the human-facing route; nothing
   * model-facing reaches this.
   */
  approve(runId: string, params: {
    checksum: string;
    approvedBy?: string | undefined;
    maxTargets?: number | undefined;
    /** The approver's explicit confirmation that the run writes an unmeasured form. */
    unmeasuredConfirmed?: boolean | undefined;
    now?: number | undefined;
  }): { ok: true; status: BulkRunStatus; triggerId: string }
    | { ok: false; reason: 'not_found' | 'wrong_phase' | 'checksum' | 'nothing_to_apply' | 'bad_max_targets' | 'probe_required' | 'unmeasured_unconfirmed' | 'mail_api' | 'shopify_off' | UndoRefusal } {
    const run = this.runRow(runId);
    if (!run) return { ok: false, reason: 'not_found' };
    if (run.phase !== 'previewed' || run.list_state === 'pending') return { ok: false, reason: 'wrong_phase' };
    if (this.isShopifyRunSwitchedOff(run)) return { ok: false, reason: 'shopify_off' };
    if (contractWritesMail(run.target_system, run.contract_json)) return { ok: false, reason: 'mail_api' };
    if (params.checksum !== this.computeChecksum(runId)) return { ok: false, reason: 'checksum' };
    // An undo restores what its source wrote; the source's approver already confirmed the form.
    if (run.kind === 'apply' && this.writeFormOfRun(run) === 'unmeasured' && params.unmeasuredConfirmed !== true) {
      return { ok: false, reason: 'unmeasured_unconfirmed' };
    }
    const writing = this.countWriting(runId);
    if (writing === 0) return { ok: false, reason: 'nothing_to_apply' };
    const maxTargets = params.maxTargets ?? writing;
    if (!Number.isInteger(maxTargets) || maxTargets < 1 || maxTargets > writing) return { ok: false, reason: 'bad_max_targets' };
    if (maxTargets > 1 && !this.probeHolds(run)) return { ok: false, reason: 'probe_required' };
    // An atomic run capped below its size could only ever stop half written.
    if (run.atomic === 1 && maxTargets !== writing) return { ok: false, reason: 'bad_max_targets' };
    const now = params.now ?? Date.now();
    const db = this.engineDb.getDb();
    let triggerId = '';
    const moved = db.transaction((): UndoRefusal | boolean => {
      // In the same transaction as the arming, and an IMMEDIATE one: it takes the write lock
      // before the check, so an approve or resume of another run of the family in another
      // process waits for this one and then sees it, instead of checking a state this one is
      // about to change. (A deferred transaction would let both check, and fail the one that
      // checked first and writes last with SQLITE_BUSY_SNAPSHOT instead of a refusal.)
      const blocked = this.writeBlocked(run);
      if (blocked !== null) return blocked;
      const res = db.prepare(
        `UPDATE bulk_runs SET phase = 'approved', approved_by = ?, approved_at = ?, approval_checksum = ?,
           max_targets = ?, expires_at = ?, halt_reason = NULL
         WHERE id = ? AND phase = 'previewed'`,
      ).run(params.approvedBy ?? null, new Date(now).toISOString(), params.checksum, maxTargets,
        this.approvalWindow(writing, now), runId);
      if (res.changes !== 1) return false;
      // An external run's preview is over once it is approved; its trigger must not fire
      // again into a run that is no longer planned.
      new TriggerStore(this.engineDb).remove(bulkPreviewTriggerId(runId));
      triggerId = this.armTrigger(run, now);
      return true;
    }).immediate();
    if (typeof moved === 'string') return { ok: false, reason: moved };
    if (!moved) return { ok: false, reason: 'wrong_phase' };
    return { ok: true, status: this.getStatus(runId)!, triggerId };
  }

  /**
   * Resume an approved run that stopped (a halt, an expired window, a loop that died):
   * a fresh human confirmation of the same approval. The checksum must still match the
   * one approved; the window restarts, the halt clears, failed and conflicting targets
   * are retried, and the trigger is due again.
   */
  resume(runId: string, params: { checksum: string; maxTargets?: number | undefined; now?: number | undefined }):
    { ok: true; status: BulkRunStatus; triggerId: string }
    | { ok: false; reason: 'not_found' | 'wrong_phase' | 'checksum' | 'bad_max_targets' | 'probe_required' | 'mail_api' | 'shopify_off' | UndoRefusal } {
    const run = this.runRow(runId);
    if (!run) return { ok: false, reason: 'not_found' };
    if (run.phase !== 'approved' && run.phase !== 'writing') return { ok: false, reason: 'wrong_phase' };
    if (this.isShopifyRunSwitchedOff(run)) return { ok: false, reason: 'shopify_off' };
    if (contractWritesMail(run.target_system, run.contract_json)) return { ok: false, reason: 'mail_api' };
    if (params.checksum !== run.approval_checksum || params.checksum !== this.computeChecksum(runId)) {
      return { ok: false, reason: 'checksum' };
    }
    // A resume may widen the cap — after a confirmed probe, the way from one target to N.
    let maxTargets = run.max_targets;
    if (params.maxTargets !== undefined) {
      const writing = this.countWriting(runId);
      maxTargets = params.maxTargets;
      if (!Number.isInteger(maxTargets) || maxTargets < 1 || maxTargets > writing) return { ok: false, reason: 'bad_max_targets' };
      if (run.atomic === 1 && maxTargets !== writing) return { ok: false, reason: 'bad_max_targets' };
    }
    // Also when the cap stays: a run approved for more than one target under an earlier rule,
    // or before its probe stopped holding, must not go on wide.
    if ((maxTargets ?? this.countWriting(runId)) > 1 && !this.probeHolds(run)) return { ok: false, reason: 'probe_required' };
    const now = params.now ?? Date.now();
    const db = this.engineDb.getDb();
    let triggerId = '';
    const moved = db.transaction((): UndoRefusal | boolean => {
      const blocked = this.writeBlocked(run);
      if (blocked !== null) return blocked;
      const res = db.prepare(
        `UPDATE bulk_runs SET halt_reason = NULL, expires_at = ?, targets_failed = 0, max_targets = ?
         WHERE id = ? AND phase IN ('approved','writing')`,
      ).run(this.approvalWindow(this.countWriting(runId), now), maxTargets, runId);
      if (res.changes !== 1) return false;
      // Not a target that failed on what it would send (`secret`): that fails the same way every
      // time, so retrying it first would halt a small run again at the same place and the rest
      // would never be written. It stays failed; the resume carries on with the others.
      db.prepare(`UPDATE bulk_targets SET error = NULL, claimed_at = NULL WHERE run_id = ? AND applied_at IS NULL AND error IS NOT NULL AND error != 'secret'`)
        .run(runId);
      triggerId = this.armTrigger(run, now);
      return true;
    }).immediate();
    if (typeof moved === 'string') return { ok: false, reason: moved };
    if (!moved) return { ok: false, reason: 'wrong_phase' };
    return { ok: true, status: this.getStatus(runId)!, triggerId };
  }

  /**
   * Why a run may not be approved or resumed now, or null. A run, its undos, their undos and
   * so on — one family, linked by `source_run_id` — write the same targets in opposite
   * directions, so no run is started while another of its family may write:
   *  - an undo waits while its source may write (`source_running`), any run while another
   *    run of its family may (`undo_open`);
   *  - an undo whose plan misses a target its source has applied since the planning would
   *    finish, report the source undone, and leave that target written (`undo_stale`). An undo
   *    of a source already undone is refused the same way: there is nothing left for it in the
   *    source's rows, and taking back what an undo of the later undo wrote again is that undo's
   *    job. (A source only partly taken back by another undo is not refused: each target is
   *    still checked against the state the source wrote, so nothing is overwritten unseen.)
   *
   * "May write" means approved or writing and NOT halted. Two states are left out
   * on purpose, and each would look like a gap to a reader who does not know why:
   *  - A previewed undo holds nothing. No route discards a previewed run and the prune takes
   *    only apply runs (and, planned by anyone but the owner, only that planner's own), so an
   *    undo that is never approved would hold its source for good.
   *    The window it leaves closes at its approval: this check runs there, and `undo_stale`
   *    refuses a plan the source has written past.
   *  - A halted undo holds nothing either, for the same reason: it may never be resumed (an
   *    expired window, a checksum halt), and nothing withdraws it. When it is resumed, this
   *    check runs again.
   *
   * A guard whose precondition fails together with the thing it guards against would hold the
   * family still for good after a crash — a live claim left by a dead loop, say. So it reads
   * only states a human can move on (approve, resume), never one only a lost process could.
   *
   * What it does not cover: a second loop on the same run. The product runs one loop per run
   * (one trigger, and a lease across engine processes); a second one exists only when two
   * engines share one data directory, and a halt set by one loop does not stop the other's
   * write in flight.
   */
  private writeBlocked(run: RunRow): UndoRefusal | null {
    const open = this.openInFamily(run.id, run.id);
    if (open !== null) return open === run.source_run_id ? 'source_running' : 'undo_open';
    if (run.kind !== 'undo' || run.source_run_id === null) return null;
    const src = this.runRow(run.source_run_id);
    if (!src) return null;
    if (src.phase === 'undone') return 'undo_stale';
    const missing = this.engineDb.getDb().prepare(
      `SELECT COUNT(*) AS n FROM bulk_targets WHERE run_id = ? AND ${undoEligible(externalHostOf(src.target_system) !== null)}
         AND seq NOT IN (SELECT source_seq FROM bulk_targets WHERE run_id = ? AND source_seq IS NOT NULL)`,
    ).get(src.id, run.id) as { n: number };
    return missing.n > 0 ? 'undo_stale' : null;
  }

  /**
   * A run of `runId`'s family, other than `exceptRunId`, that is approved or writing and not
   * halted — its id, or null. The family is every run reached from the first one of the chain
   * (followed up by `source_run_id`) by following `source_run_id` down.
   */
  private openInFamily(runId: string, exceptRunId: string | null): string | null {
    let root = runId;
    const seen = new Set<string>();
    for (;;) {
      seen.add(root);
      const up = this.runRow(root)?.source_run_id ?? null;
      if (up === null || seen.has(up)) break;
      root = up;
    }
    const row = this.engineDb.getDb().prepare(OPEN_IN_FAMILY_SQL).get(root, exceptRunId) as { id: string } | undefined;
    return row?.id ?? null;
  }

  /**
   * Plan the undo of a run (PRD §3.5): a NEW run, previewed, over the targets the source
   * applied and nobody took back since — for an external run also those whose write failed,
   * see {@link undoEligible} — in reverse order. Each undo target expects the
   * state the source wrote and writes the source's before-image back — or removes what
   * the source created. It is approved like any run (a second approval), and its effect
   * finds a target someone else changed in between by that expectation: a conflict,
   * shown, not overwritten. An undo of an undo is the same mechanism.
   */
  planUndo(sourceRunId: string, params: { createdBy?: string | undefined } = {}):
    { ok: true; status: BulkRunStatus } | { ok: false; reason: 'not_found' | 'not_undoable' | 'nothing_to_undo' | 'atomic_partial' | 'undo_open' | 'mail_api' } {
    const src = this.runRow(sourceRunId);
    if (!src) return { ok: false, reason: 'not_found' };
    // An undo writes the same host and paths under the same contract, so it could never be
    // approved; refuse it here rather than leave a run that only waits.
    if (contractWritesMail(src.target_system, src.contract_json)) return { ok: false, reason: 'mail_api' };
    if (!isStopped(src)) return { ok: false, reason: 'not_undoable' };
    // An undo beside another run of the family that may write would write the same targets.
    if (this.openInFamily(sourceRunId, null) !== null) return { ok: false, reason: 'undo_open' };
    const db = this.engineDb.getDb();
    if (src.atomic === 1) {
      // Form B's rule (PRD §2.2): an atomic run is taken back whole or not at all.
      const partial = db.prepare(
        `SELECT COUNT(*) AS n FROM bulk_targets WHERE run_id = ? AND ${WRITING_SQL}
           AND (applied_at IS NULL OR undone_at IS NOT NULL)`,
      ).get(sourceRunId) as { n: number };
      if (src.phase !== 'done' || partial.n > 0) return { ok: false, reason: 'atomic_partial' };
    }
    const external = externalHostOf(src.target_system) !== null;
    const rows = db.prepare(
      `SELECT seq, target_key, change, before, after_planned, after_actual,
         read_connection_id, read_grant_id, write_connection_id, write_grant_id FROM bulk_targets
       WHERE run_id = ? AND ${undoEligible(external)}
       ORDER BY seq DESC`,
    ).all(sourceRunId) as ({ seq: number; target_key: string; change: BulkChange; before: string | null; after_planned: string | null; after_actual: string | null } & ConnectionColumns)[];
    if (rows.length === 0) return { ok: false, reason: 'nothing_to_undo' };

    const htmlFields = this.htmlFieldsOf(sourceRunId);
    const planned = rows.map((r) => {
      const t = this.toApplyTarget({ ...r, source_seq: null });
      // An external target is expected to hold what the host kept of the write, read back
      // after it — not what was sent (build plan B §2.4). Local targets hold what was sent.
      const actual = r.after_actual === null ? null : JSON.parse(this.engineDb.dec(r.after_actual)) as ActualImage;
      const expected: BeforeImage = actual === null ? t.after : { absent: false, value: actual.value };
      // An external undo sends, per target, only fields its source sent there: the probe its
      // source wrote under (or, for an undo, none at all — `probeHolds`) tells what the verb does
      // to fields a write leaves out, and that carries over only to the same set of fields.
      const after = external ? onlySentFields(t.expected, t.after) : t.expected;
      const change: ApplyTarget['change'] = after.absent ? 'delete' : expected.absent ? 'create' : 'update';
      // Both images an undo target holds come from its source: what the source read before it
      // wrote (the undo's after-state) and what the write left (its before-image). So its read
      // side is the source's two sides merged; its own write records itself when it is sent.
      // An external target's side is recorded whenever a request was sent for it, so a side left
      // NULL there is one from before v43: unknown, not absent. Merged with a recorded side it
      // leaves the grant unknown rather than letting the other side name it.
      const sides = [connectionOf(r.read_connection_id, r.read_grant_id), connectionOf(r.write_connection_id, r.write_grant_id)];
      const merged = mergeConnections(sides);
      const read = external && merged !== null && sides.includes(null) ? { id: merged.id, grantId: null } : merged;
      // Condition (b): a value the store kept with markup the run never sent was never the
      // owner's state, so it is not written back — wherever down the family it comes from.
      const tainted = htmlFields.length > 0 && !after.absent && this.restoresShopAddedMarkup(sourceRunId, r.seq, after.value, htmlFields);
      return { key: t.key, sourceSeq: r.seq, expected, after, change, read, tainted };
    });
    const id = randomUUID();
    const undoKinds = new Set(planned.map((t) => undoFor(t.expected)));
    const runUndo: UndoKind | 'mixed' = undoKinds.size === 1 ? [...undoKinds][0]! : 'mixed';
    function* hashParts(): Generator<string> {
      yield 'undo';
      yield sourceRunId;
      for (const t of planned) { yield String(t.sourceSeq); yield t.key; }
    }
    const insertTarget = db.prepare(
      `INSERT INTO bulk_targets (run_id, seq, target_key, change, undo, before, after_planned, source_seq, read_connection_id, read_grant_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertInvalid = db.prepare(
      `INSERT INTO bulk_targets (run_id, seq, target_key, change, source_seq, error) VALUES (?, ?, ?, 'invalid', ?, ?)`,
    );
    db.transaction(() => {
      // An undo reads and writes what its source did: it is contained wherever its source is,
      // before its row, in the same transaction (`containment.ts`).
      containRunFromRun(db, sourceRunId, id);
      // The undo writes the same host and paths as its source, under the same contract.
      db.prepare(
        `INSERT INTO bulk_runs (id, created_by, rule_hash, target_system, undo, phase, targets_total, atomic, kind,
           source_run_id, target_collection, contract_json, principal, mandate_id)
         VALUES (?, ?, ?, ?, ?, 'previewed', ?, ?, 'undo', ?, ?, ?, ?, ?)`,
      ).run(id, params.createdBy ?? null, this.engineDb.keyedHash(hashParts()), src.target_system, runUndo,
        // Only the owner's route plans an undo (§3.13 E6), so the undo is the owner's.
        planned.length, src.atomic, sourceRunId, src.target_collection, src.contract_json, ...planner(OWNER_PRINCIPAL));
      planned.forEach((t, seq) => {
        if (t.tainted) {
          insertInvalid.run(id, seq, this.engineDb.enc(t.key), t.sourceSeq, 'shop_added_markup' satisfies BulkInvalidReason);
          return;
        }
        insertTarget.run(
          id, seq, this.engineDb.enc(t.key), t.change, undoFor(t.expected),
          this.engineDb.enc(JSON.stringify(t.expected)),
          t.after.absent ? null : this.engineDb.enc(JSON.stringify(t.after.value ?? null)),
          t.sourceSeq,
          t.read?.id ?? null, t.read?.grantId ?? null,
        );
      });
      // An undo is the owner's: the owner's rule, over all planners.
      this.pruneUnapproved(OWNER_PRINCIPAL);
    })();
    return { ok: true, status: this.getStatus(id)! };
  }

  /**
   * Whether an undo's after-state for one target restores, in an HTML field, a value that a write of
   * this family read back with markup it never sent (`shop_added_markup`). The after-state is the
   * undone target's before-image, which for an undo is its own source's `actual`: the chain is read
   * from there up through `source_run_id` and `source_seq`, whole (N3) — an intermediate undo whose
   * read-back held the same markup, sent by it and so unmarked, would otherwise launder it. The
   * undone target's own mark is not read: its `actual` is not what the undo writes, and its
   * before-image may hold the same markup from before the run, which restoring is.
   * Compared under `htmlEqual`, the strict direction: a reformatted copy of the value still counts.
   */
  private restoresShopAddedMarkup(runId: string, seq: number, after: unknown, htmlFields: readonly string[]): boolean {
    if (after === null || typeof after !== 'object') return false;
    const restored = after as Record<string, unknown>;
    const step = this.engineDb.getDb().prepare(
      `SELECT t.after_actual, t.shop_added_markup, t.source_seq, r.source_run_id FROM bulk_targets t
         JOIN bulk_runs r ON r.id = t.run_id WHERE t.run_id = ? AND t.seq = ?`,
    );
    let at: { runId: string; seq: number } | null = { runId, seq };
    // Bounded like `listFormOfFamily`: one run per undo, and a cycle must not hang the planner. A
    // chain the walk cannot finish — past the bound, or broken — counts as restoring the mark: the
    // safe direction, since the value's origin is then not known.
    for (let depth = 0; at !== null; depth++) {
      if (depth > 64) return true;
      const row = step.get(at.runId, at.seq) as { after_actual: string | null; shop_added_markup: number; source_seq: number | null; source_run_id: string | null } | undefined;
      if (!row) return true;
      if (depth > 0 && row.shop_added_markup === 1 && row.after_actual !== null) {
        const kept = (JSON.parse(this.engineDb.dec(row.after_actual)) as ActualImage).value;
        if (kept !== null && typeof kept === 'object') {
          const held = kept as Record<string, unknown>;
          if (htmlFields.some((f) => {
            const a = restored[f];
            const k = held[f];
            return typeof a === 'string' && typeof k === 'string' && htmlEqual(a, k);
          })) return true;
        }
      }
      at = row.source_run_id === null || row.source_seq === null ? null : { runId: row.source_run_id, seq: row.source_seq };
    }
    return false;
  }

  // ── The preview effect's reads and writes (bulk-preview.ts) ─────────────────

  getRunForPreview(runId: string): BulkRunForPreview | null {
    const r = this.runRow(runId);
    if (!r) return null;
    return { id: r.id, kind: r.kind, targetSystem: r.target_system, phase: r.phase, haltReason: r.halt_reason, contractJson: r.contract_json, delegatedPlanner: delegatedPlannerOf(r) };
  }

  /** Targets the preview has still to read, in seq order. A target read before — by an
   *  earlier tick, or another loop — is not read again (plan §6 Q7). */
  listUnread(runId: string): number[] {
    // A target whose read failed once comes last, so it cannot hold up the others.
    return (this.engineDb.getDb().prepare(
      `SELECT seq FROM bulk_targets WHERE run_id = ? AND change != 'invalid' AND before IS NULL
       ORDER BY error IS NOT NULL, seq`,
    ).all(runId) as { seq: number }[]).map((r) => r.seq);
  }

  /** The keys of a run's targets that are not invalid, in seq order: what a Shopify run's read
   *  grant is minted for on each tick (`bulk-shopify.ts`), from this table and nothing else. */
  externalTargetKeys(runId: string): string[] {
    return (this.engineDb.getDb().prepare(
      `SELECT target_key FROM bulk_targets WHERE run_id = ? AND change != 'invalid' ORDER BY seq`,
    ).all(runId) as { target_key: string }[]).map((r) => this.engineDb.dec(r.target_key));
  }

  /**
   * What an approved Shopify run's apply may send, from this run's rows and nothing else: its form,
   * the read of each writing target, and the write of the after-state each holds
   * (`withShopifyApply`). Null for a run that is not a Shopify run — one whose target system is not
   * a store host, or one with a writing target whose GID is not of its form's type (a product's, or
   * an image's). An undo's rows hold the source's before-images as their after-states, and its
   * form is its source's, so the same holds for it.
   */
  shopifyApplyOf(runId: string): { form: ShopifyWriteForm; reads: string[]; writes: ShopifyWrite[] } | null {
    const run = this.runRow(runId);
    const host = run === undefined ? null : externalHostOf(run.target_system);
    if (run === undefined || host === null || !isShopifyStoreHostName(host)) return null;
    const form = this.shopifyFormOfFamily(run);
    const gidNumber = form === 'shopify_media_alt' ? mediaImageGidNumber : productGidNumber;
    const rows = this.engineDb.getDb().prepare(
      `SELECT seq, target_key, change, before, after_planned, source_seq FROM bulk_targets WHERE run_id = ? AND ${WRITING_SQL} ORDER BY seq`,
    ).all(runId) as { seq: number; target_key: string; change: BulkChange; before: string | null; after_planned: string | null; source_seq: number | null }[];
    // `descriptionHtml` always on the product form, whatever list form is found (fail-closed).
    const html = form === 'shopify_product' ? [...new Set([...this.htmlFieldsOf(runId), 'descriptionHtml'])] : [];
    const reads: string[] = [];
    const writes: ShopifyWrite[] = [];
    for (const r of rows) {
      const key = this.engineDb.dec(r.target_key);
      if (gidNumber(key) === null) return null;
      reads.push(key);
      if (r.change === 'update' && r.after_planned !== null) {
        const after = JSON.parse(this.engineDb.dec(r.after_planned)) as Record<string, unknown>;
        // Left out, not refused: no grant is minted for it, so its request is refused before it is
        // sent and the apply halts (`contract`). Nothing else changes here — this is also what the
        // approve and resume routes ask whether a run is a Shopify run.
        if (html.length > 0 && !this.mintsHtml(run, r, after, html, host)) continue;
        writes.push({ form, gid: key, after });
      }
    }
    return { form, reads, writes };
  }

  /**
   * The markup check once more before a Shopify product write is minted (PRD shopify-preset §21.2
   * item 3): where the run's list form names the field HTML, the preview or the settle step passed
   * the same check on the same two values, so a failure here means the ledger changed after that,
   * the call sites disagree, or the rule changed in an engine upgrade. A product run whose list form
   * is not found still has `descriptionHtml` checked here as HTML ({@link htmlFieldsOf}, fail-closed),
   * so it may leave out a write the preview passed as text: the run halts, it never writes more.
   * A field the after-state leaves as its before-image is not checked, as at
   * the settle step. An undo is not checked against the rule: its after-state is its source's
   * before-image, which the rule would read as added. In its place each HTML field must be that
   * before-image byte for byte — the ledger checked against itself, not a security bound.
   */
  private mintsHtml(
    run: RunRow, row: { before: string | null; source_seq: number | null }, after: Record<string, unknown>,
    html: readonly string[], host: string,
  ): boolean {
    const fields = html.filter((f) => Object.hasOwn(after, f));
    if (fields.length === 0) return true;
    if (run.kind === 'undo') {
      if (run.source_run_id === null || row.source_seq === null) return false;
      const src = this.engineDb.getDb().prepare('SELECT before FROM bulk_targets WHERE run_id = ? AND seq = ?')
        .get(run.source_run_id, row.source_seq) as { before: string | null } | undefined;
      if (!src || src.before === null) return false;
      const image = JSON.parse(this.engineDb.dec(src.before)) as BeforeImage;
      if (image.absent || image.value === null || typeof image.value !== 'object') return false;
      const held = image.value as Record<string, unknown>;
      return fields.every((f) => Object.hasOwn(held, f) && canonicalJson(held[f]) === canonicalJson(after[f]));
    }
    const image = row.before === null ? null : JSON.parse(this.engineDb.dec(row.before)) as BeforeImage;
    const prior = image === null || image.absent || image.value === null || typeof image.value !== 'object'
      ? {} : image.value as Record<string, unknown>;
    const startDomains = this.startDomainsOfRow(run) ?? [];
    return fields.every((f) => {
      const value = after[f];
      const was = prior[f];
      if (value === was) return true;
      // Canonical bytes: the parser drops what it cannot place (a `<body onload>`), so a value the
      // check passes must also be the bytes it reads.
      if (typeof value !== 'string' || canonicalHtml(value) !== value) return false;
      return checkMarkup({ before: typeof was === 'string' ? was : null, after: value, storeHost: host, startDomains }).ok;
    });
  }

  /** An unread external target: its URL and planned after-state. */
  loadExternalTarget(runId: string, seq: number): { key: string; after: ExternalImage } | null {
    const r = this.engineDb.getDb().prepare(
      `SELECT target_key, after_planned FROM bulk_targets WHERE run_id = ? AND seq = ? AND change != 'invalid' AND before IS NULL`,
    ).get(runId, seq) as { target_key: string; after_planned: string | null } | undefined;
    if (!r || r.after_planned === null) return null;
    return { key: this.engineDb.dec(r.target_key), after: JSON.parse(this.engineDb.dec(r.after_planned)) as ExternalImage };
  }

  /**
   * Record what the preview read for one target: its before-image over F and the change
   * that follows, or why it cannot be planned. Only while the run is still `planned` and
   * the target unread, so a run that was dropped, or a target another loop read, is not
   * written twice.
   */
  recordRead(
    runId: string, seq: number, read: { before: Record<string, unknown> } | { invalid: BulkInvalidReason },
    /** The connection the before-image was read under; recorded with the image, never without it. */
    via: AttachedConnection | null = null,
    /** The after-state the read completed (a Shopify target's seo pair): stored with the image, in one transaction, and classified against. */
    completedAfter?: Readonly<Record<string, unknown>>,
  ): boolean {
    const db = this.engineDb.getDb();
    const guard = `run_id = ? AND seq = ? AND change != 'invalid' AND before IS NULL
      AND EXISTS (SELECT 1 FROM bulk_runs WHERE id = ? AND phase = 'planned' AND halt_reason IS NULL)`;
    if ('invalid' in read) {
      return db.prepare(`UPDATE bulk_targets SET change = 'invalid', undo = NULL, error = ? WHERE ${guard}`)
        .run(read.invalid, runId, seq, runId).changes === 1;
    }
    const row = db.prepare('SELECT after_planned FROM bulk_targets WHERE run_id = ? AND seq = ?').get(runId, seq) as { after_planned: string | null } | undefined;
    if (!row || row.after_planned === null) return false;
    const before: BeforeImage = { absent: false, value: read.before };
    const after = completedAfter ?? JSON.parse(this.engineDb.dec(row.after_planned)) as unknown;
    // The before-image holds exactly F, so comparing whole images compares over F (§6 P4). A
    // judged target's after-state is its template until the verdict: its change is not known.
    const change = (this.runRow(runId)?.judge_rule ?? null) !== null ? 'update' : classifyChange(before, after, this.comparedAsHtml(runId));
    return db.transaction((): boolean => {
      const stored = db.prepare(`UPDATE bulk_targets SET before = ?, change = ?, error = NULL, after_planned = ? WHERE ${guard}`)
        .run(this.engineDb.enc(JSON.stringify(before)), change, this.engineDb.enc(JSON.stringify(after)), runId, seq, runId).changes === 1;
      if (stored) this.noteConnection(runId, seq, 'read', via);
      return stored;
    })();
  }

  /**
   * Merge `via` into a target's `read_*` or `write_*` pair, as {@link mergeConnections} merges
   * the requests of one stage: the first connection recorded sets both; a later one keeps the
   * grant only when it carries that same grant under that same id, and otherwise leaves it NULL
   * for good. A NULL grant is never filled in afterwards: a target that held data of two grants
   * does not come to name one of them. Also the run's summary, once: its first connection.
   * Nothing for `via === null` (a local target, or a stage that sent nothing).
   */
  private noteConnection(runId: string, seq: number, side: 'read' | 'write', via: AttachedConnection | null): void {
    if (via === null) return;
    const db = this.engineDb.getDb();
    const id = side === 'read' ? 'read_connection_id' : 'write_connection_id';
    const grant = side === 'read' ? 'read_grant_id' : 'write_grant_id';
    // Every right-hand side reads the row as it was before this statement (SQLite). A write side
    // first recorded on a target already marked sent: that earlier write left before v43 recorded
    // anything (`markSent` notes before it marks), under a grant nobody knows, so the grant stays
    // unknown rather than becoming this one.
    const unrecordedSend = side === 'write' ? 'write_sent = 1' : '0';
    db.prepare(
      `UPDATE bulk_targets SET ${id} = COALESCE(${id}, ?),
         ${grant} = CASE WHEN ${id} IS NULL THEN (CASE WHEN ${unrecordedSend} THEN NULL ELSE ? END)
           WHEN ${id} = ? AND ${grant} IS ? THEN ${grant} ELSE NULL END
       WHERE run_id = ? AND seq = ?`,
    ).run(via.id, via.grantId, via.id, via.grantId, runId, seq);
    db.prepare('UPDATE bulk_runs SET first_connection_id = ?, first_grant_id = ? WHERE id = ? AND first_connection_id IS NULL')
      .run(via.id, via.grantId, runId);
  }

  /**
   * A read that failed on the host's side (5xx, a timeout, a broken connection). The first
   * leaves the target unread, marked, to be read again after the others; the second makes
   * it `invalid` (`read_failed`). Returns what it did, or null when the run or target has
   * moved on.
   */
  recordReadFailure(runId: string, seq: number): 'retry' | 'invalid' | null {
    const db = this.engineDb.getDb();
    return db.transaction((): 'retry' | 'invalid' | null => {
      const row = db.prepare(
        `SELECT error FROM bulk_targets WHERE run_id = ? AND seq = ? AND change != 'invalid' AND before IS NULL
           AND EXISTS (SELECT 1 FROM bulk_runs WHERE id = ? AND phase = 'planned' AND halt_reason IS NULL)`,
      ).get(runId, seq, runId) as { error: string | null } | undefined;
      if (!row) return null;
      if (row.error === null) {
        db.prepare(`UPDATE bulk_targets SET error = 'read_failed' WHERE run_id = ? AND seq = ?`).run(runId, seq);
        return 'retry';
      }
      db.prepare(`UPDATE bulk_targets SET change = 'invalid', undo = NULL, error = 'read_failed' WHERE run_id = ? AND seq = ?`).run(runId, seq);
      return 'invalid';
    })();
  }

  /** Halt a preview that is still reading, keeping a reason already set. */
  haltPreview(runId: string, reason: BulkHaltReason): void {
    this.engineDb.getDb().prepare(
      `UPDATE bulk_runs SET halt_reason = ? WHERE id = ? AND phase = 'planned' AND halt_reason IS NULL`,
    ).run(reason, runId);
  }

  /**
   * Close a preview: `planned` → `previewed`, and only when every target that is not
   * invalid holds a before-image (plan §6 Q4). A run approved with a target it never read
   * would compare that target against nothing. False when the run is not ready.
   */
  finishPreview(runId: string): boolean {
    const db = this.engineDb.getDb();
    return db.transaction((): boolean => {
      const unread = db.prepare(
        `SELECT COUNT(*) AS n FROM bulk_targets WHERE run_id = ? AND change != 'invalid' AND before IS NULL`,
      ).get(runId) as { n: number };
      if (unread.n > 0) return false;
      const valid = db.prepare(`SELECT COUNT(*) AS n FROM bulk_targets WHERE run_id = ? AND change != 'invalid'`).get(runId) as { n: number };
      return db.prepare(
        // A run whose list is still being read has none of its targets yet: an empty unread set
        // says nothing about it.
        // A judged run is previewed by its verdicts (`finishJudge`), not by its reads.
        `UPDATE bulk_runs SET phase = 'previewed', undo = ? WHERE id = ? AND phase = 'planned' AND halt_reason IS NULL
           AND (list_state IS NULL OR list_state = 'done') AND judge_rule IS NULL`,
      ).run(valid.n > 0 ? 'restorable' : 'none', runId).changes === 1;
    })();
  }

  /** The link domains the owner allowed at the start; empty where none were given. */
  startDomainsOf(runId: string): string[] {
    const run = this.runRow(runId);
    return run ? this.startDomainsOfRow(run) ?? [] : [];
  }

  private startDomainsOfRow(row: Pick<RunRow, 'start_domains'>): string[] | null {
    return row.start_domains === null ? null : JSON.parse(this.engineDb.dec(row.start_domains)) as string[];
  }

  /**
   * Start a planned run's read, or start it again after a halt (plan §6 Q5): the owner's
   * route clears the halt — the start gate included — and the preview trigger is due at
   * once. Targets already read stay read.
   *
   * A judged run (PRD bulk-loop §3.1) is started with the hash of the rule the owner was
   * shown and a spend limit in whole cents, and arms `bulk_judge`. A list's first start reads
   * only the list and takes neither: a list can end empty, and an empty run must not have
   * replaced anything. Starting a judged run ends the instance's other started, unapproved judged
   * run — only when the start names it (`supersedes`), so nothing paid is replaced silently.
   */
  resumePreview(runId: string, now: number = Date.now(), opts: {
    listChecksum?: string | undefined;
    judgeRuleHash?: string | undefined;
    costCapUsd?: number | undefined;
    supersedes?: string | undefined;
    /** The link domains the owner allows a judged list run's verdicts to add, besides the
     *  store's own (PRD shopify-preset §20.2 item 5, S20-4). Taken only by the start that begins
     *  the judge on a list, and written in the transaction that starts it, so a start refused
     *  anywhere leaves none behind. Left out before the judge first started, the run has none;
     *  from then on the list is frozen: the same one, or none given, passes. */
    startDomains?: unknown;
  } = {}):
    { ok: true; status: BulkRunStatus; triggerId: string }
    | { ok: false; reason: 'not_found' | 'wrong_phase' | 'external_in_progress' | 'checksum' | 'cost_cap' | 'not_at_this_start' | 'start_domains_not_here' | 'start_domains_invalid' | 'start_domains_frozen' }
    | { ok: false; reason: 'supersede_required'; supersedable: { id: string; costUsd: number } }
    | { ok: false; reason: 'rule_refused'; message: string } {
    // A run left reading with no trigger is halted first, so the owner can start it again.
    this.freeDeadReads(runId);
    const run = this.runRow(runId);
    if (!run) return { ok: false, reason: 'not_found' };
    if (run.phase !== 'planned' || run.halt_reason === null) return { ok: false, reason: 'wrong_phase' };
    const listPending = run.list_state === 'pending';
    // Starting a list read sends requests with the host's credential to an address the planner
    // chose: the owner presents the checksum of the list they were shown (PRD bulk-loop §3.2).
    if (listPending && (opts.listChecksum === undefined || opts.listChecksum !== this.listStartChecksum(runId))) {
      return { ok: false, reason: 'checksum' };
    }
    const judging = run.judge_rule !== null && !listPending;
    if (run.judge_rule !== null && listPending && (opts.costCapUsd !== undefined || opts.supersedes !== undefined)) {
      return { ok: false, reason: 'not_at_this_start' };
    }
    // Only where a judge starts on a list: a run without a judge writes its one planned
    // after-state, shown in full; only a list form declares HTML fields; and a list's first
    // start reads the list only, like the cost cap.
    const listJudging = judging && run.list_source !== null;
    let startList: string[] | null = null;
    if (opts.startDomains !== undefined) {
      if (!listJudging) return { ok: false, reason: 'start_domains_not_here' };
      startList = normalizeStartDomains(opts.startDomains);
      if (startList === null) return { ok: false, reason: 'start_domains_invalid' };
    }
    if (judging) {
      // The rule was checked when it was planned, by the checks of that day. A run planned before
      // a check was added waits with a rule the check would refuse, and the hash only says it is
      // unchanged: the start applies today's checks to what is stored.
      const refused = this.judgeRuleRefusal(run);
      if (refused !== null) return { ok: false, reason: 'rule_refused', message: refused };
      if (opts.judgeRuleHash === undefined || opts.judgeRuleHash !== run.judge_rule_hash) return { ok: false, reason: 'checksum' };
      if (opts.costCapUsd === undefined ? run.cost_cap_usd === null : !isWholeCents(opts.costCapUsd)) return { ok: false, reason: 'cost_cap' };
    }
    const db = this.engineDb.getDb();
    let triggerId = '';
    let supersedable: { id: string; costUsd: number } | null = null;
    const moved = db.transaction((): 'moved' | 'busy' | 'gone' | 'supersede' | 'frozen' => {
      // Frozen from the judge's first start or the first target read: decided before anything
      // here is written, so a refused list ends no other run.
      let frozen = false;
      if (listJudging) {
        const row = this.runRow(runId);
        if (!row) return 'gone';
        frozen = row.judge_started_at !== null || db.prepare(
          'SELECT 1 FROM bulk_targets WHERE run_id = ? AND before IS NOT NULL LIMIT 1',
        ).get(runId) !== undefined;
        if (frozen && startList !== null && JSON.stringify(this.startDomainsOfRow(row) ?? []) !== JSON.stringify(startList)) return 'frozen';
      }
      // The ordering rule is decided here, where a read starts — plans land halted, so
      // at plan time nothing is reading yet.
      this.haltDeadReads();
      const reading = db.prepare(
        `SELECT COUNT(*) AS n FROM bulk_runs WHERE phase = 'planned' AND halt_reason IS NULL
           AND target_system LIKE 'http:%' AND id != ?`,
      ).get(runId) as { n: number };
      if (run.target_system.startsWith('http:') && reading.n > 0) return 'busy';
      if (judging) {
        // At most one started, unapproved judged run per instance (PRD bulk-loop §3.1).
        const other = db.prepare(
          `SELECT id, cost_usd FROM bulk_runs WHERE judge_rule IS NOT NULL AND cost_cap_usd IS NOT NULL
             AND phase IN ('planned','previewed') AND id != ? ORDER BY created_at LIMIT 1`,
        ).get(runId) as { id: string; cost_usd: number } | undefined;
        if (other !== undefined) {
          if (opts.supersedes !== other.id) {
            supersedable = { id: other.id, costUsd: other.cost_usd };
            return 'supersede';
          }
          const ended = db.prepare(
            `UPDATE bulk_runs SET phase = 'aborted', halt_reason = ? WHERE id = ? AND phase IN ('planned','previewed')`,
          ).run(BULK_HALT_REASONS.superseded, other.id);
          // Its read phase's trigger goes with it: it would fire into an aborted run, maybe with a
          // paid call in flight.
          if (ended.changes === 1) new TriggerStore(this.engineDb).remove(bulkPreviewTriggerId(other.id));
        }
      }
      const res = db.prepare(
        `UPDATE bulk_runs SET halt_reason = NULL, cost_cap_usd = COALESCE(?, cost_cap_usd),
           judge_started_at = CASE WHEN ? = 1 THEN COALESCE(judge_started_at, ?) ELSE judge_started_at END
         WHERE id = ? AND phase = 'planned' AND halt_reason IS NOT NULL`,
      ).run(judging ? opts.costCapUsd ?? null : null, judging ? 1 : 0, new Date(now).toISOString(), runId);
      if (res.changes !== 1) return 'gone';
      if (listJudging && !frozen) {
        // The first judge start sets the list the run is approved with, or none.
        db.prepare('UPDATE bulk_runs SET start_domains = ? WHERE id = ?')
          .run(startList !== null && startList.length > 0 ? this.engineDb.enc(JSON.stringify(startList)) : null, runId);
      }
      triggerId = this.armPreviewTrigger(runId, now, judging ? 'bulk_judge' : 'bulk_preview');
      return 'moved';
    // IMMEDIATE: the write lock before the check, so two starts at once cannot both see no other
    // judged run and both start.
    }).immediate();
    if (moved === 'busy') return { ok: false, reason: 'external_in_progress' };
    if (moved === 'supersede') return { ok: false, reason: 'supersede_required', supersedable: supersedable! };
    if (moved === 'frozen') return { ok: false, reason: 'start_domains_frozen' };
    if (moved !== 'moved') return { ok: false, reason: 'wrong_phase' };
    return { ok: true, status: this.getStatus(runId)!, triggerId };
  }

  // ── The judge's reads and writes (bulk-judge.ts) ────────────────────────────

  /** A judged run as its judge reads it, or null. Not model-facing: it holds the rule. */
  getJudgeRun(runId: string): BulkJudgeRun | null {
    const r = this.runRow(runId);
    if (!r || r.judge_rule === null) return null;
    return {
      id: r.id, kind: r.kind, targetSystem: r.target_system, targetCollection: r.target_collection, phase: r.phase,
      haltReason: r.halt_reason, rule: this.judgeRuleOf(r), costUsd: r.cost_usd, costCapUsd: r.cost_cap_usd,
      listPending: r.list_state === 'pending',
      listForm: r.list_source === null ? null : (JSON.parse(this.engineDb.dec(r.list_source)) as BulkListSource).form,
      startDomains: this.startDomainsOfRow(r) ?? [],
    };
  }

  /** The rule of a judged run as its owner is shown it before the start, or null. Owner-only:
   *  the text and schema are the planner's words, the hash is what the start presents. */
  getJudgeRuleForOwner(runId: string): (JudgeRule & { hash: string }) | null {
    const r = this.runRow(runId);
    if (!r || r.judge_rule === null || r.judge_rule_hash === null) return null;
    return { ...this.judgeRuleOf(r), hash: r.judge_rule_hash };
  }

  /** Targets read and without a verdict, in seq order. */
  listUnjudged(runId: string): number[] {
    return (this.engineDb.getDb().prepare(
      `SELECT seq FROM bulk_targets WHERE run_id = ? AND change != 'invalid' AND before IS NOT NULL AND judged_at IS NULL ORDER BY seq`,
    ).all(runId) as { seq: number }[]).map((r) => r.seq);
  }

  /**
   * Take the claim on one target before its call is paid for: atomically, only when the target
   * has no verdict and no live claim, and only while the run is planned and not halted. A claim
   * older than `staleMs` belongs to a loop that died. Two loops after a lost lease thus pay for
   * a target at most once per expired claim (PRD bulk-loop §3.1).
   */
  claimJudge(runId: string, seq: number, token: string, now: number, staleMs: number): boolean {
    return this.engineDb.getDb().prepare(
      `UPDATE bulk_targets SET judge_claimed_at = ?, judge_claim_token = ?
       WHERE run_id = ? AND seq = ? AND change != 'invalid' AND before IS NOT NULL AND judged_at IS NULL
         AND (judge_claimed_at IS NULL OR judge_claimed_at < ?)
         AND EXISTS (SELECT 1 FROM bulk_runs WHERE id = ? AND phase = 'planned' AND halt_reason IS NULL)`,
    ).run(new Date(now).toISOString(), token, runId, seq, new Date(now - staleMs).toISOString(), runId).changes === 1;
  }

  /** Give a claim back, when the call ends without a verdict (a halt, a wait): the next tick
   *  tries the target again at once instead of after the claim expires. */
  releaseJudgeClaim(runId: string, seq: number, token: string): void {
    this.engineDb.getDb().prepare(
      `UPDATE bulk_targets SET judge_claimed_at = NULL, judge_claim_token = NULL
       WHERE run_id = ? AND seq = ? AND judge_claim_token = ? AND judged_at IS NULL`,
    ).run(runId, seq, token);
  }

  /** A target the judge is to decide: its key and before-image. */
  loadJudgeTarget(runId: string, seq: number): { key: string; before: BeforeImage } | null {
    const r = this.engineDb.getDb().prepare(
      `SELECT target_key, before FROM bulk_targets WHERE run_id = ? AND seq = ? AND change != 'invalid' AND before IS NOT NULL`,
    ).get(runId, seq) as { target_key: string; before: string } | undefined;
    if (!r) return null;
    return { key: this.engineDb.dec(r.target_key), before: JSON.parse(this.engineDb.dec(r.before)) as BeforeImage };
  }

  /** Book a paid call into the run's spend. No phase guard: what was paid stays counted,
   *  whether its verdict is recorded or not. */
  addJudgeCost(runId: string, usd: number): void {
    if (!Number.isFinite(usd) || usd <= 0) return;
    this.engineDb.getDb().prepare('UPDATE bulk_runs SET cost_usd = cost_usd + ? WHERE id = ?').run(usd, runId);
  }

  /**
   * Record one target's verdict — its after-state and the change that follows — or why it has
   * none. Only under the claim's own token (compare-and-set), only while the target has no
   * verdict, and only while the run is `planned`: a loop whose claim expired cannot overwrite
   * the verdict of the loop that took it over, and a verdict in flight does not write into a run
   * that was superseded (PRD bulk-loop §3.1).
   */
  recordJudgement(runId: string, seq: number, token: string, verdict: { after: unknown } | { invalid: BulkInvalidReason }, now: number = Date.now()): boolean {
    const db = this.engineDb.getDb();
    const guard = `run_id = ? AND seq = ? AND judge_claim_token = ? AND judged_at IS NULL AND change != 'invalid'
      AND EXISTS (SELECT 1 FROM bulk_runs WHERE id = ? AND phase = 'planned')`;
    const at = new Date(now).toISOString();
    return db.transaction((): boolean => {
      if ('invalid' in verdict) {
        return db.prepare(
          `UPDATE bulk_targets SET change = 'invalid', undo = NULL, error = ?, judged_at = ?, judge_claimed_at = NULL, judge_claim_token = NULL WHERE ${guard}`,
        ).run(verdict.invalid, at, runId, seq, token, runId).changes === 1;
      }
      const row = db.prepare('SELECT before FROM bulk_targets WHERE run_id = ? AND seq = ?').get(runId, seq) as { before: string | null } | undefined;
      if (!row || row.before === null) return false;
      const before = JSON.parse(this.engineDb.dec(row.before)) as BeforeImage;
      // A verdict on a Shopify run is completed as a planned after-state is (`shopifyPairedAfter`):
      // a write never sends one seo field without the other.
      const run = this.runRow(runId);
      const after = run !== undefined && this.shopifyFormOfRun(run) !== null && !before.absent && isPlainRecord(before.value) && isPlainRecord(verdict.after)
        ? shopifyPairedAfter(verdict.after, before.value)
        : verdict.after;
      return db.prepare(
        `UPDATE bulk_targets SET after_planned = ?, change = ?, error = NULL, judged_at = ?, judge_claimed_at = NULL, judge_claim_token = NULL WHERE ${guard}`,
      ).run(this.engineDb.enc(JSON.stringify(after)), classifyChange(before, after, this.comparedAsHtml(runId)), at, runId, seq, token, runId).changes === 1;
    })();
  }

  /**
   * Close a judged run: `planned` → `previewed` once every target is read and has a verdict, and
   * its `rule_hash` rewritten over the verdicts — what `approve` and `resume` compare. False when
   * the run is not ready, or moved on.
   */
  finishJudge(runId: string): boolean {
    const db = this.engineDb.getDb();
    return db.transaction((): boolean => {
      const run = db.prepare(
        `SELECT * FROM bulk_runs WHERE id = ? AND phase = 'planned' AND halt_reason IS NULL AND judge_rule IS NOT NULL
           AND (list_state IS NULL OR list_state = 'done')`,
      ).get(runId) as RunRow | undefined;
      if (!run) return false;
      const open = db.prepare(
        `SELECT COUNT(*) AS n FROM bulk_targets WHERE run_id = ? AND change != 'invalid' AND (before IS NULL OR judged_at IS NULL)`,
      ).get(runId) as { n: number };
      if (open.n > 0) return false;
      const rows = db.prepare(`SELECT target_key, change, after_planned, error FROM bulk_targets WHERE run_id = ? ORDER BY seq`)
        .all(runId) as { target_key: string; change: BulkChange; after_planned: string | null; error: string | null }[];
      const targets = rows.map((r) => {
        const key = this.engineDb.dec(r.target_key);
        return r.change === 'invalid' || r.after_planned === null
          ? { key, invalid: (r.error ?? 'verdict_invalid') as BulkInvalidReason }
          : { key, after: JSON.parse(this.engineDb.dec(r.after_planned)) as unknown };
      });
      const host = externalHostOf(run.target_system);
      const scope = host ?? `data_store:${run.target_collection ?? ''}`;
      const valid = targets.some((t) => !('invalid' in t));
      return db.prepare(
        `UPDATE bulk_runs SET phase = 'previewed', undo = ?, rule_hash = ? WHERE id = ? AND phase = 'planned' AND halt_reason IS NULL`,
      ).run(valid ? run.undo === 'none' ? 'restorable' : run.undo : 'none', this.engineDb.keyedHash(rulePairs(run.target_system, scope, targets)), runId).changes === 1;
    })();
  }

  /**
   * Delete every started, unapproved judged run whose start is more than `maxAgeMs` ago, with
   * its read phase's trigger and its encrypted before-images (PRD bulk-loop §3.1).
   * A started judged run is kept from the prune; this is what bounds how long it is kept. That
   * includes a run ended before approval — replaced by another start, or planned under an access
   * that has ended — whose before-images went to a model all the same; never a run that was
   * approved (an atomic run aborted while writing keeps its own reason). Run at boot and every 5
   * minutes by the engine's bulk sweep, not only when a plan is recorded. Returns how many went.
   */
  expireStaleJudgedRuns(now: number = Date.now(), maxAgeMs: number = BULK_JUDGED_RETENTION_MS): number {
    const db = this.engineDb.getDb();
    const doomed = db.prepare(
      `SELECT id FROM bulk_runs WHERE judge_rule IS NOT NULL AND cost_cap_usd IS NOT NULL AND ${UNAPPROVED_JUDGED}
         AND judge_started_at IS NOT NULL AND judge_started_at < ?`,
    ).all(new Date(now - maxAgeMs).toISOString()) as { id: string }[];
    if (doomed.length === 0) return 0;
    const triggers = new TriggerStore(this.engineDb);
    const drop = db.prepare(`DELETE FROM bulk_runs WHERE id = ? AND ${UNAPPROVED_JUDGED}`);
    let n = 0;
    db.transaction(() => {
      for (const { id } of doomed) {
        triggers.remove(bulkPreviewTriggerId(id));
        n += drop.run(id).changes;
      }
    })();
    return n;
  }

  // ── The effect loop's reads and writes (bulk-apply.ts) ──────────────────────

  getRunForApply(runId: string): BulkRunForApply | null {
    const r = this.runRow(runId);
    if (!r) return null;
    return {
      id: r.id, kind: r.kind, targetSystem: r.target_system, targetCollection: r.target_collection,
      atomic: r.atomic === 1, phase: r.phase, approvalChecksum: r.approval_checksum, maxTargets: r.max_targets,
      expiresAt: r.expires_at, applied: r.targets_applied, failed: r.targets_failed, haltReason: r.halt_reason,
      sourceRunId: r.source_run_id, contractJson: r.contract_json, delegatedPlanner: delegatedPlannerOf(r),
    };
  }

  /**
   * How many different targets of the run may have received its write verb: written, or
   * sent to whatever came back. What an approval for N targets bounds. A target found already
   * holding its value that this run never sent to (`found_unsent`) is not one of them.
   */
  sentCount(runId: string): number {
    return (this.engineDb.getDb().prepare(
      'SELECT COUNT(*) AS n FROM bulk_targets WHERE run_id = ? AND ((applied_at IS NOT NULL AND found_unsent = 0) OR write_sent = 1)',
    ).get(runId) as { n: number }).n;
  }

  /** Whether this target may already have received the run's write verb — a retry of it
   *  sends the verb to no new target. */
  wasSent(runId: string, seq: number): boolean {
    return this.engineDb.getDb().prepare(
      'SELECT 1 FROM bulk_targets WHERE run_id = ? AND seq = ? AND (applied_at IS NOT NULL OR write_sent = 1)',
    ).get(runId, seq) !== undefined;
  }

  /** Whether a send to this target ever ended without a clear answer: a timeout, a server
   *  error, a broken connection, or a loop that died while sending. Any one of them is
   *  enough; a later refusal does not make it known. */
  hasUnknownSend(runId: string, seq: number): boolean {
    return this.engineDb.getDb().prepare(
      'SELECT 1 FROM bulk_targets WHERE run_id = ? AND seq = ? AND unknown_sends > 0',
    ).get(runId, seq) !== undefined;
  }

  /** Writing targets not yet applied, failed or taken back, in seq order. */
  listPending(runId: string): number[] {
    return (this.engineDb.getDb().prepare(
      `SELECT seq FROM bulk_targets WHERE run_id = ? AND ${WRITING_SQL}
         AND applied_at IS NULL AND error IS NULL AND undone_at IS NULL ORDER BY seq`,
    ).all(runId) as { seq: number }[]).map((r) => r.seq);
  }

  /**
   * Claim one target for writing (PRD §3.4). A single conditional UPDATE,
   * so test and set are one step: it succeeds only while the target is unapplied,
   * unfailed and unclaimed — or claimed longer ago than {@link BULK_CLAIM_STALE_MS}, by
   * a loop that died. Two loops on one ledger (a restart, a retry, a second trigger)
   * therefore never both write a target.
   */
  claimTarget(runId: string, seq: number, now: number = Date.now()): boolean {
    return this.engineDb.getDb().prepare(
      `UPDATE bulk_targets SET claimed_at = ?
       WHERE run_id = ? AND seq = ? AND applied_at IS NULL AND error IS NULL AND undone_at IS NULL
         AND deselected_at IS NULL AND (claimed_at IS NULL OR claimed_at < ?)`,
    ).run(new Date(now).toISOString(), runId, seq, new Date(now - BULK_CLAIM_STALE_MS).toISOString()).changes === 1;
  }

  loadTarget(runId: string, seq: number): ApplyTarget | null {
    const r = this.engineDb.getDb().prepare(
      'SELECT seq, target_key, change, before, after_planned, source_seq FROM bulk_targets WHERE run_id = ? AND seq = ?',
    ).get(runId, seq) as { seq: number; target_key: string; change: BulkChange; before: string | null; after_planned: string | null; source_seq: number | null } | undefined;
    return r ? this.toApplyTarget(r) : null;
  }

  private toApplyTarget(r: { seq: number; target_key: string; change: BulkChange; before: string | null; after_planned: string | null; source_seq: number | null }): ApplyTarget {
    if (r.change !== 'update' && r.change !== 'create' && r.change !== 'delete') throw new Error('not a writing target');
    const expected = r.before === null ? { absent: true as const } : JSON.parse(this.engineDb.dec(r.before)) as BeforeImage;
    const after: BeforeImage = r.change === 'delete' || r.after_planned === null
      ? { absent: true }
      : { absent: false, value: JSON.parse(this.engineDb.dec(r.after_planned)) as unknown };
    return { seq: r.seq, key: this.engineDb.dec(r.target_key), change: r.change, expected, after, sourceSeq: r.source_seq };
  }

  /**
   * Record a written target, releasing its claim, in one transaction with the run's
   * counter — and, for an undo target, the source target it took back.
   */
  recordApplied(
    run: Pick<BulkRunForApply, 'id' | 'kind' | 'sourceRunId'>, seq: number, result: string, now: number = Date.now(),
    actual: ActualImage | null = null,
    /** The connection the target's write stage sent under ({@link noteConnection}, `write_*`). */
    via: AttachedConnection | null = null,
    /** The read-back holds markup the write never sent (PRD shopify-preset §21.2 item 6): marked
     *  in the same transaction as the record, so no halt after it can leave the target unmarked. */
    shopAddedMarkup = false,
    /** The host stored an HTML field otherwise than sent, within what the run may write: counted. */
    hostRewrote = false,
  ): void {
    const db = this.engineDb.getDb();
    const at = new Date(now).toISOString();
    db.transaction(() => {
      // `result` through enc() too: for an external target it is the host's own answer
      // class, and nothing about a target is stored in clear.
      const res = db.prepare(
        `UPDATE bulk_targets SET applied_at = ?, result = ?, after_actual = ?, claimed_at = NULL, shop_added_markup = ?, host_rewrote = ?
           WHERE run_id = ? AND seq = ? AND applied_at IS NULL`,
      ).run(at, this.engineDb.enc(result), actual === null ? null : this.engineDb.enc(JSON.stringify(actual)), shopAddedMarkup ? 1 : 0, hostRewrote ? 1 : 0, run.id, seq);
      if (res.changes !== 1) return;
      this.noteConnection(run.id, seq, 'write', via);
      // Found as planned and never sent to by this run: someone else set the value, so the run
      // changed nothing there ({@link sentCount}, {@link undoEligible}).
      if (result === 'already') {
        db.prepare(
          `UPDATE bulk_targets SET found_unsent = 1 WHERE run_id = ? AND seq = ? AND write_sent = 0
             AND EXISTS (SELECT 1 FROM bulk_runs WHERE id = ? AND unsent_tracked = 1)`,
        ).run(run.id, seq, run.id);
      }
      db.prepare('UPDATE bulk_runs SET targets_applied = targets_applied + 1 WHERE id = ?').run(run.id);
      if (run.kind === 'undo' && run.sourceRunId !== null) {
        db.prepare(
          `UPDATE bulk_targets SET undone_at = ? WHERE run_id = ?
             AND seq = (SELECT source_seq FROM bulk_targets WHERE run_id = ? AND seq = ?)`,
        ).run(at, run.sourceRunId, run.id, seq);
      }
    })();
  }

  /**
   * Mark that the run's write verb is about to go out to this target. Set before the request,
   * never cleared: whatever the answer — a failure, a redirect, none because the loop died —
   * the target may hold the write from here on. `via` is the connection the write leaves under,
   * recorded with the mark (`write_*`), so a loop that dies before the target is recorded still
   * leaves whose credential reached the host.
   */
  markSent(runId: string, seq: number, via: AttachedConnection | null = null): void {
    const db = this.engineDb.getDb();
    db.transaction(() => {
      // Noted first: `noteConnection` reads a target already marked sent with no write recorded as
      // one sent before v43, and this mark is not that.
      this.noteConnection(runId, seq, 'write', via);
      // Each send also counts as one whose answer is not known yet; only that send's own
      // refusal takes it back ({@link markRefused}), so no later answer can make an earlier
      // unclear one known.
      db.prepare('UPDATE bulk_targets SET write_sent = 1, unknown_sends = unknown_sends + 1 WHERE run_id = ? AND seq = ?').run(runId, seq);
    })();
  }

  /** The send just marked was refused by the host (a 4xx other than a timeout, a 429
   *  included), or never left (a blocked address): it did not change the target. Not a
   *  redirect. Called at most once per send. */
  markRefused(runId: string, seq: number): void {
    this.engineDb.getDb().prepare('UPDATE bulk_targets SET unknown_sends = unknown_sends - 1 WHERE run_id = ? AND seq = ? AND unknown_sends > 0')
      .run(runId, seq);
  }

  /** Give a claimed target back unwritten, for a loop that stops before writing it. */
  releaseClaim(runId: string, seq: number): void {
    this.engineDb.getDb().prepare('UPDATE bulk_targets SET claimed_at = NULL WHERE run_id = ? AND seq = ? AND applied_at IS NULL')
      .run(runId, seq);
  }

  /** Record a target that was not written. A conflict is not counted as a failure: the
   *  target is fine, it just no longer holds the state the run expected. Nor is
   *  `sent_unknown`, which records no new attempt (see {@link WRITE_FAILURES}). */
  recordFailed(
    runId: string, seq: number, error: BulkTargetError,
    /** The connection of what the target's write stage sent, if anything ({@link noteConnection}). */
    via: AttachedConnection | null = null,
  ): void {
    const db = this.engineDb.getDb();
    const counted = !(NOT_FAILURES as readonly BulkTargetError[]).includes(error);
    db.transaction(() => {
      const res = db.prepare(
        // `failed_once` stays NULL on a run approved before it was recorded: one known failure
        // does not make its earlier passes known.
        `UPDATE bulk_targets SET error = ?, claimed_at = NULL,
           failed_once = CASE WHEN ? = 0 OR failed_once IS NULL THEN failed_once ELSE 1 END
         WHERE run_id = ? AND seq = ? AND applied_at IS NULL`,
      ).run(error, counted ? 1 : 0, runId, seq);
      if (res.changes === 1) this.noteConnection(runId, seq, 'write', via);
      if (res.changes === 1 && counted) {
        db.prepare('UPDATE bulk_runs SET targets_failed = targets_failed + 1 WHERE id = ?').run(runId);
      }
    })();
  }

  /**
   * Mark a target written by this run as taken back (an atomic run's rollback). For an
   * undo run the rollback restores what the source wrote, so the source target stands
   * again: its `undone_at` is cleared in the same transaction.
   */
  recordRolledBack(run: Pick<BulkRunForApply, 'id' | 'kind' | 'sourceRunId'>, seq: number, now: number = Date.now()): void {
    const db = this.engineDb.getDb();
    db.transaction(() => {
      db.prepare('UPDATE bulk_targets SET undone_at = ? WHERE run_id = ? AND seq = ? AND applied_at IS NOT NULL')
        .run(new Date(now).toISOString(), run.id, seq);
      if (run.kind === 'undo' && run.sourceRunId !== null) {
        db.prepare(
          `UPDATE bulk_targets SET undone_at = NULL WHERE run_id = ?
             AND seq = (SELECT source_seq FROM bulk_targets WHERE run_id = ? AND seq = ?)`,
        ).run(run.sourceRunId, run.id, seq);
      }
    })();
  }

  /** Targets this run applied and has not taken back, newest first — a rollback's order. Not a
   *  target found already holding its value and never sent to (`found_unsent`): the run did not
   *  change it, and rolling it back would overwrite whoever did. */
  listAppliedDesc(runId: string): ApplyTarget[] {
    const rows = this.engineDb.getDb().prepare(
      `SELECT seq, target_key, change, before, after_planned, source_seq FROM bulk_targets
       WHERE run_id = ? AND applied_at IS NOT NULL AND found_unsent = 0 AND undone_at IS NULL AND ${WRITING_SQL}
       ORDER BY seq DESC`,
    ).all(runId) as { seq: number; target_key: string; change: BulkChange; before: string | null; after_planned: string | null; source_seq: number | null }[];
    return rows.map((r) => this.toApplyTarget(r));
  }

  /** Move the run's phase, only from one of `from`. */
  setPhase(runId: string, from: readonly BulkPhase[], to: BulkPhase, haltReason: BulkHaltReason | null = null): boolean {
    return this.engineDb.getDb().prepare(
      `UPDATE bulk_runs SET phase = ?, halt_reason = COALESCE(?, halt_reason)
       WHERE id = ? AND phase IN (${from.map(() => '?').join(',')})`,
    ).run(to, haltReason, runId, ...from).changes === 1;
  }

  /** Stop the run where it is: the phase stays, the reason is set. */
  halt(runId: string, reason: BulkHaltReason): void {
    this.engineDb.getDb().prepare('UPDATE bulk_runs SET halt_reason = ? WHERE id = ?').run(reason, runId);
  }

  /**
   * Close a run whose loop found nothing left to write: `done`. For an undo run, the
   * source becomes `undone` once none of what an undo takes back ({@link undoEligible}) is
   * left standing.
   */
  finish(run: Pick<BulkRunForApply, 'id' | 'kind' | 'sourceRunId'>): void {
    const db = this.engineDb.getDb();
    db.transaction(() => {
      db.prepare(`UPDATE bulk_runs SET phase = 'done' WHERE id = ? AND phase = 'writing'`).run(run.id);
      if (run.kind !== 'undo' || run.sourceRunId === null) return;
      const src = this.runRow(run.sourceRunId);
      if (!src) return;
      // Standing is what an undo takes back and has not: for an external source that includes
      // a failed write the undo could not restore (a conflict, or a failed write of its own) —
      // it may hold what the source wrote, so the source is not reported undone.
      const standing = db.prepare(
        `SELECT COUNT(*) AS n FROM bulk_targets WHERE run_id = ? AND ${undoEligible(externalHostOf(src.target_system) !== null)}`,
      ).get(run.sourceRunId) as { n: number };
      if (standing.n === 0) {
        db.prepare(`UPDATE bulk_runs SET phase = 'undone' WHERE id = ? AND phase IN ('done','aborted','writing')`).run(run.sourceRunId);
      }
    })();
  }
}
