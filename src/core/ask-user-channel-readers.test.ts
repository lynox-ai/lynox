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
 * The handle a workflow run passes its steps (`SubAgentPromptHandles.parentAskUserPrompt`) is
 * pinned the same way: `promptUser: parent.parentAskUserPrompt` would hand a step real consent
 * just as surely.
 *
 * Comment lines are left out of the scan, so a doc comment naming the field is not a site. The
 * match is on the identifier, which also finds `agent['askUserPrompt']` and a destructured
 * `{ askUserPrompt }`. The price of skipping comments by their first characters: a code line that
 * begins with `*` or `/*` (a continued multiplication, a leading block comment) is skipped too.
 * Formatted TypeScript in this repo writes neither, and a review of such a line would catch it.
 */
const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(p);
    return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [p] : [];
  });
}

/** A line that is only a comment: `//`, `/*`, or the `*` of a block comment's body. */
const isCommentLine = (line: string): boolean => /^\s*(\/\/|\/\*|\*)/.test(line);

const NAME = /\b(askUserPrompt|parentAskUserPrompt)\b/;

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
    'parentAskUserPrompt?: PromptUserFn | undefined;',
    '): { promptUser?: PromptUserFn | undefined; askUserPrompt?: PromptUserFn | undefined; promptTabs?: PromptTabsFn | undefined; promptSecret?: PromptSecretFn | undefined } {',
    'askUserPrompt: parent.parentAskUserPrompt',
    'return await parent.parentAskUserPrompt!(q, opts, { ...meta, ...m });',
    "return name === 'ask_user' && parent?.parentAskUserPrompt !== undefined;",
    'askUserPrompt: holdingTimeoutWhileAsking(promptCallbacks.askUserPrompt, stepTimeout),',
    'askUserPrompt: holdingTimeoutWhileAsking(promptCallbacks.askUserPrompt, stepTimeout),',
  ],
  // A scheduled workflow run: the worker hands the run its channel, and `runSavedWorkflow`
  // passes it on alone, as `parentAskUserPrompt`, never as `parentPromptUser`.
  'core/worker-loop.ts': [
    'parentPrompt: { parentAskUserPrompt: questions.channel.ask },',
  ],
  'tools/builtin/pipeline.ts': [
    'const asksItsOwner = runtime?.parentPrompt?.parentAskUserPrompt !== undefined && asksOnlyViaAskUser(planned.steps);',
    'parentPrompt: asksItsOwner ? { parentAskUserPrompt: runtime?.parentPrompt?.parentAskUserPrompt } : undefined,',
  ],
  'types/agent.ts': ['askUserPrompt?: PromptUserFn | undefined;'],
  'types/config.ts': ['askUserPrompt?:   PromptUserFn | undefined;'],
};

describe('the question channel of ask_user is named only at the listed lines', () => {
  const found: Record<string, string[]> = {};
  for (const file of sourceFiles(SRC)) {
    const lines = readFileSync(file, 'utf-8').split('\n')
      .filter((l) => !isCommentLine(l) && NAME.test(l)).map((l) => l.trim());
    if (lines.length > 0) found[relative(SRC, file)] = lines;
  }

  it('no other file names it', () => {
    expect(Object.keys(found).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it.each(Object.keys(EXPECTED))('%s names it only at its listed lines', (file) => {
    expect(found[file]).toEqual(EXPECTED[file]);
  });

  it('the scan finds a reader where one is added (positive control)', () => {
    expect(NAME.test('if (this.promptUser ?? this.askUserPrompt) {')).toBe(true);
    expect(NAME.test('promptUser: parent.parentPromptUser ?? parent.parentAskUserPrompt,')).toBe(true);
    expect(isCommentLine('  // falls back to askUserPrompt')).toBe(true);
    expect(isCommentLine("  const glob = 'src/*'; const ask = agent.askUserPrompt;")).toBe(false);
  });
});
