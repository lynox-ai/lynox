/**
 * The approval queue's store (`approval_entries`, engine.db v48): a mail that a run nobody
 * watches wanted to send, kept for its owner to send or discard.
 *
 * An entry binds the exact effect. `payload_json` (encrypted at rest), `origin_json` and
 * `checksum` are written once, at filing (I2): no method here updates them except the sweep's
 * tombstone below, which only empties the payload, and a trigger in engine.db refuses any
 * other UPDATE that would. The checksum is a
 * `keyedHash` over kind, payload and origin, so a payload or origin that differs from the one
 * filed is caught before it is sent; the lock does not depend on the key's secrecy, it catches
 * a display that differs from the payload.
 *
 * Each status has one writer, and each writer is one method here (I1):
 * - the filer inserts `pending` ({@link ApprovalStore.file}), never another status;
 * - the decide route writes `approved` and `rejected` ({@link ApprovalStore.decide});
 * - the executor writes `executing`, then `done`, `failed` or `unknown`
 *   ({@link ApprovalStore.claim}, {@link ApprovalStore.finish}), and stamps a hold without
 *   claiming ({@link ApprovalStore.hold});
 * - the sweep writes `expired`, turns a stale claim into `unknown`, tombstones and deletes
 *   ({@link ApprovalStore.sweep}).
 * Absence is never yes (I3): an expired, rejected or failed entry is not sent, the claim
 * refuses an entry at its expiry, and a time that does not parse counts as reached. At most
 * once (I4): `approved → executing` is a compare-and-set before any side effect, an `unknown`
 * outcome is never retried, and only a provably-not-sent failure goes back to `approved`.
 *
 * The dedup set refuses a second filing of the same mail. The keys are derived here from the
 * payload and stored only as keyed hashes, because they hold recipients and subjects. They are
 * hashed under the current vault key: after the key changes, or when an instance without one
 * gets one, a new filing no longer meets the rows filed before.
 *
 * `unknown` means the mail may have gone out, so it keeps refusing the same mail until the
 * owner clears it. After 30 days its content is removed and the row stays as a tombstone that
 * blocks through its hashed keys; clearing a tombstone deletes the row. An entry whose keys are
 * unkeyed SHA-256 (no vault key) is no tombstone: addresses and subjects can be enumerated from
 * such a hash, so it is deleted after 30 days and its block ends with it.
 *
 * Nothing here sends. Filing goes through `approval-filing.ts`, the decision through the decide
 * route, and sending through `approval-executor.ts`.
 */

import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { EngineDb } from './engine-db.js';
import { isFeatureEnabled } from './features.js';

/** Every kind of entry; the type is read from this list, so a new kind is listed wherever it is. */
export const APPROVAL_KINDS = ['mail_reply', 'mail_send'] as const;
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];

export type ApprovalStatus =
  | 'pending' | 'approved' | 'executing' | 'done' | 'failed' | 'unknown' | 'rejected' | 'expired';

/** The sources a filing can come from. Closed in the type only: the column has no CHECK, so a
 *  new source needs no migration. A row with any other source is read but never executed. */
export type ApprovalSource = 'workflow' | 'task' | 'webhook';
const KNOWN_SOURCES: ReadonlySet<string> = new Set<ApprovalSource>(['workflow', 'task', 'webhook']);

export interface ApprovalOrigin {
  source: ApprovalSource;
  triggerId: string;
  runId: string;
  rootRunId: string;
  eventId?: string | undefined;
  threadId?: string | undefined;
  /** Whether the run had read content it did not write (a web page, a mail) before it filed:
   *  the card says so (§4.5). Known only at filing, so it is stored then. */
  afterUntrusted?: boolean | undefined;
}

export interface StoredAddress {
  name?: string | undefined;
  address: string;
}

export interface MailReplyPayload {
  accountId: string;
  fromAddress: string;
  to: StoredAddress[];
  cc: StoredAddress[];
  subject: string;
  /** As it will go out (reflowed). */
  bodyText: string;
  inReplyTo?: string | undefined;
  references?: string | undefined;
  originalThreadKey: string;
  originalMessageId?: string | undefined;
  /** `<folder>:<uid>` of the original, the dedup key when it has no Message-ID. */
  originalFolderUid: string;
  /** The account the original was read through — the provider that fetched it, never a value
   *  the model passed. With smart reply-from it is not the sending account (`accountId`). Only the
   *  chat a moved entry opens reads it; sending does not. Stored from this field's introduction
   *  on; an entry filed before has none. */
  readAccountId?: string | undefined;
  /** `replyTo`: the original's Reply-To addresses. Stored from this field's introduction on; an
   *  entry filed before has none. */
  original: { from: string; to: string[]; cc: string[]; replyTo?: string[] | undefined; subject: string; date: string };
  persona?: string | undefined;
}

export interface MailSendPayload {
  accountId: string;
  fromAddress: string;
  to: StoredAddress[];
  cc: StoredAddress[];
  bcc: StoredAddress[];
  subject: string;
  /** As it will go out (reflowed). */
  bodyText: string;
  /** The follow-up the model asked for with `track_followup`, in that input's shape, registered
   *  after the send; null when it asked for none. */
  trackFollowup: ApprovalFollowup | null;
}

/** A follow-up reminder as `mail_send` takes it (`track_followup`). */
export interface ApprovalFollowup {
  reminder_in_days: number;
  reason: string;
  type?: 'awaiting_reply' | 'user_deliverable' | 'custom' | undefined;
}

export type ApprovalFiling =
  | { kind: 'mail_reply'; payload: MailReplyPayload }
  | { kind: 'mail_send'; payload: MailSendPayload };

export interface FileApprovalInput {
  filing: ApprovalFiling;
  origin: ApprovalOrigin;
  createdBy: string | null;
  mandateId: string | null;
  /** Refuse the filing when its trigger already has this many entries pending (§5, flooding).
   *  Counted in the same transaction as the insert. Absent = no limit. */
  maxPendingPerTrigger?: number | undefined;
  now?: number | undefined;
}

/**
 * Why a filing was refused as a duplicate, with the entry it met: the same mail `waiting` or
 * of `unknown` outcome, `sent` or `discarded` within its window, or — for `mail_send` — an
 * open entry of the same mail family (account, recipients, subject) with another body
 * (`family_open`).
 */
export type DuplicateReason = 'waiting' | 'unknown' | 'sent' | 'discarded' | 'family_open';

export type FileResult =
  | { ok: true; id: string }
  | { ok: false; reason: DuplicateReason; existingId: string }
  /** The origin names no trigger, run or root run, or a source this engine does not know. */
  | { ok: false; reason: 'invalid_origin' }
  /** The trigger already has `pending` entries waiting, as many as the filing allows. */
  | { ok: false; reason: 'flood'; pending: number }
  /** The body, or the payload as stored, is larger than an entry may hold
   *  ({@link APPROVAL_MAX_BODY_BYTES}, {@link APPROVAL_MAX_PAYLOAD_BYTES}). */
  | { ok: false; reason: 'too_large' };

/**
 * An entry as read. `origin` is null and `executable` false when the stored origin is not one
 * this engine knows (a source added by a later version, a damaged row), when the payload does
 * not decrypt, parse or fit its kind, or when the entry is a tombstone: such an entry is
 * shown, never sent.
 */
export interface ApprovalEntry {
  id: string;
  kind: ApprovalKind;
  status: ApprovalStatus;
  filing: ApprovalFiling | null;
  origin: ApprovalOrigin | null;
  /** The stored origin text, for display when it is not recognised. */
  originJson: string;
  executable: boolean;
  checksum: string;
  binding: 'keyed' | 'unkeyed';
  createdBy: string | null;
  mandateId: string | null;
  heldReason: string | null;
  heldAt: string | null;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  decidedReason: string | null;
  claimedAt: string | null;
  executedAt: string | null;
  attempts: number;
  /** Decrypted; null when there is none or it does not decrypt. */
  resultJson: string | null;
  purgeAfter: string | null;
  tombstonedAt: string | null;
}

export const APPROVAL_TTL_MS = 72 * 60 * 60_000;
/** An approved entry the executor neither claimed nor held within this much of its uptime expires. */
export const APPROVAL_CLAIM_WINDOW_MS = 60 * 60_000;
/** A claim older than this belongs to a process that stopped mid-send (as the scheduled send's). */
export const APPROVAL_CLAIM_STALE_MS = 15 * 60_000;
export const APPROVAL_PURGE_AFTER_MS = 30 * 24 * 60 * 60_000;
/** Attempts in all, the first included; then a provably-not-sent failure ends `failed`. */
export const APPROVAL_MAX_ATTEMPTS = 3;

/** Whether a stored result (plain JSON, or null) says a matching mail went out shortly before
 *  one of the entry's attempts: its reason was `dedup_window`, or it already carried the mark. */
export function approvalResultSawDedup(plain: string | null): boolean {
  if (plain === null) return false;
  let v: unknown;
  try { v = JSON.parse(plain); } catch { return false; }
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return o['reason'] === 'dedup_window' || o['dedupSeen'] === true;
}

/** Whether the result an attempt stores is to carry the mark: the one before carried it or was
 *  `dedup_window`, or this one is. */
function dedupSeen(previous: string | null, result: unknown): boolean {
  return approvalResultSawDedup(previous) || approvalResultSawDedup(JSON.stringify(result ?? null));
}
/** A body above this many bytes (UTF-8) is not filed (§4.5). */
export const APPROVAL_MAX_BODY_BYTES = 64 * 1024;
/** A payload above this many bytes as stored (JSON, UTF-8) is not filed: the body's limit leaves
 *  room for the recipients, the headers and the original a reply quotes, and no more. */
export const APPROVAL_MAX_PAYLOAD_BYTES = 96 * 1024;
/** How long a provably-not-sent attempt waits at least before the next one: the default
 *  recipient dedup window. The executor waits for the configured window when it is longer. */
export const APPROVAL_RETRY_DELAY_MS = 60_000;
/** How long a sent or discarded entry keeps refusing the same mail. */
export const APPROVAL_DEDUP_WINDOW_MS: Readonly<Record<ApprovalKind, number>> = {
  mail_reply: 14 * 24 * 60 * 60_000,
  mail_send: 24 * 60 * 60_000,
};

const ACTIVE_STATUSES = `('pending', 'approved', 'executing', 'unknown')`;

/** Whether the approval queue is switched on for this instance. The store and its sweep work
 *  either way, so entries from an on-period still expire and are purged after it is turned off. */
export function approvalQueueEnabled(): boolean {
  return isFeatureEnabled('approval-queue');
}

interface ApprovalDbRow {
  id: string;
  kind: ApprovalKind;
  payload_json: string;
  origin_json: string;
  checksum: string;
  binding: 'keyed' | 'unkeyed';
  created_by: string | null;
  mandate_id: string | null;
  status: ApprovalStatus;
  held_reason: string | null;
  held_at: string | null;
  created_at: string;
  expires_at: string;
  decided_at: string | null;
  decided_by: string | null;
  decided_reason: string | null;
  claimed_at: string | null;
  executed_at: string | null;
  attempts: number;
  result_json: string | null;
  purge_after: string | null;
  tombstoned_at: string | null;
}

const iso = (ms: number): string => new Date(ms).toISOString();

/** Whether a stored time has been reached. A time that does not parse counts as reached, so a
 *  damaged row expires instead of living on. */
const reached = (stored: string | null, now: number): boolean => !(Date.parse(stored ?? '') > now);

/** Lower-cased, trimmed, de-duplicated and sorted addresses, as the send dedup builds them. */
function recipientList(...lists: ReadonlyArray<ReadonlyArray<StoredAddress>>): string[] {
  const all = lists.flatMap(l => l.map(a => a.address.toLowerCase().trim()));
  return Array.from(new Set(all)).sort();
}

/** The subject trimmed and lower-cased, as the send dedup compares it. */
const comparableSubject = (s: string): string => s.trim().toLowerCase();

/**
 * The plain dedup and family keys of a filing (§4.3a), before they are hashed for storage.
 * Each is a JSON array of its parts, so no address or subject can run into the next part.
 */
export function approvalKeys(filing: ApprovalFiling, origin: ApprovalOrigin): { dedupKey: string; familyKey: string | null } {
  if (filing.kind === 'mail_reply') {
    const p = filing.payload;
    const message = p.originalMessageId !== undefined && p.originalMessageId !== ''
      ? p.originalMessageId
      : p.originalFolderUid;
    return { dedupKey: JSON.stringify(['mail_reply', p.accountId, message]), familyKey: null };
  }
  const p = filing.payload;
  const recipients = recipientList(p.to, p.cc, p.bcc);
  const subject = comparableSubject(p.subject);
  const body = createHash('sha256').update(p.bodyText, 'utf8').digest('hex');
  const event = origin.eventId ?? origin.runId;
  return {
    dedupKey: JSON.stringify(['mail_send', event, recipients, subject, body]),
    familyKey: JSON.stringify(['mail_send', p.accountId, recipients, subject]),
  };
}

const isString = (v: unknown): v is string => typeof v === 'string';
const isOptionalString = (v: unknown): boolean => v === undefined || typeof v === 'string';
const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every(isString);

function isAddressList(v: unknown): v is StoredAddress[] {
  return Array.isArray(v) && v.every(a => {
    if (typeof a !== 'object' || a === null) return false;
    const r = a as Record<string, unknown>;
    return isString(r['address']) && isOptionalString(r['name']);
  });
}

/** Whether an origin names its trigger, run and root run and a source this engine knows, and
 *  an event id, when it has one, that is not empty (an empty one would key distinct runs alike). */
function originIsComplete(o: ApprovalOrigin): boolean {
  return KNOWN_SOURCES.has(o.source) && o.triggerId !== '' && o.runId !== '' && o.rootRunId !== ''
    && o.eventId !== '';
}

/** The stored origin, or null when it is not one this engine knows. */
function readOrigin(json: string): ApprovalOrigin | null {
  let v: unknown;
  try { v = JSON.parse(json); } catch { return null; }
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (!isString(o['source']) || !isString(o['triggerId']) || !isString(o['runId']) || !isString(o['rootRunId'])) return null;
  if (!isOptionalString(o['eventId']) || !isOptionalString(o['threadId'])) return null;
  if (o['afterUntrusted'] !== undefined && typeof o['afterUntrusted'] !== 'boolean') return null;
  const origin = o as unknown as ApprovalOrigin;
  return originIsComplete(origin) ? origin : null;
}

const FOLLOWUP_TYPES: ReadonlySet<unknown> = new Set(['awaiting_reply', 'user_deliverable', 'custom']);

/** Null, or a follow-up of the shape `mail_send` takes. */
function isFollowup(v: unknown): v is ApprovalFollowup | null {
  if (v === null) return true;
  if (typeof v !== 'object') return false;
  const f = v as Record<string, unknown>;
  return typeof f['reminder_in_days'] === 'number' && isString(f['reason'])
    && (f['type'] === undefined || FOLLOWUP_TYPES.has(f['type']));
}

/**
 * The follow-up a filing stores for a `track_followup` the model wrote: the fields the reader
 * accepts, or null. A value the reader would refuse is dropped here rather than stored, so it
 * cannot make the whole entry unsendable; the send would have skipped such a follow-up too.
 */
export function approvalFollowup(v: unknown): ApprovalFollowup | null {
  if (typeof v !== 'object' || v === null) return null;
  const f = v as Record<string, unknown>;
  const days = f['reminder_in_days'];
  const reason = f['reason'];
  if (typeof days !== 'number' || !isString(reason)) return null;
  const type = f['type'];
  return FOLLOWUP_TYPES.has(type)
    ? { reminder_in_days: days, reason, type: type as NonNullable<ApprovalFollowup['type']> }
    : { reminder_in_days: days, reason };
}

/** The stored payload for its kind, or null when it does not parse or does not fit the kind. */
function readFiling(kind: ApprovalKind, json: string | null): ApprovalFiling | null {
  if (json === null) return null;
  let v: unknown;
  try { v = JSON.parse(json); } catch { return null; }
  if (typeof v !== 'object' || v === null) return null;
  const p = v as Record<string, unknown>;
  const common = isString(p['accountId']) && isString(p['fromAddress'])
    && isAddressList(p['to']) && isAddressList(p['cc'])
    && isString(p['subject']) && isString(p['bodyText']);
  if (!common) return null;
  if (kind === 'mail_reply') {
    if (!isString(p['originalThreadKey']) || !isString(p['originalFolderUid'])) return null;
    if (!isOptionalString(p['inReplyTo']) || !isOptionalString(p['references'])
      || !isOptionalString(p['originalMessageId']) || !isOptionalString(p['persona'])
      || !isOptionalString(p['readAccountId'])) return null;
    const o = p['original'];
    if (typeof o !== 'object' || o === null) return null;
    const r = o as Record<string, unknown>;
    if (!isString(r['from']) || !isStringList(r['to']) || !isStringList(r['cc']) || !isString(r['subject']) || !isString(r['date'])) return null;
    if (r['replyTo'] !== undefined && !isStringList(r['replyTo'])) return null;
    return { kind, payload: p as unknown as MailReplyPayload };
  }
  if (!isAddressList(p['bcc']) || !isFollowup(p['trackFollowup'])) return null;
  return { kind, payload: p as unknown as MailSendPayload };
}

export type DecideAction =
  | { action: 'approve'; checksum: string }
  /** `mandate_ended`: the decide route's answer to an approval of an entry whose mandate has
   *  ended; nobody else writes it. */
  | { action: 'reject'; reason: 'owner' | 'moved_to_chat' | 'mandate_ended' }
  | { action: 'clear_unknown' };

export type DecideResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'not_pending' | 'not_unknown' | 'expired' | 'checksum' | 'not_executable' };

export type ClaimResult =
  | { ok: true; entry: ApprovalEntry }
  | { ok: false; reason: 'not_claimable' | 'expired' | 'not_executable' }
  /** The send limit held it: the entry stays `approved` with the hold `send_limit`. */
  | { ok: false; reason: 'held' };

/**
 * The send limit a claim checks (§4.8 step 1), for the entry's kind: `admits` gets how many
 * entries of that kind were claimed within the last hour and day (in `executing`, `done` or
 * `unknown`), counted in the claim's own transaction, and answers whether one more may go.
 */
export interface ClaimCap {
  admits(claimedSince: { hour: number; day: number }): boolean;
}

/** The executor's outcome for a claimed entry. `retry` is only for a failure that proves
 *  nothing was sent; after the last attempt it ends `failed`. */
export type FinishOutcome = 'done' | 'failed' | 'unknown' | 'retry';

export interface SweepInput {
  now?: number | undefined;
  /** When this engine started, so a restart does not expire an approved mail. */
  engineStartedAt: number;
  /** Whether the queue is on; an approved entry that expires while it is off says so. */
  flagOn: boolean;
}

export interface SweepCounts {
  expired: number;
  unknown: number;
  tombstoned: number;
  purged: number;
}

/** The most entries one list read returns. */
export const APPROVAL_LIST_LIMIT = 200;

/**
 * Whose entries a read covers. It has no default: `all` must be asked for, so a caller that
 * holds no grant id cannot read the whole queue by leaving the filter out.
 */
export type ApprovalListScope =
  /** Every entry. */
  | { readonly kind: 'all' }
  /** The entries filed under this grant id. */
  | { readonly kind: 'grant'; readonly mandateId: string }
  /** The entries no mandate filed. */
  | { readonly kind: 'owner-only' };

export interface ApprovalListQuery {
  /** `open`: pending, approved, executing and unknown. `all`: every entry not yet purged. */
  view: 'open' | 'all';
  scope: ApprovalListScope;
  limit?: number | undefined;
}

/** The filter for a scope. A scope this store does not know, or a grant id that is empty, throws. */
function pushScopeFilter(where: string[], params: unknown[], scope: ApprovalListScope): void {
  switch (scope?.kind) {
    case 'all': return;
    case 'owner-only': where.push('mandate_id IS NULL'); return;
    case 'grant':
      if (typeof scope.mandateId !== 'string' || scope.mandateId === '') throw new Error('approval list: a grant scope needs a grant id');
      where.push('mandate_id = ?');
      params.push(scope.mandateId);
      return;
    default: throw new Error('approval list: no scope given');
  }
}

/** What a listener learns about a filed entry: which one, of what kind and under which grant, nothing from its payload. */
export interface FiledEntry {
  readonly id: string;
  readonly kind: ApprovalKind;
  /** The grant whose run filed it; null when the owner's own run did. */
  readonly mandateId: string | null;
}

export interface ApprovalStoreOptions {
  /**
   * Called once per entry this store filed, after the insert committed, so the owner can be told.
   * A refused filing never reaches it. It must not be able to undo a filing: what it throws is
   * swallowed here, because the agent reports any throw from `file` as "nothing was stored"
   * (`agent.ts` `_fileApproval`) while the row is already in the table.
   */
  readonly onFiled?: ((entry: FiledEntry) => void) | undefined;
}

export class ApprovalStore {
  private readonly db: Database.Database;
  private readonly onFiled: ((entry: FiledEntry) => void) | undefined;

  constructor(private readonly engine: EngineDb, options: ApprovalStoreOptions = {}) {
    this.db = engine.getDb();
    this.onFiled = options.onFiled;
  }

  private checksumOf(kind: ApprovalKind, payloadJson: string, originJson: string): string {
    return this.engine.keyedHash(['approval-entry-v1', kind, payloadJson, originJson]);
  }

  private storedKey(plain: string): string {
    return this.engine.keyedHash(['approval-dedup-v1', plain]);
  }

  /** A result as stored: encrypted, because a provider's error text can name a recipient. */
  private storedResult(result: unknown): string {
    return this.engine.enc(JSON.stringify(result ?? null));
  }

  /**
   * File an entry as `pending`, or refuse it. The dedup set (§4.2): an entry with the same key
   * that is pending, approved, executing or unknown, at any age; one sent within the kind's
   * window; or one the owner discarded within it, except one cleared after an unknown outcome.
   * For `mail_send` the family (account, recipients, subject) is checked too: an open entry of
   * the family refuses at any age, and the sent and discarded ones are looked up by family.
   */
  file(input: FileApprovalInput): FileResult {
    const result = this.fileEntry(input);
    if (result.ok && this.onFiled !== undefined) {
      try {
        this.onFiled({ id: result.id, kind: input.filing.kind, mandateId: input.mandateId });
      } catch {
        // The entry is filed; telling the owner is best effort and the list shows it anyway.
      }
    }
    return result;
  }

  private fileEntry(input: FileApprovalInput): FileResult {
    const now = input.now ?? Date.now();
    const { filing, origin } = input;
    if (!originIsComplete(origin)) return { ok: false, reason: 'invalid_origin' };
    if (Buffer.byteLength(filing.payload.bodyText, 'utf8') > APPROVAL_MAX_BODY_BYTES) return { ok: false, reason: 'too_large' };
    const payloadJson = JSON.stringify(filing.payload);
    if (Buffer.byteLength(payloadJson, 'utf8') > APPROVAL_MAX_PAYLOAD_BYTES) return { ok: false, reason: 'too_large' };
    const originJson = JSON.stringify(origin);
    const keys = approvalKeys(filing, origin);
    const dedupKey = this.storedKey(keys.dedupKey);
    const familyKey = keys.familyKey === null ? null : this.storedKey(keys.familyKey);
    const windowStart = iso(now - APPROVAL_DEDUP_WINDOW_MS[filing.kind]);

    const duplicate = (): FileResult | null => {
      const active = this.db.prepare(
        `SELECT id, status FROM approval_entries WHERE dedup_key = ? AND status IN ${ACTIVE_STATUSES} LIMIT 1`,
      ).get(dedupKey) as { id: string; status: ApprovalStatus } | undefined;
      if (active) return { ok: false, reason: active.status === 'unknown' ? 'unknown' : 'waiting', existingId: active.id };

      if (familyKey !== null) {
        const family = this.db.prepare(
          `SELECT id, status FROM approval_entries WHERE family_key = ? AND status IN ${ACTIVE_STATUSES}
           ORDER BY status = 'unknown' DESC, created_at DESC LIMIT 1`,
        ).get(familyKey) as { id: string; status: ApprovalStatus } | undefined;
        if (family) return { ok: false, reason: family.status === 'unknown' ? 'unknown' : 'family_open', existingId: family.id };
      }

      const keyColumn = familyKey === null ? 'dedup_key' : 'family_key';
      const ended = this.db.prepare(
        `SELECT id, status FROM approval_entries WHERE ${keyColumn} = ? AND (
           (status = 'done' AND executed_at > ?)
           OR (status = 'rejected' AND decided_at > ? AND decided_reason IS NOT 'cleared_unknown'))
         ORDER BY created_at DESC LIMIT 1`,
      ).get(familyKey ?? dedupKey, windowStart, windowStart) as { id: string; status: ApprovalStatus } | undefined;
      if (ended) return { ok: false, reason: ended.status === 'done' ? 'sent' : 'discarded', existingId: ended.id };
      return null;
    };

    return this.db.transaction((): FileResult => {
      const refused = duplicate();
      if (refused) return refused;
      if (input.maxPendingPerTrigger !== undefined) {
        // `origin_json` is stored in the clear, so the trigger is read from it; a duplicate was
        // refused above and does not count.
        const { n } = this.db.prepare(
          `SELECT COUNT(*) AS n FROM approval_entries WHERE status = 'pending' AND json_extract(origin_json, '$.triggerId') = ?`,
        ).get(origin.triggerId) as { n: number };
        if (n >= input.maxPendingPerTrigger) return { ok: false, reason: 'flood', pending: n };
      }
      // The lookup and the insert share one write lock (`immediate`), so no other filing can
      // land between them. The unique index over the open states is the database's own guard
      // against a writer outside this store; if it fires, the insert throws and nothing is filed.
      const id = randomUUID();
      this.db.prepare(
        `INSERT INTO approval_entries
           (id, kind, payload_json, origin_json, dedup_key, family_key, checksum, binding,
            created_by, mandate_id, status, created_at, expires_at, attempts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, 0)`,
      ).run(
        id, filing.kind, this.engine.enc(payloadJson), originJson, dedupKey, familyKey,
        this.checksumOf(filing.kind, payloadJson, originJson), this.engine.hashIsKeyed ? 'keyed' : 'unkeyed',
        input.createdBy, input.mandateId, iso(now), iso(now + APPROVAL_TTL_MS),
      );
      return { ok: true, id };
    }).immediate();
  }

  private toEntry(r: ApprovalDbRow): ApprovalEntry {
    // A tombstone's payload is empty, which reads as no filing.
    const payloadJson = this.engine.tryDec(r.payload_json);
    const filing = readFiling(r.kind, payloadJson);
    const origin = readOrigin(r.origin_json);
    return {
      id: r.id,
      kind: r.kind,
      status: r.status,
      filing,
      origin,
      originJson: r.origin_json,
      executable: filing !== null && origin !== null,
      checksum: r.checksum,
      binding: r.binding,
      createdBy: r.created_by,
      mandateId: r.mandate_id,
      heldReason: r.held_reason,
      heldAt: r.held_at,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      decidedAt: r.decided_at,
      decidedBy: r.decided_by,
      decidedReason: r.decided_reason,
      claimedAt: r.claimed_at,
      executedAt: r.executed_at,
      attempts: r.attempts,
      resultJson: r.result_json === null ? null : this.engine.tryDec(r.result_json),
      purgeAfter: r.purge_after,
      tombstonedAt: r.tombstoned_at,
    };
  }

  get(id: string): ApprovalEntry | null {
    const r = this.db.prepare('SELECT * FROM approval_entries WHERE id = ?').get(id) as ApprovalDbRow | undefined;
    return r ? this.toEntry(r) : null;
  }

  /** Every entry filed under a plain dedup key (§4.3a), in any status until it is purged, newest first. */
  listByDedupKey(plainDedupKey: string): ApprovalEntry[] {
    const rows = this.db.prepare(
      'SELECT * FROM approval_entries WHERE dedup_key = ? ORDER BY created_at DESC, id ASC',
    ).all(this.storedKey(plainDedupKey)) as ApprovalDbRow[];
    return rows.map(r => this.toEntry(r));
  }

  /**
   * The entries for the owner's list, newest first, at most `limit`: the open ones (pending,
   * approved, executing, unknown — tombstones included), or every entry the store still holds.
   * `scope` says whose entries: every one, one grant's, or the ones no mandate filed.
   */
  list(query: ApprovalListQuery): ApprovalEntry[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.view === 'open') where.push(`status IN ${ACTIVE_STATUSES}`);
    pushScopeFilter(where, params, query.scope);
    const asked = query.limit !== undefined && Number.isFinite(query.limit) ? Math.trunc(query.limit) : APPROVAL_LIST_LIMIT;
    const limit = Math.min(Math.max(asked, 1), APPROVAL_LIST_LIMIT);
    const rows = this.db.prepare(
      `SELECT * FROM approval_entries${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''}
       ORDER BY created_at DESC, id ASC LIMIT ?`,
    ).all(...params, limit) as ApprovalDbRow[];
    return rows.map(r => this.toEntry(r));
  }

  /**
   * Whether an entry whose outcome is unclear stays listed until the owner closes it: with a vault
   * key it becomes a tombstone at its purge time (its content cleared, the row kept); without one
   * it is deleted then like any other (`sweep`). Read from the engine's key today: an entry filed
   * before the instance had a key was bound without one and is deleted all the same.
   */
  keepsUnclearEntries(): boolean {
    return this.engine.hashIsKeyed;
  }

  /** How many entries wait for a decision (`pending` only), in a scope as {@link list} reads it. */
  countPending(scope: ApprovalListScope): number {
    const where = [`status = 'pending'`];
    const params: unknown[] = [];
    pushScopeFilter(where, params, scope);
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM approval_entries WHERE ${where.join(' AND ')}`)
      .get(...params) as { n: number }).n;
  }

  /**
   * Whether the stored payload is the one filed: the checksum recomputed over kind, the
   * decrypted payload and the origin. False when the payload does not decrypt or is gone.
   */
  checksumMatches(id: string): boolean {
    const r = this.db.prepare('SELECT kind, payload_json, origin_json, checksum FROM approval_entries WHERE id = ?')
      .get(id) as Pick<ApprovalDbRow, 'kind' | 'payload_json' | 'origin_json' | 'checksum'> | undefined;
    if (!r) return false;
    const payloadJson = this.engine.tryDec(r.payload_json);
    if (payloadJson === null) return false;
    return this.checksumOf(r.kind, payloadJson, r.origin_json) === r.checksum;
  }

  /**
   * The owner's decision. Approve needs a pending entry that has not expired (compared as
   * numbers in this transaction), is executable, and whose stored payload still matches both
   * its own checksum and the one the owner was shown. Reject takes a pending entry. Clearing
   * takes an `unknown` one: it is left `rejected` with reason `cleared_unknown`, which takes it
   * out of the dedup set, and a tombstone is deleted outright.
   */
  decide(id: string, decision: DecideAction, decidedBy: string, now: number = Date.now()): DecideResult {
    return this.db.transaction((): DecideResult => {
      const r = this.db.prepare('SELECT * FROM approval_entries WHERE id = ?').get(id) as ApprovalDbRow | undefined;
      if (!r) return { ok: false, reason: 'not_found' };
      if (decision.action === 'clear_unknown') {
        // Each statement takes only an `unknown` row (compare-and-set).
        if (r.tombstoned_at !== null) {
          const gone = this.db.prepare(`DELETE FROM approval_entries WHERE id = ? AND status = 'unknown'`).run(id);
          return gone.changes === 1 ? { ok: true } : { ok: false, reason: 'not_unknown' };
        }
        const res = this.db.prepare(
          `UPDATE approval_entries SET status = 'rejected', decided_at = ?, decided_by = ?, decided_reason = 'cleared_unknown', purge_after = ?
           WHERE id = ? AND status = 'unknown'`,
        ).run(iso(now), decidedBy, iso(now + APPROVAL_PURGE_AFTER_MS), id);
        return res.changes === 1 ? { ok: true } : { ok: false, reason: 'not_unknown' };
      }
      if (r.status !== 'pending') return { ok: false, reason: 'not_pending' };
      if (decision.action === 'reject') {
        const res = this.db.prepare(
          `UPDATE approval_entries SET status = 'rejected', decided_at = ?, decided_by = ?, decided_reason = ?, purge_after = ?
           WHERE id = ? AND status = 'pending'`,
        ).run(iso(now), decidedBy, decision.reason, iso(now + APPROVAL_PURGE_AFTER_MS), id);
        return res.changes === 1 ? { ok: true } : { ok: false, reason: 'not_pending' };
      }
      if (reached(r.expires_at, now)) return { ok: false, reason: 'expired' };
      if (!this.toEntry(r).executable) return { ok: false, reason: 'not_executable' };
      if (decision.checksum !== r.checksum || !this.checksumMatches(id)) return { ok: false, reason: 'checksum' };
      const res = this.db.prepare(
        `UPDATE approval_entries SET status = 'approved', decided_at = ?, decided_by = ?, decided_reason = NULL
         WHERE id = ? AND status = 'pending' AND checksum = ?`,
      ).run(iso(now), decidedBy, id, decision.checksum);
      return res.changes === 1 ? { ok: true } : { ok: false, reason: 'not_pending' };
    }).immediate();
  }

  /** The executor's hold over a send limit: a stamp on an approved entry, not a claim and not a
   *  status. A held entry lives until it expires. */
  hold(id: string, reason: string, now: number = Date.now()): boolean {
    return this.db.prepare(
      `UPDATE approval_entries SET held_reason = ?, held_at = ? WHERE id = ? AND status = 'approved'`,
    ).run(reason, iso(now), id).changes === 1;
  }

  /**
   * The approved entries the executor may try, in the order they were approved, at most `limit`:
   * one without a hold, one held by the send limit (it is checked again each time), and one held
   * for a retry once `retryDelayMs` has passed since its last attempt. Each with its kind; the
   * kinds in `skip` are left out, so the executor can pass over a kind the send limit holds and
   * go on with the others however many entries of that kind wait.
   */
  executable(
    now: number = Date.now(), limit = 200, retryDelayMs: number = APPROVAL_RETRY_DELAY_MS,
    skip: ReadonlySet<ApprovalKind> = new Set(),
  ): Array<{ id: string; kind: ApprovalKind }> {
    const kinds = APPROVAL_KINDS.filter((k) => !skip.has(k));
    if (kinds.length === 0) return [];
    return this.db.prepare(
      `SELECT id, kind FROM approval_entries WHERE status = 'approved' AND kind IN (${kinds.map(() => '?').join(', ')})
         AND (held_reason IS NULL OR held_reason = 'send_limit' OR (held_reason = 'retry' AND held_at <= ?))
       ORDER BY decided_at ASC, id ASC LIMIT ?`,
    ).all(...kinds, iso(now - retryDelayMs), limit) as Array<{ id: string; kind: ApprovalKind }>;
  }

  /** The send limit's hold on every approved entry of a kind that has none and has not expired:
   *  when the limit is reached for a kind, none of its entries is sent, and none expires in the
   *  claim window for having waited. Returns how many it stamped. */
  holdKind(kind: ApprovalKind, now: number = Date.now()): number {
    return this.db.transaction((): number => {
      const open = this.db.prepare(
        `SELECT id, expires_at FROM approval_entries WHERE status = 'approved' AND kind = ? AND held_reason IS NULL`,
      ).all(kind) as Array<{ id: string; expires_at: string }>;
      let stamped = 0;
      for (const r of open) if (!reached(r.expires_at, now)) stamped += this.hold(r.id, 'send_limit', now) ? 1 : 0;
      return stamped;
    }).immediate();
  }

  /** The executor's claim, `approved → executing`, before any side effect. Exactly one caller
   *  wins it. An entry at or past its expiry, or one this engine cannot execute, is not claimed. */
  claim(id: string, now: number = Date.now(), cap?: ClaimCap): ClaimResult {
    return this.db.transaction((): ClaimResult => {
      const r = this.db.prepare('SELECT * FROM approval_entries WHERE id = ?').get(id) as ApprovalDbRow | undefined;
      if (!r || r.status !== 'approved') return { ok: false, reason: 'not_claimable' };
      if (reached(r.expires_at, now)) return { ok: false, reason: 'expired' };
      if (!this.toEntry(r).executable) return { ok: false, reason: 'not_executable' };
      if (cap !== undefined) {
        const since = (ms: number): number => (this.db.prepare(
          `SELECT COUNT(*) AS n FROM approval_entries WHERE kind = ? AND status IN ('executing', 'done', 'unknown') AND claimed_at > ?`,
        ).get(r.kind, iso(now - ms)) as { n: number }).n;
        if (!cap.admits({ hour: since(60 * 60_000), day: since(24 * 60 * 60_000) })) {
          this.db.prepare(
            `UPDATE approval_entries SET held_reason = 'send_limit', held_at = ? WHERE id = ? AND status = 'approved'`,
          ).run(iso(now), id);
          return { ok: false, reason: 'held' };
        }
      }
      const res = this.db.prepare(
        `UPDATE approval_entries SET status = 'executing', claimed_at = ?, attempts = attempts + 1, held_reason = NULL, held_at = NULL
         WHERE id = ? AND status = 'approved'`,
      ).run(iso(now), id);
      if (res.changes !== 1) return { ok: false, reason: 'not_claimable' };
      const claimed = this.get(id);
      return claimed ? { ok: true, entry: claimed } : { ok: false, reason: 'not_claimable' };
    }).immediate();
  }

  /** The executor's outcome for an entry it claimed. `retry` returns it to `approved` with a
   *  `retry` hold while attempts remain, so the claim window does not expire it before its next
   *  attempt, and ends it `failed` after the last. Returns the status it ended in, or null when
   *  the entry was not `executing`. */
  finish(id: string, outcome: FinishOutcome, result: unknown, now: number = Date.now()): ApprovalStatus | null {
    return this.db.transaction((): ApprovalStatus | null => {
      const r = this.db.prepare('SELECT attempts, result_json FROM approval_entries WHERE id = ? AND status = \'executing\'')
        .get(id) as { attempts: number; result_json: string | null } | undefined;
      if (!r) return null;
      // Each attempt's result replaces the last, so the reason is the last attempt's. That a matching
      // mail went out shortly before an earlier attempt is kept beside it: a draft that met it is
      // not loaded into a chat to be written again (`chat-context.ts`).
      const resultJson = this.storedResult(dedupSeen(r.result_json === null ? null : this.engine.tryDec(r.result_json), result)
        ? { ...(typeof result === 'object' && result !== null ? result : {}), dedupSeen: true }
        : result);
      if (outcome === 'retry' && r.attempts < APPROVAL_MAX_ATTEMPTS) {
        this.db.prepare(
          `UPDATE approval_entries SET status = 'approved', claimed_at = NULL, held_reason = 'retry', held_at = ?, result_json = ?
           WHERE id = ? AND status = 'executing'`,
        ).run(iso(now), resultJson, id);
        return 'approved';
      }
      const status: ApprovalStatus = outcome === 'retry' ? 'failed' : outcome;
      this.db.prepare(
        `UPDATE approval_entries SET status = ?, executed_at = ?, result_json = ?, purge_after = ? WHERE id = ? AND status = 'executing'`,
      ).run(status, iso(now), resultJson, iso(now + APPROVAL_PURGE_AFTER_MS), id);
      return status;
    }).immediate();
  }

  /**
   * Expire, mark, tombstone and purge (§4.4, §4.8 step 6), whether the queue is on or not:
   * - a pending entry at its expiry expires (`ttl`);
   * - while the queue is on, a held approved entry expires at its expiry, with its hold's reason;
   * - an approved entry neither claimed nor held within the claim window, counted from the
   *   later of its decision and this engine's start, or at its expiry, expires (`claim_window`);
   *   while the queue is off, held entries too, with `flag_off`;
   * - a claim older than the stale limit becomes `unknown`, never retried;
   * - at `purge_after`, an `unknown` entry with keyed hashes becomes a tombstone, and every
   *   other entry is deleted.
   */
  sweep(input: SweepInput): SweepCounts {
    const now = input.now ?? Date.now();
    const purgeAfter = iso(now + APPROVAL_PURGE_AFTER_MS);
    const expire = this.db.prepare(
      `UPDATE approval_entries SET status = 'expired', result_json = ?, purge_after = ? WHERE id = ? AND status = ?`,
    );
    const reason = (r: string): string => this.storedResult({ reason: r });
    return this.db.transaction((): SweepCounts => {
      let expired = 0;
      const pending = this.db.prepare(`SELECT id, expires_at FROM approval_entries WHERE status = 'pending'`)
        .all() as Array<{ id: string; expires_at: string }>;
      for (const r of pending) {
        if (reached(r.expires_at, now)) expired += expire.run(reason('ttl'), purgeAfter, r.id, 'pending').changes;
      }
      const approved = this.db.prepare(
        `SELECT id, expires_at, decided_at, held_reason FROM approval_entries WHERE status = 'approved'`,
      ).all() as Array<{ id: string; expires_at: string; decided_at: string | null; held_reason: string | null }>;
      for (const r of approved) {
        // A hold keeps an entry past the claim window only while the queue is on; off, a held
        // entry expires like any other, so it is not sent when the queue is switched on again.
        if (r.held_reason !== null && input.flagOn) {
          if (reached(r.expires_at, now)) expired += expire.run(reason(r.held_reason), purgeAfter, r.id, 'approved').changes;
          continue;
        }
        // A decision time that does not parse makes the window's end NaN, which counts as reached.
        const windowEnd = Math.max(Date.parse(r.decided_at ?? ''), input.engineStartedAt) + APPROVAL_CLAIM_WINDOW_MS;
        if (!(windowEnd > now) || reached(r.expires_at, now)) {
          expired += expire.run(reason(input.flagOn ? 'claim_window' : 'flag_off'), purgeAfter, r.id, 'approved').changes;
        }
      }
      let unknown = 0;
      const executing = this.db.prepare(`SELECT id, claimed_at FROM approval_entries WHERE status = 'executing'`)
        .all() as Array<{ id: string; claimed_at: string | null }>;
      for (const r of executing) {
        // A claim time that is missing or does not parse counts as stale.
        if (Date.parse(r.claimed_at ?? '') + APPROVAL_CLAIM_STALE_MS > now) continue;
        unknown += this.db.prepare(
          `UPDATE approval_entries SET status = 'unknown', result_json = ?, purge_after = ? WHERE id = ? AND status = 'executing'`,
        ).run(reason('stale_claim'), purgeAfter, r.id).changes;
      }
      let tombstoned = 0;
      let purged = 0;
      const due = this.db.prepare(
        `SELECT id, status, binding, purge_after FROM approval_entries WHERE purge_after IS NOT NULL AND tombstoned_at IS NULL`,
      ).all() as Array<{ id: string; status: ApprovalStatus; binding: 'keyed' | 'unkeyed'; purge_after: string }>;
      for (const r of due) {
        if (!reached(r.purge_after, now)) continue;
        if (r.status === 'unknown' && r.binding === 'keyed') {
          tombstoned += this.db.prepare(
            `UPDATE approval_entries SET payload_json = '', result_json = NULL, purge_after = NULL, tombstoned_at = ?
             WHERE id = ? AND status = 'unknown'`,
          ).run(iso(now), r.id).changes;
        } else {
          purged += this.db.prepare('DELETE FROM approval_entries WHERE id = ?').run(r.id).changes;
        }
      }
      return { expired, unknown, tombstoned, purged };
    }).immediate();
  }
}
