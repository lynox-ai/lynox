import { describe, it, expect, afterEach, vi } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { EngineDb } from './engine-db.js';
import { ConnectionStore } from './connection-store.js';
import { ApiStore, type ApiProfile } from './api-store.js';
import { MigrationExporter } from './migration-export.js';
import { MigrationImporter } from './migration-import.js';
import { isEndpointAcked } from './llm/endpoint-allowlist.js';
import { corruptFileLeftInPlace } from './sqlite-constants.js';
import {
  generateEphemeralKeypair,
  serializePublicKey,
  deserializePublicKey,
  deriveTransferKey,
} from './migration-crypto.js';

// Re-gate of a migrated BYOK custom-endpoint acceptance (self→managed import).
// The ack is a per-instance acceptance and must NOT be inherited by a managed
// destination; a self-hosted import keeps it. See migration-import.ts /
// ApiStore.regateMigratedApiConnections / endpoint-allowlist.ts.

const SRC_VAULT_KEY = 'source-vault-key-regate-test-2026';
const DST_VAULT_KEY = 'dest-vault-key-regate-test-2026';
const MIGRATION_TOKEN = 'a'.repeat(64);

const ACK = {
  accepted: true as const,
  hosts: ['custom.example.com'],
  accepted_at: '2026-07-03T00:00:00.000Z',
};

function ackedProfile(over: Partial<ApiProfile> = {}): ApiProfile {
  return {
    id: 'customapi',
    name: 'Custom API',
    base_url: 'https://custom.example.com',
    description: 'A BYOK custom-endpoint API',
    auth: { type: 'bearer', vault_keys: ['CUSTOM_TOKEN'] },
    custom_endpoint_ack: ACK,
    provenance: { source: 'manual', schema_version: 2 },
    ...over,
  };
}

describe('migration custom_endpoint_ack re-gate (S4b follow-up)', () => {
  const dirs: string[] = [];
  const origTier = process.env['LYNOX_BILLING_TIER'];
  const origMode = process.env['LYNOX_MANAGED_MODE'];

  function tmp(): string {
    const d = mkdtempSync(join(tmpdir(), 'lynox-regate-'));
    dirs.push(d);
    return d;
  }

  /** Seed an engine.db in `dir` with one api connection (config_json plaintext). */
  function seedEngineDb(dir: string, profile: ApiProfile, vaultKey = SRC_VAULT_KEY): void {
    const engine = new EngineDb(join(dir, 'engine.db'), vaultKey);
    try {
      const store = new ApiStore();
      store.setConnectionStore(new ConnectionStore(engine));
      store.save(profile);
    } finally {
      engine.close();
    }
  }

  /**
   * Seed a valid, whitelisted NON-engine.db (`history.db`) in `dir` and NO
   * engine.db, so a migration carries data but `databasesRestored` never
   * contains `engine.db` — the input the re-gate's engine.db-presence guard
   * must short-circuit on.
   */
  function seedHistoryDbOnly(dir: string): void {
    const db = new Database(join(dir, 'history.db'));
    try {
      db.exec('CREATE TABLE marker (id INTEGER PRIMARY KEY)');
      db.prepare('INSERT INTO marker (id) VALUES (1)').run();
    } finally {
      db.close();
    }
  }

  /** Project a profile back out of an engine.db (opens/closes its own handle). */
  function readProfile(dir: string, vaultKey: string, id: string): ApiProfile | undefined {
    const engine = new EngineDb(join(dir, 'engine.db'), vaultKey);
    try {
      const store = new ApiStore();
      store.loadFromConnections(new ConnectionStore(engine));
      return store.get(id);
    } finally {
      engine.close();
    }
  }

  function performHandshake(importer: MigrationImporter): Buffer {
    const sh = importer.startHandshake(MIGRATION_TOKEN);
    const clientKp = generateEphemeralKeypair();
    const nonce = Buffer.from(sh.challengeNonce, 'hex');
    const serverPub = deserializePublicKey(sh.serverPubKey);
    const transferKey = deriveTransferKey(clientKp.privateKey, serverPub, nonce);
    importer.completeHandshake(serializePublicKey(clientKp.publicKey));
    return transferKey;
  }

  /** Full export→import→restore of a src engine.db into a fresh dst dir. */
  function runMigration(srcDir: string, dstDir: string): string[] {
    const exporter = new MigrationExporter({ lynoxDir: srcDir, vaultKey: SRC_VAULT_KEY });
    const importer = new MigrationImporter({ lynoxDir: dstDir, vaultKey: DST_VAULT_KEY });
    const transferKey = performHandshake(importer);
    const { manifest, chunks } = exporter.export(transferKey);
    importer.setManifest(manifest);
    for (const chunk of chunks) importer.receiveChunk(chunk);
    const verification = importer.restore();
    importer.cleanup();
    return verification.databasesRestored;
  }

  afterEach(() => {
    if (origTier === undefined) delete process.env['LYNOX_BILLING_TIER'];
    else process.env['LYNOX_BILLING_TIER'] = origTier;
    if (origMode === undefined) delete process.env['LYNOX_MANAGED_MODE'];
    else process.env['LYNOX_MANAGED_MODE'] = origMode;
    for (const d of dirs.splice(0)) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('managed import STRIPS the ack, keeping the rest of the profile intact', () => {
    const srcDir = tmp();
    const dstDir = tmp();
    seedEngineDb(srcDir, ackedProfile());
    process.env['LYNOX_BILLING_TIER'] = 'starter'; // managed signal ON

    const restored = runMigration(srcDir, dstDir);
    expect(restored).toContain('engine.db');

    const after = readProfile(dstDir, DST_VAULT_KEY, 'customapi');
    expect(after?.custom_endpoint_ack).toBeUndefined(); // re-gated
    // The rest of the profile survives the strip.
    expect(after?.name).toBe('Custom API');
    expect(after?.base_url).toBe('https://custom.example.com');
    expect(after?.description).toBe('A BYOK custom-endpoint API');
    expect(after?.auth?.vault_keys).toEqual(['CUSTOM_TOKEN']);
  });

  it('self-hosted import KEEPS the ack (over-strip guard)', () => {
    const srcDir = tmp();
    const dstDir = tmp();
    seedEngineDb(srcDir, ackedProfile());
    delete process.env['LYNOX_BILLING_TIER']; // managed signal OFF
    delete process.env['LYNOX_MANAGED_MODE']; // and its legacy alias

    const restored = runMigration(srcDir, dstDir);
    expect(restored).toContain('engine.db');

    const after = readProfile(dstDir, DST_VAULT_KEY, 'customapi');
    expect(after?.custom_endpoint_ack).toEqual(ACK); // unchanged
  });

  it('legacy LYNOX_MANAGED_MODE alias also triggers the strip', () => {
    const srcDir = tmp();
    const dstDir = tmp();
    seedEngineDb(srcDir, ackedProfile());
    delete process.env['LYNOX_BILLING_TIER'];
    process.env['LYNOX_MANAGED_MODE'] = 'starter'; // pre-rename managed tenant

    runMigration(srcDir, dstDir);

    expect(readProfile(dstDir, DST_VAULT_KEY, 'customapi')?.custom_endpoint_ack).toBeUndefined();
  });

  it('regateMigratedApiConnections strips the ack directly and reports the count', () => {
    const dir = tmp();
    seedEngineDb(dir, ackedProfile());
    expect(readProfile(dir, SRC_VAULT_KEY, 'customapi')?.custom_endpoint_ack).toEqual(ACK);

    const n = ApiStore.regateMigratedApiConnections(join(dir, 'engine.db'), SRC_VAULT_KEY);
    expect(n).toBe(1);
    expect(readProfile(dir, SRC_VAULT_KEY, 'customapi')?.custom_endpoint_ack).toBeUndefined();
  });

  it('is a no-op when no ack is present, and stable when re-run (idempotent)', () => {
    const dir = tmp();
    // A profile on an allowlisted host carries no ack.
    seedEngineDb(dir, ackedProfile({
      id: 'noack',
      base_url: 'https://api.anthropic.com',
      custom_endpoint_ack: undefined,
    }));
    expect(ApiStore.regateMigratedApiConnections(join(dir, 'engine.db'), SRC_VAULT_KEY)).toBe(0);

    // Re-running after a strip is stable.
    const dir2 = tmp();
    seedEngineDb(dir2, ackedProfile());
    expect(ApiStore.regateMigratedApiConnections(join(dir2, 'engine.db'), SRC_VAULT_KEY)).toBe(1);
    expect(ApiStore.regateMigratedApiConnections(join(dir2, 'engine.db'), SRC_VAULT_KEY)).toBe(0);
  });

  it('skips a row with malformed config_json without throwing', () => {
    const dir = tmp();
    seedEngineDb(dir, ackedProfile()); // one valid acked row
    // Inject a raw malformed api row alongside it.
    const engine = new EngineDb(join(dir, 'engine.db'), SRC_VAULT_KEY);
    engine.getDb().prepare(
      "INSERT INTO connections (id, kind, name, config_json) VALUES ('broken','api','Broken','not-json')",
    ).run();
    engine.close();

    // The malformed row is skipped; the valid acked row is still re-gated.
    expect(ApiStore.regateMigratedApiConnections(join(dir, 'engine.db'), SRC_VAULT_KEY)).toBe(1);
    expect(readProfile(dir, SRC_VAULT_KEY, 'customapi')?.custom_endpoint_ack).toBeUndefined();
  });

  it('re-gates only the acked rows in a mixed batch, leaving the rest untouched', () => {
    const dir = tmp();
    seedEngineDb(dir, ackedProfile()); // 'customapi' — acked
    seedEngineDb(dir, ackedProfile({   // 'plainapi' — allowlisted host, no ack
      id: 'plainapi',
      base_url: 'https://api.anthropic.com',
      custom_endpoint_ack: undefined,
    }));

    // Only the acked row counts + is stripped.
    expect(ApiStore.regateMigratedApiConnections(join(dir, 'engine.db'), SRC_VAULT_KEY)).toBe(1);
    expect(readProfile(dir, SRC_VAULT_KEY, 'customapi')?.custom_endpoint_ack).toBeUndefined();
    // The non-acked sibling is untouched (still present, still no ack, base_url intact).
    const plain = readProfile(dir, SRC_VAULT_KEY, 'plainapi');
    expect(plain?.custom_endpoint_ack).toBeUndefined();
    expect(plain?.base_url).toBe('https://api.anthropic.com');
  });

  it('leaves a non-api connection carrying an ack-like field untouched (kind-filter guard)', () => {
    const dir = tmp();
    seedEngineDb(dir, ackedProfile()); // one valid acked api row
    // A non-api connection whose config_json happens to hold a custom_endpoint_ack.
    const engine = new EngineDb(join(dir, 'engine.db'), SRC_VAULT_KEY);
    engine.getDb().prepare(
      "INSERT INTO connections (id, kind, name, config_json) VALUES ('mailconn','mail','Mail','{\"custom_endpoint_ack\":{\"accepted\":true}}')",
    ).run();
    engine.close();

    // Only the kind='api' row is re-gated (count 1); the mail row is left exactly as-is —
    // getByKind('api') is the over-strip guard on the kind dimension.
    expect(ApiStore.regateMigratedApiConnections(join(dir, 'engine.db'), SRC_VAULT_KEY)).toBe(1);
    const check = new EngineDb(join(dir, 'engine.db'), SRC_VAULT_KEY);
    const mailRow = check.getDb()
      .prepare("SELECT config_json FROM connections WHERE id='mailconn'")
      .get() as { config_json: string };
    check.close();
    expect(JSON.parse(mailRow.config_json).custom_endpoint_ack).toEqual({ accepted: true });
  });

  it('skips the re-gate on a managed import that carries NO engine.db (presence guard)', () => {
    const srcDir = tmp();
    const dstDir = tmp();
    seedHistoryDbOnly(srcDir); // whitelisted data, but no engine.db in the set
    process.env['LYNOX_BILLING_TIER'] = 'starter'; // managed signal ON

    const spy = vi.spyOn(ApiStore, 'regateMigratedApiConnections');
    try {
      const restored = runMigration(srcDir, dstDir);
      // engine.db was never migrated, so the presence half of the `&&` guard is
      // false — the re-gate must not be attempted (and must not crash opening a
      // non-existent engine.db).
      expect(restored).toContain('history.db');
      expect(restored).not.toContain('engine.db');
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('fails the managed import CLOSED when the re-gate throws (propagates, no silent success)', () => {
    const srcDir = tmp();
    const dstDir = tmp();
    seedEngineDb(srcDir, ackedProfile());
    process.env['LYNOX_BILLING_TIER'] = 'starter'; // managed signal ON

    // The re-gate runs on engine.db's staged copy. A strip failure must
    // propagate out of restore() (the operator retries; regate is idempotent),
    // NOT be swallowed into a "success" that leaves the un-disclosed ack in place.
    const spy = vi.spyOn(ApiStore, 'regateMigratedApiConnections').mockImplementation(() => {
      throw new Error('regate boom');
    });
    try {
      expect(() => runMigration(srcDir, dstDir)).toThrow(/regate boom/);
      expect(spy).toHaveBeenCalledOnce();
    } finally {
      spy.mockRestore();
    }
  });

  it('says what happened to a staged copy that looks corrupt, not the advice for a data directory', () => {
    const srcDir = tmp();
    const dstDir = tmp();
    seedEngineDb(srcDir, ackedProfile());
    process.env['LYNOX_BILLING_TIER'] = 'starter'; // managed signal ON

    // What the store throws when the staged copy fails its check at this point: its advice is
    // about a data directory, which the staged copy is not.
    const spy = vi.spyOn(ApiStore, 'regateMigratedApiConnections').mockImplementation(() => {
      throw corruptFileLeftInPlace('engine.db.migration-tmp', new Error('database disk image is malformed'));
    });
    try {
      let thrown: unknown;
      try { runMigration(srcDir, dstDir); } catch (err) { thrown = err; }
      const message = (thrown as Error).message;
      expect(message).toContain('The restored engine.db could not be prepared for this instance (database disk image is malformed)');
      expect(message).toContain('the staged copy was dropped and the engine.db in place was not replaced');
      expect(message).not.toContain('restore it from a backup');
      expect(readdirSync(dstDir).filter((f) => f.includes('migration-tmp'))).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it('re-gates an OAuth2 token_url custom endpoint, not just a base_url (token_url egress axis)', () => {
    const dir = tmp();
    const TOKEN_HOST = 'oauth.custom-idp.example';
    const TOKEN_URL = `https://${TOKEN_HOST}/token`;
    // base_url is allowlisted, so the ONLY non-allowlisted egress is the OAuth
    // token endpoint — the ack covers that host.
    const oauthProfile: ApiProfile = {
      id: 'oauthapi',
      name: 'OAuth API',
      base_url: 'https://api.anthropic.com',
      description: 'An OAuth2 API whose token endpoint is a non-allowlisted host',
      auth: {
        type: 'oauth2',
        oauth: {
          token_url: TOKEN_URL,
          grant_type: 'client_credentials',
          client_id_key: 'OAUTH_CLIENT_ID',
          client_secret_key: 'OAUTH_CLIENT_SECRET',
        },
        vault_keys: ['OAUTH_CLIENT_SECRET'],
      },
      custom_endpoint_ack: { accepted: true, hosts: [TOKEN_HOST], accepted_at: '2026-07-03T00:00:00.000Z' },
      provenance: { source: 'manual', schema_version: 2 },
    };
    seedEngineDb(dir, oauthProfile);

    // Before: the token_url egress is acked (fetch_token would be allowed).
    const before = readProfile(dir, SRC_VAULT_KEY, 'oauthapi');
    expect(isEndpointAcked(before?.custom_endpoint_ack, TOKEN_URL)).toBe(true);

    // Re-gate (managed destination) strips the ack regardless of which egress
    // axis it covered.
    expect(ApiStore.regateMigratedApiConnections(join(dir, 'engine.db'), SRC_VAULT_KEY)).toBe(1);

    // After: the token_url egress re-gates fail-closed — the OAuth token fetch
    // must re-disclose before reuse.
    const after = readProfile(dir, SRC_VAULT_KEY, 'oauthapi');
    expect(after?.custom_endpoint_ack).toBeUndefined();
    expect(isEndpointAcked(after?.custom_endpoint_ack, TOKEN_URL)).toBe(false);
    expect(after?.auth?.oauth?.token_url).toBe(TOKEN_URL); // rest of the profile survives
  });

  // The restore route has no rollback: what a step wrote stays when a later one throws. So an
  // ack the managed destination does not inherit must never land, not be removed at the end.
  describe('a restore that throws after the data landed leaves no migrated ack behind', () => {
    const RAW_PLAIN = '{"id":"plain","name":"Plain","description":"No ack","base_url":"https://api.anthropic.com"}';
    const RAW_BROKEN = '{"id":"broken", not json';

    /** Flat `apis/` profiles in the source: one with an ack, one without, one that does not parse, one nested. */
    function seedApis(dir: string): void {
      mkdirSync(join(dir, 'apis', 'sub'), { recursive: true });
      writeFileSync(join(dir, 'apis', 'flat.json'), JSON.stringify(ackedProfile({ id: 'flat' })));
      writeFileSync(join(dir, 'apis', 'plain.json'), RAW_PLAIN);
      writeFileSync(join(dir, 'apis', 'broken.json'), RAW_BROKEN);
      writeFileSync(join(dir, 'apis', 'sub', 'nested.json'), JSON.stringify(ackedProfile({ id: 'nested' })));
      writeFileSync(join(dir, 'apis', 'notes.txt'), JSON.stringify(ackedProfile({ id: 'notes' })));
    }

    /** Migrate with step 5b (after the databases and apis/ are written) throwing. */
    function migrateThrowingLate(srcDir: string, dstDir: string): void {
      const spy = vi.spyOn(ApiStore, 'stripStoreConnectionsOnImport').mockImplementation(() => {
        throw new Error('late step boom');
      });
      try {
        expect(() => runMigration(srcDir, dstDir)).toThrow(/late step boom/);
        expect(spy).toHaveBeenCalledOnce();
      } finally {
        spy.mockRestore();
      }
    }

    /** What the next boot reads from apis/: the import into connections, then the load. */
    function importedAck(dstDir: string, id: string): ApiProfile['custom_endpoint_ack'] | 'missing' {
      const engine = new EngineDb(join(dstDir, 'boot-engine.db'), DST_VAULT_KEY);
      try {
        const cs = new ConnectionStore(engine);
        const store = new ApiStore();
        store.importFromDirectoryIfNeeded(join(dstDir, 'apis'), cs);
        store.loadFromConnections(cs);
        const p = store.knownProfiles().find((x) => x.id === id);
        return p === undefined ? 'missing' : p.custom_endpoint_ack;
      } finally {
        engine.close();
      }
    }

    it('managed: engine.db lands without the ack', () => {
      const srcDir = tmp();
      const dstDir = tmp();
      seedEngineDb(srcDir, ackedProfile());
      process.env['LYNOX_BILLING_TIER'] = 'starter';

      migrateThrowingLate(srcDir, dstDir);

      const after = readProfile(dstDir, DST_VAULT_KEY, 'customapi');
      expect(after?.name).toBe('Custom API'); // the database did land
      expect(after?.custom_endpoint_ack).toBeUndefined();
    });

    it('managed: the apis/ profiles land without the ack, and the next import takes none', () => {
      const srcDir = tmp();
      const dstDir = tmp();
      seedApis(srcDir);
      process.env['LYNOX_BILLING_TIER'] = 'starter';

      migrateThrowingLate(srcDir, dstDir);

      const flat = JSON.parse(readFileSync(join(dstDir, 'apis', 'flat.json'), 'utf-8')) as ApiProfile;
      expect(flat.custom_endpoint_ack).toBeUndefined();
      expect(flat.base_url).toBe('https://custom.example.com'); // the rest of the profile stays
      // Removing the broken file opens the import; it then takes the profile, without an ack.
      rmSync(join(dstDir, 'apis', 'broken.json'));
      expect(importedAck(dstDir, 'flat')).toBeUndefined();
    });

    it('managed: a file without an ack, one that does not parse, a nested one and a non-.json one land byte for byte', () => {
      const srcDir = tmp();
      const dstDir = tmp();
      seedApis(srcDir);
      process.env['LYNOX_BILLING_TIER'] = 'starter';

      migrateThrowingLate(srcDir, dstDir);

      expect(readFileSync(join(dstDir, 'apis', 'plain.json'), 'utf-8')).toBe(RAW_PLAIN);
      expect(readFileSync(join(dstDir, 'apis', 'broken.json'), 'utf-8')).toBe(RAW_BROKEN);
      // Not a file the import reads, so not one this pass rewrites.
      expect(readFileSync(join(dstDir, 'apis', 'sub', 'nested.json'), 'utf-8')).toBe(readFileSync(join(srcDir, 'apis', 'sub', 'nested.json'), 'utf-8'));
      expect(readFileSync(join(dstDir, 'apis', 'notes.txt'), 'utf-8')).toBe(readFileSync(join(srcDir, 'apis', 'notes.txt'), 'utf-8'));
    });

    it('control, self-hosted: the same throw leaves both acks in place, as the same data owner', () => {
      const srcDir = tmp();
      const dstDir = tmp();
      seedEngineDb(srcDir, ackedProfile());
      seedApis(srcDir);
      delete process.env['LYNOX_BILLING_TIER'];
      delete process.env['LYNOX_MANAGED_MODE'];

      migrateThrowingLate(srcDir, dstDir);

      expect(readProfile(dstDir, DST_VAULT_KEY, 'customapi')?.custom_endpoint_ack).toEqual(ACK);
      rmSync(join(dstDir, 'apis', 'broken.json'));
      expect(importedAck(dstDir, 'flat')).toEqual(ACK);
    });

    it('managed: a re-gate that fails keeps the engine.db in place and leaves no staged copy', () => {
      const srcDir = tmp();
      const dstDir = tmp();
      seedEngineDb(srcDir, ackedProfile());
      seedEngineDb(dstDir, ackedProfile({ id: 'already', custom_endpoint_ack: undefined }), DST_VAULT_KEY);
      process.env['LYNOX_BILLING_TIER'] = 'starter';

      const real = ApiStore.regateMigratedApiConnections.bind(ApiStore);
      const spy = vi.spyOn(ApiStore, 'regateMigratedApiConnections').mockImplementation((path: string, key: string) => {
        real(path, key);
        throw new Error('regate boom');
      });
      try {
        expect(() => runMigration(srcDir, dstDir)).toThrow(/regate boom/);
      } finally {
        spy.mockRestore();
      }

      expect(readProfile(dstDir, DST_VAULT_KEY, 'already')?.name).toBe('Custom API');
      expect(readProfile(dstDir, DST_VAULT_KEY, 'customapi')).toBeUndefined();
      expect(readdirSync(dstDir).filter((f) => f.includes('migration-tmp'))).toEqual([]);
    });

    it('managed: a WAL left next to the staged copy by an attempt that died is not replayed onto it', () => {
      const srcDir = tmp();
      const dstDir = tmp();
      seedEngineDb(srcDir, ackedProfile());
      process.env['LYNOX_BILLING_TIER'] = 'starter';

      // A WAL with committed frames of another database, under the staged copy's name.
      const other = join(tmp(), 'other.db');
      const db = new Database(other);
      try {
        db.pragma('journal_mode = WAL');
        db.pragma('wal_autocheckpoint = 0');
        db.exec('CREATE TABLE stale (x TEXT)');
        for (let i = 0; i < 50; i++) db.prepare('INSERT INTO stale (x) VALUES (?)').run('x'.repeat(500));
        copyFileSync(`${other}-wal`, join(dstDir, 'engine.db.migration-tmp-wal'));
      } finally {
        db.close();
      }

      runMigration(srcDir, dstDir);

      expect(readProfile(dstDir, DST_VAULT_KEY, 'customapi')?.name).toBe('Custom API');
      const check = new Database(join(dstDir, 'engine.db'), { readonly: true });
      try {
        expect(check.prepare("SELECT name FROM sqlite_master WHERE name = 'stale'").get()).toBeUndefined();
      } finally {
        check.close();
      }
    });
  });
});
