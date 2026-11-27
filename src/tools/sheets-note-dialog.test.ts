import { describe, it, expect } from 'vitest';
import { SHEETS_NOTE_DIALOG, type SheetsNoteDialog } from './dialog-text.js';
import { flattenPrompt, isPromptText } from '../core/prompt-value.js';

/** Each entry said with the same arguments, so the two languages can be compared. */
function said(d: SheetsNoteDialog): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(d) as [string, unknown][]) {
    const value = typeof entry === 'function' ? (entry as (...a: unknown[]) => unknown)(2, 3, true) : entry;
    out[key] = isPromptText(value) ? flattenPrompt(value) : String(value);
  }
  return out;
}

describe('the sheets notes in German', () => {
  it('has every entry the English one has, and none of them is the English text', () => {
    const en = said(SHEETS_NOTE_DIALOG.en);
    const de = said(SHEETS_NOTE_DIALOG.de);
    expect(Object.keys(de).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(en)) expect(de[key], key).not.toBe(en[key]);
  });

  it('says the one-item forms in the singular', () => {
    expect(flattenPrompt(SHEETS_NOTE_DIALOG.de.formulaHead(1))).toContain('1 dieser Zellen beginnt wie eine Formel');
    expect(flattenPrompt(SHEETS_NOTE_DIALOG.de.formatHead(1))).toContain('1 dieser Anfragen kann ');
    expect(flattenPrompt(SHEETS_NOTE_DIALOG.de.formatShown(1))).toBe('Die Anfrage steht hier vollständig:');
    expect(flattenPrompt(SHEETS_NOTE_DIALOG.de.formatMore(1))).toBe('und 1 Formatierungsanfrage, die keinen Zellinhalt schreibt');
  });
});
