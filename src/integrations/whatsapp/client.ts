// === Meta Cloud API client (Coexistence Mode compatible) ===
//
// Minimal wrapper around the WhatsApp Business Platform endpoints we use.
// BYOK: the customer's access token + phone-number-id are injected.

import type { WhatsAppCredentials } from './types.js';
import { fetchWithPublicRedirects } from '../../core/network-guard.js';

const GRAPH_VERSION = 'v22.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

// Hard ceiling on every Meta API call so a hung network request can't wedge
// the engine (voice-note transcription fires from a webhook handler that must
// respond quickly; a hung fetchMedia would pile up in the background).
const META_REQUEST_TIMEOUT_MS = 15_000;
const META_MEDIA_DOWNLOAD_TIMEOUT_MS = 30_000;

export interface SendTextResult {
  /** Meta's returned wa_id for the outbound message. */
  readonly messageId: string;
}

export interface MediaFetchResult {
  readonly buffer: Buffer;
  readonly mimeType: string;
  /** Byte length of the downloaded media. */
  readonly size: number;
}

export class WhatsAppClient {
  constructor(private readonly creds: WhatsAppCredentials) {}

  /** Phone-Number-ID — used by the inbox bridge to build a stable accountId. */
  get phoneNumberId(): string {
    return this.creds.phoneNumberId;
  }

  /**
   * Send a plain-text message to a contact. Caller is responsible for enforcing
   * approval flow. Pass `replyToMessageId` (the wa_id of the message being
   * answered) to turn this into a quote-reply — the recipient's WhatsApp app
   * renders the original message as a tappable preview above the new reply.
   */
  async sendText(toPhoneE164: string, body: string, replyToMessageId?: string): Promise<SendTextResult> {
    const url = `${GRAPH_BASE}/${this.creds.phoneNumberId}/messages`;
    const payload: Record<string, unknown> = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: toPhoneE164,
      type: 'text',
      text: { preview_url: false, body },
    };
    if (replyToMessageId && replyToMessageId.length > 0) {
      payload['context'] = { message_id: replyToMessageId };
    }
    const res = await this.post(url, payload);
    const messageId = extractMessageId(res);
    if (!messageId) {
      throw new Error(`Meta API: missing message id in response — ${JSON.stringify(res).slice(0, 300)}`);
    }
    return { messageId };
  }

  /** Mark an inbound message as read (double blue-tick in the Mobile App). */
  async markRead(messageId: string): Promise<void> {
    const url = `${GRAPH_BASE}/${this.creds.phoneNumberId}/messages`;
    await this.post(url, {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId,
    });
  }

  /**
   * Fetch a media file by Meta's media-id. Two-step:
   *   1. GET /{media-id} → { url, mime_type }
   *   2. GET that url (also authenticated with the access token) → binary
   *
   * Media URLs are short-lived (docs: ~5 min) — do NOT cache across requests.
   */
  async fetchMedia(mediaId: string): Promise<MediaFetchResult> {
    const metaUrl = `${GRAPH_BASE}/${mediaId}`;
    const metaRes = await this.get(metaUrl);
    const url = typeof metaRes['url'] === 'string' ? metaRes['url'] : null;
    const mimeType = typeof metaRes['mime_type'] === 'string' ? metaRes['mime_type'] : 'application/octet-stream';
    if (!url) throw new Error(`Meta API: no media url returned for id ${mediaId}`);

    // The media URL is server-controlled (returned in step 1's response body).
    // Without revalidation, a compromised or MITM'd Meta response could redirect
    // the binary fetch to an internal address. Route through the public-host
    // guard so every hop (initial + redirects) is checked.
    const binRes = await fetchWithPublicRedirects(url, {
      headers: { Authorization: `Bearer ${this.creds.accessToken}` },
      signal: AbortSignal.timeout(META_MEDIA_DOWNLOAD_TIMEOUT_MS),
    });
    if (!binRes.ok) {
      throw new Error(`Media download failed: ${binRes.status} ${binRes.statusText}`);
    }
    const arrayBuf = await binRes.arrayBuffer();
    const buffer = Buffer.from(arrayBuf);
    return { buffer, mimeType, size: buffer.byteLength };
  }

  /** Probe: GET /{phone-number-id} — used by the settings page to validate creds. */
  async verifyCredentials(): Promise<{ displayPhoneNumber: string; verifiedName: string | null }> {
    const url = `${GRAPH_BASE}/${this.creds.phoneNumberId}`;
    const res = await this.get(url);
    const displayPhoneNumber = typeof res['display_phone_number'] === 'string' ? res['display_phone_number'] : '';
    const verifiedName = typeof res['verified_name'] === 'string' ? res['verified_name'] : null;
    return { displayPhoneNumber, verifiedName };
  }

  // ── internals ──

  private async post(url: string, body: unknown): Promise<Record<string, unknown>> {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.creds.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(META_REQUEST_TIMEOUT_MS),
    });
    return parseOrThrow(res);
  }

  private async get(url: string): Promise<Record<string, unknown>> {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.creds.accessToken}` },
      signal: AbortSignal.timeout(META_REQUEST_TIMEOUT_MS),
    });
    return parseOrThrow(res);
  }
}

async function parseOrThrow(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  let json: unknown = {};
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`Meta API: non-JSON response (${res.status}): ${text.slice(0, 200)}`);
    }
  }
  if (!res.ok) {
    const errMsg = extractErrorMessage(json) ?? `${res.status} ${res.statusText}`;
    throw new Error(`Meta API error: ${errMsg}`);
  }
  return (typeof json === 'object' && json !== null ? json : {}) as Record<string, unknown>;
}

function extractErrorMessage(json: unknown): string | null {
  if (typeof json !== 'object' || json === null) return null;
  const err = (json as Record<string, unknown>)['error'];
  if (typeof err !== 'object' || err === null) return null;
  const msg = (err as Record<string, unknown>)['message'];
  return typeof msg === 'string' ? msg : null;
}

function extractMessageId(res: Record<string, unknown>): string | null {
  const messages = res['messages'];
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const first = messages[0];
  if (typeof first !== 'object' || first === null) return null;
  const id = (first as Record<string, unknown>)['id'];
  return typeof id === 'string' ? id : null;
}
