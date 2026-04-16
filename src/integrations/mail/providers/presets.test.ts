import { describe, expect, it, vi } from 'vitest';
import {
  autodiscover,
  buildCustomAccount,
  buildPresetAccount,
  describePreset,
  listPresets,
  parseAutoconfigXml,
} from './presets.js';
import { MailError } from '../provider.js';

describe('describePreset / listPresets', () => {
  it('returns hardcoded servers for each known preset', () => {
    expect(describePreset('gmail').imap).toEqual({ host: 'imap.gmail.com', port: 993, secure: true });
    expect(describePreset('gmail').smtp).toEqual({ host: 'smtp.gmail.com', port: 465, secure: true });
    expect(describePreset('icloud').smtp).toEqual({ host: 'smtp.mail.me.com', port: 587, secure: false });
    expect(describePreset('fastmail').imap).toEqual({ host: 'imap.fastmail.com', port: 993, secure: true });
    expect(describePreset('yahoo').smtp).toEqual({ host: 'smtp.mail.yahoo.com', port: 465, secure: true });
    expect(describePreset('outlook').smtp).toEqual({ host: 'smtp-mail.outlook.com', port: 587, secure: false });
  });

  it('marks 2FA-required presets', () => {
    expect(describePreset('gmail').requires2FA).toBe(true);
    expect(describePreset('icloud').requires2FA).toBe(true);
    expect(describePreset('outlook').requires2FA).toBe(true);
    expect(describePreset('fastmail').requires2FA).toBe(false);
  });

  it('returns app-password URLs for everything except custom', () => {
    expect(describePreset('gmail').appPasswordUrl).toContain('myaccount.google.com');
    expect(describePreset('custom').appPasswordUrl).toBeUndefined();
    expect(describePreset('custom').custom).toBe(true);
  });

  it('listPresets enumerates all six in stable order', () => {
    const slugs = listPresets().map(p => p.slug);
    expect(slugs).toEqual(['gmail', 'icloud', 'fastmail', 'yahoo', 'outlook', 'custom']);
  });
});

describe('buildPresetAccount', () => {
  it('produces a complete MailAccountConfig from a preset slug', () => {
    const account = buildPresetAccount('gmail', {
      id: 'rafael-gmail',
      displayName: 'Rafael',
      address: 'rafael@gmail.com',
    });
    expect(account.preset).toBe('gmail');
    expect(account.imap.host).toBe('imap.gmail.com');
    expect(account.smtp.host).toBe('smtp.gmail.com');
    expect(account.auth).toBe('app-password');
    expect(account.id).toBe('rafael-gmail');
  });
});

describe('buildCustomAccount', () => {
  it('rejects empty hosts', () => {
    expect(() => buildCustomAccount({
      id: 'x',
      displayName: 'X',
      address: 'x@x.com',
      imap: { host: '', port: 993, secure: true },
      smtp: { host: 'smtp.x.com', port: 465, secure: true },
    })).toThrow(MailError);
  });

  it('passes through valid custom servers', () => {
    const account = buildCustomAccount({
      id: 'self',
      displayName: 'Self-Hosted',
      address: 'me@my-domain.eu',
      imap: { host: 'imap.my-domain.eu', port: 993, secure: true },
      smtp: { host: 'smtp.my-domain.eu', port: 587, secure: false },
    });
    expect(account.preset).toBe('custom');
    expect(account.imap.host).toBe('imap.my-domain.eu');
    expect(account.smtp.secure).toBe(false);
  });
});

describe('parseAutoconfigXml', () => {
  it('extracts the first IMAP+SMTP pair with TLS', () => {
    const xml = `
      <clientConfig version="1.1">
        <emailProvider id="example.com">
          <incomingServer type="pop3"><hostname>pop.example.com</hostname><port>995</port><socketType>SSL</socketType></incomingServer>
          <incomingServer type="imap">
            <hostname>imap.example.com</hostname>
            <port>993</port>
            <socketType>SSL</socketType>
            <username>%EMAILADDRESS%</username>
          </incomingServer>
          <outgoingServer type="smtp">
            <hostname>smtp.example.com</hostname>
            <port>465</port>
            <socketType>SSL</socketType>
            <username>%EMAILADDRESS%</username>
          </outgoingServer>
        </emailProvider>
      </clientConfig>
    `;
    const result = parseAutoconfigXml(xml);
    expect(result.imap).toEqual({ host: 'imap.example.com', port: 993, secure: true });
    expect(result.smtp).toEqual({ host: 'smtp.example.com', port: 465, secure: true });
    expect(result.usernamePattern).toBe('%EMAILADDRESS%');
  });

  it('accepts STARTTLS as secure=false', () => {
    const xml = `
      <clientConfig><emailProvider id="x">
        <incomingServer type="imap"><hostname>imap.x.com</hostname><port>143</port><socketType>STARTTLS</socketType></incomingServer>
        <outgoingServer type="smtp"><hostname>smtp.x.com</hostname><port>587</port><socketType>STARTTLS</socketType></outgoingServer>
      </emailProvider></clientConfig>
    `;
    const result = parseAutoconfigXml(xml);
    expect(result.imap.secure).toBe(false);
    expect(result.imap.port).toBe(143);
    expect(result.smtp.port).toBe(587);
  });

  it('skips plaintext (no socketType) entries', () => {
    const xml = `
      <clientConfig><emailProvider id="x">
        <incomingServer type="imap"><hostname>plain.x.com</hostname><port>143</port><socketType>plain</socketType></incomingServer>
        <incomingServer type="imap"><hostname>imap.x.com</hostname><port>993</port><socketType>SSL</socketType></incomingServer>
        <outgoingServer type="smtp"><hostname>smtp.x.com</hostname><port>465</port><socketType>SSL</socketType></outgoingServer>
      </emailProvider></clientConfig>
    `;
    const result = parseAutoconfigXml(xml);
    expect(result.imap.host).toBe('imap.x.com');
  });

  it('throws when IMAP block is missing', () => {
    const xml = `<clientConfig><emailProvider id="x">
      <outgoingServer type="smtp"><hostname>smtp.x.com</hostname><port>465</port><socketType>SSL</socketType></outgoingServer>
    </emailProvider></clientConfig>`;
    expect(() => parseAutoconfigXml(xml)).toThrow(MailError);
  });
});

describe('autodiscover', () => {
  it('rejects malformed addresses', async () => {
    const fakeFetch = vi.fn();
    await expect(autodiscover('not-an-email', fakeFetch as unknown as typeof fetch)).rejects.toBeInstanceOf(MailError);
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it('hits the thunderbird endpoint and parses the response', async () => {
    const xml = `<clientConfig><emailProvider id="example.com">
      <incomingServer type="imap"><hostname>imap.example.com</hostname><port>993</port><socketType>SSL</socketType></incomingServer>
      <outgoingServer type="smtp"><hostname>smtp.example.com</hostname><port>465</port><socketType>SSL</socketType></outgoingServer>
    </emailProvider></clientConfig>`;
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(xml),
    } as unknown as Response);

    const result = await autodiscover('me@example.com', fakeFetch as unknown as typeof fetch);
    expect(fakeFetch).toHaveBeenCalledTimes(1);
    expect(String(fakeFetch.mock.calls[0]?.[0])).toContain('autoconfig.thunderbird.net/v1.1/example.com');
    expect(result.imap.host).toBe('imap.example.com');
  });

  it('maps non-OK response to MailError(not_found)', async () => {
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve(''),
    } as unknown as Response);
    const err = await autodiscover('me@unknown.tld', fakeFetch as unknown as typeof fetch).catch(e => e as MailError);
    expect(err).toBeInstanceOf(MailError);
    expect(err.code).toBe('not_found');
  });

  it('wraps network errors as MailError(connection_failed)', async () => {
    const fakeFetch = vi.fn().mockRejectedValue(new Error('ENOTFOUND'));
    const err = await autodiscover('me@example.com', fakeFetch as unknown as typeof fetch).catch(e => e as MailError);
    expect(err.code).toBe('connection_failed');
  });
});
