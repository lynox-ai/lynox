/**
 * A failed extraction call as the model may read it: the error class and, when there is
 * one, the HTTP status — from the SDK's numeric `status`, or from the fixed prefix the
 * OpenAI-compatible adapter writes. Only the three digits are taken from the message.
 * The adapter's idle timeout is a plain `Error` with a fixed prefix of its own, so it is
 * named by that prefix; an `AbortError` is a cancelled call, which is not the same thing.
 *
 * Never the message itself: a provider's error body may echo what it was sent, and an
 * extraction call is sent text a session read from outside.
 */
export function extractionFailureForModel(err: unknown): string {
  if (err instanceof Error && err.name === 'AbortError') return 'the extraction call was aborted';
  if (err instanceof Error && err.message.startsWith('OpenAI-compatible request timed out')) return 'the extraction call timed out';
  const name = err instanceof Error && /^[A-Za-z]{1,40}$/.test(err.name) ? err.name : 'Error';
  const raw = err instanceof Error ? (err as Error & { status?: unknown }).status : undefined;
  const fromPrefix = err instanceof Error ? /^OpenAI-compatible API error (\d{3}):/.exec(err.message)?.[1] : undefined;
  const status = typeof raw === 'number' && Number.isInteger(raw) && raw >= 100 && raw <= 599 ? String(raw) : fromPrefix;
  return `the extraction call failed (${name}${status ? ` HTTP ${status}` : ''})`;
}
