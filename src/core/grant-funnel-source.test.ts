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

  // The grant's credential fingerprints have the same single writer: a second one could record
  // a credential as the epoch's own that the epoch never held (PRD connection-attribution A2).
  it('only api-store.ts assigns fingerprints', () => {
    const writers = sources(SRC)
      .filter((path) => /\bfingerprints\??\s*(?::|=(?!=))/.test(readFileSync(path, 'utf-8')))
      .map((path) => relative(SRC, path));
    expect(writers).toEqual(['core/api-store.ts']);
  });

  // And so do the foreign tokens and the key check that ride with them: a second writer of
  // `foreign` could clear the mark on the previous account's token.
  // A property assignment, a key in an object literal or type, or a shorthand key — not a local
  // variable that happens to share the name.
  const RECORD_FIELD = /\.\s*(?:foreign|fingerprint_check)\s*=(?!=)|\b(?:foreign|fingerprint_check)\??\s*:|[{,]\s*(?:foreign|fingerprint_check)\s*[,}]/;
  it('only api-store.ts assigns the foreign tokens and the key check', () => {
    const writers = sources(SRC)
      .filter((path) => RECORD_FIELD.test(readFileSync(path, 'utf-8')))
      .map((path) => relative(SRC, path));
    expect(writers).toEqual(['core/api-store.ts']);
  });

  it('positive control: the pattern sees the assignment that exists', () => {
    expect(/\bgrant_id\s*(?::|=(?!=))/.test(readFileSync(join(SRC, 'core/api-store.ts'), 'utf-8'))).toBe(true);
    expect(/\bgrant_id\s*(?::|=(?!=))/.test('x.oauth_grant?.grant_id === y')).toBe(false);
    expect(/\bfingerprints\??\s*(?::|=(?!=))/.test('record.fingerprints = fps;')).toBe(true);
    expect(/\bfingerprints\??\s*(?::|=(?!=))/.test('if (g.fingerprints === undefined)')).toBe(false);
    expect(RECORD_FIELD.test('record.foreign = credentials.foreign;')).toBe(true);
    expect(RECORD_FIELD.test('{ ...g, foreign: [] }')).toBe(true);
    expect(RECORD_FIELD.test('record.fingerprint_check = c;')).toBe(true);
    expect(RECORD_FIELD.test('{ ...g, foreign }')).toBe(true);
    expect(RECORD_FIELD.test('let foreign = false;')).toBe(false);
    expect(RECORD_FIELD.test('if (x) foreign = true;')).toBe(false);
    expect(RECORD_FIELD.test('if (g.foreign === undefined)')).toBe(false);
  });
});
