/**
 * Every chunk type the manifest can declare must have a home in the importer's group table.
 *
 * WHY THIS FILE EXISTS, and it is a compatibility property rather than a bug in this tree.
 * `groupChunksByType` builds a fixed table and drops what it does not recognise:
 *
 *     const group = groups[meta.type];
 *     if (group) group.push({ meta, data: buf });
 *
 * Measured across two real trees on 2026-09-24 — v2.14.2's importer consuming an export from
 * `origin/main`, both running their own code, the fixture built by neither: a five-chunk
 * export arrived complete (`isComplete()` true, every chunk hash verified), the importer
 * restored the two types it knew, **silently discarded `sweeps` and two `portable_dir`
 * chunks**, threw nothing, and its progress stream ended at `{phase:'done',currentChunk:5,
 * totalChunks:5}`. The number in that last event is the MANIFEST's count, not what was
 * restored, so a watching user sees a completed migration and has an instance missing its
 * sweeps and its `apis/`+`workspace/` files.
 *
 * Two things follow, and the second is why this test is shaped as it is:
 *   · Nothing in this repository can repair that for an ALREADY SHIPPED importer. v2.13.0 and
 *     v2.14.2 read neither `meta.type` against a list nor `manifest.version` at all — measured
 *     — so bumping the format version would be just as silent. That part is a release note,
 *     not a code change.
 *   · What this tree owes is that the NEXT addition cannot be silent. A new chunk type has to
 *     be declared in the union (TypeScript forces that much), so the union is the one place a
 *     guard can stand.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The declared chunk-type union, read from the contract rather than restated here. */
function declaredTypes(): string[] {
  const src = readFileSync(join(HERE, 'migration-crypto.ts'), 'utf-8');
  const line = src.split('\n').find((l) => /^\s*type:\s*'[a-z_]+'\s*\|/.test(l));
  expect(line, 'the chunk-type union must be a single line in MigrationChunkMeta').toBeDefined();
  return [...line!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
}

/** The keys of the importer's group table, read from its source. */
function groupTableKeys(): string[] {
  const src = readFileSync(join(HERE, 'migration-import.ts'), 'utf-8');
  const start = src.indexOf('const groups: Record<string');
  expect(start, 'groupChunksByType must still build a table literal').toBeGreaterThan(-1);
  const body = src.slice(start, src.indexOf('};', start));
  return [...body.matchAll(/^\s{6}([a-z_]+):\s*\[\],?$/gm)].map((m) => m[1]!);
}

describe('a chunk type the importer cannot place is a chunk it drops in silence', () => {
  it('gives every declared type a group, so nothing this tree exports can vanish', () => {
    const declared = declaredTypes();
    const keys = groupTableKeys();
    // The control first: both parses must have found something, or the comparison below is
    // two empty sets agreeing with each other.
    expect(declared.length, 'the union parse found nothing').toBeGreaterThan(4);
    expect(keys.length, 'the group-table parse found nothing').toBeGreaterThan(4);
    expect([...keys].sort()).toEqual([...declared].sort());
  });

  it('pins the type set, so growing it is a DECISION and not a diff', () => {
    // When this list changes, the addition is fine — what is not fine is adding a type and
    // shipping it under the same `manifest.version: 1`. An importer older than the release
    // drops the new type without a word (measured on v2.13.0 and v2.14.2), so the addition
    // owes a release note saying an export must not be restored onto an older instance, and
    // it owes a decision about whether this is the release that starts checking the version.
    expect(declaredTypes().sort()).toEqual([
      'artifacts', 'config', 'memory', 'portable_dir', 'secrets', 'sqlite_db', 'sweeps',
    ]);
  });

  it('the importer still reads neither the manifest version nor an allow-list of types', () => {
    // Not a defect on its own — it is the reason the remedy is a release note. If a future
    // change adds either check, this assertion is the one that should be revisited, and the
    // comment above with it.
    const src = readFileSync(join(HERE, 'migration-import.ts'), 'utf-8');
    expect(src.includes('manifest.version'), 'a version check would change the remedy').toBe(false);
    // …and the control that the file was read at all.
    expect(src).toContain('groupChunksByType');
  });
});
