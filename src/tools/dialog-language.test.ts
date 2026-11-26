import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDangerousDetailed, type DangerSignal } from './permission-guard.js';
import { flattenPrompt } from '../core/prompt-value.js';
import { ACTION_WORDS, GUARD_TEXT, RULE_LABELS_DE, SECRET_DIALOG, SPAWN_DIALOG, exfilWarning, type DialogLanguage } from './dialog-text.js';
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

  it('marks [GESPERRT in the German text wherever the English has [BLOCKED; the warning that decides stays English', () => {
    for (const c of CASES) {
      const en = ask(c, 'en');
      const de = ask(c, 'de');
      expect(flattenPrompt(de.prompt).includes('[GESPERRT'), `${c[0]} ${JSON.stringify(c[1])}`).toBe(en.warning.includes('[BLOCKED'));
      expect(flattenPrompt(de.prompt).includes('[BLOCKED'), `${c[0]}`).toBe(false);
      expect(de.warning, `${c[0]}`).toBe(en.warning);
    }
  });

  it('reads as German: the tool\'s German word and the German sentence', () => {
    expect(flattenPrompt(ask(CASES[1]!, 'de').prompt)).toBe('⚠ Befehl: git push (nur auf ausdrücklichen Wunsch) — "git push origin main"');
    expect(flattenPrompt(ask(CASES[3]!, 'de').prompt)).toBe(`⚠ Dateizugriff: ${GUARD_TEXT.de.readSensitive} — "/etc/shadow" — ${GUARD_TEXT.de.systemFiles}`);
    expect(flattenPrompt(ask(CASES[11]!, 'de').prompt)).toBe('⚠ Google Drive: Datei hochladen — ändert Daten ausserhalb von lynox');
    expect(flattenPrompt(ask(CASES[12]!, 'de').prompt)).toBe('⚠ Google Drive: Datei hochladen [GESPERRT — dafür brauche ich dein OK]');
    expect(flattenPrompt(ask(CASES[14]!, 'de').prompt)).toBe('⚠ Externes Werkzeug "Merge": "drop" [GESPERRT — das Löschen gespeicherter Daten braucht dein OK]');
  });

  it('names a built-in tool\'s action in words in both languages, and an action without words as a value', () => {
    expect(ask(CASES[11]!, 'en').warning).toBe('⚠ Google Drive: upload file — modifies external data');
    const odd = ask(CASES[13]!, 'de');
    expect(odd.prompt.segments.filter((g) => g.kind === 'value').map((g) => g.text)).toEqual(['odd']);
  });
});

describe('the German delegation sentence puts its verb last', () => {
  it('for one child on a model of unknown band', () => {
    const d = SPAWN_DIALOG.de;
    expect(d.sentence('Delegation', d.children(1), d.tierUnknownBand, '0.40', 'Anthropic', d.tailDowngrade))
      .toBe(`⚠ Delegation: Eine Teilaufgabe würde auf ${d.tierUnknownBand} laufen. Geschätzte Modellkosten für diese Sitzung: etwa $0.40. Anbieter: Anthropic. ${d.tailDowngrade}`);
  });
});

describe('a tool from outside the engine', () => {
  it('is not told the language, so it cannot show one thing and have another decided', () => {
    const seen: unknown[] = [];
    const entry = destructive('Merge', 'data', () => null);
    (entry.destructive as { check: (i: unknown, ctx: unknown) => string | null }).check = (_i, ctx) => { seen.push(ctx); return (ctx as { language?: string }).language === 'de' ? 'harmless' : 'drop everything'; };
    const s = isDangerousDetailed('Merge', {}, 'guided', entry, undefined, undefined, undefined, 'de');
    expect(seen.length).toBeGreaterThanOrEqual(2);
    for (const ctx of seen) expect(Object.hasOwn(ctx as object, 'language'), JSON.stringify(ctx)).toBe(false);
    expect(s?.prompt.segments.filter((g) => g.kind === 'value').map((g) => g.text)).toEqual(['Merge', 'drop everything']);
    expect(s?.warning).toContain('drop everything');
  });
});

describe('the question\'s wording can never fail or skip the decision', () => {
  it('a check that throws only while the question is worded leaves the English question, and the call is audited', async () => {
    const { channels } = await import('../core/observability.js');
    const published: unknown[] = [];
    const listener = (m: unknown): void => { published.push(m); };
    channels.guardBlock.subscribe(listener);
    try {
      const entry = destructive('data_store_drop', 'data', () => '');
      let calls = 0;
      (entry.destructive as { check: (i: unknown, ctx: unknown) => string | null }).check = (_i, ctx) => {
        calls += 1;
        if ((ctx as { language?: string }).language === 'de') throw new Error('only when worded');
        return '';
      };
      const s = isDangerousDetailed('data_store_drop', { collection: 'c' }, 'autonomous', entry, undefined, undefined, undefined, 'de');
      expect(calls).toBeGreaterThanOrEqual(2);
      expect(flattenPrompt(s!.prompt)).toBe(s!.warning);
      expect(published).toHaveLength(1);
    } finally {
      channels.guardBlock.unsubscribe(listener);
    }
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
    expect(q).toBe('Befehl möchte diese Geheimnisse verwenden: TOKEN. Erlauben?');
    expect(flattenPrompt(SECRET_DIALOG.de.plain(dialogToolHead('Merge', 'de'), 'TOKEN'))).toBe('Externes Werkzeug "Merge" möchte diese Geheimnisse verwenden: TOKEN. Erlauben?');
    expect(flattenPrompt(SECRET_DIALOG.de.inInput(dialogToolHead('bash', 'de'), 'TOKEN', 'curl'))).toBe('Befehl möchte diese Geheimnisse verwenden: TOKEN, in: curl — Erlauben?');
    const ext = SECRET_DIALOG.en.plain(dialogToolHead('Merge', 'en'), 'TOKEN');
    expect(ext.segments.filter((g) => g.kind === 'value').map((g) => g.text)).toEqual(['Merge', 'TOKEN']);
  });
});

describe('every place a question is posed hands it the language', () => {
  const src = (rel: string): string => readFileSync(join(process.cwd(), 'src', rel), 'utf8');

  it('the agent is built with the configured language, and a child and a workflow step take it on', () => {
    expect(src('core/session.ts')).toContain('language: this.engine.config.language,');
    expect(src('orchestrator/runtime-adapter.ts').match(/language: config\.language,/g)?.length).toBe(2);
    expect(src('tools/builtin/spawn.ts')).toContain('language: parentAgent.dialogLanguage,');
    expect(src('core/agent.ts')).toContain('this.dialogLanguage = noticeLanguage(config.language);');
  });

  it('every dialog table is indexed by the language handed in, never by a fixed one', () => {
    const allowed = new Set(["agent.dialogLanguage ?? 'en'", 'language', 'this.dialogLanguage', "ctx?.language ?? 'en'", 'l']);
    let seen = 0;
    for (const rel of ['tools/builtin/http.ts', 'tools/builtin/api-setup.ts', 'tools/builtin/spawn.ts', 'core/agent.ts']) {
      for (const m of src(rel).matchAll(/[A-Z][A-Z_]*_(?:DIALOG|NOTE)\[([^\]]+)\]/g)) {
        seen += 1;
        expect(allowed.has(m[1]!), `${rel}: ${m[0]}`).toBe(true);
      }
    }
    expect(seen).toBeGreaterThanOrEqual(12);
  });

  it('a tool\'s own check and the tools\' own questions read it', () => {
    expect(GUARD).toContain('BUILTIN_TOOL_NAMES.has(toolName) ? { autonomy, parentProvider, language } : { autonomy, parentProvider }');
    expect(src('tools/builtin/spawn.ts')).toContain("SPAWN_DIALOG[ctx?.language ?? 'en']");
    expect(src('tools/builtin/http.ts').match(/agent\.dialogLanguage \?\? 'en'/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it('says the exfiltration warnings and the delegation consent in German', () => {
    const http = src('tools/builtin/http.ts');
    const fn = http.slice(http.indexOf('function detectGetExfiltration'));
    const warnings = [...fn.slice(0, fn.indexOf('\n}')).matchAll(/return\s+'([^']+)'/g)].map((m) => m[1]!);
    expect(warnings.length).toBeGreaterThanOrEqual(2);
    for (const w of warnings) expect(exfilWarning(w, 'de'), w).not.toBe(w);
    expect(SPAWN_DIALOG.de.sentence('Delegation', SPAWN_DIALOG.de.children(2), SPAWN_DIALOG.de.tierDeep, '1.20', 'Anthropic', SPAWN_DIALOG.de.tailPinned))
      .toBe('⚠ Delegation: 2 Teilaufgaben würden auf der Stufe Tief (ein stärkeres Denkmodell, leistungsfähiger, aber teurer) laufen. Geschätzte Modellkosten für diese Sitzung: etwa $1.20. Anbieter: Anthropic. Ein Modellprofil legt einen bestimmten Endpunkt fest und lässt sich nicht herabstufen. Erlaube das nur, wenn dieser Lauf auf diesem Modell laufen soll.');
  });
});
