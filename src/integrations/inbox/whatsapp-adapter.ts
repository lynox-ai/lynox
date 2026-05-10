// === WhatsApp -> Inbox adapter ===
//
// Converts an inbound WhatsApp message into the shape the inbox
// classifier hook expects. Phase 1a backend convergence: text messages
// from contacts land in `inbox_items` with `channel='whatsapp'` alongside
// email items, so the upcoming unified InboxView (Phase 1b) reads from a
// single source.
//
// Out of scope for this Phase-1a follow-up:
//   - voice / image / document messages — handled by separate kinds in
//     WhatsAppMessage; defer rich-media classification to Phase 1b+.
//   - echoes (msg.isEcho = true, sent from the Business Mobile App by the
//     user themselves) — don't go to inbox; they're outbound history.
//   - status events (delivered/read/failed) — informational only.
//
// The accountId scheme `'whatsapp:<phoneNumberId>'` lives only in
// inbox_items (FK relaxed in migration v9). The mail_accounts table is
// not touched; the Bootstrap's AccountResolver synthesises a display
// name for whatsapp:* ids.

import type { MailEnvelope } from '../mail/provider.js';
import type { WhatsAppContact, WhatsAppMessage } from '../whatsapp/types.js';

export interface WhatsAppToEnvelopeResult {
  accountId: string;
  envelope: MailEnvelope;
}

export interface WhatsAppAdapterOptions {
  /**
   * Stable per-Engine identifier for the WhatsApp account. Typically the
   * customer's Phone-Number-ID from Meta. Used to build the polymorphic
   * accountId 'whatsapp:<phoneNumberId>'.
   */
  phoneNumberId: string;
}

/**
 * Map a WhatsApp inbound text message + contact to the (accountId, envelope)
 * pair the inbox classifier hook consumes. Returns null for messages that
 * should not reach the inbox (echoes, non-text kinds, empty body).
 */
export function waMessageToInboxInput(
  msg: WhatsAppMessage,
  contact: WhatsAppContact | null,
  opts: WhatsAppAdapterOptions,
): WhatsAppToEnvelopeResult | null {
  if (msg.direction !== 'inbound') return null;
  if (msg.isEcho) return null;
  if (msg.kind !== 'text') return null;
  const text = msg.text?.trim() ?? '';
  if (!text) return null;

  const accountId = `whatsapp:${opts.phoneNumberId}`;
  const counterpartyAddress = `whatsapp:${msg.phoneE164}`;
  const displayName = contact?.displayName ?? contact?.profileName ?? undefined;

  const envelope: MailEnvelope = {
    uid: msg.timestamp,
    messageId: msg.id,
    folder: 'WHATSAPP',
    threadKey: msg.threadId,
    inReplyTo: undefined,
    from: [{ address: counterpartyAddress, name: displayName }],
    to: [{ address: accountId }],
    cc: [],
    replyTo: [],
    subject: '', // WhatsApp has no subject — classifier reads body only
    date: new Date(msg.timestamp * 1000),
    flags: [],
    snippet: text,
    hasAttachments: false,
    attachmentCount: 0,
    sizeBytes: text.length,
    isAutoReply: false,
  };
  return { accountId, envelope };
}
