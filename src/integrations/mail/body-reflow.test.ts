import { describe, expect, it } from 'vitest';
import { reflowMailBody } from './body-reflow.js';

describe('reflowMailBody', () => {
  it('joins hard-wrapped running text into one line per paragraph', () => {
    // The 2026-08-14 symptom: model-emitted ~76-char editing wrap, rendered by
    // Apple Mail as breaks mid-sentence (text/plain, no format=flowed).
    const body = [
      'Hallo Alice,',
      'danke für dein Angebot. Ich habe die Unterlagen geprüft und',
      'möchte zwei Punkte anpassen, bevor wir unterschreiben.',
      '',
      'Viele Grüsse,',
      'Rafael',
    ].join('\n');
    expect(reflowMailBody(body)).toBe(
      'Hallo Alice, danke für dein Angebot. Ich habe die Unterlagen geprüft und möchte zwei Punkte anpassen, bevor wir unterschreiben.\n'
      + '\nViele Grüsse, Rafael',
    );
  });

  it('keeps paragraph structure: an empty line always starts a new line', () => {
    const body = 'Erster Absatz\nzweite Zeile.\n\nZweiter Absatz.';
    expect(reflowMailBody(body)).toBe('Erster Absatz zweite Zeile.\n\nZweiter Absatz.');
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

  it('is idempotent — a second pass changes nothing', () => {
    const body = 'Erste Zeile, die das Modell\nnoch hart umgebrochen hat.\n\nZweiter Absatz.\n';
    expect(reflowMailBody(reflowMailBody(body))).toBe(reflowMailBody(body));
  });

  it('returns input unchanged when there is nothing to join', () => {
    const body = 'Einzeiler ohne Umbruch.';
    expect(reflowMailBody(body)).toBe(body);
  });

  it('handles CRLF input (Windows-provided bodies) like LF input', () => {
    const body = 'Zeile eins die\r\nhart umbrochen ist.';
    expect(reflowMailBody(body)).toBe('Zeile eins die hart umbrochen ist.');
  });
});
