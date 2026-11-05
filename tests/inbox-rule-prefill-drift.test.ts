/**
 * The reading pane offers a fixed rule from a mail's sender or subject only with a value the
 * engine takes on create (`packages/web-ui/src/lib/inbox-rule-prefill.ts`). The web UI is a
 * package of its own and keeps its own copy of the checks it needs; this test holds the copy
 * against the engine's `rule-text.ts` on sample values, so the two cannot drift apart unseen.
 * The hidden-character class itself is one file kept byte for byte in both places
 * (`hidden-chars-drift.test.ts`).
 */
import { describe, it, expect } from 'vitest';
import { FIXED_VALUE_MAX, SUBJECT_MIN, fixedValueProblem, isOneSenderAddress } from '../src/integrations/inbox/rule-text.js';
import * as client from '../packages/web-ui/src/lib/inbox-rule-prefill.js';

// One of each kind the engine refuses or keeps: controls, format and direction characters,
// joiners, variation selectors, the tag block, separators, fillers, and ordinary text.
const CODE_POINTS = [
  0x00, 0x09, 0x0a, 0x0d, 0x1b, 0x7f, 0x85, 0xa0, 0xad, 0x034f, 0x061c, 0x115f, 0x180e, 0x200b, 0x200c, 0x200d,
  0x200e, 0x200f, 0x2028, 0x2029, 0x202a, 0x202e, 0x2060, 0x2066, 0x2800, 0x3164, 0xfe00, 0xfe0f, 0xfeff, 0xfffe,
  0x1d173, 0xe0001, 0xe0041, 0xe007f, 0x20, 0x41, 0xe4, 0x1f600,
];

describe('the reading pane\'s rule prefill holds to the engine\'s checks', () => {
  it('uses the same subject minimum and value maximum', () => {
    expect(client.SUBJECT_MIN).toBe(SUBJECT_MIN);
    expect(client.FIXED_VALUE_MAX).toBe(FIXED_VALUE_MAX);
  });

  it('keeps a subject whole exactly where the engine takes it, code point by code point', () => {
    const differ: string[] = [];
    for (const cp of CODE_POINTS) {
      const subject = `Rechnung${String.fromCodePoint(cp)}Lieferant`;
      const keptWhole = client.subjectRulePrefill(subject) === subject;
      const engineTakes = fixedValueProblem(subject, 'subject_contains') === null;
      if (keptWhole !== engineTakes) differ.push(cp.toString(16));
    }
    expect(differ).toEqual([]);
    // Positive control: the sample holds both outcomes.
    expect(CODE_POINTS.filter((cp) => fixedValueProblem(`a${String.fromCodePoint(cp)}b`, 'subject_contains') === null).length).toBeGreaterThan(3);
    expect(CODE_POINTS.filter((cp) => fixedValueProblem(`a${String.fromCodePoint(cp)}b`, 'subject_contains') !== null).length).toBeGreaterThan(20);
  });

  it('offers only a subject phrase the engine takes and the subject contains as it is', () => {
    const subjects = [
      'Zahlungserinnerung 42', 'Newsletter​ KW 45', 'Sale ͏͏͏ jetzt', 'Re: foo\tbar', 'Hi', ' ab ', '\u{1F600}\u{1F600}',
      '\u{1F600}\u{1F600}\u{1F600}', '﻿Rechnung', 'x'.repeat(250), '⚠️ Mahnung', 'Familie \u{1F468}‍\u{1F469}‍\u{1F467}',
      'a​b​c', 'Bestellung Nr. 7', '‮gnunhceR', 'Angebot \u{E0041}\u{E0042} Juli',
    ];
    for (const subject of subjects) {
      const value = client.subjectRulePrefill(subject);
      if (value === null) continue;
      expect(fixedValueProblem(value, 'subject_contains'), subject).toBeNull();
      expect(subject.toLowerCase().includes(value.toLowerCase()), subject).toBe(true);
    }
    // Positive control: some are offered, some are not.
    expect(subjects.filter((s) => client.subjectRulePrefill(s) === null)).toEqual(['Hi', ' ab ', '\u{1F600}\u{1F600}', 'a​b​c']);
  });

  it('offers a sender exactly when the engine takes it as one address', () => {
    const senders = ['rechnung@lieferant.ch', 'Rechnung@Lieferant.CH', "o'brien+x@example.ie", 'noreply@', 'lieferant.ch', 'Lieferant <a@b.ch>', 'a@b.ch, c@d.ch', 'a@b.ch​', '', 'undisclosed-recipients:;', `${'a'.repeat(196)}@b.ch`];
    for (const sender of senders) {
      expect(client.senderRulePrefill(sender) !== null, sender).toBe(sender.trim().length > 0 && fixedValueProblem(sender, 'from') === null);
      expect(client.isOneSenderAddress(sender.toLowerCase()), sender).toBe(isOneSenderAddress(sender.toLowerCase()));
    }
    expect(senders.filter((s) => client.senderRulePrefill(s) !== null)).toEqual(['rechnung@lieferant.ch', 'Rechnung@Lieferant.CH', "o'brien+x@example.ie"]);
  });
});
