/**
 * Which generation of the owner's sessions is live on this instance. Every owner session cookie
 * carries the generation it was minted in, signed under the same HMAC as the rest of the cookie;
 * the engine (`_verifySessionCookie`) and the web UI (`readSessionToken`) let a cookie in only when
 * its generation is the current one. Ending the owner's sessions moves the generation one on, and
 * every cookie minted before is refused, whatever its own expiry still says.
 *
 * The cookie's signature comes from the instance secret, which the control plane also uses for
 * the instance's usage reports and secret delivery and keeps on purpose across redeploys. Ending
 * the owner's sessions therefore must not mean a new secret: it means a new generation.
 *
 * A counter, not a time: an end, a login and a stolen cookie in the same second are ordered by the
 * counter alone, so there is no rule about seconds to get wrong.
 *
 * Refused on any difference, not only on an older generation: a cookie of a HIGHER generation than
 * the store's (the store went back, by a restore or a recreated file) is refused too, and the owner
 * signs in again. A cookie minted before generations existed carries none and counts as generation
 * 0, the one every instance starts at, so the sessions of today stay valid until the first end.
 *
 * Moved on in one statement (`generation = generation + 1`), so two ends at once give two steps.
 * Kept across the owner's erasure (`EngineDb.deleteAllData`): it holds no data of anyone, and
 * emptying it would bring every ended session back.
 *
 * Mirrored into a file of its own beside engine.db (`mirrorPath`, `owner-sessions-generation` in the
 * data directory), which no backup carries: a backup restored, a migration imported or an engine.db
 * that went missing would otherwise bring an older generation back, and with it every session ended
 * since. At open the higher of the two wins; every end and raise writes the file again. A value past
 * the clock in milliseconds is not one this code writes (the highest is a recreated file's, the clock
 * at that boot, which a clock set back afterwards can leave ahead): it is told and held to the clock,
 * so a file written by something else can force one new login at most, never raise the generation
 * past what a cookie can carry, and a mirror ahead of a clock set back still ends what engine.db
 * brought back.
 *
 * Not an agent tool, on purpose: ending every session is the owner's act through a route of its
 * own, never something a model can be talked into.
 */
import type Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { writeFileAtomicSync } from './atomic-write.js';
import { processErrorText } from './error-egress.js';

/** The process-wide key the engine publishes `generation` under, for the web UI in the same process. */
export const OWNER_SESSIONS_GENERATION_KEY = Symbol.for('lynox.ownerSessionsGeneration');

export class OwnerSessions {
  private readonly read: Database.Statement;
  private readonly step: Database.Statement;
  private readonly raise: Database.Statement;
  private readonly mirrorPath: string | null;

  constructor(db: Database.Database, options: { mirrorPath?: string | undefined } = {}) {
    this.mirrorPath = options.mirrorPath ?? null;
    db.prepare('INSERT OR IGNORE INTO owner_sessions (id, generation) VALUES (1, 0)').run();
    this.read = db.prepare('SELECT generation FROM owner_sessions WHERE id = 1');
    this.step = db.prepare(
      "UPDATE owner_sessions SET generation = generation + 1, updated_at = datetime('now') WHERE id = 1 RETURNING generation",
    );
    this.raise = db.prepare(
      "UPDATE owner_sessions SET generation = MAX(generation, ?), updated_at = datetime('now') WHERE id = 1 RETURNING generation",
    );
    // The higher of the two: a mirror ahead of engine.db means engine.db went back.
    const mirrored = this.readMirror();
    if (mirrored !== null) this.raiseTo(mirrored);
    else this.writeMirror(this.generation());
  }

  /** The live generation: the one every owner session minted now carries, and the only one let in. */
  generation(): number {
    return (this.read.get() as { generation: number }).generation;
  }

  /** Whether an owner session minted in `generation` is refused: any generation but the live one. */
  ended(generation: number): boolean {
    return generation !== this.generation();
  }

  /**
   * End every owner session: the generation moves one on. Returns the new generation, the one to
   * mint the caller's own new session in. Throws when the row cannot be written, and then nothing
   * has ended.
   */
  endAll(): number {
    const generation = (this.step.get() as { generation: number }).generation;
    this.writeMirror(generation);
    return generation;
  }

  /**
   * Raise the generation to at least `generation`, never lower it: the control plane re-asserting
   * the generation it recorded, after a restore brought an older one back, and a boot that found
   * engine.db corrupt. Every owner session below it ends. Returns the stored generation.
   */
  raiseTo(generation: number): number {
    const stored = (this.raise.get(generation) as { generation: number }).generation;
    this.writeMirror(stored);
    return stored;
  }

  private readMirror(): number | null {
    return this.mirrorPath === null ? null : readOwnerSessionsMirror(this.mirrorPath);
  }

  /**
   * Write the mirror whole or not at all (a temporary file renamed over it). A failed write is told
   * and does not undo the end: engine.db holds it, and the next end or open writes the mirror again.
   */
  private writeMirror(generation: number): void {
    if (this.mirrorPath === null) return;
    try {
      writeFileAtomicSync(this.mirrorPath, String(generation));
    } catch (err: unknown) {
      process.stderr.write(`[lynox] the copy of the owner sessions' generation could not be written: ${processErrorText(err)}\n`);
    }
  }
}

/**
 * The generation in a mirror file, held to the clock in milliseconds (told on stderr when it was
 * past it), or null when there is none or it holds no whole number from 0: see `OwnerSessions`.
 */
function readOwnerSessionsMirror(path: string, nowMs: number = Date.now()): number | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const value = Number(text.trim());
  if (!Number.isSafeInteger(value) || value < 0) return null;
  if (value > nowMs) {
    process.stderr.write('[lynox] the copy of the owner sessions\' generation is past the clock and was held to it\n');
    return nowMs;
  }
  return value;
}
