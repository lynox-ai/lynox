import { describe, expect, it } from 'vitest';
import { waMessageToInboxInput } from './whatsapp-adapter.js';
import type { WhatsAppContact, WhatsAppMessage } from '../whatsapp/types.js';

const OPTS = { phoneNumberId: 'pn-123' };

function msg(overrides: Partial<WhatsAppMessage> = {}): WhatsAppMessage {
  return {
    id: 'wamid.abc',
    threadId: 'whatsapp:491234567890',
    phoneE164: '491234567890',
    direction: 'inbound',
    kind: 'text',
    text: 'Hallo, kannst du mir helfen?',
    mediaId: null,
    transcript: null,
    mimeType: null,
    timestamp: 1_700_000_000,
    isEcho: false,
    rawJson: '{}',
    ...overrides,
  };
}

function contact(name?: string): WhatsAppContact {
  return {
    phoneE164: '491234567890',
    displayName: name ?? 'Max',
    profileName: 'mxm',
    lastSeenAt: 1_700_000_000,
  };
}

describe('waMessageToInboxInput — happy path', () => {
  it('synthesises a MailEnvelope from an inbound text message', () => {
    const out = waMessageToInboxInput(msg(), contact('Max Mustermann'), OPTS);
    expect(out).not.toBeNull();
    if (!out) return;
    expect(out.accountId).toBe('whatsapp:pn-123');
    expect(out.envelope.folder).toBe('WHATSAPP');
    expect(out.envelope.threadKey).toBe('whatsapp:491234567890');
    expect(out.envelope.from[0]?.address).toBe('whatsapp:491234567890');
    expect(out.envelope.from[0]?.name).toBe('Max Mustermann');
    expect(out.envelope.to[0]?.address).toBe('whatsapp:pn-123');
    expect(out.envelope.snippet).toBe('Hallo, kannst du mir helfen?');
    expect(out.envelope.subject).toBe('');
    expect(out.envelope.messageId).toBe('wamid.abc');
    expect(out.envelope.date.toISOString()).toBe('2023-11-14T22:13:20.000Z');
  });

  it('falls back to profileName when displayName is missing', () => {
    const out = waMessageToInboxInput(
      msg(),
      { phoneE164: '491234567890', displayName: null, profileName: 'mxm', lastSeenAt: 0 },
      OPTS,
    );
    expect(out?.envelope.from[0]?.name).toBe('mxm');
  });

  it('passes undefined name when no contact is supplied', () => {
    const out = waMessageToInboxInput(msg(), null, OPTS);
    expect(out?.envelope.from[0]?.name).toBeUndefined();
  });
});

describe('waMessageToInboxInput — filtering', () => {
  it('returns null for outbound messages', () => {
    expect(waMessageToInboxInput(msg({ direction: 'outbound' }), contact(), OPTS)).toBeNull();
  });

  it('returns null for echoes (sent from the Business Mobile App)', () => {
    expect(waMessageToInboxInput(msg({ isEcho: true }), contact(), OPTS)).toBeNull();
  });

  it('returns null for voice / image / document kinds (Phase 1b+)', () => {
    expect(waMessageToInboxInput(msg({ kind: 'voice', text: null }), contact(), OPTS)).toBeNull();
    expect(waMessageToInboxInput(msg({ kind: 'image', text: null }), contact(), OPTS)).toBeNull();
    expect(waMessageToInboxInput(msg({ kind: 'document', text: null }), contact(), OPTS)).toBeNull();
    expect(waMessageToInboxInput(msg({ kind: 'reaction', text: null }), contact(), OPTS)).toBeNull();
  });

  it('returns null for empty text body', () => {
    expect(waMessageToInboxInput(msg({ text: '' }), contact(), OPTS)).toBeNull();
    expect(waMessageToInboxInput(msg({ text: '   ' }), contact(), OPTS)).toBeNull();
    expect(waMessageToInboxInput(msg({ text: null }), contact(), OPTS)).toBeNull();
  });
});
