import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDangerousDetailed, type DangerSignal } from './permission-guard.js';
import { flattenPrompt } from '../core/prompt-value.js';
import { ACTION_WORDS, GUARD_TEXT, RULE_LABELS_DE, SECRET_DIALOG, type DialogLanguage } from './dialog-text.js';
import { DIALOG_ONLY_WORDS, DIALOG_ONLY_WORDS_DE, TOOL_LINE_WORDS, TOOL_LINE_WORDS_DE, dialogToolHead } from './tool-words.js';
import type { ToolEntry } from '../types/index.js';

// A confirmation question is asked in the instance's language; the warning the audit and the
// `[BLOCKED` checks read stays English, and the language never changes what is decided.

const GUARD = readFileSync(join(process.cwd(), 'src/tools/permission-guard.ts'), 'utf8');

const destructive = (name: string, mode: 'data' | 'external', check?: () => string | null): ToolEntry => ({
  definition: { name, description: '', input_schema: { type: 'object' as const, properties: {}, required: [] } },
  handler: async () => '',
  destructive: { mode, ...(check ? { check } : {}) },
} as unknown as ToolEntry);

/** A danger of every kind the guard asks about, attended and not. */
const CASES: ReadonlyArray<[string, unknown, 'guided' | 'autonomous', ToolEntry?]> = [
  ['bash', { command: 'rm -rf /' }, 'autonomous'],
  ['bash', { command: 'git push origin main' }, 'guided'],
  ['bash', { command: 'curl -X POST https://example.org' }, 'autonomous'],
  ['read_file', { path: '/etc/shadow' }, 'guided'],
  ['read_file', { path: '/etc/shadow' }, 'autonomous'],
  ['write_file', { path: '/etc/passwd', content: 'x' }, 'autonomous'],
  ['write_file', { path: 'notes.md', content: '  ' }, 'guided'],
  ['batch_files', { directory: '/etc/ssl', operation: 'transform' }, 'autonomous'],
  ['mail_send', { to: 'a@example.org' }, 'autonomous'],
  ['mail_connect', {}, 'guided'],
  ['data_store_drop', { collection: 'c' }, 'autonomous', destructive('data_store_drop', 'data')],
  ['google_drive', { action: 'upload' }, 'guided', destructive('google_drive', 'external', () => 'upload')],
  ['google_drive', { action: 'upload' }, 'autonomous', destructive('google_drive', 'external', () => 'upload')],
  ['google_drive', { action: 'odd' }, 'guided', destructive('google_drive', 'external', () => 'odd')],
  ['Merge', {}, 'autonomous', destructive('Merge', 'data', () => 'drop')],
  ['http_request', { url: 'https://example.org/x', method: 'DELETE' }, 'autonomous'],
  ['http_request', { url: 'https://example.org/x', method: 'POST' }, 'autonomous'],
];

const ask = (c: (typeof CASES)[number], language: DialogLanguage): DangerSignal => {
  const s = isDangerousDetailed(c[0], c[1], c[2], c[3], undefined, undefined, undefined, language);
  if (s === null) throw new Error(`${c[0]} ${JSON.stringify(c[1])} raised no danger — the fixture is wrong`);
  return s;
};

describe('a confirmation question in the instance\'s language', () => {
  it.each(CASES)('%s %j (%s): the same decision and the same English warning in both languages', (...c) => {
    const en = ask(c, 'en');
    const de = ask(c, 'de');
    expect(de.warning).toBe(en.warning);
    expect(de.hardBlock).toBe(en.hardBlock);
    expect(de.payload).toEqual(en.payload);
    // The prompt is the language's own: German differs from English, and every value stays.
    expect(flattenPrompt(de.prompt)).not.toBe(flattenPrompt(en.prompt));
    const values = (s: DangerSignal): string[] => s.prompt.segments.filter((g) => g.kind === 'value').map((g) => g.text);
    expect(values(de)).toEqual(values(en));
    expect(flattenPrompt(en.prompt)).toBe(en.warning.replace(/"([^"]*)"/g, (_m, v: string) => `"${v.replace(/[\\"]/g, (ch) => `\\${ch}`)}"`));
  });

  it('keeps [BLOCKED in the German text wherever the English has it', () => {
    for (const c of CASES) {
      const en = ask(c, 'en');
      expect(flattenPrompt(ask(c, 'de').prompt).includes('[BLOCKED'), `${c[0]} ${JSON.stringify(c[1])}`).toBe(en.warning.includes('[BLOCKED'));
    }
  });

  it('reads as German: the tool\'s German word and the German sentence', () => {
    expect(flattenPrompt(ask(CASES[3]!, 'de').prompt)).toBe(`⚠ Dateizugriff: ${GUARD_TEXT.de.readSensitive} — "/etc/shadow" — ${GUARD_TEXT.de.systemFiles}`);
    expect(flattenPrompt(ask(CASES[11]!, 'de').prompt)).toBe('⚠ Google Drive: Datei hochladen — ändert Daten ausserhalb von lynox');
    expect(flattenPrompt(ask(CASES[12]!, 'de').prompt)).toBe('⚠ Google Drive: Datei hochladen [BLOCKED — dafür brauche ich dein OK]');
    expect(flattenPrompt(ask(CASES[14]!, 'de').prompt)).toBe('⚠ Externes Werkzeug "Merge": "drop" [BLOCKED — das Löschen gespeicherter Daten braucht dein OK]');
  });

  it('names a built-in tool\'s action in words in both languages, and an action without words as a value', () => {
    expect(ask(CASES[11]!, 'en').warning).toBe('⚠ Google Drive: upload file — modifies external data');
    const odd = ask(CASES[13]!, 'de');
    expect(odd.prompt.segments.filter((g) => g.kind === 'value').map((g) => g.text)).toEqual(['odd']);
  });
});

describe('the German texts are complete', () => {
  it('has a German label for every label of the guard\'s rules', () => {
    const labels = [...GUARD.matchAll(/label: '([^']+)'/g)].map((m) => m[1]!);
    const curl = /const CURL_UNREADABLE = '([^']+)'/.exec(GUARD);
    expect(curl).not.toBeNull();
    labels.push(curl![1]!);
    expect(labels.length).toBeGreaterThanOrEqual(120);
    for (const label of labels) expect(Object.hasOwn(RULE_LABELS_DE, label), label).toBe(true);
    // and no German label for a rule that is gone
    for (const label of Object.keys(RULE_LABELS_DE)) expect(labels.includes(label), label).toBe(true);
  });

  it('has the same keys in both languages for every word and action', () => {
    expect(Object.keys(TOOL_LINE_WORDS_DE).sort()).toEqual(Object.keys(TOOL_LINE_WORDS).sort());
    expect(Object.keys(DIALOG_ONLY_WORDS_DE).sort()).toEqual(Object.keys(DIALOG_ONLY_WORDS).sort());
    expect(Object.keys(GUARD_TEXT.de).sort()).toEqual(Object.keys(GUARD_TEXT.en).sort());
    for (const actions of Object.values(ACTION_WORDS)) for (const words of Object.values(actions)) expect(words.de).not.toBe(words.en);
  });

  it('asks about a secret naming the tool by its word, an external one as a value', () => {
    const q = flattenPrompt(SECRET_DIALOG.de.plain(dialogToolHead('bash', 'de'), 'TOKEN'));
    expect(q).toBe('Befehl: möchte diese Geheimnisse verwenden: TOKEN. Erlauben?');
    const ext = SECRET_DIALOG.en.plain(dialogToolHead('Merge', 'en'), 'TOKEN');
    expect(ext.segments.filter((g) => g.kind === 'value').map((g) => g.text)).toEqual(['Merge', 'TOKEN']);
  });
});
