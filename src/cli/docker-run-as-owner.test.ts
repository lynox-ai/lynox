// dataOwnerOf over databases with different owners. Creating files owned by
// another uid needs root, so lstat reports the owners here instead; the
// directory and its files are real.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

const owners = vi.hoisted(() => new Map<string, number>());

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    lstatSync: ((path: string) => {
      const st = actual.lstatSync(path);
      const uid = owners.get(basename(path));
      return uid === undefined ? st : Object.assign(Object.create(Object.getPrototypeOf(st) as object) as object, st, { uid, gid: uid });
    }) as typeof actual.lstatSync,
  };
});

const { dataOwnerOf } = await import('./docker-run-as.js');

describe('dataOwnerOf with databases of different owners', () => {
  let dir: string;
  beforeEach(() => {
    dir = join(mkdtempSync(join(tmpdir(), 'lynox-owner-')), '.lynox');
    mkdirSync(dir);
    writeFileSync(join(dir, 'engine.db'), '');
    writeFileSync(join(dir, 'history.db'), '');
    owners.clear();
  });
  afterEach(() => { rmSync(join(dir, '..'), { recursive: true, force: true }); });

  it('is the one owner when all databases share it', () => {
    owners.set('engine.db', 1001);
    owners.set('history.db', 1001);
    expect(dataOwnerOf(dir)).toEqual({ uid: 1001, gid: 1001 });
  });

  it('is mixed when they belong to more than one id', () => {
    owners.set('engine.db', 1001);
    owners.set('history.db', 1000);
    expect(dataOwnerOf(dir)).toBe('mixed');
  });
});
