import { describe, expect, it } from 'vitest';
import { parseWebhook, threadIdForPhone } from './webhook-parser.js';

function textMessageEnvelope(): unknown {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'WABA_123',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '41791111111', phone_number_id: 'PHID' },
          contacts: [{ profile: { name: 'Max Müller' }, wa_id: '41791234567' }],
          messages: [{
            from: '41791234567',
            id: 'wamid.ABC',
            timestamp: '1744917600',
            type: 'text',
            text: { body: 'Hoi Rafael, wie gahts?' },
          }],
        },
      }],
    }],
  };
}

function voiceEnvelope(): unknown {
  return {
    entry: [{
      changes: [{
        value: {
          contacts: [{ profile: { name: 'Lisa' }, wa_id: '+41 79 999 0000' }],
          messages: [{
            from: '+41 79 999 0000',
            id: 'wamid.VOICE',
            timestamp: 1744918000,
            type: 'voice',
            voice: { id: 'MEDIA_ID_1', mime_type: 'audio/ogg; codecs=opus' },
          }],
        },
      }],
    }],
  };
}

function echoEnvelope(): unknown {
  return {
    entry: [{
      changes: [{
        value: {
          contacts: [{ profile: { name: 'Anna' }, wa_id: '41798880000' }],
          message_echoes: [{
            to: '41798880000',
            id: 'wamid.ECHO',
            timestamp: '1744918200',
            type: 'text',
            text: { body: 'Gern, bis morgen!' },
          }],
        },
      }],
    }],
  };
}

function statusEnvelope(): unknown {
  return {
    entry: [{
      changes: [{
        value: {
          statuses: [{
            id: 'wamid.OUTBOUND',
            status: 'delivered',
            timestamp: '1744918500',
          }],
        },
      }],
    }],
  };
}

describe('parseWebhook', () => {
  it('extracts a text message with contact profile name', () => {
    const events = parseWebhook(textMessageEnvelope());
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.type).toBe('message');
    if (e.type !== 'message') throw new Error('unreachable');
    expect(e.msg.id).toBe('wamid.ABC');
    expect(e.msg.phoneE164).toBe('41791234567');
    expect(e.msg.threadId).toBe(threadIdForPhone('41791234567'));
    expect(e.msg.direction).toBe('inbound');
    expect(e.msg.kind).toBe('text');
    expect(e.msg.text).toBe('Hoi Rafael, wie gahts?');
    expect(e.msg.isEcho).toBe(false);
    expect(e.contact?.displayName).toBe('Max Müller');
  });

  it('parses voice notes and captures media-id + mime-type', () => {
    const events = parseWebhook(voiceEnvelope());
    expect(events).toHaveLength(1);
    const e = events[0]!;
    if (e.type !== 'message') throw new Error('unreachable');
    expect(e.msg.kind).toBe('voice');
    expect(e.msg.mediaId).toBe('MEDIA_ID_1');
    expect(e.msg.mimeType).toContain('audio/ogg');
    expect(e.msg.phoneE164).toBe('41799990000'); // strips "+" and spaces
  });

  it('marks echoes as outbound and uses `to` field as counter-party', () => {
    const events = parseWebhook(echoEnvelope());
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.type).toBe('echo');
    if (e.type !== 'echo') throw new Error('unreachable');
    expect(e.msg.direction).toBe('outbound');
    expect(e.msg.isEcho).toBe(true);
    expect(e.msg.text).toBe('Gern, bis morgen!');
    expect(e.msg.phoneE164).toBe('41798880000');
  });

  it('parses delivery-status updates', () => {
    const events = parseWebhook(statusEnvelope());
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.type).toBe('status');
    if (e.type !== 'status') throw new Error('unreachable');
    expect(e.messageId).toBe('wamid.OUTBOUND');
    expect(e.status).toBe('delivered');
  });

  it('returns [] for malformed or empty payloads', () => {
    expect(parseWebhook(null)).toEqual([]);
    expect(parseWebhook({})).toEqual([]);
    expect(parseWebhook({ entry: 'not-an-array' })).toEqual([]);
    expect(parseWebhook({ entry: [{ changes: 'nope' }] })).toEqual([]);
  });

  it('skips messages missing required fields', () => {
    const events = parseWebhook({
      entry: [{
        changes: [{
          value: { messages: [{ type: 'text', text: { body: 'no id or from' } }] },
        }],
      }],
    });
    expect(events).toEqual([]);
  });
});

describe('threadIdForPhone', () => {
  it('produces a stable prefix', () => {
    expect(threadIdForPhone('41791234567')).toBe('whatsapp-41791234567');
  });
});
