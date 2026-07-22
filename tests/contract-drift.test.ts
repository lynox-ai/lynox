/**
 * Wire-contract drift guards (K-W1, PRD-CORE-PRO-CONTRACT / DEF-0030).
 *
 * (a) Byte-equality: EVERY file in the web-ui's vendored contract dir must be
 *     BYTE-identical to its same-named twin in `src/contract/` — the web-ui is
 *     a standalone package and consumes copies, and "almost identical" is
 *     exactly the drift class the contract exists to kill. Directory-wide so a
 *     future vendored `shapes.ts` (or a stray divergent file dropped there) is
 *     guarded automatically. (Pro's vendored copy is guarded on pro's side by
 *     its contract-sync CI job + CONTRACT.lock.)
 *
 * (b) Orphan-twin sweep: every symbol listed in `src/contract/migrated.ts` has
 *     its single source of truth in the contract module. A LOCAL re-declaration
 *     of one of them anywhere else in `src/` or `packages/web-ui/src/` is an
 *     orphan twin — the pre-contract failure mode where two wordgleiche copies
 *     silently diverged. Pure re-export shims (`export … from` only) are the
 *     one permitted form; the declaration patterns do not match those (rules +
 *     known limitations in migrated.ts).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative, join } from 'node:path';
import { MIGRATED } from '../src/contract/migrated.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const CONTRACT_DIR = 'src/contract';
const VENDORED_DIR = 'packages/web-ui/src/lib/contract';
const SWEEP_ROOTS = ['src', 'packages/web-ui/src'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.svelte-kit']);

function walk(dir: string, out: string[]): string[] {
  // withFileTypes: no per-entry stat syscall, and a symlinked directory is NOT
  // followed (isDirectory() is false for symlinks) — the walk cannot escape.
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const rel = relative(repoRoot, full);
      if (rel === CONTRACT_DIR || rel === VENDORED_DIR) continue;
      walk(full, out);
    } else if (entry.isFile() && /\.(ts|svelte)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

describe('contract drift: web-ui vendored copies are byte-identical', () => {
  const vendored = readdirSync(resolve(repoRoot, VENDORED_DIR)).sort();

  it('the vendored dir carries at least vocab.ts', () => {
    expect(vendored).toContain('vocab.ts');
  });

  for (const file of vendored) {
    it(`${VENDORED_DIR}/${file} === ${CONTRACT_DIR}/${file}`, () => {
      // A file with no same-named twin in src/contract/ fails the readFileSync
      // below — a stray/renamed vendored file is drift too, not just edits.
      const sot = readFileSync(resolve(repoRoot, CONTRACT_DIR, file), 'utf8');
      const copy = readFileSync(resolve(repoRoot, VENDORED_DIR, file), 'utf8');
      expect(copy).toBe(sot);
    });
  }
});

describe('contract drift: no orphan twin of a migrated symbol', () => {
  const filesPerRoot = SWEEP_ROOTS.map((root) => walk(resolve(repoRoot, root), []));
  const files = filesPerRoot.flat();
  // Read + split each file ONCE for all symbols (13+ patterns over ~900 files).
  const lineCache = new Map(files.map((f) => [f, readFileSync(f, 'utf8').split('\n')] as const));

  it('sweep sees a plausible file set per root (guard against a silently-empty walk)', () => {
    for (let i = 0; i < SWEEP_ROOTS.length; i++) {
      expect(filesPerRoot[i]?.length ?? 0, `no files under ${SWEEP_ROOTS[i]}`).toBeGreaterThan(20);
    }
  });

  for (const symbol of MIGRATED) {
    it(`${symbol.name} is declared only in src/contract/${symbol.contractFile}`, () => {
      const pattern = new RegExp(symbol.twinPattern);
      const twins: string[] = [];
      for (const [file, lines] of lineCache) {
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i] ?? '';
          const trimmed = line.trimStart();
          // Comments may legitimately mention the declaration form. (Known
          // limitation: a block-comment continuation line without a leading
          // `*` is not recognized as a comment — repo style always uses `*`.)
          if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
          if (pattern.test(line)) twins.push(`${relative(repoRoot, file)}:${i + 1}`);
        }
      }
      expect(twins, `orphan twin(s) of ${symbol.name} — the single source of truth is src/contract/${symbol.contractFile}; import/re-export it instead of re-declaring`).toEqual([]);
    });
  }
});
