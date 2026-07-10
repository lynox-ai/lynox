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

import { existsSync, readFileSync, unlinkSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { getLynoxDir } from './config.js';
import { SecretVault } from './secret-vault.js';
import { parsePortableMemoryKey } from './memory-file.js';
import type { SecretScope } from '../types/index.js';
import {
  encryptChunk,
  computeManifestHash,
  sha256,
  MAX_CHUNK_BYTES,
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
}

interface PlaintextChunk {
  meta: MigrationChunkMeta;
  data: Buffer;
}

// ── Constants ──

// Foundation Rework v2: engine.db (the subject-graph) is portable user data and
// must migrate with the rest. Safe to list before it has data — the export loop
// skips any DB that doesn't exist (existsSync guard below), so a pre-S0 or
// flag-off (empty/absent engine.db) instance migrates it harmlessly.
const SQLITE_DBS = ['history.db', 'agent-memory.db', 'datastore.db', 'engine.db'] as const;

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

  constructor(options?: { lynoxDir?: string | undefined; vaultKey?: string | undefined } | undefined) {
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
  export(transferKey: Buffer, onProgress?: ProgressCallback | undefined): ExportResult {
    // Phase 1: Collect plaintext chunks
    const plaintextChunks: PlaintextChunk[] = [];

    onProgress?.({ phase: 'collecting', currentChunk: 0, totalChunks: 0, currentName: 'secrets' });

    // 1. Secrets — decrypt from local vault
    const secretsChunk = this.collectSecrets();
    if (secretsChunk) plaintextChunks.push(secretsChunk);

    // 2. SQLite databases — VACUUM INTO temp copies
    for (const dbName of SQLITE_DBS) {
      onProgress?.({ phase: 'collecting', currentChunk: plaintextChunks.length, totalChunks: 0, currentName: dbName });
      const dbChunks = this.collectDatabase(dbName);
      plaintextChunks.push(...dbChunks);
    }

    // 3. Artifacts
    onProgress?.({ phase: 'collecting', currentChunk: plaintextChunks.length, totalChunks: 0, currentName: 'artifacts' });
    const artifactChunk = this.collectArtifacts();
    if (artifactChunk) plaintextChunks.push(artifactChunk);

    // 4. Memory — the flat-file store the memory_* tools actually read
    onProgress?.({ phase: 'collecting', currentChunk: plaintextChunks.length, totalChunks: 0, currentName: 'memory' });
    plaintextChunks.push(...this.collectMemory());

    // 5. Config (sanitized)
    const configChunk = this.collectConfig();
    if (configChunk) plaintextChunks.push(configChunk);

    // Assign sequence numbers
    const chunkMetas: MigrationChunkMeta[] = plaintextChunks.map((c, i) => ({
      ...c.meta,
      seq: i,
    }));

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

    return { manifest, chunks: encryptedChunks };
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

  private collectDatabase(dbName: string): PlaintextChunk[] {
    const srcPath = join(this.lynoxDir, dbName);
    if (!existsSync(srcPath)) return [];

    // VACUUM INTO creates a consistent, defragmented copy
    const tmpPath = join(this.lynoxDir, `${dbName}.migration-tmp`);
    let db: InstanceType<typeof Database> | null = null;
    try {
      db = new Database(srcPath, { readonly: true });
      const safePath = tmpPath.replace(/'/g, "''");
      db.exec(`VACUUM INTO '${safePath}'`);
    } finally {
      try { db?.close(); } catch { /* ignore */ }
    }

    try {
      return splitIntoChunks(readFileSync(tmpPath), 'sqlite_db', dbName);
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
