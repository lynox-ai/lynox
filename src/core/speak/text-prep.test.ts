/**
 * Unit tests — Markdown → spoken-text sanitizer (block-first redesign).
 *
 * Covers the four pipeline phases:
 *   1. Block segmentation (paragraph, list, table, code, heading, quote, hr).
 *   2. Per-block strategy (drop / summarize / speak).
 *   3. Inline-strip (links, URLs, code, HTML, markers, IDs, em-dash, arrows).
 *   4. Stub-drop and final hygiene.
 *
 * Language is a required parameter — tests pass 'de' / 'en' explicitly so
 * cases that depend on label strings or the list joiner are deterministic.
 * `'auto'` is exercised in its own block.
 */

import { describe, expect, it } from 'vitest';
import { prepareForSpeech } from './text-prep.js';

describe('prepareForSpeech — block strategies', () => {
  it('returns empty string for empty input', () => {
    expect(prepareForSpeech('', 'en')).toBe('');
    expect(prepareForSpeech('', 'de')).toBe('');
  });

  it('drops fenced code blocks entirely', () => {
    const md = 'Before\n\n```ts\nconst x = 1;\n```\n\nAfter';
    expect(prepareForSpeech(md, 'en')).toBe('Before After');
  });

  it('drops horizontal rules', () => {
    expect(prepareForSpeech('Before\n\n---\n\nAfter', 'en')).toBe('Before After');
    expect(prepareForSpeech('Before\n\n***\n\nAfter', 'en')).toBe('Before After');
    expect(prepareForSpeech('Before\n\n___\n\nAfter', 'en')).toBe('Before After');
  });

  it('strips heading markers and emits a sentence break', () => {
    expect(prepareForSpeech('# Title\n\nBody text.', 'en')).toBe('Title. Body text.');
    expect(prepareForSpeech('## Sub\n\nMore.', 'de')).toBe('Sub. More.');
  });

  it('passes plain prose through unchanged', () => {
    const plain = 'Schick das Follow-up bis morgen.';
    expect(prepareForSpeech(plain, 'de')).toBe(plain);
  });

  it('preserves blockquote text without > marker', () => {
    expect(prepareForSpeech('> Quoted line.\n\nAfter.', 'en')).toBe('Quoted line. After.');
  });
});

describe('lists', () => {
  it('joins ≤3 items with comma + " und " in DE', () => {
    const md = 'Heute:\n\n- Follow-up\n- Deployment\n- Review';
    expect(prepareForSpeech(md, 'de')).toBe('Heute: Follow-up, Deployment und Review.');
  });

  it('joins ≤3 items with comma + " and " in EN', () => {
    const md = 'Today:\n\n- Follow-up\n- Deployment\n- Review';
    expect(prepareForSpeech(md, 'en')).toBe('Today: Follow-up, Deployment and Review.');
  });

  it('summarizes lists with >3 items in DE', () => {
    const md = '- A\n- B\n- C\n- D\n- E';
    expect(prepareForSpeech(md, 'de')).toBe('Liste mit 5 Einträgen, siehe Bildschirm.');
  });

  it('summarizes lists with >3 items in EN', () => {
    const md = '- A\n- B\n- C\n- D\n- E';
    expect(prepareForSpeech(md, 'en')).toBe('List with 5 items, see screen.');
  });

  it('keeps a single item as a clean sentence', () => {
    expect(prepareForSpeech('- Nur dieser Punkt', 'de')).toBe('Nur dieser Punkt.');
  });

  it('handles numbered lists the same way', () => {
    const md = 'Schritte:\n\n1. Build\n2. Test\n3. Deploy';
    expect(prepareForSpeech(md, 'de')).toBe('Schritte: Build, Test und Deploy.');
  });

  it('strips Markdown markers and link wrappers from list items', () => {
    // List items go through stripInline; bold markers, link syntax, and
    // bare URLs must be cleaned the same way as in paragraph text. A
    // regression here would silently break formatted bullets.
    const md = '- **Build** the demo\n- See [our docs](https://docs.example.com) carefully\n- Run the tests';
    expect(prepareForSpeech(md, 'en')).toBe('Build the demo, See our docs carefully and Run the tests.');
  });
});

describe('tables', () => {
  it('speaks a 2-col table as "key: value." per row', () => {
    const md = [
      '| Szenario | Was ich tue |',
      '|---|---|',
      '| Neues Lead | Kontakt anlegen |',
      '| Sammelrechnung | Positionen bündeln |',
    ].join('\n');
    const out = prepareForSpeech(md, 'de');
    expect(out).toContain('Neues Lead: Kontakt anlegen');
    expect(out).toContain('Sammelrechnung: Positionen bündeln');
    expect(out).not.toContain('|');
    expect(out).not.toContain('Szenario');
  });

  it('speaks a 3-col table as comma-joined cells per row', () => {
    const md = [
      '| Tier | Preis | Limit |',
      '|---|---|---|',
      '| Starter | 39 | 5 Tasks |',
      '| Pro | 149 | unlimited |',
    ].join('\n');
    const out = prepareForSpeech(md, 'en');
    expect(out).toContain('Starter, 39, 5 Tasks');
    expect(out).toContain('Pro, 149, unlimited');
    expect(out).not.toContain('Tier');
  });

  it('summarizes tables with >5 rows', () => {
    const md = [
      '| K | V |',
      '|---|---|',
      '| a | 1 |', '| b | 2 |', '| c | 3 |',
      '| d | 4 |', '| e | 5 |', '| f | 6 |',
    ].join('\n');
    expect(prepareForSpeech(md, 'de')).toBe('Tabelle mit 6 Zeilen, siehe Bildschirm.');
    expect(prepareForSpeech(md, 'en')).toBe('Table with 6 rows, see screen.');
  });

  it('summarizes tables with ≥4 columns', () => {
    const md = [
      '| A | B | C | D |',
      '|---|---|---|---|',
      '| 1 | 2 | 3 | 4 |',
    ].join('\n');
    expect(prepareForSpeech(md, 'de')).toBe('Tabelle mit 1 Zeilen, siehe Bildschirm.');
  });

  it('maps trend symbols to words in DE', () => {
    const md = [
      '| Metrik | Wert | Trend |',
      '|---|---|---|',
      '| Umsatz | 12k | ↑ |',
      '| CAC | 89 | ↓ |',
      '| Churn | 3.2% | → |',
    ].join('\n');
    const out = prepareForSpeech(md, 'de');
    expect(out).toContain('Umsatz, 12k, steigend');
    expect(out).toContain('CAC, 89, fallend');
    expect(out).toContain('Churn, 3.2%, stabil');
    expect(out).not.toContain('↑');
  });

  it('maps trend symbols to words in EN', () => {
    const md = [
      '| Metric | Value | Trend |',
      '|---|---|---|',
      '| Revenue | 12k | ↑ |',
      '| CAC | 89 | ↓ |',
    ].join('\n');
    const out = prepareForSpeech(md, 'en');
    expect(out).toContain('Revenue, 12k, rising');
    expect(out).toContain('CAC, 89, falling');
  });

  it('keeps prose lines before and after a table intact', () => {
    const md = [
      'Vor der Tabelle.',
      '',
      '| A | B |',
      '|---|---|',
      '| 1 | 2 |',
      '',
      'Nach der Tabelle.',
    ].join('\n');
    const out = prepareForSpeech(md, 'de');
    expect(out).toMatch(/^Vor der Tabelle\./);
    expect(out).toContain('1: 2');
    expect(out).toMatch(/Nach der Tabelle\.?$/);
  });

  it('keeps column count stable when a data cell is empty', () => {
    // 2-col table with one empty value cell — must stay a 2-col table
    // (not collapse to 1-col / summary). The empty row produces no output;
    // the non-empty row is spoken normally.
    const md = [
      '| Schlüssel | Wert |',
      '|---|---|',
      '| Alpha | eins |',
      '| Beta |  |',
    ].join('\n');
    const out = prepareForSpeech(md, 'de');
    expect(out).toContain('Alpha: eins');
    expect(out).not.toContain('Tabelle mit');
  });

  it('handles tables with no surrounding outer pipes', () => {
    const md = [
      'Heute:',
      '',
      'Task | Owner',
      '---|---',
      'Deploy | Anna',
      'Review | Jane',
    ].join('\n');
    const out = prepareForSpeech(md, 'de');
    expect(out).toContain('Deploy: Anna');
    expect(out).toContain('Review: Jane');
    expect(out).not.toContain('|');
  });

  it('strips URLs and link syntax inside table cells', () => {
    // Table cells go through stripInline (per cell), so URLs and
    // [label](url) wrappers must be cleaned the same as in paragraphs.
    // The link label survives the wrapper strip; a cell that is JUST a
    // bare URL collapses to a marker, and the row gets dropped by
    // stub-drop downstream (no speakable content left). The first row
    // here proves the label-survival path; the table emits one sentence.
    const md = [
      '| Resource | Where |',
      '|---|---|',
      '| Docs | [our guide](https://docs.example.com) |',
      '| Source | the public https://github.com/example/repo mirror |',
    ].join('\n');
    const out = prepareForSpeech(md, 'en');
    expect(out).toContain('Docs: our guide');
    expect(out).toContain('Source: the public');
    expect(out).toContain('mirror');
    expect(out).not.toContain('https');
    expect(out).not.toContain('[');
  });
});

describe('inline strip', () => {
  it('strips bare URLs and drops the surrounding stub', () => {
    expect(prepareForSpeech('Mehr unter https://example.com/managed.', 'de')).toBe('');
  });

  it('keeps long-enough sentences that contain a URL', () => {
    const out = prepareForSpeech('Visit https://example.com for details on pricing.', 'en');
    expect(out).toBe('Visit for details on pricing.');
  });

  it('strips a parenthesized URL without leaving an orphan paren', () => {
    // Mid-sentence "(URL)" — the URL strip + bracket-collapse must remove
    // the wrapping parens too, not just the URL.
    const out = prepareForSpeech('Look at (https://example.com) for more details now.', 'en');
    expect(out).not.toContain('(');
    expect(out).not.toContain(')');
    expect(out).toContain('Look at');
    expect(out).toContain('for more details now');
  });

  it('unwraps links to their visible label', () => {
    expect(prepareForSpeech('See [the docs](https://example.com) for details.', 'en'))
      .toBe('See the docs for details.');
  });

  it('strips image syntax mid-sentence and keeps surrounding words', () => {
    // Image is mid-sentence (not tail-most) — surrounding text is kept.
    expect(prepareForSpeech('Look ![alt](https://x/y.png) here.', 'en')).toBe('Look here.');
  });

  it('strips image syntax at sentence tail and drops the stub', () => {
    expect(prepareForSpeech('See ![alt](https://x/y.png).', 'en')).toBe('');
  });

  it('strips inline code', () => {
    // "Run the command." has no marker (full sentence) once "`npm install`"
    // is replaced — but the marker IS inserted, so stub-drop kicks in if
    // remaining words drop below 3. Here we have 4 → kept.
    expect(prepareForSpeech('Run the `npm install` command now.', 'en'))
      .toBe('Run the command now.');
  });

  it('strips inline HTML', () => {
    expect(prepareForSpeech('Hello <b>world</b> today.', 'en')).toBe('Hello world today.');
  });

  it('strips bold/italic/strike markers', () => {
    expect(prepareForSpeech('This is **bold** and *italic* and ~~strike~~.', 'en'))
      .toBe('This is bold and italic and strike.');
  });

  it('drops "#" from issue refs but keeps the number', () => {
    expect(prepareForSpeech('Issue #182 ist resolved.', 'de')).toBe('Issue 182 ist resolved.');
    expect(prepareForSpeech('See PR #42 for details.', 'en')).toBe('See PR 42 for details.');
  });

  it('strips long opaque tokens (UUIDs, JWT-like)', () => {
    const uuid = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    const out = prepareForSpeech(`Token ${uuid} is valid for one hour.`, 'en');
    expect(out).not.toContain(uuid);
    expect(out).toContain('is valid');
  });

  it('does NOT strip long German compound nouns (no shape signal)', () => {
    // 34-letter German compound — no digit, no hyphen — must survive.
    const word = 'Donaudampfschifffahrtsgesellschaft';
    const out = prepareForSpeech(`Die ${word} ist heute ein Begriff.`, 'de');
    expect(out).toContain(word);
  });

  it('does NOT strip long hyphenated English compounds (hyphens are not a shape signal)', () => {
    // 30-letter hyphenated phrase — opaque-token shape signal must require
    // a digit or underscore, not just a hyphen, otherwise prose vanishes.
    const phrase = 'state-of-the-art-implementation';
    const out = prepareForSpeech(`We built a ${phrase} for the team.`, 'en');
    expect(out).toContain(phrase);
  });

  it('strips inline JSON-ish braces', () => {
    const out = prepareForSpeech('Result: {"foo": 1, "bar": 2} arrived.', 'en');
    expect(out).not.toContain('{');
    expect(out).not.toContain('}');
    expect(out).toContain('arrived');
  });

  it('replaces em-dash with comma', () => {
    expect(prepareForSpeech('Starter — simple — fast.', 'en')).toBe('Starter, simple, fast.');
  });

  it('replaces prose arrows with comma (Unicode)', () => {
    expect(prepareForSpeech('Lead → Customer is the path.', 'en')).toBe('Lead, Customer is the path.');
  });

  it('replaces prose arrows with comma (ASCII)', () => {
    expect(prepareForSpeech('A -> B -> C is the chain.', 'en')).toBe('A, B, C is the chain.');
  });
});

describe('stub-drop', () => {
  it('drops sentence fragments left after URL strip', () => {
    const md = 'Mehr unter https://docs.example.com/x. Issue 182 ist resolved.';
    expect(prepareForSpeech(md, 'de')).toBe('Issue 182 ist resolved.');
  });

  it('does NOT drop short natural sentences without strip markers', () => {
    expect(prepareForSpeech('Hi Jane. Ok.', 'en')).toBe('Hi Jane. Ok.');
  });

  it('keeps sentences with ≥3 words even when they contain a URL', () => {
    expect(prepareForSpeech('Visit https://example.com soon now please.', 'en'))
      .toBe('Visit soon now please.');
  });
});

describe('strategist brief — end-to-end', () => {
  it('processes a German brief into clean spoken text', () => {
    const md = [
      '## Wachstumsplan Q3',
      '',
      'Hallo Max,',
      '',
      'hier der **Statusbericht** für [acme.example.com](https://acme.example.com).',
      '',
      '| Metrik | Wert | Trend |',
      '|---|---|---|',
      '| Umsatz | 12k | ↑ |',
      '| CAC | 89 | ↓ |',
      '| Churn | 3.2% | → |',
      '| MRR | 4.1k | ↑ |',
      '',
      'Empfehlungen:',
      '',
      '- Newsletter-Liste segmentieren',
      '- Pricing-Page A/B-Test starten',
      '- Onboarding auf 5 Mails kürzen',
      '- Cold-Outreach pausieren',
      '- Telegram-Channel reaktivieren',
      '',
      'Beispiel-Snippet:',
      '',
      '```bash',
      'hcloud server create --type cx32',
      '```',
      '',
      'Issue #182 ist resolved.',
    ].join('\n');
    const out = prepareForSpeech(md, 'de');
    expect(out).toContain('Wachstumsplan Q3.');
    expect(out).toContain('Hallo Max');
    expect(out).toContain('Statusbericht für acme.example.com');
    expect(out).toContain('Umsatz, 12k, steigend');
    expect(out).toContain('Liste mit 5 Einträgen, siehe Bildschirm.');
    expect(out).toContain('Issue 182 ist resolved.');
    expect(out).not.toContain('**');
    expect(out).not.toContain('|');
    expect(out).not.toContain('hcloud');
    expect(out).not.toContain('https');
    expect(out).not.toContain('↑');
  });

  it('processes an English brief into clean spoken text', () => {
    const md = [
      '## Growth Plan Q3',
      '',
      'Hi Jane,',
      '',
      "here's the **status report** for [acme.example.com](https://acme.example.com).",
      '',
      '| Metric | Value | Trend |',
      '|---|---|---|',
      '| Revenue | 12k | ↑ |',
      '| CAC | 89 | ↓ |',
      '| Churn | 3.2% | → |',
      '',
      'Recommendations:',
      '',
      '- Segment newsletter list',
      '- Start pricing-page A/B test',
      '- Shorten onboarding to five emails',
      '- Pause cold outreach',
      '',
      'Example snippet:',
      '',
      '```bash',
      'hcloud server create --type cx32',
      '```',
      '',
      'Issue #182 is resolved.',
    ].join('\n');
    const out = prepareForSpeech(md, 'en');
    expect(out).toContain('Growth Plan Q3.');
    expect(out).toContain('Hi Jane');
    expect(out).toContain('status report for acme.example.com');
    expect(out).toContain('Revenue, 12k, rising');
    expect(out).toContain('List with 4 items, see screen.');
    expect(out).toContain('Issue 182 is resolved.');
    expect(out).not.toContain('**');
    expect(out).not.toContain('|');
    expect(out).not.toContain('hcloud');
  });
});

describe("'auto' lang detection", () => {
  it('picks DE when umlauts are present', () => {
    const md = '- A\n- B\n- C\n- D\n- E';
    // Same input, but with a DE-marker sentence in front to bias detection.
    const withDe = `Für die Prüfung:\n\n${md}`;
    expect(prepareForSpeech(withDe, 'auto')).toContain('Liste mit 5 Einträgen');
  });

  it('picks EN when EN stopwords dominate', () => {
    const md = 'The status of the work is the following.\n\n- A\n- B\n- C\n- D';
    expect(prepareForSpeech(md, 'auto')).toContain('List with 4 items');
  });

  it('defaults to EN on empty / unscorable input', () => {
    // Numbers and symbols only — neither DE nor EN markers fire.
    const md = '- 1\n- 2\n- 3\n- 4';
    expect(prepareForSpeech(md, 'auto')).toContain('List with 4 items');
  });

  it('returns empty for actually empty input under auto', () => {
    // The truly empty case must short-circuit cleanly without running
    // detectLang at all — the function contract is "empty in, empty out"
    // regardless of lang. Whitespace-only input behaves the same.
    expect(prepareForSpeech('', 'auto')).toBe('');
    expect(prepareForSpeech('   \n  \t  ', 'auto')).toBe('');
  });

  it('does NOT flip to DE for a single umlaut in EN content (proper-noun guard)', () => {
    // "Visit Müller and check the list now" — one umlaut in a proper noun,
    // EN stopwords elsewhere. Old heuristic counted umlauts unconditionally
    // and flipped to DE. New rule only counts umlauts when paired with a
    // DE stopword, so this stays EN.
    const md = 'Visit Müller and check the list now.\n\n- A\n- B\n- C\n- D';
    expect(prepareForSpeech(md, 'auto')).toContain('List with 4 items');
  });

  it('detects DE for terse umlaut-only input without DE stopwords', () => {
    // ≥2 umlauts on their own count as DE evidence — short replies like
    // "Prüfung läuft" have no stopwords but are unambiguously German.
    const md = 'Prüfung läuft.\n\n- A\n- B\n- C\n- D';
    expect(prepareForSpeech(md, 'auto')).toContain('Liste mit 4 Einträgen');
  });
});

describe('robustness', () => {
  it('does not crash on weird input', () => {
    expect(prepareForSpeech('```', 'en')).toBe('');
    expect(prepareForSpeech('- ', 'en')).toBe('');
    expect(prepareForSpeech('***', 'en')).toBe('');
  });

  it('collapses multiple blank lines into sentence separators', () => {
    expect(prepareForSpeech('A\n\n\nB', 'en')).toBe('A B');
  });

  it('collapses runs of whitespace', () => {
    expect(prepareForSpeech('A   B  \t  C', 'en')).toBe('A B C');
  });

  it('trims leading/trailing whitespace', () => {
    expect(prepareForSpeech('   hello there   ', 'en')).toBe('hello there');
  });
});
