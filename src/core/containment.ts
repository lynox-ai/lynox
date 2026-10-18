import type Database from 'better-sqlite3';
import type { IAgent } from '../types/index.js';
import { chatThreadOf } from '../tools/builtin/private-thread.js';
import { isProvisionedInstance } from './wire-capture.js';

/**
 * Containment: the record of which containers a store connection's credential was attached
 * for, in engine.db's `contained` table (v40).
 *
 * A container is a chat thread or a bulk run. It becomes contained for a connection when the
 * credential funnel (`tools/builtin/http.ts`) mints the request pass for that connection on its
 * behalf, after every refusal and before the pass exists; a refused request contains nothing,
 * and no request leaves without its row. A bulk run planned in a contained thread, and an undo
 * of a contained run, are contained in the transaction that inserts the run.
 *
 * Containment is never undone for the life of the container: this module has no way to delete
 * or change a row, and the table refuses every UPDATE. Only the owner's erasure empties it.
 *
 * ⚠ Polarity is the reverse of private mode's (`private-thread.ts`): there, a missing row means
 * "not private". Here every read that cannot answer — no store, a store that throws, a key that
 * names no container — answers "contained", because the cost of a wrong "no" is data leaving
 * the container.
 */

/** The container a request is attached for. A thread for an agent's request, a run for a bulk run's. */
export type StoreContainer =
  | { readonly threadId: string | undefined }
  | { readonly bulkRunId: string };

/** The connection a container is contained for. `kind` is the connection's kind (`api` for an API profile). */
export interface ContainedConnection {
  readonly kind: string;
  readonly connectionId: string;
}

/**
 * The thread an agent's requests are contained under: its own, or for a `spawn_agent` child or
 * a workflow step — which have no `currentThreadId` — the chat it runs for. The same thread the
 * memory tools check for private mode.
 */
export function containerThreadOf(agent: Pick<IAgent, 'currentThreadId' | 'originThreadId'>): string | undefined {
  return chatThreadOf(agent);
}

/** The container of an agent's own request: its thread ({@link containerThreadOf}), which may be absent. */
export function containerOf(agent: Pick<IAgent, 'currentThreadId' | 'originThreadId'>): StoreContainer {
  return { threadId: containerThreadOf(agent) };
}

export class Containment {
  constructor(private readonly db: Database.Database) {}

  /**
   * Whether the thread or the bulk run (either is enough) is contained for any connection.
   * Synchronous and fail-closed: a key that names neither, or a read that throws, is `true`.
   */
  isContained(key: { threadId?: string | undefined; bulkRunId?: string | undefined }): boolean {
    const threadId = key.threadId !== undefined && key.threadId !== '' ? key.threadId : undefined;
    const bulkRunId = key.bulkRunId !== undefined && key.bulkRunId !== '' ? key.bulkRunId : undefined;
    if (threadId === undefined && bulkRunId === undefined) return true;
    try {
      const has = this.db.prepare('SELECT 1 FROM contained WHERE container_kind = ? AND container_id = ? LIMIT 1');
      if (threadId !== undefined && has.get('thread', threadId) !== undefined) return true;
      if (bulkRunId !== undefined && has.get('bulk_run', bulkRunId) !== undefined) return true;
      return false;
    } catch {
      return true;
    }
  }

  /**
   * Record the container as contained for the connection. A second call for the same pair
   * keeps the first row and its `first_at`. Throws when the row cannot be written: the caller
   * then refuses the request it was about to send.
   */
  contain(container: { kind: 'thread' | 'bulk_run'; id: string }, connection: ContainedConnection): void {
    if (container.id === '') throw new Error('a container needs an id');
    insertContained(this.db, container.kind, container.id, connection);
  }
}

function insertContained(db: Database.Database, kind: 'thread' | 'bulk_run', id: string, c: ContainedConnection): void {
  db.prepare(
    `INSERT OR IGNORE INTO contained (container_kind, container_id, kind, connection_id, first_at)
     VALUES (?, ?, ?, ?, datetime('now'))`,
  ).run(kind, id, c.kind, c.connectionId);
}

/**
 * Contain a new bulk run for every connection its planning thread is contained for. Called
 * inside the transaction that inserts the run, before the insert, so the two land together or
 * not at all. A read that throws aborts that transaction: no run is planned whose containment
 * could not be established.
 */
export function containRunFromThread(db: Database.Database, threadId: string | undefined, runId: string): void {
  if (threadId === undefined || threadId === '') return;
  copyContainment(db, 'thread', threadId, runId);
}

/**
 * Contain an undo run for every connection its source run is contained for. Same transaction
 * rule as {@link containRunFromThread}.
 */
export function containRunFromRun(db: Database.Database, sourceRunId: string, runId: string): void {
  copyContainment(db, 'bulk_run', sourceRunId, runId);
}

function copyContainment(db: Database.Database, fromKind: 'thread' | 'bulk_run', fromId: string, runId: string): void {
  const rows = db.prepare(
    'SELECT kind, connection_id FROM contained WHERE container_kind = ? AND container_id = ?',
  ).all(fromKind, fromId) as { kind: string; connection_id: string }[];
  for (const r of rows) insertContained(db, 'bulk_run', runId, { kind: r.kind, connectionId: r.connection_id });
}

/**
 * Whether the agent's chat is contained, read from the store, never from an in-memory flag: a
 * `spawn_agent` child's request contains the chat it was spawned from, and the chat's own agent
 * holds no flag for that.
 *
 * An agent with no chat thread is not contained by a thread: the funnel refuses to attach a
 * store connection without a container, so such an agent never contained one.
 *
 * Without a store the answer depends on the instance: on a provisioned instance — the only
 * kind where the funnel can attach a store connection — the containment of this chat cannot be
 * read, so it counts as contained. Elsewhere no store request was ever sent, so nothing is
 * contained.
 */
export function chatIsContained(agent: Pick<IAgent, 'currentThreadId' | 'originThreadId' | 'toolContext'>): boolean {
  const threadId = containerThreadOf(agent);
  if (threadId === undefined || threadId === '') return false;
  return threadIsContained(agent.toolContext?.containment ?? null, threadId);
}

/** Whether a thread is contained, with the no-store rule of {@link chatIsContained}. */
export function threadIsContained(store: Containment | null, threadId: string): boolean {
  // The wider of the two markers: a provisioned instance whose control-plane env is incomplete
  // this boot may still have attached in an earlier one.
  if (store === null) return isProvisionedInstance();
  return store.isContained({ threadId });
}

/**
 * The answer a memory-writing tool gives in a contained chat, or `null`. What this chat read
 * through a store connection must not leave it, and memory outlives the chat.
 */
export function containedRefusal(agent: Pick<IAgent, 'currentThreadId' | 'originThreadId' | 'toolContext'>): string | null {
  if (!chatIsContained(agent)) return null;
  // "or": the same answer is given when the record cannot be read, and then it is not known.
  return 'Not stored: this chat has read data through a store connection, or this engine cannot read whether it has, and what it holds is not kept in memory. '
    + 'Work that should be remembered belongs in a new chat that does not read the store.';
}
