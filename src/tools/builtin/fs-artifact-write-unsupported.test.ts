import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * A platform without O_NOFOLLOW (Windows) cannot open the artifacts directory as a handle; there
 * an artifact is written by name, as it was before, rather than not at all.
 */

vi.mock('../../core/workspace-fd.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/workspace-fd.js')>();
  return {
    ...actual,
    openAnchor: () => { throw new actual.WorkspaceAccessError('UNSUPPORTED', 'fd-based workspace access is not available on win32'); },
  };
});

const { writeArtifactFile, writeResolvedFile } = await import('./fs.js');

let root: string;
let prevDataDir: string | undefined;

beforeEach(async () => {
  root = realpathSync(await mkdtemp(join(tmpdir(), 'lynox-artw-unsup-')));
  prevDataDir = process.env['LYNOX_DATA_DIR'];
  process.env['LYNOX_DATA_DIR'] = root;
  await mkdir(join(root, 'artifacts'), { recursive: true });
});

afterEach(async () => {
  if (prevDataDir === undefined) delete process.env['LYNOX_DATA_DIR'];
  else process.env['LYNOX_DATA_DIR'] = prevDataDir;
  await rm(root, { recursive: true, force: true });
});

describe('writeArtifactFile where handles are not available', () => {
  it('writes an existing artifact by name, replacing a longer content whole', async () => {
    const path = join(root, 'artifacts', 'report.html');
    await writeFile(path, 'old and longer');
    expect(() => writeArtifactFile(path, 'new', false)).not.toThrow();
    expect(await readFile(path, 'utf-8')).toBe('new');
  });

  it('replaces a longer content whole when the new one has multi-byte characters', async () => {
    const path = join(root, 'artifacts', 'report.html');
    await writeFile(path, 'a much longer old content');
    expect(() => writeArtifactFile(path, 'Préis 💶', false)).not.toThrow();
    expect(await readFile(path, 'utf-8')).toBe('Préis 💶');
  });

  it('creates a missing artifact and its folder', async () => {
    const path = join(root, 'artifacts', 'a1', 'report.html');
    expect(() => writeArtifactFile(path, 'made', true)).not.toThrow();
    expect(await readFile(path, 'utf-8')).toBe('made');
  });

  it('does not create a missing artifact without create, as the handle-based write does not', async () => {
    const path = join(root, 'artifacts', 'missing.html');
    expect(() => writeArtifactFile(path, 'x', false)).toThrow(/ENOENT/);
    await expect(readFile(path, 'utf-8')).rejects.toThrow(/ENOENT/);
  });

  it('still refuses a path outside the artifacts directory', () => {
    expect(() => writeArtifactFile(join(root, 'elsewhere.txt'), 'x', true)).toThrow(/not in the artifacts directory/);
  });
});

describe('writeResolvedFile where handles are not available', () => {
  it('writes an existing file by name, replacing a longer content whole', async () => {
    const path = join(root, 'workspace', 'a.txt');
    await mkdir(join(root, 'workspace'), { recursive: true });
    await writeFile(path, 'old and longer');
    expect(() => writeResolvedFile(path, 'new', false)).not.toThrow();
    expect(await readFile(path, 'utf-8')).toBe('new');
  });

  it('creates a missing file and its folders', async () => {
    const path = join(root, 'workspace', 'd1', 'a.txt');
    expect(() => writeResolvedFile(path, 'made', true)).not.toThrow();
    expect(await readFile(path, 'utf-8')).toBe('made');
  });
});
