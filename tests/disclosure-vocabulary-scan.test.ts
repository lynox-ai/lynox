import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { kindOf, warningsIn, proseWarnings } from '../scripts/disclosure-vocabulary-scan.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/disclosure-vocabulary-scan.mjs', import.meta.url));
// Hermetic git: a developer's global config must not decide what the diff looks like.
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

describe('what it warns about', () => {
  // The form an earlier sweep missed, because its helper word comes AFTER `filed`.
  it('a sentence that names where open work is recorded', () => {
    expect(kindOf('// filed as a register row rather than built here.')).toBe('points at an internal record');
  });

  // One sentence per pattern, each matched by that pattern alone, so a pattern that stops
  // working is seen — a sentence two patterns match would hide either one going missing.
  it('each way of naming the record, on its own', () => {
    for (const line of [
      '// the register row states which call sites',
      '// registered as its own row rather than half-fixed here',
      '// kept in the private register',
      '// cross-repo pinning is filed as its own row instead',
    ]) {
      expect(kindOf(line), line).toBe('points at an internal record');
    }
  });

  it('each way of putting work off that a broader sentence would mask', () => {
    for (const line of ['// and are tracked separately.', '// a pre-existing gap in the check']) {
      expect(kindOf(line), line).toBe('marks work as put off');
    }
  });

  // Forms that slipped past a single expression; the bar is ten of these thirteen.
  const PUT_OFF = [
    '// filed rather than built here',
    '// out of scope here',
    '// Deferred until the next release',
    '// Tracked separately as a register row',
    '// a follow-up',
    '// its own PR',
    '// a change of its own',
    '// Known gap: the second path',
    '// TODO: retry the write',
    '// One finding remains open',
    '// Left for a later change',
    '// Not addressed here',
    '// that is pre-existing.',
  ];

  // One is missed on purpose: a bare `a follow-up` is far more often the product's own
  // noun than a deferral (measured over the tree: it was most of the noise), so only
  // `is a follow-up` and `a follow-up <piece of work>` count.
  it(`at least ten of the ${PUT_OFF.length} ways of saying work was put off`, () => {
    const missed = PUT_OFF.filter((l) => kindOf(l) === null);
    expect(missed, 'missed').toEqual(['// a follow-up']);
  });

  it('a follow-up as work put off, in the forms the tree uses', () => {
    for (const line of [
      '* Unifying the tie-break is a follow-up if the pointer ever matters.',
      '// provenance is a follow-up (it needs a mapping)',
      '*     it is caught by the generic path and measured as a follow-up.',
      '// a follow-up hardening — not in this scope.',
      '// will be done in a follow-up',
      '// leaving it for a follow-up',
      '// this needs a follow-up',
      "en: 'UI toggle in a follow-up release.'",
      '* The residual gap is a deferred follow-up.',
      '// that follow-up is deferred.',
      '// TODO(owner): wire this later',
    ]) {
      expect(kindOf(line), line).toBe('marks work as put off');
    }
  });

  // A zero-width space or fullwidth letters, as an editor or a paste can leave them, read
  // as the plain word.
  it('a word spelled with an invisible character or in fullwidth letters', () => {
    expect(kindOf('// fi\u200Bled rather than built here')).toBe('marks work as put off');
    expect(kindOf('// \uFF46\uFF49\uFF4C\uFF45\uFF44 rather than built here')).toBe('marks work as put off');
  });

  // The forms of the leaked PR sentences none of the lists above caught: work handed to a
  // named later piece, and a list of what is left open under its own heading.
  it('work handed to a named later piece, and a heading over what is left open', () => {
    for (const line of [
      '- Marking it revoked comes with the admin route of the next change.',
      '// Moving the call sites onto it is a separate change.',
      '## What this does not cover',
      '**What this PR does not cover.** A step without a template',
      '## Not covered',
      '**Not covered:** a test that builds an absolute path',
      '// Not covered: an in-place rewrite',
      'Not covered yet: the race',
      '## Not covered in this PR',
      '- Not covered — the second path',
      '- fixed in the next PR to main',
      '- handled in the next change of the admin route',
    ]) {
      expect(kindOf(line), line).toBe('marks work as put off');
    }
  });

  it('not a rule\'s scope or an owner\'s later edit, which share those words', () => {
    for (const line of [
      '- two overrides are not covered by an approval for one;',
      '- Not covered by an approval for PATCH: a POST that carries a PATCH override.',
      '// an approval for PATCH does not cover a POST with a PATCH override',
      '// a schedule the owner took over is not held again by a later change of the owner\'s own',
      '// the next change to the file bumps its version',
      '// re-renders with the next change to the store',
      '// kept in a separate piece of memory',
      '// not covered → coverage falls below the bar',
    ]) {
      expect(kindOf(line), line).toBeNull();
    }
  });

  it('not product or domain sentences that share a word', () => {
    for (const line of [
      '// a durable fact is filed against the client it names',
      "it('suggests a follow-up question after the answer')",
      '// the user can add a TODO to the list',
      '// a pre-existing subject keeps its id',
      '// deferred rendering keeps the iframe out of the stream',
      '// the store went out of scope when the block ended',
      '// refuses a preset id that is not in the register',
      '/** Cancel a follow-up (user says "I don\'t care anymore"). */',
      '// the user may have sent a turn (tapped a follow-up pill',
      '// user image, an assistant reply, then a follow-up.',
      '// Accepts both a TODO (TaskRecord: has priority + due_date) and a trigger',
      '* UNBOUNDED full-scan of every USER-TODO (`tasks`) row',
    ]) {
      expect(kindOf(line), line).toBeNull();
    }
  });
});

describe('which lines it reads', () => {
  const diff = (body: string): string => `diff --git a/x b/x\n${body}`;

  it('an added line, with its file and line number', () => {
    const d = diff('--- a/src/a.ts\n+++ b/src/a.ts\n@@ -3,0 +4,1 @@\n+// filed rather than built here\n');
    expect(warningsIn(d)).toEqual([
      { path: 'src/a.ts', line: 4, kind: 'marks work as put off', text: '// filed rather than built here' },
    ]);
  });

  it('not a line the same change removes elsewhere: that is a move, not new text', () => {
    const d =
      'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -3,1 +2,0 @@\n-    // filed rather than built here\n' +
      'diff --git a/src/b.ts b/src/b.ts\n--- a/src/b.ts\n+++ b/src/b.ts\n@@ -0,0 +1,1 @@\n+// filed rather than built here\n';
    expect(warningsIn(d)).toEqual([]);
  });

  it('a moved line that is also CHANGED is new text and is read', () => {
    const d =
      'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -3,1 +2,0 @@\n-// built here\n' +
      'diff --git a/src/b.ts b/src/b.ts\n--- a/src/b.ts\n+++ b/src/b.ts\n@@ -0,0 +1,1 @@\n+// filed rather than built here\n';
    expect(warningsIn(d)).toHaveLength(1);
  });

  it('not its own two files, which hold the vocabulary on purpose', () => {
    const d = diff('--- a/tests/disclosure-vocabulary-scan.test.ts\n+++ b/tests/disclosure-vocabulary-scan.test.ts\n@@ -1,0 +2,1 @@\n+// filed as a register row\n');
    expect(warningsIn(d)).toEqual([]);
  });

  it('but the other gates, where a sentence about a gap matters most', () => {
    const d = diff('--- a/scripts/added-lines-guard.mjs\n+++ b/scripts/added-lines-guard.mjs\n@@ -1,0 +2,1 @@\n+// the octopus path is filed, not built here\n');
    expect(warningsIn(d)).toHaveLength(1);
  });
});

describe('the hook', () => {
  let dir: string;
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: dir, env: GIT_ENV, encoding: 'utf8' });
  const run = (cwd = dir): { status: number; out: string } => {
    try {
      const out = execFileSync('node', [SCRIPT], { cwd, env: GIT_ENV, encoding: 'utf8', stdio: 'pipe' });
      return { status: 0, out };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { status: typeof e.status === 'number' ? e.status : Number.NaN, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
    }
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'disclosure-scan-'));
    git('init', '-q');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'test');
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src/a.ts'), 'export const a = 1;\n// filed rather than built here\n');
    git('add', '.');
    git('commit', '-q', '-m', 'seed');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // Both halves on one input: it SAYS so, and it lets the commit through. A refusal here
  // would turn a warning into a rule that clears every honest note on a limit.
  it('warns about a planted line and still exits 0', () => {
    writeFileSync(join(dir, 'src/b.ts'), '// filed as a register row rather than built here.\n');
    git('add', '.');
    const r = run();
    expect(r.status).toBe(0);
    expect(r.out).toContain('src/b.ts:1: points at an internal record');
  });

  // The other direction of the same rule: an honest note on what a FEATURE does not do
  // is warned about like any other match, and the commit still goes ahead. Nothing here
  // forces such a note out; the author decides.
  it('lets an honest note on a feature limit through, with the warning', () => {
    writeFileSync(join(dir, 'src/b.ts'), '// Not covered here: the cap is advisory and never exceeded.\n');
    git('add', '.');
    const r = run();
    expect(r.status).toBe(0);
    expect(r.out).toContain('src/b.ts:1: marks work as put off');
  });

  it('is not refused by a developer setting that reshapes the diff', () => {
    // Two changes around one blank line: merged into one hunk, the blank line is context,
    // and with this setting git prints it as an empty line instead of a single space.
    writeFileSync(join(dir, 'src/d.ts'), 'export const d = 1;\n\nexport const e = 1;\n');
    git('add', '.');
    git('commit', '-q', '-m', 'seed d');
    git('config', 'diff.suppressBlankEmpty', 'true');
    git('config', 'diff.interHunkContext', '5');
    writeFileSync(join(dir, 'src/d.ts'), 'export const d = 2;\n\nexport const e = 2;\n');
    git('add', '.');
    expect(run()).toEqual({ status: 0, out: '' });
  });

  it('says nothing about a clean line', () => {
    writeFileSync(join(dir, 'src/b.ts'), 'export const b = 2;\n');
    git('add', '.');
    expect(run()).toEqual({ status: 0, out: '' });
  });

  it('says nothing about a file that is only moved', () => {
    git('mv', 'src/a.ts', 'src/moved.ts');
    expect(run()).toEqual({ status: 0, out: '' });
  });

  it('says nothing when the line moves to another file', () => {
    writeFileSync(join(dir, 'src/a.ts'), 'export const a = 1;\n');
    writeFileSync(join(dir, 'src/c.ts'), '  // filed rather than built here\n');
    git('add', '.');
    expect(run()).toEqual({ status: 0, out: '' });
  });

  it('refuses to report clean when it cannot read the staged diff', () => {
    const outside = mkdtempSync(join(tmpdir(), 'disclosure-scan-nogit-'));
    try {
      const r = run(outside);
      expect(r.status).toBe(2);
      expect(r.out).toContain('could not read the staged changes');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('proseWarnings — pull-request text and commit messages', () => {
  it('names the line, never the text', () => {
    const w = proseWarnings('Summary.\n\nMarking it comes with the next change.\nDone.');
    expect(w).toEqual([{ line: 3, kind: 'marks work as put off' }]);
    expect(JSON.stringify(w)).not.toContain('next change');
  });

  it('skips fenced blocks: the gate record and quoted output are not prose', () => {
    const body = 'Text.\n```gate-record\nreview: 1 opus round, a later change\n```\n~~~\n## Not covered\n~~~\nEnd.';
    expect(proseWarnings(body)).toEqual([]);
    // Control: the same line outside the fence is read.
    expect(proseWarnings('## Not covered')).toEqual([{ line: 1, kind: 'marks work as put off' }]);
  });

  it('a fence is closed only by its own kind and at least its own length', () => {
    const body = '````\n```\n## Not covered\n````\n## Not covered';
    expect(proseWarnings(body)).toEqual([{ line: 5, kind: 'marks work as put off' }]);
  });

  it('leaves out the prescribed `findings filed privately`, and reads the rest of its line', () => {
    expect(proseWarnings('Further findings filed privately.')).toEqual([]);
    expect(proseWarnings('Findings were filed privately or fixed in the next commit.')).toEqual([]);
    expect(proseWarnings('Findings filed privately; the rest is its own PR.')).toEqual([
      { line: 1, kind: 'marks work as put off' },
    ]);
    // Only `findings` filed privately: a named thing filed privately still names it.
    for (const named of ['The token-refresh race is filed privately.', 'a gap filed privately in the register', 'The rest is filed privately for later.']) {
      expect(proseWarnings(named), named).toEqual([{ line: 1, kind: 'marks work as put off' }]);
    }
    // Nothing else may sit inside the exception: another form between `findings` and
    // `filed privately` is read.
    for (const inside of ['findings left open in a later PR, filed privately', 'findings not fixed here, filed privately', 'findings are pre-existing gaps, filed privately']) {
      expect(proseWarnings(inside), inside).toEqual([{ line: 1, kind: 'marks work as put off' }]);
    }
    // The subject stays: findings said to be open are read as such.
    for (const open of ['Findings filed privately and still open', 'Findings are filed privately and remain open']) {
      expect(proseWarnings(open), open).toEqual([{ line: 1, kind: 'marks work as put off' }]);
    }
    expect(proseWarnings('Findings filed  privately.')).toEqual([]);
    // The spellings in use pass.
    for (const ok of ['Findings outside the change are filed privately.', 'Findings were fixed here or filed privately.', 'Further findings filed privately.']) {
      expect(proseWarnings(ok), ok).toEqual([]);
    }
    // Control: `filed` without `privately` still warns.
    expect(proseWarnings('The rest is filed.')).toEqual([{ line: 1, kind: 'marks work as put off' }]);
  });
});
