import { describe, expect, it } from 'vitest';
import {
  analyzeSensitiveContent,
  detectSensitiveContent,
  reasonForCategories,
} from './sensitive-content.js';

function check(input: { subject?: string; body?: string }): ReturnType<typeof detectSensitiveContent> {
  return detectSensitiveContent({ subject: input.subject ?? '', body: input.body ?? '' });
}

describe('detectSensitiveContent — negatives', () => {
  it('returns negative on empty input', () => {
    expect(check({})).toEqual({ isSensitive: false, categories: [] });
    expect(check({ subject: '   ', body: '' })).toEqual({ isSensitive: false, categories: [] });
  });

  it('does not flag a normal business mail with order numbers', () => {
    const out = check({
      subject: 'Bestellung #INV-2026-0042',
      body: 'Vielen Dank für deine Bestellung mit der Referenz 4711-8839.',
    });
    expect(out.isSensitive).toBe(false);
  });

  it('does not flag a 4-digit number without an OTP keyword', () => {
    const out = check({ subject: 'Termin um 14:30', body: 'Wir treffen uns Punkt 1430.' });
    expect(out.isSensitive).toBe(false);
  });

  it('does not flag a non-Luhn 16-digit run', () => {
    // Sequential digits — not a valid card.
    const out = check({ subject: 'Bestellnummer', body: '1234567812345678' });
    expect(out.isSensitive).toBe(false);
  });
});

describe('detectSensitiveContent — OTP / 2FA', () => {
  it('flags a German OTP message', () => {
    const out = check({
      subject: 'Dein Sicherheitscode',
      body: 'Bestätigungscode: 482917 — gültig für 5 Minuten.',
    });
    expect(out.isSensitive).toBe(true);
    expect(out.categories).toContain('otp_or_2fa');
  });

  it('flags an English 2FA mail', () => {
    const out = check({
      subject: 'Your verification code',
      body: 'Use 8472 to sign in.',
    });
    expect(out.categories).toContain('otp_or_2fa');
  });

  it('flags a TAN mail (banking)', () => {
    const out = check({
      subject: 'Ihre TAN für die Überweisung',
      body: 'TAN 12345678',
    });
    expect(out.categories).toContain('otp_or_2fa');
  });

  it('does not flag the OTP keyword alone without a digit run', () => {
    const out = check({ subject: 'Two-factor reminder', body: 'Please enable 2FA.' });
    expect(out.isSensitive).toBe(false);
  });
});

describe('detectSensitiveContent — password reset', () => {
  it('flags a German reset-password mail', () => {
    const out = check({
      subject: 'Passwort zurücksetzen',
      body: 'Klicke auf den Link um dein Passwort zurückzusetzen.',
    });
    expect(out.categories).toContain('password_reset');
  });

  it('flags a magic-link sign-in mail', () => {
    const out = check({
      subject: 'Your sign-in link',
      body: 'Click the magic link to log in.',
    });
    expect(out.categories).toContain('password_reset');
  });
});

describe('detectSensitiveContent — secrets', () => {
  it('flags an Anthropic-style API key', () => {
    const out = check({ subject: 'API key for testing', body: 'Use sk-ant-api03-AbCdEfGhIjKlMnOpQrSt' });
    expect(out.categories).toContain('api_key_or_secret');
  });

  it('flags a Slack token', () => {
    const out = check({ subject: 'Token', body: 'xoxb-1234567890-abcdefghij' });
    expect(out.categories).toContain('api_key_or_secret');
  });

  it('flags a GitHub PAT', () => {
    const out = check({ subject: 'PAT', body: `ghp${'_'}AbCdEfGhIjKlMnOpQrStUvWxYz0123456789` });
    expect(out.categories).toContain('api_key_or_secret');
  });

  it('flags an AWS access key', () => {
    const out = check({ subject: 'AWS', body: 'AKIAIOSFODNN7EXAMPLE' });
    expect(out.categories).toContain('api_key_or_secret');
  });

  it('flags a Bearer token', () => {
    const out = check({ subject: 'Auth', body: 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9-payload' });
    expect(out.categories).toContain('api_key_or_secret');
  });

  it('flags a JWT', () => {
    const out = check({
      subject: 'Token',
      body: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
    });
    expect(out.categories).toContain('api_key_or_secret');
  });

  it('flags a Stripe-style underscore live key', () => {
    const out = check({ subject: 'Customer', body: 'sk_live_abcdefghijklmnopqrstuv expired' });
    expect(out.categories).toContain('api_key_or_secret');
  });

  it('flags a Stripe-style underscore test key', () => {
    const out = check({ subject: 'Test', body: 'sk_test_abcdefghijklmnopqrstuv' });
    expect(out.categories).toContain('api_key_or_secret');
  });

  it('flags a Stripe webhook secret', () => {
    const out = check({ subject: 'Webhook', body: 'whsec_test_abcdefghijklmnopqrstuv' });
    expect(out.categories).toContain('api_key_or_secret');
  });
});

describe('detectSensitiveContent — IBAN case-insensitivity', () => {
  it('flags a lowercase IBAN', () => {
    const out = check({ subject: 'Rechnung', body: 'Bitte überweisen auf ch9300762011623852957.' });
    expect(out.categories).toContain('iban');
  });

  it('flags a mixed-case IBAN', () => {
    const out = check({ subject: 'Pay', body: 'Account: Ch9300762011623852957 today' });
    expect(out.categories).toContain('iban');
  });
});

describe('detectSensitiveContent — IBAN / credit card', () => {
  it('flags a Swiss IBAN', () => {
    const out = check({ subject: 'Rechnung', body: 'Bitte überweisen auf CH9300762011623852957.' });
    expect(out.categories).toContain('iban');
  });

  it('flags a Luhn-valid credit card number', () => {
    // Visa test number — Luhn-valid
    const out = check({ subject: 'Card', body: 'Karte 4111 1111 1111 1111 läuft ab.' });
    expect(out.categories).toContain('credit_card');
  });

  it('does not flag an IBAN-shaped string without letters', () => {
    const out = check({ subject: 'Ref', body: '1234567890123456789' });
    expect(out.categories).not.toContain('iban');
  });
});

describe('detectSensitiveContent — multi-category + reason', () => {
  it('reports every category that fires', () => {
    const out = check({
      subject: 'Password reset code',
      body: 'reset password — code 482917',
    });
    expect(out.categories).toEqual(expect.arrayContaining(['otp_or_2fa', 'password_reset']));
  });

  it('builds a German reason listing the categories', () => {
    expect(reasonForCategories(['otp_or_2fa']))
      .toBe('Mail enthält OTP/2FA-Code — nicht an Klassifizierer gesendet, manuell prüfen.');
    expect(reasonForCategories(['credit_card', 'iban']))
      .toContain('Kreditkarten-Nummer, IBAN');
  });

  it('reasonForCategories handles the empty list gracefully', () => {
    expect(reasonForCategories([])).toContain('sensible Daten');
  });
});

describe('analyzeSensitiveContent — masking', () => {
  it('redacts OTP digit runs in subject and body', () => {
    const out = analyzeSensitiveContent({
      subject: 'Sicherheitscode 482917',
      body: 'Verification code: 482917 expires in 5 minutes.',
    });
    expect(out.isSensitive).toBe(true);
    expect(out.masked.subject).toBe('Sicherheitscode [REDACTED:OTP]');
    expect(out.masked.body).toContain('[REDACTED:OTP]');
    expect(out.masked.body).not.toContain('482917');
    expect(out.masked.redactionCount).toBeGreaterThanOrEqual(2);
  });

  it('redacts API key but keeps surrounding context', () => {
    const out = analyzeSensitiveContent({
      subject: 'API key for testing',
      body: 'Hier dein Schlüssel: sk-ant-api03-AbCdEfGhIjKlMnOpQrSt — bitte nicht teilen.',
    });
    expect(out.masked.body).toContain('Hier dein Schlüssel:');
    expect(out.masked.body).toContain('[REDACTED:SECRET]');
    expect(out.masked.body).toContain('bitte nicht teilen');
    expect(out.masked.body).not.toContain('sk-ant-api03');
  });

  it('redacts a credit-card number while keeping the surrounding sentence', () => {
    const out = analyzeSensitiveContent({
      subject: 'Card on file',
      body: 'Karte 4111 1111 1111 1111 läuft im Mai ab.',
    });
    expect(out.masked.body).toContain('Karte');
    expect(out.masked.body).toContain('[REDACTED:CARD]');
    expect(out.masked.body).toContain('läuft im Mai ab');
    expect(out.masked.body).not.toContain('4111');
  });

  it('redacts an IBAN', () => {
    const out = analyzeSensitiveContent({
      subject: 'Rechnung',
      body: 'Bitte überweisen auf CH9300762011623852957 bis 31.05.',
    });
    expect(out.masked.body).toContain('[REDACTED:IBAN]');
    expect(out.masked.body).not.toContain('CH9300762011623852957');
    expect(out.masked.body).toContain('bis 31.05');
  });

  it('redacts password-reset URLs', () => {
    const out = analyzeSensitiveContent({
      subject: 'Reset your password',
      body: 'Click https://example.com/auth/reset?token=abcdef123456 to reset your password.',
    });
    expect(out.masked.body).toContain('[REDACTED:RESET-LINK]');
    expect(out.masked.body).not.toContain('token=abcdef');
    expect(out.masked.body).toContain('to reset your password');
  });

  it('returns the original input untouched when nothing matches', () => {
    const out = analyzeSensitiveContent({
      subject: 'Lunch tomorrow?',
      body: 'Free at 12:30, pick a place.',
    });
    expect(out.isSensitive).toBe(false);
    expect(out.masked.subject).toBe('Lunch tomorrow?');
    expect(out.masked.body).toBe('Free at 12:30, pick a place.');
    expect(out.masked.redactionCount).toBe(0);
  });

  it('counts every redaction it applied', () => {
    const out = analyzeSensitiveContent({
      subject: 'Code 482917',
      body: 'OTP 482917 and second code 654321',
    });
    expect(out.masked.redactionCount).toBeGreaterThanOrEqual(3);
  });
});
