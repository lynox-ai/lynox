/**
 * Which connection a single tool call went through — recorded by the engine,
 * never by the model.
 *
 * `http_request` resolves the API profile of the URL's host on every call
 * (`attachEngineManagedAuth`) and, until this existed, dropped the answer. The
 * source-connection PRD needs it kept: deleting what came from a connection
 * starts from knowing which calls read it.
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
   * has no engine.db row (the flat-JSON fallback). Together with `id` it tells
   * a profile apart from one deleted and recreated under the same id. It does
   * NOT tell apart a re-authorisation of the same row under another account:
   * an upsert keeps `created_at`.
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
