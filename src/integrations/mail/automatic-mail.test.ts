import { describe, expect, it } from 'vitest';
import { automaticMail } from './automatic-mail.js';

/** A header lookup over a plain record, any case, as the providers do. */
function headers(h: Record<string, string>): (name: string) => string | undefined {
  const lower = new Map(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
  return (name) => lower.get(name.toLowerCase());
}

describe('automaticMail: each header form of an automatic reply is marked', () => {
  const replies: Array<[string, Record<string, string>]> = [
    ['Auto-Submitted: auto-replied', { 'Auto-Submitted': 'auto-replied' }],
    ['X-Autoreply: yes', { 'X-Autoreply': 'yes' }],
    ['X-Autorespond with the responder address', { 'X-Autorespond': 'office@example.com' }],
    ['Precedence: auto_reply', { Precedence: 'auto_reply' }],
    ['Precedence: Auto_Reply (any case)', { Precedence: ' Auto_Reply ' }],
  ];
  for (const [name, h] of replies) {
    it(`${name} is an automatic reply to a message`, () => {
      expect(automaticMail(headers(h))).toEqual({ isAutoReply: true, isAutoReplied: true });
    });
  }

  it('Auto-Submitted: auto-generated is automatic, but not a reply to a message', () => {
    expect(automaticMail(headers({ 'Auto-Submitted': 'auto-generated' }))).toEqual({ isAutoReply: true, isAutoReplied: false });
  });

  it('a delivery status report (a bounce) without Auto-Submitted is automatic, but not a reply', () => {
    for (const ct of [
      'multipart/report; report-type=delivery-status; boundary="b1"',
      'Multipart/Report; boundary="b1"; Report-Type="delivery-status"',
      'multipart/report;report-type=delivery-status',
    ]) {
      expect(automaticMail(headers({ 'Content-Type': ct })), ct).toEqual({ isAutoReply: true, isAutoReplied: false });
    }
  });
});

describe('automaticMail: mail a person writes stays answerable', () => {
  it('X-Auto-Response-Suppress alone does not mark the mail (Outlook sets it on mail people write)', () => {
    expect(automaticMail(headers({ 'X-Auto-Response-Suppress': 'All' }))).toEqual({ isAutoReply: false, isAutoReplied: false });
  });

  it('no header, Auto-Submitted: no, or an X-Autoreply that says no is not automatic', () => {
    for (const h of [{}, { 'Auto-Submitted': 'no' }, { 'X-Autoreply': 'no' }, { 'X-Autorespond': 'false' }, { 'X-Autoreply': '' }]) {
      expect(automaticMail(headers(h)), JSON.stringify(h)).toEqual({ isAutoReply: false, isAutoReplied: false });
    }
  });

  it('a mailing list or a newsletter (Precedence: list, bulk, junk) is not marked by this check', () => {
    for (const p of ['list', 'bulk', 'junk']) {
      expect(automaticMail(headers({ Precedence: p })), p).toEqual({ isAutoReply: false, isAutoReplied: false });
    }
  });

  it('a report of another kind (a read receipt) or a mixed message is not a bounce', () => {
    for (const ct of [
      'multipart/report; report-type=disposition-notification; boundary="b"',
      'multipart/mixed; boundary="b"',
      'text/plain; charset=utf-8; report-type=delivery-status',
      'multipart/reportx; report-type=delivery-status',
    ]) {
      expect(automaticMail(headers({ 'Content-Type': ct })), ct).toEqual({ isAutoReply: false, isAutoReplied: false });
    }
  });
});
