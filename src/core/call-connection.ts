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
 *    scans, host policy, consent) is stamped too; a non-empty `output_json`
 *    marks those rows. Refusals BEFORE the resolver (rate limits, a CRLF header)
 *    leave the row unstamped.
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
 * opens a slot around exactly one tool dispatch (the handler, or the worker
 * pool's execute); everything that dispatch awaits runs inside it, and nothing outside it can see or fill it.
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
  /** Every `<untrusted_data>` block `wrapUntrustedData` produced while this call ran,
   *  byte for byte: in the handler and in anything it awaited in the same async context
   *  (a sub-agent's prompt building included; a sub-agent's own tool calls run in their
   *  own slot). The result scan takes the closer of exactly these blocks as the engine's
   *  own (see `scanToolResult`); a closer anywhere else stays in the scan. */
  wrapped?: string[] | undefined;
  /** The host whose answer this call returned, reported by `http_request` only when every
   *  hop of the request stayed on that host. It lets the answer's untrusted marker keep that
   *  host's write approvals (see `untrusted-epoch.ts`). `null` once two different hosts were
   *  reported; unset or `null`, the answer counts as foreign content. */
  answeredBy?: string | null | undefined;
  /** Set once anything in this call tried to reach the network (`fetchPinned`). An
   *  `http_request` result after that may carry server bytes even when it is an error,
   *  so it counts as foreign content unless it is an answer reported for one host. */
  contactedNetwork?: boolean | undefined;
}

const slotStorage = new AsyncLocalStorage<CallSlot>();

/** Run `fn` — one tool handler invocation — inside `slot`. Synchronous wrapper:
 *  it adds no microtask between the caller and `fn`. */
export function runInCallSlot<T>(slot: CallSlot, fn: () => T): T {
  return slotStorage.run(slot, fn);
}

/**
 * Record a block `wrapUntrustedData` produced while the current call runs. Outside a
 * slot (prompt building between calls, a test calling the wrapper directly) this is a
 * no-op, so nothing recorded here can reach another call's scan. A block from
 * `wrapUntrustedData` is balanced (a literal opener, a body with every boundary tag
 * neutralized, its closer), so exempting it cannot close a block it sits inside. The
 * one other caller, `recall_tool_result`, records a stored payload that need not be:
 * there only its last closer is exempted and any closer inside it stays in the scan.
 */
export function noteOwnWrapped(block: string): void {
  const slot = slotStorage.getStore();
  if (slot) (slot.wrapped ??= []).push(block);
}

/** Mark the current call as one that tried to reach the network; outside a slot a no-op. */
export function noteNetworkContact(): void {
  const slot = slotStorage.getStore();
  if (slot) slot.contactedNetwork = true;
}

/** Report the host that answered the current call. A second, different host makes the
 *  answer foreign; outside a slot this is a no-op. */
export function noteAnsweredBy(host: string): void {
  const slot = slotStorage.getStore();
  if (!slot) return;
  slot.answeredBy = slot.answeredBy === undefined || slot.answeredBy === host ? host : null;
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
