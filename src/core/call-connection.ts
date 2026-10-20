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
 *    when two profiles share the host. A sub-agent spawned inside a pipeline
 *    step writes no call row at all. After a cross-host redirect
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
  /**
   * The grant the host's profile held when the call resolved its URL (`oauth_grant.grant_id`,
   * PRD connection-attribution A3): one epoch of the connection, which the row pair above cannot
   * tell apart. Like the rest of the stamp it says which connection the host belonged to, not
   * that credentials were sent: a profile without engine-managed auth, or a call refused after
   * the resolver, carries it too. Null when the profile holds none.
   *
   * It is the grant the profile holds in memory, not checked against the ledger at call time.
   * Normally `ApiStore` minted it and engine.db `connection_grants` records it for this
   * connection. Without engine.db the store keeps whatever grant a profile file brought along,
   * and a re-mint that fails (at boot, or after a credential write) leaves the old one in place
   * until the next boot. A reader therefore selects by `connection_id` and lets a grant count
   * only where the ledger records it for that same connection; any other grant, like NULL, is
   * unknown. That check does not catch an earlier epoch of the same connection (a superseded
   * grant, or one of a deleted connection with the same id), so a reader that needs the epoch
   * treats a grant that was not the connection's latest at the call's time as uncertain.
   *
   * Read before the credential attach. A grant minted after that, by a consent callback that
   * completes in between or by the attach's own renewal when it presents a token the epoch does
   * not know, is not on this call; the next call carries it.
   */
  grantId: string | null;
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
  /** Aborted when the engine stops waiting for this call (its tool timeout), and when the run
   *  the call belongs to is stopped (`stoppedByRun`). A question the call raised carries this
   *  signal, so it is withdrawn with the call instead of staying open and holding the session's
   *  one pending prompt. A handler that does I/O passes it on, so a stop ends the I/O instead of
   *  waiting for the handler's own limit. */
  abort?: AbortController | undefined;
  /** Set when `abort` fired because the run was stopped, not because the call timed out. */
  stoppedByRun?: boolean | undefined;
  /** How many questions this call is waiting on right now. */
  awaitingAnswers?: number | undefined;
  /** Set once anything in this call tried to reach the network (`fetchPinned`). A call that
   *  never got that far — refused before sending — took no data from its connection, so its
   *  grant does not enter the conversation's set (`ConversationGrants`). */
  contactedNetwork?: boolean | undefined;
  /** Set by {@link noteGrantLift} when a write grant let this call's write through. */
  grantLift?: GrantLift | undefined;
  /** How many calls of this call's tool batch are this same call (the same tool with the same
   *  input as the model wrote it), itself included. A write approval asked for one of them sends
   *  that many (`http_request`). */
  twins?: number | undefined;
}

/**
 * The mark of a write a grant let through: which accepted grant (`workflow_grants.id`) and
 * which part of its contract.
 *
 * Two rules keep this field readable by later additions without a schema break:
 *  - It means "lifted by this grant", and only that. A refusal, a held-back contract, a gate's
 *    state or the call's outcome go into fields of their own, never into this one as a state:
 *    otherwise "present = lifted" turns false for every reader written against it.
 *  - `entry: 'v1'` means the one HTTP tuple of a v1 contract, and that in v1 only the write
 *    gate in `http_request` (`contractGrantsWrite`) sets the mark. A missing mark under v1
 *    does not say "the danger check did not lift": that check also lifts warn-level calls
 *    that are no write. A later mark from another place uses a new `entry` value, so records
 *    already written keep their meaning.
 */
export interface GrantLift {
  grantId: string;
  entry: 'v1';
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

/** How many calls of the current batch are this same call, itself included; 1 outside a slot. */
export function currentCallTwins(): number {
  return slotStorage.getStore()?.twins ?? 1;
}

/** The current call's abort signal; `undefined` outside a slot or for a slot without one. */
export function currentCallSignal(): AbortSignal | undefined {
  return slotStorage.getStore()?.abort?.signal;
}

/** Count `answer` as a question the current call waits on until it settles; outside a slot it
 *  is returned as is. */
export function trackCallAnswer<T>(answer: Promise<T>): Promise<T> {
  const slot = slotStorage.getStore();
  if (!slot) return answer;
  slot.awaitingAnswers = (slot.awaitingAnswers ?? 0) + 1;
  return answer.finally(() => { slot.awaitingAnswers = (slot.awaitingAnswers ?? 1) - 1; });
}

/**
 * Mark the current call as a write the grant `lift` names let through. Called at the one place
 * that lets an unattended write through on a grant, and nowhere else; outside a slot a no-op.
 * The mark is not cleared when the call fails afterwards: the write was let through, and what
 * became of it is the call's outcome, not part of the mark.
 */
export function noteGrantLift(lift: GrantLift): void {
  const slot = slotStorage.getStore();
  if (slot) slot.grantLift = { ...lift };
}

/** The mark {@link noteGrantLift} left on `slot`, as a copy; `undefined` when none did. */
export function grantLiftOf(slot: CallSlot): GrantLift | undefined {
  return slot.grantLift === undefined ? undefined : { ...slot.grantLift };
}

/** Mark the current call as one that tried to reach the network; outside a slot a no-op. */
export function noteNetworkContact(): void {
  const slot = slotStorage.getStore();
  if (slot) slot.contactedNetwork = true;
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
