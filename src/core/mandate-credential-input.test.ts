/**
 * `mandateCredentialInput`: which typed text of a
 * mandate's helper reads as carrying a key. One witness per rule, and a list of the helper's
 * ordinary messages that must pass: a refusal swallows the helper's message, so a false alarm is
 * the expensive error. Keys are built at runtime: a key-shaped literal is what the commit-time
 * secret scan looks for, and this repo is public.
 */
import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { MANDATE_KEY_INPUT_REFUSAL, mandateCredentialInput, maskCredentialInput } from './secret-store.js';

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const HEX = '0123456789abcdef';
const rnd = (n: number, alphabet: string): string => [...randomBytes(n)].map((b) => alphabet[b % alphabet.length]).join('');
/** Mixed classes guaranteed, whatever the random draw. */
const mixed = (n: number): string => `Aa1${rnd(n - 3, ALNUM)}`;

describe('MANDATE_KEY_INPUT_REFUSAL', () => {
  it('reads verbatim (ux U-150, English, without the text put back)', () => {
    expect(MANDATE_KEY_INPUT_REFUSAL).toBe('Your input was not sent because it contains something that looks like a key, token or password. lynox does not take any in this chat. Only the owner of this instance stores keys, in a chat of their own; ask the owner to store it there. If it was not a key, send your input again without the part that looks like one.');
  });
});

describe('mandateCredentialInput', () => {
  it('rule 1: a vendor shape the run route already masks', () => {
    const typed = `Hier: shpat_${rnd(32, HEX)}`;
    expect(maskCredentialInput(typed).labels.length).toBeGreaterThan(0);
    expect(mandateCredentialInput(typed)).toBe('Shopify token');
  });

  it('rule 2: a bearer header and user:pass in a URL', () => {
    expect(mandateCredentialInput(`Authorization: Bearer ${mixed(40)}`)).toBe('bearer token');
    expect(mandateCredentialInput(`https://admin:${mixed(16)}@shop.example.org/api`)).toBe('credential in URL');
  });

  it('rule 3: a value-shaped word within four words after a cue word, on the same line', () => {
    const key = mixed(32);
    expect(mandateCredentialInput(`API-Key: ${key}`)).toBe('credential after a cue word');
    expect(mandateCredentialInput(`Der Token lautet ${key}`)).toBe('credential after a cue word');
    expect(mandateCredentialInput(`Client Secret: ${rnd(4, ALNUM)}8Q~${rnd(30, ALNUM)}`)).toBe('credential after a cue word');
    // Same value, but five words after the cue, or on the next line: not this rule.
    expect(mandateCredentialInput(`Der Token ist bei mir und zwar ${rnd(32, HEX)}`)).toBeNull();
    expect(mandateCredentialInput(`Der Token:\n${rnd(32, HEX)} und mehr`)).toBeNull();
  });

  it('rule 3, password: only where it is plainly the value', () => {
    expect(mandateCredentialInput('Das Passwort ist Sommer2026!Shop')).toBe('password');
    expect(mandateCredentialInput('Passwort lautet: Wald#Haus77')).toBe('password');
    expect(mandateCredentialInput('The password is Tr0ub4dor&3x')).toBe('password');
    expect(mandateCredentialInput('My most-used password manager is 1Password with a work vault.')).toBeNull();
  });

  it('rule 4: a key pasted on its own, a code fence around it allowed', () => {
    const key = mixed(36);
    expect(mandateCredentialInput(key)).toBe('credential on its own');
    expect(mandateCredentialInput(`  ${key}\n`)).toBe('credential on its own');
    expect(mandateCredentialInput(`\`\`\`\n${key}\n\`\`\``)).toBe('credential on its own');
    // Under 20 characters, or no unbroken run of 16 with all three classes: not a key on its own.
    expect(mandateCredentialInput(mixed(19))).toBeNull();
    expect(mandateCredentialInput('S6-standing-practice-v2')).toBeNull();
  });

  it('names no part of the text it read', () => {
    const key = mixed(32);
    for (const typed of [`API-Key: ${key}`, key, 'Das Passwort ist Sommer2026!Shop']) {
      const label = mandateCredentialInput(typed)!;
      expect(label).not.toBeNull();
      expect(typed).not.toContain(label);
      expect(label).not.toContain(key.slice(-6));
    }
  });

  it('not caught: a bare lower-case or hex key without a cue word', () => {
    expect(mandateCredentialInput(rnd(32, HEX))).toBeNull();
    expect(mandateCredentialInput(`pat-eu1-${rnd(8, HEX)}-${rnd(4, HEX)}-${rnd(4, HEX)}-${rnd(4, HEX)}-${rnd(12, HEX)}`)).toBeNull();
  });

  // The helper's ordinary messages while setting up an instance. Each one passes.
  const ORDINARY = [
    'Bestellung #100234 ist noch offen, kannst du sie prüfen?',
    'gid://shopify/Order/5523419087123',
    'Sendungsnummer 00340434161094042557',
    'Tracking 1Z999AA10123456784',
    'SKUs: AC-FLT-2000-BLK, AC-FLT-2000-WHT, AC-CRT-0500',
    'Der Fehler kam mit Commit 3f9a1c2e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39',
    '3f9a1c2e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39',
    'Prüfsumme: 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    'Die Kunden-ID ist 3b241101-e2bb-4255-8caf-4136c566a962',
    '3b241101-e2bb-4255-8caf-4136c566a962',
    'https://shop.example.org/produkt?utm_source=newsletter&utm_campaign=herbst2026',
    'https://cdn.example.org/f.pdf?X-Amz-Signature=8a6f2c3e9b1d4f7a0c5e8b2d6f9a3c1e7b4d0f2a6c8e1b3d5f7a9c0e2b4d6f8a&X-Amz-Expires=3600',
    'https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit',
    'IBAN CH93 0076 2011 6238 5295 7',
    'Rechnung RE-2026-11-000482, QR-Referenz 210000000003139471430009017',
    'Donaudampfschifffahrtsgesellschaftskapitänsmütze',
    'acme-wasserfilter-2000-schwarz-mit-kartusche-und-halterung',
    'sha512-Q8x7ZJ0yK4b9mN2pR5tV8wA1cD3eF6gH9iJ2kL5mN8oP1qR4sT7uV0wX3yZ6aB9cD2eF5gH8iJ1kL4mN7oP0q==',
    'Kampagne ID: AbCdEfGh12345678IjKlMnOp90',
    'Ich habe den API-Key, aber ich gebe ihn lieber dem Inhaber.',
    'Der Token liegt beim Inhaber unter SHOPIFY_ADMIN_API_TOKEN.',
    'Nimm den Key secret:STRIPE_SECRET_KEY aus dem Vault.',
    'Key-Account: Müller AG, Ansprechpartnerin Frau Keller',
    'Der Token-Status ist abgelaufen, seit dem 03.11.2026.',
    'Passwort vergessen? Der Link: https://shop.example.org/account/reset?id=8823',
    'Das Modell hat 12345 Token verbraucht, Kosten 0.02 USD.',
    'Schlüssel-Anhänger Art. AC-KEY-2026-RED kostet 12.90',
    'Die API-Key-Doku: https://shopify.dev/docs/apps/auth/admin-app-access-tokens',
    'https://shop.example.org/products/filter-2000?variant=4412',
  ];
  it.each(ORDINARY)('passes an ordinary message: %s', (text) => {
    expect(mandateCredentialInput(text)).toBeNull();
  });
});
