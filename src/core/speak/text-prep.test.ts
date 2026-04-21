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
    it('replaces Unicode arrow → with a comma so prosody pauses', () => {
      expect(prepareForSpeech('Lead → Kontakt')).toBe('Lead, Kontakt');
    });

    it('replaces ASCII arrow -> the same way', () => {
      expect(prepareForSpeech('Lead -> Kontakt')).toBe('Lead, Kontakt');
    });

    it('replaces Unicode ← and ASCII <- with a comma', () => {
      expect(prepareForSpeech('Kontakt ← Lead')).toBe('Kontakt, Lead');
      expect(prepareForSpeech('Kontakt <- Lead')).toBe('Kontakt, Lead');
    });

    it('replaces ↔ and <-> the same way', () => {
      expect(prepareForSpeech('A ↔ B')).toBe('A, B');
      expect(prepareForSpeech('A <-> B')).toBe('A, B');
    });
  });
});
