import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineDb } from './engine-db.js';
import { MAX_REQUESTS_PER_MANDATE, SecretReleases } from './secret-releases.js';

describe('SecretReleases', () => {
  let dir: string;
  let edb: EngineDb;
  let releases: SecretReleases;
  const A = 'mandate:setup@example.invalid';
  const owner = { kind: 'owner' } as const;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-secret-releases-'));
    edb = new EngineDb(join(dir, 'engine.db'));
    releases = new SecretReleases(edb.getDb());
  });
  afterEach(() => {
    edb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('a save replaces what its profile asked for, so a name it no longer reads leaves nothing behind', () => {
    releases.replaceRequests('crm', A, 'M-1', [{ name: 'KEY_A', binding: 'b1' }, { name: 'KEY_B', binding: 'b1' }]);
    expect(releases.pendingReleases().map((r) => r.name)).toEqual(['KEY_A', 'KEY_B']);
    releases.replaceRequests('crm', A, 'M-1', [{ name: 'KEY_B', binding: 'b2' }]);
    expect(releases.pendingReleases().map((r) => [r.name, r.binding])).toEqual([['KEY_B', 'b2']]);
  });

  it('keeps no more open requests per grant than the cap, and says how many it wrote', () => {
    const asks = Array.from({ length: MAX_REQUESTS_PER_MANDATE + 5 }, (_, i) => ({ name: `KEY_${String(i)}`, binding: 'b' }));
    expect(releases.replaceRequests('crm', A, 'M-1', asks)).toBe(MAX_REQUESTS_PER_MANDATE);
    expect(releases.pendingReleases()).toHaveLength(MAX_REQUESTS_PER_MANDATE);
    // Another grant has its own count.
    expect(releases.replaceRequests('erp', A, 'M-2', [{ name: 'KEY_X', binding: 'b' }])).toBe(1);
  });

  it('a release answers the request, and is found by profile, author and name only', () => {
    releases.replaceRequests('crm', A, 'M-1', [{ name: 'KEY_A', binding: 'b1' }]);
    releases.release(owner, { profileId: 'crm', profileAuthor: A, name: 'KEY_A', binding: 'b1', mandateId: 'M-1' });
    expect(releases.requestOf('crm', 'KEY_A')).toBeUndefined();
    expect(releases.releaseOf('crm', A, 'KEY_A')).toEqual({ binding: 'b1', mandateId: 'M-1' });
    expect(releases.releaseOf('crm', 'mandate:other@example.invalid', 'KEY_A')).toBeUndefined();
    expect(releases.releaseOf('erp', A, 'KEY_A')).toBeUndefined();
    expect(releases.activeReleases()).toHaveLength(1);
  });

  it('withdraw takes one release back; forgetting a profile drops its requests and its releases', () => {
    releases.release(owner, { profileId: 'crm', profileAuthor: A, name: 'KEY_A', binding: 'b1', mandateId: 'M-1' });
    expect(releases.withdraw(owner, 'crm', 'KEY_A')).toBe(true);
    expect(releases.withdraw(owner, 'crm', 'KEY_A')).toBe(false);
    releases.release(owner, { profileId: 'crm', profileAuthor: A, name: 'KEY_B', binding: 'b1', mandateId: 'M-1' });
    releases.replaceRequests('crm', A, 'M-1', [{ name: 'KEY_C', binding: 'b1' }]);
    releases.forgetProfile('crm');
    expect(releases.activeReleases()).toEqual([]);
    expect(releases.pendingReleases()).toEqual([]);
  });
});
