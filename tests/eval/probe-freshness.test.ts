import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { runToken, freshName, freshUid, sawDedup } from '../../scripts/model-fitness/probe-freshness.mjs';

/**
 * The freshness primitives.
 *
 * The first version of this file asserted that the token is CONSTANT within a process and
 * never that it VARIES between processes — so replacing the whole generator with
 * `const TOKEN = 'K7Q2'` left all of it green. Across-run freshness is the only thing this
 * module exists for, and it was the one property untested (`memory/fb_test_must_fail.md`:
 * mutate the changed line, not the feature). The two-process test below is the fix.
 */

const REPO = path.resolve(__dirname, '../..');
const MODULE = path.join(REPO, 'scripts/model-fitness/probe-freshness.mjs');

/** One token from a FRESH node process — the only way to observe per-run behaviour. */
function tokenFromNewProcess(): string {
  return execFileSync(
    process.execPath,
    ['-e', `import(${JSON.stringify(MODULE)}).then(m => process.stdout.write(m.runToken()))`],
    { encoding: 'utf8' },
  ).trim();
}

describe('probe freshness primitives', () => {
  it('gives a DIFFERENT token to a different run — the property the module exists for', () => {
    // Two real processes, because that is what a second probe run is. A hard-coded token or
    // any per-process memoisation of a constant dies here.
    const a = tokenFromNewProcess();
    const b = tokenFromNewProcess();
    expect(a).not.toBe('');
    expect(a).not.toBe(b);
  });

  it('has no PERIOD — twelve tokens drawn in the same millisecond are all distinct', () => {
    // The test above does not cover this, and the gap is the exact defect that shipped in
    // the first version: `Date.now().toString(36).slice(-4)` is ms mod 36⁴, a 28-minute
    // cycle. Two processes started milliseconds apart still differ under it, so a
    // two-process test calls it healthy — while two probe runs half an hour apart collide
    // and dedup each other.
    //
    // Cache-busted imports draw many tokens inside one millisecond or two. A clock-derived
    // token repeats across them by construction; a token drawn from a space with no period
    // does not. This is the discriminator, not the two-process one.
    const draws = execFileSync(
      process.execPath,
      ['-e', `Promise.all(Array.from({length:12},(_,i)=>import(${JSON.stringify(MODULE)}+'?v='+i)))`
        + `.then(ms => process.stdout.write(ms.map(m => m.runToken()).join(',')))`],
      { encoding: 'utf8' },
    ).trim().split(',');
    expect(draws).toHaveLength(12);
    expect(new Set(draws).size).toBe(12);
  });

  it('makes the SUBJECT new without leaving a word boundary the store can match across', () => {
    // `KnowledgeStore._mentions` matches a subject name that is not flanked by an ALNUM
    // character, so `Talbach-XXXX` still reads as a mention of an existing `Talbach` and can
    // re-attach the old subject. The token must join directly.
    const name = freshName('Talbach');
    expect(name.startsWith('Talbach')).toBe(true);
    expect(name).not.toBe('Talbach');
    const suffix = name.slice('Talbach'.length);
    expect(suffix).toMatch(/^[0-9A-Z]+$/);
    expect(name).not.toMatch(/[^0-9A-Za-z]/);
  });

  it('holds the token FIXED across calls, because a run is the unit of freshness', () => {
    // `dk-capture-repro` deliberately sends one fact through three prompt conditions; a
    // per-call token would give each cell its own subject and destroy that control.
    expect(freshName('A')).toBe(`A${runToken()}`);
    expect(freshName('B')).toBe(`B${runToken()}`);
  });

  it('gives distinct facts in one run distinct UIDs, in the CHE format', () => {
    const uids = [0, 1, 2, 3, 4, 5].map(freshUid);
    expect(new Set(uids).size).toBe(uids.length);
    for (const uid of uids) expect(uid).toMatch(/^CHE-\d{3}\.\d{3}\.\d{3}$/);
  });

  it('recognises the dedup sentence the tool actually returns today', () => {
    // Read from source, not copied: the coupling IS the risk, so the test reads the other
    // side of it. If `knowledge.ts` rewords the sentence, this fails and whoever reworded it
    // learns that a probe tripwire depends on it. A false red on a refactor is the intended
    // cost — the alternative is a tripwire that goes quiet without telling anyone.
    const src = readFileSync(path.join(REPO, 'src/tools/builtin/knowledge.ts'), 'utf8');
    const m = /return '(Already recorded[^']*)'/.exec(src);
    expect(m, 'the dedup message moved or changed shape in knowledge.ts').not.toBeNull();
    expect(sawDedup(m![1])).toBe(true);
  });

  it('does not fire on an ordinary success message', () => {
    expect(sawDedup('Recorded for review: this conversation read external content')).toBe(false);
    expect(sawDedup(undefined)).toBe(false);
    expect(sawDedup('')).toBe(false);
  });
});
