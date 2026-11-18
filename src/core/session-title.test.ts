import { describe, it, expect } from 'vitest';
import { sanitizeLLMTitle, generateThreadTitle, LLM_TITLE_PROMPT, llmTitlePrompt, llmTitleSource } from './session.js';
import { closeLoadedContext } from './chat-context.js';
import { compose } from './data-boundary.js';
import { runTaskPrompt, RUN_TASK_LEAD } from './run-task-turn.js';

describe('LLM_TITLE_PROMPT', () => {
  // The prompt is the only thing that sets the title's language: the call adds the message alone.
  it('asks for the title in the language of the first message, Title Case only in English', () => {
    expect(LLM_TITLE_PROMPT).toBe(
      'Write a concise 3-6 word title for a conversation that begins with the message below. ' +
      'Write it in the language of that message; use Title Case only for an English title. ' +
      'No quotes, no trailing punctuation. Reply with ONLY the title.\n\n',
    );
  });
});

describe('llmTitlePrompt', () => {
  it('names English for an English message, the instance being German or not', () => {
    const prompt = llmTitlePrompt('Please draft a short quote for Nordglas GmbH for 20 hours of consulting.');
    expect(prompt).toContain('Write it in English, in Title Case. ');
    expect(prompt).not.toContain('language of that message');
  });

  it('names German for a German message, without Title Case', () => {
    const prompt = llmTitlePrompt('Schreib mir bitte eine kurze Offerte für die Keller AG über 20 Stunden Beratung.');
    expect(prompt).toContain('Write it in German, as a German speaker would; do not use Title Case. ');
    expect(prompt).not.toContain('English');
  });

  it('keeps the general sentence where the words do not decide (another language, a two-word reply)', () => {
    expect(llmTitlePrompt('Bonjour, pouvez-vous préparer une offre pour la société Dupont ?')).toBe(LLM_TITLE_PROMPT);
    expect(llmTitlePrompt('ok, mach')).toBe(LLM_TITLE_PROMPT);
  });
});

describe('llmTitleSource', () => {
  it('gives a scheduled run\'s task words, not the engine\'s English lead', () => {
    const turn = compose(runTaskPrompt('Wochenbericht Umsatz', 'Fasse die Umsätze der Vorwoche zusammen.'), '\n');
    expect(llmTitleSource(turn)).toBe(generateThreadTitle(turn));
    expect(llmTitleSource(turn)).not.toContain(RUN_TASK_LEAD.slice(0, 20));
  });

  it('control: an ordinary first message passes through', () => {
    expect(llmTitleSource('Kannst du mir eine Offerte für Keller AG schreiben?')).toBe('Kannst du mir eine Offerte für Keller AG schreiben?');
  });
});

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

describe('generateThreadTitle on a scheduled run\'s opening turn', () => {
  it('names the thread by the task, never by the engine\'s lead', () => {
    const turn = compose(runTaskPrompt('Daily Report', 'Generate the daily report'), '\n');
    expect(generateThreadTitle(turn)).toBe('Daily Report');
    expect(generateThreadTitle(turn)).not.toContain('Carry out');
    // The answered (re-armed) turn opens the same way.
    expect(generateThreadTitle(`${turn}\n\nA question you asked earlier has been answered.`)).toBe('Daily Report');
    // Control: an owner's message that merely quotes the lead is titled as written.
    expect(generateThreadTitle(`Why does it say: ${RUN_TASK_LEAD}`)).toBe(`Why does it say: ${RUN_TASK_LEAD}`.slice(0, 77) + '...');
  });
});
