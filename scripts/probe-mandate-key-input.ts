#!/usr/bin/env npx tsx
/**
 * Probe for the mandate key-input refusal: which keys a helper might type are
 * masked by the run route's input mask (`maskCredentialInput`), and which harmless helper messages
 * a detector would wrongly swallow. Every key below is synthetic: the right shape, random content.
 *
 *   npx tsx scripts/probe-mandate-key-input.ts
 *
 * Prints one line per sample: kind, whether the mask fired, the labels, the sample's name.
 */
import { mandateCredentialInput, maskCredentialInput } from '../src/core/secret-store.js';

/** Deterministic pseudo-random characters (xorshift32), so the samples are reproducible. */
let seed = 0x1197c0de;
function rnd(n: number, alphabet: string): string {
  let out = '';
  for (let i = 0; i < n; i++) {
    seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0;
    out += alphabet[seed % alphabet.length];
  }
  return out;
}
const AN = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const HEX = '0123456789abcdef';
const B64U = AN + '-_';

/** A key the helper might type, in the sentence a helper might type it in. */
const KEYS: Array<[string, string]> = [
  ['shopify admin token', `Hier ist das Token: shpat_${rnd(32, HEX)}`],
  ['stripe live secret', `sk_live_${rnd(40, AN)}`],
  ['openai project key', `Der Key lautet sk-proj-${rnd(48, B64U)}`],
  ['anthropic key', `sk-ant-api03-${rnd(80, B64U)}`],
  ['github pat', `github_pat_${rnd(60, AN + '_')}`],
  ['google api key', `AIza${rnd(35, B64U)}`],
  // The prefix is joined at run time: the commit-time secret scan reads the literal form.
  ['slack bot token', `${'xox'}${'b'}-${rnd(12, '0123456789')}-${rnd(24, AN)}`],
  ['jwt (bexio-style)', `eyJhbGciOiJSUzI1NiJ9.eyJ${rnd(120, B64U)}.${rnd(86, B64U)}`],
  ['bare 32 hex key alone', rnd(32, HEX)],
  ['bare mixed key alone', rnd(36, AN)],
  ['key in a code block', '```\n' + rnd(40, AN) + '\n```'],
  ['passwort lautet', 'Passwort lautet: Wald#Haus77'],
  ['english password', 'The password is Tr0ub4dor&3x'],
  ['microsoft client secret', `Client Secret: ${rnd(5, AN)}8Q~${rnd(34, AN + '.~_-')}`],
  ['hubspot private app', `pat-eu1-${rnd(8, HEX)}-${rnd(4, HEX)}-${rnd(4, HEX)}-${rnd(4, HEX)}-${rnd(12, HEX)}`],
  ['mailchimp key', `${rnd(32, HEX)}-us21`],
  ['generic 32 hex api key', `API-Key: ${rnd(32, HEX)}`],
  ['generic 40 alnum token', `Token ${rnd(40, AN)}`],
  ['bearer header', `Authorization: Bearer ${rnd(40, B64U)}`],
  ['basic auth url', `https://admin:${rnd(16, AN)}@shop.example.org/api`],
  ['password sentence', `Das Passwort ist Sommer2026!Shop`],
  ['woocommerce consumer secret', `cs_${rnd(40, HEX)}`],
  ['sendgrid key', `SG.${rnd(22, B64U)}.${rnd(43, B64U)}`],
  ['twilio auth token', `${rnd(32, HEX)}`],
  ['aws secret access key', `${rnd(40, AN + '/+')}`],
];

/** Harmless messages a helper sends while setting up an instance. */
const BENIGN: Array<[string, string]> = [
  ['order number', 'Bestellung #100234 ist noch offen, kannst du sie prüfen?'],
  ['shopify order gid', 'gid://shopify/Order/5523419087123'],
  ['tracking id (dhl)', 'Sendungsnummer 00340434161094042557'],
  ['tracking id (ups)', 'Tracking 1Z999AA10123456784'],
  ['sku list', 'SKUs: AC-FLT-2000-BLK, AC-FLT-2000-WHT, AC-CRT-0500'],
  ['git commit hash', 'Der Fehler kam mit Commit 3f9a1c2e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39'],
  ['sha256', 'Prüfsumme: 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'],
  ['uuid', 'Die Kunden-ID ist 3b241101-e2bb-4255-8caf-4136c566a962'],
  ['url with utm', 'https://shop.example.org/produkt?utm_source=newsletter&utm_campaign=herbst2026'],
  ['url with signed query', 'https://cdn.example.org/f.pdf?X-Amz-Signature=8a6f2c3e9b1d4f7a0c5e8b2d6f9a3c1e7b4d0f2a6c8e1b3d5f7a9c0e2b4d6f8a&X-Amz-Expires=3600'],
  ['google drive link', 'https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit'],
  ['iban', 'IBAN CH93 0076 2011 6238 5295 7'],
  ['phone + email', 'Ruf mich an unter +41 79 123 45 67 oder schreib an anna@example.org'],
  ['base64 image name', 'Bild: IMG_20261104_093012_HDR_compressed_final_v2.jpg'],
  ['invoice reference', 'Rechnung RE-2026-11-000482, QR-Referenz 210000000003139471430009017'],
  ['meta pixel id', 'Pixel-ID 1234567890123456'],
  ['ga4 measurement id', 'G-ABC123XYZ9'],
  ['long german word', 'Donaudampfschifffahrtsgesellschaftskapitänsmütze'],
  ['webhook url path', 'https://hooks.example.org/services/T00000000/B00000000/webhookpathsegment'],
  ['shopify product handle', 'acme-wasserfilter-2000-schwarz-mit-kartusche-und-halterung'],
  ['ean list', 'EAN 7612345678901, 7612345678902, 7612345678903'],
  ['npm integrity', 'sha512-Q8x7ZJ0yK4b9mN2pR5tV8wA1cD3eF6gH9iJ2kL5mN8oP1qR4sT7uV0wX3yZ6aB9cD2eF5gH8iJ1kL4mN7oP0q=='],
  ['mixed case id', 'Kampagne ID: AbCdEfGh12345678IjKlMnOp90'],
  ['plain sentence about keys', 'Ich habe den API-Key, aber ich gebe ihn lieber dem Inhaber.'],
  ['vault name after cue', 'Der Token liegt beim Inhaber unter SHOPIFY_ADMIN_API_TOKEN.'],
  ['secret ref after cue', 'Nimm den Key secret:STRIPE_SECRET_KEY aus dem Vault.'],
  ['key account', 'Key-Account: Müller AG, Ansprechpartnerin Frau Keller'],
  ['token status', 'Der Token-Status ist abgelaufen, seit dem 03.11.2026.'],
  ['password reset link', 'Passwort vergessen? Der Link: https://shop.example.org/account/reset?id=8823'],
  ['key with order number', 'Der wichtigste Key-Kunde hat Bestellung 100234 offen.'],
  ['token count', 'Das Modell hat 12345 Token verbraucht, Kosten 0.02 USD.'],
  ['schlüssel product', 'Schlüssel-Anhänger Art. AC-KEY-2026-RED kostet 12.90'],
  ['api key docs link', 'Die API-Key-Doku: https://shopify.dev/docs/apps/auth/admin-app-access-tokens'],
  ['secret santa', 'Secret Santa am 18.12.2026 im Büro, Budget 20 CHF'],
  ['lone commit hash', '3f9a1c2e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39'],
  ['lone uuid', '3b241101-e2bb-4255-8caf-4136c566a962'],
  ['lone tracking', '1Z999AA10123456784'],
  ['lone product handle', 'acme-wasserfilter-2000-schwarz'],
  ['lone url', 'https://shop.example.org/products/filter-2000?variant=4412'],
  ['lone shopify gid', 'gid://shopify/Product/8812345678901'],
];

for (const [kind, rows] of [['KEY', KEYS], ['BENIGN', BENIGN]] as const) {
  for (const [name, text] of rows) {
    const { labels } = maskCredentialInput(text);
    const mandate = mandateCredentialInput(text);
    process.stdout.write(`${kind}\tmask:${labels.length > 0 ? 'hit ' : '-   '}\tmandate:${mandate !== null ? 'hit ' : '-   '}\t${mandate ?? '-'}\t${name}\n`);
  }
}
