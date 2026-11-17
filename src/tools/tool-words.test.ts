import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DIALOG_ONLY_WORDS, TOOL_LINE_WORDS, dialogToolWord } from './tool-words.js';
import { BUILTIN_TOOL_NAMES } from '../core/builtin-tool-names.js';

const SRC = join(process.cwd(), 'src');
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');

/** The engine's non-test sources, as [path relative to src, text]. */
function sources(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const entry of readdirSync(SRC, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
    const full = join(entry.parentPath, entry.name);
    out.push([full.slice(SRC.length + 1), readFileSync(full, 'utf8')]);
  }
  return out;
}

/**
 * The tools that declare a `destructive` gate; the guard's generic case asks about each of
 * them. Kept by hand, and held to the sources: a new gate fails the count below until its
 * tool is listed here, and so has a dialog word.
 */
const DESTRUCTIVE: Readonly<Record<string, string>> = {
  google_calendar: 'integrations/google/google-calendar.ts',
  google_docs: 'integrations/google/google-docs.ts',
  google_drive: 'integrations/google/google-drive.ts',
  google_sheets: 'integrations/google/google-sheets.ts',
  api_setup: 'tools/builtin/api-setup.ts',
  artifact_delete: 'tools/builtin/artifact.ts',
  data_store_delete: 'tools/builtin/data-store.ts',
  data_store_drop: 'tools/builtin/data-store.ts',
  memory_block_edit: 'tools/builtin/knowledge.ts',
  memory_retire: 'tools/builtin/knowledge.ts',
  memory_delete: 'tools/builtin/memory.ts',
  memory_promote: 'tools/builtin/memory.ts',
  spawn_agent: 'tools/builtin/spawn.ts',
  subjects_merge: 'tools/builtin/subjects-merge.ts',
  update_workflow_steps: 'tools/builtin/update-workflow.ts',
};

/**
 * Every tool a confirmation dialog can name: the tools the permission guard names by a
 * literal or in its mail set, every tool with a `destructive` gate, and the tools that ask in
 * their own words.
 */
function toolsThatReachADialog(): string[] {
  const names = new Set<string>(['api_setup', 'http_request', 'spawn_agent', ...Object.keys(DESTRUCTIVE)]);
  const guard = read('tools/permission-guard.ts');
  for (const m of guard.matchAll(/toolName === '([a-z_]+)'/g)) names.add(m[1]!);
  const mailSet = /const MAIL_WRITE_TOOLS = new Set\(\[([^\]]*)\]\)/.exec(guard);
  expect(mailSet, 'the guard\'s mail tools are found').not.toBeNull();
  for (const m of mailSet![1]!.matchAll(/'([a-z_]+)'/g)) names.add(m[1]!);
  return [...names].sort();
}

describe('the word a confirmation dialog names a tool by', () => {
  it('knows every destructive gate in the sources', () => {
    const gates = sources().reduce((n, [, text]) => n + (text.match(/^\s*destructive:/gm)?.length ?? 0), 0);
    expect(gates).toBe(Object.keys(DESTRUCTIVE).length);
    // Per file: as many gates as listed tools, so a gate moved to another tool of a different
    // file cannot keep the total and slip past.
    const perFile = new Map<string, string[]>();
    for (const [tool, file] of Object.entries(DESTRUCTIVE)) perFile.set(file, [...(perFile.get(file) ?? []), tool]);
    for (const [file, tools] of perFile) {
      const text = read(file);
      expect(text.match(/^\s*destructive:/gm)?.length, file).toBe(tools.length);
      for (const tool of tools) expect(text.includes(`name: '${tool}'`), tool).toBe(true);
    }
  });

  it('exists for every tool that can reach a dialog, and only for those', () => {
    const reach = toolsThatReachADialog();
    expect(reach.length).toBeGreaterThanOrEqual(20);
    const listed = [...Object.keys(TOOL_LINE_WORDS), ...Object.keys(DIALOG_ONLY_WORDS)].sort();
    expect(listed).toEqual(reach);
  });

  it('comes from one list per tool: the tool line\'s noun or a dialog-only noun, never both', () => {
    for (const name of Object.keys(DIALOG_ONLY_WORDS)) expect(Object.hasOwn(TOOL_LINE_WORDS, name), name).toBe(false);
  });

  it('is the dialog-only noun first, then the tool line\'s word, else the marked name', () => {
    expect(dialogToolWord('read_file')).toBe('File access');
    expect(dialogToolWord('batch_files')).toBe('Bulk file change');
    expect(dialogToolWord('bash')).toBe('Command');
    expect(dialogToolWord('http_request')).toBe('API request');
    expect(dialogToolWord('some_new_tool')).toBe('External tool "some_new_tool"');
    // An inherited property is not a word.
    expect(dialogToolWord('constructor')).toBe('External tool "constructor"');
    expect(dialogToolWord('toString')).toBe('External tool "toString"');
  });

  it('shows a foreign name as a foreign value: one line, no control or bidi characters, cut, escaped', () => {
    expect(dialogToolWord('a\u202Eb\u200Bc')).toBe('External tool "abc"');
    expect(dialogToolWord('line\nbreak\ttab')).toBe('External tool "line break tab"');
    expect(dialogToolWord('x'.repeat(64))).toBe(`External tool "${'x'.repeat(64)}"`);
    expect(dialogToolWord('x'.repeat(65))).toBe(`External tool "${'x'.repeat(63)}…"`);
    expect(dialogToolWord('say "Merge" now')).toBe('External tool "say \\"Merge\\" now"');
    expect(dialogToolWord('back\\slash')).toBe('External tool "back\\\\slash"');
  });

  it('belongs to built-in tools only: no plugin can take a key of the table', () => {
    for (const tool of [...Object.keys(TOOL_LINE_WORDS), ...Object.keys(DIALOG_ONLY_WORDS)]) expect(BUILTIN_TOOL_NAMES.has(tool), tool).toBe(true);
  });

  it('cannot be imitated by a tool named like one of the words', () => {
    const words = new Set<string>([...Object.values(TOOL_LINE_WORDS), ...Object.values(DIALOG_ONLY_WORDS)]);
    // A tool name has no space (`^[a-zA-Z0-9_-]{1,64}$`), so the closest a plugin gets is
    // the word itself or its words run together.
    for (const word of words) {
      for (const name of [word, word.replaceAll(' ', ''), word.replaceAll(' ', '_')]) {
        expect(words.has(dialogToolWord(name)), name).toBe(false);
      }
    }
  });

  it('opens every ⚠ dialog of the guard, api_setup, http_request and spawn_agent', () => {
    const reach = toolsThatReachADialog();
    for (const path of ['tools/permission-guard.ts', 'tools/builtin/api-setup.ts', 'tools/builtin/http.ts', 'tools/builtin/spawn.ts', 'tools/dialog-text.ts', 'core/agent.ts']) {
      const text = read(path);
      expect(text.includes('⚠ ${system(toolName)}'), path).toBe(false);
      expect(text.includes('system(dialogToolWord('), `${path} puts a tool name into frame`).toBe(false);
      expect(text.includes('pv`Tool "${tc.name}"'), `${path} asks naming a tool by its raw name`).toBe(false);
      for (const tool of reach) expect(text.includes(`⚠ ${tool}`), `${path} opens a dialog with ${tool}`).toBe(false);
    }
    expect(read('tools/permission-guard.ts').match(/⚠ \$\{tool\(toolName\)\}/g)?.length).toBe(30);
    // The tools' own questions open with the word they are handed, in both languages.
    const dialogs = read('tools/dialog-text.ts');
    expect(dialogs.match(/pv`⚠ \$\{word\}: /g)?.length).toBe(2 * 7);
    expect(dialogs.match(/`⚠ \$\{word\}: \$\{children\}/g)?.length).toBe(2);
    expect(read('tools/builtin/api-setup.ts').match(/toolWordFrame\('api_setup', agent\.dialogLanguage \?\? 'en'\)/g)?.length).toBe(5);
    expect(read('tools/builtin/http.ts').match(/toolWordFrame\('http_request', (?:language|agent\.dialogLanguage \?\? 'en')\)/g)?.length).toBe(2);
    expect(read('tools/builtin/spawn.ts').match(/dialogToolWord\('spawn_agent', ctx\?\.language \?\? 'en'\)/g)?.length).toBe(1);
  });
});
