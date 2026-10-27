import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { appendFileSync, chmodSync, linkSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TarWriter, TarNameError, checkTarName, paxRecord } from './tar-writer.js';
import {
  ARCHIVE_MANIFEST_NAME, EXPORT_STAGING_DIR, ExportSpaceError, _setFreeBytesForTesting, archiveBound, describeWorkspace,
  stageArchive, sweepExportStaging, tarOverheadFor, writeWorkspaceArchive, type WorkspaceManifest,
} from './workspace-export.js';
import { copyOut, openAnchor, closeAnchor } from './workspace-fd.js';
import { resetShellIsolationForTest, setShellIsolationForTest, type ShellIsolation } from './shell-isolation.js';

/** A reader for what this writer produces: ustar headers plus pax `x` headers. */
interface ReadEntry { name: string; ustarName: string; type: string; data: Buffer }
function readTar(buf: Buffer): ReadEntry[] {
  const out: ReadEntry[] = [];
  let off = 0;
  let pax: Record<string, string> = {};
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every(b => b === 0)) break;
    const field = (start: number, len: number): string => h.subarray(start, start + len).toString('utf8').replace(/\0.*$/s, '');
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i]!;
    expect(parseInt(field(148, 8).trim(), 8), 'header checksum').toBe(sum);
    expect(field(257, 6)).toBe('ustar');
    const ustarName = field(0, 100);
    const type = field(156, 1);
    const size = parseInt(field(124, 12), 8);
    const data = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      pax = {};
      let p = 0;
      const text = data;
      while (p < text.length) {
        const sp = text.indexOf(0x20, p);
        const len = parseInt(text.subarray(p, sp).toString('ascii'), 10);
        const rec = text.subarray(sp + 1, p + len - 1).toString('utf8');
        const eq = rec.indexOf('=');
        pax[rec.slice(0, eq)] = rec.slice(eq + 1);
        p += len;
      }
      continue;
    }
    out.push({ name: pax['path'] ?? ustarName, ustarName, type, data: Buffer.from(data) });
    pax = {};
  }
  return out;
}

const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
const isRoot = process.getuid?.() === 0;

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'lynox-wsexport-')); });
afterEach(() => {
  // Restore modes first, so a chmod 000 fixture does not leave the temp dir behind.
  try { execFileSync('chmod', ['-R', 'u+rwx', dir]); } catch { /* gone */ }
  rmSync(dir, { recursive: true, force: true });
});

function tarOf(entries: Array<[string, Buffer]>): Buffer {
  const path = join(dir, 'out.tar');
  const fd = openSync(path, 'w', 0o600);
  try {
    const tar = new TarWriter(fd);
    for (const [name, data] of entries) tar.addBuffer(name, data, 1_700_000_000);
    tar.finish();
  } finally {
    closeSync(fd);
  }
  return readFileSync(path);
}

describe('tar writer', () => {
  it('writes a ustar entry that GNU tar reads back byte for byte, with the two end blocks', async () => {
    const buf = tarOf([['a/b.txt', Buffer.from('hello')]]);
    expect(buf.length % 512).toBe(0);
    expect(buf.subarray(buf.length - 1024).every(b => b === 0)).toBe(true);
    const entries = readTar(buf);
    expect(entries.map(e => [e.name, e.data.toString()])).toEqual([['a/b.txt', 'hello']]);
    writeFileSync(join(dir, 'x.tar'), buf);
    expect(execFileSync('tar', ['-xOf', join(dir, 'x.tar'), 'a/b.txt']).toString()).toBe('hello');
  });

  it('carries a name over 100 bytes through pax, and GNU tar extracts it under that name', async () => {
    const long = `${'d'.repeat(80)}/${'f'.repeat(80)}.txt`;
    const buf = tarOf([[long, Buffer.from('long')]]);
    const [e] = readTar(buf);
    expect(e!.name).toBe(long);
    expect(e!.ustarName.length).toBeLessThanOrEqual(100);
    writeFileSync(join(dir, 'x.tar'), buf);
    expect(execFileSync('tar', ['-tf', join(dir, 'x.tar')]).toString().trim()).toBe(long);
  });

  it('puts a name with a control character into pax and never raw into the ustar field', async () => {
    const name = 'evil\x1b[31mname\nline.txt';
    const [e] = readTar(tarOf([[name, Buffer.from('x')]]));
    expect(e!.name).toBe(name);
    expect(e!.ustarName).toMatch(/^[\x20-\x7e]+$/);
    expect(e!.ustarName).not.toContain('\x1b');
  });

  it('puts a non-ASCII name into pax, exactly', async () => {
    const name = 'Grüße/日本.txt';
    const [e] = readTar(tarOf([[name, Buffer.from('x')]]));
    expect(e!.name).toBe(name);
    expect(e!.ustarName).toMatch(/^[\x20-\x7e]+$/);
  });

  it.each([['/etc/passwd'], ['../up'], ['a/../b'], ['a//b'], ['./a'], [''], ['a\0b'], ['..\\..\\evil.bat'], ['a/x\\..\\y'], ['a/.../b'], ['a/.. /b']])('refuses the entry name %j', (name) => {
    expect(() => checkTarName(name)).toThrow(TarNameError);
    expect(() => tarOf([[name, Buffer.from('x')]])).toThrow(TarNameError);
  });

  it('keeps a far-future mtime inside its field instead of overflowing into the next', () => {
    const path = join(dir, 'm.tar');
    const fd = openSync(path, 'w', 0o600);
    try {
      const tar = new TarWriter(fd);
      tar.addBuffer('a', Buffer.from('x'), 1e15);
      tar.finish();
    } finally {
      closeSync(fd);
    }
    const h = readFileSync(path).subarray(0, 512);
    expect(h.subarray(136, 148).toString('ascii')).toBe('77777777777\0');
    expect(readTar(readFileSync(path))[0]!.data.toString()).toBe('x');
  });

  it('counts the pax record length across a power of ten', async () => {
    for (let n = 80; n < 120; n++) {
      const rec = paxRecord('path', 'p'.repeat(n));
      expect(parseInt(rec.toString().split(' ')[0]!, 10)).toBe(rec.length);
    }
  });
});

describe('workspace export', () => {
  const ws = (): string => join(dir, 'workspace');

  it('archives every workspace file with identical bytes, and the manifest hashes what it wrote', async () => {
    mkdirSync(join(ws(), 'sub'), { recursive: true });
    writeFileSync(join(ws(), 'report.md'), '# Report');
    writeFileSync(join(ws(), 'sub', 'data.csv'), 'a,b\n1,2\n');
    stageArchive(dir, 0);
    const out = join(dir, 'w.tar');
    const manifest = await writeWorkspaceArchive(dir, out);
    const entries = readTar(readFileSync(out));
    const files = Object.fromEntries(entries.map(e => [e.name, e.data.toString()]));
    expect(files['workspace/report.md']).toBe('# Report');
    expect(files['workspace/sub/data.csv']).toBe('a,b\n1,2\n');
    const inArchive = JSON.parse(files[ARCHIVE_MANIFEST_NAME]!) as WorkspaceManifest;
    expect(inArchive).toEqual(manifest);
    expect(manifest.files.find(f => f.path === 'report.md')).toEqual({ path: 'report.md', size: 8, sha256: sha('# Report') });
    expect(manifest.may_be_incomplete).toBe(false);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    // The JSON export's manifest lists the same files.
    expect(describeWorkspace(dir).files.map(f => f.path).sort()).toEqual(['report.md', 'sub/data.csv']);
  });

  it.skipIf(isRoot)('names an unreadable file and an unreadable directory, and still delivers the rest', async () => {
    mkdirSync(join(ws(), 'locked'), { recursive: true });
    writeFileSync(join(ws(), 'ok.txt'), 'fine');
    writeFileSync(join(ws(), 'secret.txt'), 'no');
    writeFileSync(join(ws(), 'locked', 'inner.txt'), 'no');
    chmodSync(join(ws(), 'secret.txt'), 0o000);
    chmodSync(join(ws(), 'locked'), 0o000);
    const out = join(dir, 'w.tar');
    const manifest = await writeWorkspaceArchive(dir, out);
    expect(manifest.unreadable).toEqual(expect.arrayContaining([
      { path: 'secret.txt', code: 'EACCES' },
      { path: 'locked', code: 'EACCES' },
    ]));
    expect(manifest.unreadable).toHaveLength(2);
    expect(manifest.skipped).toEqual([]);
    expect(manifest.may_be_incomplete).toBe(true);
    expect(readTar(readFileSync(out)).map(e => e.name)).toEqual(['workspace/ok.txt', ARCHIVE_MANIFEST_NAME]);
    const described = describeWorkspace(dir);
    expect(described.unreadable).toEqual([{ path: 'locked', code: 'EACCES' }]);
    expect(described.may_be_incomplete).toBe(true);
  });

  it.skipIf(isRoot)('a backup-style copy without the callback still fails on an unreadable file', async () => {
    mkdirSync(ws(), { recursive: true });
    writeFileSync(join(ws(), 'secret.txt'), 'no');
    chmodSync(join(ws(), 'secret.txt'), 0o000);
    const anchor = openAnchor(ws());
    try {
      expect(() => copyOut(anchor, '', () => { /* sink */ })).toThrow(/EACCES/);
    } finally {
      closeAnchor(anchor);
    }
  });

  it('lists a symlink and a FIFO as skipped and never follows or copies them', async () => {
    mkdirSync(ws(), { recursive: true });
    writeFileSync(join(dir, 'outside.txt'), 'OUTSIDE');
    symlinkSync(join(dir, 'outside.txt'), join(ws(), 'link'));
    execFileSync('mkfifo', [join(ws(), 'pipe')]);
    const out = join(dir, 'w.tar');
    const manifest = await writeWorkspaceArchive(dir, out);
    expect(manifest.skipped.sort()).toEqual(['link', 'pipe']);
    expect(manifest.may_be_incomplete).toBe(true);
    expect(readFileSync(out).includes('OUTSIDE')).toBe(false);
  });

  it('answers present:false and an archive holding only the manifest when there is no workspace', async () => {
    const out = join(dir, 'w.tar');
    expect((await writeWorkspaceArchive(dir, out)).present).toBe(false);
    expect(readTar(readFileSync(out)).map(e => e.name)).toEqual([ARCHIVE_MANIFEST_NAME]);
    expect(describeWorkspace(dir).present).toBe(false);
  });

  describe('in sidecar mode (PRD shell-sidecar-activation D7, walkers 5 and 6)', () => {
    const sidecar = { kind: 'sidecar', socket: '/run/lynox/shell.sock', root: {} } as unknown as ShellIsolation;
    const plant = (): void => {
      mkdirSync(ws(), { recursive: true });
      writeFileSync(join(ws(), 'report.md'), 'WORKSPACE-CONTENT');
    };
    const omitted = { reason: 'sidecar', source: 'control-plane' };
    afterEach(() => { resetShellIsolationForTest(); });

    it('describeWorkspace walks nothing, and records the omission with the control plane as source', () => {
      plant();
      const m = describeWorkspace(dir, sidecar);
      expect(m.omitted).toEqual(omitted);
      expect(m.files).toEqual([]);
      expect(m.present).toBe(true);
      expect(m.may_be_incomplete).toBe(true);
      // Control: the same tree in local mode is listed, so the empty list above is the mode's doing.
      expect(describeWorkspace(dir, { kind: 'local' }).files.map(f => f.path)).toEqual(['report.md']);
      expect(describeWorkspace(dir, { kind: 'local' }).omitted).toBeUndefined();
    });

    it('writeWorkspaceArchive copies nothing: the archive holds only the manifest that records the omission', async () => {
      plant();
      const out = join(dir, 'w.tar');
      const m = await writeWorkspaceArchive(dir, out, sidecar);
      expect(m.omitted).toEqual(omitted);
      const entries = readTar(readFileSync(out));
      expect(entries.map(e => e.name)).toEqual([ARCHIVE_MANIFEST_NAME]);
      expect((JSON.parse(entries[0]!.data.toString()) as WorkspaceManifest).omitted).toEqual(omitted);
      expect(readFileSync(out).includes('WORKSPACE-CONTENT')).toBe(false);
      // Control: in local mode the same tree is archived.
      const local = join(dir, 'l.tar');
      await writeWorkspaceArchive(dir, local, { kind: 'local' });
      expect(readTar(readFileSync(local)).map(e => e.name)).toContain('workspace/report.md');
    });

    it('both read the process mode when no mode is handed in', async () => {
      plant();
      setShellIsolationForTest(sidecar);
      expect(describeWorkspace(dir).omitted).toEqual(omitted);
      expect((await writeWorkspaceArchive(dir, join(dir, 'w.tar'))).omitted).toEqual(omitted);
    });
  });

  it('stages each request in its own 0700 directory and refuses an archive path that exists', async () => {
    const a = stageArchive(dir, 0);
    const b = stageArchive(dir, 0);
    expect(a.dir).not.toBe(b.dir);
    expect(statSync(a.dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, EXPORT_STAGING_DIR)).mode & 0o777).toBe(0o700);
    writeFileSync(a.path, 'planted');
    await expect(writeWorkspaceArchive(dir, a.path)).rejects.toThrow(/EEXIST/);
  });

  it('lists a name an extractor could read as leaving its directory under skipped, not in the archive', async () => {
    mkdirSync(ws(), { recursive: true });
    writeFileSync(join(ws(), '..\\..\\evil.bat'), 'x');
    writeFileSync(join(ws(), 'fine.txt'), 'ok');
    const out = join(dir, 'w.tar');
    const manifest = await writeWorkspaceArchive(dir, out);
    expect(manifest.skipped).toEqual(['..\\..\\evil.bat']);
    expect(manifest.files.map(f => f.path)).toEqual(['fine.txt']);
    expect(readTar(readFileSync(out)).map(e => e.name)).toEqual(['workspace/fine.txt', ARCHIVE_MANIFEST_NAME]);
    expect(describeWorkspace(dir).skipped).toEqual(['..\\..\\evil.bat']);
  });

  it('reports a file that grew while it was read', async () => {
    mkdirSync(ws(), { recursive: true });
    const p = join(ws(), 'log.txt');
    writeFileSync(p, Buffer.alloc(256 * 1024, 0x61));
    const out = join(dir, 'w.tar');
    const pending = writeWorkspaceArchive(dir, out);
    // The copy yields between chunks; the append lands while the file is being read.
    await new Promise(r => setImmediate(r));
    appendFileSync(p, 'more');
    const manifest = await pending;
    expect(manifest.changed_during_export).toEqual(['log.txt']);
    expect(manifest.may_be_incomplete).toBe(true);
  });

  it('gives the event loop turns while it copies', async () => {
    mkdirSync(ws(), { recursive: true });
    writeFileSync(join(ws(), 'big.bin'), Buffer.alloc(1024 * 1024));
    let finished = false;
    const pending = writeWorkspaceArchive(dir, join(dir, 'w.tar')).then(m => { finished = true; return m; });
    await new Promise(r => setImmediate(r));
    expect(finished, 'a copy that never yields finishes before any other callback runs').toBe(false);
    expect((await pending).changed_during_export).toEqual([]);
  });

  it('bounds the archive by what the writer really spends, long pax names included', async () => {
    const long = 'x'.repeat(4000);
    expect(tarOverheadFor('a.txt', 1)).toBe(1023);
    expect(tarOverheadFor(long, 1)).toBeGreaterThan(4000 + 1023);
    // Past 8 GiB the size travels in a pax record, with its own header block.
    expect(tarOverheadFor('a.txt', 0o77777777777 + 1)).toBe(1023 + 1024);
    // Measured against a real archive: the bound is never below what was written.
    mkdirSync(join(ws(), 'd'), { recursive: true });
    writeFileSync(join(ws(), 'd', 'x'.repeat(200)), 'a');
    for (let i = 0; i < 30; i++) writeFileSync(join(ws(), `f${i}`), 'b'.repeat(i * 37));
    const out = join(dir, 'w.tar');
    await writeWorkspaceArchive(dir, out);
    expect(archiveBound(describeWorkspace(dir))).toBeGreaterThanOrEqual(statSync(out).size);
  });

  it('counts manifest bytes, not characters: CJK names outweigh the slack', async () => {
    const comp = (i: number, j: number): string => `${String(i)}${String(j)}${'語'.repeat(84)}`;
    // Eight components of 252 bytes in UTF-8 but 86 characters: a count in characters misses
    // about two thirds of each name, more than the per-file padding allowance covers.
    for (let i = 0; i < 40; i++) {
      const d = join(ws(), ...Array.from({ length: 7 }, (_, j) => comp(i, j)));
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, comp(i, 7)), Buffer.alloc(512));
    }
    const out = join(dir, 'w.tar');
    await writeWorkspaceArchive(dir, out);
    expect(archiveBound(describeWorkspace(dir))).toBeGreaterThanOrEqual(statSync(out).size);
  });

  it('counts the manifest in the bound: a deep path outweighs the per-file padding slack', async () => {
    // 512 bytes: no padding, so the bound's padding allowance is pure slack, and the manifest's
    // copy of a ~3.7 KB path is more than that slack covers.
    const deep = Array.from({ length: 15 }, (_, i) => `${String(i)}${'d'.repeat(245)}`).join('/');
    mkdirSync(join(ws(), deep), { recursive: true });
    writeFileSync(join(ws(), deep, 'f'), Buffer.alloc(512));
    const out = join(dir, 'w.tar');
    await writeWorkspaceArchive(dir, out);
    expect(archiveBound(describeWorkspace(dir))).toBeGreaterThanOrEqual(statSync(out).size);
  });

  it('stops a copy that would run the disk below its floor, mid-way', async () => {
    mkdirSync(ws(), { recursive: true });
    writeFileSync(join(ws(), 'grown.bin'), Buffer.alloc(70 * 1024 * 1024));
    _setFreeBytesForTesting(() => 10 * 1024 * 1024);
    try {
      await expect(writeWorkspaceArchive(dir, join(dir, 'w.tar'))).rejects.toThrow(ExportSpaceError);
    } finally {
      _setFreeBytesForTesting(null);
    }
  });

  it('withholds a hard link to a data-directory credential, in both manifests, and lists it', async () => {
    mkdirSync(ws(), { recursive: true });
    writeFileSync(join(dir, 'vault.key'), 'KEYMATERIAL');
    mkdirSync(join(dir, 'backups', 'b1'), { recursive: true });
    writeFileSync(join(dir, 'backups', 'b1', 'part'), 'BACKUPPART');
    linkSync(join(dir, 'vault.key'), join(ws(), 'k'));
    linkSync(join(dir, 'backups', 'b1', 'part'), join(ws(), 'p'));
    writeFileSync(join(ws(), 'fine.txt'), 'ok');
    const out = join(dir, 'w.tar');
    const manifest = await writeWorkspaceArchive(dir, out);
    expect(manifest.skipped.sort()).toEqual(['k', 'p']);
    expect(manifest.files.map(f => f.path)).toEqual(['fine.txt']);
    expect(readFileSync(out).includes('KEYMATERIAL')).toBe(false);
    expect(readFileSync(out).includes('BACKUPPART')).toBe(false);
    const described = describeWorkspace(dir);
    expect(described.skipped.sort()).toEqual(['k', 'p']);
    expect(described.files.map(f => f.path)).toEqual(['fine.txt']);
  });

  it('looks at the free space again before the floor can be reached between two looks', async () => {
    mkdirSync(ws(), { recursive: true });
    for (let i = 0; i < 40; i++) writeFileSync(join(ws(), `m${String(i).padStart(2, '0')}`), Buffer.alloc(1024 * 1024));
    let calls = 0;
    // Plenty at the first look, then 20 MiB: under the 32 MiB floor before 64 MiB were written.
    _setFreeBytesForTesting(() => (++calls === 1 ? 1024 * 1024 * 1024 : 20 * 1024 * 1024));
    try {
      await expect(writeWorkspaceArchive(dir, join(dir, 'w.tar'))).rejects.toThrow(ExportSpaceError);
    } finally {
      _setFreeBytesForTesting(null);
    }
  });

  it('yields between the chunks of one large file', async () => {
    mkdirSync(ws(), { recursive: true });
    writeFileSync(join(ws(), 'one.bin'), Buffer.alloc(2 * 1024 * 1024));
    let ticks = 0;
    let stop = false;
    const tick = (): void => { ticks++; if (!stop) setImmediate(tick); };
    setImmediate(tick);
    await writeWorkspaceArchive(dir, join(dir, 'w.tar'));
    stop = true;
    // 32 chunks of 64 KiB; one yield per file alone would give a handful of ticks.
    expect(ticks).toBeGreaterThan(20);
  });

  it('yields between files, not only between chunks', async () => {
    mkdirSync(ws(), { recursive: true });
    for (let i = 0; i < 20; i++) writeFileSync(join(ws(), `e${i}`), '');
    let finished = false;
    const pending = writeWorkspaceArchive(dir, join(dir, 'w.tar')).then(m => { finished = true; return m; });
    await new Promise(r => setImmediate(r));
    expect(finished).toBe(false);
    expect((await pending).files).toHaveLength(20);
  });

  it('refuses a staging directory that is a link, and the sweep removes nothing through it', () => {
    const victim = join(dir, 'victim');
    mkdirSync(join(victim, 'workspace-keepme'), { recursive: true });
    symlinkSync(victim, join(dir, EXPORT_STAGING_DIR));
    expect(() => sweepExportStaging(dir)).toThrow(/not a directory of this process/);
    expect(() => stageArchive(dir, 0)).toThrow(/not a directory of this process/);
    expect(readdirSync(victim)).toEqual(['workspace-keepme']);
  });

  it('the sweep removes only what a request made', () => {
    stageArchive(dir, 0);
    writeFileSync(join(dir, EXPORT_STAGING_DIR, 'operator-note'), 'x');
    expect(sweepExportStaging(dir)).toBe(1);
    expect(readdirSync(join(dir, EXPORT_STAGING_DIR))).toEqual(['operator-note']);
  });

  it('fails closed before writing when the disk cannot hold the archive', async () => {
    expect(() => stageArchive(dir, Number.MAX_SAFE_INTEGER / 2)).toThrow(ExportSpaceError);
    expect(readdirSync(join(dir, EXPORT_STAGING_DIR))).toEqual([]);
  });

  it('the boot sweep removes what a crashed export left behind', async () => {
    const left = stageArchive(dir, 0);
    writeFileSync(left.path, 'half an archive');
    expect(sweepExportStaging(dir)).toBe(1);
    expect(existsSync(left.dir)).toBe(false);
    expect(readdirSync(join(dir, EXPORT_STAGING_DIR))).toEqual([]);
    expect(sweepExportStaging(join(dir, 'nothing-here'))).toBe(0);
  });
});
