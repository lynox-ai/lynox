import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TarWriter, TarNameError, checkTarName, paxRecord } from './tar-writer.js';
import {
  ARCHIVE_MANIFEST_NAME, EXPORT_STAGING_DIR, ExportSpaceError, describeWorkspace, stageArchive,
  sweepExportStaging, writeWorkspaceArchive, type WorkspaceManifest,
} from './workspace-export.js';
import { copyOut, openAnchor, closeAnchor } from './workspace-fd.js';

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
  it('writes a ustar entry that GNU tar reads back byte for byte, with the two end blocks', () => {
    const buf = tarOf([['a/b.txt', Buffer.from('hello')]]);
    expect(buf.length % 512).toBe(0);
    expect(buf.subarray(buf.length - 1024).every(b => b === 0)).toBe(true);
    const entries = readTar(buf);
    expect(entries.map(e => [e.name, e.data.toString()])).toEqual([['a/b.txt', 'hello']]);
    writeFileSync(join(dir, 'x.tar'), buf);
    expect(execFileSync('tar', ['-xOf', join(dir, 'x.tar'), 'a/b.txt']).toString()).toBe('hello');
  });

  it('carries a name over 100 bytes through pax, and GNU tar extracts it under that name', () => {
    const long = `${'d'.repeat(80)}/${'f'.repeat(80)}.txt`;
    const buf = tarOf([[long, Buffer.from('long')]]);
    const [e] = readTar(buf);
    expect(e!.name).toBe(long);
    expect(e!.ustarName.length).toBeLessThanOrEqual(100);
    writeFileSync(join(dir, 'x.tar'), buf);
    expect(execFileSync('tar', ['-tf', join(dir, 'x.tar')]).toString().trim()).toBe(long);
  });

  it('puts a name with a control character into pax and never raw into the ustar field', () => {
    const name = 'evil\x1b[31mname\nline.txt';
    const [e] = readTar(tarOf([[name, Buffer.from('x')]]));
    expect(e!.name).toBe(name);
    expect(e!.ustarName).toMatch(/^[\x20-\x7e]+$/);
    expect(e!.ustarName).not.toContain('\x1b');
  });

  it('puts a non-ASCII name into pax, exactly', () => {
    const name = 'Grüße/日本.txt';
    const [e] = readTar(tarOf([[name, Buffer.from('x')]]));
    expect(e!.name).toBe(name);
    expect(e!.ustarName).toMatch(/^[\x20-\x7e]+$/);
  });

  it.each([['/etc/passwd'], ['../up'], ['a/../b'], ['a//b'], ['./a'], [''], ['a\0b']])('refuses the entry name %j', (name) => {
    expect(() => checkTarName(name)).toThrow(TarNameError);
    expect(() => tarOf([[name, Buffer.from('x')]])).toThrow(TarNameError);
  });

  it('counts the pax record length across a power of ten', () => {
    for (let n = 80; n < 120; n++) {
      const rec = paxRecord('path', 'p'.repeat(n));
      expect(parseInt(rec.toString().split(' ')[0]!, 10)).toBe(rec.length);
    }
  });
});

describe('workspace export', () => {
  const ws = (): string => join(dir, 'workspace');

  it('archives every workspace file with identical bytes, and the manifest hashes what it wrote', () => {
    mkdirSync(join(ws(), 'sub'), { recursive: true });
    writeFileSync(join(ws(), 'report.md'), '# Report');
    writeFileSync(join(ws(), 'sub', 'data.csv'), 'a,b\n1,2\n');
    stageArchive(dir, 0);
    const out = join(dir, 'w.tar');
    const manifest = writeWorkspaceArchive(dir, out);
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

  it.skipIf(isRoot)('names an unreadable file and an unreadable directory, and still delivers the rest', () => {
    mkdirSync(join(ws(), 'locked'), { recursive: true });
    writeFileSync(join(ws(), 'ok.txt'), 'fine');
    writeFileSync(join(ws(), 'secret.txt'), 'no');
    writeFileSync(join(ws(), 'locked', 'inner.txt'), 'no');
    chmodSync(join(ws(), 'secret.txt'), 0o000);
    chmodSync(join(ws(), 'locked'), 0o000);
    const out = join(dir, 'w.tar');
    const manifest = writeWorkspaceArchive(dir, out);
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

  it.skipIf(isRoot)('a backup-style copy without the callback still fails on an unreadable file', () => {
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

  it('lists a symlink and a FIFO as skipped and never follows or copies them', () => {
    mkdirSync(ws(), { recursive: true });
    writeFileSync(join(dir, 'outside.txt'), 'OUTSIDE');
    symlinkSync(join(dir, 'outside.txt'), join(ws(), 'link'));
    execFileSync('mkfifo', [join(ws(), 'pipe')]);
    const out = join(dir, 'w.tar');
    const manifest = writeWorkspaceArchive(dir, out);
    expect(manifest.skipped.sort()).toEqual(['link', 'pipe']);
    expect(manifest.may_be_incomplete).toBe(true);
    expect(readFileSync(out).includes('OUTSIDE')).toBe(false);
  });

  it('answers present:false and an archive holding only the manifest when there is no workspace', () => {
    const out = join(dir, 'w.tar');
    expect(writeWorkspaceArchive(dir, out).present).toBe(false);
    expect(readTar(readFileSync(out)).map(e => e.name)).toEqual([ARCHIVE_MANIFEST_NAME]);
    expect(describeWorkspace(dir).present).toBe(false);
  });

  it('stages each request in its own 0700 directory and refuses an archive path that exists', () => {
    const a = stageArchive(dir, 0);
    const b = stageArchive(dir, 0);
    expect(a.dir).not.toBe(b.dir);
    expect(statSync(a.dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, EXPORT_STAGING_DIR)).mode & 0o777).toBe(0o700);
    writeFileSync(a.path, 'planted');
    expect(() => writeWorkspaceArchive(dir, a.path)).toThrow(/EEXIST/);
  });

  it('fails closed before writing when the disk cannot hold the archive', () => {
    expect(() => stageArchive(dir, Number.MAX_SAFE_INTEGER / 2)).toThrow(ExportSpaceError);
    expect(readdirSync(join(dir, EXPORT_STAGING_DIR))).toEqual([]);
  });

  it('the boot sweep removes what a crashed export left behind', () => {
    const left = stageArchive(dir, 0);
    writeFileSync(left.path, 'half an archive');
    expect(sweepExportStaging(dir)).toBe(1);
    expect(existsSync(left.dir)).toBe(false);
    expect(readdirSync(join(dir, EXPORT_STAGING_DIR))).toEqual([]);
    expect(sweepExportStaging(join(dir, 'nothing-here'))).toBe(0);
  });
});
