// Which user the installer's containers run as (docker-run-as.ts). Pure
// decisions are tested over their whole input matrix; the filesystem parts
// against real temp directories. The chown walk itself needs root and is
// covered with a mocked fs in docker-run-as-chown.test.ts.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  HELPER_IMAGE,
  IMAGE_IDS,
  chownFileToImage,
  dataOwnerOf,
  decideVaultKey,
  dockerModeFromSecurityOptions,
  freshDataDirProblem,
  handOverFreshDataDir,
  helperChownArgs,
  helperFailure,
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
  const HOSTS: Ids[] = [{ uid: 0, gid: 0 }, USER, IMAGE_IDS, { uid: 1234, gid: 1234 }, { uid: 1000, gid: 0 }];
  const OWNERS: Array<Ids | 'mixed' | null> = [null, 'mixed', { uid: 0, gid: 0 }, USER, IMAGE_IDS, { uid: 1234, gid: 50 }, { uid: 1234, gid: 0 }, { uid: 101000, gid: 101000 }];
  const MODES: DockerMode[] = ['rootful', 'rootless'];

  it('never plans a container as uid 0, in either mode, whatever the host user and the data', () => {
    let runs = 0;
    for (const mode of MODES) {
      for (const host of HOSTS) {
        for (const dataOwner of OWNERS) {
          const plan = planRunAs({ mode, host, dataOwner, dataDir: DIR });
          if (plan.kind !== 'run') continue;
          runs++;
          const where = `${mode}, host ${String(host.uid)}, data ${JSON.stringify(dataOwner)}`;
          expect(plan.engine.uid, where).not.toBe(0);
          expect(plan.engine.gid, where).not.toBe(0);
          expect(plan.search?.uid, where).not.toBe(0);
          expect(plan.search?.gid, where).not.toBe(0);
        }
      }
    }
    expect(runs).toBeGreaterThan(20); // else the loop asserted nothing
  });

  it('installing as root runs both as the image user; a fresh dir is handed over, 1001 data kept, other data refused', () => {
    const ROOT = { uid: 0, gid: 0 };
    for (const mode of ['rootful', 'rootless'] as DockerMode[]) {
      for (const dataOwner of [null, ROOT]) {
        expect(planRunAs({ mode, host: ROOT, dataOwner, dataDir: DIR }), `${mode} ${JSON.stringify(dataOwner)}`)
          .toEqual({ kind: 'run', engine: IMAGE_IDS, search: IMAGE_IDS, chown: 'direct' });
      }
      expect(planRunAs({ mode, host: ROOT, dataOwner: IMAGE_IDS, dataDir: DIR }))
        .toEqual({ kind: 'run', engine: IMAGE_IDS, search: IMAGE_IDS, chown: 'none' });
      for (const dataOwner of ['mixed', USER] as const) {
        expect(planRunAs({ mode, host: ROOT, dataOwner, dataDir: DIR }), `${mode} ${JSON.stringify(dataOwner)}`).toEqual({
          kind: 'refuse',
          reason: `The data in ${DIR} belongs to another user, and lynox runs as uid 1001 here.`,
          command: `chown -R -P 1001:1001 '${DIR}'`,
        });
      }
    }
  });

  it('never group 0 either: a host or data owner in group root gets its own uid as gid', () => {
    expect(planRunAs({ mode: 'rootful', host: { uid: 1000, gid: 0 }, dataOwner: null, dataDir: DIR }))
      .toEqual({ kind: 'run', engine: { uid: 1000, gid: 1000 }, search: { uid: 1000, gid: 1000 }, chown: 'none' });
    expect(planRunAs({ mode: 'rootful', host: USER, dataOwner: { uid: 1234, gid: 0 }, dataDir: DIR }))
      .toEqual({ kind: 'run', engine: { uid: 1234, gid: 1234 }, search: USER, chown: 'none' });
  });

  it('runs as the host user on rootful Docker with no data yet', () => {
    expect(planRunAs({ mode: 'rootful', host: USER, dataOwner: null, dataDir: DIR }))
      .toEqual({ kind: 'run', engine: USER, search: USER, chown: 'none' });
    expect(planRunAs({ mode: 'rootful', host: USER, dataOwner: USER, dataDir: DIR }))
      .toEqual({ kind: 'run', engine: USER, search: USER, chown: 'none' });
  });

  it('rootless: the engine runs as the image user, and the helper hands it the data on every run, whoever owns it', () => {
    for (const dataOwner of [null, USER, 'mixed', IMAGE_IDS, { uid: 101000, gid: 101000 }] as const) {
      expect(planRunAs({ mode: 'rootless', host: USER, dataOwner, dataDir: DIR }), JSON.stringify(dataOwner))
        .toEqual({ kind: 'run', engine: IMAGE_IDS, search: null, chown: 'helper' });
    }
  });

  it('keeps the owner of existing data on rootful Docker: an install whose data belongs to 1001 stays on 1001', () => {
    expect(planRunAs({ mode: 'rootful', host: USER, dataOwner: IMAGE_IDS, dataDir: DIR }))
      .toEqual({ kind: 'run', engine: IMAGE_IDS, search: USER, chown: 'none' });
    expect(planRunAs({ mode: 'rootful', host: USER, dataOwner: { uid: 1234, gid: 50 }, dataDir: DIR }))
      .toEqual({ kind: 'run', engine: { uid: 1234, gid: 50 }, search: USER, chown: 'none' });
  });

  it('refuses root-owned data in either mode, and mixed data on rootful, with the one command that fixes it', () => {
    for (const mode of MODES) {
      expect(planRunAs({ mode, host: USER, dataOwner: { uid: 0, gid: 0 }, dataDir: DIR }), mode).toEqual({
        kind: 'refuse',
        reason: `The databases in ${DIR} belong to root, and lynox does not run as root.`,
        command: `sudo chown -R 1000:1000 '${DIR}'`,
      });
    }
    const mixed = planRunAs({ mode: 'rootful', host: USER, dataOwner: 'mixed', dataDir: DIR });
    expect(mixed).toEqual({
      kind: 'refuse',
      reason: `The databases in ${DIR} belong to more than one user.`,
      command: `sudo chown -R 1000:1000 '${DIR}'`,
    });
  });

  it('quotes a data dir with a quote in it', () => {
    const plan = planRunAs({ mode: 'rootful', host: USER, dataOwner: 'mixed', dataDir: "/home/o'brien/.lynox" });
    expect(plan.kind === 'refuse' && plan.command).toBe(`sudo chown -R 1000:1000 '/home/o'\\''brien/.lynox'`);
  });
});

describe('helperChownArgs', () => {
  it('runs the pinned image with no network, only CHOWN and DAC_READ_SEARCH, and the one mount', () => {
    expect(HELPER_IMAGE).toMatch(/^alpine@sha256:[0-9a-f]{64}$/);
    expect(helperChownArgs(DIR)).toEqual([
      'run', '--rm', '--network', 'none', '--cap-drop', 'ALL', '--cap-add', 'CHOWN', '--cap-add', 'DAC_READ_SEARCH',
      '-v', `${DIR}:/d`, HELPER_IMAGE, 'chown', '-R', '1001:1001', '/d',
    ]);
  });

  it('refuses a path that would split the mount option', () => {
    expect(() => helperChownArgs('/home/a:b/.lynox')).toThrow(/refusing to mount/);
    expect(() => helperChownArgs('/home/a,b/.lynox')).toThrow(/refusing to mount/);
  });
});

describe('helperFailure', () => {
  it('a refused chown names the hand-back command; it hands everything to the host user', () => {
    // The stderr of a real first run: Docker's pull lines come first (measured 2026-10-23).
    const stderr = "Unable to find image 'alpine@sha256:d9e8' locally\nd9e8: Pulling from library/alpine\nchown: /d/rootfile: Operation not permitted\n";
    const f = helperFailure(stderr, USER, DIR);
    expect(f.command).toBe(`sudo chown -R 1000:1000 '${DIR}'`);
    expect(f.reason).toContain('(chown: /d/rootfile: Operation not permitted)');
    expect(f.reason).not.toContain('Unable to find image');
  });

  it('anything else (no image, no daemon) has no command, so it does not send the user round in a loop', () => {
    for (const stderr of ['Unable to find image locally\nError response from daemon: pull access denied', 'Cannot connect to the Docker daemon', '']) {
      const f = helperFailure(stderr, USER, DIR);
      expect(f.command, stderr).toBeNull();
      expect(f.reason, stderr).toContain(HELPER_IMAGE);
    }
  });

  it('quotes the cause, not the pull lines before it or the --help hint after it', () => {
    // Real shape of a failed `docker run`: pull progress, the daemon error, then the CLI's hint.
    for (const hint of ["See 'docker run --help'.", "Run 'docker run --help' for more information"]) {
      const stderr = `Unable to find image 'alpine@sha256:d9e8' locally\nd9e8: Pulling from library/alpine\ndocker: Error response from daemon: pull access denied for alpine.\n${hint}\n`;
      const f = helperFailure(stderr, USER, DIR);
      expect(f.command).toBeNull();
      expect(f.reason).toContain('(docker: Error response from daemon: pull access denied for alpine.)');
    }
  });
});

describe('decideVaultKey', () => {
  const base = { mode: 'rootful' as DockerMode, dataDir: DIR, installEnv: '/home/someone/lynox/.env' };

  it('makes a new key only for a readable data dir without a vault (control)', () => {
    expect(decideVaultKey({ ...base, recoveryKey: null, installKey: null, listable: true, vaultExists: false }))
      .toEqual({ kind: 'new' });
  });

  it('an unreadable data dir counts as holding a vault: the install key, or a refusal, never a new key', () => {
    expect(decideVaultKey({ ...base, recoveryKey: null, installKey: 'K1', listable: false, vaultExists: false }))
      .toEqual({ kind: 'reuse', key: 'K1', from: base.installEnv });
    const refused = decideVaultKey({ ...base, recoveryKey: null, installKey: null, listable: false, vaultExists: false });
    expect(refused.kind).toBe('refuse');
    expect(refused.kind === 'refuse' && refused.command)
      .toBe(`mkdir -p '/home/someone/lynox' && printf '\\n' >> '${base.installEnv}' && sudo grep '^LYNOX_VAULT_KEY=' '${DIR}/.env' >> '${base.installEnv}'`);
    const rootless = decideVaultKey({ ...base, mode: 'rootless', recoveryKey: null, installKey: null, listable: false, vaultExists: false });
    expect(rootless.kind === 'refuse' && rootless.command)
      .toBe(`mkdir -p '/home/someone/lynox' && printf '\\n' >> '${base.installEnv}' && docker run --rm --network none -v '${DIR}:/d:ro' ${HELPER_IMAGE} grep '^LYNOX_VAULT_KEY=' /d/.env >> '${base.installEnv}'`);
  });

  it('a readable vault without any key is refused, not given a new key', () => {
    expect(decideVaultKey({ ...base, recoveryKey: null, installKey: null, listable: true, vaultExists: true }).kind).toBe('refuse');
    expect(decideVaultKey({ ...base, recoveryKey: null, installKey: 'K1', listable: true, vaultExists: true }))
      .toEqual({ kind: 'reuse', key: 'K1', from: base.installEnv });
  });

  it('the recovery copy wins over the install copy', () => {
    expect(decideVaultKey({ ...base, recoveryKey: 'R', installKey: 'K1', listable: true, vaultExists: true }))
      .toEqual({ kind: 'reuse', key: 'R', from: `${DIR}/.env` });
  });
});

describe('on the filesystem', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'lynox-run-as-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  describe('dataOwnerOf', () => {
    it('is null for a missing directory or a symlink, and the owner for a real one', () => {
      expect(dataOwnerOf(join(root, 'missing'))).toBeNull();
      const dir = join(root, '.lynox');
      mkdirSync(dir);
      expect(dataOwnerOf(dir)).toEqual(ME);
      symlinkSync(dir, join(root, 'link'));
      expect(dataOwnerOf(join(root, 'link'))).toBeNull();
      writeFileSync(join(dir, 'engine.db'), '');
      expect(dataOwnerOf(dir)).toEqual(ME);
    });
  });

  describe('precheckDataDir', () => {
    it('passes a directory the engine owns and can write', () => {
      const dir = join(root, '.lynox');
      mkdirSync(dir, { mode: 0o700 });
      expect(precheckDataDir({ mode: 'rootful', host: ME, engine: ME, dataDir: dir })).toBeNull();
      expect(precheckDataDir({ mode: 'rootless', host: ME, engine: IMAGE_IDS, dataDir: dir })).toBeNull();
    });

    it('refuses a directory that belongs to someone else, with the fix', () => {
      const dir = join(root, '.lynox');
      mkdirSync(dir, { mode: 0o700 });
      const other = { uid: ME.uid + 1, gid: ME.gid + 1 };
      expect(precheckDataDir({ mode: 'rootful', host: ME, engine: other, dataDir: dir })).toEqual({
        reason: `${dir} belongs to uid ${String(ME.uid)}, and the container writes as uid ${String(other.uid)}.`,
        command: `sudo chown -R ${String(other.uid)}:${String(other.gid)} '${dir}'`,
      });
      expect(precheckDataDir({ mode: 'rootful', host: ME, engine: other, dataDir: dir })?.reason)
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

    it('passes a directory the engine writes through its group or as anyone, not only as owner', () => {
      const dir = join(root, '.lynox');
      mkdirSync(dir);
      const other = { uid: ME.uid + 1, gid: ME.gid + 1 };
      chmodSync(dir, 0o770);
      expect(precheckDataDir({ mode: 'rootful', host: ME, engine: { uid: other.uid, gid: ME.gid }, dataDir: dir })).toBeNull();
      expect(precheckDataDir({ mode: 'rootful', host: ME, engine: other, dataDir: dir })).not.toBeNull();
      chmodSync(dir, 0o777);
      expect(precheckDataDir({ mode: 'rootful', host: ME, engine: other, dataDir: dir })).toBeNull();
      // The owner's bits decide for the owner, even when others may write;
      // and writing into a directory needs x as well as w.
      chmodSync(dir, 0o577);
      try {
        expect(precheckDataDir({ mode: 'rootful', host: ME, engine: ME, dataDir: dir })).not.toBeNull();
        chmodSync(dir, 0o600);
        expect(precheckDataDir({ mode: 'rootful', host: ME, engine: ME, dataDir: dir })).not.toBeNull();
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

  describe('freshDataDirProblem on a real filesystem (the root-owned cases are in docker-run-as-chown.test.ts)', () => {
    it('refuses any path but <home>/.lynox', () => {
      mkdirSync(join(root, 'other'));
      expect(freshDataDirProblem(join(root, 'other'), root)?.reason).toMatch(/^Only .*\.lynox is handed/);
      expect(freshDataDirProblem('/', root)?.reason).toMatch(/^Only /);
    });

    it.skipIf(ME.uid === 0)('refuses a home that does not belong to root (sudo keeping the user HOME)', () => {
      mkdirSync(join(root, '.lynox'));
      expect(freshDataDirProblem(join(root, '.lynox'), root))
        .toEqual({ reason: `${root} does not belong to root. Run the installer without sudo, or with sudo -H.`, command: null });
      expect(() => { handOverFreshDataDir(join(root, '.lynox'), root); }).toThrow(/does not belong to root/);
    });
  });

  it('chownFileToImage refuses a symlink and a hard link', () => {
    writeFileSync(join(root, 'real.yml'), '');
    symlinkSync(join(root, 'real.yml'), join(root, 'settings.yml'));
    expect(() => { chownFileToImage(join(root, 'settings.yml')); }).toThrow(/not a regular file/);
    linkSync(join(root, 'real.yml'), join(root, 'hard.yml'));
    expect(() => { chownFileToImage(join(root, 'hard.yml')); }).toThrow(/not a regular file with one name/);
  });
});
