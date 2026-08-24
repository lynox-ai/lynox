import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { runToken, freshName, freshUid, sawDedup } from '../../scripts/model-fitness/probe-freshness.mjs';

/**
 * The freshness primitives, and the one coupling their own docstring admits.
 *
 * `sawDedup` matches the tool's user-facing sentence, so a reword in `knowledge.ts` would
 * silence the tripwire without failing anything. The module says so instead of pretending
 * robustness; this file turns the admission into a test, so the reword breaks here rather
 * than in a probe run months later (`memory/fb_source_vs_wire.md`).
 */

const REPO = path.resolve(__dirname, '../..');

describe('probe freshness primitives', () => {
  it('makes the SUBJECT new, which is what removes old rows from the candidate set', () => {
    // Not "the string differs" — the point is that the company NAME changed, because the
    // store selects dedup candidates by subject. A helper that varied only a trailing
    // number would pass a naive inequality check and still dedup.
    const name = freshName('Nordberg');
    expect(name).not.toBe('Nordberg');
    expect(name.startsWith('Nordberg-')).toBe(true);
    expect(name.slice('Nordberg-'.length)).toMatch(/^[0-9A-Z]{1,4}$/);
  });

  it('holds the token FIXED across calls, because a run is the unit of freshness', () => {
    // `dk-capture-repro` deliberately sends the same fact through three prompt conditions.
    // A per-call token would give each cell its own subject and destroy that control — this
    // is the assertion that dies if someone "improves" the helper into a random per call.
    expect(freshName('A').split('-')[1]).toBe(freshName('B').split('-')[1]);
    expect(freshName('A').split('-')[1]).toBe(runToken());
  });

  it('gives distinct facts in one run distinct UIDs, in the CHE format', () => {
    const a = freshUid(0), b = freshUid(1);
    expect(a).not.toBe(b);
    for (const uid of [a, b]) expect(uid).toMatch(/^CHE-\d{3}\.\d{3}\.\d{3}$/);
  });

  it('recognises the dedup sentence the tool actually returns today', () => {
    // Read from source, not copied: the coupling is the risk, so the test reads the other
    // side of it. If `knowledge.ts` rewords the sentence, this fails and whoever reworded it
    // learns that a probe tripwire depends on it.
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
