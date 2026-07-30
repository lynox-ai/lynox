import type Database from 'better-sqlite3';
import type { EngineDb } from './engine-db.js';

/**
 * OnboardingFlagStore — the read/write layer over the engine.db `onboarding_flags`
 * table (Onboarding Wave 1, PRD-ONBOARDING §2.1). It is the server-side, cross-device
 * home for Layer-1 onboarding state, fixing the localStorage-local flow (§1 problem 1).
 *
 * Deliberately minimal: a per-(owner_user_id, flag) key-value store, one row per flag.
 * `value` is opaque non-secret TEXT — NEVER encrypted (nothing sensitive lands here),
 * and per-flag typed HERE, not by a DB CHECK (the DB only constrains the flag axis):
 *   · knowledge_done   → the onboarding thread-id (RF-IRR1); presence = completed
 *   · skipped          → the skip timestamp; presence = skipped
 *   · push_nudge       → 'asked_once' | 'declined' (Wave 2)
 *   · first_session_at → the first intro-card render-ack timestamp (Wave 1 write)
 *
 * The store is UNCONDITIONAL — it does NOT gate on `durable_memory_enabled`. Onboarding
 * runs whether or not DK is on, and engine.db is always opened, so this store is present
 * whenever engine.db is (the null-store fail-open path lives one level up, at the
 * HTTP/flow layer: a degraded engine.db means "onboarding counts as done", never a
 * re-nag — PRD AC-1.7 / §2.1 degrade rule).
 *
 * owner_user_id follows the `subjects` precedent (`DEFAULT 'system'`): single-operator
 * today, user-scoped by key, multi-user-proof without a later migration (D8).
 */

/** The closed set of onboarding flags. Forward-complete with the DB CHECK enum so a
 *  wire-supplied flag can be validated before it reaches SQL. */
export type OnboardingFlag = 'knowledge_done' | 'skipped' | 'push_nudge' | 'first_session_at';

export const ONBOARDING_FLAGS: readonly OnboardingFlag[] = [
  'knowledge_done',
  'skipped',
  'push_nudge',
  'first_session_at',
] as const;

/** True when `s` is a known onboarding flag. The wire boundary uses this to reject an
 *  unknown flag with a 400 BEFORE it hits the DB CHECK (defense in depth — the CHECK
 *  would throw too, but a validated 400 is the honest response). */
export function isOnboardingFlag(s: string): s is OnboardingFlag {
  return (ONBOARDING_FLAGS as readonly string[]).includes(s);
}

/** The default (and, today, only) onboarding owner — the single operator. Mirrors the
 *  `subjects.owner_user_id DEFAULT 'system'` schema default (engine-db.ts v1). */
export const DEFAULT_ONBOARDING_OWNER = 'system';

/** A glanceable summary of one owner's onboarding state — the shape the GET status
 *  endpoint and the Layer-1 flow read. Booleans derive from row presence; the raw
 *  values carry the durable links (thread-id, nudge state, timestamp). */
export interface OnboardingStatus {
  /** knowledge_done row present (completion). */
  readonly knowledgeDone: boolean;
  /** The onboarding thread-id recorded with completion (RF-IRR1), or null when absent. */
  readonly knowledgeThreadId: string | null;
  /** skipped row present. */
  readonly skipped: boolean;
  /** push_nudge state ('asked_once' | 'declined'), or null when never asked (Wave 2). */
  readonly pushNudge: string | null;
  /** first intro-card render-ack timestamp, or null before the first ack (DC4). */
  readonly firstSessionAt: string | null;
}

interface FlagRow {
  flag: string;
  value: string;
}

export class OnboardingFlagStore {
  private readonly db: Database.Database;

  constructor(engine: EngineDb) {
    this.db = engine.getDb();
  }

  /** Read one flag's value, or null when the row is absent. */
  get(flag: OnboardingFlag, ownerUserId: string = DEFAULT_ONBOARDING_OWNER): string | null {
    const row = this.db
      .prepare('SELECT value FROM onboarding_flags WHERE owner_user_id = ? AND flag = ?')
      .get(ownerUserId, flag) as { value: string } | undefined;
    return row ? row.value : null;
  }

  /**
   * Set (upsert) a flag. `ON CONFLICT DO UPDATE` (not INSERT OR REPLACE) so a future
   * inbound FK is never tripped by delete+reinsert and `updated_at` refreshes on every
   * write. `value` defaults to '' — presence, not the value, is the completion signal
   * for knowledge_done/skipped; the value carries the durable link (thread-id / state).
   */
  set(flag: OnboardingFlag, value: string = '', ownerUserId: string = DEFAULT_ONBOARDING_OWNER): void {
    this.db
      .prepare(`
        INSERT INTO onboarding_flags (owner_user_id, flag, value)
        VALUES (?, ?, ?)
        ON CONFLICT(owner_user_id, flag) DO UPDATE SET
          value = excluded.value,
          updated_at = datetime('now')
      `)
      .run(ownerUserId, flag, value);
  }

  /** Delete a flag row (the Settings per-layer reactivation path, AC-1.5). Returns
   *  whether a row was removed (false = it was already absent — an idempotent no-op). */
  reset(flag: OnboardingFlag, ownerUserId: string = DEFAULT_ONBOARDING_OWNER): boolean {
    const info = this.db
      .prepare('DELETE FROM onboarding_flags WHERE owner_user_id = ? AND flag = ?')
      .run(ownerUserId, flag);
    return info.changes > 0;
  }

  /** The glanceable status summary for one owner (a single scan of the owner's rows). */
  getStatus(ownerUserId: string = DEFAULT_ONBOARDING_OWNER): OnboardingStatus {
    const rows = this.db
      .prepare('SELECT flag, value FROM onboarding_flags WHERE owner_user_id = ?')
      .all(ownerUserId) as FlagRow[];
    const byFlag = new Map<string, string>();
    for (const r of rows) byFlag.set(r.flag, r.value);
    const knowledgeThreadId = byFlag.get('knowledge_done');
    return {
      knowledgeDone: byFlag.has('knowledge_done'),
      // The thread-id is the stored value; an empty value (degraded write) still counts
      // as done but carries no repair link — surfaced as null, not ''.
      knowledgeThreadId: knowledgeThreadId ? knowledgeThreadId : null,
      skipped: byFlag.has('skipped'),
      pushNudge: byFlag.get('push_nudge') ?? null,
      firstSessionAt: byFlag.get('first_session_at') ?? null,
    };
  }
}
