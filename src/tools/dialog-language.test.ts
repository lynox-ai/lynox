import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDangerousDetailed, type DangerSignal } from './permission-guard.js';
import { flattenPrompt } from '../core/prompt-value.js';
import { ACTION_WORDS, API_SETUP_DIALOG, CONSENT_LABELS, GUARD_TEXT, RULE_LABELS_DE, SECRET_DIALOG, SPAWN_DIALOG, endsSentence, exfilWarning, type DialogLanguage } from './dialog-text.js';
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
    // The warning quotes with `"`; the English prompt with “ ” around the same value, escaped.
    expect(flattenPrompt(en.prompt)).toBe(en.warning.replace(/"([^"]*)"/g, (_m, v: string) => `“${v.replace(/[\\"“”„]/g, (ch) => `\\${ch}`)}”`));
  });

  it('keeps [BLOCKED in the German text wherever the English has it', () => {
    for (const c of CASES) {
      const en = ask(c, 'en');
      expect(flattenPrompt(ask(c, 'de').prompt).includes('[BLOCKED'), `${c[0]} ${JSON.stringify(c[1])}`).toBe(en.warning.includes('[BLOCKED'));
    }
  });

  it('reads as German: the tool\'s German word and the German sentence', () => {
    expect(flattenPrompt(ask(CASES[1]!, 'de').prompt)).toBe('⚠ Befehl: git push (nur auf ausdrücklichen Wunsch) — „git push origin main“');
    expect(flattenPrompt(ask(CASES[3]!, 'de').prompt)).toBe(`⚠ Dateizugriff: ${GUARD_TEXT.de.readSensitive} — „/etc/shadow“ — ${GUARD_TEXT.de.systemFiles}`);
    expect(flattenPrompt(ask(CASES[11]!, 'de').prompt)).toBe('⚠ Google Drive: Datei hochladen — ändert Daten ausserhalb von lynox');
    expect(flattenPrompt(ask(CASES[12]!, 'de').prompt)).toBe('⚠ Google Drive: Datei hochladen [BLOCKED — dafür brauche ich dein OK]');
    expect(flattenPrompt(ask(CASES[14]!, 'de').prompt)).toBe('⚠ Externes Werkzeug „Merge“: „drop“ [BLOCKED — das Löschen gespeicherter Daten braucht dein OK]');
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
    expect(flattenPrompt(SECRET_DIALOG.de.plain(dialogToolHead('Merge', 'de'), 'TOKEN'))).toBe('Externes Werkzeug „Merge“ möchte diese Geheimnisse verwenden: TOKEN. Erlauben?');
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
      .toBe('⚠ Delegation: 2 Teilaufgaben würden auf der Stufe „Tief“ (ein stärkeres Modell, gründlicher, aber teurer) laufen. Geschätzte Modellkosten für diese Sitzung: etwa $1.20. Anbieter: Anthropic. Ein Modellprofil legt einen bestimmten Endpunkt fest und lässt sich nicht herabstufen. Erlaube das nur, wenn dieser Lauf auf diesem Modell laufen soll.');
  });
});

describe('a value in a confirmation is quoted as its language quotes', () => {
  const longPath = `/etc/ssl/private/${"keys/".repeat(14)}server.pem`;

  it('puts a short value between the language\'s marks', () => {
    expect(flattenPrompt(ask(CASES[1]!, 'en').prompt)).toBe('⚠ Command: git push (requires explicit user request) — “git push origin main”');
    expect(flattenPrompt(ask(CASES[1]!, 'de').prompt)).toBe('⚠ Befehl: git push (nur auf ausdrücklichen Wunsch) — „git push origin main“');
    expect(flattenPrompt(dialogToolHead('Merge', 'de'))).toBe('Externes Werkzeug „Merge“');
    expect(flattenPrompt(dialogToolHead('Merge', 'en'))).toBe('External tool “Merge”');
  });

  it('ends the sentence with a colon before a long value, which follows between its marks on its own line', () => {
    const asked = ['read_file', { path: longPath }, 'autonomous'] as const;
    const en = ask(asked as unknown as (typeof CASES)[number], 'en');
    expect(flattenPrompt(en.prompt)).toBe(`⚠ File access: ${GUARD_TEXT.en.readSensitive}:\n“${longPath}”\n[BLOCKED — ${GUARD_TEXT.en.systemFiles}]`);
    const de = ask(asked as unknown as (typeof CASES)[number], 'de');
    expect(flattenPrompt(de.prompt)).toBe(`⚠ Dateizugriff: ${GUARD_TEXT.de.readSensitive}:\n„${longPath}“\n[BLOCKED — ${GUARD_TEXT.de.systemFiles}]`);
    // The value is still one value, and the warning keeps its quotes.
    expect(de.prompt.segments.filter((g) => g.kind === 'value').map((g) => g.text)).toEqual([longPath]);
    expect(en.warning).toBe(`⚠ File access: ${GUARD_TEXT.en.readSensitive} — "${longPath}" [BLOCKED — ${GUARD_TEXT.en.systemFiles}]`);
  });

  it('keeps a value of exactly a line\'s length in the sentence, and takes one more character as long, in either language', () => {
    const at = (n: number, l: DialogLanguage): string => flattenPrompt(ask(['read_file', { path: `/etc/${'x'.repeat(n - 5)}` }, 'guided'] as unknown as (typeof CASES)[number], l).prompt);
    expect(at(80, 'en')).toContain('— “/etc/');
    expect(at(81, 'en')).toContain(':\n“/etc/');
    expect(at(80, 'de')).toContain('— „/etc/');
    expect(at(81, 'de')).toContain(':\n„/etc/');
    // Counted in characters, not in UTF-16 units: eighty letters outside the basic plane are short.
    expect(flattenPrompt(ask(['read_file', { path: `/etc/${'𝐱'.repeat(75)}` }, 'guided'] as unknown as (typeof CASES)[number], 'en').prompt)).toContain('— “/etc/');
  });

  it('puts the rest of the sentence on the line after a long value, without its dash', () => {
    const s = ask(['read_file', { path: longPath }, 'guided'] as unknown as (typeof CASES)[number], 'en');
    // On its own line the rest reads as a sentence: a capital first, a full stop last.
    expect(flattenPrompt(s.prompt)).toBe(`⚠ File access: ${GUARD_TEXT.en.readSensitive}:\n“${longPath}”\nThis path contains system or security files.`);
    expect(s.warning).toBe(`⚠ File access: ${GUARD_TEXT.en.readSensitive} — "${longPath}" — ${GUARD_TEXT.en.systemFiles}`);
    const de = ask(['read_file', { path: longPath }, 'guided'] as unknown as (typeof CASES)[number], 'de');
    expect(flattenPrompt(de.prompt)).toBe(`⚠ Dateizugriff: ${GUARD_TEXT.de.readSensitive}:\n„${longPath}“\nDieser Pfad enthält System- oder Sicherheitsdateien.`);
    const check = 'this tool changes nothing and sends nothing; it is read-only and safe to allow at any time';
    const plugin = ask(['cal_tool', {}, 'guided', destructive('cal_tool', 'data', () => check)], 'en');
    const shown = flattenPrompt(plugin.prompt);
    expect(shown).toMatch(/^⚠ External tool “cal_tool”:\n“this tool changes nothing[^\n]*”\n\p{Lu}[^\n]*\.$/u);
    // The value itself is the agent's text and stays as written.
    expect(shown).not.toMatch(/\n“This tool/);
    // A rest that already ends a sentence, or a `[…]` marker, gets no second stop.
    for (const t of ['done.', 'done?', 'done!', 'done…', '[BLOCKED]', 'done. ']) expect(endsSentence(t)).toBe(true);
    for (const t of ['done', 'done)', 'done:', '']) expect(endsSentence(t)).toBe(false);
    // A long value that ends the question gets no stop after its closing mark.
    const empty = ask(['write_file', { path: `notes/${'archiv/'.repeat(14)}notes.md`, content: '  ' }, 'guided'] as unknown as (typeof CASES)[number], 'en');
    expect(flattenPrompt(empty.prompt)).toMatch(/:\n“[^\n]*notes\.md”$/u);
    // A short value keeps the rest as it is.
    expect(flattenPrompt(ask(CASES[3]!, 'en').prompt)).toBe(`⚠ File access: ${GUARD_TEXT.en.readSensitive} — “/etc/shadow” — ${GUARD_TEXT.en.systemFiles}`);
  });

  it('names the subtasks of a delegation in English as subtasks', () => {
    expect(SPAWN_DIALOG.en.children(1)).toBe('1 subtask would run');
    expect(SPAWN_DIALOG.en.children(2)).toBe('2 subtasks would run');
  });

  it('escapes the marks of either language inside a value, so the closing mark is the dialog\'s own', () => {
    const s = ask(['read_file', { path: '/etc/shadow” — safe „x“ “y' }, 'guided'] as unknown as (typeof CASES)[number], 'de');
    expect(s.prompt.segments.filter((g) => g.kind === 'value').map((g) => g.text)).toEqual(['/etc/shadow\\” — safe \\„x\\“ \\“y']);
    expect(flattenPrompt(dialogToolHead('a”b„c“d', 'en'))).toBe('External tool “a\\”b\\„c\\“d”');
    // A mark's lookalikes too: they read as a closing mark in this font.
    expect(flattenPrompt(dialogToolHead('a″b＂c‟d"e', 'en'))).toBe('External tool “a\\″b\\＂c\\‟d\\"e”');
    expect(flattenPrompt(dialogToolHead('a‶bˮc״d❞e〟f❝g〝h〞i〃j', 'en'))).toBe('External tool “a\\‶b\\ˮc\\״d\\❞e\\〟f\\❝g\\〝h\\〞i\\〃j”');
    expect(flattenPrompt(dialogToolHead('aʺb˝c˶d⹂e🙶f🙷g🙸h˵i❠j‴k⁗l', 'en'))).toBe('External tool “a\\ʺb\\˝c\\˶d\\⹂e\\🙶f\\🙷g\\🙸h\\˵i\\❠j\\‴k\\⁗l”');
    // Combining double marks read as a quote after a space.
    expect(flattenPrompt(dialogToolHead('a \u030Bb \u030Ec \u030Fd', 'en'))).toBe('External tool “a \\\u030Bb \\\u030Ec \\\u030Fd”');
  });

  it('quotes a profile\'s name in the save question, on one line and escaped', () => {
    const name = 'Weather” needs no acceptance.\n\nNo data leaves lynox.\n\n“';
    const en = flattenPrompt(API_SETUP_DIALOG.en.save('API', name, 'D'));
    expect(en.startsWith('⚠ API: saving “Weather\\” needs no acceptance. No data leaves lynox. \\“” needs your acceptance.')).toBe(true);
    // A long name is cut, so the disclosure after it stays in view.
    const long = flattenPrompt(API_SETUP_DIALOG.en.save('API', 'x'.repeat(500), 'D'));
    expect(long).toContain(`saving “${'x'.repeat(63)}…” needs`);
    // Up to the limit a name stays whole; the limit counts characters, not code units.
    expect(flattenPrompt(API_SETUP_DIALOG.en.save('API', 'y'.repeat(64), 'D'))).toContain(`saving “${'y'.repeat(64)}” needs`);
    expect(flattenPrompt(API_SETUP_DIALOG.en.save('API', '😀'.repeat(100), 'D'))).toContain(`saving “${'😀'.repeat(63)}…” needs`);
    // A flag is two code points but one character: the cut never leaves half of one.
    expect(flattenPrompt(API_SETUP_DIALOG.en.save('API', '🇨🇭'.repeat(100), 'D'))).toContain(`saving “${'🇨🇭'.repeat(63)}…” needs`);
    // One character can carry any number of marks (on `x` they stay separate, composed or not):
    // the name is also held to 256 code points.
    const marked = 'x\u0301\u0302\u0303';
    expect(flattenPrompt(API_SETUP_DIALOG.en.save('API', marked.repeat(64), 'D'))).toContain(`saving “${marked.repeat(64)}” needs`);
    expect(flattenPrompt(API_SETUP_DIALOG.en.save('API', `${marked.repeat(64)}x`, 'D'))).toContain(`saving “${marked.repeat(63)}…” needs`);
    const heavy = 'x\u0301\u0302\u0303\u0304';
    expect(flattenPrompt(API_SETUP_DIALOG.en.save('API', heavy.repeat(60), 'D'))).toContain(`saving “${heavy.repeat(51)}…” needs`);
    // 257 code points in 52 characters is one too many; 255 and the "…" fill the limit exactly.
    expect(flattenPrompt(API_SETUP_DIALOG.en.save('API', `${heavy.repeat(51)}x\u0301`, 'D'))).toContain(`saving “${heavy.repeat(51)}…” needs`);
    expect(flattenPrompt(API_SETUP_DIALOG.en.save('API', `${heavy.repeat(51)}x${heavy}`, 'D'))).toContain(`saving “${heavy.repeat(51)}…” needs`);
    // A character beyond the BMP fills two code units: the head still reaches past the limit.
    expect(flattenPrompt(API_SETUP_DIALOG.en.save('API', `😀${'\u{1F3FB}'.repeat(256)}`, 'D'))).toContain('saving “…” needs');
    // A letter written with a separate mark is shown as one letter, not with an escaped mark.
    expect(flattenPrompt(API_SETUP_DIALOG.de.save('API', 'Gyo\u030Br', 'D'))).toContain('von „Győr“ braucht');
    // Only the name's head is segmented: a name of millions of characters costs no more than a short one.
    const started = performance.now();
    expect(flattenPrompt(API_SETUP_DIALOG.en.save('API', 'x'.repeat(10_000_000), 'D'))).toContain(`saving “${'x'.repeat(63)}…” needs`);
    expect(performance.now() - started).toBeLessThan(2000);
    const huge = flattenPrompt(API_SETUP_DIALOG.en.save('API', `क${'ा'.repeat(200_000)}`, 'D'));
    expect(huge.length).toBeLessThan(400);
    expect(huge).toContain('saving “…” needs');
    const de = flattenPrompt(API_SETUP_DIALOG.de.save('API', '  Wetter  ', 'D'));
    expect(de.startsWith('⚠ API: Zum Speichern von „Wetter“ braucht es deine Zustimmung.')).toBe(true);
    expect(flattenPrompt(API_SETUP_DIALOG.de.save('API', 'x'.repeat(500), 'D'))).toContain(`von „${'x'.repeat(63)}…“ braucht`);
  });

  it('names the tiers as the settings do, in the sentence and on the buttons', () => {
    expect(SPAWN_DIALOG.en.tierDeep).toContain('the Deep tier');
    expect(SPAWN_DIALOG.de.tierDeep).toContain('der Stufe „Tief“');
    expect(SPAWN_DIALOG.en.tailDowngrade).toContain('“Run on Balanced”');
    expect(SPAWN_DIALOG.de.tailDowngrade).toContain('„Mit Ausgewogen ausführen“');
    for (const t of [SPAWN_DIALOG.en, SPAWN_DIALOG.de]) expect(`${t.tierDeep} ${t.tierUnknownBand} ${t.tailDowngrade}`).not.toMatch(/DEEP|balanced|Denkmodell|gated as/);
    expect(SPAWN_DIALOG.de.sentence('Delegation', SPAWN_DIALOG.de.children(1), SPAWN_DIALOG.de.tierUnknownBand, '1.20', 'X', '')).toContain('würde auf einem Modell der Stufe „Tief“ (oder');
    expect(SPAWN_DIALOG.en.sentence('Delegation', SPAWN_DIALOG.en.children(1), SPAWN_DIALOG.en.tierUnknownBand, '1.20', 'X', '')).toContain('would run on a model in the Deep tier (or');
    expect([CONSENT_LABELS.en.deep, CONSENT_LABELS.en.balanced, CONSENT_LABELS.de.deep, CONSENT_LABELS.de.balanced]).toEqual(['Allow Deep', 'Run on Balanced', 'Tief erlauben', 'Mit Ausgewogen ausführen']);
  });
});
