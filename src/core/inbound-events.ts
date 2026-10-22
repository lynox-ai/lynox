/**
 * The ledger of verified inbound webhook deliveries (`inbound_events`, engine.db v47).
 *
 * Recording is what the receiver's 200 means: the insert either adds a row (a new event) or
 * meets the unique `dedup_key` (a delivery whose signed content is already here, which starts
 * nothing). The key is unique per instance, not per trigger, because one provider secret
 * verifies at every trigger of that provider: a body recorded at one trigger is a duplicate at
 * all of them.
 *
 * Rows move `received` → `running` → `done` | `failed` | `dropped`, or `received` → `dropped`
 * when the drain refuses to run one. The receiver writes the first state; the drain, under the
 * trigger's lease, the others, each move a compare-and-set on the state it expects, so a writer
 * that lost the race changes nothing ([R2-2]). Nothing here deletes a row, and no boot sweep
 * touches the table: a `received` row survives a restart and runs after it, and a `running` row
 * a lost process left behind is reported once as of unknown outcome, never run again by itself.
 */

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { EngineDb } from './engine-db.js';
import type { MappedValues } from './webhook-verifiers.js';

export type InboundEventState = 'received' | 'running' | 'done' | 'failed' | 'dropped';

export interface InboundEventRecord {
  id: string;
  triggerId: string;
  dedupKey: string;
  receivedAt: string;
  state: InboundEventState;
  reason: string | null;
  runId: string | null;
  valuesJson: string | null;
  headersJson: string;
  /** The run attempt a `running` event belongs to. */
  attemptId: string | null;
  /** Its values are stored but cannot be read with this instance's key; `valuesJson` is null then. */
  valuesUnreadable: boolean;
  reportedAt: string | null;
  unknownReportedAt: string | null;
}

/** How a run of an event ended, as the drain writes it. */
export type EventOutcome =
  | { state: 'done'; runId?: string | undefined }
  | { state: 'failed'; reason: string; runId?: string | undefined }
  | { state: 'dropped'; reason: string };

export interface RecordDelivery {
  triggerId: string;
  dedupKey: string;
  /** The delivery's evidence headers (never the signature itself). */
  headers: Readonly<Record<string, string>>;
  /** `dropped` for a verified delivery the receiver itself refuses to run, with its reason. */
  state: 'received' | 'dropped';
  reason?: string | undefined;
  /** The values the trigger's mapping read out of the verified body (`received` only). */
  values?: MappedValues | undefined;
  now?: string | undefined;
}

interface InboundEventDbRow {
  id: string;
  trigger_id: string;
  dedup_key: string;
  received_at: string;
  state: InboundEventState;
  reason: string | null;
  run_id: string | null;
  values_json: string | null;
  headers_json: string;
  attempt_id: string | null;
  reported_at: string | null;
  unknown_reported_at: string | null;
}

const COLUMNS = 'id, trigger_id, dedup_key, received_at, state, reason, run_id, values_json, headers_json, attempt_id, reported_at, unknown_reported_at';

export class InboundEventStore {
  private readonly db: Database.Database;

  constructor(private readonly engine: EngineDb) {
    this.db = engine.getDb();
  }

  /** Whether a delivery with this dedup key is recorded already, at any trigger. */
  has(dedupKey: string): boolean {
    return this.db.prepare('SELECT 1 FROM inbound_events WHERE dedup_key = ?').get(dedupKey) !== undefined;
  }

  /**
   * Record one verified delivery. `recorded` when it is new; `duplicate` when a row with the
   * same `dedup_key` exists already, whatever its trigger or state, and then nothing changes.
   */
  record(input: RecordDelivery): 'recorded' | 'duplicate' {
    const now = input.now ?? new Date().toISOString();
    const info = this.db.prepare(
      `INSERT INTO inbound_events (id, trigger_id, dedup_key, received_at, state, reason, values_json, headers_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(dedup_key) DO NOTHING`,
    ).run(
      randomUUID(), input.triggerId, input.dedupKey, now, input.state, input.reason ?? null,
      // A dropped event runs nothing, so its values are not kept. They are a third party's
      // personal data (an order's name and address), so they are encrypted like the other
      // engine.db fields: with the vault key, and as plain text by an engine without one.
      input.state === 'received' && input.values !== undefined ? this.engine.enc(JSON.stringify(input.values)) : null,
      JSON.stringify(input.headers), now,
    );
    return info.changes === 1 ? 'recorded' : 'duplicate';
  }

  /** A trigger's events, oldest first. */
  listByTrigger(triggerId: string): InboundEventRecord[] {
    const rows = this.db.prepare(
      `SELECT ${COLUMNS} FROM inbound_events WHERE trigger_id = ? ORDER BY received_at ASC, id ASC`,
    ).all(triggerId) as InboundEventDbRow[];
    return rows.map((r) => this.#toRecord(r));
  }

  /**
   * The triggers with something for the drain: an event to run, a dropped one not reported yet,
   * or a `running` one not reported yet (a run of this process writes its outcome before its
   * lease is free, so under the lease such a row is one a lost process left behind).
   */
  triggersWithWork(): string[] {
    return (this.db.prepare(
      `SELECT DISTINCT trigger_id FROM inbound_events
       WHERE state = 'received'
          OR (state IN ('dropped', 'failed') AND reported_at IS NULL)
          OR (state = 'running' AND unknown_reported_at IS NULL)
       ORDER BY trigger_id`,
    ).all() as Array<{ trigger_id: string }>).map((r) => r.trigger_id);
  }

  /** The trigger's oldest event not run yet. */
  oldestReceived(triggerId: string): InboundEventRecord | undefined {
    const row = this.db.prepare(
      `SELECT ${COLUMNS} FROM inbound_events WHERE trigger_id = ? AND state = 'received'
       ORDER BY received_at ASC, id ASC LIMIT 1`,
    ).get(triggerId) as InboundEventDbRow | undefined;
    return row === undefined ? undefined : this.#toRecord(row);
  }

  /** `received` → `running` under `attemptId`; false when the row is no longer `received`. */
  begin(id: string, attemptId: string, now = new Date().toISOString()): boolean {
    return this.db.prepare(
      `UPDATE inbound_events SET state = 'running', attempt_id = ?, updated_at = ? WHERE id = ? AND state = 'received'`,
    ).run(attemptId, now, id).changes === 1;
  }

  /**
   * Write the outcome of the run of attempt `attemptId`; false when the row is not that
   * attempt's `running` any more, and then nothing changes. `done` and `dropped` clear the
   * values, which nothing will read again; `failed` keeps them for a run again.
   */
  finish(id: string, attemptId: string, outcome: EventOutcome, now = new Date().toISOString()): boolean {
    const clear = outcome.state !== 'failed';
    return this.db.prepare(
      `UPDATE inbound_events SET state = ?, reason = ?, run_id = COALESCE(?, run_id), updated_at = ?${clear ? ', values_json = NULL' : ''}
       WHERE id = ? AND state = 'running' AND attempt_id = ?`,
    ).run(outcome.state, outcome.state === 'done' ? null : outcome.reason, 'runId' in outcome ? outcome.runId ?? null : null, now, id, attemptId).changes === 1;
  }

  /** `received` → `dropped` with its reason, before any run; its values are cleared. */
  drop(id: string, reason: string, now = new Date().toISOString()): boolean {
    return this.db.prepare(
      `UPDATE inbound_events SET state = 'dropped', reason = ?, values_json = NULL, updated_at = ? WHERE id = ? AND state = 'received'`,
    ).run(reason, now, id).changes === 1;
  }

  /**
   * Drop every event of a trigger that waits to run, with its values: a trigger that no longer
   * accepts events leaves nothing waiting for it (PRD inbound-webhooks §5 item 9, [m8]).
   */
  dropWaiting(triggerId: string, reason: string, now = new Date().toISOString()): number {
    return this.db.prepare(
      `UPDATE inbound_events SET state = 'dropped', reason = ?, values_json = NULL, updated_at = ? WHERE trigger_id = ? AND state = 'received'`,
    ).run(reason, now, triggerId).changes;
  }

  /** How many of the trigger's events wait to run. */
  countWaiting(triggerId: string): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM inbound_events WHERE trigger_id = ? AND state = 'received'`).get(triggerId) as { n: number }).n;
  }

  /**
   * Turn `done` and `dropped` events received before `before` into tombstones: what they held
   * (headers, reason, run id, values) is cleared, and the row stays with its trigger, dedup key,
   * state and time. The key is the replay protection — Shopify's HMAC carries no time, so a
   * captured body whose row were gone would run again — and it is kept for good (sec-core,
   * review of 2b; PRD inbound-webhooks §4.3 as amended 2026-10-22). Tombstones grow only with
   * verified new deliveries. A dropped row becomes one only once it was reported, so its reason
   * reaches the owner first.
   */
  tombstoneRows(before: string): number {
    return this.db.prepare(
      `UPDATE inbound_events SET headers_json = '{}', reason = NULL, run_id = NULL, values_json = NULL, attempt_id = NULL
       WHERE state IN ('done', 'dropped') AND received_at < ?
         AND (state = 'done' OR reported_at IS NOT NULL)
         AND (headers_json <> '{}' OR reason IS NOT NULL OR run_id IS NOT NULL OR values_json IS NOT NULL OR attempt_id IS NOT NULL)`,
    ).run(before).changes;
  }

  /** The trigger's dropped and failed events not reported to the owner yet, oldest first. */
  unreportedEnds(triggerId: string): InboundEventRecord[] {
    return (this.db.prepare(
      `SELECT ${COLUMNS} FROM inbound_events WHERE trigger_id = ? AND state IN ('dropped', 'failed') AND reported_at IS NULL
       ORDER BY received_at ASC, id ASC`,
    ).all(triggerId) as InboundEventDbRow[]).map((r) => this.#toRecord(r));
  }

  /** The trigger's `running` events whose outcome nobody reported, oldest first. */
  unreportedRunning(triggerId: string): InboundEventRecord[] {
    return (this.db.prepare(
      `SELECT ${COLUMNS} FROM inbound_events WHERE trigger_id = ? AND state = 'running' AND unknown_reported_at IS NULL
       ORDER BY received_at ASC, id ASC`,
    ).all(triggerId) as InboundEventDbRow[]).map((r) => this.#toRecord(r));
  }

  /** Mark a dropped or failed event reported; false when it was already. */
  markReported(id: string, now = new Date().toISOString()): boolean {
    return this.db.prepare(
      `UPDATE inbound_events SET reported_at = ? WHERE id = ? AND state IN ('dropped', 'failed') AND reported_at IS NULL`,
    ).run(now, id).changes === 1;
  }

  /** Mark a `running` event reported as of unknown outcome; false when it was already. */
  markUnknownReported(id: string, now = new Date().toISOString()): boolean {
    return this.db.prepare(
      `UPDATE inbound_events SET unknown_reported_at = ? WHERE id = ? AND state = 'running' AND unknown_reported_at IS NULL`,
    ).run(now, id).changes === 1;
  }

  /**
   * Clear the values of events received before `before` that kept them (`failed`, and `running`
   * of unknown outcome): past the window in which they can run again, the owner's customers'
   * data is not kept for nothing (PRD inbound-webhooks §4.3). The rows stay. A `received` event
   * keeps its values however long it waits: it has not run, and it runs with them.
   */
  sweepValues(before: string): number {
    return this.db.prepare(
      `UPDATE inbound_events SET values_json = NULL
       WHERE values_json IS NOT NULL AND state IN ('failed', 'running') AND received_at < ?`,
    ).run(before).changes;
  }

  #toRecord(r: InboundEventDbRow): InboundEventRecord {
    const values = r.values_json === null ? null : this.engine.tryDec(r.values_json);
    return {
      id: r.id,
      triggerId: r.trigger_id,
      dedupKey: r.dedup_key,
      receivedAt: r.received_at,
      state: r.state,
      reason: r.reason,
      runId: r.run_id,
      valuesJson: values,
      valuesUnreadable: r.values_json !== null && values === null,
      headersJson: r.headers_json,
      attemptId: r.attempt_id,
      reportedAt: r.reported_at,
      unknownReportedAt: r.unknown_reported_at,
    };
  }

  /** How many events the instance holds, over all triggers. */
  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS c FROM inbound_events').get() as { c: number }).c;
  }
}
