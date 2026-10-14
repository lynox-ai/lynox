/**
 * The control plane's trail in the instance log (PRD cp-admin-line §3.3): every request the
 * control plane makes with its admin bearer (`cp-admin`), and every request admitted by the
 * migration token on a provisioned instance (`cp-migration`), leaves rows in `audit_log`.
 *
 * Unlike a mandate's trail, a row that cannot be written does not refuse the act. The export,
 * the mandate revoke and the Google teardown go ahead, and the row is kept here to be written
 * with the next row that can be. Whether an export should wait instead is not decided here; the
 * one place that would say so is `cpExportOnAuditFailure` (`_cpExportPolicy` in http-api.ts is a
 * test seam that reads it).
 *
 * What "kept" means, exactly:
 * - in this process's memory only. A restart loses every kept row, and nothing reports which;
 * - at most `CP_TRAIL_PENDING_MAX` rows. A row beyond that is dropped, and stderr names how many
 *   were dropped so far;
 * - written later only if a later row of this trail is written; nothing retries on its own.
 * A kept row is written with its own time in `ts` and the time of writing in `recorded_at`, so a
 * late row is told apart by `recorded_at ≠ ts` — unless it was kept and written within the same
 * millisecond, when the two are equal.
 * A refusal's row (`CpRefusalTally`) is never kept: it would take the place of an act's row.
 */
import { randomUUID } from 'node:crypto';
import { TARGET_MAX, newCorrelationId, type AuditEntry, type AuditLog } from './audit-log.js';
import { CP_ADMIN_PRINCIPAL } from './request-principal.js';
import { readMandateRevocation } from '../contract/http.js';

/** How many unwritten rows the trail keeps for later. */
export const CP_TRAIL_PENDING_MAX = 256;

/**
 * What the export does when its `attempt` row cannot be written. One place on purpose: the
 * answer is the customer's decision on the record (PRD cp-admin-line, G6), and changing it must
 * not mean finding every caller. `deliver` is today's behaviour plus the trail.
 * It is asked about the `attempt` row only: once that row is written, the export is handed over,
 * and its `done` row is kept like any other when it cannot be written.
 */
export function cpExportOnAuditFailure(): 'deliver' | 'refuse' {
  return 'deliver';
}

export class CpTrail {
  private readonly pending: AuditEntry[] = [];
  private dropped = 0;

  constructor(
    private readonly log: () => AuditLog | null,
    private readonly warn: (line: string) => void = (line) => { process.stderr.write(line); },
  ) {}

  /**
   * Write one row, after the rows kept from before. Never throws: a row that cannot be written is
   * kept (bounded, unless `keep` is false) and named on stderr. True when this row was written now.
   */
  write(entry: AuditEntry, keep = true): boolean {
    const log = this.log();
    try {
      if (log === null) throw new Error('no audit log');
      while (this.pending.length > 0) {
        log.record(this.pending[0]!);
        this.pending.shift();
      }
      log.record(entry);
      return true;
    } catch (err: unknown) {
      if (keep) this.keep(entry, err);
      else this.warn(`[lynox] control-plane trail: row not written and not kept (request ${entry.requestId ?? 'none'}): ${err instanceof Error ? err.message : String(err)}\n`);
      return false;
    }
  }

  /** How many rows wait to be written. Test seam. */
  pendingCount(): number { return this.pending.length; }

  private keep(entry: AuditEntry, err: unknown): void {
    const why = err instanceof Error ? err.message : String(err);
    const request = entry.requestId ?? 'none';
    if (this.pending.length >= CP_TRAIL_PENDING_MAX) {
      this.dropped++;
      this.warn(`[lynox] control-plane trail: row not written and not kept, the buffer is full (request ${request}): ${String(this.dropped)} row(s) dropped since start\n`);
      return;
    }
    // Its own time goes with it, so the late row keeps when the act happened.
    this.pending.push(entry.at === undefined ? { ...entry, at: new Date().toISOString() } : entry);
    this.warn(`[lynox] control-plane trail: row not written, kept in memory until a later row can be (request ${request}): ${why}\n`);
  }
}

/** What a control-plane export names as its target, and the class the answer's header carries. */
export type CpExportTargetKind = 'request-id' | 'no-request-id' | 'invalid-request-id';

/**
 * The export's target: the control plane's own id for the job, sent as `X-Lynox-CP-Request`. A
 * missing or malformed id is named as such and never refused: the export is the customer's data
 * on its way out, and a 400 here would only stop it.
 */
export function cpExportTarget(header: string | string[] | undefined): { kind: CpExportTargetKind; value: string } {
  if (header === undefined) return { kind: 'no-request-id', value: 'no-request-id' };
  if (typeof header === 'string' && /^[0-9a-f]{32}$/.test(header)) return { kind: 'request-id', value: `request ${header}` };
  return { kind: 'invalid-request-id', value: 'invalid-request-id' };
}

/**
 * The target of the control plane's other acts, read from the body the dispatcher parsed. Never a
 * value the caller chose beyond the ids it names: the Google revoke's flag is named by its class.
 */
export function cpRequestTarget(route: string, body: unknown): string | undefined {
  if (route === 'POST /api/admin/mandates/revoke') {
    const ids = readMandateRevocation(body);
    if (ids === 'invalid') return 'invalid body';
    if (ids.length === 0) return '0 mandate(s)';
    // As many whole ids as fit the row's bound, and how many more: the bound cuts without a mark,
    // so the list is fitted to it here. The room for the count is held back at its largest.
    const head = `${String(ids.length)} mandate(s): `;
    const room = TARGET_MAX - head.length - ` +${String(ids.length)} more`.length;
    const shown: string[] = [];
    let used = 0;
    for (const id of ids) {
      const add = (shown.length > 0 ? 1 : 0) + id.length;
      if (used + add > room) break;
      shown.push(id);
      used += add;
    }
    const more = ids.length - shown.length;
    return `${head}${shown.join(',')}${more > 0 ? ` +${String(more)} more` : ''}`;
  }
  if (route === 'POST /api/admin/google/revoke') {
    if (typeof body !== 'object' || body === null || !('delete_drive_backups' in body)) return 'delete_drive_backups absent';
    return (body as { delete_drive_backups?: unknown }).delete_drive_backups === false ? 'delete_drive_backups=false' : 'delete_drive_backups=other';
  }
  return undefined;
}

/** How many refusals of the control plane's bearer get a row of their own per UTC day. */
export const CP_REFUSAL_ROWS_PER_DAY = 100;

/**
 * Rows for the routes the control plane's bearer is refused (PRD cp-admin-line §3.3, F10),
 * bounded so a caller that keeps asking cannot grow the log: the first refusal of a route in a
 * minute gets a row, the rest of that minute are counted and named in one row; past
 * `CP_REFUSAL_ROWS_PER_DAY` such first rows a day, refusals are only counted, and one row names
 * the count. With the per-minute counts that makes at most twice the cap and one rows about one
 * day's refusals; as counts are written with a later refusal, up to three times the cap and one
 * can be written on one day.
 * The counted rows are written with the next refusal after their minute or day, so the counts
 * of the last minute before a restart are lost.
 */
export class CpRefusalTally {
  private minute = '';
  private readonly counted = new Map<string, number>();
  private day = '';
  private rowsToday = 0;
  private uncountedToday = 0;

  /** The rows to write for one refusal of `route` (`METHOD /path`) at `now`. */
  refuse(route: string, now: Date): AuditEntry[] {
    const iso = now.toISOString();
    const minute = iso.slice(0, 16);
    const day = iso.slice(0, 10);
    const rows: AuditEntry[] = [];
    if (minute !== this.minute) {
      for (const [r, n] of this.counted) {
        if (n > 0) rows.push(refusalRow(`${r} 403`, `${String(n)} more in ${this.minute}Z`));
      }
      this.counted.clear();
      this.minute = minute;
    }
    if (day !== this.day) {
      if (this.uncountedToday > 0) {
        rows.push(refusalRow('cp-admin refusals', `${String(this.uncountedToday)} without a row on ${this.day}: daily cap ${String(CP_REFUSAL_ROWS_PER_DAY)}`));
      }
      this.day = day;
      this.rowsToday = 0;
      this.uncountedToday = 0;
    }
    const seen = this.counted.get(route);
    if (seen !== undefined) {
      this.counted.set(route, seen + 1);
    } else if (this.rowsToday >= CP_REFUSAL_ROWS_PER_DAY) {
      this.uncountedToday++;
    } else {
      this.rowsToday++;
      this.counted.set(route, 0);
      rows.push({ ...refusalRow(`${route} 403`, 'not registered for the control plane'), requestId: randomUUID() });
    }
    return rows;
  }
}

function refusalRow(action: string, target: string): AuditEntry {
  return { principal: CP_ADMIN_PRINCIPAL, action, target, phase: 'refused', correlationId: newCorrelationId() };
}
