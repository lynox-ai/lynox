// === mail_reply tool ===
//
// Thread-aware reply. Fetches the original message to populate In-Reply-To
// and References headers, derives a sensible default recipient (the original
// sender), then sends via SMTP. PERMISSION-GUARDED.

import type { IAgent, ToolEntry } from '../../../types/index.js';
import { getErrorMessage } from '../../../core/utils.js';
import {
  MailError,
  isReceiveOnlyType,
  personaFor,
  type MailAddress,
  type MailProvider,
  type MailSendInput,
} from '../provider.js';
import type { MailContext } from '../context.js';
import { resolveProvider, type MailRegistry } from './registry.js';

interface MailReplyToolInput {
  account?: string | undefined;
  uid: number;
  body: string;
  /** Optional override for the recipient. Defaults to the original sender. */
  to?: string | undefined;
  cc?: string | undefined;
  folder?: string | undefined;
  /** Reply-all behaviour: include all original To and Cc recipients. */
  reply_all?: boolean | undefined;
}

/**
 * mail_reply needs more than a bare MailRegistry — it looks up account types
 * (to enforce the receive-only hard block) and derives the sending account
 * from the original recipient. The MailContext bundles everything.
 */
export function createMailReplyTool(registry: MailRegistry, ctx?: MailContext): ToolEntry<MailReplyToolInput> {
  return {
    definition: {
      name: 'mail_reply',
      description:
        'Reply to an existing message by UID. Fetches the original to copy In-Reply-To and References headers (preserving the thread). Default recipient is the original sender; pass to= to override or reply_all=true to include the full To+Cc list. Requires user confirmation before sending.',
      input_schema: {
        type: 'object' as const,
        properties: {
          account: { type: 'string', description: 'Account id. Omit to use the default account.' },
          uid: { type: 'number', description: 'IMAP UID of the message to reply to. Required.' },
          body: { type: 'string', description: 'Plain-text reply body. Required.' },
          to: { type: 'string', description: 'Override recipient(s), comma-separated. Defaults to original sender.' },
          cc: { type: 'string', description: 'Override CC, comma-separated.' },
          folder: { type: 'string', description: 'Folder of the original message. Default: INBOX.' },
          reply_all: { type: 'boolean', description: 'Include all original To and Cc recipients. Default false.' },
        },
        required: ['uid', 'body'],
      },
    },
    requiresConfirmation: true,
    handler: async (input: MailReplyToolInput, agent: IAgent): Promise<string> => {
      try {
        if (typeof input.uid !== 'number' || !Number.isFinite(input.uid)) {
          return 'mail_reply error: "uid" must be a number';
        }
        if (!input.body) return 'mail_reply error: "body" is required';
        if (!agent.promptUser) {
          return 'mail_reply error: sending requires interactive user confirmation, which is not available in this mode.';
        }

        // For the initial fetch, resolve the requested reading account (or default).
        // The sending account may differ — smart reply-from derives it below.
        const readProvider = resolveProvider(registry, input.account);

        const fetchOpts: { uid: number; folder?: string } = { uid: input.uid };
        if (input.folder) fetchOpts.folder = input.folder;
        const original = await readProvider.fetch(fetchOpts);

        // ── Auto-reply loop protection ────────────────────────────────────
        //
        // RFC 3834 says: "Automatic responses SHOULD NOT be issued in response
        // to any message which contains an Auto-Submitted header field, where
        // that field has any value other than 'no'." We enforce this as a
        // hard block — no confirmation can override it. Prevents mail loops.
        if (original.envelope.isAutoReply) {
          return `mail_reply blocked: original message has Auto-Submitted header (auto-generated/auto-replied). ` +
            `RFC 3834 forbids automatic replies to automated messages to prevent mail loops. ` +
            `If this is a real message that needs a response, use mail_send instead.`;
        }

        // ── Smart reply-from ────────────────────────────────────────────
        //
        // Default sender = the account we read the message from. But if the
        // MailContext is available AND one of the original recipients matches
        // a different registered account by address, use THAT account as the
        // sender. This keeps "support reply" from support@, "personal reply"
        // from personal@, automatically.

        let sendProvider: MailProvider = readProvider;
        let sendFromAddress: string = readProvider.accountId;

        if (ctx) {
          const candidates = [...original.envelope.to, ...original.envelope.cc];
          for (const candidate of candidates) {
            const match = ctx.findAccountByAddress(candidate.address);
            if (!match) continue;
            // Receive-only types cannot send — skip as a candidate. The
            // permission check below is the hard boundary; this is just so
            // we don't surface a doomed confirmation prompt.
            if (isReceiveOnlyType(match.type)) continue;
            const matched = registry.get(match.id);
            if (!matched) continue;
            sendProvider = matched;
            sendFromAddress = match.address;
            break;
          }
        }

        // Receive-only hard block — no confirm, no override, no pre-approval
        const sendAccountConfig = ctx?.getAccountConfig(sendProvider.accountId);
        if (sendAccountConfig && isReceiveOnlyType(sendAccountConfig.type)) {
          return `mail_reply blocked: account "${sendProvider.accountId}" has type "${sendAccountConfig.type}" which is receive-only. ` +
            `Compliance and bulk mailboxes never auto-respond. Escalate this message to the user manually.`;
        }

        // Determine recipients
        let toAddrs: MailAddress[];
        if (input.to) {
          toAddrs = parseAddressList(input.to);
        } else {
          // Default: the original sender (Reply-To if set, else From)
          const sender = original.envelope.replyTo[0] ?? original.envelope.from[0];
          toAddrs = sender ? [sender] : [];
        }
        if (toAddrs.length === 0) return 'mail_reply error: could not determine recipient — original message has no From or Reply-To, and no "to" override was given.';

        // Reply-all: union with original To + Cc, minus our own address
        let ccAddrs: MailAddress[] = input.cc ? parseAddressList(input.cc) : [];
        if (input.reply_all) {
          const ourAddress = sendFromAddress;
          const seen = new Set<string>([...toAddrs.map(a => a.address.toLowerCase()), ourAddress.toLowerCase()]);
          for (const addr of [...original.envelope.to, ...original.envelope.cc]) {
            const key = addr.address.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            ccAddrs.push(addr);
          }
        }

        // Build References chain: existing references + original Message-ID
        const origMessageId = original.envelope.messageId;
        const newReferences = [original.references, origMessageId].filter((s): s is string => typeof s === 'string' && s.length > 0).join(' ');

        const subject = original.envelope.subject.startsWith('Re:')
          ? original.envelope.subject
          : `Re: ${original.envelope.subject || '(no subject)'}`;

        // Persona hint shown in the confirmation prompt so the user knows
        // what voice will be used. Phase 1 will inject this as a compose-time
        // system prompt; Phase 0.1 is just the advisory render.
        let personaLine = '';
        if (sendAccountConfig) {
          personaLine = `\n  Persona: ${truncate(personaFor(sendAccountConfig), 160)}`;
        }

        const preview = `Reply to "${original.envelope.subject || '(no subject)'}"?
  Account: ${sendProvider.accountId}${sendProvider.accountId !== readProvider.accountId ? ` (smart reply-from, original was read via ${readProvider.accountId})` : ''}${personaLine}
  To:      ${toAddrs.map(a => a.address).join(', ')}${ccAddrs.length > 0 ? `\n  Cc:      ${ccAddrs.map(a => a.address).join(', ')}` : ''}
  Subject: ${subject}
  Body:    ${truncate(input.body.replace(/\s+/g, ' '), 200)}`;

        const answer = await agent.promptUser(preview, ['Yes', 'No']);
        if (!isApproval(answer)) {
          return 'mail_reply cancelled by user.';
        }

        const sendInput: MailSendInput = {
          to: toAddrs,
          subject,
          text: input.body,
        };
        if (ccAddrs.length > 0) sendInput.cc = ccAddrs;
        if (origMessageId) sendInput.inReplyTo = origMessageId;
        if (newReferences) sendInput.references = newReferences;

        const result = await sendProvider.send(sendInput);
        return `Reply sent from ${sendProvider.accountId}.\nMessage-ID: ${result.messageId}\nAccepted: ${result.accepted.join(', ') || '(none)'}${result.rejected.length > 0 ? `\nRejected: ${result.rejected.join(', ')}` : ''}`;
      } catch (err: unknown) {
        if (err instanceof MailError) return `mail_reply error (${err.code}): ${err.message}`;
        return `mail_reply error: ${getErrorMessage(err)}`;
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

/** Accept yes/ja/ok/1/y as approval — anything else is denial. */
function isApproval(answer: string): boolean {
  const a = answer.toLowerCase().trim();
  return ['yes', 'ja', 'ok', 'y', 'j', '1', 'sure', 'send', 'senden'].includes(a);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}
