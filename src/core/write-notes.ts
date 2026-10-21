/**
 * The lines a headless run's refused or possibly-landed writes carry, in one place. Both
 * refusal sites write them — the agent loop's danger check and `http_request`'s consent
 * gate — and the saved-workflow run report collects them for the owner
 * (`collectWriteNotes`), because a refused write leaves its step `completed` and nothing
 * else would surface it.
 */

import type { CapabilityContract } from '../types/capability-contract.js';
import { contractGrants, isReviewedHeaderName } from '../tools/permission-guard.js';
import { effectiveWriteMethod, isOutboundEffectWrite, writeMethodsNamed } from './outbound-write.js';

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

/**
 * A write as a refusal names it, so the next attempt or grant covers each write a server may
 * run (`writeMethodsNamed`):
 *  - no other write named: the method it is gated as;
 *  - a write sent with an override naming others: the sent one first (`POST (also naming PATCH)`);
 *  - a read sent with an override naming writes: the writes first, since a grant never needs the
 *    read (`DELETE (sent as GET)`).
 */
export function writeForNote(sentMethod: string, gatedMethod: string, named: readonly string[]): string {
  const alsoNamed = named.filter((m) => m !== sentMethod);
  if (alsoNamed.length === 0) return gatedMethod;
  return named.includes(sentMethod)
    ? `${sentMethod} (also naming ${alsoNamed.join(', ')})`
    : `${named.join(', ')} (sent as ${sentMethod})`;
}

/**
 * A header name a note or a refusal may quote: a header-name token of at most 64 characters.
 * The name was written by a model, so anything else is counted, never quoted.
 */
const NOTE_HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/;

/**
 * Every refused header as one phrase, so the next attempt does not meet a second: up to three
 * valid names quoted, the rest counted, and the names that are not valid header names counted
 * apart, never quoted.
 */
export function headerListForNote(names: readonly string[]): string {
  if (names.length === 0) return 'no header';
  const valid = names.map((n) => n.trim()).filter((n) => NOTE_HEADER_NAME.test(n));
  const invalid = names.length - valid.length;
  if (valid.length === 0) {
    return invalid === 1 ? 'a header with a name that is not a valid header name' : `${String(invalid)} headers with names that are not valid header names`;
  }
  const count = (n: number): string => (n === 1 ? 'one' : String(n));
  const parts = valid.slice(0, 3).map((n) => `"${n}"`);
  if (valid.length > 3) parts.push(`${count(valid.length - 3)} more`);
  if (invalid > 0) parts.push(invalid === 1 ? 'one with a name that is not a valid header name' : `${String(invalid)} with names that are not valid header names`);
  const last = parts.pop() ?? '';
  return `${names.length > 1 ? 'the headers' : 'a header'} ${parts.length === 0 ? last : `${parts.join(', ')} and ${last}`}`;
}

/**
 * The headers a reviewed grant refused this call for, or `undefined`. Only when the headers
 * are THE reason: the same call without them would be granted, and is no write the
 * outbound-effect table holds back from every grant. Otherwise naming a header would point
 * away from what is not granted. `input` is the call as written, with its own method: a
 * method-override header is then named as the header it is. Names, never values.
 */
export function refusedReviewedHeaders(input: unknown, contract: CapabilityContract | undefined): string[] | undefined {
  if (contract?.origin !== 'reviewed' || input === null || typeof input !== 'object') return undefined;
  const { headers, ...rest } = input as { headers?: unknown; url?: unknown; method?: unknown };
  if (headers === null || typeof headers !== 'object') return undefined;
  const refused = Object.keys(headers).filter((name) => !isReviewedHeaderName(name));
  if (refused.length === 0 || !contractGrants('http_request', rest, contract)) return undefined;
  if (typeof rest.url === 'string' && isOutboundEffectWrite(rest.url, typeof rest.method === 'string' ? rest.method : 'GET')) return undefined;
  return refused;
}

/**
 * The line in front of a response a write's redirect turned into a read: a 307/308 to another
 * origin is followed as a GET without the body, so the answer is that GET's, and a 200 there
 * says nothing about the write. `sent` opens it (`<write> was sent`, and a second sending on a
 * redirect of its own origin when there was one). `carried`: a GET from that hop on kept a
 * method override, so it is a write of its own wherever a server reads the override, and "not
 * sent there" would be false.
 */
export function writeFollowedAsReadNote(sent: string, hopUrl: string, carried?: { method: string | undefined; url: string }): string {
  let there = 'the write was not sent there, and the response below answers that GET, not the write.';
  if (carried !== undefined) {
    const what = carried.method === undefined ? 'a method override this check cannot read' : `${carried.method} as a method override`;
    const where = carried.url === hopUrl ? 'that GET carried' : `a redirect after it carried, to ${urlForNote(carried.url)},`;
    there = `${where} ${what}, which a server there may have acted on as a write, and the response below answers the last GET, not the first write.`;
  }
  return `${WRITE_POSSIBLY_LANDED_PREFIX} ${sent} and answered with a redirect to ${urlForNote(hopUrl)}, another origin, ` +
    `where it was followed as a GET without the body: ${there} Check the target system for whether the write was carried out before sending it again.`;
}

/**
 * Names a refused write by verb, host and path, so the next grant can take it in, and the
 * headers when a reviewed grant refused it for them (`refusedReviewedHeaders`).
 */
export function ungrantedWriteNote(method: string, url: string, afterUntrusted: boolean, refusedHeaders?: readonly string[]): string {
  const why = afterUntrusted ? ' The run read external content before this call, and its grant does not cover writes after that.' : '';
  const header = refusedHeaders === undefined ? '' : ` It sets ${headerListForNote(refusedHeaders)}, which a run under a reviewed grant may not set.`;
  return `${UNGRANTED_WRITE_PREFIX} ${method} ${urlForNote(url)}.${why}${header}`;
}

/**
 * The note for an `http_request` the agent loop refused without a prompt, or '' when the
 * call is not an outbound write. The autonomous posture refuses every method but GET and
 * HEAD, so that is what "write" means here — read as the danger check reads it
 * (`permission-guard.ts`): the effective method, overrides included, so a GET whose
 * `?_method=POST` it refused is named as the write it was refused for. A method or override
 * that is not a method counts as a write there; it is named without its value, which is
 * whatever the request put there.
 */
export function headlessRefusalNote(toolName: string, input: unknown, afterUntrusted: boolean, contract?: CapabilityContract): string {
  if (toolName !== 'http_request' || input === null || typeof input !== 'object') return '';
  const req = input as { url?: unknown; method?: unknown; headers?: unknown; body?: unknown };
  if (typeof req.url !== 'string') return '';
  const sent = String(req.method ?? 'GET').trim().toUpperCase();
  const headers = req.headers !== null && typeof req.headers === 'object'
    ? Object.fromEntries(Object.entries(req.headers as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
    : {};
  const body = typeof req.body === 'string' ? req.body : undefined;
  const gated = effectiveWriteMethod(sent, headers, req.url, body);
  if (gated === 'GET' || gated === 'HEAD') return '';
  const shown = gated === null
    ? 'a write whose method or method override is not an HTTP method, to'
    : writeForNote(sent, gated, writeMethodsNamed(sent, headers, req.url, body));
  return `\n${ungrantedWriteNote(shown, req.url, afterUntrusted, refusedReviewedHeaders(input, contract))}`;
}
