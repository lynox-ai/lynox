import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackupManager } from './backup.js';
import { canonicalMac, deriveListProofKey, deriveManifestKey } from './backup-crypto.js';
import { reloadConfig } from './config.js';
import { BACKUP_LIST_PROOF_FILE } from './data-dir-inventory.js';
import { removeBackupsOutside } from './data-dir-erase.js';
import { _resetWorkspaceAccess } from './workspace-access.js';

/**
 * The backup list keeps its answers across restarts in a file at the backup dir's root: a fresh
 * manager (as after a start) checks no signature whose manifest still holds the bytes it was
 * checked under, and checks afresh whatever changed, whatever the file says, unless this vault
 * key wrote the file.
 */
type ProvenanceSeam = { provenanceOf: (manifest: unknown) => string; readListProofFile: (key: string) => void };
type ProofFile = { v: number; entries: Record<string, { digest: string; provenance: string }>; mac: string };

const KEY = 'vault-key-list-proof';
let tmp: string;
let data: string;
let backupDir: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-bk-proof-')));
  data = join(tmp, 'data');
  backupDir = join(tmp, 'backups');
  mkdirSync(join(data, 'memory'), { recursive: true });
  writeFileSync(join(data, 'memory', 'x.md'), 'x');
  for (const k of ['LYNOX_DATA_DIR', 'LYNOX_DIR', 'LYNOX_WORKSPACE_ROOT']) saved[k] = process.env[k];
  process.env['LYNOX_DATA_DIR'] = data;
  delete process.env['LYNOX_DIR'];
  delete process.env['LYNOX_WORKSPACE_ROOT'];
  reloadConfig();
  _resetWorkspaceAccess();
});

afterEach(() => {
  vi.restoreAllMocks();
  _resetWorkspaceAccess();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  reloadConfig();
  rmSync(tmp, { recursive: true, force: true });
});

const manager = (key: string | null = KEY): BackupManager => new BackupManager(data, { backupDir, retentionDays: 30, encrypt: false }, key);
const proofPath = (): string => join(backupDir, BACKUP_LIST_PROOF_FILE);
const readProof = (): ProofFile => JSON.parse(readFileSync(proofPath(), 'utf8')) as ProofFile;
/** A file as this code writes it, MACed under `key` (the list's own key unless a test says otherwise). */
function writeProof(entries: ProofFile['entries'], key: Buffer = deriveListProofKey(KEY), v = 1): void {
  const body = { v, entries };
  writeFileSync(proofPath(), JSON.stringify({ ...body, mac: canonicalMac(body, key) }));
}
const sha256 = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

/** A manager whose signature checks are counted, as after a start. */
function fresh(key: string | null = KEY): { m: BackupManager; checks: ReturnType<typeof vi.spyOn> } {
  const m = manager(key);
  return { m, checks: vi.spyOn(m as unknown as ProvenanceSeam, 'provenanceOf') };
}

async function tick(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 30));
}

describe('the backup list across a restart', () => {
  it('answers from the file on the first list of a fresh manager, without checking a signature', async () => {
    const first = manager();
    await first.createBackup();
    await tick();
    await first.createBackup();
    expect(first.listBackups().map(b => b.provenance)).toEqual(['verified', 'verified']);
    expect(statSync(proofPath()).mode & 0o777).toBe(0o600);
    expect(Object.keys(readProof().entries)).toHaveLength(2);

    const { m, checks } = fresh();
    expect(m.listBackups().map(b => b.provenance)).toEqual(['verified', 'verified']);
    expect(checks).not.toHaveBeenCalled();
  });

  it('checks a manifest again whose content changed, although the file holds its old answer', async () => {
    const first = manager();
    const created = await first.createBackup();
    expect(first.listBackups()[0]?.provenance).toBe('verified');
    const path = join(created.path, 'manifest.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify({ ...manifest, version: 'changed' }));

    const { m, checks } = fresh();
    expect(m.listBackups()[0]?.provenance).toBe('mismatch');
    expect(checks).toHaveBeenCalledTimes(1);
    expect(readProof().entries[created.path.split('/').pop()!]).toEqual({ digest: sha256(path), provenance: 'mismatch' });
  });

  it('checks afresh when the file says verified for changed content but its MAC does not match', async () => {
    const first = manager();
    const created = await first.createBackup();
    first.listBackups();
    const path = join(created.path, 'manifest.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify({ ...manifest, version: 'changed' }));
    const proof = readProof();
    const name = Object.keys(proof.entries)[0]!;
    proof.entries[name] = { digest: sha256(path), provenance: 'verified' };
    writeFileSync(proofPath(), JSON.stringify(proof));

    const { m, checks } = fresh();
    expect(m.listBackups()[0]?.provenance).toBe('mismatch');
    expect(checks).toHaveBeenCalledTimes(1);
  });

  it('does not take a file MACed under the manifest key, nor one another vault key wrote', async () => {
    const first = manager();
    const created = await first.createBackup();
    first.listBackups();
    const name = Object.keys(readProof().entries)[0]!;
    const digest = sha256(join(created.path, 'manifest.json'));
    writeProof({ [name]: { digest, provenance: 'verified' } }, deriveManifestKey(KEY));
    const viaManifestKey = fresh();
    expect(viaManifestKey.m.listBackups()[0]?.provenance).toBe('verified');
    expect(viaManifestKey.checks).toHaveBeenCalledTimes(1);

    writeProof({ [name]: { digest, provenance: 'verified' } }, deriveListProofKey('another-vault-key'));
    const other = fresh();
    expect(other.m.listBackups()[0]?.provenance).toBe('verified');
    expect(other.checks).toHaveBeenCalledTimes(1);
  });

  it('under another vault key, checks afresh and shows mismatch, not the kept verified', async () => {
    const first = manager();
    await first.createBackup();
    expect(first.listBackups()[0]?.provenance).toBe('verified');
    const { m, checks } = fresh('another-vault-key');
    expect(m.listBackups()[0]?.provenance).toBe('mismatch');
    expect(checks).toHaveBeenCalledTimes(1);
  });

  it('does not take a file of another format version, though its MAC matches', async () => {
    const first = manager();
    await first.createBackup();
    first.listBackups();
    writeProof(readProof().entries, deriveListProofKey(KEY), 2);

    const { m, checks } = fresh();
    expect(m.listBackups()[0]?.provenance).toBe('verified');
    expect(checks).toHaveBeenCalledTimes(1);
  });

  it('does not read a file larger than the bound, though its MAC matches', async () => {
    const first = manager();
    const created = await first.createBackup();
    first.listBackups();
    const name = Object.keys(readProof().entries)[0]!;
    const entries: ProofFile['entries'] = { [name]: { digest: sha256(join(created.path, 'manifest.json')), provenance: 'verified' } };
    for (let i = 0; i < 12_000; i++) entries[`2026-01-01T${String(i).padStart(8, '0')}Z`] = { digest: 'a'.repeat(64), provenance: 'verified' };
    writeProof(entries);
    expect(statSync(proofPath()).size).toBeGreaterThan(1024 * 1024);

    const { m, checks } = fresh();
    expect(m.listBackups()[0]?.provenance).toBe('verified');
    expect(checks).toHaveBeenCalledTimes(1);
  });

  it('does not read a file over the bound whose first bytes alone would parse', async () => {
    const first = manager();
    await first.createBackup();
    first.listBackups();
    writeFileSync(proofPath(), readFileSync(proofPath(), 'utf8') + ' '.repeat(1024 * 1024));
    expect(statSync(proofPath()).size).toBeGreaterThan(1024 * 1024);

    const { m, checks } = fresh();
    expect(m.listBackups()[0]?.provenance).toBe('verified');
    expect(checks).toHaveBeenCalledTimes(1);
  });

  it('does not follow a symlink in the file\'s place', async () => {
    const first = manager();
    await first.createBackup();
    first.listBackups();
    const real = join(tmp, 'proof-elsewhere.json');
    writeFileSync(real, readFileSync(proofPath()));
    rmSync(proofPath());
    symlinkSync(real, proofPath());

    const { m, checks } = fresh();
    expect(m.listBackups()[0]?.provenance).toBe('verified');
    expect(checks).toHaveBeenCalledTimes(1);
  });

  it('leaves out an entry of a shape it does not write, and keeps the rest', async () => {
    const first = manager();
    await first.createBackup();
    await tick();
    await first.createBackup();
    first.listBackups();
    const proof = readProof();
    const [a, b] = Object.keys(proof.entries);
    writeProof({ [a!]: proof.entries[a!]!, [b!]: { digest: proof.entries[b!]!.digest, provenance: 'no-key' } });

    const { m, checks } = fresh();
    expect(m.listBackups().map(x => x.provenance)).toEqual(['verified', 'verified']);
    expect(checks).toHaveBeenCalledTimes(1);
  });

  it('does not write the file again after a list that checked nothing', async () => {
    const first = manager();
    await first.createBackup();
    first.listBackups();
    const before = statSync(proofPath(), { bigint: true });
    const { m } = fresh();
    m.listBackups();
    m.listBackups();
    const after = statSync(proofPath(), { bigint: true });
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeNs).toBe(before.mtimeNs);
  });

  it('drops a backup that is gone from the file', async () => {
    const first = manager();
    const old = await first.createBackup();
    await tick();
    await first.createBackup();
    first.listBackups();
    expect(Object.keys(readProof().entries)).toHaveLength(2);
    rmSync(old.path, { recursive: true });
    expect(manager().listBackups()).toHaveLength(1);
    expect(Object.keys(readProof().entries)).toEqual(readdirSync(backupDir).filter(n => n !== BACKUP_LIST_PROOF_FILE));
  });

  it('still lists when the file cannot be written, and leaves no temporary file', async () => {
    const first = manager();
    await first.createBackup();
    mkdirSync(proofPath());
    expect(first.listBackups().map(b => b.provenance)).toEqual(['verified']);
    expect(readdirSync(backupDir).filter(n => n.startsWith(`${BACKUP_LIST_PROOF_FILE}.`))).toEqual([]);
  });

  it('without a vault key, neither reads nor writes the file', async () => {
    const m = manager(null);
    await m.createBackup();
    expect(m.listBackups().map(b => b.provenance)).toEqual(['no-key']);
    expect(readdirSync(backupDir)).not.toContain(BACKUP_LIST_PROOF_FILE);
    // A file a keyed engine left there is not read either.
    writeProof({});
    const keyless = manager(null);
    const read = vi.spyOn(keyless as unknown as ProvenanceSeam, 'readListProofFile');
    expect(keyless.listBackups().map(b => b.provenance)).toEqual(['no-key']);
    expect(read).not.toHaveBeenCalled();
  });

  it('checks afresh both backups whose entries were swapped in a file this key wrote', async () => {
    const first = manager();
    await first.createBackup();
    await tick();
    await first.createBackup();
    first.listBackups();
    const proof = readProof();
    const [a, b] = Object.keys(proof.entries);
    writeProof({ [a!]: proof.entries[b!]!, [b!]: proof.entries[a!]! });

    const { m, checks } = fresh();
    expect(m.listBackups().map(x => x.provenance)).toEqual(['verified', 'verified']);
    expect(checks).toHaveBeenCalledTimes(2);
  });

  it('does not wait on a FIFO in the file\'s place', async () => {
    const first = manager();
    await first.createBackup();
    execFileSync('mkfifo', [proofPath()]);
    // A blocking open would stall the event loop, so the test timeout could
    // never fire. A child opens the FIFO read-write after 2 s (that open never
    // blocks), which releases a stalled reader; the elapsed time then shows
    // whether the list waited for it.
    const releaser = spawn('sh', ['-c', 'sleep 2; exec 3<> "$1"', 'sh', proofPath()], { stdio: 'ignore' });
    try {
      const { m, checks } = fresh();
      const started = Date.now();
      expect(m.listBackups()[0]?.provenance).toBe('verified');
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(checks).toHaveBeenCalledTimes(1);
    } finally {
      releaser.kill('SIGKILL');
    }
  }, 5_000);

  it('takes away a temporary file a crashed write left, on its next write', async () => {
    const first = manager();
    await first.createBackup();
    first.listBackups();
    const leftover = `${proofPath()}.4242.0123456789ab.tmp`;
    writeFileSync(leftover, '{}');
    await tick();
    await first.createBackup();
    first.listBackups();
    expect(readdirSync(backupDir).filter(n => n.startsWith(`${BACKUP_LIST_PROOF_FILE}.`))).toEqual([]);
  });

  it('is removed by the erasure of a backup dir outside the data dir, with its temporary file', async () => {
    const first = manager();
    await first.createBackup();
    first.listBackups();
    writeFileSync(`${proofPath()}.123.abcdef012345.tmp`, '{}');
    writeFileSync(join(backupDir, 'not-ours.txt'), 'keep');
    writeFileSync(`${proofPath()}.bak`, 'the user\'s own copy');
    const out = removeBackupsOutside(backupDir, data);
    expect(out.failures).toEqual([]);
    expect(readdirSync(backupDir).sort()).toEqual([`${BACKUP_LIST_PROOF_FILE}.bak`, 'not-ours.txt']);
  });
});
