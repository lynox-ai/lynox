// === mail_send tool ===
//
// Send a brand-new message via SMTP. PERMISSION-GUARDED — both at the
// permission-guard layer (autonomous-mode block) AND inline via
// agent.promptUser() before the actual send.
//
// All non-prompt logic (rate-limit, dedup, secret scan, provider.send,
// follow-up registration) lives in `mail/send-core.ts` so the inbox
// HTTP handler can share the exact same outbound pipeline. This
// wrapper only adds the agent-driven confirmation step.

import type { IAgent, ToolEntry } from '../../../types/index.js';
import type { MailContext } from '../context.js';
import {
  buildSendPreview,
  parseAddressList,
  sendMail,
  type SendCoreInput,
  type SendCoreOptions,
} from '../send-core.js';
import type { MailRegistry } from './registry.js';

interface MailSendToolInput {
  account?: string | undefined;
  to: string;
  cc?: string | undefined;
  bcc?: string | undefined;
  subject: string;
  body: string;
  /**
   * Optional explicit follow-up tracking. When set, after a successful send
   * the tool registers a follow-up reminder. The watcher checks due reminders
   * each tick and fires MailHooks.onFollowupDue.
   *
   * Phase 0.2 is explicit-only — no LLM detection. Phase 1 may auto-populate
   * this based on outbound content classification.
   */
  track_followup?: {
    reminder_in_days: number;
    reason: string;
    type?: 'awaiting_reply' | 'user_deliverable' | 'custom' | undefined;
  } | undefined;
}

export function createMailSendTool(registry: MailRegistry, ctx?: MailContext): ToolEntry<MailSendToolInput> {
  return {
    definition: {
      name: 'mail_send',
      description:
        'Send a new email via SMTP. Requires user confirmation before delivery (both interactively and via the autonomy permission guard). Use mail_reply to respond to an existing thread — that path preserves In-Reply-To and References headers.',
      input_schema: {
        type: 'object' as const,
        properties: {
          account: { type: 'string', description: 'Account id. Omit to use the default account.' },
          to: { type: 'string', description: 'Recipient(s), comma-separated. Required.' },
          cc: { type: 'string', description: 'CC recipient(s), comma-separated.' },
          bcc: { type: 'string', description: 'BCC recipient(s), comma-separated.' },
          subject: { type: 'string', description: 'Email subject line. Required.' },
          body: { type: 'string', description: 'Plain-text body. Required.' },
          track_followup: {
            type: 'object',
            description: 'Optional: register a follow-up reminder after sending. The agent (or user) sets this explicitly when a response is expected or a deliverable is due.',
            properties: {
              reminder_in_days: { type: 'number', description: 'How many days until the reminder fires.' },
              reason: { type: 'string', description: 'Short human-readable reason (e.g. "awaiting contract", "deliver Q1 report").' },
              type: {
                type: 'string',
                enum: ['awaiting_reply', 'user_deliverable', 'custom'],
                description: 'awaiting_reply = counterparty should respond; user_deliverable = user commits to deliver; custom = anything else.',
              },
            },
            required: ['reminder_in_days', 'reason'],
          },
        },
        required: ['to', 'subject', 'body'],
      },
    },
    requiresConfirmation: true,
    redactInputForAudit: (input: MailSendToolInput) => {
      const { body: _body, ...rest } = input;
      return { ...rest, body_chars: typeof input.body === 'string' ? input.body.length : 0 };
    },
    handler: async (input: MailSendToolInput, agent: IAgent): Promise<string> => {
      if (!input.to) return 'mail_send error: "to" is required';
      if (!input.subject) return 'mail_send error: "subject" is required';
      if (!input.body) return 'mail_send error: "body" is required';

      // Fail-safe: refuse when no interactive prompt is available (autonomous
      // mode). The permission-guard already blocks mail_send there, but this
      // is the belt-and-braces — the send-core's `beforeSend` hook below
      // would throw otherwise.
      if (!agent.promptUser) {
        return 'mail_send error: sending requires interactive user confirmation, which is not available in this mode.';
      }
      const promptUser = agent.promptUser;

      const to = parseAddressList(input.to);
      const cc = parseAddressList(input.cc);
      const bcc = parseAddressList(input.bcc);

      const coreInput: SendCoreInput = { to, cc, bcc, subject: input.subject, body: input.body };
      if (input.account !== undefined) coreInput.account = input.account;

      const opts: SendCoreOptions = {
        beforeSend: async (sendCtx) => {
          const preview = buildSendPreview(sendCtx);
          const answer = await promptUser(preview, ['Yes', 'No']);
          return isApproval(answer);
        },
      };
      if (input.track_followup) opts.trackFollowup = input.track_followup;

      const result = await sendMail(registry, coreInput, opts, ctx);

      if (!result.ok) {
        switch (result.status) {
          case 'rate_limit':
            return result.message;
          case 'invalid_recipients':
            return 'mail_send error: "to" did not parse to any valid addresses';
          case 'receive_only':
            return `mail_send blocked: ${result.message}. ` +
              `Compliance (abuse/privacy/security/legal) and bulk (info/newsletter/notifications) mailboxes cannot send mail. ` +
              `Pick a different account via the "account" parameter.`;
          case 'dedup_window':
            return result.message;
          case 'secret_in_body':
            return `mail_send blocked: ${result.message}. Strip the credential and retry.`;
          case 'cancelled':
            // beforeSend returned false — user clicked No (or the answer
            // wasn't a positive token). Mass-send vs single-send is implicit
            // in the preview already.
            return 'mail_send cancelled by user.';
          case 'provider_error':
            return `mail_send error (${result.message})`;
        }
      }

      const followupNote = result.followupId
        ? `\nFollow-up registered: ${result.followupId}`
        : (input.track_followup ? '\n(follow-up registration failed — send itself succeeded)' : '');

      return `Email sent.\nMessage-ID: ${result.result.messageId}\nAccepted: ${result.result.accepted.join(', ') || '(none)'}${result.result.rejected.length > 0 ? `\nRejected: ${result.result.rejected.join(', ')}` : ''}${followupNote}`;
    },
  };
}

/** Accept yes/ja/ok/1/y as approval — anything else is denial. */
function isApproval(answer: string): boolean {
  const a = answer.toLowerCase().trim();
  return ['yes', 'ja', 'ok', 'y', 'j', '1', 'sure', 'send', 'senden'].includes(a);
}
