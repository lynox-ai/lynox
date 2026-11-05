/**
 * `mandateCredentialInput`: which typed text of a
 * mandate's helper reads as carrying a key. One witness per rule, and a list of the helper's
 * ordinary messages that must pass: a refusal swallows the helper's message, so a false alarm is
 * the expensive error. Keys are built at runtime: a key-shaped literal is what the commit-time
 * secret scan looks for, and this repo is public. They are deterministic: drawn from a fixed
 * seed, so every run tests the same strings and a result does not depend on the draw.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { MANDATE_KEY_INPUT_REFUSAL, mandateCredentialInput, maskCredentialInput } from './secret-store.js';

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const HEX = '0123456789abcdef';
/** A deterministic character source: a SHA-256 counter stream from `seed`. */
function seeded(seed: string): (n: number, alphabet: string) => string {
  let block = 0;
  let pool: number[] = [];
  return (n, alphabet) => {
    let out = '';
    while (out.length < n) {
      if (pool.length === 0) pool = [...createHash('sha256').update(`${seed}:${block++}`).digest()];
      out += alphabet[pool.shift()! % alphabet.length];
    }
    return out;
  };
}
const rnd = seeded('mandate-credential-input');
/** A hex key that does not depend on the draw, so a rule's witness tests the rule. How often a
 *  fully drawn key gets through is pinned in the rate test below. */
const hexKey = (n: number): string => `9f3a0c7e1b5d2864${rnd(n - 16, HEX)}`;
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

  it('rule 1: the further vendor shapes, which the run route\'s mask does not know', () => {
    const uuid = `${rnd(8, HEX)}-${rnd(4, HEX)}-${rnd(4, HEX)}-${rnd(4, HEX)}-${rnd(12, HEX)}`;
    for (const [typed, label] of [
      [`pat-eu1-${uuid}`, 'HubSpot private app token'],
      [`${'c'}${'s'}_${rnd(40, HEX)}`, 'WooCommerce key'],
      [`${rnd(32, HEX)}-us21`, 'Mailchimp API key'],
      [`${'S'}${'G'}.${rnd(22, ALNUM)}.${rnd(43, ALNUM)}`, 'SendGrid API key'],
      [`${'S'}${'K'}${rnd(32, HEX)}`, 'Twilio API key'],
    ] as const) {
      expect(maskCredentialInput(typed).labels, `the mask alone: ${label}`).toEqual([]);
      expect(mandateCredentialInput(typed)).toBe(label);
    }
  });

  it('rule 2: a bearer header and user:pass in a URL', () => {
    expect(mandateCredentialInput(`Authorization: Bearer ${mixed(40)}`)).toBe('bearer token');
    expect(mandateCredentialInput(`https://admin:${mixed(16)}@shop.example.org/api`)).toBe('credential in URL');
  });

  it('rule 3: a key-shaped word within four words after a cue word, or on the next line after it', () => {
    const key = mixed(32);
    expect(mandateCredentialInput(`API-Key: ${key}`)).toBe('credential after a cue word');
    expect(mandateCredentialInput(`Der Token lautet ${key}`)).toBe('credential after a cue word');
    expect(mandateCredentialInput(`Client Secret: ${rnd(4, ALNUM)}8Q~${rnd(30, ALNUM)}`)).toBe('credential after a cue word');
    expect(mandateCredentialInput(`Der Token:\n${hexKey(32)} und mehr`)).toBe('credential after a cue word');
    expect(mandateCredentialInput(`Hier der Key:\n\n${hexKey(32)}`)).toBe('credential after a cue word');
  });

  it('rule 3, password: plainly the value after a password cue', () => {
    expect(mandateCredentialInput('Das Passwort ist Sommer2026!Shop')).toBe('password');
    expect(mandateCredentialInput('Passwort lautet: Wald#Haus77')).toBe('password');
    expect(mandateCredentialInput('The password is Tr0ub4dor&3x')).toBe('password');
    expect(mandateCredentialInput('Passwort: P@ssw0rd2025')).toBe('password');
    expect(mandateCredentialInput('Das Kennwort ist M@rkt2025')).toBe('password');
    expect(mandateCredentialInput('**Passwort:** Sommer2025!')).toBe('password');
    expect(mandateCredentialInput(`Kennwort: k7${rnd(18, 'abcdefghijklmnopqrstuvwxyz0123456789')}`)).toBe('password');
  });

  it('rule 3: a cue joined to the next word by a hyphen still counts', () => {
    const key = mixed(32);
    expect(mandateCredentialInput(`Der Token-Wert: ${key}`)).toBe('credential after a cue word');
    expect(mandateCredentialInput(`Schlüssel-Wert: ${key}`)).toBe('credential after a cue word');
    expect(mandateCredentialInput(`Mailgun key-${hexKey(32)}`)).toBe('credential after a cue word');
  });

  it('rule 4: a key pasted on its own, a code fence around it allowed', () => {
    const key = mixed(36);
    expect(mandateCredentialInput(key)).toBe('credential on its own');
    expect(mandateCredentialInput(`  ${key}\n`)).toBe('credential on its own');
    expect(mandateCredentialInput(`\`\`\`\n${key}\n\`\`\``)).toBe('credential on its own');
    // Under 20 characters, or no unbroken run of 16 with all three classes: not a key on its own.
    expect(mandateCredentialInput(mixed(19))).toBeNull();
    expect(mandateCredentialInput('S6-standing-practice-v2')).toBeNull();
    // Words joined with numbers change class too rarely for a random key.
    expect(mandateCredentialInput('Rechnung2024November05Final.pdf')).toBeNull();
    expect(mandateCredentialInput('meinshop2024Zuerich-Store')).toBeNull();
    // A Stripe object's id is no secret, however random the part after its prefix; a key with a
    // short prefix of another vendor's is not one.
    expect(mandateCredentialInput(`pi_${mixed(24)}`)).toBeNull();
    expect(mandateCredentialInput(`cus_${mixed(14)}`)).toBeNull();
    expect(mandateCredentialInput(`re_${mixed(32)}`)).toBe('credential on its own');
    expect(mandateCredentialInput(`pi_${mixed(40)}`)).toBe('credential on its own');
  });

  it('caught though not a key: a random-looking id pasted alone (a link to it passes)', () => {
    const id = `1${mixed(32)}`;
    expect(mandateCredentialInput(id)).toBe('credential on its own');
    expect(mandateCredentialInput(`https://drive.google.com/file/d/${id}/view`)).toBeNull();
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

  it('passes ordinary text with a hash or a file name the further shapes or the cue window could take', () => {
    const sha = rnd(40, HEX);
    for (const text of [
      `Datei ${rnd(32, HEX)}-us2.zip`,
      `Der Token wurde gestern im Commit ${sha} geändert`,
      `Der Token ist abgelaufen.\nCommit ${sha} hat es repariert`,
      `Key-Feature ist live seit Commit ${sha}`,
    ]) expect(mandateCredentialInput(text), text.slice(0, 30)).toBeNull();
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
    'Der Token liegt im Vault als SHOPIFY_ADMIN_TOKEN_2026.',
    'Nimm den Key BEXIO_API_TOKEN_V2_PROD dafür',
    'Key-Account: Müller AG, Ansprechpartnerin Frau Keller',
    'Der Token-Status ist abgelaufen, seit dem 03.11.2026.',
    'Passwort vergessen? Der Link: https://shop.example.org/account/reset?id=8823',
    'Das Modell hat 12345 Token verbraucht, Kosten 0.02 USD.',
    'Schlüssel-Anhänger Art. AC-KEY-2026-RED kostet 12.90',
    'Die API-Key-Doku: https://shopify.dev/docs/apps/auth/admin-app-access-tokens',
    'https://shop.example.org/products/filter-2000?variant=4412',
    'Bitte ändern Sie Ihr Passwort bis 30.09. Danke für Ihre Kooperation!',
    'Login-Seite: https://shop.example.org/account/login',
    'Login: info@firma.ch',
    'Der Shop-Login heisst info@firma.ch, das Passwort hat der Inhaber.',
    'Passwort vergessen. Bestellnummer: ORD-2024/118a',
    'Passwort zurückgesetzt.\nRechnung R-2024/0815a ist offen!',
    'Pass: Swiss-Pass Nr. AB12-34cd gültig',
    'pass: 2x Kurs Yoga-Basic1 am Mo!',
    'Login: siehe Doku, Version v2.3.1-beta',
    'Login: 2026-11-05T14:30!',
    'Wie erneuere ich den Token\nBestellung ORD-2024-Kx7Qm2Lp9R',
    'Bitte prüf den Key\nCommit 3f9a1c2e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39',
    'PW: BMW-X5-2024, LKW: keiner',
    'Fahrzeug PW: VW-Golf-2019',
    'pwd: /home/Shop-2024',
    'Wir nutzen einen Passwort-Manager für das Team.',
    'Unser Passwort-Manager ist Bitwarden.',
    'Passwort-Hinweis: steht im Ordner',
    'Bitte Kennwort-Hinweis lesen',
    'Password-Manager: 1Password',
  ];
  it.each(ORDINARY)('passes an ordinary message: %s', (text) => {
    expect(mandateCredentialInput(text)).toBeNull();
  });
});

/**
 * How often a fully drawn key typed after a cue word gets through, pinned per shape. The bands
 * come from a measured rate (100 000 random draws per shape) plus four standard deviations at
 * this sample size; the draws here are seeded, so the count is the same on every run. A change
 * to the detector that moves the rate either way fails here and has to be measured again.
 */
describe('mandateCredentialInput — rate pinned', () => {
  const N = 4000;
  const SHAPES: Array<[string, number, string, number, number]> = [
    ['32 hex', 32, HEX, 37, 104],
    ['40 hex', 40, HEX, 0, 16],
    ['24 alnum', 24, ALNUM, 34, 100],
  ];
  it.each(SHAPES)('a key of %s after a cue word: the count let through stays in its measured band', (name, n, alphabet, low, high) => {
    const draw = seeded(`mandate-key-rate:${name}`);
    let through = 0;
    for (let i = 0; i < N; i++) if (mandateCredentialInput(`Der Token lautet ${draw(n, alphabet)}`) === null) through++;
    expect(through).toBeGreaterThanOrEqual(low);
    expect(through).toBeLessThanOrEqual(high);
  });
});
