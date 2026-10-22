// === OAuth Microsoft Graph provider ===
//
// A Microsoft 365 mailbox behind the MailProvider interface, over Microsoft
// Graph with the tenant's brokered grant (`MicrosoftAuth`). The tools see the
// same shape as for IMAP and Gmail.
//
// ── Not wired yet ─────────────────────────────────────────────────────────
//
// Nothing constructs this provider: `mail/context.ts` has no `oauth_microsoft`
// branch, and a test there holds that. The cursor store is a required
// constructor argument, with no default: with `InMemoryDeltaCursorStore`, a
// restart begins a new cursor at "now" and silently skips every message that
// arrived while the process was down. The wiring passes the persistent one
// (`MailStateDeltaCursorStore`, `mail/state.ts`); the tests pass the in-memory one.
//
// ── What each call costs ──────────────────────────────────────────────────
//
// `list`/`search` are ONE request each: Graph returns the envelope fields in the
// collection, unlike Gmail's list-then-fetch-each. `fetch` is two (message and
// attachment metadata). Every request goes through one limiter of 4, the
// documented concurrency limit per app and mailbox.
//
// ── UID model ─────────────────────────────────────────────────────────────
//
// Synthetic, per provider lifetime, exactly like the Gmail provider: Graph ids
// are strings, `MailEnvelope.uid` is a number.
//
// ── Sending ───────────────────────────────────────────────────────────────
//
// `send` posts MIME to `/me/sendMail`, built by the same `buildRfc2822` the
// Gmail provider uses. A reply is a send with In-Reply-To/References, like on
// every other transport. Graph's `/reply` is NOT used: it picks the recipients
// on the server ("uses the sender of the original message as recipient"), so
// the recipients the user confirmed in the preview would not necessarily be the
// ones the message goes to. Whether `/reply` also adds the original to the text
// is not documented on that page and does not enter the decision.

import { randomUUID } from 'node:crypto';
import type { MicrosoftAuth } from '../../microsoft/microsoft-auth.js';
import { retryAfterMs } from '../../microsoft/microsoft-auth.js';
import {
  MailError,
  type MailAccountConfig,
  type MailAddress,
  type MailAttachmentMeta,
  type MailAuthType,
  type MailEnvelope,
  type MailFetchOptions,
  type MailFlag,
  type MailListOptions,
  type MailMessage,
  type MailProvider,
  type MailSearchOptions,
  type MailSearchQuery,
  type MailSendInput,
  type MailSendResult,
  type MailWatchHandle,
  type MailWatchHandler,
  type MailWatchOptions,
  listIdFromHeader,
} from '../provider.js';
import { GRAPH_API_HOSTS, graphFetch } from '../../../core/connector-egress.js';
import { joinCallSignal } from '../../../core/call-connection.js';
import { assertHostPolicy } from '../../../core/network-guard.js';
import { buildRfc2822 } from '../mime-compose.js';
import { htmlToTextSnippet, isAutoSubmittedHeader } from './imap-smtp.js';

const GRAPH_HOST = 'graph.microsoft.com';
const GRAPH_ME = `https://${GRAPH_HOST}/v1.0/me`;
const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_LIST_LIMIT = 50;
const DEFAULT_SEARCH_LIMIT = 50;
const MAX_PAGE = 100;
const DEFAULT_WATCH_INTERVAL_MS = 120_000;
const DEFAULT_WATCH_MAX_PER_TICK = 50;
/** Pages one watch tick follows before it parks the nextLink for the next tick. */
const WATCH_MAX_PAGES_PER_TICK = 10;
const WATCH_DEDUP_MAX = 1_000;
const SNIPPET_CHARS = 500;
/**
 * The same 10 MB as the IMAP provider's MAX_BODY_BYTES, counted in characters. It bounds what
 * `fetch` RETURNS, not what is downloaded: Graph sends the whole body and it is read in full
 * first, where IMAP stops the download itself.
 */
const MAX_BODY_CHARS = 10 * 1024 * 1024;
/** Graph throttling: at most 4 concurrent requests per app and mailbox. */
export const GRAPH_MAX_CONCURRENT_REQUESTS = 4;
/**
 * The lower bound written into `$filter` when the caller gave none. `$orderby`
 * goes together with a `receivedDateTime` filter here; *assumed*, not measured,
 * that Graph would otherwise refuse the pair — the bound costs nothing.
 */
const NO_LOWER_BOUND = '1970-01-01T00:00:00Z';

/**
 * Envelope fields for list, search and watch. `internetMessageHeaders` is NOT
 * among them: the archived source documents it on the single-message GET only.
 * So an envelope from a collection carries no In-Reply-To and no Auto-Submitted
 * (`isAutoReply` false); `fetch` reads both, and the reply tool's auto-reply
 * refusal reads the FETCHED envelope.
 */
const ENVELOPE_FIELDS = [
  'id', 'conversationId', 'internetMessageId', 'subject', 'from', 'toRecipients',
  'ccRecipients', 'replyTo', 'receivedDateTime', 'isRead', 'isDraft', 'flag',
  'bodyPreview', 'hasAttachments',
].join(',');

/** Outlook's well-known folder names, for the IMAP/Gmail-style names the tools pass. */
const WELL_KNOWN_FOLDERS: Readonly<Record<string, string>> = {
  INBOX: 'inbox',
  SENT: 'sentitems',
  SENTITEMS: 'sentitems',
  DRAFT: 'drafts',
  DRAFTS: 'drafts',
  ARCHIVE: 'archive',
  JUNK: 'junkemail',
  JUNKEMAIL: 'junkemail',
  SPAM: 'junkemail',
  TRASH: 'deleteditems',
  DELETEDITEMS: 'deleteditems',
};

// ── Graph shapes (only the fields read here) ──────────────────────────────

interface GraphRecipient { emailAddress?: { name?: string | null; address?: string | null } | null }

interface GraphMessage {
  id?: unknown;
  conversationId?: string | null;
  internetMessageId?: string | null;
  subject?: string | null;
  from?: GraphRecipient | null;
  toRecipients?: GraphRecipient[] | null;
  ccRecipients?: GraphRecipient[] | null;
  replyTo?: GraphRecipient[] | null;
  receivedDateTime?: string | null;
  isRead?: boolean | null;
  isDraft?: boolean | null;
  flag?: { flagStatus?: string | null } | null;
  bodyPreview?: string | null;
  hasAttachments?: boolean | null;
  internetMessageHeaders?: Array<{ name?: string; value?: string }> | null;
  body?: { contentType?: string | null; content?: string | null } | null;
  '@removed'?: unknown;
}

interface GraphCollection<T> {
  value?: T[];
  '@odata.nextLink'?: unknown;
  '@odata.deltaLink'?: unknown;
}

interface GraphAttachment {
  id?: unknown;
  name?: string | null;
  contentType?: string | null;
  size?: number | null;
  isInline?: boolean | null;
}

// ── Delta cursor ──────────────────────────────────────────────────────────

/**
 * Where a folder's watch resumes: the next Graph link (a deltaLink, or a
 * nextLink when a tick stopped at its page cap) and the newest `receivedDateTime`
 * seen, which is where a lost cursor restarts from.
 */
export interface DeltaCursor {
  readonly link: string;
  readonly since: string;
}

/** Per account and folder. In memory, or in mail-state.db (`MailStateDeltaCursorStore`). */
export interface DeltaCursorStore {
  get(accountId: string, folder: string): DeltaCursor | null;
  set(accountId: string, folder: string, cursor: DeltaCursor): void;
  clear(accountId: string, folder: string): void;
}

export class InMemoryDeltaCursorStore implements DeltaCursorStore {
  private readonly cursors = new Map<string, DeltaCursor>();
  get(accountId: string, folder: string): DeltaCursor | null {
    return this.cursors.get(`${accountId}\u0000${folder}`) ?? null;
  }
  set(accountId: string, folder: string, cursor: DeltaCursor): void {
    this.cursors.set(`${accountId}\u0000${folder}`, cursor);
  }
  clear(accountId: string, folder: string): void {
    this.cursors.delete(`${accountId}\u0000${folder}`);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Whether the grant carries `scope`. The claim may name a Graph scope short
 * (`Mail.Send`) or as a resource URI (`https://graph.microsoft.com/Mail.Send`);
 * both are the same permission, so both are read, case-insensitively. Which
 * form the control plane hands over is not measured.
 */
export function hasGraphScope(scopes: readonly string[], scope: string): boolean {
  const want = scope.toLowerCase();
  return scopes.some((s) => {
    const have = s.toLowerCase();
    return have === want || have === `https://${GRAPH_HOST}/${want}`;
  });
}

/**
 * The path segment for a folder. Well-known names map to Outlook's; anything
 * else is a folder id. An id is restricted to the characters Graph ids are made
 * of, and that excludes `.`: a folder of `..` would otherwise climb out of
 * `mailFolders/` once the URL is normalised.
 */
function folderSegment(folder: string): string {
  const known = WELL_KNOWN_FOLDERS[folder.toUpperCase()];
  if (known) return known;
  if (!/^[A-Za-z0-9\-_=+/]+$/.test(folder)) {
    throw new MailError('not_found', `Unknown Microsoft 365 folder "${folder}"`);
  }
  return encodeURIComponent(folder);
}

/**
 * The path segment for a Graph message id. Ids come from Graph, but the same
 * character rule as for folder ids applies, for the same reason: `..` would
 * climb out of `messages/` once the URL is normalised.
 */
function messageSegment(id: string): string {
  if (!/^[A-Za-z0-9\-_=+/]+$/.test(id)) {
    throw new MailError('not_found', 'Microsoft 365 message id has an unexpected shape');
  }
  return encodeURIComponent(id);
}

/**
 * An OData query string with the `$` of each option left literal. Values are
 * percent-encoded (spaces as %20, never `+`).
 */
function odataQuery(params: ReadonlyArray<readonly [string, string]>): string {
  return params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}

/**
 * A link Graph handed back (nextLink, deltaLink) is followed with the bearer
 * token, so it must point at Graph. `graphFetch` enforces the host only under a
 * `guarded` or `allow-list` policy; under the default `allow-all` it would send
 * the token wherever a link said. This check holds under every policy.
 */
function assertGraphUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new MailError('connection_failed', 'Graph returned a link that is not a URL');
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== GRAPH_HOST || parsed.port !== ''
    || parsed.username !== '' || parsed.password !== '') {
    throw new MailError('connection_failed', 'Graph returned a link off graph.microsoft.com; refused to follow it with the token');
  }
}

/** A KQL value made of plain words: quotes, backslashes and control characters dropped. */
function kqlWords(value: string): string[] {
  return value
    .replace(/["\\\u0000-\u001f\u007f]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0);
}

/** The `$search` expression for the free-text fields, or null when there are none. */
function buildKql(query: MailSearchQuery): string | null {
  const terms: string[] = [];
  if (query.text) terms.push(...kqlWords(query.text));
  if (query.from) terms.push(...kqlWords(query.from).map((w) => `from:${w}`));
  if (query.to) terms.push(...kqlWords(query.to).map((w) => `to:${w}`));
  if (query.subject) terms.push(...kqlWords(query.subject).map((w) => `subject:${w}`));
  return terms.length > 0 ? terms.join(' ') : null;
}

/** The structured parts of a search as an OData `$filter`, receivedDateTime first. */
function buildFilter(q: { since?: Date | undefined; before?: Date | undefined; unseen?: boolean | undefined; flagged?: boolean | undefined; hasAttachment?: boolean | undefined }): string {
  const parts = [`receivedDateTime ge ${q.since ? q.since.toISOString() : NO_LOWER_BOUND}`];
  if (q.before) parts.push(`receivedDateTime lt ${q.before.toISOString()}`);
  if (q.unseen) parts.push('isRead eq false');
  if (q.flagged) parts.push(`flag/flagStatus eq 'flagged'`);
  if (q.hasAttachment) parts.push('hasAttachments eq true');
  return parts.join(' and ');
}

function toAddress(r: GraphRecipient | null | undefined): MailAddress | null {
  const address = r?.emailAddress?.address;
  if (typeof address !== 'string' || address === '') return null;
  const name = r?.emailAddress?.name;
  return typeof name === 'string' && name !== '' && name !== address ? { name, address } : { address };
}

function toAddresses(list: ReadonlyArray<GraphRecipient> | null | undefined): MailAddress[] {
  return (list ?? []).map(toAddress).filter((a): a is MailAddress => a !== null);
}

function headerValue(msg: GraphMessage, name: string): string | undefined {
  const want = name.toLowerCase();
  const hit = (msg.internetMessageHeaders ?? []).find((h) => typeof h.name === 'string' && h.name.toLowerCase() === want);
  return typeof hit?.value === 'string' ? hit.value : undefined;
}

function flagsOf(msg: GraphMessage): ReadonlyArray<MailFlag> {
  const flags: MailFlag[] = [];
  if (msg.isRead === true) flags.push('\\Seen');
  if (msg.flag?.flagStatus === 'flagged') flags.push('\\Flagged');
  if (msg.isDraft === true) flags.push('\\Draft');
  // `\Answered` is not emitted: Graph has no per-message reply state in these
  // fields. Same asymmetry as the Gmail provider (see `MailFlag`).
  return flags;
}

function snippetOf(text: string): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  return cleaned.length <= SNIPPET_CHARS ? cleaned : cleaned.slice(0, SNIPPET_CHARS).trimEnd();
}

/** The domain for a locally made Message-ID: the sender's, reduced to hostname characters. */
function messageIdDomain(fromAddress: string): string {
  const domain = (fromAddress.split('@').pop() ?? '').replace(/[^A-Za-z0-9.-]/g, '');
  return domain.includes('.') ? domain : 'lynox.invalid';
}

/** A Graph HTTP failure: a MailError that also keeps the status, Graph's error code and Retry-After. */
export class GraphHttpError extends MailError {
  readonly status: number;
  readonly graphCode: string | null;
  readonly retryAfterMs: number | null;
  constructor(code: MailError['code'], message: string, status: number, graphCode: string | null, retryAfter: number | null) {
    super(code, message);
    this.name = 'GraphHttpError';
    this.status = status;
    this.graphCode = graphCode;
    this.retryAfterMs = retryAfter;
  }
}

/**
 * `error.code` of a Graph error body — Graph's stable vocabulary. The
 * `message` beside it is free text from a foreign server and never reaches a
 * tool result.
 */
function graphErrorCode(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { error?: { code?: unknown } };
    const code = parsed?.error?.code;
    return typeof code === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(code) ? code : null;
  } catch {
    return null;
  }
}

async function errorFrom(res: Response, label: string): Promise<GraphHttpError> {
  const body = await res.text().catch(() => '');
  const code = graphErrorCode(body);
  const ref = code ? ` ${code}` : '';
  const retry = retryAfterMs(res.headers.get('retry-after'), Date.now());
  switch (true) {
    case res.status === 401:
      return new GraphHttpError('auth_failed', `Graph ${label}: 401${ref} — token rejected. Reconnect the Microsoft 365 mailbox in the mail settings.`, 401, code, null);
    case res.status === 403:
      return new GraphHttpError('auth_failed', `Graph ${label}: 403${ref} — permission missing for this mailbox.`, 403, code, null);
    case res.status === 404:
      return new GraphHttpError('not_found', `Graph ${label}: 404${ref} not found`, 404, code, null);
    case res.status === 429:
      return new GraphHttpError('rate_limited', `Graph ${label}: 429${ref} rate limited${retry !== null ? `; retry after ${String(Math.ceil(retry / 1000))} s` : ''}`, 429, code, retry);
    default:
      return new GraphHttpError('connection_failed', `Graph ${label}: HTTP ${String(res.status)}${ref}`, res.status, code, retry);
  }
}

function wrapGraphError(err: unknown, fallback: string): MailError {
  if (err instanceof MailError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  return new MailError('connection_failed', `${fallback}: ${msg}`, { cause: err });
}

/**
 * The body as JSON. A body that is not JSON gets a fixed message: the parser's
 * own error quotes the first characters of the body, which is foreign text.
 */
async function jsonOf<T>(res: Response, label: string): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new MailError('connection_failed', `Graph ${label}: response is not JSON`);
  }
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

/** A lost delta cursor: 410 Gone, or a 4xx whose code names the sync state. */
function isLostCursor(err: unknown): boolean {
  if (!(err instanceof GraphHttpError)) return false;
  if (err.status === 410) return true;
  return err.status >= 400 && err.status < 500 && err.graphCode !== null && /syncstate/i.test(err.graphCode);
}

/**
 * At most `max` tasks at once. A finishing task hands its slot straight to the
 * next waiter instead of freeing it, so a caller arriving in between cannot
 * take the slot as well and push the count past `max`.
 */
class Limiter {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  constructor(private readonly max: number) {}
  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.active++;
    }
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}

/** What the mailbox probe found. Only `no-mailbox` means the account has no Exchange mailbox. */
export type GraphMailboxProbe =
  | { readonly state: 'ok' }
  | { readonly state: 'no-mailbox' }
  /**
   * 429, 5xx or a network failure: try again, keep the grant. A refusal by the
   * host policy is NOT transient; it throws.
   */
  | { readonly state: 'transient' }
  /** Any other answer; the status says which. */
  | { readonly state: 'refused'; readonly status: number };

// ── Provider ──────────────────────────────────────────────────────────────

export class OAuthGraphProvider implements MailProvider {
  readonly accountId: string;
  readonly address: string;
  readonly authType: MailAuthType = 'oauth_microsoft';

  /** Same cap and reason as `OAuthGmailProvider.MAX_UID_MAP_SIZE`. */
  private static readonly MAX_UID_MAP_SIZE = 10_000;

  private readonly auth: MicrosoftAuth;
  private readonly account: MailAccountConfig;
  private readonly cursors: DeltaCursorStore;
  private readonly limiter = new Limiter(GRAPH_MAX_CONCURRENT_REQUESTS);
  private readonly uidToGraphId = new Map<number, string>();
  private readonly graphIdToUid = new Map<string, number>();
  private nextUid = 1;
  private readonly watchers = new Set<NodeJS.Timeout>();
  /** Graph folders with a delta round in flight, across every watch of this provider. */
  private readonly roundsRunning = new Set<string>();
  private closed = false;
  private readonly aborter = new AbortController();

  /** What `send` puts in From as the name — the preview reads this same getter. */
  get fromDisplayName(): string {
    return this.account.displayName;
  }

  constructor(account: MailAccountConfig, auth: MicrosoftAuth, cursors: DeltaCursorStore) {
    this.accountId = account.id;
    this.address = account.address;
    this.account = account;
    this.auth = auth;
    this.cursors = cursors;
  }

  // ── Public MailProvider methods ─────────────────────────────────────────

  async list(opts: MailListOptions = {}): Promise<ReadonlyArray<MailEnvelope>> {
    this.assertOpen();
    const folder = opts.folder ?? 'INBOX';
    const limit = Math.min(opts.limit ?? DEFAULT_LIST_LIMIT, MAX_PAGE);
    try {
      const query = odataQuery([
        ['$select', ENVELOPE_FIELDS],
        ['$top', String(limit)],
        ['$filter', buildFilter({ since: opts.since, unseen: opts.unseenOnly })],
        ['$orderby', 'receivedDateTime desc'],
      ]);
      const page = await this.getJson<GraphCollection<GraphMessage>>(
        `${GRAPH_ME}/mailFolders/${folderSegment(folder)}/messages?${query}`, 'list');
      return this.envelopesOf(page.value, folder);
    } catch (err) {
      throw wrapGraphError(err, 'Graph list failed');
    }
  }

  /**
   * Free-text fields go to `$search` (KQL), the structured ones to `$filter`.
   * Graph does not take the two together, so when both are asked for the
   * structured part is applied here, over a full page, and the result cut to
   * `limit` afterwards — fewer than `limit` hits are then possible although
   * more exist further back. Whether KQL matches the way `MailSearchQuery`
   * describes (subject + from for `text`) is not measured.
   */
  async search(query: MailSearchQuery, opts: MailSearchOptions = {}): Promise<ReadonlyArray<MailEnvelope>> {
    this.assertOpen();
    const folder = opts.folder ?? 'INBOX';
    const limit = Math.min(opts.limit ?? DEFAULT_SEARCH_LIMIT, MAX_PAGE);
    try {
      const segment = folderSegment(folder);
      const kql = buildKql(query);
      if (kql === null) {
        const q = odataQuery([
          ['$select', ENVELOPE_FIELDS],
          ['$top', String(limit)],
          ['$filter', buildFilter(query)],
          ['$orderby', 'receivedDateTime desc'],
        ]);
        const page = await this.getJson<GraphCollection<GraphMessage>>(`${GRAPH_ME}/mailFolders/${segment}/messages?${q}`, 'search');
        return this.envelopesOf(page.value, folder);
      }
      const structured = query.since !== undefined || query.before !== undefined
        || query.unseen === true || query.flagged === true || query.hasAttachment === true;
      const q = odataQuery([
        ['$select', ENVELOPE_FIELDS],
        ['$top', String(structured ? MAX_PAGE : limit)],
        ['$search', `"${kql}"`],
      ]);
      const page = await this.getJson<GraphCollection<GraphMessage>>(`${GRAPH_ME}/mailFolders/${segment}/messages?${q}`, 'search');
      const all = this.envelopesOf(page.value, folder);
      const kept = all.filter((env) =>
        (query.since === undefined || env.date.getTime() >= query.since.getTime())
        && (query.before === undefined || env.date.getTime() < query.before.getTime())
        && (query.unseen !== true || !env.flags.includes('\\Seen'))
        && (query.flagged !== true || env.flags.includes('\\Flagged'))
        && (query.hasAttachment !== true || env.hasAttachments));
      return kept.slice(0, limit);
    } catch (err) {
      throw wrapGraphError(err, 'Graph search failed');
    }
  }

  async fetch(opts: MailFetchOptions): Promise<MailMessage> {
    this.assertOpen();
    const graphId = this.uidToGraphId.get(opts.uid);
    if (!graphId) {
      throw new MailError('not_found', `Microsoft 365 uid=${String(opts.uid)} not in current session map. Re-run mail_triage or mail_search to refresh.`);
    }
    const folder = opts.folder ?? 'INBOX';
    try {
      const id = messageSegment(graphId);
      // No `Prefer: outlook.body-content-type="text"`: Graph's own HTML-to-text
      // would keep text hidden by CSS. The HTML comes here and goes through the
      // same stripper the IMAP provider uses.
      const [msg, attachments] = await Promise.all([
        this.getJson<GraphMessage>(
          `${GRAPH_ME}/messages/${id}?${odataQuery([['$select', `${ENVELOPE_FIELDS},body,internetMessageHeaders`]])}`, 'fetch'),
        this.getJson<GraphCollection<GraphAttachment>>(
          `${GRAPH_ME}/messages/${id}/attachments?${odataQuery([['$select', 'id,name,contentType,size,isInline']])}`, 'attachments'),
      ]);
      const raw = typeof msg.body?.content === 'string' ? msg.body.content : '';
      const truncated = raw.length > MAX_BODY_CHARS;
      const content = truncated ? raw.slice(0, MAX_BODY_CHARS) : raw;
      const isHtml = (msg.body?.contentType ?? '').toLowerCase() === 'html';
      const text = isHtml ? htmlToTextSnippet(content) : content;
      return {
        envelope: this.toEnvelope(msg, folder, opts.uid),
        text: truncated ? `${text}\n\n[… body truncated at ${String(MAX_BODY_CHARS)} characters for safety]` : text,
        html: opts.includeHtml && isHtml ? content : undefined,
        attachments: (attachments.value ?? []).flatMap((a): MailAttachmentMeta[] =>
          typeof a.id === 'string'
            ? [{
              partId: a.id,
              filename: typeof a.name === 'string' ? a.name : undefined,
              contentType: typeof a.contentType === 'string' ? a.contentType : 'application/octet-stream',
              sizeBytes: typeof a.size === 'number' ? a.size : 0,
              contentId: undefined,
              inline: a.isInline === true,
            }]
            : []),
        inReplyTo: headerValue(msg, 'In-Reply-To'),
        references: headerValue(msg, 'References'),
      };
    } catch (err) {
      throw wrapGraphError(err, `Graph fetch uid=${String(opts.uid)}`);
    }
  }

  /**
   * MIME through `/me/sendMail`. Graph answers 202 with no body, so there is no
   * server id to return; the Message-ID written into the MIME is returned
   * instead. Whether Exchange keeps a client-set Message-ID is not measured.
   */
  async send(input: MailSendInput): Promise<MailSendResult> {
    this.assertOpen();
    const info = this.auth.getAccountInfo();
    if (!info || !hasGraphScope(info.scopes, 'Mail.Send')) {
      throw new MailError('unsupported', 'Sending through Microsoft 365 requires the Mail.Send permission. Reconnect the mailbox and grant send access.');
    }
    if (input.attachments !== undefined && input.attachments.length > 0) {
      // The shared MIME builder writes no attachment parts. Refused here rather
      // than sent without them and reported as sent.
      throw new MailError('unsupported', 'Attachments are not sent through Microsoft 365 yet. Nothing was sent.');
    }
    const fromAddress = await this.resolveFromAddress();
    const messageId = `<${randomUUID()}@${messageIdDomain(fromAddress)}>`;
    const mime = buildRfc2822(input, fromAddress, this.fromDisplayName, { messageId });
    try {
      const res = await this.request(`${GRAPH_ME}/sendMail`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: Buffer.from(mime, 'utf-8').toString('base64'),
      });
      if (!res.ok) {
        const err = await errorFrom(res, 'sendMail');
        if (err.status === 400) {
          throw new GraphHttpError('send_rejected', err.message, err.status, err.graphCode, null);
        }
        throw err;
      }
      return {
        messageId,
        accepted: [
          ...input.to.map((a) => a.address),
          ...(input.cc?.map((a) => a.address) ?? []),
          ...(input.bcc?.map((a) => a.address) ?? []),
        ],
        rejected: [],
      };
    } catch (err) {
      throw wrapGraphError(err, 'Graph send failed');
    }
  }

  /**
   * Polls the folder's delta. The first round starts at the time `watch` was
   * called (`$filter=receivedDateTime ge …`, `changeType=created`), so the
   * folder's history is not reported as new; *assumed* that Graph applies the
   * two options together on the first call. A lost cursor (410, or a 4xx whose
   * code names the sync state) restarts the same way, from where the current
   * round began — not from the `Location` Graph may offer, which would be a
   * sync of the whole folder. A message moved into the folder with an older
   * `receivedDateTime` is not seen by such a restart. A 429 pauses the ticks
   * for `Retry-After`.
   *
   * A tick reports at most about `maxPerTick` messages: the round stops after
   * the first page that reaches it and parks the nextLink. One round per folder
   * at a time across all watches of this provider, and the cursor is keyed by
   * the Graph folder, so `INBOX` and `inbox` share it.
   *
   * The cursor advances and ids count as reported only after the handler
   * returned: a handler that throws gets the same messages again next tick.
   */
  async watch(opts: MailWatchOptions, handler: MailWatchHandler): Promise<MailWatchHandle> {
    this.assertOpen();
    const folder = opts.folder ?? 'INBOX';
    const segment = folderSegment(folder);
    const intervalMs = opts.intervalMs ?? DEFAULT_WATCH_INTERVAL_MS;
    const maxPerTick = Math.min(opts.maxPerTick ?? DEFAULT_WATCH_MAX_PER_TICK, MAX_PAGE);
    const startedAt = new Date().toISOString();
    const reported = new Set<string>();
    let stopped = false;
    let pausedUntil = 0;

    const tick = async (): Promise<void> => {
      // One round per folder at a time: two rounds would read the same cursor and both report.
      if (stopped || this.closed || this.roundsRunning.has(segment) || Date.now() < pausedUntil) return;
      this.roundsRunning.add(segment);
      try {
        const round = await this.deltaRound(segment, startedAt, maxPerTick);
        if (stopped || this.closed) return;
        const fresh = round.messages.filter((m) => !reported.has(m.id as string));
        const envelopes = fresh.map((m) => this.toEnvelope(m, folder, this.assignUid(m.id as string)));
        await handler(envelopes.length > 0 ? { type: 'new', envelopes } : { type: 'ok' });
        for (const m of fresh) reported.add(m.id as string);
        while (reported.size > WATCH_DEDUP_MAX) {
          const oldest = reported.values().next().value;
          if (oldest === undefined) break;
          reported.delete(oldest);
        }
        round.commit();
      } catch (err) {
        if (stopped || this.closed || isAbort(err)) return;
        if (err instanceof GraphHttpError && err.status === 429) {
          pausedUntil = Date.now() + (err.retryAfterMs ?? intervalMs);
        }
        try {
          await handler({ type: 'error', error: err instanceof Error ? err : new Error(String(err)) });
        } catch {
          // A handler that throws on the error event has nowhere to report to;
          // swallowed so the interval does not leave an unhandled rejection.
        }
      } finally {
        this.roundsRunning.delete(segment);
      }
    };

    const timer = setInterval(() => { void tick(); }, intervalMs);
    this.watchers.add(timer);
    return {
      stop: async () => {
        stopped = true;
        clearInterval(timer);
        this.watchers.delete(timer);
      },
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.aborter.abort();
    for (const timer of this.watchers) clearInterval(timer);
    this.watchers.clear();
    this.uidToGraphId.clear();
    this.graphIdToUid.clear();
  }

  /** The mailbox address `send` puts in From — the same memoised value. */
  fromAddress(): Promise<string> {
    if (this.closed) return Promise.reject(new MailError('connection_failed', 'Provider closed'));
    return this.resolveFromAddress();
  }

  /**
   * Does this grant reach an Exchange mailbox? `GET /me/mailFolders/inbox`.
   * *Assumed* until measured: no mailbox answers 404 or `MailboxNotEnabledForRESTAPI`.
   * A failing token is NOT a probe result: it throws, and the grant's own
   * refresh state says why.
   */
  async probeMailbox(): Promise<GraphMailboxProbe> {
    this.assertOpen();
    const token = await this.auth.getAccessToken();
    const url = `${GRAPH_ME}/mailFolders/inbox?${odataQuery([['$select', 'id']])}`;
    // The host policy is asked HERE, on its own, before the request: a refusal is
    // permanent until the operator changes the policy, so it throws. Everything
    // the request itself throws — DNS, a broken redirect, the network — stays
    // `transient`, whatever its wording. Matching the error text instead would
    // tie this to `network-guard.ts`'s strings, and DNS failures there begin with
    // the same `Blocked:` as a policy refusal.
    assertHostPolicy(url, { surface: 'connector', hosts: GRAPH_API_HOSTS }, this.auth.hostPolicy);
    let res: Response;
    try {
      res = await this.limiter.run(() => this.fetchWithToken(url, { method: 'GET' }, token));
    } catch (err) {
      if (this.closed) throw err;
      return { state: 'transient' };
    }
    if (res.ok) return { state: 'ok' };
    const code = graphErrorCode(await res.text().catch(() => ''));
    if (res.status === 404 || code === 'MailboxNotEnabledForRESTAPI') return { state: 'no-mailbox' };
    if (res.status === 429 || res.status >= 500) return { state: 'transient' };
    return { state: 'refused', status: res.status };
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private assertOpen(): void {
    if (this.closed) throw new MailError('connection_failed', 'Provider closed');
  }

  /**
   * The mailbox's own address (`/me` → `mail`), memoised per access token like
   * the Gmail profile read. `userPrincipalName` is not a fallback: it is a
   * sign-in name and need not be an address the mailbox can send from.
   */
  private cachedFrom: { token: string; address: string } | undefined;
  private async resolveFromAddress(): Promise<string> {
    const token = await this.auth.getAccessToken();
    if (this.cachedFrom?.token === token) return this.cachedFrom.address;
    const me = await this.getJson<{ mail?: unknown }>(`${GRAPH_ME}?${odataQuery([['$select', 'mail']])}`, 'me');
    const address = typeof me.mail === 'string' ? me.mail.trim() : '';
    if (address === '') throw new MailError('connection_failed', 'Microsoft 365 account has no mailbox address');
    this.cachedFrom = { token, address };
    return address;
  }

  /**
   * One delta round: follow links until a deltaLink, at most
   * WATCH_MAX_PAGES_PER_TICK pages, and no further than the first page that
   * brings the round to `pageSize` messages. Returns the created messages (each
   * id once) and a `commit` that stores where the next round resumes.
   *
   * `since` moves only when a round reaches its deltaLink. A parked nextLink
   * keeps the round's starting point: pages not yet read may hold older
   * messages, and a restart from the newest one already seen would skip them.
   */
  private async deltaRound(
    segment: string,
    startedAt: string,
    pageSize: number,
  ): Promise<{ messages: GraphMessage[]; commit: () => void }> {
    const stored = this.cursors.get(this.accountId, segment);
    const roundStart = stored?.since ?? startedAt;
    let newest = roundStart;
    const restartUrl = (from: string): string => `${GRAPH_ME}/mailFolders/${segment}/messages/delta?${odataQuery([
      ['changeType', 'created'],
      ['$select', ENVELOPE_FIELDS],
      ['$filter', `receivedDateTime ge ${from}`],
    ])}`;
    let url = stored?.link ?? restartUrl(roundStart);
    let restarted = false;
    const messages: GraphMessage[] = [];
    const seen = new Set<string>();
    for (let page = 0; page < WATCH_MAX_PAGES_PER_TICK; page++) {
      const res = await this.request(url, { method: 'GET', headers: { Prefer: `odata.maxpagesize=${String(pageSize)}` } });
      if (!res.ok) {
        const err = await errorFrom(res, 'delta');
        if (!restarted && isLostCursor(err)) {
          restarted = true;
          url = restartUrl(roundStart);
          page = -1;
          continue;
        }
        throw err;
      }
      const body = await jsonOf<GraphCollection<GraphMessage>>(res, 'delta');
      for (const item of body.value ?? []) {
        if (item['@removed'] !== undefined || typeof item.id !== 'string') continue;
        // A restart inside the round returns what the round already read.
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        messages.push(item);
        // Compared as instants, not as strings: Graph writes `…00Z`, `toISOString` writes
        // `…00.000Z`, and `'Z' > '.'` would order the same instant as later.
        if (typeof item.receivedDateTime === 'string' && Date.parse(item.receivedDateTime) > Date.parse(newest)) {
          newest = item.receivedDateTime;
        }
      }
      const next = body['@odata.nextLink'];
      const delta = body['@odata.deltaLink'];
      if (typeof delta === 'string') {
        assertGraphUrl(delta);
        const cursor: DeltaCursor = { link: delta, since: newest };
        return { messages, commit: () => this.cursors.set(this.accountId, segment, cursor) };
      }
      if (typeof next !== 'string') {
        throw new MailError('connection_failed', 'Graph delta: a page with neither nextLink nor deltaLink');
      }
      url = next;
      if (messages.length >= pageSize) break;
    }
    // Stopped mid-round (tick budget or page cap): resume at the parked nextLink
    // next tick, from the round's starting point if that link is lost.
    assertGraphUrl(url);
    const cursor: DeltaCursor = { link: url, since: roundStart };
    return { messages, commit: () => this.cursors.set(this.accountId, segment, cursor) };
  }

  private envelopesOf(list: ReadonlyArray<GraphMessage> | undefined, folder: string): MailEnvelope[] {
    return (list ?? [])
      .filter((m) => typeof m.id === 'string')
      .map((m) => this.toEnvelope(m, folder, this.assignUid(m.id as string)));
  }

  /** Same LRU discipline as the Gmail provider: both maps shrink in lockstep. */
  private assignUid(graphId: string): number {
    const existing = this.graphIdToUid.get(graphId);
    if (existing !== undefined) return existing;
    if (this.uidToGraphId.size >= OAuthGraphProvider.MAX_UID_MAP_SIZE) {
      const oldestUid = this.uidToGraphId.keys().next().value;
      if (oldestUid !== undefined) {
        const oldestId = this.uidToGraphId.get(oldestUid);
        this.uidToGraphId.delete(oldestUid);
        if (oldestId !== undefined) this.graphIdToUid.delete(oldestId);
      }
    }
    const uid = this.nextUid++;
    this.uidToGraphId.set(uid, graphId);
    this.graphIdToUid.set(graphId, uid);
    return uid;
  }

  private toEnvelope(msg: GraphMessage, folder: string, uid: number): MailEnvelope {
    const received = typeof msg.receivedDateTime === 'string' ? new Date(msg.receivedDateTime) : new Date(Number.NaN);
    const hasAttachments = msg.hasAttachments === true;
    const from = toAddress(msg.from);
    return {
      uid,
      messageId: typeof msg.internetMessageId === 'string' && msg.internetMessageId !== '' ? msg.internetMessageId : undefined,
      folder,
      threadKey: typeof msg.conversationId === 'string' && msg.conversationId !== '' ? `graph:${msg.conversationId}` : undefined,
      inReplyTo: headerValue(msg, 'In-Reply-To'),
      from: from ? [from] : [],
      to: toAddresses(msg.toRecipients),
      cc: toAddresses(msg.ccRecipients),
      replyTo: toAddresses(msg.replyTo),
      subject: typeof msg.subject === 'string' ? msg.subject : '',
      date: Number.isNaN(received.getTime()) ? new Date() : received,
      flags: flagsOf(msg),
      // Graph's own `bodyPreview`, rendered on the server: unlike `fetch`, it does
      // NOT pass through the hidden-text stripper. Same gap as the Gmail snippet.
      snippet: snippetOf(typeof msg.bodyPreview === 'string' ? msg.bodyPreview : ''),
      hasAttachments,
      // A collection carries only the boolean; the count needs one request per
      // message. One is the lower bound when there are any. Graph's
      // `hasAttachments` does not count inline attachments.
      attachmentCount: hasAttachments ? 1 : 0,
      sizeBytes: undefined,
      isAutoReply: isAutoSubmittedHeader(headerValue(msg, 'Auto-Submitted')),
      listId: listIdFromHeader(headerValue(msg, 'List-Id')),
    };
  }

  // ── HTTP plumbing ────────────────────────────────────────────────────────

  private async fetchWithToken(url: string, init: { method: string; headers?: Record<string, string>; body?: string }, token: string): Promise<Response> {
    assertGraphUrl(url);
    const own = AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), this.aborter.signal]);
    return await graphFetch(url, {
      method: init.method,
      headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
      ...(init.body !== undefined ? { body: init.body } : {}),
      // A GET also ends with the call it runs in, when the run is stopped. Any other method
      // writes (`send`) and runs to its end once it started. The token was fetched before this,
      // without the call: a refresh is shared by every call waiting on it.
      signal: init.method === 'GET' ? joinCallSignal(own) : own,
    }, this.auth.hostPolicy);
  }

  private request(url: string, init: { method: string; headers?: Record<string, string>; body?: string }): Promise<Response> {
    return this.limiter.run(async () => this.fetchWithToken(url, init, await this.auth.getAccessToken()));
  }

  private async getJson<T>(url: string, label: string): Promise<T> {
    const res = await this.request(url, { method: 'GET' });
    if (!res.ok) throw await errorFrom(res, label);
    return await jsonOf<T>(res, label);
  }
}
