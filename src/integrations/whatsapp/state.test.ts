import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WhatsAppStateDb } from './state.js';
import type { WhatsAppMessage } from './types.js';

let db: WhatsAppStateDb;

beforeEach(() => {
  db = new WhatsAppStateDb({ path: ':memory:' });
});

afterEach(() => {
  db.close();
});

function msg(overrides: Partial<WhatsAppMessage> = {}): WhatsAppMessage {
  return {
    id: 'wamid.A',
    threadId: 'whatsapp-41791234567',
    phoneE164: '41791234567',
    direction: 'inbound',
    kind: 'text',
    text: 'Hoi',
    mediaId: null,
    transcript: null,
    mimeType: null,
    timestamp: 1_744_900_000,
    isEcho: false,
    rawJson: '{}',
    ...overrides,
  };
}

describe('WhatsAppStateDb', () => {
  it('inserts a new message and dedups the second time', () => {
    expect(db.upsertMessage(msg())).toBe(true);
    expect(db.upsertMessage(msg())).toBe(false);
    expect(db.getMessagesForThread('whatsapp-41791234567')).toHaveLength(1);
  });

  it('orders thread messages by timestamp asc', () => {
    db.upsertMessage(msg({ id: 'a', timestamp: 100 }));
    db.upsertMessage(msg({ id: 'b', timestamp: 50 }));
    db.upsertMessage(msg({ id: 'c', timestamp: 200 }));
    const out = db.getMessagesForThread('whatsapp-41791234567');
    expect(out.map(m => m.id)).toEqual(['b', 'a', 'c']);
  });

  it('stores + updates transcripts on voice notes', () => {
    db.upsertMessage(msg({ id: 'v1', kind: 'voice', text: null, mediaId: 'M1', mimeType: 'audio/ogg' }));
    db.setTranscript('v1', 'Hallo, wie geht es dir?');
    const out = db.getMessageById('v1');
    expect(out?.transcript).toBe('Hallo, wie geht es dir?');
  });

  it('upserts contact display name idempotently', () => {
    db.upsertContact({ phoneE164: '41791234567', displayName: 'Max', profileName: 'Max', lastSeenAt: 100 });
    db.upsertContact({ phoneE164: '41791234567', displayName: null, profileName: null, lastSeenAt: 200 });
    const c = db.getContact('41791234567');
    // Previous name must survive null in the upsert (COALESCE).
    expect(c?.displayName).toBe('Max');
    expect(c?.lastSeenAt).toBe(200);
  });

  it('summarises inbox with unread counts + voice flag', () => {
    db.upsertContact({ phoneE164: '41791234567', displayName: 'Max', profileName: null, lastSeenAt: 100 });
    db.upsertMessage(msg({ id: 'a', timestamp: 100, text: 'erste' }));
    db.upsertMessage(msg({ id: 'b', timestamp: 200, text: 'zweite' }));
    db.upsertMessage(msg({ id: 'v', timestamp: 300, kind: 'voice', text: null, mediaId: 'M1' }));
    const summaries = db.listThreadSummaries();
    expect(summaries).toHaveLength(1);
    const s = summaries[0]!;
    expect(s.displayName).toBe('Max');
    expect(s.unreadCount).toBe(3);
    expect(s.hasVoiceNote).toBe(true);
    expect(s.lastMessageAt).toBe(300);
  });

  it('markThreadRead drops the unread count', () => {
    db.upsertMessage(msg({ id: 'a', timestamp: 100 }));
    db.upsertMessage(msg({ id: 'b', timestamp: 200 }));
    expect(db.listThreadSummaries()[0]!.unreadCount).toBe(2);
    db.markThreadRead('whatsapp-41791234567');
    expect(db.listThreadSummaries()[0]!.unreadCount).toBe(0);
  });
});
