import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DIALOG_ONLY_WORDS, TOOL_LINE_WORDS, dialogToolWord } from './tool-words.js';

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

  it('is the dialog-only noun first, then the tool line\'s word, else the name', () => {
    expect(dialogToolWord('read_file')).toBe('File access');
    expect(dialogToolWord('batch_files')).toBe('Bulk file change');
    expect(dialogToolWord('bash')).toBe('Command');
    expect(dialogToolWord('http_request')).toBe('API request');
    expect(dialogToolWord('some_new_tool')).toBe('some_new_tool');
    // An inherited property is not a word.
    expect(dialogToolWord('constructor')).toBe('constructor');
    expect(dialogToolWord('toString')).toBe('toString');
  });

  it('opens every ⚠ dialog of the guard, api_setup, http_request and spawn_agent', () => {
    const reach = toolsThatReachADialog();
    for (const path of ['tools/permission-guard.ts', 'tools/builtin/api-setup.ts', 'tools/builtin/http.ts', 'tools/builtin/spawn.ts']) {
      const text = read(path);
      expect(text.includes('⚠ ${system(toolName)}'), path).toBe(false);
      for (const tool of reach) expect(text.includes(`⚠ ${tool}`), `${path} opens a dialog with ${tool}`).toBe(false);
    }
    expect(read('tools/permission-guard.ts').match(/⚠ \$\{system\(dialogToolWord\(toolName\)\)\}/g)?.length).toBe(24);
    expect(read('tools/builtin/api-setup.ts').match(/pv`⚠ \$\{toolWordFrame\('api_setup'\)\}: /g)?.length).toBe(5);
    expect(read('tools/builtin/http.ts').match(/pv`⚠ \$\{toolWordFrame\('http_request'\)\}: /g)?.length).toBe(2);
    expect(read('tools/builtin/spawn.ts').match(/`⚠ \$\{dialogToolWord\('spawn_agent'\)\}: /g)?.length).toBe(1);
  });
});
