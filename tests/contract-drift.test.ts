/**
 * Wire-contract drift guards (K-W1, PRD-CORE-PRO-CONTRACT / DEF-0030).
 *
 * (a) Byte-equality: the web-ui's vendored contract copy must be BYTE-identical
 *     to the source of truth in `src/contract/` — the web-ui is a standalone
 *     package and consumes a copy, and "almost identical" is exactly the drift
 *     class the contract exists to kill. (Pro's vendored copy is guarded on
 *     pro's side by its contract-sync CI job + CONTRACT.lock.)
 *
 * (b) Orphan-twin sweep: every symbol listed in `src/contract/migrated.ts` has
 *     its single source of truth in the contract module. A LOCAL re-declaration
 *     of one of them anywhere else in `src/` or `packages/web-ui/src/` is an
 *     orphan twin — the pre-contract failure mode where two wordgleiche copies
 *     silently diverged. Pure re-export shims (`export … from` only) are the
 *     one permitted form; the declaration patterns below do not match those.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative, join } from 'node:path';
import { MIGRATED } from '../src/contract/migrated.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const CONTRACT_DIRS = ['src/contract', 'packages/web-ui/src/lib/contract'];
const SWEEP_ROOTS = ['src', 'packages/web-ui/src'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.svelte-kit']);

function walk(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      if (CONTRACT_DIRS.includes(relative(repoRoot, full))) continue;
      walk(full, out);
    } else if (/\.(ts|svelte)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe('contract drift: web-ui vendored copy is byte-identical', () => {
  it('packages/web-ui/src/lib/contract/vocab.ts === src/contract/vocab.ts', () => {
    const sot = readFileSync(resolve(repoRoot, 'src/contract/vocab.ts'), 'utf8');
    const copy = readFileSync(resolve(repoRoot, 'packages/web-ui/src/lib/contract/vocab.ts'), 'utf8');
    expect(copy).toBe(sot);
  });
});

describe('contract drift: no orphan twin of a migrated symbol', () => {
  const files = SWEEP_ROOTS.flatMap((root) => walk(resolve(repoRoot, root), []));

  it('sweep sees a plausible file set (guard against a silently-empty walk)', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  for (const symbol of MIGRATED) {
    it(`${symbol.name} is declared only in src/contract/${symbol.contractFile}`, () => {
      const pattern = new RegExp(symbol.twinPattern);
      const twins: string[] = [];
      for (const file of files) {
        const lines = readFileSync(file, 'utf8').split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i] ?? '';
          const trimmed = line.trimStart();
          // Comments may legitimately mention the declaration form.
          if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
          if (pattern.test(line)) twins.push(`${relative(repoRoot, file)}:${i + 1}`);
        }
      }
      expect(twins, `orphan twin(s) of ${symbol.name} — the single source of truth is src/contract/${symbol.contractFile}; import/re-export it instead of re-declaring`).toEqual([]);
    });
  }
});
