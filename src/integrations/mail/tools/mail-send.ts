// === mail_send tool ===
//
// Send a brand-new message via SMTP. PERMISSION-GUARDED — both at the
// permission-guard layer (autonomous-mode block) AND inline via
// agent.promptUser() before the actual send.

import type { IAgent, ToolEntry } from '../../../types/index.js';
import { getErrorMessage } from '../../../core/utils.js';
import {
  MailError,
  isReceiveOnlyType,
  personaFor,
  type MailAddress,
  type MailSendInput,
} from '../provider.js';
import type { MailContext } from '../context.js';
import { resolveProvider, type MailRegistry } from './registry.js';

/**
 * Recipient count above which mail_send forces explicit confirmation with
 * the full list — anti-blast safety net. From PRD: "Never auto-send to >5
 * recipients without explicit user approval".
 */
const MASS_SEND_THRESHOLD = 5;

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
    handler: async (input: MailSendToolInput, agent: IAgent): Promise<string> => {
      try {
        if (!input.to) return 'mail_send error: "to" is required';
        if (!input.subject) return 'mail_send error: "subject" is required';
        if (!input.body) return 'mail_send error: "body" is required';

        // Fail-safe: refuse to send when no interactive prompt is available
        // (autonomous/background mode). The permission-guard already blocks
        // mail_send in autonomous mode, but this is the belt-and-braces.
        if (!agent.promptUser) {
          return 'mail_send error: sending requires interactive user confirmation, which is not available in this mode.';
        }

        const provider = resolveProvider(registry, input.account);

        // Receive-only hard block — happens BEFORE any confirmation prompt.
        // This is the non-overrideable boundary for compliance/bulk mailboxes.
        const accountConfig = ctx?.getAccountConfig(provider.accountId);
        if (accountConfig && isReceiveOnlyType(accountConfig.type)) {
          return `mail_send blocked: account "${provider.accountId}" has type "${accountConfig.type}" which is receive-only. ` +
            `Compliance (abuse/privacy/security/legal) and bulk (info/newsletter/notifications) mailboxes cannot send mail. ` +
            `Pick a different account via the "account" parameter.`;
        }

        const to = parseAddressList(input.to);
        const cc = parseAddressList(input.cc);
        const bcc = parseAddressList(input.bcc);
        if (to.length === 0) return 'mail_send error: "to" did not parse to any valid addresses';

        // Mass-send guard — count unique recipients across to+cc+bcc.
        // Above threshold, the confirmation prompt becomes mandatory and
        // lists every recipient so the user sees exactly who gets it.
        const uniqueRecipients = new Set<string>();
        for (const a of [...to, ...cc, ...bcc]) {
          uniqueRecipients.add(a.address.toLowerCase());
        }
        const isMassSend = uniqueRecipients.size > MASS_SEND_THRESHOLD;

        // Persona hint in the prompt so the user knows the implied voice.
        let personaLine = '';
        if (accountConfig) {
          personaLine = `\n  Persona: ${truncate(personaFor(accountConfig), 160)}`;
        }

        const preview = isMassSend
          ? `⚠ MASS SEND — ${String(uniqueRecipients.size)} recipients. Review carefully before confirming.
  Account: ${provider.accountId}${personaLine}
  Recipients (full list):
${[...to, ...cc, ...bcc].map(a => `    • ${a.address}`).join('\n')}
  Subject: ${input.subject}
  Body:    ${truncate(input.body.replace(/\s+/g, ' '), 200)}`
          : `Send email?
  Account: ${provider.accountId}${personaLine}
  To:      ${to.map(a => a.address).join(', ')}${cc.length > 0 ? `\n  Cc:      ${cc.map(a => a.address).join(', ')}` : ''}${bcc.length > 0 ? `\n  Bcc:     ${bcc.map(a => a.address).join(', ')}` : ''}
  Subject: ${input.subject}
  Body:    ${truncate(input.body.replace(/\s+/g, ' '), 200)}`;

        const answer = await agent.promptUser(preview, ['Yes', 'No']);
        if (answer.toLowerCase() !== 'yes' && answer !== '1') {
          return isMassSend ? 'mail_send cancelled by user (mass send).' : 'mail_send cancelled by user.';
        }

        const sendInput: MailSendInput = {
          to,
          subject: input.subject,
          text: input.body,
        };
        if (cc.length > 0) sendInput.cc = cc;
        if (bcc.length > 0) sendInput.bcc = bcc;

        const result = await provider.send(sendInput);

        // Optional follow-up registration — fires only on successful send
        let followupNote = '';
        if (input.track_followup && ctx) {
          const daysNum = Number(input.track_followup.reminder_in_days);
          if (Number.isFinite(daysNum) && daysNum > 0 && input.track_followup.reason) {
            const reminderAt = new Date(Date.now() + daysNum * 24 * 60 * 60 * 1000);
            const primaryRecipient = to[0]?.address ?? '';
            const messageId = result.messageId || `local-${String(Date.now())}`;
            try {
              const followupId = ctx.stateDb.recordFollowup({
                accountId: provider.accountId,
                sentMessageId: messageId,
                threadKey: messageId,
                recipient: primaryRecipient,
                type: input.track_followup.type ?? 'awaiting_reply',
                reason: input.track_followup.reason,
                reminderAt,
                source: 'agent',
              });
              followupNote = `\nFollow-up registered: ${followupId} (reminder in ${String(daysNum)} days, reason: ${input.track_followup.reason})`;
            } catch {
              followupNote = '\n(follow-up registration failed — send itself succeeded)';
            }
          }
        }

        return `Email sent.\nMessage-ID: ${result.messageId}\nAccepted: ${result.accepted.join(', ') || '(none)'}${result.rejected.length > 0 ? `\nRejected: ${result.rejected.join(', ')}` : ''}${followupNote}`;
      } catch (err: unknown) {
        if (err instanceof MailError) return `mail_send error (${err.code}): ${err.message}`;
        return `mail_send error: ${getErrorMessage(err)}`;
      }
    },
  };
}

function parseAddressList(input: string | undefined): MailAddress[] {
  if (!input) return [];
  return input
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0)
    .map(parseAddress)
    .filter((a): a is MailAddress => a !== null);
}

/**
 * Parse a single RFC 5322-ish address into name + address. Accepts:
 *   "Alice Tester" <alice@x.com>
 *   Alice Tester <alice@x.com>
 *   alice@x.com
 */
function parseAddress(raw: string): MailAddress | null {
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
