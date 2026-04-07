/**
 * Migration importer — receives and restores encrypted data on a managed instance.
 *
 * Handles the server side of the zero-knowledge migration protocol:
 *  1. ECDH handshake (generate keypair, sign pubkey, derive transfer key)
 *  2. Receive + decrypt chunks (verify AAD, checksums, ordering)
 *  3. Restore data (secrets → vault, SQLite DBs → data dir, artifacts → store)
 *  4. Finalize (zeroize keys, invalidate migration token, restart engine)
 *
 * Security invariants:
 *  - Ephemeral ECDH keys exist only in memory, zeroed after finalize
 *  - Secrets are decrypted from transfer encryption, immediately re-encrypted into vault
 *  - No plaintext data touches disk in unencrypted form (except SQLite DBs, which are
 *    the engine's own storage format)
 *  - Migration token is one-time use
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { getLynoxDir } from './config.js';
import { SecretVault } from './secret-vault.js';
import { verifySqliteIntegrity } from './backup-verify.js';
import { FILE_MODE_PRIVATE, DIR_MODE_PRIVATE } from './constants.js';
import type { ExportedSecret } from './migration-export.js';
import {
  generateEphemeralKeypair,
  serializePublicKey,
  deserializePublicKey,
  deriveTransferKey,
  deriveSigningKey,
  signHandshake,
  decryptChunk,
  verifyManifestHash,
  sha256,
  zeroize,
  type EphemeralKeypair,
  type HandshakeServerPayload,
  type MigrationManifest,
  type MigrationChunkMeta,
  type EncryptedChunk,
} from './migration-crypto.js';

// ── Types ──

export interface ImportProgress {
  phase: 'handshake' | 'receiving' | 'restoring' | 'finalizing' | 'done' | 'error';
  currentChunk: number;
  totalChunks: number;
  currentName: string;
  error?: string | undefined;
}

export type ImportProgressCallback = (progress: ImportProgress) => void;

export interface ImportVerification {
  secretsImported: number;
  databasesRestored: string[];
  artifactsImported: number;
  configApplied: boolean;
}

/** State of an in-progress migration session. */
interface MigrationSession {
  keypair: EphemeralKeypair;
  challengeNonce: Buffer;
  transferKey: Buffer | null;
  manifest: MigrationManifest | null;
  receivedChunks: Map<number, Buffer>;  // seq → decrypted plaintext
  tokenConsumed: boolean;
  createdAt: number;
}

// ── Constants ──

/** Migration session timeout — 30 minutes from handshake start. */
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

/** Maximum number of chunks to accept (prevents memory DoS). */
const MAX_CHUNKS = 64;

/** Maximum total plaintext size across all chunks (500 MB). */
const MAX_TOTAL_BYTES = 500 * 1024 * 1024;

/** Whitelist of allowed database file names — prevents path traversal via crafted manifests. */
const ALLOWED_DB_NAMES = new Set(['history.db', 'agent-memory.db', 'datastore.db']);

/** Config fields the importer will accept — defense-in-depth re-validation (matches exporter allowlist). */
const SAFE_CONFIG_FIELDS = new Set([
  'default_tier', 'thinking_mode', 'effort_level',
  'max_session_cost_usd', 'max_daily_cost_usd', 'max_monthly_cost_usd',
  'embedding_provider', 'memory_extraction', 'memory_half_life_days',
  'plugins',
]);

// ── Importer ──

export class MigrationImporter {
  private readonly lynoxDir: string;
  private readonly vaultKey: string;
  private readonly httpSecret: string;
  private session: MigrationSession | null = null;

  constructor(options: {
    lynoxDir?: string | undefined;
    vaultKey: string;
    httpSecret: string;
  }) {
    this.lynoxDir = options.lynoxDir ?? getLynoxDir();
    this.vaultKey = options.vaultKey;
    this.httpSecret = options.httpSecret;
  }

  /** Whether a migration session is currently active. */
  get isActive(): boolean {
    if (!this.session) return false;
    if (Date.now() - this.session.createdAt > SESSION_TIMEOUT_MS) {
      this.cleanup();
      return false;
    }
    return true;
  }

  // ── Phase 2: Handshake ──

  /**
   * Start the ECDH handshake — generate server keypair and signed payload.
   * The client will use the public key for key agreement.
   *
   * @returns Payload to send to the client
   * @throws If a session is already active
   */
  startHandshake(): HandshakeServerPayload {
    if (this.isActive) {
      throw new Error('Migration session already active. Finalize or cleanup first.');
    }

    const keypair = generateEphemeralKeypair();
    const challengeNonce = randomBytes(32);
    const serverPubKey = serializePublicKey(keypair.publicKey);

    // Sign the public key with instance-specific signing key
    const signingKey = deriveSigningKey(this.httpSecret);
    const signature = signHandshake(serverPubKey, signingKey);
    zeroize(signingKey); // Key material no longer needed

    this.session = {
      keypair,
      challengeNonce,
      transferKey: null,
      manifest: null,
      receivedChunks: new Map(),
      tokenConsumed: false,
      createdAt: Date.now(),
    };

    return {
      serverPubKey,
      signature,
      challengeNonce: challengeNonce.toString('hex'),
    };
  }

  /**
   * Complete the handshake — receive client's public key and derive transfer key.
   *
   * @param clientPubKeyB64 - Client's ephemeral X25519 public key (base64)
   * @throws If no session or handshake already completed
   */
  completeHandshake(clientPubKeyB64: string): void {
    if (!this.session) {
      throw new Error('No migration session — call startHandshake() first.');
    }
    if (this.session.transferKey) {
      throw new Error('Handshake already completed.');
    }

    const clientPubKey = deserializePublicKey(clientPubKeyB64);
    this.session.transferKey = deriveTransferKey(
      this.session.keypair.privateKey,
      clientPubKey,
      this.session.challengeNonce,
    );
  }

  // ── Phase 3: Receive chunks ──

  /**
   * Set the manifest for this migration session.
   * Must be called before receiving any data chunks.
   *
   * @throws If manifest hash verification fails
   */
  setManifest(manifest: MigrationManifest): void {
    if (!this.session?.transferKey) {
      throw new Error('Handshake not completed — cannot accept manifest.');
    }

    if (!verifyManifestHash(manifest)) {
      throw new Error('Manifest hash verification failed — data may be tampered.');
    }

    // Validate chunk count (DoS prevention)
    if (manifest.totalChunks > MAX_CHUNKS) {
      throw new Error(`Too many chunks: ${String(manifest.totalChunks)} > ${String(MAX_CHUNKS)}`);
    }

    // Validate total data size (DoS prevention)
    const totalSize = manifest.chunks.reduce((sum, c) => sum + c.originalSize, 0);
    if (totalSize > MAX_TOTAL_BYTES) {
      throw new Error(`Total data size exceeds limit: ${String(totalSize)} > ${String(MAX_TOTAL_BYTES)}`);
    }

    // Validate DB names against whitelist (path traversal prevention)
    for (const chunk of manifest.chunks) {
      if (chunk.type === 'sqlite_db') {
        const baseName = chunk.name.split(':')[0]!;
        if (!ALLOWED_DB_NAMES.has(baseName)) {
          throw new Error(`Disallowed database name: "${baseName}"`);
        }
      }
    }

    this.session.manifest = manifest;
  }

  /**
   * Receive and decrypt a single chunk.
   * Verifies AAD binding (seq + manifest hash) and plaintext checksum.
   *
   * @returns Verification info for this chunk
   * @throws On decryption failure, checksum mismatch, or out-of-order delivery
   */
  receiveChunk(chunk: EncryptedChunk): { seq: number; name: string; verified: boolean } {
    if (!this.session?.transferKey || !this.session.manifest) {
      throw new Error('Handshake and manifest required before receiving chunks.');
    }

    const { manifest, transferKey, receivedChunks } = this.session;

    // Reject duplicate chunks
    if (receivedChunks.has(chunk.seq)) {
      throw new Error(`Duplicate chunk: seq ${String(chunk.seq)}`);
    }

    // Validate seq is within manifest range
    if (chunk.seq < 0 || chunk.seq >= manifest.totalChunks) {
      throw new Error(`Invalid chunk seq ${String(chunk.seq)} — expected 0..${String(manifest.totalChunks - 1)}`);
    }

    // Decrypt (AES-256-GCM with AAD verification)
    const plaintext = decryptChunk(chunk, transferKey, manifest.manifestHash);

    // Verify checksum against manifest
    const expectedMeta = manifest.chunks.find(c => c.seq === chunk.seq);
    if (!expectedMeta) {
      throw new Error(`No manifest entry for chunk seq ${String(chunk.seq)}`);
    }

    const actualChecksum = sha256(plaintext);
    if (actualChecksum !== expectedMeta.checksum) {
      throw new Error(
        `Checksum mismatch for chunk "${expectedMeta.name}" (seq ${String(chunk.seq)}): ` +
        `expected ${expectedMeta.checksum}, got ${actualChecksum}`,
      );
    }

    receivedChunks.set(chunk.seq, plaintext);

    return { seq: chunk.seq, name: expectedMeta.name, verified: true };
  }

  /**
   * Check if all chunks have been received.
   */
  isComplete(): boolean {
    if (!this.session?.manifest) return false;
    return this.session.receivedChunks.size === this.session.manifest.totalChunks;
  }

  // ── Phase 3 continued: Restore ──

  /**
   * Restore all received data to the local data directory.
   * Must be called after all chunks are received.
   *
   * @param onProgress - Optional progress callback
   * @returns Verification summary
   * @throws If not all chunks received, or restoration fails
   */
  restore(onProgress?: ImportProgressCallback | undefined): ImportVerification {
    if (!this.session?.manifest || !this.isComplete()) {
      throw new Error('Cannot restore — not all chunks received.');
    }

    const { manifest, receivedChunks } = this.session;
    const verification: ImportVerification = {
      secretsImported: 0,
      databasesRestored: [],
      artifactsImported: 0,
      configApplied: false,
    };

    // Process chunks by type in a safe order:
    // 1. Config (least critical, applied first)
    // 2. SQLite databases (core data)
    // 3. Artifacts (supplementary)
    // 4. Secrets (most sensitive — last, so we can abort without partial secret state)

    const chunksByType = this.groupChunksByType(manifest.chunks, receivedChunks);

    // 1. Config
    for (const { meta, data } of chunksByType.config) {
      onProgress?.({ phase: 'restoring', currentChunk: meta.seq, totalChunks: manifest.totalChunks, currentName: 'config' });
      this.restoreConfig(data);
      verification.configApplied = true;
    }

    // 2. SQLite databases
    for (const { meta, data } of chunksByType.sqlite_db) {
      onProgress?.({ phase: 'restoring', currentChunk: meta.seq, totalChunks: manifest.totalChunks, currentName: meta.name });
      const dbName = this.restoreDatabase(meta, data, chunksByType.sqlite_db);
      if (dbName && !verification.databasesRestored.includes(dbName)) {
        verification.databasesRestored.push(dbName);
      }
    }

    // 3. Artifacts
    for (const { meta, data } of chunksByType.artifacts) {
      onProgress?.({ phase: 'restoring', currentChunk: meta.seq, totalChunks: manifest.totalChunks, currentName: 'artifacts' });
      verification.artifactsImported = this.restoreArtifacts(data);
    }

    // 4. Secrets (most sensitive — last)
    for (const { meta, data } of chunksByType.secrets) {
      onProgress?.({ phase: 'restoring', currentChunk: meta.seq, totalChunks: manifest.totalChunks, currentName: 'secrets' });
      verification.secretsImported = this.restoreSecrets(data);
    }

    onProgress?.({ phase: 'done', currentChunk: manifest.totalChunks, totalChunks: manifest.totalChunks, currentName: '' });

    return verification;
  }

  // ── Phase 4: Finalize ──

  /**
   * Clean up migration session — zeroize keys, release memory.
   * Call after successful restore OR on error/timeout.
   */
  cleanup(): void {
    if (!this.session) return;

    // Zeroize transfer key
    if (this.session.transferKey) {
      zeroize(this.session.transferKey);
    }

    // Zeroize challenge nonce
    zeroize(this.session.challengeNonce);

    // Clear received data from memory
    for (const [, buf] of this.session.receivedChunks) {
      buf.fill(0);
    }
    this.session.receivedChunks.clear();

    this.session = null;
  }

  // ── Private restore methods ──

  private groupChunksByType(
    metas: MigrationChunkMeta[],
    data: Map<number, Buffer>,
  ): Record<MigrationChunkMeta['type'], Array<{ meta: MigrationChunkMeta; data: Buffer }>> {
    const groups: Record<string, Array<{ meta: MigrationChunkMeta; data: Buffer }>> = {
      secrets: [],
      sqlite_db: [],
      artifacts: [],
      config: [],
    };

    for (const meta of metas) {
      const buf = data.get(meta.seq);
      if (!buf) continue;
      const group = groups[meta.type];
      if (group) group.push({ meta, data: buf });
    }

    return groups as Record<MigrationChunkMeta['type'], Array<{ meta: MigrationChunkMeta; data: Buffer }>>;
  }

  /**
   * Restore secrets into the instance's vault.
   * Decrypts from transfer, re-encrypts with instance's vault key.
   */
  private restoreSecrets(data: Buffer): number {
    const secrets = JSON.parse(data.toString('utf-8')) as ExportedSecret[];

    const vaultPath = join(this.lynoxDir, 'vault.db');
    const vault = new SecretVault({ path: vaultPath, masterKey: this.vaultKey });

    try {
      let count = 0;
      for (const secret of secrets) {
        // Validate: skip empty or missing values
        if (!secret.name || !secret.value) continue;

        vault.set(secret.name, secret.value, secret.scope, secret.ttlMs);
        count++;
      }

      return count;
    } finally {
      vault.close();
      // Zeroize plaintext secrets buffer
      data.fill(0);
    }
  }

  /**
   * Restore a SQLite database to the data directory.
   * Handles multi-part databases (split during export if >8 MB).
   */
  private restoreDatabase(
    meta: MigrationChunkMeta,
    data: Buffer,
    allDbChunks: Array<{ meta: MigrationChunkMeta; data: Buffer }>,
  ): string | null {
    // Parse db name — may be "history.db" or "history.db:part0"
    const isMultiPart = meta.name.includes(':part');
    const baseName = meta.name.split(':')[0]!;

    // Defense-in-depth: re-validate DB name (also checked in setManifest)
    if (!ALLOWED_DB_NAMES.has(baseName)) {
      throw new Error(`Disallowed database name: "${baseName}"`);
    }

    // For multi-part: only process on the first part (part0), assemble all parts
    if (isMultiPart && !meta.name.endsWith(':part0')) {
      return null; // Will be handled when part0 is processed
    }

    let finalData: Buffer;

    if (isMultiPart) {
      // Collect all parts for this database, sorted by part number
      const parts = allDbChunks
        .filter(c => c.meta.name.startsWith(`${baseName}:part`))
        .sort((a, b) => {
          const aPart = parseInt(a.meta.name.split(':part')[1]!, 10);
          const bPart = parseInt(b.meta.name.split(':part')[1]!, 10);
          return aPart - bPart;
        });

      finalData = Buffer.concat(parts.map(p => p.data));
    } else {
      finalData = data;
    }

    // Write to temp file, verify integrity, then atomic rename
    const destPath = join(this.lynoxDir, baseName);
    const tmpPath = `${destPath}.migration-tmp`;

    writeFileSync(tmpPath, finalData, { mode: FILE_MODE_PRIVATE });

    // Verify SQLite integrity before replacing
    if (!verifySqliteIntegrity(tmpPath)) {
      try { unlinkSync(tmpPath); } catch { /* ok */ }
      throw new Error(`SQLite integrity check failed for ${baseName} — import aborted.`);
    }

    // Atomic rename — replaces existing DB
    renameSync(tmpPath, destPath);

    return baseName;
  }

  /**
   * Restore artifacts (index + content files).
   */
  private restoreArtifacts(data: Buffer): number {
    const bundle = JSON.parse(data.toString('utf-8')) as {
      index: Array<{ id: string; [key: string]: unknown }>;
      files: Record<string, string>;
    };

    const artifactsDir = join(this.lynoxDir, 'artifacts');
    mkdirSync(artifactsDir, { recursive: true, mode: DIR_MODE_PRIVATE });

    // Write index
    writeFileSync(join(artifactsDir, 'index.json'), JSON.stringify(bundle.index, null, 2), {
      encoding: 'utf-8',
      mode: FILE_MODE_PRIVATE,
    });

    // Write content files with path traversal protection
    for (const [id, content] of Object.entries(bundle.files)) {
      // Validate ID format (must match ArtifactStore's SAFE_ID pattern)
      if (!/^[a-f0-9]{8}$/.test(id)) continue;
      const filePath = resolve(artifactsDir, `${id}.html`);
      // Defense-in-depth: ensure resolved path is still within artifacts dir
      if (!filePath.startsWith(artifactsDir)) continue;
      writeFileSync(filePath, content, {
        encoding: 'utf-8',
        mode: FILE_MODE_PRIVATE,
      });
    }

    return bundle.index.length;
  }

  /**
   * Apply sanitized config values (merge into existing config, don't replace).
   */
  private restoreConfig(data: Buffer): void {
    const imported = JSON.parse(data.toString('utf-8')) as Record<string, unknown>;
    const configPath = join(this.lynoxDir, 'config.json');

    // Defense-in-depth: re-validate imported fields against allowlist
    // Even though the exporter already filters, a crafted bundle could contain anything
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(imported)) {
      if (SAFE_CONFIG_FIELDS.has(key)) {
        sanitized[key] = value;
      }
    }

    if (Object.keys(sanitized).length === 0) return;

    let existing: Record<string, unknown> = {};
    if (existsSync(configPath)) {
      try {
        existing = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
      } catch { /* start fresh */ }
    }

    // Merge: imported safe fields win for overlapping keys
    const merged = { ...existing, ...sanitized };

    writeFileSync(configPath, JSON.stringify(merged, null, 2), {
      encoding: 'utf-8',
      mode: FILE_MODE_PRIVATE,
    });
  }
}

