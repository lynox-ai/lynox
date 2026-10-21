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

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, lstatSync, readdirSync, accessSync, constants as fsConstants } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { getLynoxDir } from './config.js';
import { readEnvAlias } from './env.js';
import { ApiStore, accessTokenKey, refreshTokenKey, type WrittenSecret } from './api-store.js';
import { isProtectedSecretWrite } from './secret-store.js';
import { tokenFingerprint } from './oauth-refresh-failure.js';
import { SecretVault } from './secret-vault.js';
import { parsePortableMemoryKey, trimMemoryContent } from './memory-file.js';
import { isMergeLedgerFileName } from './subject-merge-runner.js';
import { MIGRATE_SQLITE_DBS, GENERIC_PORTABLE_DIRS, isPortableDirEntryName, MAX_PORTABLE_DIR_BYTES, MAX_PORTABLE_DIR_ENTRIES } from './data-dir-inventory.js';
import { verifySqliteIntegrity } from './backup-verify.js';
import { FILE_MODE_PRIVATE, DIR_MODE_PRIVATE } from './constants.js';
import { isCorruptionError } from './sqlite-constants.js';
import { leaseWorkspaceFor } from './workspace-access.js';
import { removeStaleStages, stageIn, statEntry, type StageEntry } from './workspace-fd.js';
import type { ExportedSecret } from './migration-export.js';
import type { SecretScope } from '../types/index.js';
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
  type MigrationChunkType,
  type EncryptedChunk,
  MIGRATION_CHUNK_TYPES,
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
  /**
   * Workspace entries of the bundle that were not written (`workspace/...`), because a path on
   * the way is a file, a link or a directory where the bundle has a file. Absent when none.
   */
  portableDirSkipped?: string[] | undefined;
  configApplied: boolean;
  /** Store connections (Shopify) whose tokens the import removed: each has to be connected again. Absent when none. */
  reconnectStores?: string[] | undefined;
}

/** `name` or `name:partN` → the part index; `0` when the payload was not split. */
function partNumber(chunkName: string): number {
  const idx = chunkName.indexOf(':part');
  if (idx === -1) return 0;
  const n = parseInt(chunkName.slice(idx + ':part'.length), 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * A profile file's bytes without its `custom_endpoint_ack`, read as the import reads them
 * (utf-8, `JSON.parse`). What is no JSON object or carries no ack is returned as it came: the
 * import reads no ack from it either.
 */
function withoutEndpointAck(content: Buffer): Buffer {
  let profile: unknown;
  try { profile = JSON.parse(content.toString('utf-8')); } catch { return content; }
  if (typeof profile !== 'object' || profile === null || Array.isArray(profile)) return content;
  const fields = profile as Record<string, unknown>;
  if (fields['custom_endpoint_ack'] === undefined) return content;
  delete fields['custom_endpoint_ack'];
  return Buffer.from(JSON.stringify(fields, null, 2), 'utf-8');
}

/** A database of the bundle, written next to the one it replaces and checked, not yet swapped in. */
interface StagedDatabase {
  baseName: string;
  tmpPath: string;
  destPath: string;
  /** The database in place cannot be opened by SQLite; phase 2 moves it aside first. */
  unreadable: boolean;
}

/**
 * Remove a staged copy with its WAL files: the re-gate opens it read-write, and a WAL left by an
 * attempt that died would be replayed onto the next copy written under the same name.
 */
function dropStagedCopy(tmpPath: string): void {
  for (const p of [tmpPath, `${tmpPath}-wal`, `${tmpPath}-shm`]) {
    try { unlinkSync(p); } catch { /* ok */ }
  }
}

/**
 * Whether SQLite cannot read the file at `path` as a database at all (corrupt, or not a database),
 * asked read-only. Any other failure is not answered here: the read-write open after it decides.
 */
function cannotReadAsDatabase(path: string): boolean {
  let db: Database.Database | null = null;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true });
    db.pragma('schema_version');
    return false;
  } catch (err: unknown) {
    return isCorruptionError(err);
  } finally {
    try { db?.close(); } catch { /* best-effort */ }
  }
}

/**
 * Move a database SQLite cannot open aside, under the name the boot's corrupt path uses
 * (`<db>.corrupt-<ms>`, with its `-wal` and `-shm`). Only a missing `-wal` or `-shm` is passed
 * over: a `-wal` that stays would be replayed onto the copy renamed into its place.
 */
function moveAsideUnreadable(destPath: string): void {
  const corruptPath = `${destPath}.corrupt-${Date.now()}`;
  renameSync(destPath, corruptPath);
  for (const suffix of ['-wal', '-shm']) {
    try {
      renameSync(`${destPath}${suffix}`, `${corruptPath}${suffix}`);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
}

/**
 * The parts of a bundle after its databases, decoded and checked in phase 1 of the restore. The
 * steps after the swap decode no chunk bytes, they take these: a chunk that does not parse, is
 * over a bound, or has a shape `prepareRest` refuses stops the restore before any database is
 * swapped in.
 */
interface PreparedRest {
  config: Array<{ meta: MigrationChunkMeta; fields: Record<string, unknown> }>;
  artifacts: Array<{ meta: MigrationChunkMeta; index: unknown[]; files: Record<string, unknown> }>;
  /** `files` is null when the bundle carries none: nothing is written, nothing is checked. */
  memory: { meta: MigrationChunkMeta; files: Record<string, unknown> | null } | null;
  sweeps: { meta: MigrationChunkMeta; files: Record<string, unknown> | null } | null;
  portable: Array<{ meta: MigrationChunkMeta; dir: string; entries: Array<[string, unknown]> }>;
  secrets: Array<{ meta: MigrationChunkMeta; secrets: ExportedSecret[]; data: Buffer }>;
}

/** A JSON object (an array counts, as `Object.entries` takes it), or null for anything else. */
function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null;
}

/** The chunks of one part, reassembled in part order: a part boundary can fall mid-UTF-8-sequence. */
function reassemble(chunks: Array<{ meta: MigrationChunkMeta; data: Buffer }>): Buffer {
  const ordered = [...chunks].sort((a, b) => partNumber(a.meta.name) - partNumber(b.meta.name));
  return ordered.length === 1 ? ordered[0]!.data : Buffer.concat(ordered.map(c => c.data));
}

/**
 * Refuse a path that exists and is not a real directory (a link, a file). Phase 1 asks it before
 * anything is replaced; the step that writes asks it again, for what changed in between.
 */
function refuseUnlessRealDirectory(path: string, message: string): void {
  if (existsSync(path) && !lstatSync(path).isDirectory()) throw new Error(message);
}

/** The scopes the vault takes (its CHECK constraint); a secret naming another fails its insert. */
const SECRET_SCOPES = { http_header: true, http_body: true, bash_env: true, any: true } satisfies Record<SecretScope, true>;

/**
 * Step 6b over the flat `apis/*.json` profiles on the destination (managed only, see `restore`).
 * `check` runs in phase 1 and refuses what the strip could not handle, writing nothing; it passes
 * over the names in `replaced`, which step 4c replaces with the bundle's own files. `strip` runs at
 * the end and removes the ack.
 */
function regateFlatProfiles(apisDir: string, mode: 'check' | 'strip', replaced: ReadonlySet<string> = new Set()): void {
  if (!existsSync(apisDir) || !lstatSync(apisDir).isDirectory()) return;
  for (const file of readdirSync(apisDir)) {
    if (!file.endsWith('.json') || replaced.has(file)) continue;
    const path = join(apisDir, file);
    const cannot = (what: string): Error => new Error(`Refusing to finish the import: apis/${file} ${what}, so a custom endpoint acceptance it may carry cannot be removed. Remove the entry, or make it and apis/ readable and writable, then run the migration again.`);
    // A file that vanished leaves nothing to import.
    const vanished = (err: unknown): boolean => (err as NodeJS.ErrnoException).code === 'ENOENT';
    let st: ReturnType<typeof lstatSync>;
    try { st = lstatSync(path); } catch (err: unknown) {
      if (vanished(err)) continue;
      throw cannot('could not be read');
    }
    if (st.isDirectory()) continue;   // no profile; the import passes a directory over
    if (!st.isFile()) throw cannot('is not a regular file');
    let raw: string;
    try { raw = readFileSync(path, 'utf-8'); } catch (err: unknown) {
      if (vanished(err)) continue;
      throw cannot('could not be read');
    }
    let profile: Record<string, unknown>;
    try {
      profile = JSON.parse(raw) as Record<string, unknown>;
    } catch { continue; }
    if (typeof profile !== 'object' || profile === null || profile['custom_endpoint_ack'] === undefined) continue;
    if (mode === 'check') {
      try { accessSync(path, fsConstants.W_OK); } catch { throw cannot('could not be rewritten'); }
      continue;
    }
    delete profile['custom_endpoint_ack'];
    try {
      writeFileSync(path, JSON.stringify(profile, null, 2), { mode: FILE_MODE_PRIVATE });
    } catch {
      throw cannot('could not be rewritten');
    }
  }
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

/** An artifact id as ArtifactStore's SAFE_ID makes it; the restore writes `<id>.html` for no other key. */
const ARTIFACT_ID = /^[a-f0-9]{8}$/;

const SWEEPS_NOT_A_DIRECTORY = 'Refusing to restore merge ledgers: ~/.lynox/sweeps is not a real directory.';
const portableNotADirectory = (dir: string): string => `Refusing to restore ${dir}: it is not a real directory.`;

/** Config fields the importer will accept — defense-in-depth re-validation (matches exporter allowlist). */
/**
 * The declared chunk types as a lookup. `setManifest` refuses anything outside it, which is the
 * only point where an export from a NEWER lynox can be told apart from a corrupt one.
 */
const KNOWN_CHUNK_TYPES: ReadonlySet<string> = new Set(MIGRATION_CHUNK_TYPES);

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

    for (const chunk of manifest.chunks) {
      // A type this build does not know means the export came from a NEWER lynox. Refusing
      // here — before a single chunk is transferred — is the whole point: the alternative is
      // what shipped versions do, which is to accept everything, restore what they recognise,
      // and report `done` with the manifest's chunk count. A partial instance that looks
      // complete is worse than a migration that refuses to start, and the message has to name
      // the type, because otherwise the operator cannot tell "too old" from "corrupt".
      if (!KNOWN_CHUNK_TYPES.has(chunk.type)) {
        // The type is echoed because the operator cannot act without it — and it is BOUNDED
        // and QUOTED at the source, not one function away. `errorResponse` does mask and cap
        // at 600 chars on the way out, but a throw site that relies on its caller for that is
        // safe only for as long as every caller keeps doing it; two sibling errors in this
        // file already lean on the same single mitigation. `JSON.stringify` also escapes
        // control characters, so a crafted type cannot forge a line wherever this text lands.
        //
        // The wording states what the code KNOWS. An earlier draft said the export "was
        // written by a newer lynox" — which a corrupt or hostile manifest produces just as
        // well, so the sentence asserted a cause the check cannot establish. Naming both and
        // ranking them is the difference between a diagnosis and a guess.
        throw new Error(
          `Unknown chunk type ${JSON.stringify(String(chunk.type).slice(0, 64))} in the `
          + `manifest. Most likely this export was written by a newer lynox than this `
          + `instance — upgrade this instance before restoring. Otherwise the manifest is `
          + `corrupt. Either way, restoring now would silently leave out everything this `
          + `build cannot place.`,
        );
      }

      // Validate DB names against whitelist (path traversal prevention)
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
    // 1. SQLite databases (core data) — all of them staged and checked before any is swapped in
    // 2. Config, once the databases are in place
    // 3. Artifacts (supplementary)
    // 4. Memory (the flat-file store the memory_* tools read)
    // 5. Secrets (most sensitive — last, so we can abort without partial secret state)

    const chunksByType = this.groupChunksByType(manifest.chunks, receivedChunks);

    // Phase 1, before anything is replaced: every part after the databases is decoded and checked
    // (`prepareRest`), and so is what the destination holds where those parts go
    // (`checkDestination`, which names what it asks). What either refuses stops the restore here,
    // with every database, the config and the rest as they were. A write that fails after the
    // swap for another reason (permissions, space, I/O) still stops it there.
    const rest = this.prepareRest(chunksByType);
    this.checkDestination(rest);

    // 1. SQLite databases, in two phases. The first stages every copy and checks it and the
    // database it replaces; if anything fails there, every database and the config stay as they
    // were. The second swaps them all in.
    const staged = this.stageDatabases(chunksByType.sqlite_db, (meta) => {
      onProgress?.({ phase: 'restoring', currentChunk: meta.seq, totalChunks: manifest.totalChunks, currentName: meta.name });
    });
    for (const { baseName, tmpPath, destPath, unreadable } of staged) {
      // The unreadable database goes first, its `-wal` with it: the copy must not land next to it.
      if (unreadable) moveAsideUnreadable(destPath);
      renameSync(tmpPath, destPath);
      verification.databasesRestored.push(baseName);
    }

    // 2. Config
    for (const { meta, fields } of rest.config) {
      onProgress?.({ phase: 'restoring', currentChunk: meta.seq, totalChunks: manifest.totalChunks, currentName: 'config' });
      this.restoreConfig(fields);
      verification.configApplied = true;
    }

    // 3. Artifacts
    for (const artifacts of rest.artifacts) {
      onProgress?.({ phase: 'restoring', currentChunk: artifacts.meta.seq, totalChunks: manifest.totalChunks, currentName: 'artifacts' });
      verification.artifactsImported = this.restoreArtifacts(artifacts.index, artifacts.files);
    }

    // 4. Memory (flat-file store) — one call for the whole set, so a split
    // payload is reassembled once instead of last-write-wins per chunk.
    if (rest.memory) {
      onProgress?.({ phase: 'restoring', currentChunk: rest.memory.meta.seq, totalChunks: manifest.totalChunks, currentName: 'memory' });
      verification.memoryFilesImported = this.restoreMemory(rest.memory.files);
    }

    // 4b. Merge ledgers — the reversal records for `subjects_merge`. After memory and
    // before secrets: they reference subject ids that live in engine.db, already
    // restored in step 1, so a ledger landing here is usable the moment it lands.
    if (rest.sweeps) {
      onProgress?.({ phase: 'restoring', currentChunk: rest.sweeps.meta.seq, totalChunks: manifest.totalChunks, currentName: 'sweeps' });
      verification.mergeLedgersImported = this.restoreSweeps(rest.sweeps.files);
    }

    // 4c. Generic portable directories (`apis/`, `workspace/`) — opaque file trees, so
    // they carry no ordering constraint against the databases. Grouped and reassembled by
    // directory in `prepareRest`.
    const portableSkipped: string[] = [];
    for (const { meta, dir, entries } of rest.portable) {
      onProgress?.({ phase: 'restoring', currentChunk: meta.seq, totalChunks: manifest.totalChunks, currentName: dir });
      verification.portableDirFilesImported += this.restorePortableDir(dir, entries, portableSkipped);
    }
    if (portableSkipped.length > 0) verification.portableDirSkipped = portableSkipped;

    // 5. Secrets (most sensitive — last)
    for (const { meta, secrets, data } of rest.secrets) {
      onProgress?.({ phase: 'restoring', currentChunk: meta.seq, totalChunks: manifest.totalChunks, currentName: 'secrets' });
      verification.secretsImported = this.restoreSecrets(secrets, data);
    }

    // 5b. Store connections (Appendix B, B10): their binding was made under the source's vault
    // key and their tokens reach no store here, so each is dropped and the customer connects the
    // store again. Every destination, managed or not; after the secrets, so the vault holds what
    // is removed. A token slot of a store profile goes; the client pair stays.
    const written: { written: (WrittenSecret & { forced: boolean })[]; inUse: string[] } = { written: [], inUse: [] };
    const reconnect = ApiStore.stripStoreConnectionsOnImport(join(this.lynoxDir, 'engine.db'), join(this.lynoxDir, 'apis'), this.vaultKey, written);
    if (reconnect.length > 0) {
      const vaultPath = join(this.lynoxDir, 'vault.db');
      if (existsSync(vaultPath)) {
        const vault = new SecretVault({ path: vaultPath, masterKey: this.vaultKey });
        try {
          // A slot a kept profile reads stays, derived or recorded: a `-`/`_` partner shares the
          // derived pair, and any profile may name a slot an exchange once wrote.
          const inUse = new Set(written.inUse);
          for (const id of reconnect) {
            for (const name of [accessTokenKey(id), refreshTokenKey(id)]) if (!inUse.has(name)) vault.delete(name);
          }
          // Of a recorded slot only the value the exchange wrote, and never a protected name: what
          // sits there now may be the customer's own. A kept profile naming the slot holds it,
          // except against a store a mandate connected (`forced`), as in `purgeRecordedTokens`.
          // Unlike there, a slot only an unreadable row names is not held: such a row is skipped.
          for (const w of written.written) {
            if (isProtectedSecretWrite(w.name) || (inUse.has(w.name) && !w.forced)) continue;
            const value = vault.get(w.name);
            if (value !== null && tokenFingerprint(value) === w.fp) vault.delete(w.name);
          }
        } finally {
          vault.close();
        }
      }
      verification.reconnectStores = reconnect;
    }

    // 6. Re-gate (MANAGED destination only): a migrated api connection's
    // custom_endpoint_ack is a per-instance BYOK-endpoint acceptance that must
    // NOT be inherited — strip it so any custom endpoint re-triggers the
    // disclosure gate before reuse (the engine.db analog of restoreConfig's
    // SAFE_CONFIG_FIELDS strip). A self-hosted import keeps the ack (same data
    // owner). It runs before anything lands, not here: on engine.db's staged copy in
    // step 1 (`stageDatabase`) and on each `apis/*.json` as step 4c writes it
    // (`restorePortableDir`). The route has no rollback, so a strip at the end left
    // every ack on disk whenever a step before it threw, and the next boot read it.

    // 6b. The SAME re-gate for the flat `apis/*.json` profiles, which now travel too.
    // Without this the gate has a hole with a precise shape: a source from BEFORE the
    // connections cutover ships `apis/` and no `engine.db`, so the engine.db re-gate never runs, the
    // destination boots with empty `connections`, `importFromDirectoryIfNeeded` reads the
    // flat JSON — and the ack rides in intact, defeating the managed BYOK-endpoint
    // disclosure gate for an operator who never saw the dialog. Same condition, same
    // reasoning, same idempotence; a self-hosted destination keeps the ack because it is
    // the same data owner.
    // The bundle's own files carry no ack by now (step 4c strips it as it writes them); this
    // pass is for the entries that were on the destination before the restore.
    // The import reads every `apis/*.json` it can, following a link, so a file this pass cannot
    // read or rewrite would keep its ack: the restore refuses instead of reporting success. The
    // same pass ran as a check in phase 1, so what it refuses there stops the restore before
    // anything is replaced; here it refuses what changed since, and an entry of the same name as
    // one the bundle carries whose write step 4c passed over. The refused entry and its ack stay
    // where they are. A link is refused rather than followed, since rewriting
    // through it writes outside the data dir. A directory and a file that does not parse are
    // passed over: the import passes the one over and holds the other with the same parser.
    if (readEnvAlias('LYNOX_BILLING_TIER')) regateFlatProfiles(join(this.lynoxDir, 'apis'), 'strip');

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
  ): Record<MigrationChunkType, Array<{ meta: MigrationChunkMeta; data: Buffer }>> {
    // DERIVED from the declared list, not restated. The hand-written table was the defect:
    // a type in the union with no bucket here fell through `if (group)` without a word, and a
    // v2.14.2 importer reading a v2.15 export lost `sweeps` and two `portable_dir` chunks that
    // way while reporting `done` at 5 of 5 (measured 2026-09-24 across two real trees).
    const groups = Object.fromEntries(
      MIGRATION_CHUNK_TYPES.map((t) => [t, [] as Array<{ meta: MigrationChunkMeta; data: Buffer }>]),
    ) as Record<MigrationChunkType, Array<{ meta: MigrationChunkMeta; data: Buffer }>>;

    for (const meta of metas) {
      const buf = data.get(meta.seq);
      if (!buf) continue;
      // No `if (group)` guard, and its absence is the point: `meta.type` is a declared type and
      // every declared type has a bucket above, so the lookup cannot miss. A guard here would
      // re-create the silent drop it is meant to prevent.
      groups[meta.type].push({ meta, data: buf });
    }

    return groups;
  }

  /**
   * Phase 1 for every part after the databases: reassemble, bound and decode it, and check its
   * shape. Refused here, before anything is replaced: a payload that does not parse, a bound, a
   * payload a later step reads as an object that is not one, an artifact whose content is not a
   * string, and a secret the vault cannot take. A part the later step would pass over (an
   * undeclared portable directory, no `files`) is passed over here, as before.
   */
  private prepareRest(chunksByType: Record<MigrationChunkType, Array<{ meta: MigrationChunkMeta; data: Buffer }>>): PreparedRest {
    const malformed = (what: string): Error => new Error(`Refusing to restore: the ${what} in the bundle is malformed — import aborted before anything was replaced.`);
    const decode = (data: Buffer): unknown => JSON.parse(data.toString('utf-8'));

    const config = chunksByType.config.map(({ meta, data }) => {
      const fields = asObject(decode(data));
      if (!fields) throw malformed('config');
      return { meta, fields };
    });

    const artifacts = chunksByType.artifacts.map(({ meta, data }) => {
      const bundle = asObject(decode(data));
      const files = asObject(bundle?.['files']);
      const index = bundle?.['index'];
      if (!Array.isArray(index) || !files) throw malformed('artifacts');
      // The content of an id the restore writes must be a string: `writeFileSync` throws on most else.
      if (Object.entries(files).some(([id, content]) => ARTIFACT_ID.test(id) && typeof content !== 'string')) throw malformed('artifacts');
      return { meta, index: index as unknown[], files };
    });

    // Memory and merge ledgers: reassembly + decode + parse holds several copies of the payload
    // at once. MAX_TOTAL_BYTES (500 MiB) bounds the whole transfer, not this one bundle, so bound
    // it here: a real memory tree is scopes × 4 × MAX_MEMORY_FILE_BYTES, i.e. 64 MiB already
    // allows 64 scope directories. The exporter splits an oversized bundle into `<name>:partN`.
    const filesBundle = (chunks: Array<{ meta: MigrationChunkMeta; data: Buffer }>, label: string): { meta: MigrationChunkMeta; files: Record<string, unknown> | null } | null => {
      if (chunks.length === 0) return null;
      const totalBytes = chunks.reduce((n, c) => n + c.data.length, 0);
      if (totalBytes > MAX_MEMORY_BUNDLE_BYTES) {
        throw new Error(`${label} bundle too large: ${String(totalBytes)} > ${String(MAX_MEMORY_BUNDLE_BYTES)}`);
      }
      const bundle = asObject(decode(reassemble(chunks)));
      if (!bundle) throw malformed(label.toLowerCase());
      return { meta: chunks[0]!.meta, files: asObject(bundle['files']) };
    };
    const memory = filesBundle(chunksByType.memory, 'Memory');
    const sweeps = filesBundle(chunksByType.sweeps, 'Merge-ledger');
    // Bound the ledger FILE COUNT, not only the bytes. A minimal entry costs ~43 bytes, so the
    // byte cap alone permits ~1.4M files — each one a separate write, and each one then
    // copied + SHA-256'd + manifested by every future backup, which would brick the
    // backup path from a single import.
    if (sweeps?.files) {
      const fileCount = Object.keys(sweeps.files).length;
      if (fileCount > MAX_MERGE_LEDGERS) {
        throw new Error(`Too many merge ledgers: ${String(fileCount)} > ${String(MAX_MERGE_LEDGERS)}`);
      }
    }

    // Portable directories, grouped BY DIRECTORY, not per chunk: `splitIntoChunks` turns a bundle
    // over MAX_CHUNK_BYTES into `workspace:part0`, `workspace:part1`, …, and one of those parts
    // alone does not parse.
    const portableByDir = new Map<string, Array<{ meta: MigrationChunkMeta; data: Buffer }>>();
    for (const c of chunksByType.portable_dir) {
      const base = c.meta.name.split(':')[0]!;
      portableByDir.set(base, [...(portableByDir.get(base) ?? []), c]);
    }
    const portable: PreparedRest['portable'] = [];
    for (const parts of portableByDir.values()) {
      // Sum the REASSEMBLED payload, not individual chunks: `encryptChunk` already caps each
      // chunk at MAX_CHUNK_BYTES, so a per-chunk sum could never reach this limit. The bundle is
      // base64, so the ceiling is expressed on the encoded size the importer holds in memory.
      const totalBytes = parts.reduce((n, c) => n + c.data.length, 0);
      if (totalBytes > MAX_PORTABLE_DIR_BYTES * 2) {
        throw new Error(`Portable directory bundle too large: ${String(totalBytes)} > ${String(MAX_PORTABLE_DIR_BYTES * 2)}`);
      }
      const bundle = asObject(decode(reassemble(parts)));
      if (!bundle) throw malformed('portable directory');
      const dir = bundle['dir'];
      const files = asObject(bundle['files']);
      // The directory name comes from the bundle, so it is attacker-shaped: accept only the
      // ones this build declares portable, never whatever the payload asks for.
      if (typeof dir !== 'string' || !GENERIC_PORTABLE_DIRS.includes(dir) || !files) continue;
      const entries = Object.entries(files);
      if (entries.length > MAX_PORTABLE_DIR_ENTRIES) {
        throw new Error(`Too many entries in ${dir}: ${String(entries.length)} > ${String(MAX_PORTABLE_DIR_ENTRIES)}`);
      }
      portable.push({ meta: parts[0]!.meta, dir, entries });
    }

    // Each secret as `restoreSecrets` takes it. What it passes over (an entry without a name or a
    // value) stays passed over; what would make it throw is refused here: a `null` entry, a value
    // the vault cannot encrypt, and a name, scope or TTL its insert cannot take. Without this, that
    // throw came after the swap, with some secrets already written.
    const bindable = (v: unknown): boolean => v === undefined || v === null || typeof v === 'string' || typeof v === 'number';
    const secrets = chunksByType.secrets.map(({ meta, data }) => {
      const list = decode(data);
      if (!Array.isArray(list)) throw malformed('secrets');
      for (const item of list) {
        if (item === null) throw malformed('secrets');
        if (typeof item !== 'object') continue;
        const { name, value, scope, ttlMs } = item as Record<string, unknown>;
        if (!name || !value) continue;
        if (typeof value !== 'string' || !bindable(name) || !bindable(ttlMs)) throw malformed('secrets');
        if (scope !== undefined && scope !== null && !(typeof scope === 'string' && Object.hasOwn(SECRET_SCOPES, scope))) throw malformed('secrets');
      }
      return { meta, secrets: list as ExportedSecret[], data };
    });

    return { config, artifacts, memory, sweeps, portable, secrets };
  }

  /**
   * Phase 1 for the destination: what it holds where the parts after the databases go. Refused
   * here: a link or file where sweeps/ or a portable directory belongs, a workspace root that
   * cannot be opened, and a flat profile step 6b would refuse. The steps that write ask the
   * directory checks again, for what changed in between.
   */
  private checkDestination(rest: PreparedRest): void {
    const at = (rel: string): string => join(this.lynoxDir, rel);

    if (rest.sweeps?.files) {
      refuseUnlessRealDirectory(at('sweeps'), SWEEPS_NOT_A_DIRECTORY);
    }
    for (const { dir } of rest.portable) {
      if (dir === 'workspace') {
        // Opening the root is what the write step does first; absent, it is made there.
        leaseWorkspaceFor(this.lynoxDir)?.release();
        continue;
      }
      refuseUnlessRealDirectory(at(dir), portableNotADirectory(dir));
    }

    // Step 6b, as a check: the bundle's own top-level `apis/*.json` replace the entries of the
    // same name, so those are not asked.
    if (readEnvAlias('LYNOX_BILLING_TIER')) {
      const replaced = new Set<string>();
      for (const { dir, entries } of rest.portable) {
        if (dir !== 'apis') continue;
        for (const [rel, b64] of entries) {
          if (typeof b64 === 'string' && isPortableDirEntryName(rel) && !rel.includes('/') && rel.endsWith('.json')) replaced.add(rel);
        }
      }
      regateFlatProfiles(at('apis'), 'check', replaced);
    }
  }

  /**
   * Restore secrets into the instance's vault.
   * Decrypts from transfer, re-encrypts with instance's vault key.
   */
  private restoreSecrets(secrets: ExportedSecret[], data: Buffer): number {
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
   * Phase 1 of the database restore: stage every database of the bundle and check it and the
   * database it replaces. Nothing in the data directory is replaced here; if anything fails, every
   * staged copy goes and the error is thrown.
   */
  private stageDatabases(
    chunks: Array<{ meta: MigrationChunkMeta; data: Buffer }>,
    onChunk: (meta: MigrationChunkMeta) => void,
  ): StagedDatabase[] {
    const staged: StagedDatabase[] = [];
    try {
      for (const { meta, data } of chunks) {
        onChunk(meta);
        const copy = this.stageDatabase(meta, data, chunks);
        if (copy) staged.push(copy);
      }
      for (const copy of staged) copy.unreadable = this.drainDestination(copy.baseName, copy.destPath);
    } catch (err: unknown) {
      for (const copy of staged) dropStagedCopy(copy.tmpPath);
      throw err;
    }
    return staged;
  }

  /**
   * The database a staged copy will replace. Its `-wal` and `-shm` belong to the path, not to the
   * file, so a `-wal` left there would be replayed onto the copy. A checkpoint and a close drain it
   * into the old file, and SQLite removes the `-wal` when the last connection closes: one that is
   * still there afterwards means another connection holds the database open, and the restore stops.
   * A `-wal` a crash left on a database nothing opens any more is drained here, not refused.
   * Without a `-wal` there is nothing to replay and no holder to find (the four databases open in
   * WAL mode, and an open connection keeps its `-wal`), so the destination is not opened at all
   * and is replaced as it is.
   * Returns true when SQLite cannot read the file as a database (corrupt, or not a database): that
   * one is moved aside in phase 2. Any failure to open or checkpoint it after that stops the restore.
   */
  private drainDestination(baseName: string, destPath: string): boolean {
    // A directory cannot be renamed over; phase 2 would fail on it after swapping others in.
    if (lstatSync(destPath, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error(`${baseName} in the data directory is a directory — import aborted.`);
    }
    if (!existsSync(`${destPath}-wal`)) return false;
    // Read-only first: a read-write connection that closes on a file which is no database
    // (SQLITE_NOTADB) deletes the `-wal` beside it, a read-only one leaves it, and that `-wal` is
    // to go aside with the file.
    if (cannotReadAsDatabase(destPath)) return true;
    const db = new Database(destPath);
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
    } finally {
      db.close();
    }
    if (existsSync(`${destPath}-wal`)) {
      throw new Error(`${baseName} is still open elsewhere — import aborted.`);
    }
    return false;
  }

  /**
   * Stage one SQLite database of the bundle next to the one it replaces (`<db>.migration-tmp`),
   * check its integrity and, for engine.db, re-gate it.
   * Handles multi-part databases (split during export if >8 MB).
   */
  private stageDatabase(
    meta: MigrationChunkMeta,
    data: Buffer,
    allDbChunks: Array<{ meta: MigrationChunkMeta; data: Buffer }>,
  ): StagedDatabase | null {
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

    // Write to temp file and verify integrity; the swap is phase 2's
    const destPath = join(this.lynoxDir, baseName);
    const tmpPath = `${destPath}.migration-tmp`;

    dropStagedCopy(tmpPath);
    writeFileSync(tmpPath, finalData, { mode: FILE_MODE_PRIVATE });

    // Verify SQLite integrity before replacing
    if (!verifySqliteIntegrity(tmpPath)) {
      dropStagedCopy(tmpPath);
      throw new Error(`SQLite integrity check failed for ${baseName} — import aborted.`);
    }

    // The re-gate of step 6 (managed destination only), on the staged copy: the engine.db that
    // lands never carries a migrated custom_endpoint_ack, so a later step that throws cannot
    // leave one behind. If it fails, the staged copy goes and the database in place stays.
    if (baseName === 'engine.db' && readEnvAlias('LYNOX_BILLING_TIER')) {
      try {
        ApiStore.regateMigratedApiConnections(tmpPath, this.vaultKey);
      } catch (err: unknown) {
        dropStagedCopy(tmpPath);
        // The store's own advice is about a data directory; this is a staged copy, now gone.
        const cause = err instanceof Error && err.cause instanceof Error ? err.cause : err;
        const what = cause instanceof Error ? cause.message.split('\n')[0] : String(cause);
        throw new Error(
          `The restored ${baseName} could not be prepared for this instance (${what}); the staged copy was dropped and the ${baseName} in place was not replaced.`,
          { cause: err },
        );
      }
    }

    return { baseName, tmpPath, destPath, unreadable: false };
  }

  /**
   * Restore artifacts (index + content files).
   */
  private restoreArtifacts(index: unknown[], files: Record<string, unknown>): number {
    const artifactsDir = join(this.lynoxDir, 'artifacts');
    mkdirSync(artifactsDir, { recursive: true, mode: DIR_MODE_PRIVATE });

    // Write index
    writeFileSync(join(artifactsDir, 'index.json'), JSON.stringify(index, null, 2), {
      encoding: 'utf-8',
      mode: FILE_MODE_PRIVATE,
    });

    // Write content files with path traversal protection
    for (const [id, content] of Object.entries(files)) {
      // Validate ID format (must match ArtifactStore's SAFE_ID pattern); `prepareRest` refused a
      // bundle where the content of such an id is not a string.
      if (!ARTIFACT_ID.test(id)) continue;
      const filePath = resolve(artifactsDir, `${id}.html`);
      // Defense-in-depth: ensure resolved path is still within artifacts dir
      if (!filePath.startsWith(artifactsDir)) continue;
      writeFileSync(filePath, content as string, {
        encoding: 'utf-8',
        mode: FILE_MODE_PRIVATE,
      });
    }

    return index.length;
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
  private restoreMemory(files: Record<string, unknown> | null): number {
    if (!files) return 0;

    const memoryDir = join(this.lynoxDir, 'memory');
    const memoryPrefix = memoryDir + sep;
    let written = 0;

    for (const [key, content] of Object.entries(files)) {
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
   * Restore the merge ledgers. Their bounds (bytes, file count) are checked in `prepareRest`,
   * before any database is replaced.
   */
  private restoreSweeps(files: Record<string, unknown> | null): number {
    if (!files) return 0;

    const sweepsDir = join(this.lynoxDir, 'sweeps');
    const sweepsPrefix = sweepsDir + sep;

    // A bundle arrives from another machine and its contents are attacker-shaped in the
    // threat model this importer already assumes. Two symlink shapes defeat a purely
    // lexical path check, so both are closed before anything is written:
    //   1. `sweeps/` ITSELF a symlink — `resolve()` is lexical and `mkdirSync(recursive)`
    //      no-ops on an existing link, so every ledger would land outside the data dir
    //      while `startsWith(sweepsPrefix)` still passed. Phase 1 refuses it first.
    //   2. an individual `merge-*.json` already a symlink — `writeFileSync` opens
    //      O_CREAT|O_TRUNC, which FOLLOWS, so bundle content would overwrite the target.
    refuseUnlessRealDirectory(sweepsDir, SWEEPS_NOT_A_DIRECTORY);

    let written = 0;

    for (const [fileName, content] of Object.entries(files)) {
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
  private restorePortableDir(dir: string, entries: Array<[string, unknown]>, skipped: string[]): number {
    if (dir === 'workspace') return this.restoreWorkspace(entries, skipped);

    const root = join(this.lynoxDir, dir);
    const rootPrefix = root + sep;
    refuseUnlessRealDirectory(root, portableNotADirectory(dir));

    // The root itself, once — the per-segment walk below deliberately does NOT use
    // `recursive`, so it cannot create a chain through a link, and therefore cannot create
    // the root either.
    mkdirSync(root, { recursive: true, mode: DIR_MODE_PRIVATE });

    // Managed destination: a profile file's custom_endpoint_ack is not inherited (see step 6 of
    // `restore`), so it is left out of what is written rather than removed after the fact.
    const regate = dir === 'apis' && Boolean(readEnvAlias('LYNOX_BILLING_TIER'));

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
      let content: Buffer = Buffer.from(b64, 'base64');
      // The files the import reads: `*.json` directly in apis/.
      if (regate && dirname(filePath) === root && rel.endsWith('.json')) content = withoutEndpointAck(content);

      try { unlinkSync(filePath); } catch { /* not there — the normal case */ }
      try {
        writeFileSync(filePath, content, { mode: FILE_MODE_PRIVATE, flag: 'wx' });
      } catch { continue; } // raced, or the parent vanished
      written++;
    }
    return written;
  }

  /**
   * The workspace bundle, written through the root's anchor: the root may live outside the data
   * dir. Every file is staged inside the root and then renamed over its target, so a link on the
   * way is refused and a link at the target is replaced, never written through; files the
   * bundle does not carry stay. An entry whose path the root cannot take as a file — a file or
   * a link where a directory belongs, a directory where the file goes, or a path the bundle
   * also uses as a directory — is skipped and named, as the by-name import did per entry.
   */
  private restoreWorkspace(entries: Array<[string, unknown]>, skipped: string[]): number {
    const lease = leaseWorkspaceFor(this.lynoxDir, { create: true });
    if (lease === null) throw new Error('Refusing to restore workspace: the workspace root could not be made.');
    try {
      const anchor = lease.access.anchor;
      const fileKeys = new Set<string>();
      const dirKeys = new Set<string>();
      const accepted: Array<[string, string]> = [];
      // What the target holds at a path, asked once. Below an absent directory nothing is asked:
      // the stage makes it fresh, and the primitive cannot walk into what is not there.
      const onTarget = new Map<string, 'absent' | 'dir' | 'other'>();
      const kindOf = (rel: string): 'absent' | 'dir' | 'other' => {
        let kind = onTarget.get(rel);
        if (kind === undefined) {
          const st = statEntry(anchor, rel);
          kind = st === null ? 'absent' : st.type === 'dir' ? 'dir' : 'other';
          onTarget.set(rel, kind);
        }
        return kind;
      };
      const takes = (rel: string): boolean => {
        const parts = rel.split('/');
        // A name the file system would store as other bytes (a lone surrogate) or refuse (over 255
        // bytes) is skipped here: in the stage it would fail the whole set, possibly mid-commit.
        if (parts.some(part => Buffer.from(part, 'utf8').toString('utf8') !== part || Buffer.byteLength(part, 'utf8') > 255)) return false;
        const prefixes = parts.slice(1).map((_, i) => parts.slice(0, i + 1).join('/'));
        // A file the bundle already placed on the way, at any depth: asked before the target is,
        // because an absent directory below ends the walk early.
        if (prefixes.some(prefix => fileKeys.has(prefix))) return false;
        for (const prefix of prefixes) {
          const kind = kindOf(prefix);
          if (kind === 'absent') return !dirKeys.has(rel);   // everything below is made fresh
          if (kind !== 'dir') return false;
        }
        if (dirKeys.has(rel)) return false;
        return kindOf(rel) !== 'dir';
      };
      for (const [rel, b64] of entries) {
        if (typeof b64 !== 'string') continue;
        if (!isPortableDirEntryName(rel)) continue;
        let ok: boolean;
        try { ok = takes(rel); } catch { ok = false; }   // a link on the way: refused by the anchor
        if (!ok) { skipped.push(`workspace/${rel}`); continue; }
        fileKeys.add(rel);
        const parts = rel.split('/');
        for (let i = 1; i < parts.length; i++) dirKeys.add(parts.slice(0, i).join('/'));
        accepted.push([rel, b64]);
      }
      if (accepted.length === 0) return 0;
      removeStaleStages(anchor, '');
      const source = function* (): Iterable<StageEntry> {
        for (const [rel, b64] of accepted) yield { rel, data: Buffer.from(b64, 'base64') };
      };
      const staged = stageIn(anchor, '', source(), { fileMode: FILE_MODE_PRIVATE, dirMode: DIR_MODE_PRIVATE });
      staged.commit();
      return staged.files;
    } finally {
      lease.release();
    }
  }

  /**
   * Apply sanitized config values (merge into existing config, don't replace).
   */
  private restoreConfig(imported: Record<string, unknown>): void {
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

