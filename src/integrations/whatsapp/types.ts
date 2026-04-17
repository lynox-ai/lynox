// === WhatsApp Business Cloud API — domain types ===
//
// Coexistence Mode (Meta, GA Nov 2025) — the same WhatsApp Business number
// runs in the Mobile App and via Cloud API simultaneously.
//
// Phase 0 (BYOK pilot): customers paste their own Meta App credentials into
// Settings; lynox never goes through Meta Tech-Provider / Embedded Signup.

/** BYOK credential bundle for one WhatsApp Business Account. */
export interface WhatsAppCredentials {
  /** Permanent access token (System User) from the customer's Meta App. */
  accessToken: string;
  /** WhatsApp Business Account ID (WABA-ID). */
  wabaId: string;
  /** Phone-Number-ID attached to the WABA (not the raw phone). */
  phoneNumberId: string;
  /** Meta App secret — used to verify X-Hub-Signature-256 on webhooks. */
  appSecret: string;
  /** Webhook verify token (customer chooses this when configuring the webhook). */
  webhookVerifyToken: string;
}

/** Direction of a WhatsApp message. */
export type MessageDirection = 'inbound' | 'outbound';

/** Kind of a WhatsApp message body. */
export type MessageKind =
  | 'text'
  | 'voice'
  | 'image'
  | 'document'
  | 'location'
  | 'contact'
  | 'sticker'
  | 'reaction'
  | 'unsupported';

/** Single WhatsApp message (one row in the state DB). */
export interface WhatsAppMessage {
  /** Meta's unique message ID (wa_id). */
  readonly id: string;
  /** Thread ID (= `whatsapp-{phoneDigits}`). */
  readonly threadId: string;
  /** Counter-party phone in E.164 without leading '+'. */
  readonly phoneE164: string;
  readonly direction: MessageDirection;
  readonly kind: MessageKind;
  /** Text body (for text; null for media-only). */
  readonly text: string | null;
  /** Meta media-id for voice/image/document (null otherwise). */
  readonly mediaId: string | null;
  /** Transcript for voice notes (null until transcribed). */
  readonly transcript: string | null;
  /** Mime-type for media messages. */
  readonly mimeType: string | null;
  /** Unix-seconds timestamp from Meta. */
  readonly timestamp: number;
  /** True if the message arrived via `smb_message_echoes` (sent from Mobile App). */
  readonly isEcho: boolean;
  /** Raw Meta payload (for future enrichment + debugging). */
  readonly rawJson: string;
}

/** Contact display name + last-seen timestamp, cached from webhook envelopes. */
export interface WhatsAppContact {
  readonly phoneE164: string;
  readonly displayName: string | null;
  readonly profileName: string | null;
  readonly lastSeenAt: number;
}

/** Inbox thread summary (one counter-party). */
export interface WhatsAppThreadSummary {
  readonly threadId: string;
  readonly phoneE164: string;
  readonly displayName: string | null;
  readonly lastMessageAt: number;
  readonly lastMessagePreview: string;
  readonly unreadCount: number;
  readonly hasVoiceNote: boolean;
}

/** Meta webhook event — normalized shape. */
export type MetaWebhookEvent =
  | { type: 'message'; msg: WhatsAppMessage; contact: WhatsAppContact | null }
  | { type: 'echo'; msg: WhatsAppMessage; contact: WhatsAppContact | null }
  | { type: 'status'; messageId: string; status: 'sent' | 'delivered' | 'read' | 'failed'; timestamp: number };
