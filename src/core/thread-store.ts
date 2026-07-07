import type Database from 'better-sqlite3';
import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages.js';

export interface ThreadRecord {
  id: string;
  title: string;
  model_tier: string;
  context_id: string;
  message_count: number;
  total_tokens: number;
  total_cost_usd: number;
  summary: string | null;
  summary_up_to: number;
  is_archived: number; // SQLite boolean
  is_favorite: number; // SQLite boolean
  skip_extraction: number; // SQLite boolean — disable KG extraction for this thread
  /** Slice B3: 1 = the agent opened/bumped this thread with context the user
   *  hasn't seen yet (a failed run, a watcher finding). Floats to the top of the
   *  thread list until opened. SQLite boolean. */
  is_unread: number;
  /** Context-Hierarchy Scoping (Slice A): this thread's anchor subject — a
   *  project/customer subject id (engine.db `subjects`). Soft ref (subjects live in
   *  a different DB → no FK). NULL = un-anchored. Drives the default subject_id on
   *  this thread's memory writes (Slice B) + the retrieval walk-up weight (Slice C). */
  primary_subject_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ThreadMessageRecord {
  id: number;
  thread_id: string;
  seq: number;
  role: string;
  content_json: string;
  /** JSON-encoded token/cost rollup, or null. Only the final assistant
   *  message of a run carries it — see `ThreadStore.setMessageUsage`. */
  usage_json: string | null;
  /** 1 = display-only row (B-full failed-turn note + failed user message):
   *  rendered in the UI but excluded from the model's API context. 0 = an
   *  ordinary API message. See migration v32. */
  display_only: number;
  created_at: string;
}

/** A display-only row to persist for a failed turn — never enters the model's
 *  API context. `note` carries a structured marker the render projection turns
 *  into a localized failure note; a plain user message has no `note`. */
export interface DisplayNoteInput {
  role: 'user' | 'assistant';
  /** Raw content, JSON-serialized as-is. Either ordinary message content
   *  (the failed user message text/blocks) or a structured failure-note
   *  marker (`{ _lynox_note: { code, detail } }`) the render projection
   *  turns into a localized note. */
  content: unknown;
}

export class ThreadStore {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  // ── Thread CRUD ──

  createThread(id: string, opts?: {
    title?: string | undefined;
    model_tier?: string | undefined;
    context_id?: string | undefined;
  }): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO threads (id, title, model_tier, context_id)
      VALUES (?, ?, ?, ?)
    `).run(
      id,
      opts?.title ?? '',
      opts?.model_tier ?? 'balanced',
      opts?.context_id ?? '',
    );
  }

  getThread(id: string): ThreadRecord | undefined {
    return this.db.prepare('SELECT * FROM threads WHERE id = ?').get(id) as ThreadRecord | undefined;
  }

  listThreads(opts?: {
    limit?: number | undefined;
    includeArchived?: boolean | undefined;
  }): ThreadRecord[] {
    const limit = Math.min(opts?.limit ?? 50, 200);
    const includeArchived = opts?.includeArchived ?? false;
    // Slice B3: unread (agent-escalated) threads float to the very top, then the
    // existing favorite/recency order.
    const sql = includeArchived
      ? 'SELECT * FROM threads WHERE message_count > 0 ORDER BY is_unread DESC, is_favorite DESC, updated_at DESC LIMIT ?'
      : 'SELECT * FROM threads WHERE is_archived = 0 AND message_count > 0 ORDER BY is_unread DESC, is_favorite DESC, updated_at DESC LIMIT ?';
    return this.db.prepare(sql).all(limit) as ThreadRecord[];
  }

  /**
   * Record-on-spine R2b: threads anchored to a subject (`idx_threads_subject`),
   * most-recent activity first. Reads whatever thread source this store wraps — in
   * production `this._threadStore` is the LIVE history.db handle the anchor writes
   * go to (`set_thread_context`), so the footprint stays correct across the S2
   * cutover with no flip-branching here.
   */
  listBySubjectId(subjectId: string, limit = 50): ThreadRecord[] {
    const safeLimit = Math.max(1, Math.min(limit, 500));
    return this.db.prepare(
      'SELECT * FROM threads WHERE primary_subject_id = ? ORDER BY updated_at DESC LIMIT ?',
    ).all(subjectId, safeLimit) as ThreadRecord[];
  }

  updateThread(id: string, updates: {
    title?: string | undefined;
    summary?: string | undefined;
    summary_up_to?: number | undefined;
    message_count?: number | undefined;
    total_tokens?: number | undefined;
    total_cost_usd?: number | undefined;
    is_archived?: boolean | undefined;
    is_favorite?: boolean | undefined;
    skip_extraction?: boolean | undefined;
    is_unread?: boolean | undefined;
    /** Slice A: set (string) or clear (null) the thread's anchor subject.
     *  `undefined` leaves it unchanged (whitelist semantics — null is a real clear). */
    primary_subject_id?: string | null | undefined;
  }): void {
    const sets: string[] = [];
    const params: unknown[] = [];

    if (updates.title !== undefined) { sets.push('title = ?'); params.push(updates.title); }
    if (updates.summary !== undefined) { sets.push('summary = ?'); params.push(updates.summary); }
    if (updates.summary_up_to !== undefined) { sets.push('summary_up_to = ?'); params.push(updates.summary_up_to); }
    if (updates.message_count !== undefined) { sets.push('message_count = ?'); params.push(updates.message_count); }
    if (updates.total_tokens !== undefined) { sets.push('total_tokens = ?'); params.push(updates.total_tokens); }
    if (updates.total_cost_usd !== undefined) { sets.push('total_cost_usd = ?'); params.push(updates.total_cost_usd); }
    if (updates.is_archived !== undefined) { sets.push('is_archived = ?'); params.push(updates.is_archived ? 1 : 0); }
    if (updates.is_favorite !== undefined) { sets.push('is_favorite = ?'); params.push(updates.is_favorite ? 1 : 0); }
    if (updates.skip_extraction !== undefined) { sets.push('skip_extraction = ?'); params.push(updates.skip_extraction ? 1 : 0); }
    if (updates.is_unread !== undefined) { sets.push('is_unread = ?'); params.push(updates.is_unread ? 1 : 0); }
    // null is a real value here (clear the anchor); only `undefined` means "skip".
    if (updates.primary_subject_id !== undefined) { sets.push('primary_subject_id = ?'); params.push(updates.primary_subject_id); }

    if (sets.length === 0) return;

    sets.push("updated_at = datetime('now')");
    params.push(id);
    this.db.prepare(`UPDATE threads SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  /** Slice B3: clear the unread flag (the user opened the escalated thread).
   *  Does NOT bump updated_at — reading shouldn't re-sort the list. */
  markThreadRead(id: string): void {
    this.db.prepare('UPDATE threads SET is_unread = 0 WHERE id = ?').run(id);
  }

  /**
   * Retroactive-merge support: repoint every thread anchored to `fromSubjectId`
   * onto `toSubjectId`. history.db carries the LIVE thread anchor (engine.db's
   * `threads` is an empty mirror), so a subject merge must repoint it HERE — else
   * the thread stays anchored to the now-archived duplicate and keeps attaching new
   * memories to it. Returns the ids of the threads it repointed (for the merge
   * ledger's rollback); empty when nothing was anchored to the dup. Does NOT bump
   * updated_at — a structural repoint shouldn't re-sort the user's thread list.
   */
  repointPrimarySubject(fromSubjectId: string, toSubjectId: string): string[] {
    const affected = this.db
      .prepare('SELECT id FROM threads WHERE primary_subject_id = ?')
      .all(fromSubjectId) as Array<{ id: string }>;
    if (affected.length === 0) return [];
    this.db
      .prepare('UPDATE threads SET primary_subject_id = ? WHERE primary_subject_id = ?')
      .run(toSubjectId, fromSubjectId);
    return affected.map(r => r.id);
  }

  /** Reverse {@link repointPrimarySubject}: set the named threads back to `toSubjectId`. */
  restorePrimarySubject(threadIds: readonly string[], toSubjectId: string): void {
    const stmt = this.db.prepare('UPDATE threads SET primary_subject_id = ? WHERE id = ?');
    for (const id of threadIds) stmt.run(toSubjectId, id);
  }

  deleteThread(id: string): void {
    this.db.prepare('DELETE FROM threads WHERE id = ?').run(id);
  }

  // ── Message Persistence ──

  appendMessages(threadId: string, messages: BetaMessageParam[], startSeq: number, threadUpdates?: {
    message_count?: number | undefined;
    total_tokens?: number | undefined;
    total_cost_usd?: number | undefined;
  }): void {
    const insert = this.db.prepare(`
      INSERT INTO thread_messages (thread_id, seq, role, content_json)
      VALUES (?, ?, ?, ?)
    `);

    // Share one transaction (and one fsync under WAL) between the insert
    // batch and the rollup updateThread — better-sqlite3 includes any
    // statement run inside the batch lambda in the same atomic boundary.
    // P1 from /pr-review #456 — was two fsyncs per checkpoint, now one.
    const batch = this.db.transaction((msgs: BetaMessageParam[], start: number) => {
      for (let i = 0; i < msgs.length; i++) {
        const msg = msgs[i]!;
        insert.run(
          threadId,
          start + i,
          msg.role,
          JSON.stringify(msg.content),
        );
      }
      if (threadUpdates) this.updateThread(threadId, threadUpdates);
    });

    batch(messages, startSeq);
  }

  /**
   * Append display-only rows (B-full) for a failed turn. These are persisted
   * with display_only=1 so they render on reload but are never fed back into
   * the model's API context. `startSeq` must be the thread's total message
   * count (MAX(seq)+1) so the rows sort AFTER the surviving API messages.
   */
  appendDisplayNotes(threadId: string, notes: DisplayNoteInput[], startSeq: number): void {
    if (notes.length === 0) return;
    const insert = this.db.prepare(`
      INSERT INTO thread_messages (thread_id, seq, role, content_json, display_only)
      VALUES (?, ?, ?, ?, 1)
    `);
    const batch = this.db.transaction((items: DisplayNoteInput[], start: number) => {
      for (let i = 0; i < items.length; i++) {
        const n = items[i]!;
        insert.run(threadId, start + i, n.role, JSON.stringify(n.content));
      }
    });
    batch(notes, startSeq);
  }

  /**
   * Convert a failed run's persisted footprint to display-only (B-full). The
   * agent rolls its in-memory API context back to before the failed turn; this
   * mirrors that on disk so any rows the run eager-persisted (the user message
   * + partial assistant iterations) still render on reload but never re-enter
   * the model's context. Only flips rows currently display_only=0. Returns how
   * many rows were flipped and whether a user message was among them (so the
   * caller knows whether the failed user turn already survives in display
   * history or still needs to be appended).
   */
  markDisplayOnlyFrom(threadId: string, fromSeq: number): { marked: number; hadUserMessage: boolean } {
    const rows = this.db.prepare(
      "SELECT role FROM thread_messages WHERE thread_id = ? AND seq >= ? AND display_only = 0",
    ).all(threadId, fromSeq) as Array<{ role: string }>;
    if (rows.length === 0) return { marked: 0, hadUserMessage: false };
    this.db.prepare(
      'UPDATE thread_messages SET display_only = 1 WHERE thread_id = ? AND seq >= ? AND display_only = 0',
    ).run(threadId, fromSeq);
    return { marked: rows.length, hadUserMessage: rows.some((r) => r.role === 'user') };
  }

  getMessages(threadId: string, opts?: {
    fromSeq?: number | undefined;
    limit?: number | undefined;
    /** Exclude display-only rows — used when hydrating the model's API
     *  context (session resume) so failed-turn notes never re-enter the
     *  prompt. The render path leaves this false to show full history. */
    apiOnly?: boolean | undefined;
  }): ThreadMessageRecord[] {
    const fromSeq = opts?.fromSeq ?? 0;
    const limit = opts?.limit ?? 10_000;
    const apiClause = opts?.apiOnly ? ' AND display_only = 0' : '';
    return this.db.prepare(
      `SELECT * FROM thread_messages WHERE thread_id = ? AND seq >= ?${apiClause} ORDER BY seq ASC LIMIT ?`,
    ).all(threadId, fromSeq, limit) as ThreadMessageRecord[];
  }

  /** Total row count (incl. display-only). Use for the next seq when
   *  appending so seqs stay globally monotonic across both kinds. */
  getMessageCount(threadId: string): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) as cnt FROM thread_messages WHERE thread_id = ?',
    ).get(threadId) as { cnt: number } | undefined;
    return row?.cnt ?? 0;
  }

  /** Count of API rows only (display_only=0). This is the count the caller
   *  slices `agent.messages` against — display-only rows are absent from the
   *  agent's in-memory array, so using the total here would misalign the
   *  "which messages are new" computation once a failed turn has persisted
   *  a note. Equals getMessageCount() until the first display note exists. */
  getApiMessageCount(threadId: string): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) as cnt FROM thread_messages WHERE thread_id = ? AND display_only = 0',
    ).get(threadId) as { cnt: number } | undefined;
    return row?.cnt ?? 0;
  }

  /** Next seq to assign when appending — `MAX(seq)+1`, NOT `COUNT(*)`.
   *  Count-based seq reuses values after any row deletion (seq collision +
   *  silent reorder on the `ORDER BY seq` load). MAX+1 stays strictly
   *  monotonic and crash-safe regardless of deletions. Equals getMessageCount()
   *  on an append-only thread; diverges (safely) once a row is ever removed. */
  getNextSeq(threadId: string): number {
    const row = this.db.prepare(
      'SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM thread_messages WHERE thread_id = ?',
    ).get(threadId) as { next: number } | undefined;
    return row?.next ?? 0;
  }

  /**
   * Attach a JSON token/cost rollup to a thread's most recent assistant
   * message. Called once per run at run-end so the per-message usage footer
   * survives a thread resume. Self-targets the highest-seq NON-display
   * assistant row, so neither a trailing tool_result carrier nor a B-full
   * failure note can divert the stamp; a no-op when the thread has no
   * assistant message yet.
   */
  setMessageUsage(threadId: string, usageJson: string): void {
    this.db.prepare(
      `UPDATE thread_messages SET usage_json = ?
       WHERE id = (
         SELECT id FROM thread_messages
         WHERE thread_id = ? AND role = 'assistant' AND display_only = 0
         ORDER BY seq DESC LIMIT 1
       )`,
    ).run(usageJson, threadId);
  }
}
