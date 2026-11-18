/**
 * The lines a headless run's refused or possibly-landed writes carry, in one place. Both
 * refusal sites write them — the agent loop's danger check and `http_request`'s consent
 * gate — and the saved-workflow run report collects them for the owner
 * (`collectWriteNotes`), because a refused write leaves its step `completed` and nothing
 * else would surface it.
 */

import type { CapabilityContract } from '../types/capability-contract.js';
import { contractGrants, isReviewedHeaderName } from '../tools/permission-guard.js';
import { effectiveWriteMethod, isOutboundEffectWrite, isReadMethod, writeMethodsNamed } from './outbound-write.js';
import { maskSecretPatterns } from './secret-store.js';

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

/** How many methods a one-line note lists before it counts the rest (`writeForShortNote`). */
const NOTE_METHODS_LISTED = 3;

/**
 * `writeForNote` for the one line a run report collects (`collectWriteNotes` keeps 300
 * characters): a request can name up to 26 methods, and listing them all pushes the URL out of
 * the line. The method the call is gated as and the one it sends are always named, the gated
 * one first; only the others are counted, so the write the grant is missing is never in the
 * counted rest.
 */
export function writeForShortNote(sentMethod: string, gatedMethod: string, named: readonly string[]): string {
  const sends = named.includes(sentMethod);
  const kept = [gatedMethod, ...named.filter((m) => m !== gatedMethod)].filter((m) => !(sends && m === sentMethod));
  // Counted only when something is left over: what fits is listed as the refusals list it.
  if (kept.length <= NOTE_METHODS_LISTED) return writeForNote(sentMethod, gatedMethod, named);
  const listed = kept.slice(0, NOTE_METHODS_LISTED);
  const more = ` and ${String(kept.length - listed.length)} more`;
  return sends
    ? `${sentMethod} (also naming ${listed.join(', ')}${more})`
    : `${listed.join(', ')}${more} (sent as ${sentMethod})`;
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
export function ungrantedWriteNote(method: string, url: string, afterUntrusted: boolean, refusedHeaders?: readonly string[], hideHost = false, mask: (text: string) => string = (text) => text): string {
  const why = afterUntrusted ? ' The run read external content before this call, and its grant does not cover writes after that.' : '';
  const header = refusedHeaders === undefined ? '' : ` It sets ${headerListForNote(refusedHeaders)}, which a run under a reviewed grant may not set.`;
  const head = `${UNGRANTED_WRITE_PREFIX} ${method} `;
  const tail = `.${why}${header}`;
  // Masked before it is cut: a stored value cut in part is one no mask knows any more. `mask` is
  // the caller's mask of stored values (the URL may carry them resolved), then credential shapes.
  const shown = maskSecretPatterns(mask(urlWithHidden(url, hideHost, mask)));
  return `${head}${urlWithin(shown, NOTE_LINE_MAX_CHARS - head.length - tail.length)}${tail}`;
}

const HOST_HIDDEN = '(host not shown: its address holds a stored secret)';
const PATH_HIDDEN = '/(path not shown: it holds a stored secret)';

/**
 * `urlForNote`, with the host or the path left out where it holds a stored value the mask would
 * miss in the parsed URL. The parser rewrites what it reads — it lower-cases the host and
 * percent-encodes a space or a quote in the path — and a value rewritten that way no longer
 * matches its stored form. So the host and the path are also read as the request wrote them, and
 * a part that holds a value there and reads differently once parsed is left out, never rewritten:
 * what is shown is always the parser's own reading, so the note names the host the request goes to
 * and never shows the query. `hideHost`: the caller already knows the host holds a stored secret.
 */
function urlWithHidden(raw: string, hideHost: boolean, mask: (text: string) => string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return '(unparsable URL)';
  }
  const written = writtenHostAndPath(raw);
  const holds = (text: string): boolean => mask(text) !== text;
  const rewritten = (as: string, parsed: string): boolean => holds(as) && as !== parsed;
  let host = hideHost;
  let path = false;
  if (written === undefined) {
    // Not split as the parser splits it (a scheme other than http or https): a stored value the
    // mask finds in the URL as written leaves both parts out.
    if (holds(raw)) host = path = true;
  } else {
    if (rewritten(written.host, u.host)) host = true;
    if (rewritten(written.path, u.pathname)) path = true;
    // A value that runs from the host into the path is in neither part alone.
    if (!host && !path && rewritten(written.host + written.path, u.host + u.pathname)) host = path = true;
  }
  return `${u.protocol}//${host ? HOST_HIDDEN : u.host}${path ? PATH_HIDDEN : u.pathname}`;
}

/**
 * The host (with port, without userinfo) and the path of an http or https URL as written, cut
 * where the URL parser cuts them: it first drops control characters and spaces around the URL and
 * every tab and line break in it, skips any run of `/` and `\` after the scheme (`https:host`,
 * `https:\\host` read as `https://host`), ends the authority at the first `/`, `\`, `?` or `#`,
 * takes the host after its last `@`, and ends the path at `?` or `#`. Any other scheme: undefined.
 */
function writtenHostAndPath(raw: string): { host: string; path: string } | undefined {
  // The parser's own clean-up: C0 controls and space around the URL, tabs and line breaks in it.
  const cleaned = raw.replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, '').replace(/[\t\n\r]/g, '');
  const m = /^https?:[/\\]*([^/\\?#]*)([^?#]*)/i.exec(cleaned);
  if (m === null) return undefined;
  const authority = m[1] ?? '';
  return { host: authority.slice(authority.lastIndexOf('@') + 1), path: m[2] ?? '' };
}

/** What a run report keeps of one such line (`collectWriteNotes`). */
const NOTE_LINE_MAX_CHARS = 300;

/**
 * A URL, already masked, cut to fit `budget`, marked with `…`: a long path would otherwise push
 * the reason out of the line the report keeps, and the reason is what says why the write was
 * refused. Cut only after a `/`, so no path segment is kept in part.
 */
function urlWithin(url: string, budget: number): string {
  if (url.length <= budget) return url;
  // However much else the line says, the service stays named: scheme, host and the path's `/`.
  const origin = /^[a-z][a-z0-9+.-]*:\/\/[^/]*\/?/i.exec(url)?.[0] ?? url;
  const cut = url.lastIndexOf('/', budget - 2);
  return `${url.slice(0, Math.max(cut + 1, origin.length))}…`;
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
  if (isReadMethod(gated)) return '';
  const shown = gated === null
    ? 'a write whose method or method override is not an HTTP method, to'
    : writeForShortNote(sent, gated, writeMethodsNamed(sent, headers, req.url, body));
  return `\n${ungrantedWriteNote(shown, req.url, afterUntrusted, refusedReviewedHeaders(input, contract))}`;
}
