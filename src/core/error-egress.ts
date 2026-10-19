/**
 * The text of an error, as it may leave the engine: on stderr (the container log) and in a push.
 *
 * A provider puts the body of its answer into the error it throws (the OpenAI-compatible adapter
 * reads it whole into the message; the Anthropic SDK carries it in `message`). In a contained
 * container that body can quote what the run read from a store, so there an error leaves as its
 * class and HTTP status only, as `judgeErrorForTracker` already reports bulk-judge failures
 * (PRD-SHOPIFY-CONTAINMENT-ERASURE E4).
 *
 * Which errors: a sink that knows its thread or bulk run asks `Containment.isContained`. A sink
 * that does not (the HTTP catch-all, the process-wide handlers) reduces every error once the
 * instance holds an exact connection, which `refuseDebug` reports here.
 */

import type { Containment } from './containment.js';

let exactHeld = false;

/** Set by `refuseDebug`: from here on, a sink without a container key reduces every error. */
export function reduceErrorTextForProcess(): void {
  exactHeld = true;
}

/** Whether the instance holds an exact connection, as far as error text is concerned. */
export function isErrorTextReducedForProcess(): boolean {
  return exactHeld;
}

/**
 * The status code of a provider's error: the SDK's `status`, or the OpenAI-compatible adapter's
 * message prefix. Null for anything else.
 */
export function providerStatus(err: unknown): number | null {
  if (typeof err === 'object' && err !== null && typeof (err as { status?: unknown }).status === 'number') {
    return (err as { status: number }).status;
  }
  const m = err instanceof Error ? /^OpenAI-compatible API error (\d{3}):/.exec(err.message) : null;
  return m ? Number(m[1]) : null;
}

/**
 * Class and HTTP status of an error, and nothing it carries. A name is kept only when it is an
 * identifier, as a class name is; one built from text (spaces, punctuation) reads `Error`.
 */
export function reducedErrorText(err: unknown): string {
  // A getter on `name`, `status` or `message` that throws would carry its own text into the
  // handler that called this; such an error reads `Error`.
  try {
    const name = err instanceof Error ? (/^[A-Za-z_][A-Za-z0-9_]{0,39}$/.test(err.name) ? err.name : 'Error') : typeof err;
    const status = providerStatus(err);
    return `${name}${status !== null ? ` (HTTP ${String(status)})` : ''}`;
  } catch {
    return 'Error';
  }
}

/** The full text an error has always been reported with; with `withStack`, its stack. */
function fullErrorText(err: unknown, withStack: boolean): string {
  if (!(err instanceof Error)) return String(err);
  return withStack && err.stack ? err.stack : err.message;
}

/**
 * Whether an error from this container leaves reduced. A container key goes to `Containment`
 * (fail-closed there); without a key, or without a store, the process state decides.
 */
export function errorTextReduced(
  store: Containment | null | undefined,
  key: { threadId?: string | undefined; bulkRunId?: string | undefined },
): boolean {
  if (store && (key.threadId || key.bulkRunId)) return store.isContained(key);
  return exactHeld;
}

/**
 * The text of `err` for a sink: reduced when `reduce`, the full message otherwise. `withStack`
 * is for an error nobody caught, whose stack Node or the SDK printed before. Reduced, it has no
 * stack either: the frames follow the message in one string, and no rule on that string tells a
 * frame V8 wrote from a message line shaped like one, so the crash location is not reported.
 */
export function errorText(err: unknown, reduce: boolean, withStack = false): string {
  if (reduce) return reducedErrorText(err);
  return fullErrorText(err, withStack);
}

/**
 * The text of `err` for a sink that knows no container: reduced once the instance holds an exact
 * connection. No flag to pass, so a call site cannot hand it the wrong one.
 */
export function processErrorText(err: unknown, withStack = false): string {
  return errorText(err, exactHeld, withStack);
}

let reducedUncaught: ((err: Error) => void) | null = null;
let reducedRejection: ((reason: unknown) => void) | null = null;

/**
 * Handlers for errors nobody caught, writing only the reduced text. Without
 * a handler Node prints the whole message. `refuseDebug` refuses error reporting before it
 * installs these, which removes the reporter's handlers and refuses any later init, so under the
 * marker these are the only lynox handlers; the SDK's own stay out (`error-reporting.ts`).
 * An uncaught exception ends the process as Node would, but only as the event's sole listener:
 * Node itself ends it only when nobody listens, and another listener (a test runner) has taken
 * that decision already. Once installed, a rejection never ends it, so a managed instance keeps
 * its chats and workers through a stray rejection however the marker came. At boot they are
 * installed only after engine.db opens; before that the process behaves as on main. main keeps
 * running only when error reporting started before the marker (its SDK handler stays registered
 * and can print the whole stack), and crashes with the marker on disk at boot or without a DSN.
 * This handler only writes; it hands nothing to the error reporter.
 */
export function installReducedProcessHandlers(): void {
  if (reducedUncaught !== null) return;
  reducedUncaught = (err) => {
    process.stderr.write(`[lynox] uncaught exception: ${reducedErrorText(err)}\n`);
    if (process.listenerCount('uncaughtException') === 1) process.exit(1);
  };
  reducedRejection = (reason) => {
    process.stderr.write(`[lynox] unhandled rejection: ${reducedErrorText(reason)}\n`);
  };
  process.on('uncaughtException', reducedUncaught);
  process.on('unhandledRejection', reducedRejection);
}

/** @internal test-only */
export function _resetErrorEgress(): void {
  exactHeld = false;
  if (reducedUncaught) process.off('uncaughtException', reducedUncaught);
  if (reducedRejection) process.off('unhandledRejection', reducedRejection);
  reducedUncaught = null;
  reducedRejection = null;
}
