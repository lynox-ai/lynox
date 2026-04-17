// === WhatsApp webhook dispatch ===
//
// Called by src/server/http-api.ts for POST /api/webhooks/whatsapp.
// The HTTP layer does the signature check + JSON parse and then hands off
// here. Voice notes are transcribed in the background — this function returns
// quickly to keep Meta's <30s response requirement well out of reach.

import { parseWebhook } from './webhook-parser.js';
import type { WhatsAppContext } from './context.js';

export interface DispatchResult {
  /** Total events parsed (messages + echoes + statuses). */
  readonly eventsParsed: number;
  /** Messages newly inserted (dedup passes). */
  readonly messagesInserted: number;
  /** Voice-note transcriptions scheduled (not awaited). */
  readonly transcriptionsScheduled: number;
}

/**
 * Dispatch a parsed Meta webhook body.
 *
 * The caller is responsible for:
 *   - Verifying `X-Hub-Signature-256` via ./signature.ts#verifySignature
 *   - Responding 200 OK to Meta quickly (this function is fast enough to await)
 */
export function dispatchWebhook(ctx: WhatsAppContext, payload: unknown): DispatchResult {
  const events = parseWebhook(payload);
  let inserted = 0;
  let transcribed = 0;

  for (const event of events) {
    const persisted = ctx.persistEvent(event);
    if (persisted.messageInserted) inserted += 1;

    if (
      (event.type === 'message' || event.type === 'echo') &&
      event.msg.kind === 'voice' &&
      event.msg.mediaId !== null &&
      persisted.messageInserted
    ) {
      // Fire-and-forget background transcription. On failure we log server-side
      // and leave the message transcript-less; the UI falls back to the raw
      // audio player (served by /api/whatsapp/media/:messageId).
      transcribed += 1;
      const contactName = event.contact?.displayName ?? null;
      void transcribeVoiceNote(ctx, event.msg.id, event.msg.mediaId, contactName).catch((err: unknown) => {
        const reason = err instanceof Error ? err.message : String(err);
        console.warn(`[whatsapp] voice transcription failed for ${event.msg.id}: ${reason}`);
      });
    }
  }

  return {
    eventsParsed: events.length,
    messagesInserted: inserted,
    transcriptionsScheduled: transcribed,
  };
}

async function transcribeVoiceNote(
  ctx: WhatsAppContext,
  messageId: string,
  mediaId: string,
  contactName: string | null,
): Promise<void> {
  const client = ctx.getClient();
  if (!client) return;

  const { buffer, mimeType } = await client.fetchMedia(mediaId);
  const filename = filenameForMime(mimeType);

  const { transcribe } = await import('../../core/transcribe/index.js');

  // No language hint — Voxtral auto-detects, so a CH-German contact gets Swiss
  // German, a French contact gets French, without config. The contact display
  // name is passed as a glossary term so proper nouns ("Max Müller") survive
  // the STT post-processing.
  const session = contactName && contactName.length > 0
    ? { contactNames: [contactName] }
    : undefined;

  const transcript = await transcribe(buffer, filename, {
    ...(session ? { session } : {}),
  });
  if (transcript && transcript.length > 0) {
    ctx.getStateDb().setTranscript(messageId, transcript);
  }
}

function filenameForMime(mimeType: string): string {
  // Voxtral accepts audio/ogg (WhatsApp default), audio/mpeg, etc. Filename
  // helps servers sniff the format — we pass a canonical extension.
  if (mimeType.includes('ogg')) return 'voice.ogg';
  if (mimeType.includes('mpeg') || mimeType.includes('mp3')) return 'voice.mp3';
  if (mimeType.includes('wav')) return 'voice.wav';
  if (mimeType.includes('mp4') || mimeType.includes('m4a')) return 'voice.m4a';
  return 'voice.bin';
}
