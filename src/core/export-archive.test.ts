import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { EngineDb } from './engine-db.js';
import { RunHistory } from './run-history.js';
import { SecretVault } from './secret-vault.js';
import { exportMaskValues, maskSecretsAndPatterns, shiftedBase64 } from './secret-store.js';
import { EXPORT_TABLES, type ExportedStore } from './export-tables.js';
import { DATA_DIR_INVENTORY } from './data-dir-inventory.js';
import {
  acquireSlot, EXPORT_SLOT_FILE, EXPORT_SLOT_TTL_MS, readSlot, releaseSlotByJob, sweepSlot,
} from './export-slot.js';
import {
  ARCHIVE_DIR_PREFIX, MANIFEST_NAME, openVerified, resolvesTo, WITHHELD_SECRET_MARKER, prepareArchive, README_NAME, removeArchive, renderReadme, stagedExportDirs, sweepStagedArchives, sweepStaleExports,
  UNDECRYPTABLE_MARKER, type ArchiveManifest,
} from './export-archive.js';
import { _setFreeBytesForTesting, EXPORT_STAGING_DIR, ExportSpaceError, GUARD_READ_CAP_BYTES, guardContent } from './workspace-export.js';
import { isNoSpace } from '../scripts/export-archive.js';

const SCRIPT = join(import.meta.dirname, '..', 'scripts', 'export-archive.ts');

/** Every file below `root`, with its bytes. */
function filesUnder(root: string): Array<{ rel: string; bytes: Buffer }> {
  const out: Array<{ rel: string; bytes: Buffer }> = [];
  const visit = (rel: string): void => {
    for (const name of readdirSync(join(root, rel))) {
      const r = rel ? `${rel}/${name}` : name;
      const st = statSync(join(root, r));
      if (st.isDirectory()) visit(r);
      else out.push({ rel: r, bytes: readFileSync(join(root, r)) });
    }
  };
  visit('');
  return out;
}

function runCommand(dataDir: string, vaultKey: string, extra: string[] = []): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ['--import', 'tsx', SCRIPT, `--data-dir=${dataDir}`, ...extra], {
    env: { PATH: process.env['PATH'] ?? '', HOME: dataDir, LYNOX_VAULT_KEY: vaultKey },
    encoding: 'utf8',
    timeout: 120_000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function readJsonl(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, 'utf8').split('\n').filter(l => l !== '').map(l => JSON.parse(l) as Record<string, unknown>);
}

describe('the export command (a real engine data dir, a separate process)', () => {
  let dir: string;
  let out: string;
  // Built at RUNTIME: a key-shaped literal in a fixture is what the commit-time secret scan looks for.
  const vaultKey = `vk-${randomBytes(16).toString('hex')}`;
  const planted = `PLANTED${randomBytes(12).toString('hex')}`;
  const plantedConfig = `cfg${randomBytes(12).toString('hex')}`;
  const keyedChecksum = `KEYEDSUM${randomBytes(8).toString('hex')}`;
  // A JSON-blob secret (as OAuth tokens are stored): its refresh token can appear on its own.
  const refreshTok = `rt${randomBytes(12).toString('hex')}`;
  // A value with characters that JSON and URLs escape: its escaped and encoded forms differ from it.
  const quoted = `qq"${randomBytes(6).toString('hex')}\\zz /&?`;
  // A value whose base64 forms are below every generic token pattern (checked below), so only the
  // export's own forms mask them; base64 'Pz8/' and base64url 'Pz8_' differ, so neither form's
  // mask covers the other's witness.
  const shortB64 = '???';
  // A two-character secret: masked in text, but too short to withhold a binary file over.
  const tiny = 'Q7';
  // Exactly the shortest form the byte scan looks for: found in a binary file.
  const eight = `e${randomBytes(4).toString('hex').slice(0, 7)}`;
  // Exactly the shortest JSON leaf the masker hides on its own.
  const leaf12 = `lf${randomBytes(5).toString('hex')}`;
  const forms = {
    planted,
    plantedConfig,
    refreshTok,
    leaf12,
    quoted,
    quotedJsonOnce: JSON.stringify(quoted).slice(1, -1),
    quotedJsonTwice: JSON.stringify(JSON.stringify(quoted).slice(1, -1)).slice(1, -1),
    shortB64: Buffer.from(shortB64).toString('base64'),
    shortB64url: Buffer.from(shortB64).toString('base64url'),
    quotedUrl: encodeURIComponent(quoted),
  };
  let first: { job: string; dir: string; path: string; size: number; may_be_incomplete: boolean };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-export-archive-'));
    out = mkdtempSync(join(tmpdir(), 'lynox-export-archive-out-'));
    const vault = new SecretVault({ path: join(dir, 'vault.db'), masterKey: vaultKey });
    vault.set('CUSTOMER_TOKEN', planted);
    vault.set('GOOGLE_OAUTH', JSON.stringify({ token_type: 'Bearer', refresh_token: refreshTok, id12: leaf12 }));
    vault.set('EIGHT_SECRET', eight);
    vault.set('QUOTED_SECRET', quoted);
    vault.set('SHORT_SECRET', shortB64);
    vault.set('TINY_SECRET', tiny);
    vault.close();

    const engine = new EngineDb(join(dir, 'engine.db'), vaultKey);
    const db = engine.getDb();
    // A column the map does NOT list as encrypted, holding a value encrypted under the store key:
    // the export decrypts every text value strictly, so it reads plain.
    db.prepare('INSERT INTO threads (id, title) VALUES (?, ?)').run('t-enc', engine.enc('thread title readable'));
    // A value that carries the prefix and does not decrypt: marked, never written as it is.
    db.prepare('INSERT INTO threads (id, title) VALUES (?, ?)').run('t-bad', 'enc:AAAAnotciphertext');
    // Each form of a vault value in a plain column: the refresh token alone, JSON-escaped once and
    // twice (a tool result inside a JSON column), base64 and URL-encoded.
    db.prepare('INSERT INTO threads (id, title) VALUES (?, ?)').run('t-rt', `token ${refreshTok} end`);
    db.prepare('INSERT INTO threads (id, title) VALUES (?, ?)').run('t-q', `raw ${quoted} end`);
    db.prepare('INSERT INTO threads (id, title) VALUES (?, ?)').run('t-leaf', `leaf ${leaf12} end`);
    // Bytes in a column: one holding a vault value is withheld, one without goes out as base64.
    db.prepare('INSERT INTO threads (id, title) VALUES (?, ?)').run('t-blob', Buffer.concat([Buffer.from([0, 9]), Buffer.from(planted), Buffer.from([7])]));
    db.prepare('INSERT INTO threads (id, title) VALUES (?, ?)').run('t-blob-ok', Buffer.from([0, 9, 8, 7]));
    db.prepare('INSERT INTO threads (id, title) VALUES (?, ?)').run('t-j1', `{"v":"${forms.quotedJsonOnce}"}`);
    db.prepare('INSERT INTO threads (id, title) VALUES (?, ?)').run('t-j2', `"{\\"v\\":\\"${forms.quotedJsonTwice}\\"}"`);
    db.prepare('INSERT INTO threads (id, title) VALUES (?, ?)').run('t-b64', `b64 ${forms.shortB64} end`);
    db.prepare('INSERT INTO threads (id, title) VALUES (?, ?)').run('t-b64u', `b64 ${forms.shortB64url} end`);
    db.prepare('INSERT INTO threads (id, title) VALUES (?, ?)').run('t-url', `https://x.example/?q=${forms.quotedUrl}`);
    db.prepare(`INSERT INTO workflow_grants (id, workflow_id, contract_json, accepted_by, accepted_at, checksum, binding, trigger_id, cron, bound_params_json, after_untrusted)
      VALUES ('g1', 'w1', '{}', 'owner', '2026-11-09', ?, 'b', 'tr', '* * * * *', '{}', 0)`).run(keyedChecksum);
    engine.close();

    const history = new RunHistory(join(dir, 'history.db'), vaultKey);
    const runId = history.insertRun({ taskText: `summarise the report and use ${planted}`, modelTier: 'balanced', modelId: 'm' });
    history.insertToolCall({ runId, toolName: 'http', inputJson: JSON.stringify({ token: planted }), outputJson: JSON.stringify({ body: 'tool output visible' }), durationMs: 1, sequenceOrder: 0 });
    history.close();

    mkdirSync(join(dir, 'memory'), { recursive: true });
    writeFileSync(join(dir, 'memory', 'notes.md'), 'memory note visible');
    // A vault value inside an ordinary text file, under a harmless name: masked.
    writeFileSync(join(dir, 'memory', 'plain.md'), `note mentions ${planted} and ${refreshTok} here`);
    // A credential's name inside an included directory: skipped and listed, never copied.
    writeFileSync(join(dir, 'memory', '.env'), `LYNOX_VAULT_KEY=${planted}`);
    mkdirSync(join(dir, 'workspace', 'out'), { recursive: true });
    writeFileSync(join(dir, 'workspace', 'out', 'report.md'), '# Quarterly');
    writeFileSync(join(dir, 'workspace', 'vault.key'), planted);
    // Credential-shaped names, case-insensitive: skipped and listed.
    writeFileSync(join(dir, 'workspace', 'Vault.KEY'), planted);
    writeFileSync(join(dir, 'workspace', '.env.bak'), planted);
    // Not text (a NUL byte): a vault value inside is found by the byte scan and the file withheld;
    // one without is copied as it is and listed as not masked.
    writeFileSync(join(dir, 'workspace', 'dump.bin'), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(planted), Buffer.from([0])]));
    writeFileSync(join(dir, 'workspace', 'eight.bin'), Buffer.concat([Buffer.from([0, 1]), Buffer.from(eight), Buffer.from([0])]));
    writeFileSync(join(dir, 'workspace', 'image.bin'), Buffer.concat([Buffer.from([0, 1, 2, 3, 255]), Buffer.from(tiny)]));
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ provider: 'anthropic', api_key: plantedConfig }));

    const r = runCommand(dir, vaultKey);
    if (r.status !== 0) throw new Error(`export command failed (${String(r.status)}): ${r.stderr}`);
    first = JSON.parse(r.stdout.trim()) as typeof first;
    const t = spawnSync('tar', ['-xf', first.path, '-C', out]);
    if (t.status !== 0) throw new Error(`tar failed: ${t.stderr.toString()}`);
  }, 180_000);

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  });

  it('stages the archive under export-staging and answers with its path, never with content', () => {
    expect(first.dir.startsWith(join(dir, EXPORT_STAGING_DIR, ARCHIVE_DIR_PREFIX))).toBe(true);
    expect(existsSync(first.path)).toBe(true);
    expect(first.size).toBe(statSync(first.path).size);
  });

  it('puts the README first and the manifest last', () => {
    const list = spawnSync('tar', ['-tf', first.path], { encoding: 'utf8' }).stdout.trim().split('\n');
    expect(list[0]).toBe(README_NAME);
    expect(list[list.length - 1]).toBe(MANIFEST_NAME);
  });

  it('control: the generic patterns alone do not mask the base64 form, so only its own form can', () => {
    expect(maskSecretsAndPatterns(`b64 ${forms.shortB64} end`, [])).toBe(`b64 ${forms.shortB64} end`);
    expect(maskSecretsAndPatterns(`b64 ${forms.shortB64url} end`, [])).toBe(`b64 ${forms.shortB64url} end`);
    expect(forms.shortB64).not.toBe(forms.shortB64url);
  });

  it('positive control: the scan finds every planted form in the source data dir it reads from', () => {
    const source = filesUnder(dir).filter(f => !f.rel.startsWith(`${EXPORT_STAGING_DIR}/`));
    for (const [name, form] of Object.entries(forms)) {
      expect(source.some(f => f.bytes.includes(Buffer.from(form))), name).toBe(true);
    }
    expect(source.some(f => f.bytes.includes(Buffer.from('enc:'))), 'enc:').toBe(true);
  });

  it('holds neither a vault value in any form nor any stored ciphertext anywhere in the archive (byte witness)', () => {
    const all = filesUnder(out);
    expect(all.length).toBeGreaterThan(5);
    for (const f of all) {
      for (const [name, form] of Object.entries(forms)) expect(f.bytes.includes(Buffer.from(form)), `${name} in ${f.rel}`).toBe(false);
      expect(f.bytes.includes(Buffer.from('enc:')), f.rel).toBe(false);
    }
  });

  it('holds no vault value in any form inside the decoded records either (the JSONL escapes what it writes)', () => {
    const strings: string[] = [];
    const collect = (v: unknown): void => {
      if (typeof v === 'string') strings.push(v);
      else if (Array.isArray(v)) v.forEach(collect);
      else if (v !== null && typeof v === 'object') Object.values(v).forEach(collect);
    };
    const parts = filesUnder(join(out, 'stores')).filter(f => f.rel.endsWith('.jsonl'));
    for (const f of parts) for (const line of f.bytes.toString('utf8').split('\n')) if (line !== '') collect(JSON.parse(line));
    // Positive control: the decoded records are the ones that carried the planted rows.
    expect(strings.some(v => v.startsWith('b64 ') && v.endsWith(' end'))).toBe(true);
    for (const v of strings) {
      for (const [name, form] of Object.entries(forms)) expect(v.includes(form), `${name} in a record`).toBe(false);
    }
  });

  it('withholds a byte column that holds a vault value and exports one that does not, as base64', () => {
    const rows = readFileSync(join(out, 'stores', 'engine.db', 'threads.jsonl'), 'utf8').split('\n').filter(Boolean)
      .map(l => JSON.parse(l) as { id: string; title: unknown });
    expect(rows.find(r => r.id === 't-blob')?.title).toBe(WITHHELD_SECRET_MARKER);
    expect(rows.find(r => r.id === 't-blob-ok')?.title).toEqual({ base64: Buffer.from([0, 9, 8, 7]).toString('base64') });
    const manifest = JSON.parse(readFileSync(join(out, MANIFEST_NAME), 'utf8')) as ArchiveManifest;
    const threads = manifest.stores.find(s => s.store === 'engine.db')?.tables.find(t => t.table === 'threads');
    expect(threads?.withheld).toBeGreaterThanOrEqual(1);
  });

  it('masks a vault value inside an ordinary text file, withholds a non-text file holding one, and lists the rest as not masked', () => {
    expect(readFileSync(join(out, 'memory', 'plain.md'), 'utf8')).toContain('note mentions');
    const manifest = JSON.parse(readFileSync(join(out, MANIFEST_NAME), 'utf8')) as ArchiveManifest;
    expect(existsSync(join(out, 'workspace', 'dump.bin'))).toBe(false);
    expect([...(manifest.workspace.held_back_secret ?? [])].sort()).toEqual(['dump.bin', 'eight.bin']);
    expect(manifest.workspace.skipped).toContain('dump.bin');
    expect(existsSync(join(out, 'workspace', 'image.bin'))).toBe(true);
    // Holds the two-character secret: too short to withhold it over, so it is copied and listed.
    expect(manifest.workspace.not_masked).toEqual(['image.bin']);
  });

  it('reads the run history in plain text, masked, with its tool calls', () => {
    const runs = readJsonl(join(out, 'stores', 'history.db', 'runs.jsonl'));
    expect(runs).toHaveLength(1);
    expect(String(runs[0]!['task_text'])).toContain('summarise the report and use');
    const calls = readJsonl(join(out, 'stores', 'history.db', 'run_tool_calls.jsonl'));
    expect(String(calls[0]!['output_json'])).toContain('tool output visible');
  });

  it('decrypts a value under the store key in a column the map does not list, and marks one that does not decrypt', () => {
    const threads = readJsonl(join(out, 'stores', 'engine.db', 'threads.jsonl'));
    const byId = new Map(threads.map(t => [t['id'], t['title']]));
    expect(byId.get('t-enc')).toBe('thread title readable');
    expect(byId.get('t-bad')).toBe(UNDECRYPTABLE_MARKER);
    const manifest = JSON.parse(readFileSync(join(out, MANIFEST_NAME), 'utf8')) as ArchiveManifest;
    const part = manifest.stores.find(s => s.store === 'engine.db')!.tables.find(t => t.table === 'threads')!;
    expect(part.undecryptable).toBe(1);
    expect(manifest.may_be_incomplete).toBe(true);
  });

  it('strips a keyed digest column', () => {
    const grants = readJsonl(join(out, 'stores', 'engine.db', 'workflow_grants.jsonl'));
    expect(grants).toHaveLength(1);
    expect('checksum' in grants[0]!).toBe(false);
    expect(JSON.stringify(grants)).not.toContain(keyedChecksum);
  });

  it('skips and lists a file with a credential\'s name, in an included directory and in the workspace', () => {
    expect(existsSync(join(out, 'memory', 'notes.md'))).toBe(true);
    expect(existsSync(join(out, 'memory', '.env'))).toBe(false);
    expect(readFileSync(join(out, 'workspace', 'out', 'report.md'), 'utf8')).toBe('# Quarterly');
    expect(existsSync(join(out, 'workspace', 'vault.key'))).toBe(false);
    expect(existsSync(join(out, 'workspace', 'Vault.KEY'))).toBe(false);
    expect(existsSync(join(out, 'workspace', '.env.bak'))).toBe(false);
    const manifest = JSON.parse(readFileSync(join(out, MANIFEST_NAME), 'utf8')) as ArchiveManifest;
    expect(manifest.directories.find(d => d.directory === 'memory')!.skipped).toContain('.env');
    expect(manifest.workspace.skipped).toEqual(expect.arrayContaining(['vault.key', 'Vault.KEY', '.env.bak']));
  });

  it('carries the settings redacted, under a name that is not config.json, and the secret names without values', () => {
    expect(existsSync(join(out, 'config.json'))).toBe(false);
    const config = JSON.parse(readFileSync(join(out, 'config.redacted.json'), 'utf8')) as Record<string, unknown>;
    expect(config['provider']).toBe('anthropic');
    expect(JSON.stringify(config)).not.toContain(plantedConfig);
    expect(JSON.parse(readFileSync(join(out, 'secret-names.json'), 'utf8'))).toContain('CUSTOMER_TOKEN');
  });

  it('keeps the slot while the archive is staged: a second export is refused (exit 3), and --finish removes both', () => {
    expect(readSlot(dir)?.holder).toBe('command');
    const second = runCommand(dir, vaultKey);
    expect(second.status).toBe(3);
    const fin = runCommand(dir, vaultKey, ['--finish', `--job=${first.job}`, `--dir=${first.dir}`]);
    expect(fin.status).toBe(0);
    expect(existsSync(first.dir)).toBe(false);
    expect(readSlot(dir)).toBeNull();
  }, 180_000);

  it('--finish refuses a directory that is not a staged archive of this data dir, and another job\'s archive', () => {
    const fin = runCommand(dir, vaultKey, ['--finish', '--job=x', `--dir=${join(dir, 'memory')}`]);
    expect(fin.status).toBe(2);
    expect(existsSync(join(dir, 'memory', 'notes.md'))).toBe(true);
    const other = join(dir, EXPORT_STAGING_DIR, `${ARCHIVE_DIR_PREFIX}someone-else-abc`);
    mkdirSync(other, { recursive: true });
    const wrongJob = runCommand(dir, vaultKey, ['--finish', '--job=mine', `--dir=${other}`]);
    expect(wrongJob.status).toBe(2);
    expect(existsSync(other)).toBe(true);
    rmSync(other, { recursive: true, force: true });
  }, 60_000);
});

describe('the export command without the vault key that opens the vault', () => {
  let dir: string;
  const vaultKey = `vk-${randomBytes(16).toString('hex')}`;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-export-key-'));
    const vault = new SecretVault({ path: join(dir, 'vault.db'), masterKey: vaultKey });
    vault.set('CUSTOMER_TOKEN', `v${randomBytes(12).toString('hex')}`);
    vault.close();
    new EngineDb(join(dir, 'engine.db'), vaultKey).close();
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('refuses with exit 5 and stages nothing when the key is missing', () => {
    const r = runCommand(dir, '');
    expect(r.status).toBe(5);
    expect(r.stderr).toContain('vault key is missing');
    expect(stagedExportDirs(dir)).toEqual([]);
    expect(readSlot(dir)).toBeNull();
  }, 120_000);

  it('refuses with exit 5 and stages nothing when the key does not open the vault', () => {
    const r = runCommand(dir, `wrong-${randomBytes(8).toString('hex')}`);
    expect(r.status).toBe(5);
    expect(r.stderr).toContain('does not open the vault');
    expect(stagedExportDirs(dir)).toEqual([]);
    expect(readSlot(dir)).toBeNull();
  }, 120_000);

  it('reads the key from the data dir\'s .env (0600) as the entrypoint does, when the environment has none', () => {
    writeFileSync(join(dir, '.env'), `LYNOX_VAULT_KEY=${vaultKey}\n`, { mode: 0o600 });
    const r = runCommand(dir, '');
    expect(r.status).toBe(0);
    const res = JSON.parse(r.stdout.trim()) as { job: string; dir: string };
    expect(runCommand(dir, '', ['--finish', `--job=${res.job}`, `--dir=${res.dir}`]).status).toBe(0);
  }, 120_000);
});

describe('the export slot', () => {
  let dir: string;
  afterEach(() => { if (dir !== undefined) rmSync(dir, { recursive: true, force: true }); });

  it('is taken once, refused while held, and given back only by its holder', () => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-slot-'));
    const a = acquireSlot(dir, 'export', 'http');
    expect(a.ok).toBe(true);
    const b = acquireSlot(dir, 'erasure', 'http');
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.held.kind).toBe('export');
    expect(releaseSlotByJob(dir, 'someone-else')).toBe(false);
    expect(readSlot(dir)).not.toBeNull();
    if (a.ok) a.slot.release();
    expect(readSlot(dir)).toBeNull();
    expect(acquireSlot(dir, 'erasure', 'http').ok).toBe(true);
  });

  it('is stale past its TTL and broken by the next taker', () => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-slot-'));
    const t0 = 1_000_000_000_000;
    expect(acquireSlot(dir, 'export', 'command', { now: t0 }).ok).toBe(true);
    expect(readSlot(dir, t0 + EXPORT_SLOT_TTL_MS - 1)).not.toBeNull();
    expect(readSlot(dir, t0 + EXPORT_SLOT_TTL_MS + 1)).toBeNull();
    expect(acquireSlot(dir, 'export', 'http', { now: t0 + EXPORT_SLOT_TTL_MS + 1 }).ok).toBe(true);
  });

  it('a heartbeat keeps a slow holder live past the TTL; without it the slot goes stale (control)', () => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-slot-'));
    const t0 = 1_000_000_000_000;
    const a = acquireSlot(dir, 'export', 'http', { now: t0 });
    if (!a.ok) throw new Error('fixture');
    expect(a.slot.refresh(t0 + EXPORT_SLOT_TTL_MS - 1000)).toBe(true);
    expect(readSlot(dir, t0 + EXPORT_SLOT_TTL_MS + 1000)).not.toBeNull();
    expect(readSlot(dir, t0 + 2 * EXPORT_SLOT_TTL_MS)).toBeNull();
    a.slot.release();
    expect(a.slot.refresh()).toBe(false);
  });

  it('reads a garbled lock as held until it is older than the export TTL', () => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-slot-'));
    const path = join(dir, EXPORT_SLOT_FILE);
    writeFileSync(path, 'half written');
    expect(acquireSlot(dir, 'erasure', 'http').ok).toBe(false);
    const old = (Date.now() - EXPORT_SLOT_TTL_MS - 60_000) / 1000;
    utimesSync(path, old, old);
    expect(acquireSlot(dir, 'erasure', 'http').ok).toBe(true);
  });

  it('the boot sweep removes a slot the HTTP API held before it started, and leaves the export command\'s', () => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-slot-'));
    const started = Date.now();
    expect(acquireSlot(dir, 'export', 'http', { now: started - 1000 }).ok).toBe(true);
    expect(sweepSlot(dir, started)).toBe(true);
    expect(readSlot(dir)).toBeNull();
    expect(acquireSlot(dir, 'export', 'command', { now: started - 1000 }).ok).toBe(true);
    expect(sweepSlot(dir, started)).toBe(false);
    expect(readSlot(dir)?.holder).toBe('command');
  });
});

describe('prepareArchive', () => {
  let dir: string;
  afterEach(() => {
    _setFreeBytesForTesting(null);
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });
  const noKeys = { engine: null, history: null };
  const opts = (slot: Parameters<typeof prepareArchive>[1]['slot']): Parameters<typeof prepareArchive>[1] =>
    ({ slot, keys: noKeys, guard: { mask: t => t, holds: () => false, maxNeedle: 0 }, config: null, secretNames: [], isolation: { kind: 'local' } });

  it('refuses before a snapshot that would take the disk below the floor, and leaves no staged archive', async () => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-archive-space-'));
    new EngineDb(join(dir, 'engine.db')).close();
    _setFreeBytesForTesting(() => 1024);
    const taken = acquireSlot(dir, 'export', 'http');
    if (!taken.ok) throw new Error('fixture');
    await expect(prepareArchive(dir, opts(taken.slot))).rejects.toBeInstanceOf(ExportSpaceError);
    expect(stagedExportDirs(dir)).toEqual([]);
  });

  it('refuses before copying a part into the tar that would take the disk below the floor', async () => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-archive-part-space-'));
    new EngineDb(join(dir, 'engine.db')).close();
    // Room for the snapshot (the first look), none for anything after it: the part's move is refused.
    let looks = 0;
    _setFreeBytesForTesting(() => (looks++ === 0 ? 1024 * 1024 * 1024 : 1024));
    const taken = acquireSlot(dir, 'export', 'http');
    if (!taken.ok) throw new Error('fixture');
    await expect(prepareArchive(dir, opts(taken.slot))).rejects.toBeInstanceOf(ExportSpaceError);
    expect(looks).toBeGreaterThan(1);
    expect(stagedExportDirs(dir)).toEqual([]);
  });

  it('opens a file only when its real path is inside the directory it was walked from', () => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-archive-open-'));
    const root = join(dir, 'memory');
    const outside = join(dir, 'outside');
    mkdirSync(root);
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret.txt'), 'outside');
    writeFileSync(join(root, 'inside.txt'), 'inside');
    // A directory inside the root swapped for a link to a directory outside it.
    symlinkSync(outside, join(root, 'swapped'));
    const rootReal = realpathSync(root);
    const insideFd = openVerified(join(root, 'inside.txt'), rootReal, statSync(join(root, 'inside.txt')).ino);
    expect(insideFd).not.toBeNull();
    if (insideFd !== null) closeSync(insideFd);
    expect(openVerified(join(root, 'swapped', 'secret.txt'), rootReal, statSync(join(outside, 'secret.txt')).ino)).toBeNull();
    // Where the opened file's path cannot be read back (off Linux), the file is refused, not read.
    expect(openVerified(join(root, 'inside.txt'), rootReal, statSync(join(root, 'inside.txt')).ino, () => null)).toBeNull();
    // The root itself: the walk resolves it only when it is still the directory it looked at.
    expect(resolvesTo(rootReal, statSync(root).ino)).toBe(true);
    expect(resolvesTo(rootReal, statSync(outside).ino)).toBe(false);
    // The file the walk saw replaced by another one: refused by its inode.
    expect(openVerified(join(root, 'inside.txt'), rootReal, statSync(join(root, 'inside.txt')).ino + 1)).toBeNull();
  });

  it('keeps the slot alive while it stages (a heartbeat) and refreshes it once at the end', async () => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-archive-beat-'));
    new EngineDb(join(dir, 'engine.db')).close();
    // Each file yields a turn and looks at the free space, which the probe below makes slow.
    mkdirSync(join(dir, 'memory'));
    for (let i = 0; i < 6; i++) writeFileSync(join(dir, 'memory', `n${String(i)}.md`), 'note');
    for (const [heartbeatMs, atLeast] of [[1, 2], [3_600_000, 1]] as const) {
      const taken = acquireSlot(dir, 'export', 'command');
      if (!taken.ok) throw new Error('fixture');
      let refreshes = 0;
      const counted = { ...taken.slot, info: taken.slot.info, release: () => taken.slot.release(), refresh: (n?: number) => { refreshes++; return taken.slot.refresh(n); } };
      // A slow staging step: the interval fires while the stores are read.
      _setFreeBytesForTesting(() => { const until = Date.now() + 5; while (Date.now() < until) { /* spin */ } return 1024 * 1024 * 1024; });
      const res = await prepareArchive(dir, { ...opts(counted), heartbeatMs });
      _setFreeBytesForTesting(null);
      if (heartbeatMs === 1) expect(refreshes, 'with a short beat').toBeGreaterThanOrEqual(atLeast);
      else expect(refreshes, 'the end refresh alone').toBe(1);
      removeArchive(res.dir);
      taken.slot.release();
    }
  });

  it('refuses without the live export slot', async () => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-archive-slot-'));
    const taken = acquireSlot(dir, 'export', 'http');
    if (!taken.ok) throw new Error('fixture');
    taken.slot.release();
    await expect(prepareArchive(dir, opts(taken.slot))).rejects.toThrow(/slot/);
  });

  it('carries a datastore table with its registry row, and refuses to guess at one without', async () => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-archive-ds-'));
    const db = new Database(join(dir, 'datastore.db'));
    db.exec(`CREATE TABLE ds_collections (name TEXT PRIMARY KEY, scope_type TEXT, scope_id TEXT, schema_json TEXT, unique_key TEXT, record_count INTEGER, created_at TEXT, updated_at TEXT);
      INSERT INTO ds_collections (name, schema_json, created_at, updated_at) VALUES ('leads', '{}', 'x', 'x');
      CREATE TABLE ds_leads (email TEXT); INSERT INTO ds_leads VALUES ('a@example.test');
      CREATE TABLE ds_orphan (v TEXT); INSERT INTO ds_orphan VALUES ('orphan row');`);
    db.close();
    const taken = acquireSlot(dir, 'export', 'http');
    if (!taken.ok) throw new Error('fixture');
    const prepared = await prepareArchive(dir, opts(taken.slot));
    const store = prepared.manifest.stores.find(s => s.store === 'datastore.db')!;
    expect(store.tables.map(t => t.table).sort()).toEqual(['ds_collections', 'ds_leads']);
    expect(store.undecided).toEqual(['ds_orphan']);
    expect(prepared.manifest.may_be_incomplete).toBe(true);
    const list = spawnSync('tar', ['-tf', prepared.path], { encoding: 'utf8' }).stdout;
    expect(list).not.toContain('ds_orphan');
  });

  it('the HTTP boot sweep removes a staged archive unless the export command holds the slot', () => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-archive-sweep-'));
    mkdirSync(join(dir, EXPORT_STAGING_DIR, `${ARCHIVE_DIR_PREFIX}left`), { recursive: true });
    const held = acquireSlot(dir, 'export', 'command');
    expect(sweepStagedArchives(dir)).toBe(0);
    if (held.ok) held.slot.release();
    expect(sweepStagedArchives(dir)).toBe(1);
    expect(stagedExportDirs(dir)).toEqual([]);
  });

  it('removes staged exports whose holder is gone, and none while an export holds the slot', () => {
    dir = mkdtempSync(join(tmpdir(), 'lynox-archive-stale-'));
    mkdirSync(join(dir, EXPORT_STAGING_DIR, `${ARCHIVE_DIR_PREFIX}orphan`), { recursive: true, mode: 0o700 });
    mkdirSync(join(dir, EXPORT_STAGING_DIR, 'workspace-orphan'), { recursive: true, mode: 0o700 });
    const t0 = Date.now();
    const held = acquireSlot(dir, 'export', 'command', { now: t0 });
    if (!held.ok) throw new Error('fixture');
    expect(sweepStaleExports(dir, t0 + 1000)).toBe(0);
    // The holder's heartbeat stopped: past the TTL its staged exports are orphans.
    expect(sweepStaleExports(dir, t0 + EXPORT_SLOT_TTL_MS + 1000)).toBe(2);
    expect(stagedExportDirs(dir)).toEqual([]);
  });
});

describe('the README', () => {
  it('names every included table of every listed store and every included directory, in plain words', () => {
    const readme = renderReadme({ kind: 'local' });
    for (const store of Object.keys(EXPORT_TABLES) as ExportedStore[]) {
      for (const [table, d] of Object.entries(EXPORT_TABLES[store].include)) {
        expect(d.about.length, `${store}.${table}`).toBeGreaterThan(5);
        expect(readme).toContain(`  ${table}.jsonl: ${d.about}`);
      }
    }
    for (const e of DATA_DIR_INVENTORY) if (e.kind === 'dir' && e.export.by === 'include') expect(readme).toContain(`  ${e.name}/`);
  });

  it('describes every included directory in the README', () => {
    const readme = renderReadme({ kind: 'local' } as unknown as Parameters<typeof renderReadme>[0]);
    const dirs = DATA_DIR_INVENTORY.filter(e => e.kind === 'dir' && e.export.by === 'include' && e.name !== 'workspace').map(e => e.name);
    expect(dirs.length).toBeGreaterThanOrEqual(4);
    for (const name of dirs) {
      const line = readme.split('\n').find(l => l.startsWith(`  ${name}/: `));
      expect(line, name).toBeDefined();
      expect(line!.length, name).toBeGreaterThan(`  ${name}/: `.length + 10);
    }
  });

  it('says in sidecar mode that the workspace files are not in the archive, and where to ask: managed or self-hosted', () => {
    const sidecar = { kind: 'sidecar' } as unknown as Parameters<typeof renderReadme>[0];
    expect(renderReadme(sidecar, true)).toContain('workspace/: not in this archive');
    expect(renderReadme(sidecar, true)).toContain('write to privacy@lynox.ai');
    expect(renderReadme(sidecar, false)).toContain('ask the operator of this installation');
    expect(renderReadme(sidecar, false)).not.toContain('privacy@lynox.ai');
  });
});

describe('the export guard on its own', () => {
  it('finds a value across a chunk boundary of a file larger than it reads whole, and reads none there otherwise', () => {
    const d = mkdtempSync(join(tmpdir(), 'lynox-guard-chunk-'));
    try {
      const needle = Buffer.from(`ndl${randomBytes(8).toString('hex')}`);
      const guard = { mask: (t: string) => t, holds: (b: Buffer) => b.includes(needle), maxNeedle: needle.length };
      const size = GUARD_READ_CAP_BYTES + 2 * 1024 * 1024;
      const big = Buffer.alloc(size);
      big[0] = 0; // not text: a NUL, and too large to be read whole anyway
      // Straddles the first 1 MiB chunk boundary: only an overlapping scan sees it whole.
      needle.copy(big, 1024 * 1024 - 5);
      const withIt = join(d, 'with.bin');
      writeFileSync(withIt, big);
      const without = join(d, 'without.bin');
      writeFileSync(without, Buffer.alloc(size));
      for (const [path, kind] of [[withIt, 'secret'], [without, 'raw']] as const) {
        const fd = openSync(path, 'r');
        try {
          const c = guardContent(fd, size, guard);
          expect(c.kind, path).toBe(kind);
          if (c.kind === 'raw') expect(c.bytes).toBeNull();
        } finally {
          closeSync(fd);
        }
      }
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('derives the base64 of a value at each offset inside a longer text (Basic auth: user + colon + password)', () => {
    const value = `pw${randomBytes(9).toString('hex')}`;
    const forms = exportMaskValues([value]);
    for (const prefix of ['', 'a', 'user:']) {
      const enc = Buffer.from(`${prefix}${value}tail`).toString('base64');
      const hit = forms.find(f => f.length >= 8 && enc.includes(f));
      expect(hit, `offset ${String(prefix.length % 3)}`).toBeDefined();
      expect(maskSecretsAndPatterns(enc, forms).includes(hit!)).toBe(false);
    }
    // Each run is decided by the value's bytes alone: the same run whatever comes before or after.
    expect(shiftedBase64(Buffer.from(value))).toHaveLength(3);
  });

  it('reads a full disk as exit 4, whether the export, the file system or SQLite says so', () => {
    expect(isNoSpace(new ExportSpaceError(10, 1))).toBe(true);
    expect(isNoSpace(Object.assign(new Error('x'), { code: 'ENOSPC' }))).toBe(true);
    expect(isNoSpace(Object.assign(new Error('x'), { code: 'SQLITE_FULL' }))).toBe(true);
    expect(isNoSpace(Object.assign(new Error('x'), { code: 'EACCES' }))).toBe(false);
    expect(isNoSpace(null)).toBe(false);
  });
});
