import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ArtifactFileRefusedError, ArtifactStore, ArtifactVersionRefusedError } from './artifact-store.js';

/**
 * The store reaches its files through an open handle on its directory: a link put into the
 * directory is neither written through nor read through, and a content file with a second name
 * is not written. Each case has a control with an ordinary file.
 */

let dir: string;
let outside: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-store-links-')));
  outside = realpathSync(mkdtempSync(join(tmpdir(), 'lynox-store-out-')));
  writeFileSync(join(outside, 'secret.txt'), 'SECRET\n');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const refusalOf = (run: () => unknown): ArtifactFileRefusedError | null => {
  try { run(); } catch (err) { if (err instanceof ArtifactFileRefusedError) return err; throw err; }
  return null;
};

/** Every file below `root`, with its content, so a test can say no copy of a text landed there. */
function contents(root: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(root)) {
    const p = join(root, name);
    const st = lstatSync(p);
    if (st.isDirectory()) out.push(...contents(p));
    else if (st.isFile()) out.push(readFileSync(p, 'utf-8'));
  }
  return out;
}

describe('an update by id', () => {
  it('control: writes an ordinary content file and keeps the prior content as a version', () => {
    const store = new ArtifactStore(dir);
    const a = store.save({ title: 't', content: 'first' });
    const b = store.save({ id: a.id, title: 't', content: 'second' });
    expect(readFileSync(join(dir, `${a.id}.html`), 'utf-8')).toBe('second');
    expect(readFileSync(b.overwrite!.backupPath, 'utf-8')).toBe('first');
    expect(b.version).toBe(2);
  });

  it('refuses a link at the content file, writes nothing through it, copies nothing from it, and leaves the entry as it was', () => {
    const store = new ArtifactStore(dir);
    const a = store.save({ title: 't', content: 'first' });
    rmSync(join(dir, `${a.id}.html`));
    symlinkSync(join(outside, 'secret.txt'), join(dir, `${a.id}.html`));
    const err = refusalOf(() => store.save({ id: a.id, title: 'changed', content: 'second' }));
    expect(err?.reason).toBe('link');
    expect(err?.path).toBe(join(dir, `${a.id}.html`));
    expect(err?.message).toBe(`${join(dir, `${a.id}.html`)}: a link on the way to the file is not followed; nothing was written`);
    expect(readFileSync(join(outside, 'secret.txt'), 'utf-8')).toBe('SECRET\n');
    // The prior content was read through the handle, so the link's target was not snapshotted.
    expect(contents(dir).some(c => c.includes('SECRET'))).toBe(false);
    const meta = new ArtifactStore(dir).list().find(m => m.id === a.id);
    expect(meta?.version).toBe(1);
    expect(meta?.title).toBe('t');
  });

  it('refuses a content file with a second name and leaves the other name as it was', () => {
    const store = new ArtifactStore(dir);
    const a = store.save({ title: 't', content: 'first' });
    linkSync(join(dir, `${a.id}.html`), join(outside, 'second.html'));
    const err = refusalOf(() => store.save({ id: a.id, title: 't', content: 'second' }));
    expect(err?.reason).toBe('second-name');
    expect(err?.message).toBe(`${join(dir, `${a.id}.html`)} has more than one name (a hard link); nothing was written`);
    expect(readFileSync(join(outside, 'second.html'), 'utf-8')).toBe('first');
  });
});

describe('a file with a second name outside is not read', () => {
  it('by the snapshot before an update, so its content lands in no version', () => {
    const store = new ArtifactStore(dir);
    const a = store.save({ title: 't', content: 'first' });
    rmSync(join(dir, `${a.id}.html`));
    linkSync(join(outside, 'secret.txt'), join(dir, `${a.id}.html`));
    expect(refusalOf(() => store.save({ id: a.id, title: 't', content: 'second' }))?.reason).toBe('second-name');
    expect(contents(join(dir)).filter(c => c.includes('SECRET'))).toEqual(['SECRET\n']); // the linked file itself only
    expect(readFileSync(join(outside, 'secret.txt'), 'utf-8')).toBe('SECRET\n');
  });

  it('by a restore of a version with a second name', () => {
    const store = new ArtifactStore(dir);
    const a = store.save({ title: 't', content: 'first' });
    mkdirSync(join(dir, 'versions'));
    linkSync(join(outside, 'secret.txt'), join(dir, 'versions', `${a.id}.v3.html`));
    expect(() => store.restore(a.id, 3)).toThrow(ArtifactVersionRefusedError);
    expect(readFileSync(join(dir, `${a.id}.html`), 'utf-8')).toBe('first');
  });

  it('by get', () => {
    const store = new ArtifactStore(dir);
    const a = store.save({ title: 't', content: 'first' });
    rmSync(join(dir, `${a.id}.html`));
    linkSync(join(outside, 'secret.txt'), join(dir, `${a.id}.html`));
    expect(store.get(a.id)).toBeNull();
  });
});

describe('the index', () => {
  it('control: is written as a regular file', () => {
    new ArtifactStore(dir).save({ title: 't', content: 'x' });
    expect(lstatSync(join(dir, 'index.json')).isFile()).toBe(true);
  });

  it('replaces a link at index.json instead of writing through it', () => {
    symlinkSync(join(outside, 'secret.txt'), join(dir, 'index.json'));
    const store = new ArtifactStore(dir);
    store.save({ title: 't', content: 'x' });
    expect(readFileSync(join(outside, 'secret.txt'), 'utf-8')).toBe('SECRET\n');
    expect(lstatSync(join(dir, 'index.json')).isFile()).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'index.json'), 'utf-8'))).toHaveLength(1);
  });

  it('is not read through a link', () => {
    writeFileSync(join(outside, 'index.json'), JSON.stringify([{ id: 'abcdef12', title: 'planted', description: '', type: 'html', createdAt: '', updatedAt: '', threadId: '', version: 1 }]));
    symlinkSync(join(outside, 'index.json'), join(dir, 'index.json'));
    expect(new ArtifactStore(dir).list()).toEqual([]);
  });
});

describe('versions', () => {
  it('replaces a link at a version file instead of writing through it', () => {
    const store = new ArtifactStore(dir);
    const a = store.save({ title: 't', content: 'first' });
    mkdirSync(join(dir, 'versions'));
    symlinkSync(join(outside, 'secret.txt'), join(dir, 'versions', `${a.id}.v1.html`));
    store.save({ id: a.id, title: 't', content: 'second' });
    expect(readFileSync(join(outside, 'secret.txt'), 'utf-8')).toBe('SECRET\n');
    expect(lstatSync(join(dir, 'versions', `${a.id}.v1.html`)).isFile()).toBe(true);
    expect(readFileSync(join(dir, 'versions', `${a.id}.v1.html`), 'utf-8')).toBe('first');
  });

  it('writes no version into a linked versions folder and prunes nothing there', () => {
    const store = new ArtifactStore(dir);
    const a = store.save({ title: 't', content: 'v1' });
    // Files there named like this artifact's versions: pruning by name would remove some.
    for (let n = 1; n <= 12; n++) writeFileSync(join(outside, `${a.id}.v${n}.html`), `kept ${n}`);
    symlinkSync(outside, join(dir, 'versions'));
    for (let n = 2; n <= 4; n++) store.save({ id: a.id, title: 't', content: `v${n}` });
    expect(readFileSync(join(dir, `${a.id}.html`), 'utf-8')).toBe('v4');
    const left = readdirSync(outside).sort();
    expect(left).toHaveLength(13);
    for (let n = 1; n <= 12; n++) expect(readFileSync(join(outside, `${a.id}.v${n}.html`), 'utf-8')).toBe(`kept ${n}`);
    expect(store.history(a.id)).toEqual([]);
  });

  it('control: prunes its own versions beyond the ring', () => {
    const store = new ArtifactStore(dir);
    const a = store.save({ title: 't', content: 'v1' });
    for (let n = 2; n <= 13; n++) store.save({ id: a.id, title: 't', content: `v${n}` });
    expect(readdirSync(join(dir, 'versions'))).toHaveLength(10);
  });

  it('restores no version that is a link, and copies nothing from its target', () => {
    const store = new ArtifactStore(dir);
    const a = store.save({ title: 't', content: 'first' });
    mkdirSync(join(dir, 'versions'));
    symlinkSync(join(outside, 'secret.txt'), join(dir, 'versions', `${a.id}.v3.html`));
    expect(() => store.restore(a.id, 3)).toThrow(ArtifactVersionRefusedError);
    expect(readFileSync(join(dir, `${a.id}.html`), 'utf-8')).toBe('first');
    expect(contents(dir).some(c => c.includes('SECRET'))).toBe(false);
  });

  it('control: restores an ordinary version', () => {
    const store = new ArtifactStore(dir);
    const a = store.save({ title: 't', content: 'first' });
    store.save({ id: a.id, title: 't', content: 'second' });
    expect(store.restore(a.id, 1)?.content).toBe('first');
  });
});

describe('reading an artifact', () => {
  it('returns nothing for a content file that is a link', () => {
    const store = new ArtifactStore(dir);
    const a = store.save({ title: 't', content: 'first' });
    rmSync(join(dir, `${a.id}.html`));
    symlinkSync(join(outside, 'secret.txt'), join(dir, `${a.id}.html`));
    expect(store.get(a.id)).toBeNull();
  });

  it('control: returns an ordinary artifact', () => {
    const store = new ArtifactStore(dir);
    const a = store.save({ title: 't', content: 'first' });
    expect(store.get(a.id)?.content).toBe('first');
  });
});

describe('a new artifact under an id the index does not hold', () => {
  it('refuses a link at its file and adds no entry', () => {
    symlinkSync(join(outside, 'secret.txt'), join(dir, 'abcdef12.html'));
    const store = new ArtifactStore(dir);
    expect(refusalOf(() => store.save({ id: 'abcdef12', title: 't', content: 'x' }))?.reason).toBe('link');
    expect(readFileSync(join(outside, 'secret.txt'), 'utf-8')).toBe('SECRET\n');
    expect(store.list().some(m => m.id === 'abcdef12')).toBe(false);
    store.save({ title: 'other', content: 'y' }); // writes the index
    expect(new ArtifactStore(dir).list().map(m => m.title)).toEqual(['other']);
  });
});

describe('a new artifact', () => {
  it('is created with the mode a write by name gives it', () => {
    const umask = process.umask();
    const a = new ArtifactStore(dir).save({ title: 't', content: 'x' });
    expect(statSync(join(dir, `${a.id}.html`)).mode & 0o777).toBe(0o666 & ~umask);
    expect(statSync(join(dir, 'index.json')).mode & 0o777).toBe(0o666 & ~umask);
  });
});

describe('a store directory that is itself a link', () => {
  it('works through the directory it resolved to when it was made', () => {
    const real = join(outside, 'real-artifacts');
    mkdirSync(real);
    const linked = join(dir, 'artifacts');
    symlinkSync(real, linked);
    const a = new ArtifactStore(linked).save({ title: 't', content: 'x' });
    expect(readFileSync(join(real, `${a.id}.html`), 'utf-8')).toBe('x');
  });
});

describe('the held handle on the store directory', () => {
  it('stays with the directory when a folder above it is swapped for a link', () => {
    const base = join(dir, 'data');
    mkdirSync(join(base, 'artifacts'), { recursive: true });
    mkdirSync(join(outside, 'artifacts'));
    const store = new ArtifactStore(join(base, 'artifacts'));
    renameSync(base, join(dir, 'data.old'));
    symlinkSync(outside, base);
    const a = store.save({ title: 't', content: 'x' });
    expect(readdirSync(join(outside, 'artifacts'))).toEqual([]);
    expect(readFileSync(join(dir, 'data.old', 'artifacts', `${a.id}.html`), 'utf-8')).toBe('x');
  });

  it('deletes in the directory it holds, not through a folder above it swapped for a link', () => {
    const base = join(dir, 'data');
    mkdirSync(join(base, 'artifacts'), { recursive: true });
    mkdirSync(join(outside, 'artifacts'));
    const store = new ArtifactStore(join(base, 'artifacts'));
    const a = store.save({ title: 't', content: 'x' });
    writeFileSync(join(outside, 'artifacts', `${a.id}.html`), 'kept');
    renameSync(base, join(dir, 'data.old'));
    symlinkSync(outside, base);
    expect(store.delete(a.id)).toBe(true);
    expect(readFileSync(join(outside, 'artifacts', `${a.id}.html`), 'utf-8')).toBe('kept');
    expect(existsSync(join(dir, 'data.old', 'artifacts', `${a.id}.html`))).toBe(false);
  });

  it('opens the directory again when it was deleted, and writes there', () => {
    const store = new ArtifactStore(join(dir, 'artifacts'));
    store.save({ title: 'before', content: 'x' });
    rmSync(join(dir, 'artifacts'), { recursive: true, force: true });
    const a = store.save({ title: 'after', content: 'y' });
    expect(readFileSync(join(dir, 'artifacts', `${a.id}.html`), 'utf-8')).toBe('y');
  });

  it('after the erasure, forgetAll writes to the directory again', () => {
    const store = new ArtifactStore(join(dir, 'artifacts'));
    store.save({ title: 'before', content: 'x' });
    rmSync(join(dir, 'artifacts'), { recursive: true, force: true });
    store.forgetAll();
    const a = store.save({ title: 'after', content: 'y' });
    expect(readFileSync(join(dir, 'artifacts', `${a.id}.html`), 'utf-8')).toBe('y');
    expect(new ArtifactStore(join(dir, 'artifacts')).list().map(m => m.title)).toEqual(['after']);
  });
});

describe('an error from the kernel', () => {
  it.skipIf(process.getuid?.() === 0)('names the file by its path below the store, not by the process handle', () => {
    const store = new ArtifactStore(dir);
    const a = store.save({ title: 't', content: 'x' });
    chmodSync(join(dir, `${a.id}.html`), 0o444);
    expect(() => store.save({ id: a.id, title: 't', content: 'y' })).toThrow(`EACCES: ${join(dir, `${a.id}.html`)}`);
  });
});

describe('a refused update', () => {
  it('leaves the version ring as it was', () => {
    const store = new ArtifactStore(dir);
    const a = store.save({ title: 't', content: 'v1' });
    for (let n = 2; n <= 12; n++) store.save({ id: a.id, title: 't', content: `v${n}` });
    const before = readdirSync(join(dir, 'versions')).sort();
    expect(before).toHaveLength(10);
    rmSync(join(dir, `${a.id}.html`));
    symlinkSync(join(outside, 'secret.txt'), join(dir, `${a.id}.html`));
    expect(refusalOf(() => store.save({ id: a.id, title: 't', content: 'v13' }))?.reason).toBe('link');
    expect(readdirSync(join(dir, 'versions')).sort()).toEqual(before);
  });

  it('control: an update of a missing content file makes no empty version', () => {
    const store = new ArtifactStore(dir);
    const a = store.save({ title: 't', content: 'v1' });
    rmSync(join(dir, `${a.id}.html`));
    const b = store.save({ id: a.id, title: 't', content: 'v2' });
    expect(b.overwrite?.backupPath).toBe('');
    expect(existsSync(join(dir, 'versions'))).toBe(false);
  });
});

describe('the index file', () => {
  it('keeps the mode it has', () => {
    const store = new ArtifactStore(dir);
    store.save({ title: 't', content: 'x' });
    chmodSync(join(dir, 'index.json'), 0o600);
    store.save({ title: 'u', content: 'y' });
    expect(statSync(join(dir, 'index.json')).mode & 0o777).toBe(0o600);
  });
});

describe('a store that is made', () => {
  it('removes temp files a crash left behind', () => {
    writeFileSync(join(dir, '.lynox-stage-0123456789abcdef01234567'), 'half');
    mkdirSync(join(dir, 'versions'));
    writeFileSync(join(dir, 'versions', '.lynox-stage-89abcdef0123456789abcdef'), 'half');
    new ArtifactStore(dir);
    expect(readdirSync(dir).filter(n => n.startsWith('.lynox-stage-'))).toEqual([]);
    expect(readdirSync(join(dir, 'versions'))).toEqual([]);
  });

  it('does not adopt a file with a second name as an artifact', () => {
    linkSync(join(outside, 'secret.txt'), join(dir, 'abcdef12.html'));
    expect(new ArtifactStore(dir).list()).toEqual([]);
  });

  it('control: adopts an ordinary file named like an artifact', () => {
    writeFileSync(join(dir, 'abcdef12.html'), 'x');
    expect(new ArtifactStore(dir).list().map(m => m.id)).toEqual(['abcdef12']);
  });
});
