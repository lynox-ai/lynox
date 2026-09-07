import { describe, it, expect } from 'vitest';
import { sanitizeLLMTitle, generateThreadTitle } from './session.js';
import { closeLoadedContext } from './chat-context.js';

describe('sanitizeLLMTitle', () => {
  it('passes a clean title through unchanged', () => {
    expect(sanitizeLLMTitle('Quarterly Budget Review')).toBe('Quarterly Budget Review');
  });

  it('strips wrapping double and single quotes', () => {
    expect(sanitizeLLMTitle('"Quarterly Budget Review"')).toBe('Quarterly Budget Review');
    expect(sanitizeLLMTitle("'Hello World'")).toBe('Hello World');
  });

  it('strips trailing punctuation and whitespace', () => {
    expect(sanitizeLLMTitle('Deploy the Release.')).toBe('Deploy the Release');
    expect(sanitizeLLMTitle('  Trimmed Title  ')).toBe('Trimmed Title');
  });

  it('keeps only the first line', () => {
    expect(sanitizeLLMTitle('Database Migration\nSome stray model commentary')).toBe('Database Migration');
  });

  it('preserves internal punctuation', () => {
    expect(sanitizeLLMTitle('"Auth, Billing & Webhooks"')).toBe('Auth, Billing & Webhooks');
  });

  it('caps overlong titles at 80 chars with an ellipsis', () => {
    const result = sanitizeLLMTitle('a'.repeat(120));
    expect(result.length).toBe(80);
    expect(result.endsWith('...')).toBe(true);
  });

  it('returns empty string when nothing usable remains', () => {
    expect(sanitizeLLMTitle('')).toBe('');
    expect(sanitizeLLMTitle('   ')).toBe('');
    expect(sanitizeLLMTitle('""')).toBe('');
  });
});

describe('generateThreadTitle', () => {
  it('titles a plain message from its first line', () => {
    expect(generateThreadTitle('Wie ist der Umsatz im Q3?')).toBe('Wie ist der Umsatz im Q3?');
  });

  it('#6: does NOT title a context-chat from the [Loaded …] preamble', () => {
    // A "💬 Im Chat beantworten" chat: the first message carries a loaded-context
    // preamble closed by the sentinel, then the user's own words. The nav title
    // must be the user's words — not "[Loaded mail for reply — …]".
    //
    // The fixture mirrors what chat-context.ts composes: the sender-authored
    // fields inside an `<untrusted_data>` block. It is hand-built — this file
    // must not depend on the inbox reader — so it CAN drift, and it already had:
    // the previous version carried the pre-wrapper shape and stayed green against
    // a premise that no longer existed.
    //
    // What guards the fidelity is `chat-context.test.ts`, which runs the REAL
    // composed preamble of every kind through the REAL strip. Here we assert only
    // the outcome that belongs to this file: the title is the user's words. Two
    // earlier attempts at a second assertion were both tautologies — first
    // `.not.toContain('untrusted_data')` beside the exact `.toBe(...)` (nothing
    // can pass one and fail the other), then `expect(first).toContain(…)` on a
    // literal three lines below it.
    const preamble =
      '[Loaded mail for reply — item: item-1]\n' +
      '<untrusted_data source="mail:acme:markus@acme.example">\n' +
      'From: Markus <markus@acme.example>\nSubject: Angebot\n' +
      'Message: Koennt ihr ein Angebot schicken?\n' +
      '</untrusted_data>\n\n' +
      'To reply, call mail_reply with uid: 42, account: "acme". Draft a reply, confirm the send with the user, then send it.';
    const first = closeLoadedContext(preamble) + 'Antworte freundlich und frag nach dem Budget.';
    expect(generateThreadTitle(first)).toBe('Antworte freundlich und frag nach dem Budget.');
  });

  it('still strips the onboarding prefix (regression)', () => {
    expect(generateThreadTitle('[ONBOARDING 1/3] Welcome!\n\nHelp me set up email.')).toBe('Help me set up email.');
  });

  it('falls back to "New Chat" for an empty message', () => {
    expect(generateThreadTitle('')).toBe('New Chat');
  });
});
