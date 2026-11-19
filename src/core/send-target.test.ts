import { describe, expect, it } from 'vitest';
import {
  hostTargets,
  mailTargets,
  normalizeHostName,
  normalizeHostTarget,
  normalizeMailTarget,
  UnknownSendTargetError,
} from './send-target.js';
import { InMemoryMailRegistry } from '../integrations/mail/tools/registry.js';
import { createMailSendTool } from '../integrations/mail/tools/mail-send.js';
import { createMailReplyTool } from '../integrations/mail/tools/mail-reply.js';
import { httpRequestTool } from '../tools/builtin/http.js';
import { createDriveTool } from '../integrations/google/google-drive.js';
import { createCalendarTool } from '../integrations/google/google-calendar.js';

const values = (targets: readonly { value: string }[] | null | undefined): string[] | null =>
  targets == null ? null : targets.map((t) => t.value);

describe('send target normalization', () => {
  it('lower-cases a mail address and maps an international domain to punycode', () => {
    expect(normalizeMailTarget('  Anna@Müller.CH ')).toEqual({ kind: 'mail', value: 'anna@xn--mller-kva.ch' });
    expect(normalizeMailTarget('anna@xn--mller-kva.ch')).toEqual({ kind: 'mail', value: 'anna@xn--mller-kva.ch' });
  });

  it('drops a trailing dot on a mail domain and on a host', () => {
    expect(normalizeMailTarget('anna@firma.ch.')?.value).toBe('anna@firma.ch');
    expect(normalizeHostName('Firma.CH.')).toBe('firma.ch');
    expect(normalizeHostTarget('https://firma.ch./x')?.value).toBe('firma.ch');
  });

  it('maps an international host to punycode, from a URL and from a bare name alike', () => {
    expect(normalizeHostName('müller.ch')).toBe('xn--mller-kva.ch');
    expect(normalizeHostTarget('https://müller.ch/path')?.value).toBe('xn--mller-kva.ch');
    expect(normalizeHostTarget('https://XN--MLLER-KVA.ch/')?.value).toBe('xn--mller-kva.ch');
  });

  it('keeps distinct hosts distinct: no suffix, no subdomain folding', () => {
    expect(normalizeHostName('evil-firma.ch')).not.toBe(normalizeHostName('firma.ch'));
    expect(normalizeHostName('x.firma.ch')).not.toBe(normalizeHostName('firma.ch'));
    expect(normalizeMailTarget('max@firma.ch')?.value).not.toBe(normalizeMailTarget('x@firma.ch')?.value);
  });

  it('rejects what is not an address or a host', () => {
    expect(normalizeMailTarget('no-at-sign')).toBeNull();
    expect(normalizeMailTarget('@firma.ch')).toBeNull();
    expect(normalizeMailTarget('anna@')).toBeNull();
    expect(normalizeMailTarget('a b@firma.ch')).toBeNull();
    expect(normalizeHostName('')).toBeNull();
    expect(normalizeHostName('firma ch')).toBeNull();
    expect(normalizeHostTarget('not a url')).toBeNull();
  });

  it('treats a host built from a stored secret as unreadable', () => {
    expect(normalizeHostTarget('https://secret:HOST/x')).toBeNull();
    expect(() => hostTargets('https://secret:HOST/x')).toThrow(UnknownSendTargetError);
  });

  it('throws for the whole list when one address cannot be read', () => {
    expect(() => mailTargets(['anna@firma.ch', 'nonsense'])).toThrow(UnknownSendTargetError);
  });
});

describe('sendTargets on the sending tools', () => {
  const registry = new InMemoryMailRegistry();

  it('mail_send names every recipient in to, cc and bcc', () => {
    const tool = createMailSendTool(registry);
    const targets = tool.sendTargets?.({
      to: 'Anna <Anna@Firma.ch>, bob@firma.ch',
      cc: 'carla@müller.ch',
      bcc: 'dora@firma.ch',
      subject: 's',
      body: 'b',
    });
    expect(values(targets)).toEqual(['anna@firma.ch', 'bob@firma.ch', 'carla@xn--mller-kva.ch', 'dora@firma.ch']);
    expect(targets?.every((t) => t.kind === 'mail')).toBe(true);
  });

  it('mail_send drops a recipient with a line break, as its handler does', () => {
    const tool = createMailSendTool(registry);
    expect(values(tool.sendTargets?.({ to: 'anna@firma.ch, evil@x.ch\r\nBcc: z@y.ch', subject: 's', body: 'b' }))).toEqual(['anna@firma.ch']);
  });

  it('mail_reply names only the to and cc overrides', () => {
    const tool = createMailReplyTool(registry);
    expect(values(tool.sendTargets?.({ uid: 1, body: 'b' }))).toEqual([]);
    expect(values(tool.sendTargets?.({ uid: 1, body: 'b', to: 'Anna@Firma.ch', cc: 'bob@firma.ch' }))).toEqual(['anna@firma.ch', 'bob@firma.ch']);
  });

  it('http_request names the host of a write and nothing for a read', () => {
    const send = httpRequestTool.sendTargets;
    expect(values(send?.({ url: 'https://Api.Firma.ch/v1/x', method: 'POST', body: '{}' }))).toEqual(['api.firma.ch']);
    expect(send?.({ url: 'https://api.firma.ch/v1/x', method: 'POST', body: '{}' })?.[0]?.kind).toBe('host');
    expect(values(send?.({ url: 'https://api.firma.ch/v1/x', method: 'DELETE' }))).toEqual(['api.firma.ch']);
    expect(send?.({ url: 'https://api.firma.ch/v1/x' })).toBeNull();
    expect(send?.({ url: 'https://api.firma.ch/v1/x', method: 'GET' })).toBeNull();
  });

  it('http_request names the host when a GET carries a write override', () => {
    const send = httpRequestTool.sendTargets;
    expect(values(send?.({ url: 'https://api.firma.ch/x', method: 'GET', headers: { 'X-HTTP-Method-Override': 'DELETE' } }))).toEqual(['api.firma.ch']);
  });

  it('google_drive names the address a share sends to, and nothing for other actions', () => {
    const tool = createDriveTool(() => null);
    expect(values(tool.sendTargets?.({ action: 'share', file_id: 'f', email: 'Anna@Firma.ch' }))).toEqual(['anna@firma.ch']);
    expect(values(tool.sendTargets?.({ action: 'share', file_id: 'f' }))).toEqual([]);
    expect(tool.sendTargets?.({ action: 'search', query: 'x' })).toBeNull();
    expect(tool.sendTargets?.({ action: 'move', file_id: 'f', target_folder_id: 'g' })).toBeNull();
  });

  it('google_calendar names the guests of a new event', () => {
    const tool = createCalendarTool(() => null);
    expect(values(tool.sendTargets?.({
      action: 'create_event', start: '2026-12-01T10:00:00', end: '2026-12-01T11:00:00', attendees: ['Anna@Firma.ch'],
    }))).toEqual(['anna@firma.ch']);
    expect(values(tool.sendTargets?.({ action: 'create_event', start: '2026-12-01T10:00:00', end: '2026-12-01T11:00:00' }))).toEqual([]);
  });

  it('google_calendar names guests given inside updates.attendees on an update', () => {
    const tool = createCalendarTool(() => null);
    expect(values(tool.sendTargets?.({
      action: 'update_event', event_id: 'e', updates: { attendees: [{ email: 'Anna@Firma.ch' }, 'bob@firma.ch'] },
    }))).toEqual(['anna@firma.ch', 'bob@firma.ch']);
    expect(values(tool.sendTargets?.({ action: 'update_event', event_id: 'e', attendees: ['carla@firma.ch'] }))).toEqual(['carla@firma.ch']);
    expect(tool.sendTargets?.({ action: 'list_events' })).toBeNull();
    expect(tool.sendTargets?.({ action: 'delete_event', event_id: 'e' })).toBeNull();
  });
});
