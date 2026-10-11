/**
 * The lines a headless run's refused or possibly-landed writes carry, in one place. Both
 * refusal sites write them — the agent loop's danger check and `http_request`'s consent
 * gate — and the saved-workflow run report collects them for the owner
 * (`collectWriteNotes`), because a refused write leaves its step `completed` and nothing
 * else would surface it.
 */

import type { CapabilityContract } from '../types/capability-contract.js';
import { contractGrants, isReviewedHeaderName } from '../tools/permission-guard.js';
import { isOutboundEffectWrite } from './outbound-write.js';

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
 * A header name as a note or a refusal may quote it: a header-name token of at most 64
 * characters, or a phrase that quotes nothing. The name was written by a model.
 */
export function headerNameForNote(raw: string): string {
  const name = raw.trim();
  return /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/.test(name) ? `"${name}"` : 'with a name that is not a valid header name';
}

/** Up to three refused headers as one phrase, so the next attempt does not meet a second. */
export function headerListForNote(names: readonly string[]): string {
  const shown = names.slice(0, 3).map(headerNameForNote);
  const more = names.length > 3 ? ` and ${String(names.length - 3)} more` : '';
  return `${shown.length > 1 || more !== '' ? 'the headers' : 'a header'} ${shown.join(', ')}${more}`;
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
 * HEAD, so that is what "write" means here.
 */
export function headlessRefusalNote(toolName: string, input: unknown, afterUntrusted: boolean, contract?: CapabilityContract): string {
  if (toolName !== 'http_request' || input === null || typeof input !== 'object') return '';
  const { url, method } = input as { url?: unknown; method?: unknown };
  const m = (typeof method === 'string' ? method : 'GET').toUpperCase();
  if (typeof url !== 'string' || m === 'GET' || m === 'HEAD') return '';
  return `\n${ungrantedWriteNote(m, url, afterUntrusted, refusedReviewedHeaders(input, contract))}`;
}
