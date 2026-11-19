// dataOwnerOf over files with different owners. Creating files owned by
// another uid needs root, so lstat reports the owners here instead; the
// directory and its files are real.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

const owners = vi.hoisted(() => new Map<string, { uid: number; gid: number }>());

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    lstatSync: ((path: string) => {
      const st = actual.lstatSync(path);
      const ids = owners.get(basename(path));
      return ids === undefined ? st : Object.assign(Object.create(Object.getPrototypeOf(st) as object) as object, st, ids);
    }) as typeof actual.lstatSync,
  };
});

const { dataOwnerOf } = await import('./docker-run-as.js');

const ids = (uid: number, gid = uid) => ({ uid, gid });

describe('dataOwnerOf with files of different owners', () => {
  let dir: string;
  beforeEach(() => {
    dir = join(mkdtempSync(join(tmpdir(), 'lynox-owner-')), '.lynox');
    mkdirSync(dir);
    writeFileSync(join(dir, 'engine.db'), '');
    writeFileSync(join(dir, 'history.db'), '');
    owners.clear();
  });
  afterEach(() => {
    chmodSync(dir, 0o700);
    rmSync(join(dir, '..'), { recursive: true, force: true });
  });

  it('is the one owner when all databases share it, over the directory owner', () => {
    owners.set('.lynox', ids(1000));
    owners.set('engine.db', ids(1001));
    owners.set('history.db', ids(1001));
    expect(dataOwnerOf(dir)).toEqual(ids(1001));
  });

  it('a symlinked database does not count', () => {
    owners.set('engine.db', ids(1001));
    owners.set('history.db', ids(1001));
    symlinkSync(join(dir, 'engine.db'), join(dir, 'link.db'));
    owners.set('link.db', ids(1000));
    expect(dataOwnerOf(dir)).toEqual(ids(1001));
  });

  it('is mixed when they belong to more than one uid', () => {
    owners.set('engine.db', ids(1001));
    owners.set('history.db', ids(1000));
    expect(dataOwnerOf(dir)).toBe('mixed');
  });

  it('counts the SQLite journals: a WAL file of another uid makes it mixed', () => {
    owners.set('engine.db', ids(1001));
    owners.set('history.db', ids(1001));
    writeFileSync(join(dir, 'engine.db-wal'), '');
    owners.set('engine.db-wal', ids(1000));
    expect(dataOwnerOf(dir)).toBe('mixed');
  });

  it('the same uid with another gid is one owner, not mixed', () => {
    owners.set('engine.db', ids(1001, 1001));
    owners.set('history.db', ids(1001, 50));
    expect(dataOwnerOf(dir)).toEqual({ uid: 1001, gid: expect.any(Number) as number });
  });

  it.skipIf(process.getuid?.() === 0)('a directory this user cannot list is judged by its own owner (an install that ran as 1001 left it 0700)', () => {
    owners.set('.lynox', ids(1001));
    owners.set('engine.db', ids(1000));
    owners.set('history.db', ids(1000));
    chmodSync(dir, 0o000);
    expect(dataOwnerOf(dir)).toEqual(ids(1001));
  });
});
