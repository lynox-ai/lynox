// Which user the installer's containers run as (docker-run-as.ts). Pure
// decisions are tested over their whole input matrix; the filesystem parts
// against real temp directories. The chown walk itself needs root and is
// covered with a mocked fs in docker-run-as-chown.test.ts.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  IMAGE_IDS,
  chownDataDirToImage,
  chownFileToImage,
  dataOwnerOf,
  dockerModeFromSecurityOptions,
  planRunAs,
  precheckDataDir,
  type DockerMode,
  type Ids,
} from './docker-run-as.js';

const ME: Ids = { uid: process.getuid?.() ?? 1000, gid: process.getgid?.() ?? 1000 };
const USER: Ids = { uid: 1000, gid: 1000 };
const DIR = '/home/someone/.lynox';

describe('dockerModeFromSecurityOptions', () => {
  it('is rootless only when an option names it', () => {
    expect(dockerModeFromSecurityOptions('["name=seccomp,profile=builtin","name=rootless","name=cgroupns"]')).toBe('rootless');
    expect(dockerModeFromSecurityOptions('["name=seccomp,profile=builtin,name=rootless"]')).toBe('rootless');
  });

  it('is rootful for a rootful daemon and for anything it cannot read', () => {
    for (const raw of [
      '["name=apparmor,profile=default","name=seccomp,profile=builtin","name=cgroupns"]',
      '',
      'not json',
      '[name=rootless]',
      'null',
      '{"name":"rootless"}',
      '["rootless"]',
      '[1,2]',
    ]) {
      expect(dockerModeFromSecurityOptions(raw), raw).toBe('rootful');
    }
  });
});

describe('planRunAs', () => {
  const HOSTS: Ids[] = [{ uid: 0, gid: 0 }, USER, IMAGE_IDS, { uid: 1234, gid: 1234 }];
  const OWNERS: Array<Ids | 'mixed' | null> = [null, 'mixed', { uid: 0, gid: 0 }, USER, IMAGE_IDS, { uid: 1234, gid: 50 }];

  it('never runs a container as uid 0 on rootful Docker, whatever the host user and the data', () => {
    let runs = 0;
    for (const host of HOSTS) {
      for (const dataOwner of OWNERS) {
        const plan = planRunAs({ mode: 'rootful', host, dataOwner, dataDir: DIR });
        if (plan.kind !== 'run') continue;
        runs++;
        expect(plan.engine.uid, `host ${String(host.uid)}, data ${JSON.stringify(dataOwner)}`).not.toBe(0);
        expect(plan.search.uid, `host ${String(host.uid)}, data ${JSON.stringify(dataOwner)}`).not.toBe(0);
      }
    }
    expect(runs).toBeGreaterThan(5); // else the loop asserted nothing
  });

  it('installing as root runs both as the image user and hands the files over, in either mode', () => {
    for (const mode of ['rootful', 'rootless'] as DockerMode[]) {
      for (const dataOwner of OWNERS) {
        expect(planRunAs({ mode, host: { uid: 0, gid: 0 }, dataOwner, dataDir: DIR }))
          .toEqual({ kind: 'run', engine: IMAGE_IDS, search: IMAGE_IDS, chownToImage: true });
      }
    }
  });

  it('runs as the host user on rootful Docker with no data yet', () => {
    expect(planRunAs({ mode: 'rootful', host: USER, dataOwner: null, dataDir: DIR }))
      .toEqual({ kind: 'run', engine: USER, search: USER, chownToImage: false });
  });

  it('runs as 0 on rootless Docker, which is the host user there', () => {
    const self = { uid: 0, gid: 0 };
    expect(planRunAs({ mode: 'rootless', host: USER, dataOwner: null, dataDir: DIR }))
      .toEqual({ kind: 'run', engine: self, search: self, chownToImage: false });
    expect(planRunAs({ mode: 'rootless', host: USER, dataOwner: USER, dataDir: DIR }))
      .toEqual({ kind: 'run', engine: self, search: self, chownToImage: false });
  });

  it('keeps the owner of existing data: an install whose data belongs to 1001 stays on 1001', () => {
    expect(planRunAs({ mode: 'rootful', host: USER, dataOwner: IMAGE_IDS, dataDir: DIR }))
      .toEqual({ kind: 'run', engine: IMAGE_IDS, search: USER, chownToImage: false });
    expect(planRunAs({ mode: 'rootful', host: USER, dataOwner: { uid: 1234, gid: 50 }, dataDir: DIR }))
      .toEqual({ kind: 'run', engine: { uid: 1234, gid: 50 }, search: USER, chownToImage: false });
    // Rootless: data the container wrote as 1001 shows as a subordinate id on the host.
    expect(planRunAs({ mode: 'rootless', host: USER, dataOwner: { uid: 101000, gid: 101000 }, dataDir: DIR }))
      .toEqual({ kind: 'run', engine: IMAGE_IDS, search: { uid: 0, gid: 0 }, chownToImage: false });
  });

  it('refuses root-owned and mixed data with the one command that fixes it', () => {
    const rootData = planRunAs({ mode: 'rootful', host: USER, dataOwner: { uid: 0, gid: 0 }, dataDir: DIR });
    expect(rootData).toEqual({
      kind: 'refuse',
      reason: `The databases in ${DIR} belong to root, and lynox does not run as root.`,
      command: `sudo chown -R 1000:1000 '${DIR}'`,
    });
    const mixed = planRunAs({ mode: 'rootful', host: USER, dataOwner: 'mixed', dataDir: DIR });
    expect(mixed.kind).toBe('refuse');
    expect(mixed.kind === 'refuse' && mixed.command).toBe(`sudo chown -R 1000:1000 '${DIR}'`);
    const rootless = planRunAs({ mode: 'rootless', host: USER, dataOwner: 'mixed', dataDir: DIR });
    expect(rootless.kind === 'refuse' && rootless.command).toBe(`docker run --rm -v '${DIR}':/d alpine chown -R 0:0 /d`);
  });

  it('quotes a data dir with a quote in it', () => {
    const plan = planRunAs({ mode: 'rootful', host: USER, dataOwner: 'mixed', dataDir: "/home/o'brien/.lynox" });
    expect(plan.kind === 'refuse' && plan.command).toBe(`sudo chown -R 1000:1000 '/home/o'\\''brien/.lynox'`);
  });
});

describe('on the filesystem', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'lynox-run-as-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  describe('dataOwnerOf', () => {
    it('is null without databases and the owner with them; a symlinked .db does not count', () => {
      const dir = join(root, '.lynox');
      mkdirSync(dir);
      expect(dataOwnerOf(dir)).toBeNull();
      expect(dataOwnerOf(join(root, 'missing'))).toBeNull();
      writeFileSync(join(root, 'elsewhere.db'), '');
      symlinkSync(join(root, 'elsewhere.db'), join(dir, 'link.db'));
      writeFileSync(join(dir, 'notes.txt'), '');
      expect(dataOwnerOf(dir)).toBeNull();
      writeFileSync(join(dir, 'engine.db'), '');
      expect(dataOwnerOf(dir)).toEqual(ME);
    });
  });

  describe('precheckDataDir', () => {
    it('passes a directory the engine owns and can write', () => {
      const dir = join(root, '.lynox');
      mkdirSync(dir, { mode: 0o700 });
      expect(precheckDataDir({ mode: 'rootful', host: ME, engine: ME, dataDir: dir })).toBeNull();
      expect(precheckDataDir({ mode: 'rootless', host: ME, engine: { uid: 0, gid: 0 }, dataDir: dir })).toBeNull();
    });

    it('refuses a directory that belongs to someone else, with the fix', () => {
      const dir = join(root, '.lynox');
      mkdirSync(dir, { mode: 0o700 });
      const other = { uid: ME.uid + 1, gid: ME.gid + 1 };
      expect(precheckDataDir({ mode: 'rootful', host: ME, engine: other, dataDir: dir })).toEqual({
        reason: `${dir} belongs to uid ${String(ME.uid)}, and the container writes as uid ${String(other.uid)}.`,
        command: `sudo chown -R ${String(other.uid)}:${String(other.gid)} '${dir}'`,
      });
      expect(precheckDataDir({ mode: 'rootless', host: other, engine: { uid: 0, gid: 0 }, dataDir: dir })?.reason)
        .toBe(`${dir} belongs to uid ${String(ME.uid)}, and the container writes as uid ${String(other.uid)}.`);
    });

    it('refuses a directory its owner cannot write', () => {
      const dir = join(root, '.lynox');
      mkdirSync(dir, { mode: 0o500 });
      try {
        expect(precheckDataDir({ mode: 'rootful', host: ME, engine: ME, dataDir: dir })?.command)
          .toBe(`sudo chown -R ${String(ME.uid)}:${String(ME.gid)} '${dir}'`);
      } finally {
        chmodSync(dir, 0o700);
      }
    });

    it('refuses a missing directory and a symlink', () => {
      expect(precheckDataDir({ mode: 'rootful', host: ME, engine: ME, dataDir: join(root, 'nope') }))
        .toEqual({ reason: `${join(root, 'nope')} does not exist.`, command: `mkdir -p '${join(root, 'nope')}'` });
      mkdirSync(join(root, 'real'));
      symlinkSync(join(root, 'real'), join(root, '.lynox'));
      expect(precheckDataDir({ mode: 'rootful', host: ME, engine: ME, dataDir: join(root, '.lynox') })?.reason)
        .toBe(`${join(root, '.lynox')} is not a directory.`);
    });

    it('does not judge a rootless engine running as the image user (a subordinate id it does not compute)', () => {
      const dir = join(root, '.lynox');
      mkdirSync(dir, { mode: 0o700 });
      expect(precheckDataDir({ mode: 'rootless', host: ME, engine: IMAGE_IDS, dataDir: dir })).toBeNull();
    });
  });

  describe('chownDataDirToImage refuses before it touches anything', () => {
    it('refuses any path but <home>/.lynox', () => {
      mkdirSync(join(root, 'other'));
      expect(() => { chownDataDirToImage(join(root, 'other'), root); }).toThrow(/refusing to chown .*only .*\.lynox/);
      expect(() => { chownDataDirToImage('/', root); }).toThrow(/refusing to chown/);
    });

    it('refuses <home>/.lynox when it is a symlink, even to a real directory', () => {
      mkdirSync(join(root, 'target'));
      symlinkSync(join(root, 'target'), join(root, '.lynox'));
      expect(() => { chownDataDirToImage(join(root, '.lynox'), root); }).toThrow(/not a real directory/);
    });

    it.skipIf(ME.uid === 0)('passes the guard for the real directory (the chown itself then needs root)', () => {
      mkdirSync(join(root, '.lynox'));
      expect(() => { chownDataDirToImage(join(root, '.lynox'), root); }).toThrow(/EPERM/);
    });
  });

  it('chownFileToImage refuses a symlink', () => {
    writeFileSync(join(root, 'real.yml'), '');
    symlinkSync(join(root, 'real.yml'), join(root, 'settings.yml'));
    expect(() => { chownFileToImage(join(root, 'settings.yml')); }).toThrow(/not a regular file/);
  });
});
