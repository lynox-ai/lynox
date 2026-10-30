/**
 * Does this instance run without its vault key over stores that already hold encrypted values?
 *
 * WHY. Without a key the stores write new values in plain beside the ciphertext, and the vault
 * stays shut; the only signal today is one stderr line when the vault does not open. This check
 * turns the state into something the owner can see (a status field, a banner) and that `/health`
 * reports as `degraded`. It changes no write and no key source: it reads, and it reports.
 *
 * WHAT COUNTS AS CIPHERTEXT. A value in a column the export map registers as encrypted
 * (`EXPORT_TABLES`) that has the shape `enc:` writes: the prefix, case-sensitive, then strict
 * base64 of iv (12) + tag (16) + at least one byte, so a body of at least 40 characters and a
 * multiple of 4, padding only at the end. A plaintext note that happens to start with `enc:` does
 * not match.
 *
 * HOW IT READS. Through the stores' own connections, read-only, in steps of a fixed number of rows
 * by rowid: one statement never reads more than one step, whether or not anything matches, so
 * `/health` (answered by the same event loop) is never held behind a whole column. Between steps it
 * yields, and a total time budget ends the check. The test sits in the select list, not in a WHERE,
 * so a step without a match still returns the last rowid it read and the next step starts after it.
 *
 * FAILURE DIRECTION. A query that throws, or a budget that runs out, gives `unknown`: the state may
 * hold and could not be checked. The check never throws and never stops a boot.
 */

import type Database from 'better-sqlite3';
import { EXPORT_TABLES } from './export-tables.js';

export type KeylessStore = 'engine.db' | 'history.db';

export type KeylessState =
  | { readonly state: 'missing_over_encrypted_data'; readonly stores: readonly KeylessStore[] }
  | { readonly state: 'unknown' };

export interface KeylessCheckOptions {
  /** Rows one statement reads at most. */
  readonly stepRows?: number;
  /** Wall-clock budget for the whole check. */
  readonly budgetMs?: number;
  readonly now?: () => number;
}

const DEFAULT_STEP_ROWS = 500;
const DEFAULT_BUDGET_MS = 30_000;

/** The ciphertext shape as an SQL expression over one column (see the header). */
function ciphertextShape(column: string): string {
  const c = `"${column}"`;
  const body = `substr(${c}, 5)`;
  const eq = `(length(${body}) - length(replace(${body}, '=', '')))`;
  return `(typeof(${c}) = 'text' AND ${c} GLOB 'enc:*'`
    + ` AND length(${body}) >= 40 AND length(${body}) % 4 = 0`
    + ` AND ${body} NOT GLOB '*[^A-Za-z0-9+/=]*'`
    + ` AND (${eq} = 0 OR (${eq} = 1 AND ${body} GLOB '*=') OR (${eq} = 2 AND ${body} GLOB '*=='))`
    + `)`;
}

/** Every registered encrypted column of one store, as [table, column]. */
function registeredColumns(store: KeylessStore): Array<readonly [string, string]> {
  const out: Array<readonly [string, string]> = [];
  for (const [table, decision] of Object.entries(EXPORT_TABLES[store].include)) {
    for (const column of decision.encrypted ?? []) out.push([table, column] as const);
  }
  return out;
}

// run-group-starter: resolves on the next turn; it only lets other work run between read steps and reports no spend.
const yieldToLoop = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });

/**
 * Checks the given stores. Returns null when no registered column holds ciphertext. The caller
 * decides when to run it: only without a key, and after the server listens.
 */
export async function checkKeylessOverCiphertext(
  stores: ReadonlyArray<{ readonly name: KeylessStore; readonly db: Database.Database }>,
  options: KeylessCheckOptions = {},
): Promise<KeylessState | null> {
  const stepRows = options.stepRows ?? DEFAULT_STEP_ROWS;
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
  const now = options.now ?? Date.now;
  const deadline = now() + budgetMs;
  const found: KeylessStore[] = [];
  try {
    for (const { name, db } of stores) {
      let hit = false;
      for (const [table, column] of registeredColumns(name)) {
        const step = db.prepare(
          `SELECT max(r) AS last, max(hit) AS hit FROM (`
          + `SELECT rowid AS r, ${ciphertextShape(column)} AS hit FROM "${table}" WHERE rowid > ? ORDER BY rowid LIMIT ?`
          + `)`,
        );
        let after = Number.MIN_SAFE_INTEGER;
        // run-group-starter: started once after listen at boot, outside any run; ends at the deadline at the latest, only reads and reports no spend.
        for (;;) {
          if (now() > deadline) return { state: 'unknown' };
          const row = step.get(after, stepRows) as { last: number | null; hit: number | null };
          if (row.last === null) break;
          if (row.hit === 1) { hit = true; break; }
          after = row.last;
          await yieldToLoop();
        }
        if (hit) break;
        await yieldToLoop();
      }
      if (hit) found.push(name);
    }
  } catch {
    return { state: 'unknown' };
  }
  return found.length > 0 ? { state: 'missing_over_encrypted_data', stores: found } : null;
}
