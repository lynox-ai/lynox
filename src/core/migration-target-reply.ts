/**
 * What the migration source reads from the target instance, and how it shows the target's words.
 *
 * The target is the instance the user named, reached through the pinned fetch with the migration
 * token, but its answers are still another instance's input: every body is read up to a cap for its
 * kind (a larger one is not held in full), and a text it sends for the user is shown without control
 * or bidi characters, so it displays as what it says.
 */

/** Bytes the source reads at most, per kind of answer. A real one is far below each. */
export const TARGET_BODY_CAPS = {
  /** The handshake's key material, or its refusal text. */
  handshake: 64 * 1024,
  /** A refusal of the manifest, a chunk or the restore. */
  refusal: 64 * 1024,
  /** The restore's report, which can name up to the workspace's entry cap of skipped paths. */
  restore: 8 * 1024 * 1024,
} as const;

/** How long the source waits for one answer's body to arrive in full. */
export const TARGET_BODY_TIMEOUT_MS = 30_000;

/**
 * How long the source waits for the target to start answering (its status line and headers), per
 * request. The body then has `TARGET_BODY_TIMEOUT_MS` of its own. The restore runs the whole
 * import on the target before it answers, so it gets the longest.
 */
export const TARGET_REQUEST_TIMEOUTS_MS = {
  handshake: 30_000,
  manifest: 60_000,
  chunk: 120_000,
  restore: 15 * 60_000,
} as const;

/**
 * Whether `err` is the connection failing (refused, reset, unreachable, a TLS failure): Node's
 * system and TLS errors carry a string `code`, on the error or its cause. The network guard's own
 * refusals ("Blocked: …") carry none and stay as they are.
 */
export function isConnectionFailure(err: unknown): boolean {
  const code = (e: unknown): unknown => (e !== null && typeof e === 'object' ? (e as { code?: unknown }).code : undefined);
  return typeof code(err) === 'string' || typeof code((err as { cause?: unknown } | null)?.cause) === 'string'
    || (err instanceof Error && /^(aborted|socket hang up|other side closed)$/i.test(err.message));
}

/** A target that did not start answering within its request's deadline. */
export class TargetDidNotAnswer extends Error {
  constructor(readonly timeoutMs: number) {
    super(`the target instance did not answer within ${durationText(timeoutMs)}`);
    this.name = 'TargetDidNotAnswer';
  }
}

/** A deadline in the unit a person reads: seconds below two minutes, minutes from there. */
export function durationText(ms: number): string {
  return ms >= 120_000 ? `${String(ms / 60_000)} minutes` : `${String(ms / 1000)} seconds`;
}

/**
 * The whole transfer to the target ran past its deadline (`transferDeadlineMs`). `asked`: the
 * request had gone out when it did (the target may have acted on it), or the deadline had passed
 * before it, and it was not sent.
 */
export class TransferOutOfTime extends Error {
  constructor(readonly asked: boolean) {
    super('the migration ran past its deadline as a whole');
    this.name = 'TransferOutOfTime';
  }
}

/**
 * How long the whole transfer (manifest, every part, the restore) may take, from the bundle's
 * size: a fixed allowance for the target's own steps (the restore alone may take 15 minutes) and
 * the time the bundle takes at 128 KiB/s (about 1 Mbit/s), rounded up to whole minutes. A
 * migration over a link at least that fast is not cut; a slower one can be, although each part
 * alone would pass its own deadline. A target that answers each step just inside its own deadline
 * cannot hold the export, and the bundle in this instance's memory, for hours.
 */
export const TRANSFER_DEADLINE = { allowanceMs: 20 * 60_000, bytesPerSecond: 128 * 1024 } as const;
export function transferDeadlineMs(bundleBytes: number): number {
  const ms = TRANSFER_DEADLINE.allowanceMs + (Math.max(0, bundleBytes) / TRANSFER_DEADLINE.bytesPerSecond) * 1000;
  return Math.ceil(ms / 60_000) * 60_000;
}

/**
 * `fetchFn` with a deadline for the answer to start: past it the request is aborted and
 * `TargetDidNotAnswer` thrown. The deadline ends once the headers are in, so it does not cut a
 * body that `readTargetBody` is still reading under its own. `overall`, when given, ends the
 * request too, with `TransferOutOfTime`.
 * The request is raced against both, so they hold also while the transport has not taken the
 * signal yet, as during the network guard's name lookup (which the guard itself ends after 5 s),
 * and for a `fetchFn` that ignores the signal.
 */
export async function askTarget(
  fetchFn: (url: string, init: RequestInit) => Promise<Response>,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  overall?: AbortSignal,
): Promise<Response> {
  if (overall?.aborted === true) throw new TransferOutOfTime(false);
  const ctl = new AbortController();
  let stop: (err: Error) => void = () => {};
  const stopped = new Promise<never>((_, reject) => { stop = reject; });
  const end = (err: Error): void => { ctl.abort(err); stop(err); };
  // run-group-starter: cleared in this call's `finally`, or fired once; it only aborts this request and reports no spend.
  const timer = setTimeout(() => end(new TargetDidNotAnswer(timeoutMs)), timeoutMs);
  const onOverall = (): void => end(new TransferOutOfTime(true));
  overall?.addEventListener('abort', onOverall, { once: true });
  try {
    return await Promise.race([fetchFn(url, { ...init, signal: ctl.signal }), stopped]);
  } catch (err: unknown) {
    if (ctl.signal.aborted) throw ctl.signal.reason instanceof Error ? ctl.signal.reason : new TargetDidNotAnswer(timeoutMs);
    throw err;
  } finally {
    clearTimeout(timer);
    overall?.removeEventListener('abort', onOverall);
  }
}

/** A target answer whose body did not arrive in full within the deadline. */
export class TargetAnswerTooSlow extends Error {
  constructor(readonly timeoutMs: number) {
    super(`it did not finish its answer within ${String(timeoutMs / 1000)} seconds`);
    this.name = 'TargetAnswerTooSlow';
  }
}

/** Why the source could not use a target answer, in words for the user. */
export type UnreadAnswer = 'large' | 'format' | 'slow' | 'broken';

/** A cap in the unit a person reads: KiB below 1 MiB, MiB from there. */
export function capText(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${String(bytes / (1024 * 1024))} MiB` : `${String(bytes / 1024)} KiB`;
}

/**
 * A target answer read as JSON, or a throw with `fail`'s text (or the error `fail` gives) when it
 * is over `cap`, does not arrive in full in time, or is not JSON. The answer's own text is never quoted.
 */
export async function readTargetJson(r: Response, cap: number, fail: (why: UnreadAnswer) => string | Error, timeoutMs: number = TARGET_BODY_TIMEOUT_MS): Promise<unknown> {
  const failure = (why: UnreadAnswer): Error => { const said = fail(why); return said instanceof Error ? said : new Error(said); };
  let text: string | null;
  try {
    text = await readTargetBody(r, cap, timeoutMs);
  } catch (err: unknown) {
    // Any other failure of the read (a reset, a closed connection) is the connection breaking.
    throw failure(err instanceof TargetAnswerTooSlow ? 'slow' : 'broken');
  }
  if (text === null) throw failure('large');
  try { return JSON.parse(text) as unknown; } catch { throw failure('format'); }
}

/**
 * The body of `r` as text, read up to `cap` bytes, or null when it is larger (the read stops at the
 * cap and the rest is not taken). A body that does not arrive in full within `timeoutMs` throws, so
 * a target cannot hold the export open by sending slowly. No body is an empty text.
 */
export async function readTargetBody(r: Response, cap: number, timeoutMs: number = TARGET_BODY_TIMEOUT_MS): Promise<string | null> {
  if (!r.body) return '';
  const reader = r.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  let timedOut = false;
  // run-group-starter: cleared in this call's `finally`, or fired once; it only cancels this body's read and reports no spend.
  const timer = setTimeout(() => { timedOut = true; void reader.cancel().catch(() => undefined); }, timeoutMs);
  try {
    // run-group-starter: reads one bounded body within this call; it starts nothing that outlives it.
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (err: unknown) {
        // A read the deadline cancelled may reject instead of ending: it is still the deadline.
        if (timedOut) throw new TargetAnswerTooSlow(timeoutMs);
        throw err;
      }
      const { done, value } = chunk;
      if (timedOut) throw new TargetAnswerTooSlow(timeoutMs);
      if (done) break;
      size += value.byteLength;
      if (size > cap) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      parts.push(value);
    }
  } finally {
    clearTimeout(timer);
  }
  return Buffer.concat(parts).toString('utf-8');
}

/** Bytes of an unneeded answer the source reads to the end, so its connection can be reused. */
export const DISCARD_READ_BYTES = 64 * 1024;

/**
 * Let go of an answer whose body the source does not need: read to its end when it is small (the
 * connection is then free for the next request), cancelled past `DISCARD_READ_BYTES` or the body
 * deadline. Never throws.
 */
export async function discardBody(r: Response, timeoutMs: number = TARGET_BODY_TIMEOUT_MS): Promise<void> {
  try { await readTargetBody(r, DISCARD_READ_BYTES, timeoutMs); } catch { /* let go either way */ }
}

/**
 * Every character that is not shown as itself: controls (Cc), format characters (Cf: the bidi
 * embeddings, overrides, isolates and marks, the zero-width characters, the invisible operators,
 * the soft hyphen, the interlinear annotation and tag characters), the variation selectors and the
 * fillers that render as nothing, and lone surrogates (Cs), which no font shows and which a quoted
 * form would spell out six characters each.
 */
const HIDDEN = /[\p{Cc}\p{Cf}\p{Cs}\u034F\u115F\u1160\u180B-\u180F\u3164\uFE00-\uFE0F\uFFA0\u{E0100}-\u{E01EF}]/gu;

/**
 * A text from the target as it is shown to the user: line breaks, tabs and the line and paragraph
 * separators become a space, every character in `HIDDEN` is removed, then it is cut at `max`
 * characters with a mark that it was.
 */
export function relayedText(text: string, max: number = 500): string {
  const out = text.replace(/[\r\n\t\u2028\u2029]/g, ' ').replace(HIDDEN, '');
  // Count characters (code points) without spreading a long text into an array.
  let n = 0;
  let end = 0;
  for (const ch of out) {
    if (n === max) return `${out.slice(0, end)}…`;
    n++;
    end += ch.length;
  }
  return out;
}

/** How deep the source follows a restore report; a real one is two levels deep. */
export const REPORT_MAX_DEPTH = 8;

/**
 * The target's restore report with every string in it passed through `relayedText` (1,000
 * characters each, keys 200). Anything nested deeper than `REPORT_MAX_DEPTH` is dropped (null),
 * so a report built to exhaust the stack does not.
 */
export function relayedReport(value: unknown, depth: number = 0): unknown {
  if (typeof value === 'string') return relayedText(value, 1000);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= REPORT_MAX_DEPTH) return null;
  if (Array.isArray(value)) return value.map((v) => relayedReport(v, depth + 1));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [relayedText(k, 200), relayedReport(v, depth + 1)]));
}
