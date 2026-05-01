/**
 * Persistent prompt store for resumable ask_user / ask_secret prompts.
 *
 * Stores pending prompts in SQLite so they survive SSE disconnects, page
 * reloads, and thread switches. Answer delivery uses an in-process event bus
 * (no polling). SQLite is the durability layer; the event bus is the latency
 * layer. `waitForAnswer` subscribes before reading so no race between
 * subscribe and answer insertion.
 *
 * Concurrent pending prompts per session are rejected at insert time (partial
 * UNIQUE index in the schema, plus a belt-and-braces check here for clearer
 * errors).
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { TabQuestion } from '../types/agent.js';

// ── Types ────────────────────────────────────────────────────────────────────

export type PromptType = 'ask_user' | 'ask_secret';
export type PromptStatus = 'pending' | 'answered' | 'expired';

export interface PendingPromptRow {
  id: string;
  session_id: string;
  prompt_type: PromptType;
  question: string;
  options_json: string | null;
  questions_json: string | null;
  partial_answers_json: string | null;
  secret_name: string | null;
  secret_key_type: string | null;
  answer: string | null;
  answer_saved: number | null;
  status: PromptStatus;
  created_at: string;
  answered_at: string | null;
  expires_at: string;
}

/** A richer view of how a wait ended. Callers that only want the answer can
 * keep using `waitForAnswer`; callers that need to distinguish timeout from
 * abort from dismiss (e.g. the tool handler) use `waitForSettled`. */
export type PromptOutcome =
  | { status: 'answered'; row: PendingPromptRow }
  | { status: 'expired' }
  | { status: 'aborted' };

export class PromptConflictError extends Error {
  constructor(sessionId: string) {
    super(`Session ${sessionId} already has a pending prompt`);
    this.name = 'PromptConflictError';
  }
}

// ── Constants ────────────────────────────────────────────────────────────────

const PROMPT_TTL_MS = 24 * 60 * 60_000; // 24 hours
// Safety-net expiry check inside waitForAnswer — the event bus handles the
// happy path; this timer only catches prompts whose 24h TTL elapsed while the
// handler was awaiting.
const EXPIRY_CHECK_MS = 30_000;

// ── Store ────────────────────────────────────────────────────────────────────

export class PromptStore {
  private readonly db: Database.Database;
  private readonly emitter = new EventEmitter();

  // Prepared statements (lazy-initialized)
  private _stmtInsert: Database.Statement | undefined;
  private _stmtAnswer: Database.Statement | undefined;
  private _stmtAnswerSecret: Database.Statement | undefined;
  private _stmtGetPending: Database.Statement | undefined;
  private _stmtGetById: Database.Statement | undefined;
  private _stmtExpireOld: Database.Statement | undefined;
  private _stmtExpireAll: Database.Statement | undefined;
  private _stmtSetPartial: Database.Statement | undefined;

  constructor(db: Database.Database) {
    this.db = db;
    // Each concurrent session's waitForAnswer subscribes one listener. In
    // steady state there is ≤1 waiter per session; bump the limit so we don't
    // see warnings under load.
    this.emitter.setMaxListeners(1000);
  }

  // ── Insert ──────────────────────────────────────────────────────────────

  /** Insert a single-question ask_user prompt. Throws PromptConflictError if
   * this session already has a pending prompt. */
  insertAskUser(sessionId: string, question: string, options?: string[]): string {
    return this._insert({
      sessionId,
      promptType: 'ask_user',
      question,
      optionsJson: options ? JSON.stringify(options) : null,
      questionsJson: null,
      secretName: null,
      secretKeyType: null,
    });
  }

  /** Insert a multi-question (tabs) ask_user prompt. All questions are
   * answered in a single reply. Throws PromptConflictError on collision. */
  insertAskUserTabs(sessionId: string, questions: TabQuestion[]): string {
    if (questions.length === 0) throw new Error('insertAskUserTabs: questions must be non-empty');
    return this._insert({
      sessionId,
      promptType: 'ask_user',
      // question held separately for logging / restoration; canonical data is
      // in questions_json.
      question: questions[0]!.question,
      optionsJson: null,
      questionsJson: JSON.stringify(questions),
      secretName: null,
      secretKeyType: null,
    });
  }

  insertAskSecret(sessionId: string, name: string, prompt: string, keyType?: string): string {
    return this._insert({
      sessionId,
      promptType: 'ask_secret',
      question: prompt,
      optionsJson: null,
      questionsJson: null,
      secretName: name,
      secretKeyType: keyType ?? null,
    });
  }

  private _insert(args: {
    sessionId: string;
    promptType: PromptType;
    question: string;
    optionsJson: string | null;
    questionsJson: string | null;
    secretName: string | null;
    secretKeyType: string | null;
  }): string {
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + PROMPT_TTL_MS).toISOString();
    try {
      this._getInsertStmt().run(
        id,
        args.sessionId,
        args.promptType,
        args.question,
        args.optionsJson,
        args.questionsJson,
        args.secretName,
        args.secretKeyType,
        null, // answer
        null, // answer_saved
        'pending',
        expiresAt,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('UNIQUE') || msg.includes('unique')) {
        throw new PromptConflictError(args.sessionId);
      }
      throw err;
    }
    return id;
  }

  // ── Answer ──────────────────────────────────────────────────────────────

  /** Answer a single-question ask_user. Idempotent: returns true only the
   * first time the prompt transitions to 'answered' (matches status='pending'
   * AND not expired). Subsequent calls return false but do not error. */
  answerUser(promptId: string, answer: string): boolean {
    const result = this._getAnswerStmt().run(answer, promptId);
    const changed = result.changes > 0;
    if (changed) this._emitSettled(promptId);
    return changed;
  }

  /** Answer a multi-question (tabs) ask_user. Answers are stored as a JSON
   * string[] in the answer column. Ordering must match questions ordering. */
  answerUserTabs(promptId: string, answers: string[]): boolean {
    // Shared UPDATE path: stores JSON-encoded array in the same `answer`
    // column single-question uses. Handler disambiguates by presence of
    // questions_json on the row.
    const result = this._getAnswerStmt().run(JSON.stringify(answers), promptId);
    const changed = result.changes > 0;
    if (changed) this._emitSettled(promptId);
    return changed;
  }

  /** Optional: persist partial answers so a reconnect mid-batch can restore
   * progress. Doesn't settle the prompt — the handler keeps awaiting. */
  setPartialAnswers(promptId: string, partial: (string | null)[]): boolean {
    const result = this._getSetPartialStmt().run(JSON.stringify(partial), promptId);
    return result.changes > 0;
  }

  /** Answer an ask_secret. `saved=true` means the user accepted the secret
   * prompt; the value itself is never held by the PromptStore. */
  answerSecret(promptId: string, saved: boolean): boolean {
    const result = this._getAnswerSecretStmt().run(saved ? 1 : 0, promptId);
    const changed = result.changes > 0;
    if (changed) this._emitSettled(promptId);
    return changed;
  }

  // ── Query ───────────────────────────────────────────────────────────────

  /** Get the pending (non-expired) prompt for a session, if any. */
  getPending(sessionId: string): PendingPromptRow | undefined {
    return this._getGetPendingStmt().get(sessionId) as PendingPromptRow | undefined;
  }

  getById(promptId: string): PendingPromptRow | undefined {
    return this._getGetByIdStmt().get(promptId) as PendingPromptRow | undefined;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  /** Transition prompts past expires_at to 'expired'. Safe to call anytime. */
  expireOld(): number {
    const rows = this.db
      .prepare(`SELECT id FROM pending_prompts WHERE status = 'pending' AND expires_at <= datetime('now')`)
      .all() as { id: string }[];
    const result = this._getExpireOldStmt().run();
    // Emit for each so pending waiters return promptly.
    for (const row of rows) this._emitSettled(row.id);
    return result.changes;
  }

  /** Expire ALL pending prompts (used on engine restart). */
  expireAll(): number {
    const rows = this.db
      .prepare(`SELECT id FROM pending_prompts WHERE status = 'pending'`)
      .all() as { id: string }[];
    const result = this._getExpireAllStmt().run();
    for (const row of rows) this._emitSettled(row.id);
    return result.changes;
  }

  /** Expire a single pending prompt by id. Used when a /run handler is
   * superseded by a fresh /run for the same session: the previous run is
   * stuck on `waitForSettled`, so the only way to drain it is to mark its
   * prompt expired and let the wait resolve. Idempotent. Returns true only
   * the first time the prompt transitions out of 'pending'. */
  expirePrompt(promptId: string): boolean {
    const result = this.db
      .prepare(`UPDATE pending_prompts SET status = 'expired' WHERE id = ? AND status = 'pending'`)
      .run(promptId);
    const changed = result.changes > 0;
    if (changed) this._emitSettled(promptId);
    return changed;
  }

  // ── Wait ────────────────────────────────────────────────────────────────

  /** Resolve when the prompt is answered, expired, or the signal aborts.
   * Returns the final row on 'answered', undefined otherwise. Event-based: a
   * 30s timer is a safety net for expiry; the happy path is sub-millisecond
   * after `answerUser` fires. */
  async waitForAnswer(promptId: string, signal?: AbortSignal): Promise<PendingPromptRow | undefined> {
    const outcome = await this.waitForSettled(promptId, signal);
    return outcome.status === 'answered' ? outcome.row : undefined;
  }

  /** Like waitForAnswer but distinguishes why the wait ended. */
  waitForSettled(promptId: string, signal?: AbortSignal): Promise<PromptOutcome> {
    return new Promise<PromptOutcome>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setInterval> | undefined;
      const eventName = `settled:${promptId}`;

      const settle = (outcome: PromptOutcome): void => {
        if (settled) return;
        settled = true;
        this.emitter.off(eventName, onSettled);
        signal?.removeEventListener('abort', onAbort);
        if (timer) clearInterval(timer);
        resolve(outcome);
      };

      const evaluate = (): void => {
        const row = this.getById(promptId);
        if (!row) return settle({ status: 'expired' });
        if (row.status === 'answered') return settle({ status: 'answered', row });
        if (row.status === 'expired') return settle({ status: 'expired' });
        if (new Date(row.expires_at).getTime() <= Date.now()) {
          this._getExpireOldStmt().run();
          this._emitSettled(promptId);
          return settle({ status: 'expired' });
        }
      };

      const onSettled = (): void => evaluate();
      const onAbort = (): void => settle({ status: 'aborted' });

      // Subscribe BEFORE the initial check so we never miss an answer that
      // arrives between evaluate() and the subscription.
      this.emitter.on(eventName, onSettled);
      if (signal) {
        if (signal.aborted) return settle({ status: 'aborted' });
        signal.addEventListener('abort', onAbort, { once: true });
      }
      timer = setInterval(evaluate, EXPIRY_CHECK_MS);

      // Fast path: prompt already settled.
      evaluate();
    });
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private _emitSettled(promptId: string): void {
    this.emitter.emit(`settled:${promptId}`);
  }

  private _getInsertStmt(): Database.Statement {
    return (this._stmtInsert ??= this.db.prepare(`
      INSERT INTO pending_prompts
        (id, session_id, prompt_type, question, options_json, questions_json,
         secret_name, secret_key_type, answer, answer_saved, status, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `));
  }

  private _getAnswerStmt(): Database.Statement {
    return (this._stmtAnswer ??= this.db.prepare(`
      UPDATE pending_prompts
      SET answer = ?, status = 'answered', answered_at = datetime('now')
      WHERE id = ? AND status = 'pending' AND expires_at > datetime('now')
    `));
  }

  private _getAnswerSecretStmt(): Database.Statement {
    return (this._stmtAnswerSecret ??= this.db.prepare(`
      UPDATE pending_prompts
      SET answer_saved = ?, status = 'answered', answered_at = datetime('now')
      WHERE id = ? AND status = 'pending' AND expires_at > datetime('now')
    `));
  }

  private _getSetPartialStmt(): Database.Statement {
    return (this._stmtSetPartial ??= this.db.prepare(`
      UPDATE pending_prompts
      SET partial_answers_json = ?
      WHERE id = ? AND status = 'pending'
    `));
  }

  private _getGetPendingStmt(): Database.Statement {
    return (this._stmtGetPending ??= this.db.prepare(`
      SELECT * FROM pending_prompts
      WHERE session_id = ? AND status = 'pending' AND expires_at > datetime('now')
      ORDER BY created_at DESC LIMIT 1
    `));
  }

  private _getGetByIdStmt(): Database.Statement {
    return (this._stmtGetById ??= this.db.prepare(`
      SELECT * FROM pending_prompts WHERE id = ?
    `));
  }

  private _getExpireOldStmt(): Database.Statement {
    return (this._stmtExpireOld ??= this.db.prepare(`
      UPDATE pending_prompts
      SET status = 'expired'
      WHERE status = 'pending' AND expires_at <= datetime('now')
    `));
  }

  private _getExpireAllStmt(): Database.Statement {
    return (this._stmtExpireAll ??= this.db.prepare(`
      UPDATE pending_prompts
      SET status = 'expired'
      WHERE status = 'pending'
    `));
  }
}
