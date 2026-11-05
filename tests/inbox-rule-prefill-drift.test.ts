/**
 * The reading pane offers a fixed rule from a mail's sender or subject only with a value the
 * engine takes on create (`packages/web-ui/src/lib/inbox-rule-prefill.ts`). The web UI is a
 * package of its own and keeps its own copy of the checks it needs; this test holds the copy
 * against the engine's `rule-text.ts` on sample values, so the two cannot drift apart unseen,
 * and runs a mail's raw subject through the store, the pane and the rule match end to end.
 * The hidden-character class itself is one file kept byte for byte in both places
 * (`hidden-chars-drift.test.ts`).
 */
import { describe, it, expect } from 'vitest';
import { FIXED_VALUE_MAX, SUBJECT_MIN, fixedValueProblem, isOneSenderAddress } from '../src/integrations/inbox/rule-text.js';
import { sanitizeHeader } from '../src/integrations/inbox/classifier/sanitize.js';
import { envelopeToItemInputFields } from '../src/integrations/inbox/state.js';
import { InboxRulesLoader } from '../src/integrations/inbox/rules-loader.js';
import * as client from '../packages/web-ui/src/lib/inbox-rule-prefill.js';

/** The subject the inbox stores for a mail with this raw subject, which the pane reads. */
function storedSubject(raw: string): string {
  return envelopeToItemInputFields({ from: [{ address: 'a@b.example' }], subject: raw, date: new Date(), snippet: '', messageId: 'm', inReplyTo: undefined } as never).subject ?? '';
}

/** Whether a confirmed subject rule with this value files the mail with this raw subject. */
function ruleMatchesRaw(value: string, rawSubject: string): boolean {
  const rule = { id: 'r', accountId: 'acc', matcherKind: 'subject_contains', matcherValue: value, bucket: 'auto_handled', action: 'archive', status: 'confirmed' };
  const loader = new InboxRulesLoader({ listConfirmedRulesForAccount: () => [rule] } as never);
  return loader.match({ accountId: 'acc', from: 'a@b.example', subject: rawSubject }) !== null;
}

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

  it('keeps a stored subject whole exactly where the engine takes it, code point by code point', () => {
    const differ: string[] = [];
    for (const cp of CODE_POINTS) {
      // The pane reads the subject as stored, so the sample goes through `sanitizeHeader` first.
      const subject = sanitizeHeader(`Rechnung${String.fromCodePoint(cp)}Lieferant`, 998);
      const keptWhole = client.subjectRulePrefill(subject) === subject;
      const engineTakes = fixedValueProblem(subject, 'subject_contains') === null;
      if (keptWhole !== engineTakes) differ.push(cp.toString(16));
    }
    expect(differ).toEqual([]);
    // Positive control: the stored samples hold both outcomes.
    const stored = CODE_POINTS.map((cp) => sanitizeHeader(`a${String.fromCodePoint(cp)}b`, 998));
    expect(stored.filter((v) => fixedValueProblem(v, 'subject_contains') === null).length).toBeGreaterThan(3);
    expect(stored.filter((v) => fixedValueProblem(v, 'subject_contains') !== null).length).toBeGreaterThan(5);
  });

  it('offers only a subject phrase the engine takes, and its rule files the raw mail it came from', () => {
    // raw subject -> stored subject -> offered value -> create check -> the loader on the raw subject
    const raws = [
      '\u26A0\uFE0F Mahnung Nr. 42', 'Zahlungserinnerung 42', 'Newsletter\u200B KW 45', 'Re: Rechnung\tNr. 42', 'Rechnung  Nr. 42',
      'Rechnung\r\n Nr. 42', '\uFEFFRechnung', 'a\u200Bb\u200Bc', '\u202EgnunhceR', 'Angebot \u{E0041}\u{E0042} Juli',
      'Familie \u{1F468}\u200D\u{1F469}\u200D\u{1F467}', '\u{1F600}\u{1F600}\u{1F600}', 'x'.repeat(250),
      `${'x'.repeat(550)} Bestellung 4711`, '\u039B\u039F\u0393\u0391\u03A1\u0399\u0391\u03A3\u039C\u039F\u03A3\u200B\u0391\u0398\u0397\u039D\u0391',
      `${'\u0391'.repeat(199)}\u03A3\u0391`,
      'Sale \u034F\u034F\u034F jetzt', 'Rechnung\u2800Nr. 42', `${'x'.repeat(210)} \u034F jetzt`, 'Hi', ' ab ', '\u{1F600}\u{1F600}',
    ];
    const notOffered: string[] = [];
    for (const raw of raws) {
      const value = client.subjectRulePrefill(storedSubject(raw));
      if (value === null) { notOffered.push(raw); continue; }
      expect(fixedValueProblem(value, 'subject_contains'), raw).toBeNull();
      expect(ruleMatchesRaw(value, raw), raw).toBe(true);
    }
    // Positive control: some are offered, some are not, and the warning sign is offered.
    expect(notOffered).toEqual(['Sale \u034F\u034F\u034F jetzt', 'Rechnung\u2800Nr. 42', `${'x'.repeat(210)} \u034F jetzt`, 'Hi', ' ab ', '\u{1F600}\u{1F600}']);
    expect(client.subjectRulePrefill(storedSubject('\u26A0\uFE0F Mahnung Nr. 42'))).toBe('\u26A0 Mahnung Nr. 42');
    // ...and the check can fail: an unrelated value does not file the mail.
    expect(ruleMatchesRaw('Mahnung Nr. 43', '\u26A0\uFE0F Mahnung Nr. 42')).toBe(false);
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
