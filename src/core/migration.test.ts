import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { SecretVault } from './secret-vault.js';
import { MigrationExporter } from './migration-export.js';
import { MigrationImporter } from './migration-import.js';
import {
  generateEphemeralKeypair,
  serializePublicKey,
  deserializePublicKey,
  deriveTransferKey,
  deriveSigningKey,
  verifyHandshake,
  computeManifestHash,
  sha256,
} from './migration-crypto.js';

// ── Test helpers ──

const SRC_VAULT_KEY = 'source-vault-key-for-testing-migration-2026';
const DST_VAULT_KEY = 'destination-vault-key-for-managed-instance-2026';
const HTTP_SECRET = 'test-instance-http-secret-abc123';

function createTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'lynox-migration-test-'));
}

function createTestVault(dir: string, key: string, secrets: Array<{ name: string; value: string }>): void {
  const vault = new SecretVault({ path: join(dir, 'vault.db'), masterKey: key });
  for (const s of secrets) {
    vault.set(s.name, s.value, 'any', 0);
  }
  vault.close();
}

function createTestDatabase(dir: string, dbName: string, rows: Array<{ id: number; text: string }>): void {
  const db = new Database(join(dir, dbName));
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE IF NOT EXISTS test_data (id INTEGER PRIMARY KEY, text TEXT)');
  const insert = db.prepare('INSERT INTO test_data (id, text) VALUES (?, ?)');
  for (const row of rows) {
    insert.run(row.id, row.text);
  }
  db.close();
}

function createTestArtifacts(dir: string, artifacts: Array<{ id: string; title: string; content: string }>): void {
  const artifactsDir = join(dir, 'artifacts');
  mkdirSync(artifactsDir, { recursive: true });

  const index = artifacts.map(a => ({
    id: a.id,
    title: a.title,
    description: '',
    type: 'html',
    createdAt: '2026-04-07T00:00:00Z',
    updatedAt: '2026-04-07T00:00:00Z',
    threadId: '',
  }));
  writeFileSync(join(artifactsDir, 'index.json'), JSON.stringify(index));

  for (const a of artifacts) {
    writeFileSync(join(artifactsDir, `${a.id}.html`), a.content);
  }
}

function createTestConfig(dir: string, config: Record<string, unknown>): void {
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
}

/** Simulate the full ECDH handshake between exporter (client) and importer (server). */
function performHandshake(importer: MigrationImporter): { clientTransferKey: Buffer; serverHandshake: ReturnType<MigrationImporter['startHandshake']> } {
  const serverHandshake = importer.startHandshake();

  // Client: verify signature
  const signingKey = deriveSigningKey(HTTP_SECRET);
  expect(verifyHandshake(serverHandshake.serverPubKey, serverHandshake.signature, signingKey)).toBe(true);

  // Client: generate keypair, derive transfer key
  const clientKp = generateEphemeralKeypair();
  const challengeNonce = Buffer.from(serverHandshake.challengeNonce, 'hex');
  const serverPubKey = deserializePublicKey(serverHandshake.serverPubKey);
  const clientTransferKey = deriveTransferKey(clientKp.privateKey, serverPubKey, challengeNonce);

  // Server: complete handshake with client's public key
  importer.completeHandshake(serializePublicKey(clientKp.publicKey));

  return { clientTransferKey, serverHandshake };
}

// ── Tests ──

describe('migration E2E', () => {
  let srcDir: string;
  let dstDir: string;

  beforeEach(() => {
    srcDir = createTmpDir();
    dstDir = createTmpDir();
  });

  afterEach(() => {
    rmSync(srcDir, { recursive: true, force: true });
    rmSync(dstDir, { recursive: true, force: true });
  });

  // ── Preview ──

  describe('preview', () => {
    it('reports empty installation', () => {
      const exporter = new MigrationExporter({ lynoxDir: srcDir, vaultKey: SRC_VAULT_KEY });
      const preview = exporter.preview();
      expect(preview.secrets).toBe(0);
      expect(preview.databases).toEqual([]);
      expect(preview.artifacts).toBe(0);
      expect(preview.hasConfig).toBe(false);
    });

    it('reports populated installation', () => {
      createTestVault(srcDir, SRC_VAULT_KEY, [
        { name: 'API_KEY', value: 'sk-test-123' },
        { name: 'DB_PASS', value: 'hunter2' },
      ]);
      createTestDatabase(srcDir, 'history.db', [{ id: 1, text: 'hello' }]);
      createTestArtifacts(srcDir, [{ id: 'abcd1234', title: 'Test', content: '<h1>Test</h1>' }]);
      createTestConfig(srcDir, { default_tier: 'sonnet' });

      const exporter = new MigrationExporter({ lynoxDir: srcDir, vaultKey: SRC_VAULT_KEY });
      const preview = exporter.preview();
      expect(preview.secrets).toBe(2);
      expect(preview.databases).toContain('history.db');
      expect(preview.artifacts).toBe(1);
      expect(preview.hasConfig).toBe(true);
    });
  });

  // ── Full Export + Import ──

  describe('full round-trip', () => {
    it('migrates secrets, databases, artifacts, and config', () => {
      // Setup source data
      createTestVault(srcDir, SRC_VAULT_KEY, [
        { name: 'ANTHROPIC_API_KEY', value: 'sk-ant-test-key-123456' },
        { name: 'TAVILY_API_KEY', value: 'tvly-test-key-789' },
      ]);
      createTestDatabase(srcDir, 'history.db', [
        { id: 1, text: 'First conversation' },
        { id: 2, text: 'Second conversation' },
      ]);
      createTestDatabase(srcDir, 'agent-memory.db', [
        { id: 1, text: 'User likes TypeScript' },
      ]);
      createTestArtifacts(srcDir, [
        { id: 'abcd1234', title: 'Dashboard', content: '<html><body>Dashboard</body></html>' },
        { id: 'efgh5678', title: 'Report', content: '<html><body>Report</body></html>' },
      ]);
      createTestConfig(srcDir, {
        default_tier: 'opus',
        thinking_mode: true,
        api_key: 'SHOULD_NOT_MIGRATE',
        provider: 'SHOULD_NOT_MIGRATE',
      });

      // Create exporter and importer
      const exporter = new MigrationExporter({ lynoxDir: srcDir, vaultKey: SRC_VAULT_KEY });
      const importer = new MigrationImporter({ lynoxDir: dstDir, vaultKey: DST_VAULT_KEY, httpSecret: HTTP_SECRET });

      // Perform ECDH handshake
      const { clientTransferKey } = performHandshake(importer);

      // Export (client-side)
      const progressEvents: string[] = [];
      const { manifest, chunks } = exporter.export(clientTransferKey, (p) => {
        progressEvents.push(`${p.phase}:${p.currentName}`);
      });

      expect(manifest.version).toBe(1);
      expect(manifest.totalChunks).toBe(chunks.length);
      expect(chunks.length).toBeGreaterThanOrEqual(4); // secrets + 2 DBs + artifacts + config
      expect(progressEvents.length).toBeGreaterThan(0);

      // Import (server-side) — set manifest, receive chunks, restore
      importer.setManifest(manifest);

      for (const chunk of chunks) {
        const result = importer.receiveChunk(chunk);
        expect(result.verified).toBe(true);
      }
      expect(importer.isComplete()).toBe(true);

      const verification = importer.restore();

      // Verify secrets
      expect(verification.secretsImported).toBe(2);
      const dstVault = new SecretVault({ path: join(dstDir, 'vault.db'), masterKey: DST_VAULT_KEY });
      expect(dstVault.get('ANTHROPIC_API_KEY')).toBe('sk-ant-test-key-123456');
      expect(dstVault.get('TAVILY_API_KEY')).toBe('tvly-test-key-789');
      dstVault.close();

      // Verify databases
      expect(verification.databasesRestored).toContain('history.db');
      expect(verification.databasesRestored).toContain('agent-memory.db');

      const dstHistoryDb = new Database(join(dstDir, 'history.db'), { readonly: true });
      const rows = dstHistoryDb.prepare('SELECT * FROM test_data ORDER BY id').all() as Array<{ id: number; text: string }>;
      expect(rows).toEqual([
        { id: 1, text: 'First conversation' },
        { id: 2, text: 'Second conversation' },
      ]);
      dstHistoryDb.close();

      // Verify artifacts
      expect(verification.artifactsImported).toBe(2);
      expect(existsSync(join(dstDir, 'artifacts', 'index.json'))).toBe(true);
      expect(readFileSync(join(dstDir, 'artifacts', 'abcd1234.html'), 'utf-8')).toContain('Dashboard');

      // Verify config — safe fields migrated, credentials excluded
      expect(verification.configApplied).toBe(true);
      const dstConfig = JSON.parse(readFileSync(join(dstDir, 'config.json'), 'utf-8')) as Record<string, unknown>;
      expect(dstConfig['default_tier']).toBe('opus');
      expect(dstConfig['thinking_mode']).toBe(true);
      expect(dstConfig['api_key']).toBeUndefined();
      expect(dstConfig['provider']).toBeUndefined();

      // Cleanup
      importer.cleanup();
    });

    it('handles empty installation gracefully', () => {
      const exporter = new MigrationExporter({ lynoxDir: srcDir, vaultKey: SRC_VAULT_KEY });
      const importer = new MigrationImporter({ lynoxDir: dstDir, vaultKey: DST_VAULT_KEY, httpSecret: HTTP_SECRET });

      const { clientTransferKey } = performHandshake(importer);
      const { manifest, chunks } = exporter.export(clientTransferKey);

      expect(manifest.totalChunks).toBe(0);
      expect(chunks.length).toBe(0);

      // No chunks to receive — but manifest should still verify
      importer.setManifest(manifest);
      expect(importer.isComplete()).toBe(true);

      const verification = importer.restore();
      expect(verification.secretsImported).toBe(0);
      expect(verification.databasesRestored).toEqual([]);
      expect(verification.artifactsImported).toBe(0);
      expect(verification.configApplied).toBe(false);

      importer.cleanup();
    });

    it('merges config into existing destination config', () => {
      createTestConfig(srcDir, { default_tier: 'opus', effort_level: 'high' });
      createTestConfig(dstDir, { plugins: ['test'], default_tier: 'haiku' });

      const exporter = new MigrationExporter({ lynoxDir: srcDir, vaultKey: SRC_VAULT_KEY });
      const importer = new MigrationImporter({ lynoxDir: dstDir, vaultKey: DST_VAULT_KEY, httpSecret: HTTP_SECRET });

      const { clientTransferKey } = performHandshake(importer);
      const { manifest, chunks } = exporter.export(clientTransferKey);
      importer.setManifest(manifest);
      for (const chunk of chunks) importer.receiveChunk(chunk);
      importer.restore();

      const dstConfig = JSON.parse(readFileSync(join(dstDir, 'config.json'), 'utf-8')) as Record<string, unknown>;
      expect(dstConfig['default_tier']).toBe('opus');      // overwritten by import
      expect(dstConfig['effort_level']).toBe('high');       // new from import
      expect(dstConfig['plugins']).toEqual(['test']);        // preserved from existing

      importer.cleanup();
    });
  });

  // ── Security: Tamper Detection ──

  describe('tamper detection', () => {
    function setupMigration(): {
      exporter: MigrationExporter;
      importer: MigrationImporter;
      clientTransferKey: Buffer;
    } {
      createTestVault(srcDir, SRC_VAULT_KEY, [{ name: 'SECRET', value: 'sensitive' }]);
      createTestDatabase(srcDir, 'history.db', [{ id: 1, text: 'data' }]);

      const exporter = new MigrationExporter({ lynoxDir: srcDir, vaultKey: SRC_VAULT_KEY });
      const importer = new MigrationImporter({ lynoxDir: dstDir, vaultKey: DST_VAULT_KEY, httpSecret: HTTP_SECRET });

      const { clientTransferKey } = performHandshake(importer);
      return { exporter, importer, clientTransferKey };
    }

    it('rejects tampered manifest hash', () => {
      const { exporter, importer, clientTransferKey } = setupMigration();
      const { manifest } = exporter.export(clientTransferKey);

      manifest.manifestHash = 'ff'.repeat(32);
      expect(() => importer.setManifest(manifest)).toThrow('Manifest hash verification failed');

      importer.cleanup();
    });

    it('rejects tampered chunk data', () => {
      const { exporter, importer, clientTransferKey } = setupMigration();
      const { manifest, chunks } = exporter.export(clientTransferKey);

      importer.setManifest(manifest);

      // Tamper with first chunk's ciphertext
      const tampered = { ...chunks[0]! };
      const dataBytes = Buffer.from(tampered.data, 'base64');
      if (dataBytes.length > 0) dataBytes[0] = (dataBytes[0]! + 1) % 256;
      tampered.data = dataBytes.toString('base64');

      expect(() => importer.receiveChunk(tampered)).toThrow();

      importer.cleanup();
    });

    it('rejects duplicate chunks', () => {
      const { exporter, importer, clientTransferKey } = setupMigration();
      const { manifest, chunks } = exporter.export(clientTransferKey);

      importer.setManifest(manifest);
      importer.receiveChunk(chunks[0]!);

      expect(() => importer.receiveChunk(chunks[0]!)).toThrow('Duplicate chunk');

      importer.cleanup();
    });

    it('rejects out-of-range chunk seq', () => {
      const { exporter, importer, clientTransferKey } = setupMigration();
      const { manifest, chunks } = exporter.export(clientTransferKey);

      importer.setManifest(manifest);

      const outOfRange = { ...chunks[0]!, seq: 999 };
      expect(() => importer.receiveChunk(outOfRange)).toThrow('Invalid chunk seq');

      importer.cleanup();
    });

    it('rejects chunk with wrong transfer key (MITM)', () => {
      createTestVault(srcDir, SRC_VAULT_KEY, [{ name: 'SECRET', value: 'value' }]);
      const exporter = new MigrationExporter({ lynoxDir: srcDir, vaultKey: SRC_VAULT_KEY });
      const importer = new MigrationImporter({ lynoxDir: dstDir, vaultKey: DST_VAULT_KEY, httpSecret: HTTP_SECRET });

      const { clientTransferKey } = performHandshake(importer);

      // Attacker encrypts with a different key
      const attackerKey = randomBytes(32);
      const { manifest, chunks } = exporter.export(attackerKey);

      importer.setManifest(manifest);

      // Chunks encrypted with attacker key can't be decrypted with the real transfer key
      expect(() => importer.receiveChunk(chunks[0]!)).toThrow();

      importer.cleanup();
    });
  });

  // ── Hardening: DoS + Path Traversal Prevention ──

  describe('hardening', () => {
    it('rejects manifest with too many chunks', () => {
      const importer = new MigrationImporter({ lynoxDir: dstDir, vaultKey: DST_VAULT_KEY, httpSecret: HTTP_SECRET });
      performHandshake(importer);

      const chunks = Array.from({ length: 100 }, (_, i) => ({
        seq: i, type: 'sqlite_db' as const, name: 'history.db', originalSize: 100, checksum: 'abc',
      }));
      const base = { version: 1 as const, exportedAt: '', lynoxVersion: '', totalChunks: 100, chunks };
      const manifestHash = computeManifestHash(base);
      const manifest = { ...base, manifestHash };

      expect(() => importer.setManifest(manifest)).toThrow('Too many chunks');
      importer.cleanup();
    });

    it('rejects manifest with disallowed database name', () => {
      const importer = new MigrationImporter({ lynoxDir: dstDir, vaultKey: DST_VAULT_KEY, httpSecret: HTTP_SECRET });
      performHandshake(importer);

      const chunks = [{ seq: 0, type: 'sqlite_db' as const, name: '../../etc/passwd', originalSize: 100, checksum: 'abc' }];
      const base = { version: 1 as const, exportedAt: '', lynoxVersion: '', totalChunks: 1, chunks };
      const manifestHash = computeManifestHash(base);
      const manifest = { ...base, manifestHash };

      expect(() => importer.setManifest(manifest)).toThrow('Disallowed database name');
      importer.cleanup();
    });

    it('rejects manifest with excessive total size', () => {
      const importer = new MigrationImporter({ lynoxDir: dstDir, vaultKey: DST_VAULT_KEY, httpSecret: HTTP_SECRET });
      performHandshake(importer);

      const chunks = [{ seq: 0, type: 'sqlite_db' as const, name: 'history.db', originalSize: 600 * 1024 * 1024, checksum: 'abc' }];
      const base = { version: 1 as const, exportedAt: '', lynoxVersion: '', totalChunks: 1, chunks };
      const manifestHash = computeManifestHash(base);
      const manifest = { ...base, manifestHash };

      expect(() => importer.setManifest(manifest)).toThrow('Total data size exceeds limit');
      importer.cleanup();
    });

    it('config import re-validates allowlist (defense-in-depth)', () => {
      // Even if exporter is compromised and sends dangerous fields,
      // the importer should filter them out
      createTestConfig(srcDir, {
        default_tier: 'sonnet',
        api_key: 'INJECTED_KEY', // should be blocked by exporter AND importer
      });

      const exporter = new MigrationExporter({ lynoxDir: srcDir, vaultKey: SRC_VAULT_KEY });
      const importer = new MigrationImporter({ lynoxDir: dstDir, vaultKey: DST_VAULT_KEY, httpSecret: HTTP_SECRET });
      const { clientTransferKey } = performHandshake(importer);
      const { manifest, chunks } = exporter.export(clientTransferKey);
      importer.setManifest(manifest);
      for (const chunk of chunks) importer.receiveChunk(chunk);
      importer.restore();

      const config = JSON.parse(readFileSync(join(dstDir, 'config.json'), 'utf-8')) as Record<string, unknown>;
      expect(config['default_tier']).toBe('sonnet');
      expect(config['api_key']).toBeUndefined(); // blocked by both exporter and importer
      importer.cleanup();
    });
  });

  // ── Protocol State Machine ──

  describe('protocol state machine', () => {
    it('rejects manifest before handshake', () => {
      const importer = new MigrationImporter({ lynoxDir: dstDir, vaultKey: DST_VAULT_KEY, httpSecret: HTTP_SECRET });

      const manifest = {
        version: 1 as const,
        exportedAt: '',
        lynoxVersion: '',
        manifestHash: '',
        totalChunks: 0,
        chunks: [],
      };

      expect(() => importer.setManifest(manifest)).toThrow('Handshake not completed');
    });

    it('rejects chunk before manifest', () => {
      const importer = new MigrationImporter({ lynoxDir: dstDir, vaultKey: DST_VAULT_KEY, httpSecret: HTTP_SECRET });
      importer.startHandshake();

      expect(() => importer.receiveChunk({ seq: 0, iv: '', authTag: '', data: '' })).toThrow('Handshake and manifest required');

      importer.cleanup();
    });

    it('rejects restore before all chunks received', () => {
      createTestDatabase(srcDir, 'history.db', [{ id: 1, text: 'data' }]);
      const exporter = new MigrationExporter({ lynoxDir: srcDir, vaultKey: SRC_VAULT_KEY });
      const importer = new MigrationImporter({ lynoxDir: dstDir, vaultKey: DST_VAULT_KEY, httpSecret: HTTP_SECRET });

      const { clientTransferKey } = performHandshake(importer);
      const { manifest, chunks } = exporter.export(clientTransferKey);

      importer.setManifest(manifest);
      // Only receive first chunk, not all
      if (chunks.length > 1) {
        importer.receiveChunk(chunks[0]!);
        expect(importer.isComplete()).toBe(false);
        expect(() => importer.restore()).toThrow('not all chunks received');
      }

      importer.cleanup();
    });

    it('rejects double handshake', () => {
      const importer = new MigrationImporter({ lynoxDir: dstDir, vaultKey: DST_VAULT_KEY, httpSecret: HTTP_SECRET });
      importer.startHandshake();

      expect(() => importer.startHandshake()).toThrow('already active');

      importer.cleanup();
    });

    it('rejects double completeHandshake', () => {
      const importer = new MigrationImporter({ lynoxDir: dstDir, vaultKey: DST_VAULT_KEY, httpSecret: HTTP_SECRET });
      importer.startHandshake();

      const clientKp = generateEphemeralKeypair();
      importer.completeHandshake(serializePublicKey(clientKp.publicKey));

      expect(() => importer.completeHandshake(serializePublicKey(clientKp.publicKey))).toThrow('already completed');

      importer.cleanup();
    });

    it('cleanup resets session and allows new handshake', () => {
      const importer = new MigrationImporter({ lynoxDir: dstDir, vaultKey: DST_VAULT_KEY, httpSecret: HTTP_SECRET });
      importer.startHandshake();
      expect(importer.isActive).toBe(true);

      importer.cleanup();
      expect(importer.isActive).toBe(false);

      // Should be able to start a new session
      const payload = importer.startHandshake();
      expect(payload.serverPubKey).toBeDefined();

      importer.cleanup();
    });
  });

  // ── Secret Security ──

  describe('secret security', () => {
    it('re-encrypts secrets with destination vault key', () => {
      createTestVault(srcDir, SRC_VAULT_KEY, [
        { name: 'SENSITIVE_KEY', value: 'super-secret-value-12345' },
      ]);

      const exporter = new MigrationExporter({ lynoxDir: srcDir, vaultKey: SRC_VAULT_KEY });
      const importer = new MigrationImporter({ lynoxDir: dstDir, vaultKey: DST_VAULT_KEY, httpSecret: HTTP_SECRET });

      const { clientTransferKey } = performHandshake(importer);
      const { manifest, chunks } = exporter.export(clientTransferKey);
      importer.setManifest(manifest);
      for (const chunk of chunks) importer.receiveChunk(chunk);
      importer.restore();

      // Secret is readable with destination key
      const dstVault = new SecretVault({ path: join(dstDir, 'vault.db'), masterKey: DST_VAULT_KEY });
      expect(dstVault.get('SENSITIVE_KEY')).toBe('super-secret-value-12345');
      dstVault.close();

      // Secret is NOT readable with source key (different PBKDF2 salt)
      // Suppress expected stderr warning about decryption failure
      const origWrite = process.stderr.write;
      process.stderr.write = (() => true) as typeof process.stderr.write;
      try {
        const wrongVault = new SecretVault({ path: join(dstDir, 'vault.db'), masterKey: SRC_VAULT_KEY });
        expect(wrongVault.get('SENSITIVE_KEY')).toBeNull();
        wrongVault.close();
      } finally {
        process.stderr.write = origWrite;
      }

      importer.cleanup();
    });

    it('config never includes credentials', () => {
      createTestConfig(srcDir, {
        api_key: 'sk-ant-SHOULD-NOT-MIGRATE',
        provider: 'anthropic',
        default_tier: 'sonnet',
        aws_region: 'eu-central-1',
        max_session_cost_usd: 5,
      });

      const exporter = new MigrationExporter({ lynoxDir: srcDir, vaultKey: SRC_VAULT_KEY });
      const importer = new MigrationImporter({ lynoxDir: dstDir, vaultKey: DST_VAULT_KEY, httpSecret: HTTP_SECRET });

      const { clientTransferKey } = performHandshake(importer);
      const { manifest, chunks } = exporter.export(clientTransferKey);
      importer.setManifest(manifest);
      for (const chunk of chunks) importer.receiveChunk(chunk);
      importer.restore();

      const dstConfig = JSON.parse(readFileSync(join(dstDir, 'config.json'), 'utf-8')) as Record<string, unknown>;
      expect(dstConfig['api_key']).toBeUndefined();
      expect(dstConfig['provider']).toBeUndefined();
      expect(dstConfig['aws_region']).toBeUndefined();
      expect(dstConfig['default_tier']).toBe('sonnet');
      expect(dstConfig['max_session_cost_usd']).toBe(5);

      importer.cleanup();
    });
  });
});
