import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { runToken, freshName, freshUid, sawDedup, storedActive } from '../../scripts/model-fitness/probe-freshness.mjs';

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

  it('recognises ONLY the two active-storing returns the handler actually has', () => {
    // PINNED, not derived. The first version of this test looped over the returns and
    // asserted `storedActive(r) === r.startsWith('Remembered')` — the predicate compared
    // against its own literal, which holds for ANY return set. It passed just as happily
    // with a new active-storing return that says something else (the denylist's original
    // failure mode) as without one. A tautology is worse than a missing test, because it
    // looks like coverage (`memory/fb_test_must_fail.md`).
    //
    // So: the COUNT is pinned and the recognised set is pinned. Adding, removing or
    // rewording a return in the handler fails here and forces a human to decide whether the
    // allowlist still covers it — which is the whole job this check exists to do.
    //
    // The two REJECTION outcomes (too long, secret-shaped) moved into `checkKnowledgeText`
    // in knowledge-store.ts when the turn-end capture path started sharing that gate. They
    // are still user-visible returns of `remember` — the handler returns `check.reason`
    // verbatim — so they are counted HERE, on their new surface. Lowering the count to 6
    // instead would have shrunk this guard silently while it still reported green, which is
    // the exact failure mode it exists to catch.
    const src = readFileSync(path.join(REPO, 'src/tools/builtin/knowledge.ts'), 'utf8');
    const handler = src.slice(src.indexOf('const rememberTool'), src.indexOf('// ── recall'));
    const returns = [...handler.matchAll(/return ['`]([^'`]{6,})/g)].map(m => m[1]!);

    const gateSrc = readFileSync(path.join(REPO, 'src/core/knowledge-store.ts'), 'utf8');
    // From the entry point to the end of its helper. The first cut of this slice stopped
    // at the FIRST `\n}` and went green the moment the gate was split into an entry point
    // plus `checkOneField` — the reasons moved one function down and the count silently
    // read 0 against an expected 2. A source-reading guard has to be anchored to the last
    // thing it means to cover, not to the first brace it meets.
    const gateStart = gateSrc.indexOf('export function checkKnowledgeText');
    const helperStart = gateSrc.indexOf('function checkOneField', gateStart);
    expect(helperStart, 'the shared gate no longer has the shape this guard reads').toBeGreaterThan(gateStart);
    const gateBody = gateSrc.slice(gateStart, gateSrc.indexOf('\n}', helperStart));
    const reasons = [...gateBody.matchAll(/reason: ['`]([^'`]{6,})/g)].map(m => m[1]!);
    expect(reasons, 'a rejection reason was added to or removed from checkKnowledgeText')
      .toHaveLength(2);
    // A rejection must never READ like a successful active store, or the probe counts a
    // refusal as a hit. The count pin above cannot see a reword; this can.
    expect(reasons.filter(storedActive), 'a checkKnowledgeText rejection now reads as a store')
      .toEqual([]);

    const outcomes = [...returns, ...reasons];
    expect(outcomes, 'a user-visible outcome of remember was added or removed')
      .toHaveLength(8);
    expect(outcomes.filter(storedActive)).toEqual([
      'Remembered${pinned}, but \"${input.subject}\" matches more than one subject, so it is ',
      'Remembered${linked}${pinned}.',
    ]);
  });

  it('does not fire on an ordinary success message', () => {
    expect(sawDedup('Recorded for review: this conversation read external content')).toBe(false);
    expect(sawDedup(undefined)).toBe(false);
    expect(sawDedup('')).toBe(false);
    expect(storedActive('Recorded for review: this conversation read external content')).toBe(false);
    expect(storedActive('Already recorded — this matches an existing durable entry.')).toBe(false);
    expect(storedActive(undefined)).toBe(false);
  });
});
