import { createReadStream } from 'node:fs';
import { appendFile, rename, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

/**
 * Bounded append-only JSONL telemetry sink — the shared retention primitive for the
 * engine's opt-in measurement logs (`retrieval-shadow.jsonl`, `memory-write.jsonl`,
 * `context-cost.jsonl`). Each of those was an independent unbounded `appendFile`; this
 * consolidates the "one flag, one retention story" promise into one mechanism so
 * enabling the measurement flags on real customer data can never grow an unbounded
 * plaintext file (the shadow logs carry plaintext threadId/subjectId).
 *
 * Retention model — size-based rotation, one kept generation:
 *  - When the live file reaches the byte cap, it is renamed to `<name>.1` (overwriting
 *    any previous `.1`) and a fresh live file is started. Because the cap is checked
 *    BEFORE the append, on-disk footprint is bounded to `≤ 2 × cap` plus at most one
 *    in-flight record per sink (a telemetry record is small relative to the cap). A
 *    reader wanting the full retained window globs `<name>*` (the live file plus `.1`).
 *  - The cap defaults to 32 MiB (`LYNOX_TELEMETRY_LOG_MAX_BYTES` overrides it, clamped
 *    to [64 KiB, 2 GiB] so a typo can neither thrash-rotate every line nor silently
 *    disable the bound). 2×32 MiB comfortably holds well over the ≥2-week window a
 *    single instance needs to measure the Wave-2 admission floor, while staying a hard
 *    ceiling; the CP can raise it (up to the ceiling) for a high-volume tenant where
 *    2 weeks would otherwise overflow.
 *
 * Invariants inherited from the sinks it replaces:
 *  - Best-effort: any FS error (read-only volume, disk full, permission, ENOTDIR) is
 *    swallowed — a telemetry failure must NEVER surface into the caller's run.
 *  - Deploy-safe path: written under the persistent data dir (`LYNOX_DATA_DIR`/`LYNOX_DIR`,
 *    else `~/.lynox`), the one volume writable in the managed read-only container.
 *  - Serialized per file so concurrent fire-and-forget writers cannot interleave a
 *    rotation with an append (which would split or drop a line).
 */

/** Default per-file byte cap before rotation. */
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
/** Floor for an operator override — below this, rotation would thrash on every line. */
const MIN_MAX_BYTES = 64 * 1024;
/** Ceiling for an operator override — above this the bound is effectively disabled (typo guard). */
const MAX_MAX_BYTES = 2 * 1024 * 1024 * 1024;

/** Resolve the data dir the same way the rest of the engine does. */
function dataDir(): string {
  const fromEnv = process.env['LYNOX_DATA_DIR'] ?? process.env['LYNOX_DIR'];
  return fromEnv && fromEnv.length > 0 ? fromEnv : path.join(homedir(), '.lynox');
}

/** Resolve the byte cap, honouring an env override but clamped to [floor, ceiling]. */
function maxBytes(): number {
  const raw = process.env['LYNOX_TELEMETRY_LOG_MAX_BYTES'];
  if (raw === undefined || raw.length === 0) return DEFAULT_MAX_BYTES;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < MIN_MAX_BYTES) return DEFAULT_MAX_BYTES;
  return n > MAX_MAX_BYTES ? MAX_MAX_BYTES : n;
}

/**
 * Per-file in-process write chain. Making size-check + rotate + append atomic within
 * the process keeps concurrent writers to the same sink from interleaving. Only one
 * entry per distinct sink file (a handful total), each holding the latest tail.
 */
const chains = new Map<string, Promise<void>>();

/** Rotate the live file to `<file>.1` if it has reached the cap. Best-effort. */
async function rotateIfNeeded(file: string, cap: number): Promise<void> {
  let size: number;
  try {
    size = (await stat(file)).size;
  } catch {
    return; // no file yet (ENOENT) or unstatable — nothing to rotate
  }
  if (size < cap) return;
  try {
    await rename(file, `${file}.1`);
  } catch {
    // Rotation failed — leave the file; the next successful rotate re-bounds it.
  }
}

/**
 * Best-effort append of one JSON line to a size-bounded telemetry sink under the
 * engine data dir. Never throws: the returned promise always resolves to `undefined`,
 * even when the write fails. Callers do `void appendBoundedJsonl(...)` and never await.
 */
export function appendBoundedJsonl(fileName: string, entry: unknown): Promise<void> {
  // Resolve INSIDE the guard. `dataDir()`/`path.join`/`maxBytes` are synchronous and a
  // throw here (a NUL byte in an env-supplied path, a hostile LYNOX_DATA_DIR) escaped the
  // promise entirely — so a `void`-ed telemetry call could abort its caller. Every emit
  // site sits next to a durable write; one of them runs BEFORE the write. Telemetry must
  // never be able to fail the thing it measures.
  let file: string;
  let cap: number;
  try {
    file = path.join(dataDir(), fileName);
    cap = maxBytes();
  } catch {
    return Promise.resolve();
  }
  const prev = chains.get(file) ?? Promise.resolve();
  const next = prev.then(async () => {
    try {
      await rotateIfNeeded(file, cap);
      await appendFile(file, JSON.stringify(entry) + '\n', 'utf8');
    } catch {
      // Best-effort telemetry — never propagate.
    }
  });
  // Store a non-rejecting tail so the chain can't accumulate an unhandled rejection.
  chains.set(file, next.catch(() => {}));
  return next;
}

/** What one `scanBoundedJsonl` pass saw — and what it could NOT read. */
export interface BoundedJsonlScan {
  /** Records handed to the visitor. */
  readonly entriesSeen: number;
  /**
   * Lines that were present but did not parse as JSON. A reader that silently drops
   * these reports a rate over a denominator it quietly shrank — the one failure mode
   * a telemetry aggregate cannot afford, because it has no symptom. Counted, never hidden.
   */
  readonly unparsableLines: number;
  /** Which generations existed and were read (`<name>.1` first when present). */
  readonly generationsRead: number;
}

/**
 * Stream the full retained window of a bounded sink through a visitor — the missing
 * half of `appendBoundedJsonl`. Globs the two retained generations exactly as the
 * retention model above describes: `<name>.1` (older, if it exists) then the live
 * `<name>`, so the visitor sees records in chronological file order.
 *
 * STREAMING is the point, not an optimisation. These sinks are bounded but not small:
 * the default cap already allows 2 × 32 MiB retained, and an operator may raise it to
 * 2 × 2 GiB. Slurping a generation into a string (and again into a split array) would
 * put a multi-hundred-MiB allocation behind whatever diagnostic surface calls this —
 * on an HTTP endpoint, a repeatable one. A line-at-a-time visitor keeps the read O(1)
 * in memory regardless of how the cap is configured, which is what makes it safe to
 * expose the aggregate over the API at all.
 *
 * Best-effort in the same sense as the append side: a missing or unreadable file is
 * skipped rather than thrown, because every caller is a diagnostic surface and a
 * telemetry read must never fail the thing it reports on. It does NOT swallow *partial*
 * damage — an unparsable line is counted so the caller can state how complete its
 * numbers are. A visitor that throws aborts the scan; callers keep visitors total.
 *
 * No validation of the record shape happens here: the sink is schema-per-file and the
 * caller owns the type. `T` is an unchecked assertion, so callers that aggregate on a
 * field must tolerate it being absent.
 */
export async function scanBoundedJsonl<T>(fileName: string, visit: (entry: T) => void): Promise<BoundedJsonlScan> {
  let file: string;
  try {
    file = path.join(dataDir(), fileName);
  } catch {
    return { entriesSeen: 0, unparsableLines: 0, generationsRead: 0 };
  }
  let entriesSeen = 0;
  let unparsableLines = 0;
  let generationsRead = 0;
  // Oldest first: `.1` is the rotated-out generation, the live file is newer.
  for (const candidate of [`${file}.1`, file]) {
    try {
      await stat(candidate);
    } catch {
      continue; // ENOENT for `.1` is the normal case, not an error
    }
    generationsRead++;
    const stream = createReadStream(candidate, { encoding: 'utf8' });
    // `crlfDelay: Infinity` so a CRLF-written line is one record, not a torn one.
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (line.trim().length === 0) continue;
        let parsed: T;
        try {
          parsed = JSON.parse(line) as T;
        } catch {
          // A torn last line is expected mid-append; anything else is real damage.
          // Either way the caller learns the count rather than a quietly short list.
          unparsableLines++;
          continue;
        }
        entriesSeen++;
        visit(parsed);
      }
    } finally {
      lines.close();
      stream.destroy();
    }
  }
  return { entriesSeen, unparsableLines, generationsRead };
}
