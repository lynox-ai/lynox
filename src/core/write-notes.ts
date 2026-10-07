/**
 * The lines a headless run's refused or possibly-landed writes carry, in one place. Both
 * refusal sites write them — the agent loop's danger check and `http_request`'s consent
 * gate — and the saved-workflow run report collects them for the owner
 * (`collectWriteNotes`), because a refused write leaves its step `completed` and nothing
 * else would surface it.
 */

/** Start of the line that names a write an unattended run was not granted. */
export const UNGRANTED_WRITE_PREFIX = 'Not granted for an unattended run:';
/** Start of the message for a write that was sent and then redirected off its grant. */
export const WRITE_POSSIBLY_LANDED_PREFIX = 'Write possibly landed:';

/** Scheme, host (with port) and path — never the query, which may carry values. */
export function urlForNote(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return '(unparsable URL)';
  }
}

/** Names a refused write by verb, host and path, so the next grant can take it in. */
export function ungrantedWriteNote(method: string, url: string, afterUntrusted: boolean): string {
  const why = afterUntrusted ? ' The run read external content before this call, and its grant does not cover writes after that.' : '';
  return `${UNGRANTED_WRITE_PREFIX} ${method} ${urlForNote(url)}.${why}`;
}

/**
 * The note for an `http_request` the agent loop refused without a prompt, or '' when the
 * call is not an outbound write. The autonomous posture refuses every method but GET and
 * HEAD, so that is what "write" means here.
 */
export function headlessRefusalNote(toolName: string, input: unknown, afterUntrusted: boolean): string {
  if (toolName !== 'http_request' || input === null || typeof input !== 'object') return '';
  const { url, method } = input as { url?: unknown; method?: unknown };
  const m = (typeof method === 'string' ? method : 'GET').toUpperCase();
  if (typeof url !== 'string' || m === 'GET' || m === 'HEAD') return '';
  return `\n${ungrantedWriteNote(m, url, afterUntrusted)}`;
}
