// === Parse Meta webhook payloads into MetaWebhookEvent[] ===
//
// Meta webhook shape (truncated):
//   {
//     entry: [{
//       changes: [{
//         field: 'messages',
//         value: {
//           messaging_product: 'whatsapp',
//           metadata: { phone_number_id, display_phone_number },
//           contacts: [{ profile: { name }, wa_id }],
//           messages: [{ id, from, timestamp, type, text: { body }, voice: { id, mime_type }, ... }],
//           statuses: [{ id, status, timestamp, ... }],
//           message_echoes: [{ ...like messages, plus `to` field }]     <-- smb_message_echoes
//         }
//       }]
//     }]
//   }

import type { MessageKind, MetaWebhookEvent, WhatsAppContact, WhatsAppMessage } from './types.js';

/** Convert a phone WA-id (digits only, e.g. "41791234567") into a deterministic thread ID. */
export function threadIdForPhone(phoneDigits: string): string {
  return `whatsapp-${phoneDigits}`;
}

/** Normalize a wa_id / `from` field to E.164-without-plus digits only. */
function normalizePhone(raw: string): string {
  return raw.replace(/[^0-9]/g, '');
}

/** Pull the relevant sub-value objects out of Meta's envelope. */
function extractValues(payload: unknown): Array<Record<string, unknown>> {
  if (typeof payload !== 'object' || payload === null) return [];
  const entry = (payload as Record<string, unknown>)['entry'];
  if (!Array.isArray(entry)) return [];
  const values: Array<Record<string, unknown>> = [];
  for (const e of entry) {
    if (typeof e !== 'object' || e === null) continue;
    const changes = (e as Record<string, unknown>)['changes'];
    if (!Array.isArray(changes)) continue;
    for (const c of changes) {
      if (typeof c !== 'object' || c === null) continue;
      const value = (c as Record<string, unknown>)['value'];
      if (typeof value === 'object' && value !== null) {
        values.push(value as Record<string, unknown>);
      }
    }
  }
  return values;
}

function pickContacts(value: Record<string, unknown>): Map<string, WhatsAppContact> {
  const now = Math.floor(Date.now() / 1000);
  const out = new Map<string, WhatsAppContact>();
  const contacts = value['contacts'];
  if (!Array.isArray(contacts)) return out;
  for (const c of contacts) {
    if (typeof c !== 'object' || c === null) continue;
    const waId = (c as Record<string, unknown>)['wa_id'];
    if (typeof waId !== 'string') continue;
    const profile = (c as Record<string, unknown>)['profile'];
    const profileName = typeof profile === 'object' && profile !== null && typeof (profile as Record<string, unknown>)['name'] === 'string'
      ? (profile as Record<string, unknown>)['name'] as string
      : null;
    const phoneE164 = normalizePhone(waId);
    out.set(phoneE164, {
      phoneE164,
      displayName: profileName,
      profileName,
      lastSeenAt: now,
    });
  }
  return out;
}

function messageKindOf(type: string): MessageKind {
  switch (type) {
    case 'text': return 'text';
    case 'voice':
    case 'audio': return 'voice';
    case 'image': return 'image';
    case 'document': return 'document';
    case 'location': return 'location';
    case 'contacts': return 'contact';
    case 'sticker': return 'sticker';
    case 'reaction': return 'reaction';
    default: return 'unsupported';
  }
}

function toWhatsAppMessage(raw: Record<string, unknown>, isEcho: boolean): WhatsAppMessage | null {
  const id = raw['id'];
  const timestamp = raw['timestamp'];
  const type = raw['type'];
  if (typeof id !== 'string' || typeof type !== 'string') return null;

  // For inbound: `from` is the sender (counter-party). For echo: `to` is the counter-party.
  const phoneField = isEcho ? raw['to'] : raw['from'];
  if (typeof phoneField !== 'string') return null;
  const phoneE164 = normalizePhone(phoneField);
  if (phoneE164.length === 0) return null;

  const ts = typeof timestamp === 'string' ? parseInt(timestamp, 10) : (typeof timestamp === 'number' ? timestamp : Math.floor(Date.now() / 1000));
  const kind = messageKindOf(type);

  let text: string | null = null;
  let mediaId: string | null = null;
  let mimeType: string | null = null;

  if (type === 'text') {
    const t = raw['text'];
    if (typeof t === 'object' && t !== null && typeof (t as Record<string, unknown>)['body'] === 'string') {
      text = (t as Record<string, unknown>)['body'] as string;
    }
  } else if (type === 'voice' || type === 'audio') {
    const m = raw[type];
    if (typeof m === 'object' && m !== null) {
      const rec = m as Record<string, unknown>;
      mediaId = typeof rec['id'] === 'string' ? rec['id'] : null;
      mimeType = typeof rec['mime_type'] === 'string' ? rec['mime_type'] : null;
    }
  } else if (type === 'image' || type === 'document' || type === 'sticker') {
    const m = raw[type];
    if (typeof m === 'object' && m !== null) {
      const rec = m as Record<string, unknown>;
      mediaId = typeof rec['id'] === 'string' ? rec['id'] : null;
      mimeType = typeof rec['mime_type'] === 'string' ? rec['mime_type'] : null;
      const caption = rec['caption'];
      if (typeof caption === 'string') text = caption;
    }
  }

  return {
    id,
    threadId: threadIdForPhone(phoneE164),
    phoneE164,
    direction: isEcho ? 'outbound' : 'inbound',
    kind,
    text,
    mediaId,
    transcript: null,
    mimeType,
    timestamp: ts,
    isEcho,
    rawJson: JSON.stringify(raw),
  };
}

/**
 * Parse a raw Meta webhook payload into a sequence of normalized events.
 * Returns `[]` when the payload is malformed or contains nothing actionable.
 */
export function parseWebhook(payload: unknown): MetaWebhookEvent[] {
  const events: MetaWebhookEvent[] = [];
  const values = extractValues(payload);

  for (const value of values) {
    const contactMap = pickContacts(value);

    const messages = value['messages'];
    if (Array.isArray(messages)) {
      for (const raw of messages) {
        if (typeof raw !== 'object' || raw === null) continue;
        const msg = toWhatsAppMessage(raw as Record<string, unknown>, false);
        if (!msg) continue;
        events.push({ type: 'message', msg, contact: contactMap.get(msg.phoneE164) ?? null });
      }
    }

    const echoes = value['message_echoes'];
    if (Array.isArray(echoes)) {
      for (const raw of echoes) {
        if (typeof raw !== 'object' || raw === null) continue;
        const msg = toWhatsAppMessage(raw as Record<string, unknown>, true);
        if (!msg) continue;
        events.push({ type: 'echo', msg, contact: contactMap.get(msg.phoneE164) ?? null });
      }
    }

    const statuses = value['statuses'];
    if (Array.isArray(statuses)) {
      for (const raw of statuses) {
        if (typeof raw !== 'object' || raw === null) continue;
        const r = raw as Record<string, unknown>;
        const id = r['id'];
        const status = r['status'];
        const timestamp = r['timestamp'];
        if (typeof id !== 'string' || typeof status !== 'string') continue;
        if (status !== 'sent' && status !== 'delivered' && status !== 'read' && status !== 'failed') continue;
        const ts = typeof timestamp === 'string' ? parseInt(timestamp, 10) : (typeof timestamp === 'number' ? timestamp : Math.floor(Date.now() / 1000));
        events.push({ type: 'status', messageId: id, status, timestamp: ts });
      }
    }
  }

  return events;
}
