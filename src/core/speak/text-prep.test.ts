/**
 * Unit tests — Markdown → spoken-text sanitizer.
 */

import { describe, expect, it } from 'vitest';
import { prepareForSpeech } from './text-prep.js';

describe('prepareForSpeech', () => {
  it('returns empty string for empty input', () => {
    expect(prepareForSpeech('')).toBe('');
  });

  it('strips fenced code blocks', () => {
    const md = 'Before\n```ts\nconst x = 1;\n```\nAfter';
    expect(prepareForSpeech(md)).toBe('Before. After');
  });

  it('unwraps inline code', () => {
    expect(prepareForSpeech('Run the `npm install` command.')).toBe('Run the npm install command.');
  });

  it('strips image syntax entirely', () => {
    expect(prepareForSpeech('Look ![alt](https://x/y.png) here')).toBe('Look here');
  });

  it('unwraps links to their visible text', () => {
    expect(prepareForSpeech('See [the docs](https://example.com) for details.')).toBe('See the docs for details.');
  });

  it('strips bare URLs', () => {
    const out = prepareForSpeech('Visit https://lynox.ai/setup for setup.');
    expect(out).toBe('Visit for setup.');
  });

  it('strips heading markers', () => {
    expect(prepareForSpeech('# Title\n\nBody text.')).toBe('Title. Body text.');
  });

  it('strips emphasis markers', () => {
    expect(prepareForSpeech('This is **bold** and *italic*.')).toBe('This is bold and italic.');
  });

  it('strips blockquote markers', () => {
    expect(prepareForSpeech('> Quoted line.\n\nAfter.')).toBe('Quoted line. After.');
  });

  it('strips inline HTML tags', () => {
    expect(prepareForSpeech('Hello <b>world</b>.')).toBe('Hello world.');
  });

  it('flattens bullet lists into a joined sentence with "und"', () => {
    const md = 'Heute:\n- Follow-up\n- Deployment\n- Review';
    expect(prepareForSpeech(md)).toBe('Heute: Follow-up, Deployment und Review.');
  });

  it('flattens numbered lists the same way', () => {
    const md = 'Schritte:\n1. Build\n2. Test\n3. Deploy';
    expect(prepareForSpeech(md)).toBe('Schritte: Build, Test und Deploy.');
  });

  it('keeps single-item list as a clean sentence', () => {
    expect(prepareForSpeech('- Nur dieser Punkt')).toBe('Nur dieser Punkt.');
  });

  it('collapses multiple blank lines into sentence separators', () => {
    expect(prepareForSpeech('A\n\n\nB')).toBe('A. B');
  });

  it('collapses runs of whitespace', () => {
    expect(prepareForSpeech('A   B  \t  C')).toBe('A B C');
  });

  it('trims leading/trailing whitespace', () => {
    expect(prepareForSpeech('   hello   ')).toBe('hello');
  });

  it('handles a realistic mixed assistant reply', () => {
    const md = [
      '## Zusammenfassung',
      '',
      'Das **Deployment** läuft. Die Action Items:',
      '',
      '- Call mit Marketing',
      '- Follow-up Mail',
      '- Review der Landing Page',
      '',
      'Details siehe [Dashboard](https://control.lynox.cloud/dashboard).',
    ].join('\n');
    const out = prepareForSpeech(md);
    expect(out).not.toContain('**');
    expect(out).not.toContain('##');
    expect(out).not.toContain('[');
    expect(out).not.toContain('(https');
    expect(out).toContain('Deployment');
    expect(out).toContain('Call mit Marketing, Follow-up Mail und Review der Landing Page.');
    expect(out).toContain('Dashboard');
  });

  it('is idempotent on plain text', () => {
    const plain = 'Schick das Follow-up bis morgen.';
    expect(prepareForSpeech(plain)).toBe(plain);
  });

  it('does not crash on weird input', () => {
    expect(prepareForSpeech('```')).toBe('');
    expect(prepareForSpeech('**')).toBe('**');
    expect(prepareForSpeech('- ')).toBe('');
  });

  // Markdown tables render visually but read like pipe-and-dash noise when
  // passed to a TTS engine verbatim. Two-column tables are typically
  // Key→Value layouts and read naturally as "key: value." sentences; wider
  // tables fall back to comma-joined rows.
  describe('markdown tables', () => {
    it('flattens a 2-column key/value table into "key: value." sentences', () => {
      const md = [
        '| Szenario | Was ich tue |',
        '|---|---|',
        '| Neues Lead | Kontakt anlegen |',
        '| Sammelrechnung | Positionen bündeln |',
      ].join('\n');
      const out = prepareForSpeech(md);
      expect(out).not.toContain('|');
      expect(out).not.toMatch(/-{3,}/);
      expect(out).toContain('Neues Lead: Kontakt anlegen');
      expect(out).toContain('Sammelrechnung: Positionen bündeln');
    });

    it('flattens an N>2-column table as comma-joined rows', () => {
      const md = [
        '| Tier | Preis | Limit |',
        '|---|---|---|',
        '| Starter | 39 | 5 Tasks |',
        '| Pro | 149 | unlimited |',
      ].join('\n');
      const out = prepareForSpeech(md);
      expect(out).not.toContain('|');
      expect(out).toContain('Tier, Preis, Limit');
      expect(out).toContain('Starter, 39, 5 Tasks');
      expect(out).toContain('Pro, 149, unlimited');
    });

    it('handles tables with no surrounding outer pipes', () => {
      const md = [
        'Heute:',
        '',
        'Task | Owner',
        '---|---',
        'Deploy | Rafael',
        'Review | Anna',
      ].join('\n');
      const out = prepareForSpeech(md);
      expect(out).not.toContain('|');
      expect(out).toContain('Deploy: Rafael');
      expect(out).toContain('Review: Anna');
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
      const out = prepareForSpeech(md);
      expect(out).toMatch(/Vor der Tabelle\./);
      expect(out).toMatch(/Nach der Tabelle\.?$/);
      expect(out).toContain('1: 2');
    });
  });

  describe('horizontal rules', () => {
    it('drops --- lines', () => {
      expect(prepareForSpeech('Before\n\n---\n\nAfter')).toBe('Before. After');
    });

    it('drops *** lines', () => {
      expect(prepareForSpeech('Before\n\n***\n\nAfter')).toBe('Before. After');
    });

    it('drops ___ lines', () => {
      expect(prepareForSpeech('Before\n\n___\n\nAfter')).toBe('Before. After');
    });
  });

  describe('arrow symbols', () => {
    // EN-neutral default: comma. Applies to neutral/unmarked text and
    // to explicitly English content. Prevents the Voxtral EN voice from
    // reading a German "dann" as /dæn/ (the name "Dan").
    it('uses ", " for neutral/EN text (Unicode →)', () => {
      expect(prepareForSpeech('Lead → Contact')).toBe('Lead, Contact');
    });

    it('uses ", " for neutral/EN text (ASCII ->)', () => {
      expect(prepareForSpeech('Lead -> Contact')).toBe('Lead, Contact');
    });

    it('uses ", " for ← and <- in EN text', () => {
      expect(prepareForSpeech('Contact ← Lead')).toBe('Contact, Lead');
      expect(prepareForSpeech('Contact <- Lead')).toBe('Contact, Lead');
    });

    it('uses ", " for ↔ and <-> in EN text', () => {
      expect(prepareForSpeech('A ↔ B')).toBe('A, B');
      expect(prepareForSpeech('A <-> B')).toBe('A, B');
    });

    it('uses ", " for EN arrow chain — "dann" would sound like "Dan"', () => {
      expect(prepareForSpeech('Starter -> Managed -> Pro: pick one.')).toBe(
        'Starter, Managed, Pro: pick one.',
      );
    });

    // DE-detected path: " dann " is a real connector the EN voice renders
    // as /daːn/ in German context. Triggered by umlauts or DE stopwords.
    it('uses " dann " when DE markers present (umlaut)', () => {
      expect(prepareForSpeech('Für die Prüfung: Lead → Kontakt')).toBe(
        'Für die Prüfung: Lead dann Kontakt',
      );
    });

    it('uses " dann " for chains in DE context', () => {
      expect(prepareForSpeech('Das ist nicht leicht: Starter → Managed → Pro')).toBe(
        'Das ist nicht leicht: Starter dann Managed dann Pro',
      );
    });

    it('uses " dann " for ASCII arrows in DE context', () => {
      expect(prepareForSpeech('Nach dem Build ist es bereit: A -> B')).toBe(
        'Nach dem Build ist es bereit: A dann B',
      );
    });
  });

  describe('less-than + digit', () => {
    it('strips leading < before a number so TTS reads the quantity', () => {
      expect(prepareForSpeech('Response <4h')).toBe('Response 4h');
    });

    it('handles <N with spacing variants', () => {
      expect(prepareForSpeech('latency < 100ms')).toBe('latency 100ms');
    });

    it('leaves < untouched when NOT followed by a digit', () => {
      // "<tag>" gets stripped by the HTML-tag rule (not the less-than rule)
      expect(prepareForSpeech('use <tag> carefully')).toBe('use carefully');
    });
  });

  describe('German "Die" pronunciation guard', () => {
    it('rewrites sentence-initial Die to Dee when DE markers present', () => {
      expect(prepareForSpeech('Die Timeline zeigt alles. Wichtig ist das.')).toBe(
        'Dee Timeline zeigt alles. Wichtig ist das.',
      );
    });

    it('rewrites Die after . in a DE paragraph', () => {
      expect(prepareForSpeech('Das ist so. Die nächste Phase kommt.')).toBe(
        'Das ist so. Dee nächste Phase kommt.',
      );
    });

    it('leaves English "Die" untouched (no German markers)', () => {
      expect(prepareForSpeech('Die Hard is a classic movie.')).toBe(
        'Die Hard is a classic movie.',
      );
    });

    it('does not mutate mid-sentence lowercase die', () => {
      expect(prepareForSpeech('Ich mag die Timeline.')).toBe('Ich mag die Timeline.');
    });

    it('fires when text has umlauts even without DE stopwords', () => {
      expect(prepareForSpeech('Die Prüfung läuft.')).toBe('Dee Prüfung läuft.');
    });
  });

  describe('price/rate per unit expansion', () => {
    it('expands N/mo to "per month" in EN context', () => {
      expect(prepareForSpeech('Starter costs 39/mo for solo use.')).toBe(
        'Starter costs 39 per month for solo use.',
      );
    });

    it('expands N/mo to "pro Monat" in DE context', () => {
      expect(prepareForSpeech('Starter kostet CHF 49/mo für Solo-Nutzung.')).toBe(
        'Starter kostet CHF 49 pro Monat für Solo-Nutzung.',
      );
    });

    it('expands N/yr to "per year" in EN', () => {
      expect(prepareForSpeech('Growth at 199/yr includes priority support.')).toBe(
        'Growth at 199 per year includes priority support.',
      );
    });

    it('expands N/yr to "pro Jahr" in DE', () => {
      // "mit" triggers DE markers; otherwise /yr would fall through to EN default.
      expect(prepareForSpeech('Das Jahresabo kostet 199/yr mit allem drin.')).toBe(
        'Das Jahresabo kostet 199 pro Jahr mit allem drin.',
      );
    });

    it('handles uppercase unit variants', () => {
      expect(prepareForSpeech('Plan: 79/Mo standard')).toBe('Plan: 79 per month standard');
    });

    it('handles long-form "month"', () => {
      expect(prepareForSpeech('Pro at 149/month scales.')).toBe('Pro at 149 per month scales.');
    });

    it('handles German long form /Monat', () => {
      expect(prepareForSpeech('Für 149/Monat mit nicht beliebten Aufgaben.')).toBe(
        'Für 149 pro Monat mit nicht beliebten Aufgaben.',
      );
    });

    it('expands rates in parenthetical prices', () => {
      expect(prepareForSpeech('Upgrade to Managed (CHF 149/mo) for more resources.')).toBe(
        'Upgrade to Managed (CHF 149 per month) for more resources.',
      );
    });
  });

  describe('slash between word-tokens', () => {
    it('converts letter/letter to ", " (list separator)', () => {
      expect(prepareForSpeech('Wachstum/SLA nötig')).toBe('Wachstum, SLA nötig');
    });

    it('converts multi-letter/multi-letter with spaces', () => {
      expect(prepareForSpeech('EU / US Region')).toBe('EU, US Region');
    });

    it('leaves date patterns alone (digit/digit)', () => {
      expect(prepareForSpeech('Termin am 04/21 um 14:00')).toBe('Termin am 04/21 um 14:00');
    });

    it('leaves fractions alone (digit/digit)', () => {
      expect(prepareForSpeech('1/2 der Kunden')).toBe('1/2 der Kunden');
    });

    it('combines with less-than stripping', () => {
      expect(prepareForSpeech('Multi-Region/<4h Response')).toBe('Multi-Region, 4h Response');
    });
  });
});
