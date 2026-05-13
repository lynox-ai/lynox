// === Mail send-core — shared SMTP send pipeline ===
//
// Single source of truth for outbound mail. Encapsulates everything
// `mail_send` (and the inbox-reply HTTP handler, and any future
// outbound caller) does between input parsing and the final
// `provider.send()` call:
//
//   1. Rate-limit gate         (cross-session, configurable cap)
//   2. Receive-only block      (compliance/bulk mailboxes are read-only)
//   3. Recipient address parse + count validation
//   4. Recipient-dedup window  (catches retry storms)
//   5. Mass-send recipient check (caller decides what to do above N)
//   6. Secret-in-content scan  (no Bearer tokens / API keys outbound)
//   7. `provider.send()`
//   8. Dedup record (only on success — failed sends can legitimately retry)
//   9. Optional follow-up reminder + outbound hook
//
// Confirmation prompts are NOT in the core. The agent-tool wrapper
// calls `agent.promptUser()` between mass-send detection and
// provider.send; the inbox-reply HTTP handler treats the explicit user
// click as the confirmation and skips the prompt.

import {
  MailError,
  isReceiveOnlyType,
  personaFor,
  type MailAccountConfig,
  type MailAddress,
  type MailSendInput,
  type MailSendResult,
} from './provider.js';
import type { MailContext } from './context.js';
import type { MailProvider } from './provider.js';
import type { SentMailLogInput } from './state.js';
import { resolveProvider, type MailRegistry } from './tools/registry.js';
import {
  checkMailRateLimit,
  checkRecipientDedup,
  recordMailSend,
} from './tools/rate-limit.js';

/**
 * Recipient count above which callers should force explicit confirmation
 * with the full list — anti-blast safety net from the PRD ("Never auto-
 * send to >5 recipients without explicit user approval"). Exported so
 * the agent-tool wrapper can switch confirmation UI shape on it.
 */
export const MASS_SEND_THRESHOLD = 5;

export interface SendCoreInput {
  /** Account id; omit to use the registry default. */
  account?: string | undefined;
  /** Already-parsed `to` list. The agent-tool wrapper parses from CSV strings. */
  to: ReadonlyArray<MailAddress>;
  cc?: ReadonlyArray<MailAddress> | undefined;
  bcc?: ReadonlyArray<MailAddress> | undefined;
  subject: string;
  body: string;
  /** Optional In-Reply-To header — inbox replies set this from the original Message-ID. */
  inReplyTo?: string | undefined;
  /** Optional References header — chain previous messages for proper threading. */
  references?: string | undefined;
}

export interface SendCoreFollowup {
  reminder_in_days: number;
  reason: string;
  type?: 'awaiting_reply' | 'user_deliverable' | 'custom' | undefined;
}

export interface SendCoreOptions {
  /** Pre-send confirmation hook — runs after all blocking gates pass. */
  beforeSend?: ((ctx: SendCoreBeforeSendCtx) => Promise<boolean>) | undefined;
  /** Optional follow-up registration on success — passed through to MailContext. */
  trackFollowup?: SendCoreFollowup | undefined;
  /**
   * Skip the cross-session rate-limit gate. Inbox-reply skips it because
   * the user manually clicks once per draft — there is no agent loop to
   * rate-limit. Default false.
   */
  skipRateLimit?: boolean | undefined;
}

export interface SendCoreBeforeSendCtx {
  provider: MailProvider;
  accountConfig: MailAccountConfig | null;
  to: ReadonlyArray<MailAddress>;
  cc: ReadonlyArray<MailAddress>;
  bcc: ReadonlyArray<MailAddress>;
  subject: string;
  body: string;
  isMassSend: boolean;
  uniqueRecipientCount: number;
}

export type SendCoreResult =
  | { ok: true; result: MailSendResult; followupId: string | null }
  | { ok: false; status: SendCoreFailureStatus; message: string };

export type SendCoreFailureStatus =
  | 'rate_limit'
  | 'invalid_recipients'
  | 'receive_only'
  | 'dedup_window'
  | 'secret_in_body'
  | 'cancelled'
  | 'provider_error';

/**
 * The pipeline. Validation gates fire first; `beforeSend` runs after
 * mass-send detection and before the actual send. Discriminated
 * `{ok: false, status, message}` failures let the caller choose between
 * "show modal" (mass-send cancelled), "block with reason" (secret
 * detected), or "transient error" (provider raised).
 */
export async function sendMail(
  registry: MailRegistry,
  input: SendCoreInput,
  opts: SendCoreOptions = {},
  ctx?: MailContext,
): Promise<SendCoreResult> {
  if (!opts.skipRateLimit) {
    const rateBlock = checkMailRateLimit('mail_send');
    if (rateBlock) return { ok: false, status: 'rate_limit', message: rateBlock };
  }

  // Secret-in-content scan BEFORE provider lookup — cheaper to bail
  // and keeps the rejection reason at the body layer where it belongs.
  const { detectSecretInContent } = await import('../../tools/builtin/http.js');
  const secretMatch = detectSecretInContent(input.body);
  if (secretMatch) {
    return {
      ok: false,
      status: 'secret_in_body',
      message: `body contains a ${secretMatch}; refusing to send`,
    };
  }

  const provider = resolveProvider(registry, input.account);
  const accountConfig = ctx?.getAccountConfig(provider.accountId) ?? null;
  if (accountConfig && isReceiveOnlyType(accountConfig.type)) {
    return {
      ok: false,
      status: 'receive_only',
      message:
        `account "${provider.accountId}" has type "${accountConfig.type}" which is receive-only`,
    };
  }

  if (input.to.length === 0) {
    return { ok: false, status: 'invalid_recipients', message: 'no valid recipients' };
  }

  const cc = input.cc ?? [];
  const bcc = input.bcc ?? [];
  const allRecipients = [...input.to, ...cc, ...bcc];
  const dedupBlock = checkRecipientDedup(allRecipients, input.subject);
  if (dedupBlock) return { ok: false, status: 'dedup_window', message: dedupBlock };

  const uniqueRecipients = new Set<string>();
  for (const a of allRecipients) uniqueRecipients.add(a.address.toLowerCase());
  const isMassSend = uniqueRecipients.size > MASS_SEND_THRESHOLD;

  if (opts.beforeSend) {
    const approved = await opts.beforeSend({
      provider,
      accountConfig,
      to: input.to,
      cc,
      bcc,
      subject: input.subject,
      body: input.body,
      isMassSend,
      uniqueRecipientCount: uniqueRecipients.size,
    });
    if (!approved) return { ok: false, status: 'cancelled', message: 'send cancelled' };
  }

  const sendInput: MailSendInput = {
    to: [...input.to],
    subject: input.subject,
    text: input.body,
  };
  if (cc.length > 0) sendInput.cc = [...cc];
  if (bcc.length > 0) sendInput.bcc = [...bcc];
  if (input.inReplyTo !== undefined) sendInput.inReplyTo = input.inReplyTo;
  if (input.references !== undefined) sendInput.references = input.references;

  let result: MailSendResult;
  try {
    result = await provider.send(sendInput);
  } catch (err) {
    if (err instanceof MailError) {
      return { ok: false, status: 'provider_error', message: `${err.code}: ${err.message}` };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 'provider_error', message: msg };
  }

  // Dedup record + follow-up only on success — failed sends can
  // legitimately retry without hitting the window.
  recordMailSend(allRecipients, input.subject);

  let followupId: string | null = null;
  if (opts.trackFollowup && ctx) {
    const days = Number(opts.trackFollowup.reminder_in_days);
    if (Number.isFinite(days) && days > 0 && opts.trackFollowup.reason) {
      const reminderAt = new Date(Date.now() + days * 86_400_000);
      const primary = input.to[0]?.address ?? '';
      const messageId = result.messageId || `local-${String(Date.now())}`;
      try {
        followupId = ctx.stateDb.recordFollowup({
          accountId: provider.accountId,
          sentMessageId: messageId,
          threadKey: messageId,
          recipient: primary,
          type: opts.trackFollowup.type ?? 'awaiting_reply',
          reason: opts.trackFollowup.reason,
          reminderAt,
          source: 'agent',
        });
      } catch {
        // Follow-up registration failure must not fail the send itself.
        followupId = null;
      }
    }
  }

  // Persist outbound for the Mail-Context-Sidebar. Observational data —
  // a write failure must never roll back the user-visible send. Logged
  // at debug so persistent schema/permission breakage stays diagnosable
  // (silent swallow once cost us a week of missing sidebar history).
  if (ctx) {
    try {
      const sentLogInput: SentMailLogInput = {
        accountId: provider.accountId,
        messageId: result.messageId || `local-${String(Date.now())}`,
        to: input.to,
        cc,
        bcc,
        subject: input.subject,
        bodyChars: input.body.length,
      };
      if (input.inReplyTo !== undefined) sentLogInput.inReplyTo = input.inReplyTo;
      if (followupId !== null) sentLogInput.followupId = followupId;
      ctx.stateDb.recordSentMail(sentLogInput);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.debug(`[mail/send-core] recordSentMail failed: ${msg}`);
    }
  }

  return { ok: true, result, followupId };
}

/**
 * Build the agent-prompt preview text the tool wrapper shows to the
 * user. Kept in send-core so the inbox-pane (if it ever surfaces a
 * preview elsewhere) can render the same shape.
 */
export function buildSendPreview(ctx: SendCoreBeforeSendCtx): string {
  const personaLine = ctx.accountConfig
    ? `\n  Persona: ${truncate(personaFor(ctx.accountConfig), 160)}`
    : '';
  const bodyPreview = truncate(ctx.body.replace(/\s+/g, ' '), 200);
  if (ctx.isMassSend) {
    return (
      `⚠ **MASS SEND** — ${String(ctx.uniqueRecipientCount)} recipients\n\n` +
      `**Account:** ${ctx.provider.accountId}${personaLine ? `\n**Persona:** ${truncate(personaFor(ctx.accountConfig!), 120)}` : ''}\n` +
      `**Recipients:**\n${[...ctx.to, ...ctx.cc, ...ctx.bcc].map((a) => `  • ${a.address}`).join('\n')}\n` +
      `**Subject:** ${ctx.subject}\n\n` +
      `> ${bodyPreview}`
    );
  }
  return (
    `**Send email?**\n\n` +
    `**To:** ${ctx.to.map((a) => a.address).join(', ')}` +
    `${ctx.cc.length > 0 ? `\n**Cc:** ${ctx.cc.map((a) => a.address).join(', ')}` : ''}` +
    `${ctx.bcc.length > 0 ? `\n**Bcc:** ${ctx.bcc.map((a) => a.address).join(', ')}` : ''}\n` +
    `**Subject:** ${ctx.subject}\n` +
    `**From:** ${ctx.provider.accountId}${personaLine ? ` · _${truncate(personaFor(ctx.accountConfig!), 80)}_` : ''}\n\n` +
    `> ${bodyPreview}`
  );
}

/**
 * Parse a comma-separated recipient list into MailAddress objects.
 * Accepts `Name <addr@host>`, `"Name" <addr@host>`, or bare `addr@host`.
 */
export function parseAddressList(raw: string | undefined): MailAddress[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map(parseAddress)
    .filter((a): a is MailAddress => a !== null);
}

function parseAddress(raw: string): MailAddress | null {
  // Defense-in-depth header-injection guard: any CR/LF (or other ASCII
  // control char) in a recipient string lets an attacker append
  // synthetic SMTP headers (Bcc:, Subject:, body separator) when the
  // value reaches the wire. Most MTAs re-encode but we never want to
  // rely on that — drop any segment containing such bytes.
  if (/[\r\n -]/.test(raw)) return null;
  const angle = raw.match(/^\s*(?:"?([^"<]*?)"?\s*)?<([^>]+)>\s*$/);
  if (angle) {
    const name = angle[1]?.trim();
    const address = angle[2]?.trim();
    if (!address || !address.includes('@')) return null;
    return name ? { name, address } : { address };
  }
  if (raw.includes('@')) return { address: raw };
  return null;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}
