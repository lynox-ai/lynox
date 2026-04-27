// === OAuth-Gmail provider ===
//
// Wraps the Gmail REST API behind the MailProvider interface so Gmail accounts
// connected via OAuth coexist with IMAP/SMTP accounts in the same MailRegistry.
// Tools (mail_triage, mail_search, mail_read, mail_send, mail_reply) see the
// same shape regardless of transport.
//
// ── UID model (synthetic, per provider lifetime) ──────────────────────────
//
// MailEnvelope.uid is `number`, but Gmail message IDs are hex strings. We
// keep an in-memory `syntheticUid → gmailId` map populated on every list /
// search call and consumed by fetch. The map is regenerated when the engine
// restarts or the provider is closed — same lifetime semantics as IMAP
// UIDVALIDITY changes, so callers must not persist uids across restarts.
//
// ── Token refresh ──────────────────────────────────────────────────────────
//
// All token handling lives in GoogleAuth. This provider calls
// `googleAuth.getAccessToken()` per request — GoogleAuth refreshes
// transparently when the token is near expiry, so we never duplicate refresh
// logic here.

import type { GoogleAuth } from '../../google/google-auth.js';
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
} from '../provider.js';

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_LIST_LIMIT = 50;
const DEFAULT_SEARCH_LIMIT = 50;
const DEFAULT_WATCH_INTERVAL_MS = 120_000;
const DEFAULT_WATCH_MAX_PER_TICK = 50;
// Re-query a 60-second overlap each tick. Gmail's index can lag the
// server-side message arrival by a few seconds, and clock skew between
// us and Google can also drop a message that's "before" our `since` from
// our perspective but "after" it from the server's. The dedup map below
// absorbs the duplicates this introduces.
const WATCH_SINCE_OVERLAP_MS = 60_000;
const WATCH_DEDUP_TTL_MS = 5 * 60_000;
const WATCH_DEDUP_MAX = 1_000;
const SNIPPET_CHARS = 500;

// Gmail label that maps to IMAP's INBOX. Other folder names pass through —
// the agent can use Gmail label IDs directly when it needs custom labels.
const INBOX_LABEL = 'INBOX';

// ── Gmail API response shapes ─────────────────────────────────────────────

interface GmailListResponse {
  messages?: ReadonlyArray<{ id: string; threadId: string }>;
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: ReadonlyArray<string>;
  snippet?: string;
  sizeEstimate?: number;
  internalDate?: string;
  payload?: GmailPayload;
}

interface GmailPayload {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: ReadonlyArray<{ name: string; value: string }>;
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: ReadonlyArray<GmailPayload>;
}

interface GmailProfile {
  emailAddress: string;
  messagesTotal?: number;
  threadsTotal?: number;
}

interface GmailSendResponse {
  id: string;
  threadId: string;
  labelIds?: ReadonlyArray<string>;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function header(headers: ReadonlyArray<{ name: string; value: string }> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const h of headers) {
    if (h.name.toLowerCase() === lower) return decodeMimeWords(h.value);
  }
  return undefined;
}

/**
 * Decode RFC 2047 MIME encoded-words like `=?UTF-8?B?...?=` and `=?UTF-8?Q?...?=`
 * that appear in Subject / From / To headers when the original contained
 * non-ASCII characters. Without this, `Subject: =?UTF-8?B?w7xtbGF1dHM=?=`
 * lands in the agent context as opaque base64, AND the boundary scanner
 * can't see through the encoding to detect injection-shaped content.
 *
 * Coverage: UTF-8 + ISO-8859-1 (Buffer-supported). Other charsets fall
 * back to UTF-8 decoding which is best-effort but never throws.
 */
function decodeMimeWords(value: string): string {
  return value.replace(
    /=\?([\w-]+)\?([BbQq])\?([^?]+)\?=(?:\s+(?==\?))?/g,
    (_match, charset: string, encoding: string, payload: string) => {
      try {
        const cs = charset.toLowerCase();
        const enc = encoding.toUpperCase();
        let bytes: Buffer;
        if (enc === 'B') {
          bytes = Buffer.from(payload, 'base64');
        } else {
          // Q-encoding: `_` → space, `=XX` → byte
          const expanded = payload.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_m, h: string) => String.fromCharCode(Number.parseInt(h, 16)));
          bytes = Buffer.from(expanded, 'binary');
        }
        const codec: BufferEncoding = cs === 'iso-8859-1' || cs === 'latin1'
          ? 'latin1'
          : cs === 'us-ascii' || cs === 'ascii'
          ? 'ascii'
          : 'utf-8';
        return bytes.toString(codec);
      } catch {
        return ''; // never let a malformed encoded-word leak its raw payload
      }
    },
  );
}

/**
 * RFC 2045 quoted-printable decoding for body parts. `=20` → space, `=3D`
 * → `=`, soft line breaks (`=\r\n` or `=\n`) join lines, every other `=XX`
 * is a hex byte. Used when a Gmail payload reports
 * Content-Transfer-Encoding: quoted-printable.
 */
function decodeQuotedPrintable(input: string, charset: string): string {
  const cleaned = input
    // Soft line breaks (must come first so we don't try to interpret `=\r` as a hex escape)
    .replace(/=\r?\n/g, '')
    // Hex escapes
    .replace(/=([0-9A-Fa-f]{2})/g, (_m, h: string) => String.fromCharCode(Number.parseInt(h, 16)));

  const cs = (charset || 'utf-8').toLowerCase();
  const codec: BufferEncoding = cs === 'iso-8859-1' || cs === 'latin1'
    ? 'latin1'
    : cs === 'us-ascii' || cs === 'ascii'
    ? 'ascii'
    : 'utf-8';
  return Buffer.from(cleaned, 'binary').toString(codec);
}

/** Lookup the charset declared on a part's Content-Type header, or undefined. */
function partCharset(payload: GmailPayload | undefined): string | undefined {
  const ct = header(payload?.headers, 'Content-Type');
  if (!ct) return undefined;
  const m = ct.match(/charset\s*=\s*"?([^";\s]+)"?/i);
  return m?.[1];
}

/** Lookup Content-Transfer-Encoding (e.g. 'quoted-printable', 'base64', '7bit'). */
function partTransferEncoding(payload: GmailPayload | undefined): string {
  return (header(payload?.headers, 'Content-Transfer-Encoding') ?? '7bit').toLowerCase();
}

function base64urlDecode(data: string): Buffer {
  const padded = data.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded, 'base64');
}

function base64urlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Parse an RFC5322 address-list header value into MailAddress[].
 * Tolerant — accepts "Name <addr@x>", bare "addr@x", quoted display names,
 * and comma-separated lists. Drops entries without a usable address.
 */
function parseAddressList(value: string | undefined): MailAddress[] {
  if (!value) return [];
  const out: MailAddress[] = [];
  // Split on commas not inside quotes
  const parts = value.match(/(?:"[^"]*"|[^,])+/g) ?? [];
  for (const raw of parts) {
    const part = raw.trim();
    if (!part) continue;
    const angle = part.match(/^(.*?)\s*<([^>]+)>\s*$/);
    if (angle) {
      const name = angle[1]!.replace(/^"|"$/g, '').trim();
      const address = angle[2]!.trim();
      if (!address) continue;
      out.push(name ? { name, address } : { address });
    } else if (part.includes('@')) {
      out.push({ address: part });
    }
  }
  return out;
}

function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Find the first part with the given mimeType in a Gmail payload tree. */
function findPart(payload: GmailPayload | undefined, mime: string): GmailPayload | undefined {
  if (!payload) return undefined;
  if (payload.mimeType === mime) return payload;
  if (payload.parts) {
    for (const child of payload.parts) {
      const found = findPart(child, mime);
      if (found) return found;
    }
  }
  return undefined;
}

/** Walk the payload tree collecting attachment metadata (non-inline-text parts with attachmentId). */
function collectAttachments(payload: GmailPayload | undefined): MailAttachmentMeta[] {
  const out: MailAttachmentMeta[] = [];
  if (!payload) return out;

  const visit = (node: GmailPayload): void => {
    const mime = node.mimeType ?? '';
    const isMultipart = mime.startsWith('multipart/');
    const hasAttachmentRef = !!node.body?.attachmentId;
    const isText = mime.startsWith('text/');
    if (!isMultipart && (hasAttachmentRef || (!isText && node.filename))) {
      out.push({
        partId: node.partId ?? '',
        filename: node.filename || undefined,
        contentType: mime,
        sizeBytes: node.body?.size ?? 0,
        contentId: header(node.headers, 'Content-ID')?.replace(/^<|>$/g, ''),
        inline: (header(node.headers, 'Content-Disposition') ?? '').toLowerCase().startsWith('inline'),
      });
    }
    if (node.parts) {
      for (const child of node.parts) visit(child);
    }
  };

  visit(payload);
  return out;
}

/**
 * Decode a Gmail body part's `body.data` honouring its Content-Transfer-
 * Encoding and declared charset. Gmail's `format=full` API delivers the
 * payload bytes pre-decoded from base64url, but the bytes themselves may
 * still be quoted-printable or in a non-UTF-8 charset — the previous
 * implementation assumed UTF-8 + base64-only and silently produced
 * garbled body text for anything German/legacy.
 */
function decodePartBody(part: GmailPayload | undefined): string {
  if (!part?.body?.data) return '';
  const charset = partCharset(part) ?? 'utf-8';
  const tx = partTransferEncoding(part);
  // Gmail wraps everything in base64url at the API boundary, so the inner
  // string here is the post-base64url payload — i.e. either raw text or
  // QP/base64-of-the-original. We base64url-decode once unconditionally.
  const raw = base64urlDecode(part.body.data);
  if (tx === 'quoted-printable') {
    return decodeQuotedPrintable(raw.toString('binary'), charset);
  }
  if (tx === 'base64') {
    // Gmail typically delivers already-decoded text via base64url, so a
    // declared 'base64' transfer encoding is rare. If it does appear,
    // treat the post-base64url bytes as the actual payload.
    const codec: BufferEncoding = charset.toLowerCase() === 'iso-8859-1' ? 'latin1' : 'utf-8';
    return raw.toString(codec);
  }
  // 7bit / 8bit / binary / unspecified — just decode bytes as the charset.
  const codec: BufferEncoding = charset.toLowerCase() === 'iso-8859-1' || charset.toLowerCase() === 'latin1'
    ? 'latin1'
    : 'utf-8';
  return raw.toString(codec);
}

function extractText(payload: GmailPayload | undefined): string {
  if (!payload) return '';
  // Prefer text/plain
  const plain = findPart(payload, 'text/plain');
  if (plain?.body?.data) return decodePartBody(plain);
  // Fall back to text/html → strip tags
  const html = findPart(payload, 'text/html');
  if (html?.body?.data) return htmlToText(decodePartBody(html));
  // Single-part with inline body
  if (payload.body?.data) {
    if (payload.mimeType === 'text/html') return htmlToText(decodePartBody(payload));
    return decodePartBody(payload);
  }
  return '';
}

function snippetFrom(text: string, max: number): string {
  const cleaned = text.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
  if (cleaned.length <= max) return cleaned;
  const cut = cleaned.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd();
}

function isAutoSubmitted(value: string | undefined): boolean {
  if (!value) return false;
  const lower = value.toLowerCase().trim();
  return lower !== 'no' && lower !== '';
}

function flagsFromLabels(labelIds: ReadonlyArray<string> | undefined): ReadonlyArray<MailFlag> {
  if (!labelIds) return [];
  const flags: MailFlag[] = [];
  if (!labelIds.includes('UNREAD')) flags.push('\\Seen');
  if (labelIds.includes('STARRED')) flags.push('\\Flagged');
  if (labelIds.includes('DRAFT')) flags.push('\\Draft');
  return flags;
}

function buildSearchQuery(query: MailSearchQuery): string {
  const terms: string[] = [];
  if (query.from) terms.push(`from:${query.from}`);
  if (query.to) terms.push(`to:${query.to}`);
  if (query.subject) terms.push(`subject:"${query.subject}"`);
  if (query.text) terms.push(query.text);
  if (query.unseen) terms.push('is:unread');
  if (query.flagged) terms.push('is:starred');
  if (query.hasAttachment) terms.push('has:attachment');
  if (query.since) terms.push(`after:${Math.floor(query.since.getTime() / 1000)}`);
  if (query.before) terms.push(`before:${Math.floor(query.before.getTime() / 1000)}`);
  return terms.join(' ');
}

function buildListQuery(opts: MailListOptions): string {
  const terms: string[] = [];
  if (opts.unseenOnly) terms.push('is:unread');
  if (opts.since) terms.push(`after:${Math.floor(opts.since.getTime() / 1000)}`);
  return terms.join(' ');
}

function metadataHeaders(): string[] {
  return ['From', 'To', 'Cc', 'Subject', 'Date', 'Message-ID', 'In-Reply-To', 'References', 'Reply-To', 'Auto-Submitted'];
}

/**
 * Strip CR/LF (and tab) from a header value to defeat header injection.
 * Without this, a subject like `Foo\r\nBcc: attacker@x` would inject an
 * extra Bcc header. RFC 5322 forbids these chars in unfolded headers.
 */
function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n\t]+/g, ' ').trim();
}

function buildRfc2822(input: MailSendInput, fromAddress: string): string {
  const lines: string[] = [];
  // Display names get quotes escaped + CRLF stripped so a malicious display
  // name can't terminate its own quoted string and inject a header.
  const formatAddr = (a: MailAddress): string => {
    const address = sanitizeHeaderValue(a.address);
    if (!a.name) return address;
    const safeName = sanitizeHeaderValue(a.name).replace(/"/g, '\\"');
    return `"${safeName}" <${address}>`;
  };
  lines.push(`From: ${sanitizeHeaderValue(fromAddress)}`);
  lines.push(`To: ${input.to.map(formatAddr).join(', ')}`);
  if (input.cc?.length) lines.push(`Cc: ${input.cc.map(formatAddr).join(', ')}`);
  if (input.bcc?.length) lines.push(`Bcc: ${input.bcc.map(formatAddr).join(', ')}`);
  if (input.replyTo) lines.push(`Reply-To: ${formatAddr(input.replyTo)}`);
  lines.push(`Subject: ${sanitizeHeaderValue(input.subject)}`);
  // Date is needed for proper threading on receiving servers — Gmail backfills
  // when omitted but that loses precision when the message is forwarded.
  lines.push(`Date: ${new Date().toUTCString()}`);
  if (input.inReplyTo) lines.push(`In-Reply-To: ${sanitizeHeaderValue(input.inReplyTo)}`);
  if (input.references) lines.push(`References: ${sanitizeHeaderValue(input.references)}`);
  lines.push('MIME-Version: 1.0');
  if (input.html) {
    // Multipart alternative, very minimal
    const boundary = `lynox-${Math.random().toString(36).slice(2, 12)}`;
    lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    lines.push('');
    lines.push(`--${boundary}`);
    lines.push('Content-Type: text/plain; charset="UTF-8"');
    lines.push('Content-Transfer-Encoding: 7bit');
    lines.push('');
    lines.push(input.text);
    lines.push(`--${boundary}`);
    lines.push('Content-Type: text/html; charset="UTF-8"');
    lines.push('Content-Transfer-Encoding: 7bit');
    lines.push('');
    lines.push(input.html);
    lines.push(`--${boundary}--`);
  } else {
    lines.push('Content-Type: text/plain; charset="UTF-8"');
    lines.push('Content-Transfer-Encoding: 7bit');
    lines.push('');
    lines.push(input.text);
  }
  return lines.join('\r\n');
}

function wrapGmailError(err: unknown, fallback: string): MailError {
  if (err instanceof MailError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  return new MailError('connection_failed', `${fallback}: ${msg}`, { cause: err });
}

// ── Provider ───────────────────────────────────────────────────────────────

export class OAuthGmailProvider implements MailProvider {
  readonly accountId: string;
  readonly authType: MailAuthType = 'oauth_google';

  /**
   * LRU cap on the synthetic UID map. At 50 messages per watcher tick × 720
   * ticks per day this would otherwise grow ~1.1 MB/day forever; bounded
   * size keeps the long-running watcher predictable. Old entries that fall
   * off only break `mail_read({uid:N})` for stale uids — re-running
   * `mail_triage` reassigns and the new uid stays valid for that round-trip.
   */
  private static readonly MAX_UID_MAP_SIZE = 10_000;

  private readonly googleAuth: GoogleAuth;

  /**
   * Two synced maps — `uidToGmailId` is the read path used by `fetch`,
   * `gmailIdToUid` lets `assignUid` reuse an existing uid in O(1) instead of
   * the O(n) scan it used to do. Both grow together and shrink together
   * during eviction.
   */
  private readonly uidToGmailId = new Map<number, string>();
  private readonly gmailIdToUid = new Map<string, number>();
  private nextUid = 1;
  private readonly watchers = new Set<NodeJS.Timeout>();
  private closed = false;
  // Fired by close() to cancel any in-flight Gmail fetches; without this,
  // a fetch that resolves *after* close() can call assignUid on the just-
  // cleared uid map and leave dangling entries on a closed provider.
  private readonly aborter = new AbortController();

  constructor(account: MailAccountConfig, googleAuth: GoogleAuth) {
    this.accountId = account.id;
    this.googleAuth = googleAuth;
  }

  // ── Public MailProvider methods ─────────────────────────────────────────

  async list(opts: MailListOptions = {}): Promise<ReadonlyArray<MailEnvelope>> {
    if (this.closed) throw new MailError('connection_failed', 'Provider closed');
    const limit = Math.min(opts.limit ?? DEFAULT_LIST_LIMIT, 100);
    const labelIds = (opts.folder ?? INBOX_LABEL).toUpperCase();
    const params = new URLSearchParams({ labelIds, maxResults: String(limit) });
    const query = buildListQuery(opts);
    if (query) params.set('q', query);

    try {
      const refs = await this.gmailGet<GmailListResponse>(`messages?${params.toString()}`);
      return await this.envelopesFor(refs.messages ?? [], opts.folder ?? INBOX_LABEL);
    } catch (err) {
      throw wrapGmailError(err, 'Gmail list failed');
    }
  }

  async search(query: MailSearchQuery, opts: MailSearchOptions = {}): Promise<ReadonlyArray<MailEnvelope>> {
    if (this.closed) throw new MailError('connection_failed', 'Provider closed');
    const limit = Math.min(opts.limit ?? DEFAULT_SEARCH_LIMIT, 100);
    const params = new URLSearchParams({ maxResults: String(limit) });
    const q = buildSearchQuery(query);
    if (q) params.set('q', q);
    if (opts.folder) params.set('labelIds', opts.folder.toUpperCase());

    try {
      const refs = await this.gmailGet<GmailListResponse>(`messages?${params.toString()}`);
      return await this.envelopesFor(refs.messages ?? [], opts.folder ?? INBOX_LABEL);
    } catch (err) {
      throw wrapGmailError(err, 'Gmail search failed');
    }
  }

  async fetch(opts: MailFetchOptions): Promise<MailMessage> {
    if (this.closed) throw new MailError('connection_failed', 'Provider closed');
    const gmailId = this.uidToGmailId.get(opts.uid);
    if (!gmailId) {
      throw new MailError('not_found', `Gmail uid=${String(opts.uid)} not in current session map. Re-run mail_triage or mail_search to refresh.`);
    }
    try {
      const msg = await this.gmailGet<GmailMessage>(`messages/${gmailId}?format=full`);
      const env = this.toEnvelope(msg, opts.folder ?? INBOX_LABEL, opts.uid);
      const text = extractText(msg.payload);
      const html = opts.includeHtml ? this.extractHtml(msg.payload) : undefined;
      return {
        envelope: env,
        text,
        html,
        attachments: collectAttachments(msg.payload),
        inReplyTo: header(msg.payload?.headers, 'In-Reply-To'),
        references: header(msg.payload?.headers, 'References'),
      };
    } catch (err) {
      throw wrapGmailError(err, `Gmail fetch uid=${String(opts.uid)}`);
    }
  }

  async send(input: MailSendInput): Promise<MailSendResult> {
    if (this.closed) throw new MailError('connection_failed', 'Provider closed');
    if (!this.googleAuth.hasScope('https://www.googleapis.com/auth/gmail.send')) {
      throw new MailError('unsupported', 'Gmail send requires the gmail.send scope. Grant write access in Settings → Integrations → Google.');
    }
    const fromAddress = await this.resolveFromAddress();
    const raw = base64urlEncode(Buffer.from(buildRfc2822(input, fromAddress), 'utf-8'));
    try {
      const result = await this.gmailPost<GmailSendResponse>('messages/send', { raw });
      const allRecipients = [
        ...input.to.map(a => a.address),
        ...(input.cc?.map(a => a.address) ?? []),
        ...(input.bcc?.map(a => a.address) ?? []),
      ];
      return { messageId: result.id, accepted: allRecipients, rejected: [] };
    } catch (err) {
      throw wrapGmailError(err, 'Gmail send failed');
    }
  }

  async watch(opts: MailWatchOptions, handler: MailWatchHandler): Promise<MailWatchHandle> {
    if (this.closed) throw new MailError('connection_failed', 'Provider closed');
    const intervalMs = opts.intervalMs ?? DEFAULT_WATCH_INTERVAL_MS;
    const maxPerTick = Math.min(opts.maxPerTick ?? DEFAULT_WATCH_MAX_PER_TICK, 100);
    let lastTick = new Date();
    // Gmail-message-id → emit timestamp. Required because the SINCE_OVERLAP
    // window will return the same message twice across two consecutive ticks
    // until it falls out of the overlap. TTL-evicted on each tick to bound
    // memory on long-running watchers.
    const recentlyEmitted = new Map<string, number>();

    const tick = async (): Promise<void> => {
      if (this.closed) return;
      const since = new Date(lastTick.getTime() - WATCH_SINCE_OVERLAP_MS);
      lastTick = new Date();
      try {
        const fresh = await this.list({ folder: opts.folder, since, limit: maxPerTick });
        if (this.closed) return;

        const now = Date.now();
        for (const [id, t] of recentlyEmitted) {
          if (now - t > WATCH_DEDUP_TTL_MS) recentlyEmitted.delete(id);
        }

        const newOnly: MailEnvelope[] = [];
        for (const env of fresh) {
          const gmailId = this.uidToGmailId.get(env.uid);
          if (gmailId && recentlyEmitted.has(gmailId)) continue;
          if (gmailId) recentlyEmitted.set(gmailId, now);
          newOnly.push(env);
        }

        while (recentlyEmitted.size > WATCH_DEDUP_MAX) {
          const oldest = recentlyEmitted.keys().next().value;
          if (oldest === undefined) break;
          recentlyEmitted.delete(oldest);
        }

        if (newOnly.length > 0) {
          await handler({ type: 'new', envelopes: newOnly });
        }
      } catch (err) {
        if (this.closed) return;
        // close() abort surfaces here as AbortError; suppress so the consumer
        // doesn't see a spurious error event during shutdown.
        if (err instanceof Error && err.name === 'AbortError') return;
        await handler({ type: 'error', error: err instanceof Error ? err : new Error(String(err)) });
      }
    };

    const timer = setInterval(() => { void tick(); }, intervalMs);
    this.watchers.add(timer);

    return {
      stop: async () => {
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
    this.uidToGmailId.clear();
    this.gmailIdToUid.clear();
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /**
   * Resolve the user's email address via the Gmail profile endpoint. Memoised
   * on the GoogleAuth token data lifecycle — we still re-fetch on cache miss.
   */
  private cachedFromAddress: string | undefined;
  private async resolveFromAddress(): Promise<string> {
    if (this.cachedFromAddress) return this.cachedFromAddress;
    const profile = await this.gmailGet<GmailProfile>('profile');
    this.cachedFromAddress = profile.emailAddress;
    return profile.emailAddress;
  }

  private async envelopesFor(refs: ReadonlyArray<{ id: string; threadId: string }>, folder: string): Promise<MailEnvelope[]> {
    const headerParam = metadataHeaders().map(h => `metadataHeaders=${encodeURIComponent(h)}`).join('&');
    const envelopes: MailEnvelope[] = [];
    for (const ref of refs) {
      try {
        const msg = await this.gmailGet<GmailMessage>(`messages/${ref.id}?format=metadata&${headerParam}`);
        const uid = this.assignUid(msg.id);
        envelopes.push(this.toEnvelope(msg, folder, uid));
      } catch {
        // Skip messages we can't fetch — partial results are better than failing the whole call
      }
    }
    return envelopes;
  }

  /**
   * O(1) reuse via the reverse map. When the LRU cap is hit we evict the
   * oldest entry from BOTH maps in lockstep — JS Map iteration is insertion-
   * ordered, so `.keys().next()` is the oldest. No effect on dedup, which
   * uses the Message-ID header in MailStateDb, not these uids.
   */
  private assignUid(gmailId: string): number {
    const existing = this.gmailIdToUid.get(gmailId);
    if (existing !== undefined) return existing;

    if (this.uidToGmailId.size >= OAuthGmailProvider.MAX_UID_MAP_SIZE) {
      const oldestUid = this.uidToGmailId.keys().next().value;
      if (oldestUid !== undefined) {
        const oldestGmailId = this.uidToGmailId.get(oldestUid);
        this.uidToGmailId.delete(oldestUid);
        if (oldestGmailId !== undefined) this.gmailIdToUid.delete(oldestGmailId);
      }
    }

    const uid = this.nextUid++;
    this.uidToGmailId.set(uid, gmailId);
    this.gmailIdToUid.set(gmailId, uid);
    return uid;
  }

  private toEnvelope(msg: GmailMessage, folder: string, uid: number): MailEnvelope {
    const headers = msg.payload?.headers;
    const messageId = header(headers, 'Message-ID') ?? header(headers, 'Message-Id');
    const inReplyTo = header(headers, 'In-Reply-To');
    const dateHeader = header(headers, 'Date');
    const internalMs = msg.internalDate ? Number.parseInt(msg.internalDate, 10) : NaN;
    const date = Number.isFinite(internalMs)
      ? new Date(internalMs)
      : (dateHeader ? new Date(dateHeader) : new Date());

    const text = extractText(msg.payload);
    const attachments = collectAttachments(msg.payload);

    // Thread key — namespaced so we can tell Gmail threads from IMAP message-id chains
    const threadKey = `gmail:${msg.threadId}`;

    return {
      uid,
      messageId: messageId ?? undefined,
      folder,
      threadKey,
      inReplyTo,
      from: parseAddressList(header(headers, 'From')),
      to: parseAddressList(header(headers, 'To')),
      cc: parseAddressList(header(headers, 'Cc')),
      replyTo: parseAddressList(header(headers, 'Reply-To')),
      subject: header(headers, 'Subject') ?? '',
      date,
      flags: flagsFromLabels(msg.labelIds),
      snippet: snippetFrom(msg.snippet ?? text, SNIPPET_CHARS),
      hasAttachments: attachments.length > 0,
      attachmentCount: attachments.length,
      sizeBytes: msg.sizeEstimate,
      isAutoReply: isAutoSubmitted(header(headers, 'Auto-Submitted')),
    };
  }

  private extractHtml(payload: GmailPayload | undefined): string | undefined {
    const html = findPart(payload, 'text/html');
    if (html?.body?.data) return decodePartBody(html);
    return undefined;
  }

  // ── HTTP plumbing ────────────────────────────────────────────────────────

  private async authHeaders(): Promise<Record<string, string>> {
    const token = await this.googleAuth.getAccessToken();
    return {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
  }

  private async gmailGet<T>(path: string): Promise<T> {
    const headers = await this.authHeaders();
    const res = await globalThis.fetch(`${GMAIL_BASE}/${path}`, {
      headers,
      signal: AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), this.aborter.signal]),
    });
    return await this.parseResponse<T>(res, `GET ${path}`);
  }

  private async gmailPost<T>(path: string, body: unknown): Promise<T> {
    const headers = await this.authHeaders();
    const res = await globalThis.fetch(`${GMAIL_BASE}/${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), this.aborter.signal]),
    });
    return await this.parseResponse<T>(res, `POST ${path}`);
  }

  private async parseResponse<T>(res: Response, label: string): Promise<T> {
    if (res.ok) {
      return await res.json() as T;
    }
    const bodyText = await res.text().catch(() => '');
    if (res.status === 401) {
      throw new MailError('auth_failed', `Gmail ${label}: 401 — token rejected. Re-authorize in Settings → Integrations → Google.`);
    }
    if (res.status === 403) {
      // Gmail uses 403 for both insufficient-scope AND quota-exceeded. The
      // remediation is wildly different (re-authorize vs. wait it out), so
      // we split based on the structured `error.errors[0].reason` field.
      const reason = parseGmailErrorReason(bodyText);
      const isQuota = reason !== null && (
        reason === 'quotaexceeded' ||
        reason === 'userratelimitexceeded' ||
        reason === 'ratelimitexceeded' ||
        reason === 'dailylimitexceeded'
      );
      if (isQuota) {
        throw new MailError('rate_limited', `Gmail ${label}: 403 ${reason} — quota or rate limit exceeded; back off and retry.`);
      }
      throw new MailError('auth_failed', `Gmail ${label}: 403${reason ? ` ${reason}` : ''} — missing scope. Grant write access in Settings → Integrations → Google.`);
    }
    if (res.status === 404) {
      throw new MailError('not_found', `Gmail ${label}: 404 not found`);
    }
    if (res.status === 429) {
      throw new MailError('rate_limited', `Gmail ${label}: 429 rate limited`);
    }
    throw new MailError('connection_failed', `Gmail ${label}: HTTP ${String(res.status)} ${bodyText.slice(0, 200)}`);
  }
}

/**
 * Pull `error.errors[0].reason` (lowercased) out of a Gmail API error body.
 * Returns null when the body isn't JSON, or doesn't carry the reason.
 * Standard shape:
 *   {"error":{"code":403,"errors":[{"reason":"insufficientPermissions",...}]}}
 */
function parseGmailErrorReason(body: string): string | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as { error?: { errors?: Array<{ reason?: string }> } };
    const reason = parsed?.error?.errors?.[0]?.reason;
    return typeof reason === 'string' ? reason.toLowerCase() : null;
  } catch {
    return null;
  }
}
