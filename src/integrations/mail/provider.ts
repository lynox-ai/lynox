// === Provider-agnostic mail integration — public contract ===
//
// All mail backends (imap-smtp base, presets, future Microsoft OAuth) implement
// the MailProvider interface. The agent and the rest of the engine never see
// which backend is in use — only this contract.

// ── Address ────────────────────────────────────────────────────────────────

export interface MailAddress {
  name?: string | undefined;
  address: string;
}

// ── Flags ──────────────────────────────────────────────────────────────────
//
// Standard IMAP system flags use the backslash prefix (e.g. '\\Seen').
// Custom keywords (e.g. '$lynox-processed') are passed through as-is.
export type MailFlag =
  | '\\Seen'
  | '\\Answered'
  | '\\Flagged'
  | '\\Deleted'
  | '\\Draft'
  | '\\Recent'
  | string;

// ── Envelope (lightweight summary) ─────────────────────────────────────────
//
// The shape returned by list/search. Built from IMAP ENVELOPE + BODYSTRUCTURE
// + a 500-char text snippet — no full body fetch. Token cost: ~100 tokens.
//
// Token-Efficient Fetching (PRD): triage and search calls return arrays of
// MailEnvelope, never full MailMessage. Only mail_read fetches MailMessage.

export interface MailEnvelope {
  /** Stable per-account UID (IMAP UIDVALIDITY-scoped). */
  uid: number;
  /** RFC 5322 Message-ID header value, if present. Primary dedup key. */
  messageId: string | undefined;
  /** Folder this envelope was fetched from (e.g. 'INBOX'). */
  folder: string;
  /** Thread grouping key — In-Reply-To/References-derived, may equal messageId. */
  threadKey: string | undefined;
  /** In-Reply-To header — the immediate parent message-id, if this is a reply. */
  inReplyTo: string | undefined;
  from: MailAddress[];
  to: MailAddress[];
  cc: MailAddress[];
  /** Reply-To header, if different from From. */
  replyTo: MailAddress[];
  subject: string;
  date: Date;
  flags: ReadonlyArray<MailFlag>;
  /** Up to 500 chars of cleaned text/plain body, or empty string if none. */
  snippet: string;
  /** True if BODYSTRUCTURE indicates at least one non-text attachment part. */
  hasAttachments: boolean;
  /** Number of attachments (best-effort from BODYSTRUCTURE). */
  attachmentCount: number;
  /** Total RFC822 size in bytes, if reported. */
  sizeBytes: number | undefined;
  /**
   * True if Auto-Submitted header indicates this is an auto-generated or
   * auto-replied message. The agent must NEVER auto-reply to such messages
   * to prevent reply loops with autoresponders.
   */
  isAutoReply: boolean;
}

// ── Attachment metadata ────────────────────────────────────────────────────
//
// Returned with full message reads. Content is NOT fetched here — agents must
// call mail_attachment_get explicitly (PRD security requirement).

export interface MailAttachmentMeta {
  /** IMAP part identifier (e.g. '2.1') for later content fetch. */
  partId: string;
  filename: string | undefined;
  contentType: string;
  /** Declared size in bytes. */
  sizeBytes: number;
  /** Content-ID header, used for inline references. */
  contentId: string | undefined;
  /** True if the part is marked inline rather than attached. */
  inline: boolean;
}

// ── Full message (returned only by fetch) ──────────────────────────────────

export interface MailMessage {
  envelope: MailEnvelope;
  /** Cleaned text/plain body. May be derived from text/html if no plain part. */
  text: string;
  /**
   * Raw text/html body, if present and explicitly requested via
   * MailFetchOptions.includeHtml. Otherwise undefined to keep token cost low.
   */
  html: string | undefined;
  attachments: ReadonlyArray<MailAttachmentMeta>;
  /** In-Reply-To header, used by reply tool for thread continuation. */
  inReplyTo: string | undefined;
  /** References header (space-separated message-ids). */
  references: string | undefined;
}

// ── Operation inputs ───────────────────────────────────────────────────────

export interface MailListOptions {
  /** Default 'INBOX'. */
  folder?: string | undefined;
  /** Only return messages received at or after this instant. */
  since?: Date | undefined;
  /** Only return UNSEEN messages. Default false. */
  unseenOnly?: boolean | undefined;
  /** Max messages to fetch. Provider must honour and may impose its own cap. */
  limit?: number | undefined;
}

export interface MailFetchOptions {
  /** Default 'INBOX'. */
  folder?: string | undefined;
  /** UID returned previously via list/search. */
  uid: number;
  /** Include raw text/html body alongside cleaned text. Default false. */
  includeHtml?: boolean | undefined;
}

export interface MailSearchQuery {
  /** Free-text terms applied to subject + from. */
  text?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  subject?: string | undefined;
  /** Lower bound on date (inclusive). */
  since?: Date | undefined;
  /** Upper bound on date (exclusive). */
  before?: Date | undefined;
  /** Only unseen messages. */
  unseen?: boolean | undefined;
  /** Only flagged messages. */
  flagged?: boolean | undefined;
  /** Only messages with at least one attachment. */
  hasAttachment?: boolean | undefined;
}

export interface MailSearchOptions {
  folder?: string | undefined;
  limit?: number | undefined;
}

export interface MailSendAttachment {
  filename: string;
  contentType: string;
  /** Raw bytes. */
  content: Uint8Array;
}

export interface MailSendInput {
  to: MailAddress[];
  cc?: MailAddress[] | undefined;
  bcc?: MailAddress[] | undefined;
  replyTo?: MailAddress | undefined;
  subject: string;
  /** Plain-text body. Always required — html is optional. */
  text: string;
  html?: string | undefined;
  /** Set when this send is a reply — fills In-Reply-To header. */
  inReplyTo?: string | undefined;
  /** Set when this send is a reply — fills References header. */
  references?: string | undefined;
  attachments?: ReadonlyArray<MailSendAttachment> | undefined;
}

export interface MailSendResult {
  /** Message-ID assigned by the SMTP server (or generated locally). */
  messageId: string;
  accepted: ReadonlyArray<string>;
  rejected: ReadonlyArray<string>;
}

// ── Watch (Phase 0: polling) ───────────────────────────────────────────────

export interface MailWatchOptions {
  folder?: string | undefined;
  /** Polling interval in milliseconds. Default 120_000 (2 min) per PRD. */
  intervalMs?: number | undefined;
  /** Cap per tick. Default 50. */
  maxPerTick?: number | undefined;
}

export type MailWatchEvent =
  | { type: 'new'; envelopes: ReadonlyArray<MailEnvelope> }
  | { type: 'error'; error: Error };

export type MailWatchHandler = (event: MailWatchEvent) => void | Promise<void>;

export interface MailWatchHandle {
  stop(): Promise<void>;
}

// ── Provider contract ──────────────────────────────────────────────────────

/**
 * Auth/transport flavor of a configured mailbox.
 *
 * - `imap`            — IMAP/SMTP with app-password credentials
 * - `oauth_google`    — Gmail API via Google OAuth tokens (Phase 1b)
 * - `oauth_microsoft` — Microsoft Graph via Microsoft OAuth tokens (Phase 1b+)
 *
 * Lives on both `MailAccountConfig.authType` and `MailProvider.authType` so
 * callers can branch on it without inspecting the concrete provider class.
 */
export type MailAuthType = 'imap' | 'oauth_google' | 'oauth_microsoft';

export const ALL_AUTH_TYPES: ReadonlyArray<MailAuthType> = ['imap', 'oauth_google', 'oauth_microsoft'];

export function isValidAuthType(value: unknown): value is MailAuthType {
  return typeof value === 'string' && (ALL_AUTH_TYPES as ReadonlyArray<string>).includes(value);
}

export interface MailProvider {
  /** Stable identifier for this provider instance (account id). */
  readonly accountId: string;

  /** Auth/transport flavor of this provider. */
  readonly authType: MailAuthType;

  /** Lightweight envelope listing — never fetches full bodies. */
  list(opts?: MailListOptions): Promise<ReadonlyArray<MailEnvelope>>;

  /** Full message fetch — text body cleaned via body-clean helper. */
  fetch(opts: MailFetchOptions): Promise<MailMessage>;

  /** IMAP SEARCH with envelope-only result shape. */
  search(query: MailSearchQuery, opts?: MailSearchOptions): Promise<ReadonlyArray<MailEnvelope>>;

  /** Send a message via SMTP. Behind Permission-Guard at the tool layer. */
  send(input: MailSendInput): Promise<MailSendResult>;

  /** Start a polling watcher. Provider may override interval if it can't honour the requested cadence. */
  watch(opts: MailWatchOptions, handler: MailWatchHandler): Promise<MailWatchHandle>;

  /** Release IMAP connection pool, SMTP transport, timers. Idempotent. */
  close(): Promise<void>;
}

// ── Account configuration ──────────────────────────────────────────────────

export interface MailServerConfig {
  host: string;
  port: number;
  /** True for implicit TLS (SMTPS:465, IMAPS:993). False for STARTTLS upgrade. */
  secure: boolean;
}

/**
 * Stored, non-secret account configuration. Credentials are resolved at
 * connection time via the SecretStore — never stored on this object.
 *
 * `authType` selects which provider implementation hydrates this row:
 *   - `imap`            → ImapSmtpProvider, requires `imap` + `smtp` fields
 *   - `oauth_google`    → OAuthGmailProvider, requires `oauthProviderKey`
 *   - `oauth_microsoft` → OAuthMicrosoftProvider (future), requires `oauthProviderKey`
 */
export interface MailAccountConfig {
  /** Stable id, e.g. 'rafael-gmail'. Used as the SecretStore key prefix. */
  id: string;
  /** Human label for UI. */
  displayName: string;
  /** Primary mailbox address — also the SMTP envelope From. */
  address: string;
  /** Preset slug for telemetry and onboarding context (e.g. 'gmail'). */
  preset: MailPresetSlug;
  /** IMAP server config — required when `authType === 'imap'`, ignored otherwise. */
  imap: MailServerConfig;
  /** SMTP server config — required when `authType === 'imap'`, ignored otherwise. */
  smtp: MailServerConfig;
  /** Auth/transport flavor — see {@link MailAuthType}. */
  authType: MailAuthType;
  /**
   * Pointer to the vault key holding OAuth tokens for this account. Required
   * when `authType` starts with `oauth_`. For `imap` accounts, leave undefined —
   * IMAP credentials are resolved separately via the credential store.
   */
  oauthProviderKey?: string | undefined;
  /**
   * Semantic role of this mailbox. Drives agent behavior, tone, auto-reply
   * policy, and the receive-only hard block for compliance addresses.
   * Default: 'personal'.
   */
  type: MailAccountType;
  /**
   * Optional custom tone/persona instruction injected into compose flows.
   * When unset, the agent uses the default persona derived from `type`.
   */
  personaPrompt?: string | undefined;
}

export type MailPresetSlug =
  | 'gmail'
  | 'icloud'
  | 'fastmail'
  | 'yahoo'
  | 'outlook'
  | 'custom';

// ── Account types ─────────────────────────────────────────────────────────
//
// The account type classifies the semantic role of a mailbox. It shapes:
//   • tone / persona defaults used when composing
//   • prefilter aggressiveness during triage
//   • whether sending is allowed at all (compliance addresses are read-only)
//   • what the agent should escalate vs. handle autonomously
//
// Four coarse groups:
//   owned       — personal, business — full agent capability, user owns the voice
//   service     — support, sales, hello — customer-facing, draft-first, templates
//   bulk        — info, newsletter, notifications — high noise, receive-only
//   compliance  — abuse, privacy, security, legal — hard receive-only, escalate

export type MailAccountType =
  | 'personal'
  | 'business'
  | 'support'
  | 'sales'
  | 'hello'
  | 'info'
  | 'newsletter'
  | 'notifications'
  | 'abuse'
  | 'privacy'
  | 'security'
  | 'legal';

export const ALL_ACCOUNT_TYPES: ReadonlyArray<MailAccountType> = [
  'personal',
  'business',
  'support',
  'sales',
  'hello',
  'info',
  'newsletter',
  'notifications',
  'abuse',
  'privacy',
  'security',
  'legal',
];

/**
 * Types that MUST NOT send. The tool layer enforces this as a hard block —
 * not confirm-overrideable, not pre-approvable, independent of autonomy level.
 *
 * Bulk types (info/newsletter/notifications) are receive-only because
 * auto-responding to bulk senders creates spam loops. Compliance types
 * (abuse/privacy/security/legal) are receive-only because those channels
 * require a human in the loop by policy.
 */
const RECEIVE_ONLY_TYPES: ReadonlySet<MailAccountType> = new Set([
  'info',
  'newsletter',
  'notifications',
  'abuse',
  'privacy',
  'security',
  'legal',
]);

export function isReceiveOnlyType(type: MailAccountType): boolean {
  return RECEIVE_ONLY_TYPES.has(type);
}

export function isValidAccountType(value: unknown): value is MailAccountType {
  return typeof value === 'string' && (ALL_ACCOUNT_TYPES as ReadonlyArray<string>).includes(value);
}

/**
 * Default persona instruction per type. Used when the user hasn't set a
 * custom persona. Written in neutral English — the agent can translate to
 * the user's working language at compose time.
 */
const DEFAULT_PERSONAS: Record<MailAccountType, string> = {
  personal:      'Casual, warm, first-person. Sign with the user\'s first name only. Short paragraphs.',
  business:      'Professional, confident, direct. Full sign-off with role if known. Draft-first — never auto-send.',
  support:       'Short, polite, action-oriented. Acknowledge the issue in one sentence, state next steps, provide a reference. Use templates when possible. Draft-first always.',
  sales:         'Warm professional, benefit-led, no pressure. Reference past touchpoints from CRM when known. Draft-first.',
  hello:         'Friendly and brief. First contact with prospects — short, inviting, always ask one question.',
  info:          '(receive-only)',
  newsletter:    '(receive-only)',
  notifications: '(receive-only)',
  abuse:         '(receive-only — escalate every message to the user, never respond)',
  privacy:       '(receive-only — escalate every message to the user, never respond)',
  security:      '(receive-only — escalate every message to the user, never respond)',
  legal:         '(receive-only — escalate every message to the user, never respond)',
};

export function defaultPersonaFor(type: MailAccountType): string {
  return DEFAULT_PERSONAS[type];
}

/**
 * Resolve the persona to use for composing — custom override if present,
 * otherwise the type default. For receive-only types, returns the receive-only
 * marker (callers should never reach compose for these).
 */
export function personaFor(account: MailAccountConfig): string {
  if (account.personaPrompt && account.personaPrompt.trim()) return account.personaPrompt.trim();
  return defaultPersonaFor(account.type);
}

// ── Errors ─────────────────────────────────────────────────────────────────
//
// Narrow, typed errors so the tool layer can map to user-facing messages
// without leaking provider internals.

export type MailErrorCode =
  | 'auth_failed'
  | 'connection_failed'
  | 'tls_failed'
  | 'not_found'
  | 'send_rejected'
  | 'rate_limited'
  | 'timeout'
  | 'unsupported'
  | 'unknown';

export class MailError extends Error {
  readonly code: MailErrorCode;
  constructor(code: MailErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MailError';
    this.code = code;
  }
}
