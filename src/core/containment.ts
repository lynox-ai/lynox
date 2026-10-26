import type Database from 'better-sqlite3';
import type { IAgent } from '../types/index.js';
import { chatThreadOf } from '../tools/builtin/private-thread.js';
import { isProvisionedInstance } from './wire-capture.js';
import type { ThreadStore } from './thread-store.js';
import { isShopifyAdminHost, normalizeHostForMatch } from './shopify-host.js';
import { FOLLOW_UP_TOOL_NAME } from './follow-up-fallback.js';
import { effectiveWriteMethod, graphqlWrite, isGraphqlEndpoint, writeMethodsNamed, type BodyReadings } from './outbound-write.js';

/**
 * Containment: the record of which containers a store connection's credential was attached
 * for, in engine.db's `contained` table (v40).
 *
 * A container is a chat thread or a bulk run. It becomes contained for a connection when the
 * credential funnel (`tools/builtin/http.ts`) mints the request pass for that connection on its
 * behalf, after every refusal and before the pass exists; a refused request contains nothing,
 * and no request leaves without its row. A bulk run planned in a contained thread, and an undo
 * of a contained run, are contained in the transaction that inserts the run. A chat that reads
 * what a contained chat produced — a workflow run that chat started, through a diagnosis, the
 * chat context of a run, or a retry — is contained for the same connections before it reads
 * ({@link containThreadFrom}).
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
   * The threads among `threadIds` that are contained, in one read. Fail-closed like
   * {@link isContained}: an empty id, or a read that throws, counts as contained.
   */
  containedThreadIds(threadIds: readonly string[]): Set<string> {
    const named = threadIds.filter((id) => id !== '');
    const contained = new Set<string>(threadIds.filter((id) => id === ''));
    if (named.length === 0) return contained;
    try {
      const rows = this.db
        .prepare(`SELECT DISTINCT container_id AS id FROM contained WHERE container_kind = 'thread' AND container_id IN (${named.map(() => '?').join(',')})`)
        .all(...named) as Array<{ id: string }>;
      for (const row of rows) contained.add(row.id);
      return contained;
    } catch {
      return new Set(threadIds);
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

  /**
   * Contain a thread for every connection another thread is contained for, and answer how many
   * that were. A second call keeps the rows already there. Throws when the rows cannot be read
   * or written. Copies rows only; the reading thread's private flag is
   * {@link containThreadFrom}'s, which every reader goes through.
   */
  containFromThread(sourceThreadId: string, threadId: string): number {
    if (sourceThreadId === '' || threadId === '') throw new Error('a container needs an id');
    const rows = this.db.prepare(
      "SELECT kind, connection_id FROM contained WHERE container_kind = 'thread' AND container_id = ?",
    ).all(sourceThreadId) as { kind: string; connection_id: string }[];
    for (const r of rows) insertContained(this.db, 'thread', threadId, { kind: r.kind, connectionId: r.connection_id });
    return rows.length;
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

/** The contained threads among `threadIds`, with the no-store rule of {@link threadIsContained}. */
export function containedThreads(store: Containment | null, threadIds: readonly string[]): Set<string> {
  if (store === null) return isProvisionedInstance() ? new Set(threadIds) : new Set();
  return store.containedThreadIds(threadIds);
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

/**
 * Contain the thread that reads what a contained thread produced — a workflow run that chat
 * started — before anything of it is shown or run there: the reading thread gets every
 * connection of the source, and its own `skip_extraction` set and read back, as the credential
 * funnel does.
 *
 * Throws when that cannot be established: no store, no thread store, no reading thread, a
 * source with no row to copy (its containment was only a read that could not answer), or a
 * flag that does not hold. The caller then shows nothing.
 */
export function containThreadFrom(
  stores: {
    readonly containment: Containment | null;
    readonly threadStore: Pick<ThreadStore, 'getThread' | 'updateThread'> | null;
  },
  sourceThreadId: string,
  readerThreadId: string | undefined,
): void {
  if (readerThreadId === undefined || readerThreadId === '') throw new Error('the reader has no thread to contain');
  const { containment, threadStore } = stores;
  if (!containment) throw new Error('no containment store');
  if (!threadStore) throw new Error('no thread store');
  if (containment.containFromThread(sourceThreadId, readerThreadId) === 0) {
    throw new Error('the source has no containment row to copy');
  }
  // Read back, not trusted: an UPDATE of a thread row that does not exist changes nothing and
  // throws nothing.
  if (threadStore.getThread(readerThreadId)?.skip_extraction !== 1) threadStore.updateThread(readerThreadId, { skip_extraction: true });
  if (threadStore.getThread(readerThreadId)?.skip_extraction !== 1) throw new Error('the private flag did not hold');
}

/**
 * The answer a reader gives instead of a workflow run that a contained chat started, when the
 * reading chat could not be contained as well.
 */
export const CONTAINED_READ_REFUSAL =
  'Not shown: this run was started from a chat that read data through a store connection, and this engine could not record that this chat now reads that data too.';

/**
 * The tools a contained chat may call. What such a chat holds stays in the chat, so the set is
 * what reads, asks, or works inside it: `http_request` only to a store host
 * ({@link containedCallAllowed}) and only to read ({@link CONTAINED_WRITE_REFUSAL}), the reads of
 * memory and history, the follow-up chips, a question to the user, the child agents and workflow
 * steps (which are held by the same check, since they run for this chat), and the status of a
 * bulk run. Planning a bulk run is not on it: the run is planned in a chat that has not read the
 * store. Everything else — a tool registered later included — is refused.
 *
 * "A store" is any store host, not only the connections this chat is contained for. A read of
 * another store contains the chat for that one as well (the credential funnel in
 * `tools/builtin/http.ts`), and the chat sends a write to neither. Should a store write ever be
 * let through here, it has to be bound to the connections the chat is contained for, or what the
 * chat read from one store lands in another where erasing the first does not find it.
 */
export const CONTAINED_TOOLS: ReadonlySet<string> = Object.freeze(new Set<string>([
  'http_request',
  'memory_recall',
  'memory_list',
  'recall',
  'archive_search',
  'recall_tool_result',
  FOLLOW_UP_TOOL_NAME,
  'ask_user',
  'spawn_agent',
  'run_workflow',
  'bulk_status',
]));

/**
 * Hosts a contained chat may reach besides the store's own, such as the store's asset CDN.
 * Empty: which hosts a store's data is served from has not been measured yet, and a host named
 * here without that could carry the data out.
 */
export const CONTAINED_CDN_HOSTS: ReadonlySet<string> = Object.freeze(new Set<string>());

/** Whether a contained chat may make this call (see {@link CONTAINED_TOOLS}). */
export function containedCallAllowed(name: string, input: unknown): boolean {
  return containedCallRefusal(name, input) === null;
}

/**
 * The answer a contained chat gets for this call, or `null` when it may make it: a store write
 * gets {@link CONTAINED_WRITE_REFUSAL}, everything else not on the list
 * {@link CONTAINED_CALL_REFUSAL}. Read at dispatch, before any prompt; `tools/builtin/http.ts`
 * reads the write again from the request as it is sent.
 */
export function containedCallRefusal(name: string, input: unknown): string | null {
  if (!CONTAINED_TOOLS.has(name)) return CONTAINED_CALL_REFUSAL;
  if (name !== 'http_request') return null;
  const url = fieldOf(input, 'url');
  if (typeof url !== 'string' || !storeRequestUrl(url)) return CONTAINED_CALL_REFUSAL;
  const method = fieldOf(input, 'method') ?? 'GET';
  const headers = fieldOf(input, 'headers') ?? {};
  const body = fieldOf(input, 'body');
  // A field of a shape the tool does not take is a write until the tool says otherwise.
  if (typeof method !== 'string' || (body !== undefined && typeof body !== 'string')) return CONTAINED_WRITE_REFUSAL;
  if (typeof headers !== 'object' || headers === null || Object.values(headers).some((v) => typeof v !== 'string')) return CONTAINED_WRITE_REFUSAL;
  return containedStoreWrite(method, headers as Record<string, string>, url, body) ? CONTAINED_WRITE_REFUSAL : null;
}

/**
 * Whether a request writes, as a contained chat is held to it: a method, or any override the
 * request names, that is not a read — or one that is not a method at all. The one write that
 * reads is a GraphQL query: sent as a POST, naming no other method, to a GraphQL endpoint without
 * a query string, whose document `graphqlWrite` reads as no mutation. `readings` is the body as
 * the method gates read it, where the sender repairs it before sending; the GraphQL document is
 * read from the body as given, which is the one `graphqlWrite` accepts.
 */
export function containedStoreWrite(method: string, headers: Record<string, string>, url: string, body: unknown, readings?: BodyReadings): boolean {
  const gateBody = readings ?? (typeof body === 'string' ? body : undefined);
  if (effectiveWriteMethod(method, headers, url, gateBody) === null) return true;
  const named = writeMethodsNamed(method, headers, url, gateBody);
  if (named.length === 0) return false;
  if (method.trim().toUpperCase() !== 'POST' || named.length !== 1 || named[0] !== 'POST') return true;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return true; }
  if (!isGraphqlEndpoint(url) || parsed.search.length > 1) return true;
  const reading = graphqlWrite(headers, body);
  return 'refusal' in reading || reading.mutates;
}

function fieldOf(input: unknown, key: string): unknown {
  return typeof input === 'object' && input !== null ? (input as Record<string, unknown>)[key] : undefined;
}

function storeRequestUrl(url: string): boolean {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.protocol !== 'https:') return false;
  const host = normalizeHostForMatch(parsed.hostname);
  return isShopifyAdminHost(host) || CONTAINED_CDN_HOSTS.has(host);
}

/**
 * The answer a contained chat gets for a call outside {@link CONTAINED_TOOLS}. It names the
 * reason and where other work belongs, and nothing about which call would get through.
 */
export const CONTAINED_CALL_REFUSAL =
  'Not run: this chat has read data through a store connection, or this engine cannot read whether it has, and what it holds stays in this chat. '
  + 'Work that does not need the store\'s data belongs in a new chat.';

/**
 * The answer a contained chat gets for a write to a store host (`tools/builtin/http.ts`): such a
 * chat only reads. A change to the store belongs in a chat that has not read it, or in a bulk run
 * planned there.
 */
export const CONTAINED_WRITE_REFUSAL =
  'Not sent: this chat has read data through a store connection, or this engine cannot read whether it has, so it only reads the store and changes nothing there. '
  + 'A change to the store belongs in a new chat, or in a bulk run planned in one.';
