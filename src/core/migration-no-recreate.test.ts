import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
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

// EngineDb sets a corrupt database aside and opens an empty one in its place: right for the boot,
// which must start. The restore's own edits of engine.db open it the same way, and there an empty
// database took the place of the migrated one while the restore reported success. They now open
// it so that a failed check throws and the file stays where it is.
// In the restore tests the check fails inside the store's own open: `integrity_check` answers
// SQLITE_CORRUPT once, on the handle the edit opens. The boot's control takes a file whose header
// is overwritten.

const SRC_KEY = 'source-vault-key-no-recreate-2026';
const DST_KEY = 'dest-vault-key-no-recreate-2026';
const TOKEN = 'a'.repeat(64);

const profile = (id: string): ApiProfile => ({
  id, name: id, base_url: `https://${id}.example.com`, description: id,
  auth: { type: 'bearer', vault_keys: [`${id.toUpperCase()}_TOKEN`] },
  custom_endpoint_ack: { accepted: true, hosts: [`${id}.example.com`], accepted_at: '2026-07-03T00:00:00.000Z' },
  provenance: { source: 'manual', schema_version: 2 },
});

describe('the restore does not put an empty engine.db in place of the migrated one', () => {
  const dirs: string[] = [];
  const origTier = process.env['LYNOX_BILLING_TIER'];

  const tmp = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'lynox-no-recreate-'));
    dirs.push(d);
    return d;
  };
  const seed = (dir: string, key: string, ids: string[]): void => {
    const engine = new EngineDb(join(dir, 'engine.db'), key);
    try {
      const store = new ApiStore();
      store.setConnectionStore(new ConnectionStore(engine));
      for (const id of ids) store.save(profile(id));
    } finally {
      engine.close();
    }
  };
  const ids = (dir: string): string[] => {
    const db = new Database(join(dir, 'engine.db'), { readonly: true });
    try {
      return (db.prepare("SELECT id FROM connections WHERE kind = 'api' ORDER BY id").all() as { id: string }[]).map((r) => r.id);
    } finally {
      db.close();
    }
  };
  /** Descriptors of this process open on `file` (Linux: /proc/self/fd). */
  const openHandles = (file: string): number => readdirSync('/proc/self/fd').filter((fd) => {
    try { return readlinkSync(join('/proc/self/fd', fd)) === file; } catch { return false; }
  }).length;
  const leftovers = (dir: string): string[] => readdirSync(dir).filter((f) => f.includes('.corrupt-') || f.includes('.migration-tmp'));
  const migrate = (src: string, dst: string): void => {
    const exporter = new MigrationExporter({ lynoxDir: src, vaultKey: SRC_KEY });
    const importer = new MigrationImporter({ lynoxDir: dst, vaultKey: DST_KEY });
    const sh = importer.startHandshake(TOKEN);
    const kp = generateEphemeralKeypair();
    const key = deriveTransferKey(kp.privateKey, deserializePublicKey(sh.serverPubKey), Buffer.from(sh.challengeNonce, 'hex'));
    importer.completeHandshake(serializePublicKey(kp.publicKey));
    const { manifest, chunks } = exporter.export(key);
    importer.setManifest(manifest);
    for (const c of chunks) importer.receiveChunk(c);
    try {
      importer.restore();
    } finally {
      importer.cleanup();
    }
  };
  /**
   * `integrity_check` answers SQLITE_CORRUPT once, on the first writable handle whose file `when`
   * accepts, while `armed()` holds. A read-only handle (the restore's own byte check) is not touched.
   */
  const corruptOnce = (when: (file: string) => boolean, armed: () => boolean = () => true): { fired: () => boolean } => {
    let fired = false;
    const orig = Database.prototype.pragma;
    vi.spyOn(Database.prototype, 'pragma').mockImplementation(function (this: Database.Database, source: string, options?: Database.PragmaOptions) {
      if (!fired && source === 'integrity_check' && !this.readonly && when(this.name) && armed()) {
        fired = true;
        throw new Database.SqliteError('database disk image is malformed', 'SQLITE_CORRUPT');
      }
      return orig.call(this, source, options);
    });
    return { fired: () => fired };
  };

  afterEach(() => {
    vi.restoreAllMocks();
    if (origTier === undefined) delete process.env['LYNOX_BILLING_TIER'];
    else process.env['LYNOX_BILLING_TIER'] = origTier;
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('control: without a failed check the managed restore lands the migrated engine.db', () => {
    const src = tmp();
    const dst = tmp();
    seed(src, SRC_KEY, ['alpha', 'beta']);
    seed(dst, DST_KEY, ['old']);
    process.env['LYNOX_BILLING_TIER'] = 'starter';
    migrate(src, dst);
    expect(ids(dst)).toEqual(['alpha', 'beta']);
    expect(leftovers(dst)).toEqual([]);
  });

  it('a failed check in the re-gate of the staged copy stops the restore, and the engine.db in place stays', () => {
    const src = tmp();
    const dst = tmp();
    seed(src, SRC_KEY, ['alpha', 'beta']);
    seed(dst, DST_KEY, ['old']);
    const before = readFileSync(join(dst, 'engine.db'));
    process.env['LYNOX_BILLING_TIER'] = 'starter';
    const failed = corruptOnce((f) => f.endsWith('engine.db.migration-tmp'));
    expect(() => migrate(src, dst)).toThrow();
    expect(failed.fired()).toBe(true);
    expect(readFileSync(join(dst, 'engine.db')).equals(before), 'the engine.db in place was replaced').toBe(true);
    expect(leftovers(dst)).toEqual([]);
  });

  it('a failed check in the store strip after the swap stops the restore, and the migrated engine.db stays', () => {
    const src = tmp();
    const dst = tmp();
    seed(src, SRC_KEY, ['alpha', 'beta']);
    seed(dst, DST_KEY, ['old']);
    delete process.env['LYNOX_BILLING_TIER'];
    let inStrip = false;
    const strip = ApiStore.stripStoreConnectionsOnImport.bind(ApiStore);
    vi.spyOn(ApiStore, 'stripStoreConnectionsOnImport').mockImplementation((...args: Parameters<typeof ApiStore.stripStoreConnectionsOnImport>) => {
      inStrip = true;
      try { return strip(...args); } finally { inStrip = false; }
    });
    const failed = corruptOnce((f) => f === join(dst, 'engine.db'), () => inStrip);
    expect(() => migrate(src, dst)).toThrow();
    expect(failed.fired()).toBe(true);
    expect(ids(dst), 'the migrated engine.db was set aside for an empty one').toEqual(['alpha', 'beta']);
    expect(leftovers(dst)).toEqual([]);
  });

  it('control: the boot still sets a corrupt database aside and starts on an empty one', () => {
    const dir = tmp();
    seed(dir, DST_KEY, ['old']);
    const file = join(dir, 'engine.db');
    const bytes = readFileSync(file);
    bytes.fill(0x41, 0, 100); // the header: no longer an SQLite file
    writeFileSync(file, bytes);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const engine = new EngineDb(file, DST_KEY, { onCorruption: 'recreate' }); // as the boot opens it
    engine.close();
    expect(ids(dir)).toEqual([]);
    expect(readdirSync(dir).some((f) => /^engine\.db\.corrupt-\d+$/.test(f))).toBe(true);
  });

  it('opened to be edited, a database it cannot check throws, closes its handle, and stays in place', () => {
    const dir = tmp();
    seed(dir, DST_KEY, ['old']);
    const before = readFileSync(join(dir, 'engine.db'));
    const failed = corruptOnce((f) => f === join(dir, 'engine.db'));
    expect(() => new EngineDb(join(dir, 'engine.db'), DST_KEY, { onCorruption: 'throw' })).toThrow(/malformed/);
    expect(failed.fired()).toBe(true);
    expect(readFileSync(join(dir, 'engine.db')).equals(before)).toBe(true);
    expect(leftovers(dir)).toEqual([]);
    // The handle is closed: no descriptor of this process still points at the file.
    expect(openHandles(join(dir, 'engine.db'))).toBe(0);
    expect(ids(dir)).toEqual(['old']);
  });
});
