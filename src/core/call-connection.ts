/**
 * Which connection the engine RESOLVED for a single tool call — recorded by the
 * engine, never by the model.
 *
 * `http_request` resolves the API profile of the URL's host on every call
 * (`attachEngineManagedAuth`) and, until this existed, dropped the answer. The
 * source-connection PRD needs it kept: deleting what came from a connection
 * starts from knowing which calls touched it.
 *
 * What the stamp means, and what it does not:
 *  - "the request URL's host belongs to this profile". It is written before the
 *    request is sent, so a call refused afterwards (vetted-host refusal, egress
 *    scans, host policy, consent) is stamped too; `is_error` tells those apart.
 *    It also covers what the call SENT to the connection, not only what it read.
 *  - It is a LOWER bound, not a complete list. A call is unstamped when its host
 *    maps to no profile — including a host variant the profile does not name —
 *    when two profiles share the host, and for pipeline-step calls (their rows
 *    are written from stream events by runner.ts). After a cross-host redirect
 *    the stamp keeps the first host's profile. So NULL means "unknown", and a
 *    consumer must never read the column as "everything from connection X".
 *
 * The slot is per CALL, not per agent. Tool dispatch fans out concurrently, so
 * an agent field would be written by whichever call resolved last. The agent
 * opens a slot around exactly one `tool.handler(...)` invocation; everything
 * that handler awaits runs inside it, and nothing outside it can see or fill it.
 *
 * Trust: the only writer is {@link noteCallConnection}, and its only caller is
 * the resolver in `http.ts`, fed by the profile store. No tool input reaches it,
 * so a value the model supplies cannot become the stamp.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface CallConnection {
  /** `connections.id` of the resolved profile. */
  id: string;
  /**
   * `connections.created_at` of that row at call time; null when the profile
   * has no engine.db row (the flat-JSON fallback). Together with `id` it usually
   * tells a profile apart from one deleted and recreated under the same id — but
   * not reliably: the column has one-second resolution, so a delete and re-create
   * inside one second give the same pair. And it does NOT tell apart a
   * re-authorisation of the same row under another account, nor a change of the
   * row's base_url: an upsert keeps `created_at`. The pair names a connection
   * ROW, not a grant.
   */
  createdAt: string | null;
}

/** One call's slot. `connection` stays undefined when nothing was resolved. */
export interface CallSlot {
  connection?: CallConnection | undefined;
}

const slotStorage = new AsyncLocalStorage<CallSlot>();

/** Run `fn` — one tool handler invocation — inside `slot`. Synchronous wrapper:
 *  it adds no microtask between the caller and `fn`. */
export function runInCallSlot<T>(slot: CallSlot, fn: () => T): T {
  return slotStorage.run(slot, fn);
}

/**
 * Record the connection the current call resolved. First write wins: one
 * `http_request` resolves its host once, and a later resolution inside the same
 * call must not overwrite the one the request was sent under. Outside a slot
 * (a bulk run's worker effect, a test calling the resolver directly) this is a
 * no-op.
 */
export function noteCallConnection(connection: CallConnection): void {
  const slot = slotStorage.getStore();
  if (slot && slot.connection === undefined) slot.connection = { ...connection };
}
