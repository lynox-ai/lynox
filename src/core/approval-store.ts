/**
 * The approval queue's store (`approval_entries`, engine.db v48): a mail that a run nobody
 * watches wanted to send, kept for its owner to send or discard.
 *
 * An entry binds the exact effect. `payload_json` (encrypted at rest), `origin_json` and
 * `checksum` are written once, at filing, and nothing here updates them (I2). The checksum is a
 * `keyedHash` over kind, payload and origin, so a payload that differs from the one filed is
 * caught before it is sent; the lock does not depend on the key's secrecy, it catches a
 * display that differs from the payload.
 *
 * Each status has one writer, and each writer is one method here (I1):
 * - the filer inserts `pending` ({@link ApprovalStore.file}), never another status;
 * - the decide route writes `approved` and `rejected` ({@link ApprovalStore.decide});
 * - the executor writes `executing`, then `done`, `failed` or `unknown`
 *   ({@link ApprovalStore.claim}, {@link ApprovalStore.finish}), and stamps a hold without
 *   claiming ({@link ApprovalStore.hold});
 * - the sweep writes `expired`, turns a stale claim into `unknown` and deletes
 *   ({@link ApprovalStore.sweep}).
 * Absence is never yes (I3): an expired, rejected or failed entry is not sent. At most once
 * (I4): `approved → executing` is a compare-and-set before any side effect, an `unknown`
 * outcome is never retried, and only a provably-not-sent failure goes back to `approved`.
 *
 * The dedup set refuses a second filing of the same mail. The keys are derived here from the
 * payload and stored only as keyed hashes, because they hold recipients and subjects.
 *
 * Nothing here sends, and nothing calls this store yet: filing and executing are wired later.
 */

import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { EngineDb } from './engine-db.js';
import { isFeatureEnabled } from './features.js';

export type ApprovalKind = 'mail_reply' | 'mail_send';

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
  original: { from: string; to: string[]; cc: string[]; subject: string; date: string };
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
  trackFollowup: boolean;
}

export type ApprovalFiling =
  | { kind: 'mail_reply'; payload: MailReplyPayload }
  | { kind: 'mail_send'; payload: MailSendPayload };

export interface FileApprovalInput {
  filing: ApprovalFiling;
  origin: ApprovalOrigin;
  createdBy: string | null;
  mandateId: string | null;
  now?: number | undefined;
}

/** Why a filing was refused as a duplicate, with the entry it met. */
export type DuplicateReason = 'waiting' | 'unknown' | 'sent' | 'discarded';

export type FileResult =
  | { ok: true; id: string }
  | { ok: false; reason: DuplicateReason; existingId: string };

/**
 * An entry as read. `origin` is null and `executable` false when the stored origin is not one
 * this engine knows (a source added by a later version, a damaged row), when the payload does
 * not decrypt or parse, or when it does not match its kind: such an entry is shown, never sent.
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
  resultJson: string | null;
  purgeAfter: string | null;
}

export const APPROVAL_TTL_MS = 72 * 60 * 60_000;
/** An approved entry the executor neither claimed nor held within this much of its uptime expires. */
export const APPROVAL_CLAIM_WINDOW_MS = 60 * 60_000;
/** A claim older than this belongs to a process that stopped mid-send (as the scheduled send's). */
export const APPROVAL_CLAIM_STALE_MS = 15 * 60_000;
export const APPROVAL_PURGE_AFTER_MS = 30 * 24 * 60 * 60_000;
export const APPROVAL_MAX_ATTEMPTS = 3;
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
}

const iso = (ms: number): string => new Date(ms).toISOString();

/** Lower-cased, trimmed, de-duplicated and sorted addresses, as the send dedup builds them. */
function recipientList(...lists: ReadonlyArray<ReadonlyArray<StoredAddress>>): string {
  const all = lists.flatMap(l => l.map(a => a.address.toLowerCase().trim()));
  return Array.from(new Set(all)).sort().join(',');
}

const normalisedSubject = (s: string): string => s.trim().toLowerCase();

/** The plain dedup and family keys of a filing (§4.3a), before they are hashed for storage. */
export function approvalKeys(filing: ApprovalFiling, origin: ApprovalOrigin): { dedupKey: string; familyKey: string | null } {
  if (filing.kind === 'mail_reply') {
    const p = filing.payload;
    const message = p.originalMessageId !== undefined && p.originalMessageId !== ''
      ? p.originalMessageId
      : p.originalFolderUid;
    return { dedupKey: `mail_reply|${p.accountId}|${message}`, familyKey: null };
  }
  const p = filing.payload;
  const recipients = recipientList(p.to, p.cc, p.bcc);
  const subject = normalisedSubject(p.subject);
  const body = createHash('sha256').update(p.bodyText, 'utf8').digest('hex');
  const event = origin.eventId ?? origin.runId;
  return {
    dedupKey: `mail_send|${event}|${recipients}|${subject}|${body}`,
    familyKey: `mail_send|${p.accountId}|${recipients}|${subject}`,
  };
}

function isAddressList(v: unknown): v is StoredAddress[] {
  return Array.isArray(v) && v.every(a => typeof a === 'object' && a !== null && typeof (a as { address?: unknown }).address === 'string');
}

/** The stored origin, or null when it is not one this engine knows. */
function readOrigin(json: string): ApprovalOrigin | null {
  let v: unknown;
  try { v = JSON.parse(json); } catch { return null; }
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o['source'] !== 'string' || !KNOWN_SOURCES.has(o['source'])) return null;
  if (typeof o['triggerId'] !== 'string' || typeof o['runId'] !== 'string' || typeof o['rootRunId'] !== 'string') return null;
  if (o['eventId'] !== undefined && typeof o['eventId'] !== 'string') return null;
  if (o['threadId'] !== undefined && typeof o['threadId'] !== 'string') return null;
  return o as unknown as ApprovalOrigin;
}

/** The stored payload for its kind, or null when it does not parse or does not fit the kind. */
function readFiling(kind: ApprovalKind, json: string | null): ApprovalFiling | null {
  if (json === null) return null;
  let v: unknown;
  try { v = JSON.parse(json); } catch { return null; }
  if (typeof v !== 'object' || v === null) return null;
  const p = v as Record<string, unknown>;
  const common = typeof p['accountId'] === 'string' && typeof p['fromAddress'] === 'string'
    && isAddressList(p['to']) && isAddressList(p['cc'])
    && typeof p['subject'] === 'string' && typeof p['bodyText'] === 'string';
  if (!common) return null;
  if (kind === 'mail_reply') {
    if (typeof p['originalThreadKey'] !== 'string' || typeof p['originalFolderUid'] !== 'string') return null;
    if (typeof p['original'] !== 'object' || p['original'] === null) return null;
    return { kind, payload: p as unknown as MailReplyPayload };
  }
  if (!isAddressList(p['bcc']) || typeof p['trackFollowup'] !== 'boolean') return null;
  return { kind, payload: p as unknown as MailSendPayload };
}

export type DecideAction =
  | { action: 'approve'; checksum: string }
  | { action: 'reject'; reason: 'owner' | 'moved_to_chat' }
  | { action: 'clear_unknown' };

export type DecideResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'not_pending' | 'not_unknown' | 'expired' | 'checksum' | 'not_executable' };

export type ClaimResult =
  | { ok: true; entry: ApprovalEntry }
  | { ok: false; reason: 'not_claimable' | 'not_executable' };

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
  purged: number;
}

export class ApprovalStore {
  private readonly db: Database.Database;

  constructor(private readonly engine: EngineDb) {
    this.db = engine.getDb();
  }

  private checksumOf(kind: ApprovalKind, payloadJson: string, originJson: string): string {
    return this.engine.keyedHash(['approval-entry-v1', kind, payloadJson, originJson]);
  }

  private storedKey(plain: string): string {
    return this.engine.keyedHash(['approval-dedup-v1', plain]);
  }

  /**
   * File an entry as `pending`, or refuse it as a duplicate. The dedup set (§4.2): an entry
   * with the same key that is pending, approved, executing or unknown, at any age; one sent
   * within the kind's window; or one the owner discarded within it, except one cleared after
   * an unknown outcome. For `mail_send` the sent and discarded ones are looked up by family.
   */
  file(input: FileApprovalInput): FileResult {
    const now = input.now ?? Date.now();
    const { filing, origin } = input;
    const payloadJson = JSON.stringify(filing.payload);
    const originJson = JSON.stringify(origin);
    const keys = approvalKeys(filing, origin);
    const dedupKey = this.storedKey(keys.dedupKey);
    const familyKey = keys.familyKey === null ? null : this.storedKey(keys.familyKey);
    const windowStart = iso(now - APPROVAL_DEDUP_WINDOW_MS[filing.kind]);

    return this.db.transaction((): FileResult => {
      const active = this.db.prepare(
        `SELECT id, status FROM approval_entries WHERE dedup_key = ? AND status IN ${ACTIVE_STATUSES} LIMIT 1`,
      ).get(dedupKey) as { id: string; status: ApprovalStatus } | undefined;
      if (active) return { ok: false, reason: active.status === 'unknown' ? 'unknown' : 'waiting', existingId: active.id };

      const keyColumn = familyKey === null ? 'dedup_key' : 'family_key';
      const ended = this.db.prepare(
        `SELECT id, status FROM approval_entries WHERE ${keyColumn} = ? AND (
           (status = 'done' AND executed_at > ?)
           OR (status = 'rejected' AND decided_at > ? AND decided_reason IS NOT 'cleared_unknown'))
         ORDER BY created_at DESC LIMIT 1`,
      ).get(familyKey ?? dedupKey, windowStart, windowStart) as { id: string; status: ApprovalStatus } | undefined;
      if (ended) return { ok: false, reason: ended.status === 'done' ? 'sent' : 'discarded', existingId: ended.id };

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
      resultJson: r.result_json,
      purgeAfter: r.purge_after,
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
   * Whether the stored payload is the one filed: the checksum recomputed over kind, the
   * decrypted payload and the origin. False when the payload does not decrypt.
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
   * its own checksum and the one the owner was shown. Reject takes a pending entry; clearing
   * takes an `unknown` one and leaves it `rejected` with reason `cleared_unknown`, which takes
   * it out of the dedup set.
   */
  decide(id: string, decision: DecideAction, decidedBy: string, now: number = Date.now()): DecideResult {
    return this.db.transaction((): DecideResult => {
      const r = this.db.prepare('SELECT * FROM approval_entries WHERE id = ?').get(id) as ApprovalDbRow | undefined;
      if (!r) return { ok: false, reason: 'not_found' };
      if (decision.action === 'clear_unknown') {
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
      if (Date.parse(r.expires_at) <= now) return { ok: false, reason: 'expired' };
      if (!this.toEntry(r).executable) return { ok: false, reason: 'not_executable' };
      if (decision.checksum !== r.checksum || !this.checksumMatches(id)) return { ok: false, reason: 'checksum' };
      const res = this.db.prepare(
        `UPDATE approval_entries SET status = 'approved', decided_at = ?, decided_by = ?, decided_reason = NULL
         WHERE id = ? AND status = 'pending'`,
      ).run(iso(now), decidedBy, id);
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

  /** The executor's claim, `approved → executing`, before any side effect. Exactly one caller
   *  wins it. An entry this engine cannot execute is not claimed. */
  claim(id: string, now: number = Date.now()): ClaimResult {
    return this.db.transaction((): ClaimResult => {
      const r = this.db.prepare('SELECT * FROM approval_entries WHERE id = ?').get(id) as ApprovalDbRow | undefined;
      if (!r || r.status !== 'approved') return { ok: false, reason: 'not_claimable' };
      if (!this.toEntry(r).executable) return { ok: false, reason: 'not_executable' };
      const res = this.db.prepare(
        `UPDATE approval_entries SET status = 'executing', claimed_at = ?, attempts = attempts + 1, held_reason = NULL, held_at = NULL
         WHERE id = ? AND status = 'approved'`,
      ).run(iso(now), id);
      if (res.changes !== 1) return { ok: false, reason: 'not_claimable' };
      const claimed = this.get(id);
      return claimed ? { ok: true, entry: claimed } : { ok: false, reason: 'not_claimable' };
    }).immediate();
  }

  /** The executor's outcome for an entry it claimed. `retry` returns it to `approved` while
   *  attempts remain, and ends it `failed` after the last. Returns the status it ended in, or
   *  null when the entry was not `executing`. */
  finish(id: string, outcome: FinishOutcome, result: unknown, now: number = Date.now()): ApprovalStatus | null {
    return this.db.transaction((): ApprovalStatus | null => {
      const r = this.db.prepare('SELECT attempts FROM approval_entries WHERE id = ? AND status = \'executing\'')
        .get(id) as { attempts: number } | undefined;
      if (!r) return null;
      const resultJson = JSON.stringify(result ?? null);
      if (outcome === 'retry' && r.attempts < APPROVAL_MAX_ATTEMPTS) {
        this.db.prepare(
          `UPDATE approval_entries SET status = 'approved', claimed_at = NULL, result_json = ? WHERE id = ? AND status = 'executing'`,
        ).run(resultJson, id);
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
   * Expire, mark and purge (§4.4, §4.8 step 6), whether the queue is on or not:
   * - a pending entry past `expires_at` expires (`ttl`);
   * - a held approved entry past `expires_at` expires with its hold's reason;
   * - an approved entry neither claimed nor held within the claim window, counted from the
   *   later of its decision and this engine's start, expires (`claim_window`, or `flag_off`
   *   while the queue is off);
   * - a claim older than the stale limit becomes `unknown`, never retried;
   * - an entry past `purge_after` is deleted.
   */
  sweep(input: SweepInput): SweepCounts {
    const now = input.now ?? Date.now();
    const nowIso = iso(now);
    const purgeAfter = iso(now + APPROVAL_PURGE_AFTER_MS);
    const expire = this.db.prepare(
      `UPDATE approval_entries SET status = 'expired', result_json = ?, purge_after = ? WHERE id = ? AND status = ?`,
    );
    return this.db.transaction((): SweepCounts => {
      let expired = 0;
      const pending = this.db.prepare(`SELECT id, expires_at FROM approval_entries WHERE status = 'pending'`)
        .all() as Array<{ id: string; expires_at: string }>;
      for (const r of pending) {
        if (Date.parse(r.expires_at) <= now) expired += expire.run(JSON.stringify({ reason: 'ttl' }), purgeAfter, r.id, 'pending').changes;
      }
      const approved = this.db.prepare(
        `SELECT id, expires_at, decided_at, held_reason FROM approval_entries WHERE status = 'approved'`,
      ).all() as Array<{ id: string; expires_at: string; decided_at: string | null; held_reason: string | null }>;
      for (const r of approved) {
        if (r.held_reason !== null) {
          if (Date.parse(r.expires_at) <= now) expired += expire.run(JSON.stringify({ reason: r.held_reason }), purgeAfter, r.id, 'approved').changes;
          continue;
        }
        const decided = r.decided_at === null ? 0 : Date.parse(r.decided_at);
        const windowStart = Math.max(decided, input.engineStartedAt);
        if (windowStart + APPROVAL_CLAIM_WINDOW_MS <= now || Date.parse(r.expires_at) <= now) {
          const reason = input.flagOn ? 'claim_window' : 'flag_off';
          expired += expire.run(JSON.stringify({ reason }), purgeAfter, r.id, 'approved').changes;
        }
      }
      const unknown = this.db.prepare(
        `UPDATE approval_entries SET status = 'unknown', result_json = ?, purge_after = ?
         WHERE status = 'executing' AND claimed_at < ?`,
      ).run(JSON.stringify({ reason: 'stale_claim' }), purgeAfter, iso(now - APPROVAL_CLAIM_STALE_MS)).changes;
      const purged = this.db.prepare(
        `DELETE FROM approval_entries WHERE purge_after IS NOT NULL AND purge_after <= ?`,
      ).run(nowIso).changes;
      return { expired, unknown, purged };
    }).immediate();
  }
}
