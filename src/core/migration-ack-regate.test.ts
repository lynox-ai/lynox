import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngineDb } from './engine-db.js';
import { ConnectionStore } from './connection-store.js';
import { ApiStore, type ApiProfile } from './api-store.js';
import { MigrationExporter } from './migration-export.js';
import { MigrationImporter } from './migration-import.js';
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
});
