import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { EngineDb } from './engine-db.js';
import { SecretVault } from './secret-vault.js';
import { MigrationExporter } from './migration-export.js';
import { MigrationImporter, type ImportProgressCallback } from './migration-import.js';
import {
  generateEphemeralKeypair,
  serializePublicKey,
  deserializePublicKey,
  deriveTransferKey,
} from './migration-crypto.js';

// A restore refuses, before any database is swapped in, what would otherwise stop it after the
// swap: a part of the bundle that does not decode, and a destination that cannot take a part
// (a link where a directory belongs, a flat profile step 6b refuses).
// See migration-import.ts (`prepareRest`, `checkDestination`).

const VAULT_KEY = 'checks-first-restore-test-key-2026';
const DBS = ['engine.db', 'history.db', 'datastore.db', 'agent-memory.db'] as const;
const NEW_HALF_LIFE = 11;
const OLD_HALF_LIFE = 99;
const LEDGER = 'merge-2026-10-20T10-00-00-000Z-abc.json';
const SECRET_NAME = 'RESTORE_WITNESS_NOTE';
const ARTIFACT_ID = 'a1b2c3d4';

// Each test seeds two data dirs and runs a full export and import: seconds on a loaded machine.
describe('migration restore — what can refuse is refused before the swap', { timeout: 30_000 }, () => {
  const dirs: string[] = [];
  const origTier = process.env['LYNOX_BILLING_TIER'];

  afterEach(() => {
    if (origTier === undefined) delete process.env['LYNOX_BILLING_TIER'];
    else process.env['LYNOX_BILLING_TIER'] = origTier;
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function tmp(): string {
    const d = mkdtempSync(join(tmpdir(), 'lynox-restore-checks-'));
    dirs.push(d);
    return d;
  }

  /** The four databases, each carrying `tag`, and a config with a field the restore merges. */
  function seed(dir: string, tag: 'new' | 'old'): void {
    new EngineDb(join(dir, 'engine.db'), VAULT_KEY).close();
    for (const db of DBS) {
      const d = new Database(join(dir, db));
      try {
        d.exec('CREATE TABLE IF NOT EXISTS zz_mark (v TEXT)');
        d.prepare('INSERT INTO zz_mark (v) VALUES (?)').run(tag);
      } finally {
        d.close();
      }
    }
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ memory_half_life_days: tag === 'new' ? NEW_HALF_LIFE : OLD_HALF_LIFE }));
  }

  /** Every part after the databases, one witness each. */
  function seedRest(src: string, withApis = true): void {
    mkdirSync(join(src, 'memory', 'global'), { recursive: true });
    writeFileSync(join(src, 'memory', 'global', 'knowledge.txt'), 'restored memory\n');
    mkdirSync(join(src, 'sweeps'));
    writeFileSync(join(src, 'sweeps', LEDGER), JSON.stringify({ version: 1, phase: 'merge' }));
    mkdirSync(join(src, 'artifacts'));
    writeFileSync(join(src, 'artifacts', 'index.json'), JSON.stringify([{ id: ARTIFACT_ID, title: 'restored' }]));
    writeFileSync(join(src, 'artifacts', `${ARTIFACT_ID}.html`), '<p>restored</p>');
    mkdirSync(join(src, 'workspace'));
    writeFileSync(join(src, 'workspace', 'notes.txt'), 'restored workspace');
    if (withApis) {
      mkdirSync(join(src, 'apis', 'sub'), { recursive: true });
      writeFileSync(join(src, 'apis', 'sub', 'notes.json'), JSON.stringify({ restored: true }));
    }
    const vault = new SecretVault({ path: join(src, 'vault.db'), masterKey: VAULT_KEY });
    try { vault.set(SECRET_NAME, ['restored', 'witness'].join('-')); } finally { vault.close(); }
  }

  function markOf(path: string): string {
    const d = new Database(path, { readonly: true });
    try {
      return (d.prepare('SELECT v FROM zz_mark').get() as { v: string }).v;
    } finally {
      d.close();
    }
  }
  const marks = (dir: string): Record<string, string> => Object.fromEntries(DBS.map((db) => [db, markOf(join(dir, db))]));
  const halfLife = (dir: string): unknown =>
    (JSON.parse(readFileSync(join(dir, 'config.json'), 'utf-8')) as { memory_half_life_days?: unknown }).memory_half_life_days;
  const secretOf = (dir: string): string | null => {
    if (!existsSync(join(dir, 'vault.db'))) return null;
    const vault = new SecretVault({ path: join(dir, 'vault.db'), masterKey: VAULT_KEY });
    try { return vault.get(SECRET_NAME); } finally { vault.close(); }
  };
  /** Which parts after the databases landed on `dst`. */
  const landed = (dst: string): Record<string, boolean> => ({
    memory: existsSync(join(dst, 'memory', 'global', 'knowledge.txt')),
    ledger: existsSync(join(dst, 'sweeps', LEDGER)),
    artifact: existsSync(join(dst, 'artifacts', `${ARTIFACT_ID}.html`)),
    apis: existsSync(join(dst, 'apis', 'sub', 'notes.json')),
    workspace: existsSync(join(dst, 'workspace', 'notes.txt')),
    secret: secretOf(dst) !== null,
  });
  const nothingLanded = { memory: false, ledger: false, artifact: false, apis: false, workspace: false, secret: false };

  /** A full bundle from `src`, received by an importer on `dst`; `damage` may alter a chunk before the restore. */
  function receive(src: string, dst: string, damage?: (chunkOf: (name: string) => Buffer) => void): MigrationImporter {
    const importer = new MigrationImporter({ lynoxDir: dst, vaultKey: VAULT_KEY });
    const handshake = importer.startHandshake('c'.repeat(64));
    const keypair = generateEphemeralKeypair();
    const key = deriveTransferKey(keypair.privateKey, deserializePublicKey(handshake.serverPubKey), Buffer.from(handshake.challengeNonce, 'hex'));
    importer.completeHandshake(serializePublicKey(keypair.publicKey));
    const { manifest, chunks } = new MigrationExporter({ lynoxDir: src, vaultKey: VAULT_KEY }).export(key);
    importer.setManifest(manifest);
    for (const chunk of chunks) importer.receiveChunk(chunk);
    if (damage) {
      const received = (importer as unknown as { session: { receivedChunks: Map<number, Buffer> } }).session.receivedChunks;
      damage((name) => {
        const meta = manifest.chunks.find((c) => c.name === name);
        if (!meta) throw new Error(`fixture: no chunk ${name}`);
        return received.get(meta.seq)!;
      });
    }
    return importer;
  }

  /** Source and destination seeded, the destination prepared by `prep`. */
  function pair(prep: (dst: string, outside: string) => void, withApis = true): { src: string; dst: string; outside: string } {
    const src = tmp(); const dst = tmp(); const outside = tmp();
    seed(src, 'new'); seedRest(src, withApis);
    seed(dst, 'old');
    prep(dst, outside);
    return { src, dst, outside };
  }

  /** The restore threw before the swap: every database, the config and every later part as they were. */
  function expectUntouched(dst: string): void {
    expect(marks(dst)).toEqual({ 'engine.db': 'old', 'history.db': 'old', 'datastore.db': 'old', 'agent-memory.db': 'old' });
    expect(halfLife(dst), 'config not applied').toBe(OLD_HALF_LIFE);
    expect(landed(dst), 'no later part landed').toEqual(nothingLanded);
    expect(readdirSync(dst).filter((f) => f.includes('migration-tmp')), 'no staged copy').toEqual([]);
  }

  it('control: every part lands, so each witness can see it', () => {
    delete process.env['LYNOX_BILLING_TIER'];
    const { src, dst } = pair(() => { /* nothing */ });

    receive(src, dst).restore();

    expect(marks(dst)).toEqual({ 'engine.db': 'new', 'history.db': 'new', 'datastore.db': 'new', 'agent-memory.db': 'new' });
    expect(halfLife(dst)).toBe(NEW_HALF_LIFE);
    expect(landed(dst)).toEqual({ memory: true, ledger: true, artifact: true, apis: true, workspace: true, secret: true });
  });

  // Each part after the databases, damaged two ways: bytes that do not parse, and a payload that
  // parses to `null` (padded with spaces to the chunk's length), which every later step read as an object.
  const PARTS = ['config', 'artifacts', 'memory', 'sweeps', 'apis', 'workspace', 'vault_secrets'] as const;
  it.each(PARTS)('a %s part that does not parse stops the restore before the swap', (part) => {
    delete process.env['LYNOX_BILLING_TIER'];
    const { src, dst } = pair(() => { /* nothing */ });

    expect(() => receive(src, dst, (chunkOf) => { chunkOf(part).fill(0x7b); }).restore()).toThrow(SyntaxError);

    expectUntouched(dst);
  });
  it.each(PARTS)('a %s part that is not an object stops the restore before the swap', (part) => {
    delete process.env['LYNOX_BILLING_TIER'];
    const { src, dst } = pair(() => { /* nothing */ });

    expect(() => receive(src, dst, (chunkOf) => { chunkOf(part).fill(0x20).write('null'); }).restore()).toThrow(/is malformed/);

    expectUntouched(dst);
  });

  it('a workspace root that cannot be opened stops the restore before the swap', () => {
    delete process.env['LYNOX_BILLING_TIER'];
    const { src, dst } = pair((d) => { writeFileSync(join(d, 'workspace'), 'a file where the root belongs'); });

    expect(() => receive(src, dst).restore()).toThrow(/workspace/);

    expect(readFileSync(join(dst, 'workspace'), 'utf-8')).toBe('a file where the root belongs');
    rmSync(join(dst, 'workspace'));   // so the witness below reads the absent file, not a path through a file
    expectUntouched(dst);
  });

  it('sweeps/ a link on the destination stops the restore before the swap', () => {
    delete process.env['LYNOX_BILLING_TIER'];
    const { src, dst, outside } = pair((d, o) => { symlinkSync(o, join(d, 'sweeps')); });

    expect(() => receive(src, dst).restore()).toThrow(/sweeps is not a real directory/);

    expectUntouched(dst);
    expect(readdirSync(outside), 'nothing written through the link').toEqual([]);
  });

  it('apis/ a link on the destination stops the restore before the swap', () => {
    delete process.env['LYNOX_BILLING_TIER'];
    const { src, dst, outside } = pair((d, o) => { symlinkSync(o, join(d, 'apis')); });

    expect(() => receive(src, dst).restore()).toThrow(/Refusing to restore apis: it is not a real directory/);

    expectUntouched(dst);
    expect(readdirSync(outside), 'nothing written through the link').toEqual([]);
  });

  /** Replace a chunk's payload with `json`, padded with spaces to the chunk's length. */
  const rewrite = (part: string, json: string) => (chunkOf: (name: string) => Buffer): void => {
    const buf = chunkOf(part);
    expect(Buffer.byteLength(json), `fixture: ${part} chunk long enough`).toBeLessThanOrEqual(buf.length);
    buf.fill(0x20).write(json);
  };

  it.each([
    ['a null entry', '[null]'],
    ['a value that is not a string', '[{"name":"A_NOTE","value":5}]'],
    ['a name the vault cannot take', '[{"name":true,"value":"v"}]'],
    ['a scope the vault does not know', '[{"name":"A_NOTE","value":"v","scope":"everywhere"}]'],
    ['a TTL the vault cannot take', '[{"name":"A_NOTE","value":"v","ttlMs":{}}]'],
  ])('secrets with %s stop the restore before the swap', (_case, json) => {
    delete process.env['LYNOX_BILLING_TIER'];
    const { src, dst } = pair(() => { /* nothing */ });

    expect(() => receive(src, dst, rewrite('vault_secrets', json)).restore()).toThrow(/the secrets in the bundle is malformed/);

    expectUntouched(dst);
  });

  it('an artifact whose content is not a string stops the restore before the swap', () => {
    delete process.env['LYNOX_BILLING_TIER'];
    const { src, dst } = pair(() => { /* nothing */ });

    expect(() => receive(src, dst, rewrite('artifacts', '{"index":[],"files":{"a1b2c3d4":5}}')).restore()).toThrow(/the artifacts in the bundle is malformed/);

    expectUntouched(dst);
  });

  it('secrets without a name or a value are passed over, as before', () => {
    delete process.env['LYNOX_BILLING_TIER'];
    const { src, dst } = pair(() => { /* nothing */ });

    const verification = receive(src, dst, rewrite('vault_secrets', '[{"name":"","value":5},{"name":"B_NOTE","value":""},"text",{"name":"C_NOTE","value":"kept"}]')).restore();

    expect(verification.secretsImported).toBe(1);
    expect(marks(dst)['engine.db']).toBe('new');
  });
  it('managed: a flat profile step 6b refuses stops the restore before the swap', () => {
    process.env['LYNOX_BILLING_TIER'] = 'starter';
    const { src, dst, outside } = pair((d, o) => {
      mkdirSync(join(d, 'apis'));
      writeFileSync(join(o, 'linked.json'), JSON.stringify({ id: 'linked', custom_endpoint_ack: true }));
      symlinkSync(join(o, 'linked.json'), join(d, 'apis', 'linked.json'));
    }, false);

    expect(() => receive(src, dst).restore()).toThrow(/apis\/linked\.json is not a regular file/);

    expectUntouched(dst);
  });

  it('managed: an entry the bundle replaces is not refused by the check', () => {
    process.env['LYNOX_BILLING_TIER'] = 'starter';
    const src = tmp(); const dst = tmp(); const outside = tmp();
    seed(src, 'new'); seed(dst, 'old');
    mkdirSync(join(src, 'apis'));
    writeFileSync(join(src, 'apis', 'shared.json'), JSON.stringify({ id: 'shared', from: 'bundle' }));
    mkdirSync(join(dst, 'apis'));
    writeFileSync(join(outside, 'shared.json'), JSON.stringify({ id: 'shared', custom_endpoint_ack: true }));
    symlinkSync(join(outside, 'shared.json'), join(dst, 'apis', 'shared.json'));

    receive(src, dst).restore();

    expect(marks(dst)['engine.db']).toBe('new');
    expect(JSON.parse(readFileSync(join(dst, 'apis', 'shared.json'), 'utf-8'))).toEqual({ id: 'shared', from: 'bundle' });
    expect(JSON.parse(readFileSync(join(outside, 'shared.json'), 'utf-8')), 'the link target untouched').toEqual({ id: 'shared', custom_endpoint_ack: true });
  });

  // The write steps ask the directory checks again: a link planted after phase 1 is refused there.
  it.each([
    ['sweeps', /sweeps is not a real directory/],
    ['apis', /Refusing to restore apis: it is not a real directory/],
  ])('%s/ turned into a link after phase 1 is refused by the step that writes it', (part, refusal) => {
    delete process.env['LYNOX_BILLING_TIER'];
    const { src, dst, outside } = pair(() => { /* nothing */ });
    const plant: ImportProgressCallback = (p) => {
      if (p.currentName !== part) return;
      rmSync(join(dst, part), { recursive: true, force: true });
      symlinkSync(outside, join(dst, part));
    };

    expect(() => receive(src, dst).restore(plant)).toThrow(refusal);

    expect(readdirSync(outside), 'nothing written through the link').toEqual([]);
  });
});
