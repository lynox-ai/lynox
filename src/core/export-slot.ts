import { randomUUID } from 'node:crypto';
import { closeSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The one slot an export and an erasure share, as a lock file in the data directory, so it holds
 * ACROSS PROCESSES: the export command (`scripts/export-archive.ts`) runs beside the HTTP API in the
 * same container, and an in-process flag would not see it.
 *
 * - An export takes the slot for as long as its staged archive exists. An erasure takes it for its
 *   whole run (`DELETE /api/data` is asynchronous, so an export started beside it would read stores
 *   half wiped). Whoever finds the slot held refuses.
 * - Staleness is decided by TIME, never by PID: a container restart starts a new PID namespace, so a
 *   dead holder's PID is very likely alive again. A slot older than its kind's TTL is stale.
 * - The HTTP API's boot sweep also removes a slot the HTTP API itself held before this process
 *   started (`holder: 'http'`): its holder cannot have survived the restart. A slot the export
 *   command holds is left to its TTL, since the command may run in a process the restart did not end.
 *
 * Named remainder: two processes that both find the SAME stale slot at the same moment can both
 * break it and the second can remove the first's fresh one. It takes a holder that died an hour
 * before and two starts in one instant.
 */

export const EXPORT_SLOT_FILE = 'export-slot.lock';
/** An export holds the slot from staging until its archive is gone: at most this long. */
export const EXPORT_SLOT_TTL_MS = 60 * 60 * 1000;
/** An erasure holds the slot for its run; a wipe of a large instance can take long. */
export const ERASURE_SLOT_TTL_MS = 24 * 60 * 60 * 1000;

export type SlotKind = 'export' | 'erasure';
export type SlotHolder = 'http' | 'command';

export interface SlotInfo {
  readonly kind: SlotKind;
  readonly holder: SlotHolder;
  readonly job: string;
  /** When the slot was taken, ms since the epoch. */
  readonly at: number;
}

export interface HeldSlot {
  readonly info: SlotInfo;
  /**
   * Heartbeat: move the slot's time to now while the holder works (a stream that runs past the
   * TTL), so "stale" means "the holder died", not "the holder is slow". Only while the slot is
   * still this holder's; returns whether it was.
   */
  refresh(now?: number): boolean;
  /** Give the slot back. Removes the lock only while it is still this holder's. Idempotent. */
  release(): void;
}

export type AcquireResult = { readonly ok: true; readonly slot: HeldSlot } | { readonly ok: false; readonly held: SlotInfo };

const ttlOf = (kind: SlotKind): number => (kind === 'erasure' ? ERASURE_SLOT_TTL_MS : EXPORT_SLOT_TTL_MS);

function parse(text: string): SlotInfo | null {
  try {
    const v = JSON.parse(text) as Partial<SlotInfo>;
    if ((v.kind === 'export' || v.kind === 'erasure') && (v.holder === 'http' || v.holder === 'command')
      && typeof v.job === 'string' && typeof v.at === 'number' && Number.isFinite(v.at)) {
      return { kind: v.kind, holder: v.holder, job: v.job, at: v.at };
    }
  } catch { /* unreadable: decided below by its mtime */ }
  return null;
}

/**
 * The lock as it is on disk: its info, or `garbled` with the file's mtime when it does not parse
 * (a writer that died between create and write). `null` when there is no lock.
 */
function readRaw(path: string): { info: SlotInfo } | { garbled: number } | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const info = parse(text);
  if (info) return { info };
  try {
    return { garbled: lstatSync(path).mtimeMs };
  } catch {
    return null;
  }
}

/**
 * Whether what is on disk is stale at `now`. A garbled lock (a writer that died between creating
 * and writing it) is judged by its mtime against the export TTL: long enough for any writer that
 * is merely slow, short enough that the customer's erasure is not held off for a day.
 */
function isStale(raw: { info: SlotInfo } | { garbled: number }, now: number): boolean {
  if ('info' in raw) return now - raw.info.at > ttlOf(raw.info.kind);
  return now - raw.garbled > EXPORT_SLOT_TTL_MS;
}

/**
 * Rewrite the lock of `job` with time `at` (atomically: a temp file renamed over it), only while the
 * lock is that job's. Returns whether it did.
 */
export function touchSlotByJob(dataDir: string, job: string, at: number = Date.now()): boolean {
  const path = join(dataDir, EXPORT_SLOT_FILE);
  const raw = readRaw(path);
  if (raw === null || !('info' in raw) || raw.info.job !== job) return false;
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...raw.info, at }), { mode: 0o600 });
  renameSync(tmp, path);
  return true;
}

function unlinkQuiet(path: string): void {
  try { unlinkSync(path); } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/**
 * The live slot, or `null` when it is free or stale. A garbled lock that is not stale yet is
 * reported as an erasure held by `command` (fail closed: whoever wrote it may still run).
 */
export function readSlot(dataDir: string, now: number = Date.now()): SlotInfo | null {
  const raw = readRaw(join(dataDir, EXPORT_SLOT_FILE));
  if (raw === null || isStale(raw, now)) return null;
  return 'info' in raw ? raw.info : { kind: 'erasure', holder: 'command', job: 'unknown', at: raw.garbled };
}

/** Take the slot, or say who holds it. A stale lock is broken first. */
export function acquireSlot(
  dataDir: string,
  kind: SlotKind,
  holder: SlotHolder,
  opts: { job?: string; now?: number } = {},
): AcquireResult {
  const path = join(dataDir, EXPORT_SLOT_FILE);
  const now = opts.now ?? Date.now();
  const info: SlotInfo = { kind, holder, job: opts.job ?? randomUUID(), at: now };
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number;
    try {
      fd = openSync(path, 'wx', 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const raw = readRaw(path);
      if (raw === null) continue; // released between the two calls: try again
      if (!isStale(raw, now)) {
        return { ok: false, held: 'info' in raw ? raw.info : { kind: 'erasure', holder: 'command', job: 'unknown', at: raw.garbled } };
      }
      unlinkQuiet(path);
      continue;
    }
    try {
      writeSync(fd, JSON.stringify(info));
    } finally {
      closeSync(fd);
    }
    let released = false;
    return {
      ok: true,
      slot: {
        info,
        refresh(at: number = Date.now()): boolean {
          if (released) return false;
          return touchSlotByJob(dataDir, info.job, at);
        },
        release(): void {
          if (released) return;
          released = true;
          const raw = readRaw(path);
          if (raw !== null && 'info' in raw && raw.info.job === info.job) unlinkQuiet(path);
        },
      },
    };
  }
  // Two rounds of "broken, then taken by someone else": report what is there now.
  const now2 = readSlot(dataDir, now);
  return { ok: false, held: now2 ?? { kind: 'erasure', holder: 'command', job: 'unknown', at: now } };
}

/**
 * The HTTP API's boot sweep: remove a slot the HTTP API held before `startedAt` (its holder died
 * with the process). A slot the export command holds is left to its TTL. Returns whether it removed one.
 */
export function sweepSlot(dataDir: string, startedAt: number): boolean {
  const path = join(dataDir, EXPORT_SLOT_FILE);
  const raw = readRaw(path);
  if (raw === null) return false;
  if ('info' in raw && raw.info.holder === 'http' && raw.info.at < startedAt) {
    unlinkQuiet(path);
    return true;
  }
  return false;
}

/**
 * Give back a slot from a process other than the one that took it (the export command's `--finish`,
 * run after the hand-over): removes the lock only when it is the slot of `job`. Returns whether it did.
 */
export function releaseSlotByJob(dataDir: string, job: string): boolean {
  const path = join(dataDir, EXPORT_SLOT_FILE);
  const raw = readRaw(path);
  if (raw === null || !('info' in raw) || raw.info.job !== job) return false;
  unlinkQuiet(path);
  return true;
}
