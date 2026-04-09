/**
 * Persistent prompt store for resumable ask_user / ask_secret prompts.
 *
 * Stores pending prompts in SQLite so they survive SSE disconnects,
 * page reloads, and thread switches. The agent polls SQLite for answers
 * instead of holding a Promise resolve callback in RAM.
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

// ── Types ────────────────────────────────────────────────────────────────────

export type PromptType = 'ask_user' | 'ask_secret';
export type PromptStatus = 'pending' | 'answered' | 'expired';

export interface PendingPromptRow {
  id: string;
  session_id: string;
  prompt_type: PromptType;
  question: string;
  options_json: string | null;
  secret_name: string | null;
  secret_key_type: string | null;
  answer: string | null;
  answer_saved: number | null;
  status: PromptStatus;
  created_at: string;
  answered_at: string | null;
  expires_at: string;
}

// ── Constants ────────────────────────────────────────────────────────────────

const PROMPT_TTL_MS = 24 * 60 * 60_000; // 24 hours
const POLL_INTERVAL_MS = 2_000;

// ── Store ────────────────────────────────────────────────────────────────────

export class PromptStore {
  private readonly db: Database.Database;

  // Prepared statements (lazy-initialized)
  private _stmtInsert: Database.Statement | undefined;
  private _stmtAnswer: Database.Statement | undefined;
  private _stmtAnswerSecret: Database.Statement | undefined;
  private _stmtGetPending: Database.Statement | undefined;
  private _stmtGetById: Database.Statement | undefined;
  private _stmtExpireOld: Database.Statement | undefined;
  private _stmtExpireAll: Database.Statement | undefined;

  constructor(db: Database.Database) {
    this.db = db;
  }

  // ── Insert ──

  insertAskUser(sessionId: string, question: string, options?: string[]): string {
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + PROMPT_TTL_MS).toISOString();
    const optionsJson = options ? JSON.stringify(options) : null;
    this._getInsertStmt().run(
      id, sessionId, 'ask_user', question, optionsJson,
      null, null, null, null, 'pending', expiresAt,
    );
    return id;
  }

  insertAskSecret(sessionId: string, name: string, prompt: string, keyType?: string): string {
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + PROMPT_TTL_MS).toISOString();
    this._getInsertStmt().run(
      id, sessionId, 'ask_secret', prompt, null,
      name, keyType ?? null, null, null, 'pending', expiresAt,
    );
    return id;
  }

  // ── Answer ──

  /** Answer an ask_user prompt. Returns true if the prompt was pending and updated. */
  answerUser(promptId: string, answer: string): boolean {
    const result = this._getAnswerStmt().run(answer, promptId);
    return result.changes > 0;
  }

  /** Answer an ask_secret prompt. Returns true if the prompt was pending and updated. */
  answerSecret(promptId: string, saved: boolean): boolean {
    const result = this._getAnswerSecretStmt().run(saved ? 1 : 0, promptId);
    return result.changes > 0;
  }

  // ── Query ──

  /** Get the pending prompt for a session (at most one). */
  getPending(sessionId: string): PendingPromptRow | undefined {
    return this._getGetPendingStmt().get(sessionId) as PendingPromptRow | undefined;
  }

  /** Get a specific prompt by ID. */
  getById(promptId: string): PendingPromptRow | undefined {
    return this._getGetByIdStmt().get(promptId) as PendingPromptRow | undefined;
  }

  // ── Lifecycle ──

  /** Expire all prompts past their expires_at. */
  expireOld(): number {
    const result = this._getExpireOldStmt().run();
    return result.changes;
  }

  /** Expire ALL pending prompts (used on engine restart). */
  expireAll(): number {
    const result = this._getExpireAllStmt().run();
    return result.changes;
  }

  // ── Polling helper ──

  /**
   * Poll SQLite until the prompt is answered or expired.
   * Returns the answered row, or undefined if expired/timed out.
   *
   * The abort signal allows the caller (session.abort) to cancel the poll.
   */
  async waitForAnswer(promptId: string, signal?: AbortSignal): Promise<PendingPromptRow | undefined> {
    return new Promise<PendingPromptRow | undefined>((resolve) => {
      const check = (): void => {
        if (signal?.aborted) {
          resolve(undefined);
          return;
        }
        const row = this.getById(promptId);
        if (!row || row.status !== 'pending') {
          resolve(row?.status === 'answered' ? row : undefined);
          return;
        }
        // Check expiry
        if (new Date(row.expires_at).getTime() <= Date.now()) {
          this._getExpireOldStmt().run();
          resolve(undefined);
          return;
        }
        setTimeout(check, POLL_INTERVAL_MS);
      };

      // Handle abort signal
      if (signal) {
        signal.addEventListener('abort', () => resolve(undefined), { once: true });
      }

      // First check immediately
      check();
    });
  }

  // ── Prepared statements (lazy) ──

  private _getInsertStmt(): Database.Statement {
    return (this._stmtInsert ??= this.db.prepare(`
      INSERT INTO pending_prompts
        (id, session_id, prompt_type, question, options_json,
         secret_name, secret_key_type, answer, answer_saved, status, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
