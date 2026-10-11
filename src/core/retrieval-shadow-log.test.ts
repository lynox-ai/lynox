import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { shadowQueryHash } from './retrieval-shadow-log.js';

/**
 * The shadow log stores a hash of every retrieval query, and a query is often a name. A
 * plain sha256 prefix let anyone holding the file and a list of names read back who was
 * looked up, after the person's data was erased. The hash is now keyed with a salt that
 * lives only in the process.
 */
describe('shadowQueryHash', () => {
  const QUERY = 'Kornfeld Sattlerei';

  it('groups a repeated query within the process', () => {
    expect(shadowQueryHash(QUERY)).toBe(shadowQueryHash(QUERY));
    expect(shadowQueryHash(QUERY)).not.toBe(shadowQueryHash('Brenntal Verlag'));
    expect(shadowQueryHash(QUERY)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('cannot be recomputed from the query alone', () => {
    const dictionary = createHash('sha256').update(QUERY).digest('hex').slice(0, 16);
    expect(shadowQueryHash(QUERY)).not.toBe(dictionary);
  });

  // A salt written into the source would be the same in every process, and so as
  // recomputable as no salt at all. A fresh module load stands in for a fresh process.
  it('draws a new salt per process', async () => {
    vi.resetModules();
    const fresh = await import('./retrieval-shadow-log.js');
    expect(fresh.shadowQueryHash(QUERY)).not.toBe(shadowQueryHash(QUERY));
  });
});
