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
  created_at: string;
  updated_at: string;
}

export interface ThreadMessageRecord {
  id: number;
  thread_id: string;
  seq: number;
  role: string;
  content_json: string;
  created_at: string;
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
      opts?.model_tier ?? 'sonnet',
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
    const limit = opts?.limit ?? 50;
    const includeArchived = opts?.includeArchived ?? false;
    const sql = includeArchived
      ? 'SELECT * FROM threads ORDER BY updated_at DESC LIMIT ?'
      : 'SELECT * FROM threads WHERE is_archived = 0 ORDER BY updated_at DESC LIMIT ?';
    return this.db.prepare(sql).all(limit) as ThreadRecord[];
  }

  updateThread(id: string, updates: {
    title?: string | undefined;
    summary?: string | undefined;
    summary_up_to?: number | undefined;
    message_count?: number | undefined;
    total_tokens?: number | undefined;
    total_cost_usd?: number | undefined;
    is_archived?: boolean | undefined;
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

    if (sets.length === 0) return;

    sets.push("updated_at = datetime('now')");
    params.push(id);
    this.db.prepare(`UPDATE threads SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  deleteThread(id: string): void {
    this.db.prepare('DELETE FROM threads WHERE id = ?').run(id);
  }

  // ── Message Persistence ──

  appendMessages(threadId: string, messages: BetaMessageParam[], startSeq: number): void {
    const insert = this.db.prepare(`
      INSERT INTO thread_messages (thread_id, seq, role, content_json)
      VALUES (?, ?, ?, ?)
    `);

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
    });

    batch(messages, startSeq);
  }

  getMessages(threadId: string, opts?: {
    fromSeq?: number | undefined;
    limit?: number | undefined;
  }): ThreadMessageRecord[] {
    const fromSeq = opts?.fromSeq ?? 0;
    const limit = opts?.limit ?? 10_000;
    return this.db.prepare(
      'SELECT * FROM thread_messages WHERE thread_id = ? AND seq >= ? ORDER BY seq ASC LIMIT ?',
    ).all(threadId, fromSeq, limit) as ThreadMessageRecord[];
  }

  getMessageCount(threadId: string): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) as cnt FROM thread_messages WHERE thread_id = ?',
    ).get(threadId) as { cnt: number } | undefined;
    return row?.cnt ?? 0;
  }
}
