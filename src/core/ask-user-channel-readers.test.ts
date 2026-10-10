import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Where the question channel of `ask_user` (`Agent.askUserPrompt`) is named in src/.
 *
 * The channel lets a step of a scheduled workflow ask its owner a question. It must not let the
 * step approve anything: every consent gate and the permission guard read `promptUser`, and a
 * step that has only the question channel has no `promptUser`. That holds only as long as no
 * consent site reads the channel as a fallback (`promptUser ?? askUserPrompt`). Such a line
 * would compile and look harmless, so the set of lines that name the channel is pinned here,
 * line by line: a new reader fails this test until it is listed, and listing it is the review.
 *
 * Comments are stripped before the scan, so a doc comment naming the field is not a site. The
 * match is on the bare identifier, which also finds `agent['askUserPrompt']` and a destructured
 * `{ askUserPrompt }`; `parentAskUserPrompt` is a different identifier and is not counted.
 */
const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(p);
    return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [p] : [];
  });
}

/** Block and line comments blanked out, line breaks kept so line numbers stay true. */
function withoutComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

const NAME = /\baskUserPrompt\b/;

const EXPECTED: Record<string, string[]> = {
  'core/agent.ts': [
    'get askUserPrompt(): PromptUserFn | undefined {',
    'set askUserPrompt(fn: PromptUserFn | undefined) { this._askUserPrompt = fn; }',
    'this.askUserPrompt = config.askUserPrompt;',
  ],
  'tools/builtin/ask-user.ts': [
    'const ask = agent.promptUser ?? agent.askUserPrompt;',
  ],
  'orchestrator/runtime-adapter.ts': [
    '): { promptUser?: PromptUserFn | undefined; askUserPrompt?: PromptUserFn | undefined; promptTabs?: PromptTabsFn | undefined; promptSecret?: PromptSecretFn | undefined } {',
    'askUserPrompt: parent.parentAskUserPrompt',
    'askUserPrompt: promptCallbacks.askUserPrompt,',
    'askUserPrompt: promptCallbacks.askUserPrompt,',
  ],
  'types/agent.ts': ['askUserPrompt?: PromptUserFn | undefined;'],
  'types/config.ts': ['askUserPrompt?:   PromptUserFn | undefined;'],
};

describe('the question channel of ask_user is named only at the listed lines', () => {
  const found: Record<string, string[]> = {};
  for (const file of sourceFiles(SRC)) {
    const lines = withoutComments(readFileSync(file, 'utf-8')).split('\n')
      .filter((l) => NAME.test(l)).map((l) => l.trim());
    if (lines.length > 0) found[relative(SRC, file)] = lines;
  }

  it('no other file names it', () => {
    expect(Object.keys(found).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it.each(Object.keys(EXPECTED))('%s names it only at its listed lines', (file) => {
    expect(found[file]).toEqual(EXPECTED[file]);
  });

  it('the scan finds a reader where one is added (positive control)', () => {
    const consentSite = 'if (this.promptUser ?? this.askUserPrompt) {';
    expect(NAME.test(withoutComments(consentSite))).toBe(true);
    expect(NAME.test(withoutComments('// falls back to askUserPrompt'))).toBe(false);
    expect(NAME.test('parent.parentAskUserPrompt')).toBe(false);
  });
});
