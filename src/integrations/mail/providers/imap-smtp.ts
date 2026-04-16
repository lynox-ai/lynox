// === IMAP/SMTP base provider ===
//
// Wraps imapflow (read) + nodemailer (send) behind the MailProvider interface.
// All preset providers (gmail, icloud, fastmail, yahoo, outlook, custom) build
// on top of this — they only differ in the host/port/TLS configuration.

import { ImapFlow, type FetchMessageObject, type MessageStructureObject, type SearchObject } from 'imapflow';
import nodemailer, { type Transporter } from 'nodemailer';

import {
  MailError,
  type MailAccountConfig,
  type MailAddress,
  type MailAttachmentMeta,
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
  type MailWatchEvent,
  type MailWatchHandle,
  type MailWatchHandler,
  type MailWatchOptions,
} from '../provider.js';

// ── Credentials ────────────────────────────────────────────────────────────
//
// Phase 0: app-password only. Phase 1b will add { accessToken } for ms-oauth.
export interface MailCredentials {
  user: string;
  pass: string;
}

/** Async resolver so the provider never holds the password long-term. */
export type CredentialsResolver = () => Promise<MailCredentials> | MailCredentials;

/**
 * Provider construction options.
 *
 * `insecureTls` disables certificate validation on both IMAP and SMTP. It
 * exists ONLY for integration tests against local mail servers with
 * self-signed certificates (e.g. GreenMail in Docker). Production code paths
 * — including all preset factories — must leave it unset.
 */
export interface ImapSmtpProviderOptions {
  insecureTls?: boolean;
}

// ── Tuning constants (PRD: production security requirements) ───────────────

const CONNECT_TIMEOUT_MS = 10_000;
const GREETING_TIMEOUT_MS = 10_000;
const SOCKET_TIMEOUT_MS = 60_000;
const RECONNECT_BACKOFF_INITIAL_MS = 1_000;
const RECONNECT_BACKOFF_MAX_MS = 30_000;
const RECONNECT_MAX_ATTEMPTS = 5;
const SNIPPET_BYTES = 1_024;
const SNIPPET_CHARS = 500;
const DEFAULT_LIST_LIMIT = 50;
const DEFAULT_SEARCH_LIMIT = 50;
const DEFAULT_WATCH_INTERVAL_MS = 120_000; // 2 minutes per PRD
const DEFAULT_WATCH_MAX_PER_TICK = 50;
/** Upper bound on any downloaded body part. Silently trimmed beyond this. */
const MAX_BODY_BYTES = 10 * 1024 * 1024;
/** Upper bound on attachment filename length after sanitization. */
const MAX_FILENAME_LENGTH = 200;

// ── Helpers ────────────────────────────────────────────────────────────────

function toAddresses(input: ReadonlyArray<{ name?: string; address?: string }> | undefined): MailAddress[] {
  if (!input) return [];
  const out: MailAddress[] = [];
  for (const a of input) {
    if (!a.address) continue;
    out.push(a.name ? { name: a.name, address: a.address } : { address: a.address });
  }
  return out;
}

function toFlags(set: ReadonlySet<string> | undefined): ReadonlyArray<MailFlag> {
  if (!set) return [];
  return [...set] as ReadonlyArray<MailFlag>;
}

/** Find the first text/plain part in a parsed BODYSTRUCTURE tree. */
function findTextPart(node: MessageStructureObject | undefined, mime: 'text/plain' | 'text/html'): MessageStructureObject | undefined {
  if (!node) return undefined;
  if (node.type === mime) return node;
  if (node.childNodes) {
    for (const child of node.childNodes) {
      const found = findTextPart(child, mime);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * Sanitize an attachment filename.
 *
 * Adversarial filenames can carry path traversal (`../../etc/passwd`), CRLF
 * injection (`\r\nBcc: victim@x.com`), control characters, null bytes, and
 * excessive length. We strip all of these defensively before the filename
 * reaches the UI or the LLM context.
 */
export function sanitizeFilename(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const s = String(raw);
  if (s.length === 0) return undefined;
  const cleaned = s
    .replace(/[\x00-\x1f\x7f]/g, '')    // control chars incl. CR/LF/NUL
    .replace(/[/\\]/g, '_')              // path separators
    .replace(/^\.+/, '')                 // leading dots (foo. → hidden, ../ → ..)
    .replace(/\s+/g, ' ')                // collapse whitespace
    .trim();
  if (cleaned.length === 0) return undefined;
  return cleaned.length > MAX_FILENAME_LENGTH ? cleaned.slice(0, MAX_FILENAME_LENGTH) : cleaned;
}

/** Walk BODYSTRUCTURE collecting attachment-like (non-inline-text) parts. */
function collectAttachmentMetas(node: MessageStructureObject | undefined): MailAttachmentMeta[] {
  const out: MailAttachmentMeta[] = [];
  if (!node) return out;

  const visit = (n: MessageStructureObject): void => {
    const isMultipart = n.type.startsWith('multipart/');
    const disposition = (n.disposition ?? '').toLowerCase();
    const isAttachment =
      !isMultipart &&
      (disposition === 'attachment' ||
        (disposition === 'inline' && !n.type.startsWith('text/')) ||
        (!disposition && !n.type.startsWith('text/') && !n.type.startsWith('multipart/')));

    if (isAttachment && n.part) {
      const params = n.dispositionParameters ?? n.parameters ?? {};
      const filenameRaw = params['filename'] ?? params['name'];
      out.push({
        partId: n.part,
        filename: sanitizeFilename(filenameRaw),
        contentType: n.type,
        sizeBytes: n.size ?? 0,
        contentId: n.id ?? undefined,
        inline: disposition === 'inline',
      });
    }

    if (n.childNodes) {
      for (const child of n.childNodes) visit(child);
    }
  };

  visit(node);
  return out;
}

function countAttachments(node: MessageStructureObject | undefined): number {
  return collectAttachmentMetas(node).length;
}

function hasAttachments(node: MessageStructureObject | undefined): boolean {
  return countAttachments(node) > 0;
}

/** Decode a body-part Buffer using a permissive charset hint. */
function decodeBuffer(buf: Buffer, charset?: string): string {
  const cs = (charset ?? 'utf-8').toLowerCase();
  // Node Buffer supports utf-8, latin1, ascii, utf16le, etc. Map common aliases.
  const mapped =
    cs === 'utf-8' || cs === 'utf8' ? 'utf-8' :
    cs === 'iso-8859-1' || cs === 'latin1' ? 'latin1' :
    cs === 'us-ascii' || cs === 'ascii' ? 'ascii' :
    'utf-8';
  try {
    return buf.toString(mapped as BufferEncoding);
  } catch {
    return buf.toString('utf-8');
  }
}

/** Truncate to N characters at a word boundary, preserve no trailing whitespace. */
function snippet(text: string, max: number): string {
  const cleaned = text.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
  if (cleaned.length <= max) return cleaned;
  const cut = cleaned.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd();
}

/**
 * HTML → text for snippets and plain fallback extraction.
 *
 * Importantly this strips content-bearing elements that an adversary could
 * use to show the user one thing and the agent a different thing:
 *   • script, style, noscript, template, head, title
 *   • elements with display:none, visibility:hidden, font-size:0, opacity:0
 *   • HTML comments and CDATA (can hide injection payloads)
 *
 * The goal is defense against phishing mails that smuggle adversarial
 * content into the LLM context via hidden text.
 */
export function htmlToTextSnippet(html: string): string {
  return html
    // Remove hidden-style elements first — by far the biggest risk
    .replace(/<[^>]*\bstyle\s*=\s*"[^"]*display\s*:\s*none[^"]*"[^>]*>[\s\S]*?<\/[^>]+>/gi, '')
    .replace(/<[^>]*\bstyle\s*=\s*'[^']*display\s*:\s*none[^']*'[^>]*>[\s\S]*?<\/[^>]+>/gi, '')
    .replace(/<[^>]*\bstyle\s*=\s*"[^"]*visibility\s*:\s*hidden[^"]*"[^>]*>[\s\S]*?<\/[^>]+>/gi, '')
    .replace(/<[^>]*\bstyle\s*=\s*"[^"]*font-size\s*:\s*0[^"]*"[^>]*>[\s\S]*?<\/[^>]+>/gi, '')
    .replace(/<[^>]*\bstyle\s*=\s*"[^"]*opacity\s*:\s*0[^"]*"[^>]*>[\s\S]*?<\/[^>]+>/gi, '')
    // Content-bearing but non-visible elements
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<template[\s\S]*?<\/template>/gi, '')
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<title[\s\S]*?<\/title>/gi, '')
    // Comments and CDATA — never visible but can carry payloads
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '')
    // Block-element breaks before stripping remaining tags
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    // Strip any remaining tags
    .replace(/<[^>]+>/g, '')
    // Common entities
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n');
}

/**
 * Detect Auto-Submitted header indicating an automated message. Values other
 * than 'no' (the default per RFC 3834) signal auto-generation, so we must
 * never respond to prevent reply loops.
 */
export function isAutoSubmittedHeader(rawHeader: string | undefined): boolean {
  if (!rawHeader) return false;
  const value = rawHeader.toLowerCase().trim();
  if (value.length === 0) return false;
  // RFC 3834: Auto-Submitted: no  →  this is NOT automated (a human sent it)
  if (value.startsWith('no')) return false;
  // Anything else (auto-generated, auto-replied, auto-notified, ...) is automated
  return true;
}

function isAuthError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'AuthenticationFailure') return true;
  // imapflow sets authenticationFailed on the error object
  if ('authenticationFailed' in err && (err as unknown as Record<string, unknown>).authenticationFailed) return true;
  // imapflow responseStatus / responseText carry the IMAP response code
  const resp = String((err as unknown as Record<string, unknown>).responseText ?? '').toLowerCase();
  if (resp.includes('authenticationfailed') || resp.includes('authenticate')) return true;
  const msg = err.message.toLowerCase();
  return msg.includes('authentication') || msg.includes('invalid credentials') || msg.includes('login failed') || msg.includes('login');
}

function wrapImapError(err: unknown, fallback: string): MailError {
  if (err instanceof MailError) return err;
  if (isAuthError(err)) return new MailError('auth_failed', 'IMAP authentication failed', { cause: err });
  if (err instanceof Error && err.message.toLowerCase().includes('timeout')) {
    return new MailError('timeout', `${fallback}: timeout`, { cause: err });
  }
  if (err instanceof Error && err.message.toLowerCase().includes('certificate')) {
    return new MailError('tls_failed', `${fallback}: TLS verification failed`, { cause: err });
  }
  return new MailError('connection_failed', `${fallback}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
}

// ── Provider ───────────────────────────────────────────────────────────────

export class ImapSmtpProvider implements MailProvider {
  readonly accountId: string;

  private readonly account: MailAccountConfig;
  private readonly resolveCredentials: CredentialsResolver;
  private readonly tlsRejectUnauthorized: boolean;

  private client: ImapFlow | null = null;
  private connecting: Promise<ImapFlow> | null = null;
  private smtpTransport: Transporter | null = null;
  private closed = false;

  constructor(account: MailAccountConfig, resolveCredentials: CredentialsResolver, options?: ImapSmtpProviderOptions) {
    this.accountId = account.id;
    this.account = account;
    this.resolveCredentials = resolveCredentials;
    this.tlsRejectUnauthorized = !options?.insecureTls;
  }

  // ── Connection management ────────────────────────────────────────────────

  private async getClient(): Promise<ImapFlow> {
    if (this.closed) throw new MailError('connection_failed', 'Provider closed');
    if (this.client && this.client.usable) return this.client;
    if (this.connecting) return this.connecting;

    this.connecting = this.connectWithBackoff();
    try {
      this.client = await this.connecting;
      return this.client;
    } finally {
      this.connecting = null;
    }
  }

  private async connectWithBackoff(): Promise<ImapFlow> {
    let attempt = 0;
    let delay = RECONNECT_BACKOFF_INITIAL_MS;
    let lastErr: unknown;

    while (attempt < RECONNECT_MAX_ATTEMPTS) {
      attempt++;
      try {
        const creds = await this.resolveCredentials();
        const client = new ImapFlow({
          host: this.account.imap.host,
          port: this.account.imap.port,
          secure: this.account.imap.secure,
          auth: { user: creds.user, pass: creds.pass },
          logger: false,
          connectionTimeout: CONNECT_TIMEOUT_MS,
          greetingTimeout: GREETING_TIMEOUT_MS,
          socketTimeout: SOCKET_TIMEOUT_MS,
          tls: { rejectUnauthorized: this.tlsRejectUnauthorized, minVersion: 'TLSv1.2' },
          clientInfo: { name: 'lynox-mail', version: '0.1.0' },
          disableAutoIdle: true,
        });

        client.on('error', () => {
          // Mark client unusable on socket error so next call reconnects.
          if (this.client === client) this.client = null;
        });
        client.on('close', () => {
          if (this.client === client) this.client = null;
        });

        await client.connect();
        return client;
      } catch (err) {
        lastErr = err;
        if (isAuthError(err)) {
          // No point retrying auth failures.
          throw wrapImapError(err, 'IMAP connect');
        }
        if (attempt >= RECONNECT_MAX_ATTEMPTS) break;
        await sleep(delay);
        delay = Math.min(delay * 2, RECONNECT_BACKOFF_MAX_MS);
      }
    }

    throw wrapImapError(lastErr, 'IMAP connect');
  }

  private getSmtpTransport(creds: MailCredentials): Transporter {
    if (this.smtpTransport) return this.smtpTransport;

    this.smtpTransport = nodemailer.createTransport({
      host: this.account.smtp.host,
      port: this.account.smtp.port,
      secure: this.account.smtp.secure,
      auth: { user: creds.user, pass: creds.pass },
      requireTLS: !this.account.smtp.secure,
      tls: { rejectUnauthorized: this.tlsRejectUnauthorized, minVersion: 'TLSv1.2' },
      connectionTimeout: CONNECT_TIMEOUT_MS,
      greetingTimeout: GREETING_TIMEOUT_MS,
      socketTimeout: SOCKET_TIMEOUT_MS,
    });
    return this.smtpTransport;
  }

  // ── list ────────────────────────────────────────────────────────────────

  async list(opts: MailListOptions = {}): Promise<ReadonlyArray<MailEnvelope>> {
    const folder = opts.folder ?? 'INBOX';
    const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_LIST_LIMIT, DEFAULT_LIST_LIMIT));
    const client = await this.getClient();

    const lock = await client.getMailboxLock(folder).catch((err: unknown) => {
      throw wrapImapError(err, `IMAP open ${folder}`);
    });

    try {
      const search: SearchObject = {};
      if (opts.since) search.since = opts.since;
      if (opts.unseenOnly) search.seen = false;
      if (Object.keys(search).length === 0) search.all = true;

      const uids = await client.search(search, { uid: true });
      if (uids === false || uids.length === 0) return [];

      // Take the most recent N (search returns ascending)
      const slice = uids.slice(-limit);

      const envelopes: MailEnvelope[] = [];
      for await (const msg of client.fetch(
        slice,
        {
          uid: true,
          envelope: true,
          flags: true,
          internalDate: true,
          size: true,
          bodyStructure: true,
          bodyParts: [{ key: '1', maxLength: SNIPPET_BYTES }],
        },
        { uid: true },
      )) {
        envelopes.push(this.buildEnvelope(folder, msg));
      }

      // Most-recent-first
      envelopes.sort((a, b) => b.date.getTime() - a.date.getTime());
      return envelopes;
    } catch (err) {
      throw wrapImapError(err, `IMAP list ${folder}`);
    } finally {
      lock.release();
    }
  }

  // ── fetch ───────────────────────────────────────────────────────────────

  async fetch(opts: MailFetchOptions): Promise<MailMessage> {
    const folder = opts.folder ?? 'INBOX';
    const client = await this.getClient();
    const lock = await client.getMailboxLock(folder).catch((err: unknown) => {
      throw wrapImapError(err, `IMAP open ${folder}`);
    });

    try {
      const msg = await client.fetchOne(
        String(opts.uid),
        {
          uid: true,
          envelope: true,
          flags: true,
          internalDate: true,
          size: true,
          bodyStructure: true,
          headers: ['in-reply-to', 'references', 'auto-submitted'],
        },
        { uid: true },
      );

      if (!msg) throw new MailError('not_found', `Message uid=${String(opts.uid)} not found in ${folder}`);

      const envelope = this.buildEnvelope(folder, msg);

      const textPart = findTextPart(msg.bodyStructure, 'text/plain');
      const htmlPart = findTextPart(msg.bodyStructure, 'text/html');
      // Single-part messages have no childNodes — IMAP section is BODY[TEXT], not BODY[1].
      const isMultipart = (msg.bodyStructure?.childNodes?.length ?? 0) > 0;

      let text = '';
      if (textPart) {
        const partId = isMultipart ? (textPart.part ?? '1') : 'TEXT';
        text = await this.downloadPartAsText(client, opts.uid, partId);
      } else if (htmlPart) {
        const partId = isMultipart ? (htmlPart.part ?? '1') : 'TEXT';
        const html = await this.downloadPartAsText(client, opts.uid, partId);
        text = htmlToTextSnippet(html);
      }

      let html: string | undefined;
      if (opts.includeHtml && htmlPart) {
        const partId = isMultipart ? (htmlPart.part ?? '1') : 'TEXT';
        html = await this.downloadPartAsText(client, opts.uid, partId);
      }

      const headers = msg.headers ? parseHeaders(msg.headers.toString('utf-8')) : new Map<string, string>();

      return {
        envelope,
        text,
        html,
        attachments: collectAttachmentMetas(msg.bodyStructure),
        inReplyTo: msg.envelope?.inReplyTo ?? headers.get('in-reply-to'),
        references: headers.get('references'),
      };
    } catch (err) {
      throw wrapImapError(err, `IMAP fetch uid=${String(opts.uid)}`);
    } finally {
      lock.release();
    }
  }

  private async downloadPartAsText(client: ImapFlow, uid: number, partId: string): Promise<string> {
    // Use fetch() with explicit bodyParts rather than downloadMany() — downloadMany
    // also requests BODY[<part>.MIME] which fails on single-part messages because
    // there is no per-part MIME header section to read.
    //
    // imapflow normalizes bodyParts keys to lowercase internally (see imap-flow.js
    // ~line 3018), so the Map is keyed by the lowercased identifier.
    //
    // We cap via maxLength at the fetch-request level to keep memory bounded
    // on pathological HTML bombs. The cap is silent — callers get a trimmed
    // body with a trailing marker so they know truncation happened.
    const key = partId.toLowerCase();
    for await (const msg of client.fetch(
      String(uid),
      { uid: true, bodyParts: [{ key, maxLength: MAX_BODY_BYTES }] },
      { uid: true },
    )) {
      const buf = msg.bodyParts?.get(key);
      if (buf && buf.length > 0) {
        const text = decodeBuffer(buf, undefined);
        if (buf.length >= MAX_BODY_BYTES) {
          return `${text}\n\n[… body truncated at ${String(MAX_BODY_BYTES)} bytes for safety]`;
        }
        return text;
      }
    }
    return '';
  }

  // ── search ──────────────────────────────────────────────────────────────

  async search(query: MailSearchQuery, opts: MailSearchOptions = {}): Promise<ReadonlyArray<MailEnvelope>> {
    const folder = opts.folder ?? 'INBOX';
    const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_SEARCH_LIMIT, DEFAULT_SEARCH_LIMIT));
    const client = await this.getClient();
    const lock = await client.getMailboxLock(folder).catch((err: unknown) => {
      throw wrapImapError(err, `IMAP open ${folder}`);
    });

    try {
      const search: SearchObject = {};
      if (query.text) search.text = query.text;
      if (query.from) search.from = query.from;
      if (query.to) search.to = query.to;
      if (query.subject) search.subject = query.subject;
      if (query.since) search.since = query.since;
      if (query.before) search.before = query.before;
      if (query.unseen) search.seen = false;
      if (query.flagged) search.flagged = true;
      if (Object.keys(search).length === 0) search.all = true;

      const uids = await client.search(search, { uid: true });
      if (uids === false || uids.length === 0) return [];

      const slice = uids.slice(-limit);

      const envelopes: MailEnvelope[] = [];
      for await (const msg of client.fetch(
        slice,
        {
          uid: true,
          envelope: true,
          flags: true,
          internalDate: true,
          size: true,
          bodyStructure: true,
          bodyParts: [{ key: '1', maxLength: SNIPPET_BYTES }],
        },
        { uid: true },
      )) {
        const envelope = this.buildEnvelope(folder, msg);
        if (query.hasAttachment && !envelope.hasAttachments) continue;
        envelopes.push(envelope);
      }

      envelopes.sort((a, b) => b.date.getTime() - a.date.getTime());
      return envelopes;
    } catch (err) {
      throw wrapImapError(err, `IMAP search ${folder}`);
    } finally {
      lock.release();
    }
  }

  // ── send ────────────────────────────────────────────────────────────────

  async send(input: MailSendInput): Promise<MailSendResult> {
    if (this.closed) throw new MailError('connection_failed', 'Provider closed');
    let creds: MailCredentials;
    try {
      creds = await this.resolveCredentials();
    } catch (err) {
      throw new MailError('auth_failed', 'Could not resolve mail credentials', { cause: err });
    }

    const transport = this.getSmtpTransport(creds);

    try {
      const result = await transport.sendMail({
        from: { name: this.account.displayName, address: this.account.address },
        to: input.to.map(addressToString),
        cc: input.cc?.map(addressToString),
        bcc: input.bcc?.map(addressToString),
        replyTo: input.replyTo ? addressToString(input.replyTo) : undefined,
        subject: input.subject,
        text: input.text,
        html: input.html,
        inReplyTo: input.inReplyTo,
        references: input.references,
        attachments: input.attachments?.map(a => ({
          filename: a.filename,
          content: Buffer.from(a.content),
          contentType: a.contentType,
        })),
      });

      return {
        messageId: result.messageId ?? '',
        accepted: (result.accepted ?? []).map(addrToPlain),
        rejected: (result.rejected ?? []).map(addrToPlain),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isAuthError(err)) throw new MailError('auth_failed', 'SMTP authentication failed', { cause: err });
      if (message.toLowerCase().includes('timeout')) throw new MailError('timeout', 'SMTP timeout', { cause: err });
      if (message.toLowerCase().includes('certificate')) throw new MailError('tls_failed', 'SMTP TLS verification failed', { cause: err });
      throw new MailError('send_rejected', `SMTP send failed: ${message}`, { cause: err });
    }
  }

  // ── watch ───────────────────────────────────────────────────────────────

  async watch(opts: MailWatchOptions, handler: MailWatchHandler): Promise<MailWatchHandle> {
    const folder = opts.folder ?? 'INBOX';
    const intervalMs = Math.max(30_000, opts.intervalMs ?? DEFAULT_WATCH_INTERVAL_MS);
    const maxPerTick = Math.max(1, opts.maxPerTick ?? DEFAULT_WATCH_MAX_PER_TICK);

    let lastPolledAt = new Date();
    let stopped = false;
    let ticking = false;

    const tick = async (): Promise<void> => {
      if (stopped || ticking || this.closed) return;
      ticking = true;
      try {
        const since = new Date(lastPolledAt.getTime() - 60_000); // 1-minute overlap to ride IMAP date granularity
        lastPolledAt = new Date();
        const envelopes = await this.list({ folder, since, limit: maxPerTick });
        if (envelopes.length === 0) return;
        const event: MailWatchEvent = { type: 'new', envelopes };
        await handler(event);
      } catch (err) {
        const event: MailWatchEvent = { type: 'error', error: err instanceof Error ? err : new Error(String(err)) };
        try { await handler(event); } catch { /* swallow handler errors */ }
      } finally {
        ticking = false;
      }
    };

    const timer = setInterval(() => { void tick(); }, intervalMs);
    timer.unref();

    return {
      stop: async (): Promise<void> => {
        stopped = true;
        clearInterval(timer);
      },
    };
  }

  // ── close ───────────────────────────────────────────────────────────────

  async close(): Promise<void> {
    this.closed = true;
    if (this.client) {
      try {
        await this.client.logout();
      } catch {
        try { this.client.close(); } catch { /* ignore */ }
      }
      this.client = null;
    }
    if (this.smtpTransport) {
      try { this.smtpTransport.close(); } catch { /* ignore */ }
      this.smtpTransport = null;
    }
  }

  // ── envelope construction ──────────────────────────────────────────────

  private buildEnvelope(folder: string, msg: FetchMessageObject): MailEnvelope {
    const env = msg.envelope;
    const internal = msg.internalDate;
    const date =
      env?.date instanceof Date ? env.date :
      internal instanceof Date ? internal :
      typeof internal === 'string' ? new Date(internal) :
      new Date(0);

    // Extract snippet from BODYPART '1' if requested in the fetch
    let snippetText = '';
    const partBuf = msg.bodyParts?.get('1');
    if (partBuf) {
      const decoded = decodeBuffer(partBuf, undefined);
      // If the part was actually HTML (e.g. message has only text/html as part 1),
      // strip it down before snippeting.
      const looksHtml = /<[a-z!/][\s\S]*?>/i.test(decoded.slice(0, 200));
      snippetText = snippet(looksHtml ? htmlToTextSnippet(decoded) : decoded, SNIPPET_CHARS);
    }

    // Auto-Submitted header detection — must never auto-reply to these
    const headers = msg.headers ? parseHeaders(msg.headers.toString('utf-8')) : new Map<string, string>();
    const isAutoReply = isAutoSubmittedHeader(headers.get('auto-submitted'));

    return {
      uid: msg.uid,
      messageId: env?.messageId,
      folder,
      threadKey: msg.threadId ?? env?.messageId,
      inReplyTo: env?.inReplyTo,
      from: toAddresses(env?.from),
      to: toAddresses(env?.to),
      cc: toAddresses(env?.cc),
      replyTo: toAddresses(env?.replyTo),
      subject: env?.subject ?? '',
      date,
      flags: toFlags(msg.flags),
      snippet: snippetText,
      hasAttachments: hasAttachments(msg.bodyStructure),
      attachmentCount: countAttachments(msg.bodyStructure),
      sizeBytes: msg.size,
      isAutoReply,
    };
  }
}

// ── small utils kept private to this file ─────────────────────────────────

function addressToString(a: MailAddress): string {
  return a.name ? `"${a.name.replace(/"/g, '\\"')}" <${a.address}>` : a.address;
}

function addrToPlain(a: string | { address?: string }): string {
  if (typeof a === 'string') return a;
  return a.address ?? '';
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms).unref(); });
}

function parseHeaders(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key && value) out.set(key, value);
  }
  return out;
}
