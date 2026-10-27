import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { EngineDb } from './engine-db.js';
import { RunHistory } from './run-history.js';
import { ExactMirror } from './history-markers.js';
import { MigrationExporter } from './migration-export.js';
import { MigrationImporter } from './migration-import.js';
import { generateEphemeralKeypair, serializePublicKey, deserializePublicKey, deriveTransferKey } from './migration-crypto.js';

// An instance that holds the exact marker keeps it across a migration import that replaces its
// engine.db and history.db with a bundle's (cut S3-E, `migration-import.ts`). The marker and this
// instance's copy are written into the staged copies, before the swap.

const VAULT_KEY = 'exact-marker-import-test-key-2026';
const INSTANCE = 'inst-dst';

describe('migration import — the exact marker', { timeout: 30_000 }, () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  function tmp(): string {
    const d = mkdtempSync(join(tmpdir(), 'lynox-import-exact-'));
    dirs.push(d);
    return d;
  }

  function seed(dir: string, opts: { engineMarker?: boolean; copyFor?: string } = {}): void {
    const e = new EngineDb(join(dir, 'engine.db'), VAULT_KEY);
    if (opts.engineMarker) e.setExactMarker();
    e.close();
    const h = new RunHistory(join(dir, 'history.db'));
    if (opts.copyFor !== undefined) new ExactMirror(h.getDb(), opts.copyFor).set();
    h.close();
  }

  function importInto(src: string, dst: string): void {
    const importer = new MigrationImporter({ lynoxDir: dst, vaultKey: VAULT_KEY });
    const handshake = importer.startHandshake('b'.repeat(64));
    const keypair = generateEphemeralKeypair();
    const key = deriveTransferKey(keypair.privateKey, deserializePublicKey(handshake.serverPubKey), Buffer.from(handshake.challengeNonce, 'hex'));
    importer.completeHandshake(serializePublicKey(keypair.publicKey));
    const { manifest, chunks } = new MigrationExporter({ lynoxDir: src, vaultKey: VAULT_KEY }).export(key);
    importer.setManifest(manifest);
    for (const chunk of chunks) importer.receiveChunk(chunk);
    const verification = importer.restore();
    expect(verification.databasesRestored).toEqual(expect.arrayContaining(['engine.db', 'history.db']));
  }

  function state(dir: string): { engine: boolean; copy: string | null } {
    const e = new Database(join(dir, 'engine.db'), { readonly: true });
    const h = new Database(join(dir, 'history.db'), { readonly: true });
    try {
      return {
        engine: e.prepare('SELECT 1 FROM exact_marker WHERE id = 1').get() !== undefined,
        copy: (h.prepare('SELECT instance_id FROM exact_marker_mirror WHERE id = 1').get() as { instance_id: string } | undefined)?.instance_id ?? null,
      };
    } finally {
      e.close();
      h.close();
    }
  }

  const managed = (): void => {
    vi.stubEnv('LYNOX_MANAGED_CONTROL_PLANE_URL', 'https://cp.example.invalid');
    vi.stubEnv('LYNOX_MANAGED_INSTANCE_ID', INSTANCE);
    vi.stubEnv('LYNOX_HTTP_SECRET', 's');
  };

  it('a destination that holds the marker keeps it and its copy, though the bundle carries neither', () => {
    managed();
    const src = tmp(); const dst = tmp();
    seed(src); seed(dst, { engineMarker: true, copyFor: INSTANCE });
    importInto(src, dst);
    expect(state(dst)).toEqual({ engine: true, copy: INSTANCE });
  });

  it('held only by its own copy in history.db: kept as well', () => {
    managed();
    const src = tmp(); const dst = tmp();
    seed(src); seed(dst, { copyFor: INSTANCE });
    importInto(src, dst);
    expect(state(dst)).toEqual({ engine: true, copy: INSTANCE });
  });

  it('the control: a destination without the marker gets none', () => {
    managed();
    const src = tmp(); const dst = tmp();
    seed(src); seed(dst);
    importInto(src, dst);
    expect(state(dst)).toEqual({ engine: false, copy: null });
  });

  it('a destination carrying only another instance\'s copy is not held, and nothing is written', () => {
    managed();
    const src = tmp(); const dst = tmp();
    seed(src); seed(dst, { copyFor: 'someone-else' });
    importInto(src, dst);
    expect(state(dst)).toEqual({ engine: false, copy: null });
  });
});
