/**
 * When each mandate ends, as far as this engine has been told (PRD customer-granted-operator-access
 * §3.13 B9, Bau-Auflage 1).
 *
 * A mandate's session cookie ends after at most 15 minutes, so the cookie's own `exp` is the end
 * of a session, not of the mandate. The web UI signs the mandate's end into the session principal
 * as well (`mandate_exp`), read from the control plane at login, and every verified request of a
 * mandate records it here. What reads this later runs without a request of the mandate — a
 * stamped run resolving a connection the mandate made — so the end has to be stored, not taken
 * from a cookie.
 *
 * Keyed by `mandate_id`, not by address: a later mandate for the same address is another grant
 * and does not inherit what the earlier one left.
 *
 * The latest login wins, not the latest end: a cookie signed later carries what the control plane
 * said later, so a change reaches the engine with the mandate's next login, whichever way it moved
 * the end. A request of an older session still running alongside cannot move it back. Two
 * logins signed in the same second cannot be ordered, so the earlier of their two ends is kept.
 *
 * A revocation wins over every login: once `revoke` ran, no later cookie moves the end or makes
 * the mandate live again, for as long as the instance keeps its data (erasing it with
 * `deleteAllData` empties this table like every other).
 *
 * Fail-closed is the reader's rule: a mandate with no stored end, or a revoked one, has ended.
 * A reader is to ask `isLive`: `endOf` alone does not say whether the mandate was revoked.
 */
import type Database from 'better-sqlite3';
import type { RequestPrincipal } from './request-principal.js';

export class MandateEnds {
  private readonly upsert: Database.Statement;
  private readonly revokeStmt: Database.Statement;
  private readonly select: Database.Statement;
  /**
   * The newest login recorded per mandate in this process. Every request of a session carries the
   * same login, so without this each one would take engine.db's write lock to change nothing.
   */
  private readonly recorded = new Map<string, { issuedAt: number; endsAt: number }>();

  constructor(db: Database.Database) {
    this.upsert = db.prepare(
      `INSERT INTO mandate_ends (mandate_id, ends_at, issued_at) VALUES (?, ?, ?)
       ON CONFLICT(mandate_id) DO UPDATE SET ends_at = excluded.ends_at, issued_at = excluded.issued_at, updated_at = datetime('now')
       WHERE mandate_ends.revoked_at IS NULL AND (excluded.issued_at > mandate_ends.issued_at
         OR (excluded.issued_at = mandate_ends.issued_at AND excluded.ends_at < mandate_ends.ends_at))`,
    );
    this.revokeStmt = db.prepare(
      `INSERT INTO mandate_ends (mandate_id, ends_at, issued_at, revoked_at) VALUES (?, ?, 0, ?)
       ON CONFLICT(mandate_id) DO UPDATE SET revoked_at = excluded.revoked_at, updated_at = datetime('now')
       WHERE mandate_ends.revoked_at IS NULL`,
    );
    this.select = db.prepare('SELECT ends_at, revoked_at FROM mandate_ends WHERE mandate_id = ?');
  }

  /**
   * Record the end a verified mandate request carried; `issuedAtS` is when its session cookie was
   * signed, the login. Does nothing for the owner, or for a mandate whose cookie names no mandate
   * id or no end (a cookie minted before the web UI signed one). Throws when the row cannot be
   * written.
   */
  record(p: RequestPrincipal, issuedAtS: number): void {
    if (p.kind !== 'mandate' || p.mandateId === undefined || p.mandateExp === undefined) return;
    const seen = this.recorded.get(p.mandateId);
    if (seen !== undefined && (issuedAtS < seen.issuedAt || (issuedAtS === seen.issuedAt && p.mandateExp >= seen.endsAt))) return;
    this.upsert.run(p.mandateId, p.mandateExp, issuedAtS);
    this.recorded.set(p.mandateId, { issuedAt: issuedAtS, endsAt: p.mandateExp });
  }

  /** The mandate was revoked at `atS`. Final: no later `record` revives it. */
  revoke(mandateId: string, atS: number = Math.floor(Date.now() / 1000)): void {
    this.revokeStmt.run(mandateId, atS, atS);
  }

  /** The end recorded with this mandate's latest login, in unix seconds; undefined when none is. */
  endOf(mandateId: string): number | undefined {
    return this.row(mandateId)?.ends_at;
  }

  /** Whether this mandate is still live at `nowS`. False when no end was recorded or it was revoked. */
  isLive(mandateId: string, nowS: number = Math.floor(Date.now() / 1000)): boolean {
    const row = this.row(mandateId);
    return row !== undefined && row.revoked_at === null && nowS < row.ends_at;
  }

  private row(mandateId: string): { ends_at: number; revoked_at: number | null } | undefined {
    return this.select.get(mandateId) as { ends_at: number; revoked_at: number | null } | undefined;
  }
}
