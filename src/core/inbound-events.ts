/**
 * The ledger of verified inbound webhook deliveries (`inbound_events`, engine.db v47).
 *
 * Recording is what the receiver's 200 means: the insert either adds a row (a new event) or
 * meets the unique `dedup_key` (a delivery whose signed content is already here, which starts
 * nothing). The key is unique per instance, not per trigger, because one provider secret
 * verifies at every trigger of that provider: a body recorded at one trigger is a duplicate at
 * all of them.
 *
 * Rows move `received` → `running` → `done` | `failed` | `dropped`. This module writes only the
 * first state; the drain that runs events owns the others. Nothing here deletes a row, and no
 * boot sweep touches the table: a `received` row survives a restart and runs after it.
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
}

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
}

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
      // personal data (an order's name and address), so they are kept encrypted.
      input.state === 'received' && input.values !== undefined ? this.engine.enc(JSON.stringify(input.values)) : null,
      JSON.stringify(input.headers), now,
    );
    return info.changes === 1 ? 'recorded' : 'duplicate';
  }

  /** A trigger's events, oldest first. */
  listByTrigger(triggerId: string): InboundEventRecord[] {
    const rows = this.db.prepare(
      `SELECT id, trigger_id, dedup_key, received_at, state, reason, run_id, values_json, headers_json
       FROM inbound_events WHERE trigger_id = ? ORDER BY received_at ASC, id ASC`,
    ).all(triggerId) as InboundEventDbRow[];
    return rows.map((r) => ({
      id: r.id,
      triggerId: r.trigger_id,
      dedupKey: r.dedup_key,
      receivedAt: r.received_at,
      state: r.state,
      reason: r.reason,
      runId: r.run_id,
      valuesJson: r.values_json === null ? null : this.engine.dec(r.values_json),
      headersJson: r.headers_json,
    }));
  }

  /** How many events the instance holds, over all triggers. */
  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS c FROM inbound_events').get() as { c: number }).c;
  }
}
