// The rule match compares the mail and the rule value the way the inbox stores a header
// (`normalizeHeaderText`), so a rule made from what the owner reads matches the mail it came from.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MailStateDb } from '../mail/state.js';
import { InboxStateDb, envelopeToItemInputFields } from './state.js';
import { InboxRulesLoader, ruleMatchText } from './rules-loader.js';
import { normalizeHeaderText, sanitizeHeader } from './classifier/sanitize.js';
import { fixedValueProblem } from './rule-text.js';
import type { MailAccountConfig } from '../mail/provider.js';
import type { InboxRule } from '../../types/index.js';

const ACCOUNT: MailAccountConfig = {
  id: 'acct-1',
  displayName: 'Me',
  address: 'me@acme.example',
  preset: 'custom',
  imap: { host: 'i', port: 993, secure: true },
  smtp: { host: 's', port: 465, secure: true },
  authType: 'imap',
  type: 'personal',
  isDefault: true,
};

let mail: MailStateDb;
let inbox: InboxStateDb;
let loader: InboxRulesLoader;

beforeEach(() => {
  mail = new MailStateDb({ path: ':memory:' });
  mail.upsertAccount(ACCOUNT);
  inbox = new InboxStateDb(mail.getConnection());
  loader = new InboxRulesLoader(inbox);
});

afterEach(() => {
  mail.close();
});

/** What the inbox stores for a mail with this raw subject and sender. */
function stored(subject: string, from = 'a@b.example'): { subject: string; fromAddress: string } {
  const f = envelopeToItemInputFields({ from: [{ address: from }], subject, date: new Date(), snippet: '', messageId: 'm', inReplyTo: undefined } as never);
  return { subject: f.subject ?? '', fromAddress: f.fromAddress ?? '' };
}

/** A loader holding exactly one confirmed rule, for the pure checks. */
function oneRule(kind: InboxRule['matcherKind'], value: string): InboxRulesLoader {
  const rule = { id: 'r', accountId: 'acc', matcherKind: kind, matcherValue: value, bucket: 'auto_handled', action: 'archive', status: 'confirmed' };
  return new InboxRulesLoader({ listConfirmedRulesForAccount: () => [rule] } as never);
}

function subjectMatches(value: string, subject: string): boolean {
  return oneRule('subject_contains', value).match({ accountId: 'acc', from: 'x@y.example', subject }) !== null;
}

/** The comparison before this change, the reference the new one must not lose a match of. */
function oldMatch(value: string, subject: string): boolean {
  return subject.toLowerCase().includes(value.toLowerCase());
}

/** A seeded PRNG (mulberry32), so a failing case can be replayed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Letters with case quirks, every kind of whitespace and line break, hidden characters the
// stored header drops, ones it keeps (U+034F), and emoji with their variation selector.
const POOL = [
  'a', 'b', 'R', 'x', ' ', ' ', ' ', '\t', '\u00A0', '\r', '\n', '\u200B', '\u200D', '\u2028', '\u202E', '\u2060',
  '\uFEFF', '\uFE0F', '\u26A0', '\u{1F600}', '\u{E0041}', '\u{E0100}', '\u034F', '\u03A3', '\u03C2', '\u03C3',
  '\u0391', '\u0130', 'i', '\u0307',
];

function randomText(rand: () => number, length: number): string {
  let s = '';
  for (let i = 0; i < length; i++) s += POOL[Math.floor(rand() * POOL.length)]!;
  return s;
}

/** Subjects and rule values; half the values are a piece of their subject, so many match. A long
 *  subject is long enough that more than 500 characters remain once the hidden ones are gone. */
function* cases(seed: number, n: number): Generator<{ subject: string; value: string }> {
  const rand = mulberry32(seed);
  for (let i = 0; i < n; i++) {
    const long = rand() < 0.2;
    const subject = randomText(rand, long ? 900 + Math.floor(rand() * 300) : Math.floor(rand() * 40));
    const chars = Array.from(subject);
    let value: string;
    if (rand() < 0.5 && chars.length > 0) {
      // From a long subject a longer piece, so one behind character 500 rarely recurs before it.
      const start = Math.floor(rand() * chars.length);
      value = chars.slice(start, start + 1 + Math.floor(rand() * (long ? 40 : 12))).join('');
    } else {
      value = randomText(rand, 1 + Math.floor(rand() * 6));
    }
    yield { subject, value };
  }
}

/** Every case the old comparison matched that `match` does not: the counterexamples. */
function lostMatches(seed: number, n: number, match: (value: string, subject: string) => boolean): { lost: string[]; oldMatches: number; skippedEmpty: number } {
  const lost: string[] = [];
  let oldMatches = 0;
  let skippedEmpty = 0;
  for (const { subject, value } of cases(seed, n)) {
    if (!oldMatch(value, subject)) continue;
    // A value with nothing left once normalized never matches, by design (create refuses one).
    if (ruleMatchText(value) === '') { skippedEmpty++; continue; }
    oldMatches++;
    if (!match(value, subject)) lost.push(JSON.stringify({ subject, value }));
  }
  return { lost, oldMatches, skippedEmpty };
}

const SEED = 0x801e;
const N = 20_000;

describe('normalizeHeaderText and sanitizeHeader share one rule set', () => {
  it('sanitizeHeader is normalizeHeaderText cut to the length', () => {
    const raw = ` \u26A0\uFE0F Re:\tRech\u200Bnung\r\n  Nr.\u00A042 ${'x'.repeat(600)}`;
    expect(normalizeHeaderText(raw)).toBe(`\u26A0 Re: Rechnung Nr. 42 ${'x'.repeat(600)}`);
    expect(sanitizeHeader(raw)).toBe(normalizeHeaderText(raw).slice(0, 500));
    expect(sanitizeHeader(raw, 998)).toBe(normalizeHeaderText(raw).slice(0, 998));
  });
});

describe('a rule made from the stored subject or sender matches the mail it came from', () => {
  it.each([
    ['an emoji with its variation selector', '\u26A0\uFE0F Mahnung Nr. 42'],
    ['a double space', 'Rechnung  Nr. 42'],
    ['a tab', 'Re: Rechnung\tNr. 42'],
    ['a zero-width space', 'Newsletter\u200B KW 45'],
    ['a line break', 'Rechnung\r\n Nr. 42'],
    ['tag characters', 'Angebot \u{E0041}\u{E0042} Juli'],
  ])('with %s', (_label, raw) => {
    const value = stored(raw).subject;
    expect(fixedValueProblem(value, 'subject_contains')).toBeNull();
    // The comparison before this change missed it; the stored value is what the owner sees.
    expect(oldMatch(value, raw)).toBe(false);
    expect(subjectMatches(value, raw)).toBe(true);
  });

  it('with a sender whose raw address carries a hidden character', () => {
    const raw = 'Rechnung@Lieferant.example\u200B';
    const value = stored('x', raw).fromAddress;
    expect(value).toBe('Rechnung@Lieferant.example');
    expect(oneRule('from', value).match({ accountId: 'acc', from: raw, subject: 'x' })).not.toBeNull();
    expect(oneRule('from', value).match({ accountId: 'acc', from: 'andere@lieferant.example', subject: 'x' })).toBeNull();
  });

  it('with a list id whose raw value carries a hidden character', () => {
    expect(oneRule('list_id', 'news.example').match({ accountId: 'acc', from: 'x@y', subject: 'x', listId: 'News.example\u200B' })).not.toBeNull();
  });

  it('reads the Greek final sigma as the medial one on both sides', () => {
    // Lowercasing picks \u03C2 or \u03C3 by the letters around \u03A3; a piece of the subject does not carry them.
    expect(subjectMatches('\u039B\u039F\u0393\u0391\u03A1\u0399\u0391\u03A3\u039C\u039F\u03A3', '\u039B\u039F\u0393\u0391\u03A1\u0399\u0391\u03A3\u039C\u039F\u03A3\u200B\u0391\u0398\u0397\u039D\u0391')).toBe(true);
    expect(subjectMatches(`${'\u0391'.repeat(199)}\u03A3`, `${'\u0391'.repeat(199)}\u03A3\u0391`)).toBe(true);
    expect(ruleMatchText('\u03A3\u03A3')).toBe('\u03C3\u03C3');
  });

  it('still tells subjects apart that differ in letters', () => {
    expect(subjectMatches('Mahnung', '\u26A0\uFE0F Rechnung')).toBe(false);
    expect(subjectMatches('Rechnung Nr. 43', 'Rechnung  Nr. 42')).toBe(false);
  });
});

describe('every case that matched before still matches', () => {
  it.each([
    ['Invoice', 'Your INVOICE for May'],
    ['\u26A0\uFE0F Mahnung', '\u26A0\uFE0F Mahnung 4711'],
    ['Rechnung  Nr\u00A0471', 'Re: Rechnung  Nr\u00A0471'],
    [' rechnung ', 'Re: Rechnung 42'],
    ['\u0130stanbul', 'Rechnung \u0130stanbul'],
  ])('%j in %j', (value, subject) => {
    expect(oldMatch(value, subject)).toBe(true);
    expect(subjectMatches(value, subject)).toBe(true);
  });

  it('a value behind character 500 of a long subject', () => {
    const subject = `${'x'.repeat(550)} Bestellung 4711 ${'y'.repeat(30)}`;
    expect(Array.from(subject).length).toBeGreaterThan(590);
    expect(oldMatch('Bestellung 4711', subject)).toBe(true);
    expect(subjectMatches('Bestellung 4711', subject)).toBe(true);
  });

  it(`fuzz: old match implies new match (mulberry32 seed ${String(SEED)}, n ${String(N)}), with a control that finds a counterexample`, () => {
    const real = lostMatches(SEED, N, subjectMatches);
    // Control: the same generator against a variant known to be wrong (the subject cut at 500,
    // as `sanitizeHeader` cuts it) must find a lost match, or the generator cannot find one.
    const control = lostMatches(SEED, N, (value, subject) =>
      ruleMatchText(sanitizeHeader(subject)).includes(ruleMatchText(value)));
    expect(control.lost.length).toBeGreaterThanOrEqual(1);
    expect(real.lost).toEqual([]);
    expect(real.oldMatches).toBeGreaterThan(N / 10);
  });
});

describe('a rule value with nothing left once normalized never matches', () => {
  it.each([
    ['subject_contains', '\u200B\u200B\u200B'],
    ['subject_contains', ' \u2060 '],
    ['from', '\u200B'],
  ] as const)('%s %j', (kind, value) => {
    // Inserted as a restored or hand-edited database could hold it: create refuses it.
    inbox.insertRule({ accountId: 'acct-1', matcherKind: kind, matcherValue: value, bucket: 'auto_handled', action: 'archive', source: 'on_demand' });
    expect(loader.match({ accountId: 'acct-1', from: '\u200B', subject: 'Rechnung 42' })).toBeNull();
    expect(loader.match({ accountId: 'acct-1', from: 'a@b.example', subject: '' })).toBeNull();
  });

  it('create refuses such a value (seeded fuzz over the same pool)', () => {
    for (const v of ['\u200B\u200B\u200B', ' \u2060 ', '\uFE0F\uFE0F\uFE0F', '\u200D\u200D\u200D', '\u{E0041}\u{E0042}\u{E0043}', '   ']) {
      expect(fixedValueProblem(v, 'subject_contains'), JSON.stringify(v)).not.toBeNull();
      expect(fixedValueProblem(v, 'from'), JSON.stringify(v)).not.toBeNull();
    }
    const rand = mulberry32(SEED + 1);
    let accepted = 0;
    for (let i = 0; i < N; i++) {
      const v = randomText(rand, 1 + Math.floor(rand() * 8));
      if (fixedValueProblem(v, 'subject_contains') !== null) continue;
      accepted++;
      expect(ruleMatchText(v), JSON.stringify(v)).not.toBe('');
    }
    expect(accepted).toBeGreaterThan(100);
  });
});

describe('the cache holds the normalized values and is dropped as before', () => {
  it('a rule added after invalidate matches by its normalized value; a deleted one stops', () => {
    expect(loader.match({ accountId: 'acct-1', from: 'x@y.example', subject: '\u26A0\uFE0F Mahnung 42' })).toBeNull();
    const id = inbox.insertRule({ accountId: 'acct-1', matcherKind: 'subject_contains', matcherValue: '\u26A0 Mahnung', bucket: 'auto_handled', action: 'archive', source: 'on_demand' });
    // Cached empty list until invalidated, as before.
    expect(loader.match({ accountId: 'acct-1', from: 'x@y.example', subject: '\u26A0\uFE0F Mahnung 42' })).toBeNull();
    loader.invalidate('acct-1');
    expect(loader.match({ accountId: 'acct-1', from: 'x@y.example', subject: '\u26A0\uFE0F Mahnung 42' })?.id).toBe(id);
    expect(inbox.deleteRule(id)).toBe(true);
    loader.invalidate('acct-1');
    expect(loader.match({ accountId: 'acct-1', from: 'x@y.example', subject: '\u26A0\uFE0F Mahnung 42' })).toBeNull();
  });
});
