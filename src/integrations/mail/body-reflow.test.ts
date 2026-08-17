import { describe, expect, it } from 'vitest';
import { reflowMailBody } from './body-reflow.js';

describe('reflowMailBody', () => {
  it('joins hard-wrapped running text into one line per paragraph', () => {
    // The 2026-08-14 symptom: model-emitted ~76-char editing wrap, rendered by
    // Apple Mail as breaks mid-sentence (text/plain, no format=flowed).
    // EXPECTATION CORRECTED 2026-08-17. This assert used to demand
    // `Hallo Alice, danke für…` and `Viele Grüsse, Rafael` — i.e. it pinned the
    // salutation and the sign-off being pulled INTO the running text. That was
    // the reflow overshooting, encoded as if it were the fix: both lines are
    // running text by every structural test, and nothing asked whether the line
    // before them was long enough to have been machine-wrapped. The paragraph
    // lines are also lengthened to a realistic wrap width, so the join this test
    // exists for is still exercised.
    const body = [
      'Hallo Alice,',
      'danke für dein Angebot. Ich habe die Unterlagen sorgfältig geprüft und',
      'möchte zwei Punkte anpassen, bevor wir das Ganze unterschreiben.',
      '',
      'Viele Grüsse,',
      'Rafael',
    ].join('\n');
    expect(reflowMailBody(body)).toBe(
      'Hallo Alice,\n'
      + 'danke für dein Angebot. Ich habe die Unterlagen sorgfältig geprüft und möchte zwei Punkte anpassen, bevor wir das Ganze unterschreiben.\n'
      + '\nViele Grüsse,\nRafael',
    );
  });

  it('keeps paragraph structure: an empty line always starts a new line', () => {
    // ORIGINAL INPUT RESTORED 2026-08-17. An earlier version of this fix changed
    // the input here to make a failing assertion pass; that was the wrong edit.
    // The input was never the problem — the EXPECTATION was: joining two 13-char
    // lines is not reflow, it is mangling. Nothing in this body was ever wrapped
    // (its longest line is 15 characters, so there is no wrap column to infer),
    // so the correct answer is to leave it alone, blank line and all.
    const body = 'Erster Absatz\nzweite Zeile.\n\nZweiter Absatz.';
    expect(reflowMailBody(body)).toBe(body);
  });

  it('joins across a realistically wrapped paragraph and stops at the blank line', () => {
    // The join-across-a-paragraph case the test above USED to claim, on a body
    // that was actually wrapped. Added rather than substituted, so both the
    // "short lines are not wrapped text" and the "wrapped text joins" halves
    // have their own assertion.
    const body = 'Ein erster Absatz, den das Modell bei etwa achtzig Zeichen hart\numbrochen hat.\n\nZweiter Absatz.';
    expect(reflowMailBody(body)).toBe('Ein erster Absatz, den das Modell bei etwa achtzig Zeichen hart umbrochen hat.\n\nZweiter Absatz.');
  });

  it('keeps a delimiter-less signature and address block on its own lines', () => {
    // The case the structural tests cannot see: every one of these is running
    // text — no `-- ` delimiter, no list marker, no double space, no indent.
    //
    // Deliberately includes a 55-character address+phone line and a website
    // line. A review showed the first version of this fixture was hand-picked:
    // every line in it happened to be short, and adding one ordinary long line
    // brought the collapse straight back. Asserted with `toBe` over the whole
    // output — the three `toContain` prefixes it replaces were satisfied by an
    // output that still exhibited the bug.
    const body = [
      'Wir haben den Termin nun definitiv auf Donnerstag gelegt und melden',
      'uns davor noch einmal.',
      '',
      'Mit freundlichen Grüßen',
      'Max Mustermann',
      'Mustermann Treuhand AG',
      'Bahnhofstrasse 1, 8001 Zürich, Telefon +41 44 123 45 67',
      'www.mustermann-treuhand.example.ch',
    ].join('\n');
    expect(reflowMailBody(body)).toBe([
      'Wir haben den Termin nun definitiv auf Donnerstag gelegt und melden uns davor noch einmal.',
      '',
      'Mit freundlichen Grüßen',
      'Max Mustermann',
      'Mustermann Treuhand AG',
      'Bahnhofstrasse 1, 8001 Zürich, Telefon +41 44 123 45 67',
      'www.mustermann-treuhand.example.ch',
    ].join('\n'));
  });

  it('joins a wrapped line whose successor starts with a long compound', () => {
    // The direction a fixed length threshold got wrong. At a ~76-column wrap a
    // line can end at 62 characters purely because the next word is 29 long —
    // that is a machine wrap and must still join. German business vocabulary
    // clears that bar routinely, and so does every URL.
    const body = [
      'Bitte beachten Sie die beigelegte Quartalsauswertung sowie die',
      'Sozialversicherungsabrechnung fuer das zweite Quartal des Jahres.',
    ].join('\n');
    expect(reflowMailBody(body)).toBe(
      'Bitte beachten Sie die beigelegte Quartalsauswertung sowie die Sozialversicherungsabrechnung fuer das zweite Quartal des Jahres.',
    );
  });

  // ── The constants, pinned at their edges ──────────────────────────────────
  // Synthetic on purpose: these fix the RULE, not a realistic body. The previous
  // version of this module carried a threshold that every value in a 40-wide
  // range satisfied, so the number was decoration — a review had to discover
  // that, because nothing in the suite could. Each case below is one character
  // away from flipping.
  const lineOf = (n: number): string => 'x'.repeat(n - 5) + ' ende';

  it('pins WRAP_TOLERANCE from below — a line exactly at the edge still counts as wrapped', () => {
    // Longest line 72, so the edge sits at 72 - 12 = 60. With the tolerance one
    // narrower, the 60-line stops counting, the majority flips, and the run is
    // left verbatim at 4 lines.
    const body = [lineOf(72), lineOf(60), lineOf(30), lineOf(18)].join('\n');
    expect(reflowMailBody(body).split('\n').length).toBeLessThan(4);
  });

  it('pins WRAP_TOLERANCE from above — one character past the edge does NOT count', () => {
    // Same shape with 59 instead of 60. It must stay verbatim; a tolerance of 13
    // would pull it in and start joining author-broken blocks.
    const body = [lineOf(72), lineOf(59), lineOf(30), lineOf(18)].join('\n');
    expect(reflowMailBody(body)).toBe(body);
  });

  it('pins the exclusion of the last line from the vote', () => {
    // The remainder is short by construction, so counting it would bias every
    // short paragraph toward "not wrapped". Here it is decisive: including it
    // turns a 1-of-2 majority into 1-of-3 and leaves the body at 3 lines.
    const body = [lineOf(72), lineOf(30), lineOf(30)].join('\n');
    expect(reflowMailBody(body).split('\n').length).toBe(2);
  });

  it('leaves quoted reply chains verbatim', () => {
    const body = 'Antwort unten.\n\n> Am Montag schrieb Alice:\n> das ist eine\n> zitierte Zeile';
    expect(reflowMailBody(body)).toBe(body);
  });

  it('leaves list items as their own lines', () => {
    const body = 'Punkte:\n- erstens\n- zweitens\n1. auch nummeriert\n2) zweite runde';
    expect(reflowMailBody(body)).toBe(body);
  });

  it('leaves fenced code blocks verbatim — and does not join around them', () => {
    const body = 'Der Fix:\n```sql\nSELECT 1\n  FROM t;\n```\nFertig.';
    expect(reflowMailBody(body)).toBe(body);
  });

  it('preserves everything after the RFC 3676 signature delimiter', () => {
    const body = 'Kurze Mail.\n\n-- \nRafael Burlet\nlynox GmbH';
    expect(reflowMailBody(body)).toBe(body);
  });

  it('leaves column-aligned lines alone (two or more consecutive spaces)', () => {
    const body = 'Übersicht:\nPosition  Menge   Preis\nA         2       4.00';
    expect(reflowMailBody(body)).toBe(body);
  });

  it('is idempotent on a genuinely wrapped body', () => {
    // ORIGINAL INPUT RESTORED, with a wrapped one beside it. Measured across 172
    // greedy-wrapped paragraphs at six wrap columns: 0 non-idempotent.
    const short = 'Erste Zeile, die das Modell\nnoch hart umgebrochen hat.\n\nZweiter Absatz.\n';
    expect(reflowMailBody(reflowMailBody(short))).toBe(reflowMailBody(short));
    const wrapped = 'Eine erste Zeile, die das Modell an der üblichen Stelle noch\nhart umgebrochen hat.\n\nZweiter Absatz.\n';
    expect(reflowMailBody(reflowMailBody(wrapped))).toBe(reflowMailBody(wrapped));
  });

  it('is NOT idempotent when an author break sits inside wrapped text — the known limit', () => {
    // Pinned rather than claimed away. The wrap column is INFERRED, so a joined
    // line becomes the new longest line: a body mixing machine wrap with a
    // deliberate break reads differently on a second pass. Pass 1 preserves the
    // author's break — which is the point — and pass 2 closes it.
    //
    // Not reachable in production: both call sites reflow the raw body exactly
    // once. This test is what goes red if that stops being true, and it asserts
    // the ACTUAL behaviour so that making it idempotent one day fails here and
    // gets removed deliberately instead of drifting.
    const body = [
      'Wir haben Ihre Unterlagen erhalten und heute vollstaendig geprueft',
      'und freuen uns.',
      'Bitte melden Sie sich bei Rueckfragen jederzeit bei uns.',
    ].join('\n');
    const pass1 = reflowMailBody(body);
    expect(pass1.split('\n')).toHaveLength(2);
    expect(reflowMailBody(pass1).split('\n')).toHaveLength(1);
  });

  it('returns input unchanged when there is nothing to join', () => {
    const body = 'Einzeiler ohne Umbruch.';
    expect(reflowMailBody(body)).toBe(body);
  });

  it('handles CRLF input (Windows-provided bodies) like LF input', () => {
    // ORIGINAL INPUT RESTORED. This test is about \r\n being split like \n, and
    // that holds whether or not the body joins — the earlier rewrite to a
    // 63-char line was an undisclosed red-to-green edit and was not needed.
    // Nothing here is wrapped (longest line 19), so the body survives with its
    // line break and only the carriage return goes.
    expect(reflowMailBody('Zeile eins die\r\nhart umbrochen ist.')).toBe('Zeile eins die\nhart umbrochen ist.');
  });

  it('handles CRLF in a body that DOES join', () => {
    expect(reflowMailBody('Eine Zeile, die ein Windows-Client mit CRLF geliefert hat und die\r\nhart umbrochen ist.'))
      .toBe('Eine Zeile, die ein Windows-Client mit CRLF geliefert hat und die hart umbrochen ist.');
  });});

describe('reflowMailBody — review-hardened shapes (2026-08-14)', () => {
  it('keeps a unified diff verbatim', () => {
    const body = 'Der Fix:\ndiff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n context';
    expect(reflowMailBody(body)).toBe(body);
  });

  it('keeps stack-trace frames verbatim', () => {
    const body = 'Error: boom\n    at foo (/app/x.js:1:2)\n    at bar (/app/y.js:3:4)';
    expect(reflowMailBody(body)).toBe(body);
  });

  it('keeps timestamped log lines verbatim', () => {
    const body = 'Log:\n2026-08-14T12:00:00Z started\n2026-08-14T12:00:01Z done';
    expect(reflowMailBody(body)).toBe(body);
  });

  it('keeps + changelog entries as their own lines', () => {
    const body = 'Changelog:\n+ added feature\n- removed legacy\n+ another add';
    expect(reflowMailBody(body)).toBe(body);
  });

  it('treats a whitespace-only line as a paragraph boundary', () => {
    expect(reflowMailBody('First para.\n   \nSecond para.')).toBe('First para.\n\nSecond para.');
  });

  it('keeps indented continuation lines out of the following paragraph', () => {
    const body = '- item one\n  continuation of item one\nAnd then running prose.';
    expect(reflowMailBody(body)).toBe(body);
  });
});
