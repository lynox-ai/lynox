import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { RunHistory } from './run-history.js';
import { EngineDb } from './engine-db.js';
import { AgentMemoryDb } from './agent-memory-db.js';
import { DataStore } from './data-store.js';
import { SecretVault } from './secret-vault.js';
import { SecurityAudit } from './security-audit.js';

// What secure_delete does to the bytes is asserted once, on a bare connection, in
// `sqlite-constants.test.ts`. This pins the other half: every store that holds user
// data turns it on for the connection it opens. The erasure's VACUUM would hide a
// store that forgot, so the byte witness for the erasure cannot be this witness.
describe('every user-data store opens its connection with secure_delete', () => {
  let dir = '';
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ''; });

  const secureDelete = (store: object): unknown =>
    (store as { db: Database.Database }).db.pragma('secure_delete', { simple: true });

  const cases: Array<[string, (d: string) => object]> = [
    ['history.db', d => new RunHistory(join(d, 'history.db'))],
    // A second connection to history.db that writes user text (`input_preview`).
    ['history.db (security audit)', d => new SecurityAudit(join(d, 'history.db'))],
    ['engine.db', d => new EngineDb(join(d, 'engine.db'), '')],
    ['agent-memory.db', d => new AgentMemoryDb(join(d, 'agent-memory.db'))],
    ['datastore.db', d => new DataStore(join(d, 'datastore.db'))],
    ['vault.db', d => new SecretVault({ path: join(d, 'vault.db'), masterKey: 'k'.repeat(64) })],
  ];

  for (const [name, open] of cases) {
    it(name, () => {
      dir = mkdtempSync(join(tmpdir(), 'lynox-sd-'));
      const store = open(dir);
      try {
        expect(secureDelete(store)).toBe(1);
      } finally {
        (store as { close(): void }).close();
      }
    });
  }
});
