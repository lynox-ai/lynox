import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * One funnel for the grant (PRD connection-attribution A2): `ApiStore` is the only place that
 * assigns a profile's `grant_id`, and every other save keeps the stored one. A second writer
 * would mint — or keep — a grant under rules nobody reviews here, so this refuses one.
 */
const SRC = join(import.meta.dirname, '..');
// grant-ledger.ts declares the ledger row's `grant_id` column; it assigns no profile's.
const ALLOWED = new Set(['core/api-store.ts', 'core/grant-ledger.ts']);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts') ? [path] : [];
  });
}

describe('grant funnel', () => {
  it('only api-store.ts assigns grant_id', () => {
    const writers = sources(SRC)
      .filter((path) => /\bgrant_id\s*(?::|=(?!=))/.test(readFileSync(path, 'utf-8')))
      .map((path) => relative(SRC, path));
    expect(writers).toEqual([...ALLOWED]);
  });

  it('positive control: the pattern sees the assignment that exists', () => {
    expect(/\bgrant_id\s*(?::|=(?!=))/.test(readFileSync(join(SRC, 'core/api-store.ts'), 'utf-8'))).toBe(true);
    expect(/\bgrant_id\s*(?::|=(?!=))/.test('x.oauth_grant?.grant_id === y')).toBe(false);
  });
});
