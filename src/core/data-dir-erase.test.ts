import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR_INVENTORY, ERASE_BY_REMOVE, ERASE_BY_STEP, ERASE_KEPT } from './data-dir-inventory.js';

/**
 * The erasure's decision per data-dir entry, held against a SECOND source.
 *
 * The route derives what it removes from `DATA_DIR_INVENTORY`. A test that derived its
 * expectation from the same table would agree with any change to it: flip `artifacts` to
 * `keep` and the route keeps the customer's documents while the test expects exactly that.
 * So the set of entries the erasure LEAVES ALONE is written out here by hand, and moving
 * an entry into or out of it has to change this file — a reviewer sees the decision.
 */
const KEPT_BY_DECISION = new Set([
  '.access-token',
  '.cache-salt',
  '.env',
  '.last_version',
  '.tos-accepted-1',
  '.volume-check',
  'http-secret',
  'plugins',
  'pricing.json',
  'vapid-keys.json',
  'vault.key',
  'wire-sink-on',
  'wire-sink-raw-on',
]);

describe('data-dir erasure decisions', () => {
  it('keeps exactly the entries decided here, and erases every other one', () => {
    expect(new Set(ERASE_KEPT)).toEqual(KEPT_BY_DECISION);
    const erased = new Set([...ERASE_BY_STEP, ...ERASE_BY_REMOVE]);
    const all = DATA_DIR_INVENTORY.map(e => e.name);
    expect(erased).toEqual(new Set(all.filter(n => !KEPT_BY_DECISION.has(n))));
  });

  it('gives every kept entry a reason', () => {
    const silent = DATA_DIR_INVENTORY.filter(e => e.erase.by === 'keep' && e.erase.why.trim() === '').map(e => e.name);
    expect(silent).toEqual([]);
  });

  // The entrypoint writes into the data dir in SHELL, which the source scan in
  // `data-dir-coverage.test.ts` cannot read. Every `$HOME/.lynox/<name>` it names has to
  // be declared: the erasure refuses to run while the data dir holds an entry this table
  // does not know, so an undeclared login token or vault key would block every erasure.
  it('declares every data-dir name the container entrypoint touches', () => {
    const script = readFileSync(join(__dirname, '..', '..', 'entrypoint-webui.sh'), 'utf8');
    const named = new Set([...script.matchAll(/(?:\$HOME|~)\/\.lynox\/([A-Za-z0-9._-]+)/g)].map(m => m[1]!).filter(n => n !== '.' && n !== '..'));
    // Positive control: the scan finds the two the entrypoint is known to write.
    expect(named).toContain('.access-token');
    expect(named).toContain('.env');
    const declared = new Set(DATA_DIR_INVENTORY.map(e => e.name));
    expect([...named].filter(n => !declared.has(n))).toEqual([]);
  });
});
