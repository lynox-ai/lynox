/**
 * The `.gitignore` rules that keep real thread content out of a PUBLIC repo.
 *
 * A rule in `.gitignore` is executable configuration with no test attached, which
 * makes it the easiest kind of guard to delete by accident: nothing turns red, and
 * the failure is silent and permanent — a committed transcript cannot be taken back.
 * These assertions are `git check-ignore` outcomes, so they characterise the real
 * matcher rather than a re-implementation of it.
 *
 * `--no-index` throughout, and that is the whole reason these are meaningful: without
 * it `git check-ignore` says nothing about a path that is already tracked, so every
 * assertion about the kg-bench corpora would pass for the wrong reason.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf-8' }).trim();

/** `check-ignore` exits 1 for "not ignored", which execFileSync throws on. */
function isIgnored(path: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '--no-index', '-q', '--', path], { cwd: ROOT, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('.gitignore — real thread content cannot be committed by accident', () => {
  it('ignores the jsonl gold format wherever it lands', () => {
    for (const p of [
      'gold.jsonl',
      'tests/eval/whatever.jsonl',
      'deep/nested/dir/threads.jsonl',
      'gold.jsonl.bak',          // `cp x.jsonl x.jsonl.bak`, the shell habit
      'export.ndjson',
      'gold-2026.json',
      'my-gold-set.json',
    ]) {
      expect(isIgnored(p), p).toBe(true);
    }
  });

  // The comment in `.gitignore` calls this an HONEST LIMIT. Pinning it turns a
  // sentence into a fact: if someone later believes the `.json` half is covered,
  // this test is what contradicts them. It is also the assertion that must be
  // DELETED, not edited, by whoever closes the gap with a structural guard.
  it('does NOT ignore a GoldCorpus under a name that says nothing — the stated limit', () => {
    for (const p of ['corpus.json', 'threads.json', 'data/export.json']) {
      expect(isIgnored(p), p).toBe(false);
    }
  });

  // The negations. These matter for FUTURE files: the four tracked corpora are
  // unaffected either way, because .gitignore never applies to a tracked path.
  it('keeps new kg-bench fixtures addable in the two directories that hold them', () => {
    expect(isIgnored('scripts/kg-bench/corpus/gamma.jsonl')).toBe(false);
    expect(isIgnored('scripts/kg-bench/queries/catalog-v2.jsonl')).toBe(false);
  });

  // `*` does not cross `/`, which the comment says and nothing checked. A new
  // subdirectory falls back to the blanket rule — the safe default, and the one a
  // future author needs to know about before wondering why their file vanished.
  it('a NEW subdirectory under kg-bench is not covered by the negations', () => {
    expect(isIgnored('scripts/kg-bench/corpus/v2/gamma.jsonl')).toBe(true);
    expect(isIgnored('scripts/kg-bench/queries/v2/catalog.jsonl')).toBe(true);
  });

  // The control for every assertion above: an ordinary source path is not ignored,
  // so a `.gitignore` that swallowed the whole tree would fail here rather than
  // making all the `toBe(true)` cases pass.
  it('ordinary source files are untouched', () => {
    for (const p of ['src/core/agent.ts', 'tests/gate-record.test.ts', 'package.json']) {
      expect(isIgnored(p), p).toBe(false);
    }
  });
});
