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

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, lstatSync, readdirSync } from 'node:fs';
import { join, resolve, sep, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { getLynoxDir } from './config.js';
import { readEnvAlias } from './env.js';
import { ApiStore } from './api-store.js';
import { SecretVault } from './secret-vault.js';
import { parsePortableMemoryKey, trimMemoryContent } from './memory-file.js';
import { isMergeLedgerFileName } from './subject-merge-runner.js';
import { MIGRATE_SQLITE_DBS, GENERIC_PORTABLE_DIRS, isPortableDirEntryName, MAX_PORTABLE_DIR_BYTES, MAX_PORTABLE_DIR_ENTRIES } from './data-dir-inventory.js';
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
  memoryFilesImported: number;
  /** Merge ledgers restored — the reversal records `rollbackMergeRun` consumes. */
  mergeLedgersImported: number;
  /** Files restored into the generic portable directories (`apis/`, `workspace/`). */
  portableDirFilesImported: number;
  configApplied: boolean;
}

/** `name` or `name:partN` → the part index; `0` when the payload was not split. */
function partNumber(chunkName: string): number {
  const idx = chunkName.indexOf(':part');
  if (idx === -1) return 0;
  const n = parseInt(chunkName.slice(idx + ':part'.length), 10);
  return Number.isFinite(n) ? n : 0;
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

/**
 * Ceiling for the reassembled flat-file memory bundle. A legitimate tree is
 * `scopeDirs × 4 namespaces × MAX_MEMORY_FILE_BYTES`, so this allows 64 scopes.
 */
const MAX_MEMORY_BUNDLE_BYTES = 64 * 1024 * 1024;
/**
 * Ledger COUNT cap. One merge writes one ledger, so this is generous for a real instance
 * and still bounds the file/inode blast radius the byte cap alone leaves open.
 */
const MAX_MERGE_LEDGERS = 50_000;

/** Whitelist of allowed database file names — prevents path traversal via crafted manifests.
 *  engine.db (Foundation Rework v2 subject-graph) is portable user data — mirrors the export set. */
// DERIVED — the importer's whitelist is the exporter's set, so a database can never be
// shipped by one side and refused by the other.
const ALLOWED_DB_NAMES = new Set<string>(MIGRATE_SQLITE_DBS);

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
  private session: MigrationSession | null = null;

  constructor(options: {
    lynoxDir?: string | undefined;
    vaultKey: string;
  }) {
    this.lynoxDir = options.lynoxDir ?? getLynoxDir();
    this.vaultKey = options.vaultKey;
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
   * Signature is keyed off the per-session migration token, which both sides
   * hold after the bootstrap. Binding the signature to this shared secret
   * lets the client detect a substituted server public key (MITM).
   *
   * @param migrationToken - 64-hex-char migration token verified by the caller
   * @returns Payload to send to the client
   * @throws If a session is already active
   */
  startHandshake(migrationToken: string): HandshakeServerPayload {
    if (this.isActive) {
      throw new Error('Migration session already active. Finalize or cleanup first.');
    }

    const keypair = generateEphemeralKeypair();
    const challengeNonce = randomBytes(32);
    const serverPubKey = serializePublicKey(keypair.publicKey);

    const signingKey = deriveSigningKey(migrationToken);
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
      memoryFilesImported: 0,
      mergeLedgersImported: 0,
      portableDirFilesImported: 0,
      configApplied: false,
    };

    // Process chunks by type in a safe order:
    // 1. Config (least critical, applied first)
    // 2. SQLite databases (core data)
    // 3. Artifacts (supplementary)
    // 4. Memory (the flat-file store the memory_* tools read)
    // 5. Secrets (most sensitive — last, so we can abort without partial secret state)

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

    // 4. Memory (flat-file store) — one call for the whole set, so a split
    // payload is reassembled once instead of last-write-wins per chunk.
    if (chunksByType.memory.length > 0) {
      onProgress?.({ phase: 'restoring', currentChunk: chunksByType.memory[0]!.meta.seq, totalChunks: manifest.totalChunks, currentName: 'memory' });
      verification.memoryFilesImported = this.restoreMemory(chunksByType.memory);
    }

    // 4b. Merge ledgers — the reversal records for `subjects_merge`. After memory and
    // before secrets: they reference subject ids that live in engine.db, already
    // restored in step 2, so a ledger landing here is usable the moment it lands.
    if (chunksByType.sweeps.length > 0) {
      onProgress?.({ phase: 'restoring', currentChunk: chunksByType.sweeps[0]!.meta.seq, totalChunks: manifest.totalChunks, currentName: 'sweeps' });
      verification.mergeLedgersImported = this.restoreSweeps(chunksByType.sweeps);
    }

    // 4c. Generic portable directories (`apis/`, `workspace/`) — opaque file trees, so
    // they carry no ordering constraint against the databases.
    // Grouped BY DIRECTORY, not per chunk. `splitIntoChunks` turns a bundle over
    // MAX_CHUNK_BYTES into `workspace:part0`, `workspace:part1`, … and handing those to
    // JSON.parse one at a time throws on the first part — uncaught, aborting the import
    // AFTER the databases have already landed. ~6 MB of files is enough to trigger it
    // (the payload is base64, so ×4/3), and `workspace/` is the agent's own file area.
    const portableByDir = new Map<string, Array<{ meta: MigrationChunkMeta; data: Buffer }>>();
    for (const c of chunksByType.portable_dir) {
      const base = c.meta.name.split(':')[0]!;
      portableByDir.set(base, [...(portableByDir.get(base) ?? []), c]);
    }
    for (const [dirName, parts] of portableByDir) {
      onProgress?.({ phase: 'restoring', currentChunk: parts[0]!.meta.seq, totalChunks: manifest.totalChunks, currentName: dirName });
      verification.portableDirFilesImported += this.restorePortableDir(parts);
    }

    // 5. Secrets (most sensitive — last)
    for (const { meta, data } of chunksByType.secrets) {
      onProgress?.({ phase: 'restoring', currentChunk: meta.seq, totalChunks: manifest.totalChunks, currentName: 'secrets' });
      verification.secretsImported = this.restoreSecrets(data);
    }

    // 6. Re-gate (MANAGED destination only): a migrated api connection's
    // custom_endpoint_ack is a per-instance BYOK-endpoint acceptance that must
    // NOT be inherited — strip it so any custom endpoint re-triggers the
    // disclosure gate before reuse (the engine.db analog of restoreConfig's
    // SAFE_CONFIG_FIELDS strip). A self-hosted import keeps the ack (same data
    // owner). Runs LAST, after data + secrets are in, so a strip failure fails
    // the import closed (the operator retries; regate is idempotent) rather than
    // dropping the secret restore. No-op unless engine.db was in the set.
    if (verification.databasesRestored.includes('engine.db') && readEnvAlias('LYNOX_BILLING_TIER')) {
      ApiStore.regateMigratedApiConnections(join(this.lynoxDir, 'engine.db'), this.vaultKey);
    }

    // 6b. The SAME re-gate for the flat `apis/*.json` profiles, which now travel too.
    // Without this the gate has a hole with a precise shape: a source from BEFORE the
    // connections cutover ships `apis/` and no `engine.db`, so the block above no-ops, the
    // destination boots with empty `connections`, `importFromDirectoryIfNeeded` reads the
    // flat JSON — and the ack rides in intact, defeating the managed BYOK-endpoint
    // disclosure gate for an operator who never saw the dialog. Same condition, same
    // reasoning, same idempotence; a self-hosted destination keeps the ack because it is
    // the same data owner.
    if (readEnvAlias('LYNOX_BILLING_TIER')) {
      const apisDir = join(this.lynoxDir, 'apis');
      if (existsSync(apisDir) && lstatSync(apisDir).isDirectory()) {
        for (const file of readdirSync(apisDir)) {
          if (!file.endsWith('.json')) continue;
          const path = join(apisDir, file);
          try {
            if (!lstatSync(path).isFile()) continue;
            const profile = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
            if (profile['custom_endpoint_ack'] === undefined) continue;
            delete profile['custom_endpoint_ack'];
            writeFileSync(path, JSON.stringify(profile, null, 2), { mode: FILE_MODE_PRIVATE });
          } catch { continue; }   // unparseable or vanished — it cannot carry an ack either
        }
      }
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
      memory: [],
      config: [],
      sweeps: [],
      portable_dir: [],
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
        .sort((a, b) => partNumber(a.meta.name) - partNumber(b.meta.name));

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
   * Restore the flat-file memory tree (`memory/<scopeDir>/<namespace>.txt`).
   *
   * Both path segments are validated independently against the shapes the
   * exporter can produce, so a hand-crafted bundle cannot write outside the
   * memory directory even before the resolved-path check below. Unrecognised
   * keys are skipped, never coerced.
   *
   * @returns the number of files written
   */
  private restoreMemory(chunks: Array<{ meta: MigrationChunkMeta; data: Buffer }>): number {
    // Reassembly + decode + parse holds several copies of the payload at once.
    // MAX_TOTAL_BYTES (500 MiB) bounds the whole transfer, not this one bundle,
    // so bound it here: a real memory tree is scopes × 4 × MAX_MEMORY_FILE_BYTES,
    // i.e. 64 MiB already allows 64 scope directories. Fail closed and loud —
    // an import that would exhaust the heap must not half-write the tree.
    const totalBytes = chunks.reduce((n, c) => n + c.data.length, 0);
    if (totalBytes > MAX_MEMORY_BUNDLE_BYTES) {
      throw new Error(
        `Memory bundle too large: ${String(totalBytes)} > ${String(MAX_MEMORY_BUNDLE_BYTES)}`,
      );
    }

    // The exporter splits an oversized bundle into `memory:partN`. Reassemble in
    // part order before parsing — a part boundary can fall mid-UTF-8-sequence,
    // so the concatenation must happen on the Buffers, never on decoded strings.
    const ordered = [...chunks].sort((a, b) => partNumber(a.meta.name) - partNumber(b.meta.name));
    const data = ordered.length === 1 ? ordered[0]!.data : Buffer.concat(ordered.map(c => c.data));

    const bundle = JSON.parse(data.toString('utf-8')) as { files: Record<string, string> };
    if (!bundle.files || typeof bundle.files !== 'object') return 0;

    const memoryDir = join(this.lynoxDir, 'memory');
    const memoryPrefix = memoryDir + sep;
    let written = 0;

    for (const [key, content] of Object.entries(bundle.files)) {
      if (typeof content !== 'string') continue;

      const parsed = parsePortableMemoryKey(key);
      if (!parsed) continue;
      const { scopeDir, fileName } = parsed;

      const scopePath = resolve(memoryDir, scopeDir);
      const filePath = resolve(scopePath, fileName);
      // Defense-in-depth: the resolved path must sit strictly inside memory/.
      // A bare startsWith(memoryDir) would also accept a sibling `memoryEVIL/`.
      if (!filePath.startsWith(memoryPrefix)) continue;

      mkdirSync(scopePath, { recursive: true, mode: DIR_MODE_PRIVATE });
      // Route through the same trim every `Memory` write uses, so a restored file
      // is never larger than one the store could have produced itself —
      // `loadScoped` reads it whole into the model's context. Parity, not a hard
      // cap: `trimMemoryContent` cannot shrink a single line, and neither can
      // `Memory`, so a one-line giant stays possible on both paths.
      writeFileSync(filePath, trimMemoryContent(content), { encoding: 'utf-8', mode: FILE_MODE_PRIVATE });
      written++;
    }

    return written;
  }

  /**
   * Restore the merge ledgers. Bounded like the memory bundle because reassembly holds
   * several copies of the payload at once.
   *
   * Deliberately NOT claimed: that throwing here leaves nothing half-written. This runs at
   * step 4b, so config, the SQLite databases and memory have already landed — a throw here
   * aborts the import with those in place. That is the pre-existing shape of `restore()`,
   * not something this step introduces, and the operator retries; the bound exists to stop
   * the heap being exhausted, not to make the import transactional.
   */
  private restoreSweeps(chunks: Array<{ meta: MigrationChunkMeta; data: Buffer }>): number {
    const totalBytes = chunks.reduce((n, c) => n + c.data.length, 0);
    if (totalBytes > MAX_MEMORY_BUNDLE_BYTES) {
      throw new Error(
        `Merge-ledger bundle too large: ${String(totalBytes)} > ${String(MAX_MEMORY_BUNDLE_BYTES)}`,
      );
    }

    // A part boundary can fall mid-UTF-8-sequence, so concatenate the Buffers, never
    // decoded strings — same reason as the memory bundle.
    const ordered = [...chunks].sort((a, b) => partNumber(a.meta.name) - partNumber(b.meta.name));
    const data = ordered.length === 1 ? ordered[0]!.data : Buffer.concat(ordered.map(c => c.data));

    const bundle = JSON.parse(data.toString('utf-8')) as { files: Record<string, string> };
    if (!bundle.files || typeof bundle.files !== 'object') return 0;

    const sweepsDir = join(this.lynoxDir, 'sweeps');
    const sweepsPrefix = sweepsDir + sep;

    // A bundle arrives from another machine and its contents are attacker-shaped in the
    // threat model this importer already assumes. Two symlink shapes defeat a purely
    // lexical path check, so both are closed before anything is written:
    //   1. `sweeps/` ITSELF a symlink — `resolve()` is lexical and `mkdirSync(recursive)`
    //      no-ops on an existing link, so every ledger would land outside the data dir
    //      while `startsWith(sweepsPrefix)` still passed.
    //   2. an individual `merge-*.json` already a symlink — `writeFileSync` opens
    //      O_CREAT|O_TRUNC, which FOLLOWS, so bundle content would overwrite the target.
    if (existsSync(sweepsDir) && !lstatSync(sweepsDir).isDirectory()) {
      throw new Error('Refusing to restore merge ledgers: ~/.lynox/sweeps is not a real directory.');
    }

    // Bound the FILE COUNT, not only the bytes. A minimal entry costs ~43 bytes, so the
    // byte cap alone permits ~1.4M files — each one a separate write, and each one then
    // copied + SHA-256'd + manifested by every future backup, which would brick the
    // backup path from a single import.
    const fileCount = Object.keys(bundle.files).length;
    if (fileCount > MAX_MERGE_LEDGERS) {
      throw new Error(`Too many merge ledgers: ${String(fileCount)} > ${String(MAX_MERGE_LEDGERS)}`);
    }

    let written = 0;

    for (const [fileName, content] of Object.entries(bundle.files)) {
      if (typeof content !== 'string') continue;
      // The writer's own name shape, which admits a basename only — so a crafted
      // bundle cannot smuggle `../` or an absolute path through this key.
      if (!isMergeLedgerFileName(fileName)) continue;

      // The filename says "merge ledger"; that is not evidence the payload is one. The
      // export doc-comment claims sweep/archive ledgers are deliberately not carried, and
      // enforcing that on the NAME alone leaves a `phase: 'archive'` body importable under
      // a `merge-*.json` name — which `subject-sweep --rollback` then dispatches on by
      // name. Cheap to close, so close it.
      let parsed: unknown;
      try { parsed = JSON.parse(content); } catch { continue; }
      const led = parsed as { version?: unknown; phase?: unknown };
      if (led?.version !== 1 || led.phase !== 'merge') continue;

      const filePath = resolve(sweepsDir, fileName);
      // Defense-in-depth, exactly as the memory restore does it: the resolved path must
      // sit strictly inside sweeps/. A bare startsWith would also accept `sweepsEVIL/`.
      if (!filePath.startsWith(sweepsPrefix)) continue;

      mkdirSync(sweepsDir, { recursive: true, mode: DIR_MODE_PRIVATE });
      // Drop any existing entry rather than truncating it: `writeFileSync` follows a
      // symlink, so writing onto one would put bundle content into its target. unlink
      // removes the LINK, and 'wx' then refuses to follow anything raced in afterwards.
      try { unlinkSync(filePath); } catch { /* not there — the normal case */ }
      writeFileSync(filePath, content, { encoding: 'utf-8', mode: FILE_MODE_PRIVATE, flag: 'wx' });
      written++;
    }

    return written;
  }

  /**
   * Restore one generic portable directory. Every guard the sweeps restore earned from an
   * adversarial round applies here too, for the same reasons: the bundle comes from another
   * machine, `writeFileSync` follows symlinks, `resolve()` is purely lexical, and
   * `mkdirSync(recursive)` no-ops on an existing link.
   */
  private restorePortableDir(chunks: Array<{ meta: MigrationChunkMeta; data: Buffer }>): number {
    // Sum the REASSEMBLED payload, not individual chunks: `encryptChunk` already caps each
    // chunk at MAX_CHUNK_BYTES, so a per-chunk sum could never reach this limit — the check
    // was unreachable. The bundle is base64, so the ceiling is expressed on the encoded
    // size the importer actually holds in memory.
    const totalBytes = chunks.reduce((n, c) => n + c.data.length, 0);
    if (totalBytes > MAX_PORTABLE_DIR_BYTES * 2) {
      throw new Error(`Portable directory bundle too large: ${String(totalBytes)} > ${String(MAX_PORTABLE_DIR_BYTES * 2)}`);
    }
    const ordered = [...chunks].sort((a, b) => partNumber(a.meta.name) - partNumber(b.meta.name));
    const data = ordered.length === 1 ? ordered[0]!.data : Buffer.concat(ordered.map(c => c.data));

    const bundle = JSON.parse(data.toString('utf-8')) as { dir?: unknown; files?: Record<string, string> };
    // The directory name comes from the bundle, so it is attacker-shaped: accept only the
    // ones this build declares portable, never whatever the payload asks for.
    if (typeof bundle.dir !== 'string' || !GENERIC_PORTABLE_DIRS.includes(bundle.dir)) return 0;
    if (!bundle.files || typeof bundle.files !== 'object') return 0;

    const entries = Object.entries(bundle.files);
    if (entries.length > MAX_PORTABLE_DIR_ENTRIES) {
      throw new Error(`Too many entries in ${bundle.dir}: ${String(entries.length)} > ${String(MAX_PORTABLE_DIR_ENTRIES)}`);
    }

    const root = join(this.lynoxDir, bundle.dir);
    const rootPrefix = root + sep;
    if (existsSync(root) && !lstatSync(root).isDirectory()) {
      throw new Error(`Refusing to restore ${bundle.dir}: it is not a real directory.`);
    }

    // The root itself, once — the per-segment walk below deliberately does NOT use
    // `recursive`, so it cannot create a chain through a link, and therefore cannot create
    // the root either.
    mkdirSync(root, { recursive: true, mode: DIR_MODE_PRIVATE });

    let written = 0;
    for (const [rel, b64] of entries) {
      if (typeof b64 !== 'string') continue;
      if (!isPortableDirEntryName(rel)) continue;

      const filePath = resolve(root, rel);
      if (!filePath.startsWith(rootPrefix)) continue;

      // EVERY ancestor, not just the immediate parent. `resolve()` is lexical and
      // `existsSync` FOLLOWS links, so checking only `dirname(filePath)` misses a link one
      // level up: with `apis/sub` a symlink, the key `sub/deeper/pwn.txt` resolves to a
      // path that still starts with the root, and `mkdirSync(recursive)` then creates
      // `deeper` THROUGH the link and the write lands outside the data dir. Entries are
      // written in object order, so an earlier entry could also plant the link the next
      // one walks through — hence the check runs per entry, not once up front.
      const segments = rel.split('/');
      let cursor = root;
      let ancestorEscape = false;
      for (const segment of segments.slice(0, -1)) {
        cursor = join(cursor, segment);
        let st;
        try { st = lstatSync(cursor); } catch { st = null; }   // absent — mkdir will create it
        if (st && !st.isDirectory()) { ancestorEscape = true; break; }
        if (!st) mkdirSync(cursor, { mode: DIR_MODE_PRIVATE });
      }
      if (ancestorEscape) continue;

      // unlink first, then 'wx': writeFileSync opens O_CREAT|O_TRUNC and FOLLOWS a symlink,
      // so writing onto one would put bundle content into its target.
      try { unlinkSync(filePath); } catch { /* not there — the normal case */ }
      try {
        writeFileSync(filePath, Buffer.from(b64, 'base64'), { mode: FILE_MODE_PRIVATE, flag: 'wx' });
      } catch { continue; } // raced, or the parent vanished
      written++;
    }
    return written;
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

