/**
 * Migration exporter — packages local lynox data for zero-knowledge transfer
 * to a managed instance.
 *
 * Collects:
 *  - Secrets (decrypted from local vault, re-encrypted in transit)
 *  - SQLite databases (crash-safe VACUUM INTO copies)
 *  - Artifacts (index + content files)
 *  - Memory (the flat-file `memory/<scope>/<namespace>.txt` tree)
 *  - Config (sanitized — no secrets, no provider credentials)
 *
 * All data is encrypted per-chunk with AES-256-GCM using an ECDH-derived key.
 * The control plane never sees any plaintext.
 *
 * The memory tree is the PRIMARY store the `memory_*` tools read and write
 * (`Memory` in memory.ts, reached via `agent.memory`); the agent-memory DB is a
 * mirror populated through `channels.memoryStore`. Omitting it — as this
 * exporter did until now, while backup.ts:COPY_DIRS always carried it — left a
 * migrated tenant with an agent that still recalls facts ambiently but reports
 * an empty `memory_recall`/`memory_list`.
 */

import { existsSync, readFileSync, unlinkSync, readdirSync, statSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { snapshotSqlite } from './sqlite-snapshot.js';
import { getLynoxDir } from './config.js';
import { SecretVault } from './secret-vault.js';
import { parsePortableMemoryKey } from './memory-file.js';
import { isMergeLedgerFileName } from './subject-merge-runner.js';
import { MIGRATE_SQLITE_DBS, GENERIC_PORTABLE_DIRS, isPortableDirEntryName, MAX_PORTABLE_DIR_BYTES, MAX_PORTABLE_DIR_ENTRIES } from './data-dir-inventory.js';
import { leaseWorkspaceFor } from './workspace-access.js';
import { copyOut } from './workspace-fd.js';
import { shellIsolation, type ShellIsolation } from './shell-isolation.js';
import { OMITTED_SIDECAR } from './sidecar-refusals.js';
import type { SecretScope } from '../types/index.js';
import { deriveEngineEncKey } from './engine-db.js';
import { deriveHistoryEncKey } from './run-history.js';
import { isPlainStore, type PlainStore } from './migration-rekey.js';
import type { MigrationCeiling } from './migration-ceiling.js';
import {
  choosePlainPaths, rewriteLedgersForPlain, rewriteStoreForPlain,
  type PathReason, type PlainLedgers, type PlainSourceResult,
} from './migration-plain-source.js';
import {
  encryptChunk,
  computeManifestHash,
  sha256,
  MAX_CHUNK_BYTES,
  MIGRATION_MAX_CHUNKS,
  MIGRATION_MAX_TOTAL_BYTES,
  type MigrationManifest,
  type MigrationChunkMeta,
  type EncryptedChunk,
} from './migration-crypto.js';

// ── Types ──

export interface ExportedSecret {
  name: string;
  value: string;
  scope: SecretScope;
  ttlMs: number;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
}

export interface ExportProgress {
  phase: 'collecting' | 'encrypting' | 'done';
  currentChunk: number;
  totalChunks: number;
  currentName: string;
}

export type ProgressCallback = (progress: ExportProgress) => void;

export interface ExportResult {
  manifest: MigrationManifest;
  chunks: EncryptedChunk[];
  /**
   * Workspace entries not in the export (`workspace/...`): links and special files (never
   * followed) and names that are not valid UTF-8. Absent when everything was carried.
   */
  skipped?: string[] | undefined;
  /**
   * Set when the workspace was left out because the engine runs in shell sidecar mode (PRD D7,
   * walker 2): its files are not in this export, and the rest is.
   */
  workspace?: typeof OMITTED_SIDECAR | undefined;
  /**
   * Set when the export was asked for the plaintext path: per store (engine.db, history.db) the
   * path it took, why a store took the raw path, and the values that decrypted or did not
   * (failed ones travel as they were and are named in the payload).
   */
  plain?: PlainExportReport | undefined;
}

export interface PlainExportReport {
  stores: Array<{ store: PlainStore; path: 'plain' | 'raw'; reason?: PathReason | undefined; decrypted: number; failed: number }>;
  /** The merge ledgers, when there are any: their path follows engine.db's. */
  ledgers?: { path: 'plain' | 'raw'; decrypted: number; failed: number } | undefined;
}

export interface ExportOptions {
  /**
   * The destination takes plaintext stores and published these numbers: the stores and the merge
   * ledgers are decrypted in memory, and each store takes the plaintext path where the numbers
   * say the destination can re-encrypt it (`choosePlainPaths`), else the raw path as today.
   * Absent: every store travels raw.
   */
  plain?: { ceiling: MigrationCeiling } | undefined;
}

/** The merge ledgers' cap at the destination (`MAX_MEMORY_BUNDLE_BYTES` in the importer). */
const SWEEPS_CAP_BYTES = 64 * 1024 * 1024;

interface PlaintextChunk {
  meta: MigrationChunkMeta;
  data: Buffer;
}

// ── Constants ──

// DERIVED from `data-dir-inventory.ts` — see the note there. Safe to list a DB before it
// has data: the export loop skips any that doesn't exist (existsSync guard below).
const SQLITE_DBS = MIGRATE_SQLITE_DBS;

/** Bytes as MiB with one decimal for a refusal a person reads, or as bytes where that would read equal to `other`. */
function size(bytes: number, other: number): string {
  const mib = (n: number) => (n / (1024 * 1024)).toFixed(1);
  return mib(bytes) === mib(other) ? `${String(bytes)} bytes` : `${mib(bytes)} MiB`;
}

/**
 * Split a payload into `MAX_CHUNK_BYTES`-bounded chunks. `encryptChunk` throws
 * above that ceiling, so every collector whose payload can grow past it must
 * route through here — a single oversized chunk aborts the whole migration.
 * A payload that fits keeps its bare `name`; a larger one becomes `name:partN`,
 * which the importer reassembles at `part0`.
 */
function splitIntoChunks(
  data: Buffer,
  type: MigrationChunkMeta['type'],
  name: string,
): PlaintextChunk[] {
  if (data.length <= MAX_CHUNK_BYTES) {
    return [{
      meta: { seq: 0, type, name, originalSize: data.length, checksum: sha256(data) },
      data,
    }];
  }

  const parts: PlaintextChunk[] = [];
  let offset = 0;
  let partNum = 0;
  while (offset < data.length) {
    const end = Math.min(offset + MAX_CHUNK_BYTES, data.length);
    const part = data.subarray(offset, end);
    parts.push({
      meta: {
        seq: 0,
        type,
        name: `${name}:part${String(partNum)}`,
        originalSize: part.length,
        checksum: sha256(part),
      },
      data: Buffer.from(part), // copy to detach from the source buffer
    });
    offset = end;
    partNum++;
  }
  return parts;
}

/** Config fields that are safe to migrate (no credentials, no paths). */
const SAFE_CONFIG_FIELDS = [
  'default_tier', 'thinking_mode', 'effort_level',
  'max_session_cost_usd', 'max_daily_cost_usd', 'max_monthly_cost_usd',
  'embedding_provider', 'memory_extraction', 'memory_half_life_days',
  'plugins',
] as const;

// ── Exporter ──

export class MigrationExporter {
  private readonly lynoxDir: string;
  private readonly vaultKey: string;

  /**
   * Overrides for the portable-directory caps. Production never sets them — they exist so a
   * test can REACH the boundary: the real ceilings are 20 000 entries and 64 MiB, and a test
   * that has to materialise either one is slow enough that it does not get written, which is
   * exactly how a cap ends up shipping untested.
   */
  private readonly portableDirLimits: { maxEntries: number; maxBytes: number } | undefined;
  /** Overrides for the migration's bounds, for the same reason: a test cannot build 500 MiB. */
  private readonly bounds: { maxChunks: number; maxTotalBytes: number };
  /** Workspace entries the current export left out; reset per `export()`. */
  private skipped: string[] = [];
  /** Set by `collectWorkspace` when it left the workspace out; reset per `export()`. */
  private workspaceOmitted = false;

  constructor(options?: {
    lynoxDir?: string | undefined;
    vaultKey?: string | undefined;
    portableDirLimits?: { maxEntries: number; maxBytes: number } | undefined;
    bounds?: { maxChunks: number; maxTotalBytes: number } | undefined;
  } | undefined) {
    this.portableDirLimits = options?.portableDirLimits;
    this.bounds = options?.bounds ?? { maxChunks: MIGRATION_MAX_CHUNKS, maxTotalBytes: MIGRATION_MAX_TOTAL_BYTES };
    this.lynoxDir = options?.lynoxDir ?? getLynoxDir();
    const key = options?.vaultKey ?? process.env['LYNOX_VAULT_KEY'];
    if (!key) {
      throw new Error('Vault key required for migration export. Set LYNOX_VAULT_KEY or pass vaultKey option.');
    }
    this.vaultKey = key;
  }

  /**
   * Collect all local data and encrypt it for transfer.
   *
   * @param transferKey  - 32-byte AES-256 key from ECDH key agreement
   * @param onProgress   - Optional progress callback for UI updates
   * @returns Manifest + encrypted chunks ready for upload
   */
  export(transferKey: Buffer, onProgress?: ProgressCallback | undefined, options?: ExportOptions | undefined): ExportResult {
    // Phase 1: Collect plaintext chunks
    const plaintextChunks: PlaintextChunk[] = [];
    this.skipped = [];
    this.workspaceOmitted = false;
    const plan = options?.plain;
    /** Where each database's chunks go in `plaintextChunks`, and both forms of a plaintext-path store. */
    const databases: Array<{ name: string; at: number; raw: PlaintextChunk[]; plain: PlainSourceResult | null }> = [];
    let sweeps: { at: number; raw: PlaintextChunk[]; plain: PlainLedgers | null } | null = null;

    onProgress?.({ phase: 'collecting', currentChunk: 0, totalChunks: 0, currentName: 'secrets' });

    // 1. Secrets — decrypt from local vault
    const secretsChunk = this.collectSecrets();
    if (secretsChunk) plaintextChunks.push(secretsChunk);

    // 2. SQLite databases — VACUUM INTO temp copies; on the plaintext path also decrypted in memory
    for (const dbName of SQLITE_DBS) {
      onProgress?.({ phase: 'collecting', currentChunk: plaintextChunks.length, totalChunks: 0, currentName: dbName });
      const snapshot = this.snapshotDatabase(dbName);
      if (!snapshot) continue;
      const plain = plan && isPlainStore(dbName) ? this.plainForm(snapshot, dbName) : null;
      databases.push({ name: dbName, at: plaintextChunks.length, raw: splitIntoChunks(snapshot, 'sqlite_db', dbName), plain });
    }

    // 3. Artifacts
    onProgress?.({ phase: 'collecting', currentChunk: plaintextChunks.length, totalChunks: 0, currentName: 'artifacts' });
    const artifactChunk = this.collectArtifacts();
    if (artifactChunk) plaintextChunks.push(artifactChunk);

    // 4. Memory — the flat-file store the memory_* tools actually read
    onProgress?.({ phase: 'collecting', currentChunk: plaintextChunks.length, totalChunks: 0, currentName: 'memory' });
    plaintextChunks.push(...this.collectMemory());

    onProgress?.({ phase: 'collecting', currentChunk: plaintextChunks.length, totalChunks: 0, currentName: 'sweeps' });
    const ledgerFiles = this.readSweeps();
    if (ledgerFiles) {
      const raw = splitIntoChunks(Buffer.from(JSON.stringify({ files: ledgerFiles }), 'utf-8'), 'sweeps', 'sweeps');
      const plain = plan && databases.some((d) => d.name === 'engine.db' && d.plain) ? this.plainLedgers(ledgerFiles) : null;
      sweeps = { at: plaintextChunks.length, raw, plain };
    }

    for (const dirName of GENERIC_PORTABLE_DIRS) {
      onProgress?.({ phase: 'collecting', currentChunk: plaintextChunks.length, totalChunks: 0, currentName: dirName });
      plaintextChunks.push(...this.collectPortableDir(dirName));
    }

    // 5. Config (sanitized)
    const configChunk = this.collectConfig();
    if (configChunk) plaintextChunks.push(configChunk);

    // 6. The databases and the merge ledgers, each in the form its path takes. The path is chosen
    //    only now, over every chunk: the destination judges the whole bundle.
    const report = plan ? this.placeDatabases(plaintextChunks, databases, sweeps, plan.ceiling) : this.placeRaw(plaintextChunks, databases, sweeps);

    // Assign sequence numbers
    const chunkMetas: MigrationChunkMeta[] = plaintextChunks.map((c, i) => ({
      ...c.meta,
      seq: i,
    }));

    // The destination refuses a manifest over either bound only after it arrives; check here,
    // before anything is encrypted or sent, and say which bound it is.
    const totalBytes = chunkMetas.reduce((sum, c) => sum + c.originalSize, 0);
    const over: string[] = [];
    if (chunkMetas.length > this.bounds.maxChunks) {
      over.push(`it needs ${String(chunkMetas.length)} chunks, and a migration carries at most ${String(this.bounds.maxChunks)} (each kind of data starts its own chunks of up to ${String(MAX_CHUNK_BYTES / (1024 * 1024))} MiB)`);
    }
    if (totalBytes > this.bounds.maxTotalBytes) {
      over.push(`it is ${size(totalBytes, this.bounds.maxTotalBytes)}, and a migration carries at most ${size(this.bounds.maxTotalBytes, totalBytes)}`);
    }
    if (over.length > 0) {
      for (const pc of plaintextChunks) pc.data.fill(0);
      throw new Error(`This instance's data does not fit one migration: ${over.join('; ')}. None of your data was sent, and the data on this instance is unchanged. A migration cannot move only part of it; write to support@lynox.ai with this message and we will look at it with you.`);
    }

    // Build manifest (without hash first, then compute)
    let lynoxVersion = 'unknown';
    try {
      const pkgPath = join(this.lynoxDir, '..', 'package.json');
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: string };
        if (pkg.version) lynoxVersion = pkg.version;
      }
    } catch { /* best effort */ }

    const manifestBase = {
      version: 1 as const,
      exportedAt: new Date().toISOString(),
      lynoxVersion,
      totalChunks: chunkMetas.length,
      chunks: chunkMetas,
    };

    const manifestHash = computeManifestHash(manifestBase);
    const manifest: MigrationManifest = { ...manifestBase, manifestHash };

    // Phase 2: Encrypt chunks and zeroize plaintext immediately after
    const encryptedChunks: EncryptedChunk[] = [];
    for (let i = 0; i < plaintextChunks.length; i++) {
      const pc = plaintextChunks[i]!;
      onProgress?.({
        phase: 'encrypting',
        currentChunk: i,
        totalChunks: plaintextChunks.length,
        currentName: pc.meta.name,
      });

      encryptedChunks.push(encryptChunk(pc.data, transferKey, i, manifestHash));

      // Zeroize plaintext immediately after encryption — especially critical for secrets
      pc.data.fill(0);
    }

    onProgress?.({ phase: 'done', currentChunk: plaintextChunks.length, totalChunks: plaintextChunks.length, currentName: '' });

    return {
      manifest, chunks: encryptedChunks,
      ...(this.skipped.length > 0 ? { skipped: [...this.skipped] } : {}),
      ...(this.workspaceOmitted ? { workspace: OMITTED_SIDECAR } : {}),
      ...(report ? { plain: report } : {}),
    };
  }

  /** A store's plaintext form, or null when its rewrite fails (it then travels raw). */
  private plainForm(snapshot: Buffer, store: PlainStore): PlainSourceResult | null {
    const key = store === 'engine.db' ? deriveEngineEncKey(this.vaultKey) : deriveHistoryEncKey(this.vaultKey);
    try {
      return rewriteStoreForPlain(snapshot, store, { key });
    } catch {
      return null;
    } finally {
      key.fill(0);
    }
  }

  /** The merge ledgers' plaintext form, or null when they have to travel raw. */
  private plainLedgers(files: Record<string, string>): PlainLedgers | null {
    const key = deriveEngineEncKey(this.vaultKey);
    try {
      return rewriteLedgersForPlain(structuredClone(files), key);
    } finally {
      key.fill(0);
    }
  }

  /**
   * Insert chunks at the positions their collectors had. `placed` comes in collection order, so its
   * positions never decrease; inserting from the last entry back keeps that order, also for
   * several entries at one position (the databases all sit after the secrets).
   */
  private insertAt(chunks: PlaintextChunk[], placed: Array<{ at: number; chunks: PlaintextChunk[] }>): void {
    for (let i = placed.length - 1; i >= 0; i--) chunks.splice(placed[i]!.at, 0, ...placed[i]!.chunks);
  }

  /** Every database and the ledgers raw, as today. */
  private placeRaw(
    chunks: PlaintextChunk[],
    databases: Array<{ at: number; raw: PlaintextChunk[] }>,
    sweeps: { at: number; raw: PlaintextChunk[] } | null,
  ): undefined {
    this.insertAt(chunks, [...databases.map((d) => ({ at: d.at, chunks: d.raw })), ...(sweeps ? [{ at: sweeps.at, chunks: sweeps.raw }] : [])]);
    return undefined;
  }

  /**
   * The plaintext path: choose per store over the whole bundle, then place each store and the
   * ledgers in the chosen form and zero the form that does not travel.
   */
  private placeDatabases(
    chunks: PlaintextChunk[],
    databases: Array<{ name: string; at: number; raw: PlaintextChunk[]; plain: PlainSourceResult | null }>,
    sweeps: { at: number; raw: PlaintextChunk[]; plain: PlainLedgers | null } | null,
    ceiling: MigrationCeiling,
  ): PlainExportReport {
    const bytes = (cs: PlaintextChunk[]): number => cs.reduce((n, c) => n + c.data.length, 0);
    const stores = databases.filter((d): d is typeof d & { name: PlainStore } => isPlainStore(d.name));
    const paths = choosePlainPaths({
      ceiling,
      stores: stores.map((d) => ({ store: d.name, plainBytes: d.plain ? d.plain.payload.length : null, rawBytes: bytes(d.raw) })),
      otherBytes: bytes(chunks),
      otherDatabaseBytes: databases.filter((d) => !isPlainStore(d.name)).reduce((n, d) => n + bytes(d.raw), 0),
      sweeps: sweeps ? { rawBytes: bytes(sweeps.raw), plainBytes: sweeps.plain ? sweeps.plain.payload.length : null } : null,
      sweepsCapBytes: SWEEPS_CAP_BYTES,
    });
    const placed: Array<{ at: number; chunks: PlaintextChunk[] }> = [];
    const report: PlainExportReport = { stores: [] };
    for (const d of databases) {
      const choice = isPlainStore(d.name) ? paths.get(d.name) : undefined;
      if (choice?.path === 'plain' && d.plain) {
        const parts = splitIntoChunks(d.plain.payload, 'sqlite_db_plain', d.name);
        parts[0]!.meta.columns = d.plain.columns;
        placed.push({ at: d.at, chunks: parts });
        for (const c of d.raw) c.data.fill(0);
      } else {
        placed.push({ at: d.at, chunks: d.raw });
        d.plain?.payload.fill(0);
      }
      if (choice) report.stores.push({ store: d.name as PlainStore, path: choice.path, ...(choice.reason ? { reason: choice.reason } : {}), decrypted: d.plain?.counts.decrypted ?? 0, failed: d.plain?.counts.failed ?? 0 });
    }
    if (sweeps) {
      const plain = paths.get('engine.db')?.path === 'plain' && sweeps.plain ? sweeps.plain : null;
      if (plain) {
        const parts = splitIntoChunks(plain.payload, 'sweeps', 'sweeps');
        parts[0]!.meta.ledgerForm = 'plain';
        parts[0]!.meta.ledgerRawBytes = plain.rawBytes;
        placed.push({ at: sweeps.at, chunks: parts });
        for (const c of sweeps.raw) c.data.fill(0);
      } else {
        placed.push({ at: sweeps.at, chunks: sweeps.raw });
        sweeps.plain?.payload.fill(0);
      }
      report.ledgers = { path: plain ? 'plain' : 'raw', decrypted: sweeps.plain?.counts.decrypted ?? 0, failed: sweeps.plain?.counts.failed ?? 0 };
    }
    this.insertAt(chunks, placed);
    return report;
  }

  /**
   * Get a summary of what will be exported (without actually exporting).
   * Useful for the wizard UI to show the user what data will be migrated.
   */
  preview(): { secrets: number; databases: string[]; artifacts: number; memoryFiles: number; hasConfig: boolean } {
    let secrets = 0;
    try {
      const vault = new SecretVault({ path: join(this.lynoxDir, 'vault.db'), masterKey: this.vaultKey });
      secrets = vault.size;
      vault.close();
    } catch { /* vault may not exist */ }

    const databases: string[] = [];
    for (const dbName of SQLITE_DBS) {
      if (existsSync(join(this.lynoxDir, dbName))) {
        databases.push(dbName);
      }
    }

    let artifacts = 0;
    try {
      const indexPath = join(this.lynoxDir, 'artifacts', 'index.json');
      if (existsSync(indexPath)) {
        const index = JSON.parse(readFileSync(indexPath, 'utf-8')) as unknown[];
        artifacts = index.length;
      }
    } catch { /* ok */ }

    let memoryFiles = 0;
    try {
      const memoryDir = join(this.lynoxDir, 'memory');
      if (existsSync(memoryDir)) {
        for (const scopeDir of readdirSync(memoryDir)) {
          const scopePath = join(memoryDir, scopeDir);
          if (!statSync(scopePath).isDirectory()) continue;
          for (const fileName of readdirSync(scopePath)) {
            if (parsePortableMemoryKey(`${scopeDir}/${fileName}`)) memoryFiles++;
          }
        }
      }
    } catch { /* ok */ }

    const hasConfig = existsSync(join(this.lynoxDir, 'config.json'));

    return { secrets, databases, artifacts, memoryFiles, hasConfig };
  }

  // ── Private collectors ──

  private collectSecrets(): PlaintextChunk | null {
    const vaultPath = join(this.lynoxDir, 'vault.db');
    if (!existsSync(vaultPath)) return null;

    const vault = new SecretVault({ path: vaultPath, masterKey: this.vaultKey });
    try {
      const allSecrets = vault.getAll();
      const metadata = vault.list();

      if (allSecrets.size === 0) return null;

      const secrets: ExportedSecret[] = [];
      for (const [name, entry] of allSecrets) {
        const meta = metadata.find(m => m.name === name);
        secrets.push({
          name,
          value: entry.value,
          scope: entry.scope,
          ttlMs: entry.ttlMs,
          createdAt: meta?.createdAt,
          updatedAt: meta?.updatedAt,
        });
      }

      const data = Buffer.from(JSON.stringify(secrets), 'utf-8');

      return {
        meta: {
          seq: 0, // assigned later
          type: 'secrets',
          name: 'vault_secrets',
          originalSize: data.length,
          checksum: sha256(data),
        },
        data,
      };
    } finally {
      vault.close();
    }
  }

  /**
   * A `VACUUM INTO` snapshot of the database (a consistent, defragmented copy), read into a Buffer;
   * the file is removed. It holds what the store holds: ciphertext in the encrypted columns. A
   * file left at the snapshot's path by an export that was killed is removed first: `VACUUM INTO`
   * refuses an existing file, which would block every later export.
   */
  private snapshotDatabase(dbName: string): Buffer | null {
    const srcPath = join(this.lynoxDir, dbName);
    if (!existsSync(srcPath)) return null;

    const tmpPath = join(this.lynoxDir, `${dbName}.migration-tmp`);
    try { unlinkSync(tmpPath); } catch { /* none left */ }
    snapshotSqlite(srcPath, tmpPath);

    try {
      return readFileSync(tmpPath);
    } finally {
      try { unlinkSync(tmpPath); } catch { /* ok */ }
    }
  }

  private collectArtifacts(): PlaintextChunk | null {
    const artifactsDir = join(this.lynoxDir, 'artifacts');
    const indexPath = join(artifactsDir, 'index.json');
    if (!existsSync(indexPath)) return null;

    try {
      const indexData = readFileSync(indexPath, 'utf-8');
      const index = JSON.parse(indexData) as Array<{ id: string; [key: string]: unknown }>;
      if (index.length === 0) return null;

      // Bundle index + all content files into a single JSON payload
      const bundle: { index: unknown[]; files: Record<string, string> } = {
        index,
        files: {},
      };

      for (const entry of index) {
        // Validate artifact ID format before reading (prevents path traversal)
        if (!/^[a-f0-9-]{8}$/.test(entry.id)) continue;
        const contentPath = join(artifactsDir, `${entry.id}.html`);
        if (existsSync(contentPath)) {
          bundle.files[entry.id] = readFileSync(contentPath, 'utf-8');
        }
      }

      const data = Buffer.from(JSON.stringify(bundle), 'utf-8');

      return {
        meta: {
          seq: 0,
          type: 'artifacts',
          name: 'artifacts',
          originalSize: data.length,
          checksum: sha256(data),
        },
        data,
      };
    } catch {
      return null;
    }
  }

  /**
   * Bundle the flat-file memory tree.
   *
   * Layout is `memory/<scopeDir>/<namespace>.txt` (see `Memory._scopeFilePath`).
   * Keys are the relative `<scopeDir>/<namespace>.txt` paths, validated by the
   * same predicate the importer applies. Unknown files and nested directories
   * are skipped — the importer reconstructs only what it recognises.
   *
   * `Memory` trims each namespace file to MAX_MEMORY_FILE_BYTES (256 KiB), so a
   * scope holds at most ~1 MiB — but a tenant with enough contexts still passes
   * MAX_CHUNK_BYTES, which `encryptChunk` rejects by throwing. Hence the split.
   *
   * Deliberately NOT wrapped in a catch-all: an unreadable `memory/` must fail
   * the migration loudly rather than hand the user a "success" that quietly
   * dropped the store their memory_* tools read. Only per-entry races and
   * broken symlinks are skipped.
   */
  private collectMemory(): PlaintextChunk[] {
    const memoryDir = join(this.lynoxDir, 'memory');
    if (!existsSync(memoryDir)) return [];

    const files: Record<string, string> = {};

    for (const scopeDir of readdirSync(memoryDir)) {
      const scopePath = join(memoryDir, scopeDir);
      try {
        if (!statSync(scopePath).isDirectory()) continue;
      } catch { continue; } // broken symlink — not a scope we can carry

      for (const fileName of readdirSync(scopePath)) {
        const key = `${scopeDir}/${fileName}`;
        // Same predicate the importer applies — one source of truth, so the two
        // sides cannot drift into exporting what cannot be restored.
        if (!parsePortableMemoryKey(key)) continue;
        const filePath = join(scopePath, fileName);
        try {
          if (!statSync(filePath).isFile()) continue;
          files[key] = readFileSync(filePath, 'utf-8');
        } catch { continue; } // vanished between readdir and read
      }
    }

    if (Object.keys(files).length === 0) return [];

    return splitIntoChunks(Buffer.from(JSON.stringify({ files }), 'utf-8'), 'memory', 'memory');
  }

  /**
   * The merge ledgers under `sweeps/`. Without these a migrated instance keeps every
   * merged subject and loses the only thing that could undo one — `rollbackMergeRun`
   * takes a ledger file and nothing else. Sweep/archive ledgers from the operator CLI
   * are deliberately NOT carried: they describe an archive phase against subject ids on
   * the source instance and are not a reversal record for a merge.
   */
  /** The merge ledgers by file name, as stored; null when there are none. */
  private readSweeps(): Record<string, string> | null {
    const sweepsDir = join(this.lynoxDir, 'sweeps');
    if (!existsSync(sweepsDir)) return null;

    const files: Record<string, string> = {};
    for (const fileName of readdirSync(sweepsDir)) {
      // Same predicate the importer applies — one source of truth, so the two sides
      // cannot drift into exporting what cannot be restored.
      if (!isMergeLedgerFileName(fileName)) continue;
      const filePath = join(sweepsDir, fileName);
      try {
        // lstat, NOT stat: a symlink here would otherwise be read THROUGH, and whatever
        // it points at (vault.db, a host key) would ride the migration bundle out under a
        // ledger's name. Only a real file is a ledger.
        if (!lstatSync(filePath).isFile()) continue;
        files[fileName] = readFileSync(filePath, 'utf-8');
      } catch { continue; } // vanished between readdir and read
    }

    if (Object.keys(files).length === 0) return null;
    return files;
  }

  /**
   * A portable directory whose contents are opaque to us — `apis/` holds connection
   * definitions, `workspace/` is the file area the fs tools write into. Both can contain
   * BINARY payloads (a measured instance had a .docx in its file area), so entries are
   * base64, not utf-8: decoding a .docx as text and re-encoding it destroys the file while
   * every test that only round-trips ASCII stays green.
   *
   * Symlinks are skipped rather than followed — the same reason as `readSweeps`: a link
   * planted here would otherwise carry whatever it points at out inside the bundle.
   */
  private collectPortableDir(dirName: string): PlaintextChunk[] {
    if (dirName === 'workspace') return this.collectWorkspace();
    const root = join(this.lynoxDir, dirName);
    if (!existsSync(root)) return [];

    const maxEntries = this.portableDirLimits?.maxEntries ?? MAX_PORTABLE_DIR_ENTRIES;
    const maxBytes = this.portableDirLimits?.maxBytes ?? MAX_PORTABLE_DIR_BYTES;
    const files: Record<string, string> = {};
    let total = 0;
    let truncated = false;

    const walk = (rel: string): void => {
      if (truncated) return;
      const abs = rel === '' ? root : join(root, rel);
      let entries: string[];
      try { entries = readdirSync(abs); } catch { return; }
      for (const name of entries) {
        const childRel = rel === '' ? name : `${rel}/${name}`;
        const childAbs = join(abs, name);
        let st;
        try { st = lstatSync(childAbs); } catch { continue; }
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) { walk(childRel); continue; }
        if (!st.isFile()) continue;
        if (!isPortableDirEntryName(childRel)) continue;
        // Both caps enforced HERE as well as on import. Without the entry cap the exporter
        // happily builds a 20 001-file bundle the importer then rejects — after it has
        // already restored the databases. `break`, not `continue`: skipping past a cap and
        // admitting whatever smaller files come next is a silent, order-dependent partial
        // export, which is worse than stopping.
        if (Object.keys(files).length >= maxEntries) { truncated = true; break; }
        if (total + st.size > maxBytes) { truncated = true; break; }
        try {
          files[childRel] = readFileSync(childAbs).toString('base64');
          total += st.size;
        } catch { continue; } // vanished between lstat and read
      }
    };
    walk('');

    if (Object.keys(files).length === 0) return [];
    if (truncated) {
      // Loud, not silent. A bounded export that says nothing reads exactly like a complete
      // one — the shape this whole change exists to remove from the coverage lists.
      throw new Error(
        `${dirName}/ exceeds the migration limits (${String(maxEntries)} entries / ${String(maxBytes)} bytes) — refusing to ship a partial copy of it`,
      );
    }
    return splitIntoChunks(
      Buffer.from(JSON.stringify({ dir: dirName, files }), 'utf-8'),
      'portable_dir',
      dirName,
    );
  }

  /**
   * The workspace, read through its root's anchor: the root may live outside the data dir. Same
   * bundle as every portable directory (`dir: 'workspace'`), the same name rule and caps. A
   * link, a special file or a name that is not UTF-8 is skipped and named in `skipped`; a mount
   * below the root or a file that cannot be read fails the export, never a silent gap.
   *
   * In shell sidecar mode it walks nothing (PRD D7, walker 2): the tree is shared with the pool
   * uids, and a walk throws on the first directory one of them closed. The workspace is left out
   * and recorded in the result; it never throws for the mode, so everything else is exported.
   */
  private collectWorkspace(isolation: ShellIsolation = shellIsolation()): PlaintextChunk[] {
    if (isolation.kind === 'sidecar') { this.workspaceOmitted = true; return []; }
    const lease = leaseWorkspaceFor(this.lynoxDir);
    if (lease === null) return [];
    const maxEntries = this.portableDirLimits?.maxEntries ?? MAX_PORTABLE_DIR_ENTRIES;
    const maxBytes = this.portableDirLimits?.maxBytes ?? MAX_PORTABLE_DIR_BYTES;
    const files: Record<string, string> = {};
    let count = 0;
    let total = 0;
    const tooBig = new Error(
      `workspace/ exceeds the migration limits (${String(maxEntries)} entries / ${String(maxBytes)} bytes) — refusing to ship a partial copy of it`,
    );
    try {
      const data = statSync(this.lynoxDir);
      const copied = copyOut(lease.access.anchor, '', (rel, fd, size) => {
        if (!isPortableDirEntryName(rel)) { this.skipped.push(`workspace/${rel}`); return; }
        if (count >= maxEntries || total + size > maxBytes) throw tooBig;
        files[rel] = readFileSync(fd).toString('base64');
        count++;
        total += size;
      }, undefined, { dev: data.dev, ino: data.ino });
      this.skipped.push(...copied.skipped.map(rel => `workspace/${rel}`));
    } finally {
      lease.release();
    }
    if (count === 0) return [];
    return splitIntoChunks(
      Buffer.from(JSON.stringify({ dir: 'workspace', files }), 'utf-8'),
      'portable_dir',
      'workspace',
    );
  }

  private collectConfig(): PlaintextChunk | null {
    const configPath = join(this.lynoxDir, 'config.json');
    if (!existsSync(configPath)) return null;

    try {
      const raw = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;

      // Only include safe fields — never migrate credentials or paths
      const sanitized: Record<string, unknown> = {};
      for (const field of SAFE_CONFIG_FIELDS) {
        if (field in raw) {
          sanitized[field] = raw[field];
        }
      }

      if (Object.keys(sanitized).length === 0) return null;

      const data = Buffer.from(JSON.stringify(sanitized), 'utf-8');

      return {
        meta: {
          seq: 0,
          type: 'config',
          name: 'config',
          originalSize: data.length,
          checksum: sha256(data),
        },
        data,
      };
    } catch {
      return null;
    }
  }
}
