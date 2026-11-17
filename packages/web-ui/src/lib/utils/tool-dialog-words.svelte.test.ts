import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { toolCallLabel } from './tool-call-label.js';
import { getLocale, setLocale, t } from '../i18n.svelte.js';

// The engine names a tool in a confirmation dialog by an English word from its own table
// (`src/tools/tool-words.ts`). Where the chat's tool line names the tool by a noun, the
// dialog takes that word: this test holds the two equal. The table is read as text, so
// this package does not import the engine.

const before = getLocale();
afterEach(() => setLocale(before));

function engineTable(name: 'TOOL_LINE_WORDS' | 'DIALOG_ONLY_WORDS' | 'TOOL_LINE_WORDS_DE' | 'DIALOG_ONLY_WORDS_DE'): Record<string, string> {
  let root = process.cwd();
  while (!existsSync(join(root, 'src/tools/tool-words.ts')) && dirname(root) !== root) root = dirname(root);
  const text = readFileSync(join(root, 'src/tools/tool-words.ts'), 'utf8');
  const block = new RegExp(`export const ${name} = \\{([^}]*)\\}`).exec(text);
  expect(block, `${name} is found`).not.toBeNull();
  const entries: Record<string, string> = {};
  for (const m of block![1]!.matchAll(/^\s*([a-z_]+): '([^']+)',$/gm)) entries[m[1]!] = m[2]!;
  // Every line of the block is an entry this reads: none is skipped unread.
  const lines = block![1]!.split('\n').filter((line) => line.trim() !== '');
  expect(Object.keys(entries).length, `${name}: every line is read`).toBe(lines.length);
  return entries;
}

const lineWord = (tool: string, locale: 'en' | 'de'): string | undefined => {
  setLocale(locale);
  return toolCallLabel(tool, undefined, t)?.action;
};
const englishLineWord = (tool: string): string | undefined => lineWord(tool, 'en');

describe('the dialog word and the chat\'s tool-line word', () => {
  const lineWords = engineTable('TOOL_LINE_WORDS');
  const dialogOnly = engineTable('DIALOG_ONLY_WORDS');

  it('reads both tables', () => {
    expect(Object.keys(lineWords).length).toBeGreaterThanOrEqual(15);
    expect(Object.keys(dialogOnly)).toEqual(['read_file', 'write_file', 'edit_file', 'batch_files', 'spawn_agent']);
  });

  it('are the same word wherever the dialog takes the tool line\'s noun', () => {
    for (const [tool, word] of Object.entries(lineWords)) expect(englishLineWord(tool), tool).toBe(word);
  });

  it('differ only where the tool line names the tool after the call, by a participle', () => {
    for (const [tool, word] of Object.entries(dialogOnly)) {
      const line = englishLineWord(tool);
      expect(line, tool).toBeDefined();
      expect(line, `${tool}: the tool line already has this word, so it belongs in TOOL_LINE_WORDS`).not.toBe(word);
    }
  });
});

describe('the German dialog word and the chat\'s German tool-line word', () => {
  const lineWords = engineTable('TOOL_LINE_WORDS_DE');
  const dialogOnly = engineTable('DIALOG_ONLY_WORDS_DE');

  it('lists the same tools as the English tables', () => {
    expect(Object.keys(lineWords).sort()).toEqual(Object.keys(engineTable('TOOL_LINE_WORDS')).sort());
    expect(Object.keys(dialogOnly).sort()).toEqual(Object.keys(engineTable('DIALOG_ONLY_WORDS')).sort());
  });

  it('are the same word wherever the dialog takes the tool line\'s noun', () => {
    for (const [tool, word] of Object.entries(lineWords)) expect(lineWord(tool, 'de'), tool).toBe(word);
  });

  it('differ where the tool line names the tool after the call', () => {
    for (const [tool, word] of Object.entries(dialogOnly)) {
      const line = lineWord(tool, 'de');
      expect(line, tool).toBeDefined();
      expect(line, tool).not.toBe(word);
    }
  });
});
