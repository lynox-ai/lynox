import { describe, it, expect, afterEach } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  buildShellIsolation,
  checkNothingByName,
  contextLabel,
  resetShellIsolationForTest,
  ShellIsolationError,
  SIDECAR_ROOT_FD,
  WORKSPACE_LABEL,
  type ShellIsolationInputs,
} from './shell-isolation.js';
import { resolveContext } from './context.js';
import { otherNamesFor, parseMountinfo, unescapeMountField } from './sidecar-mounts.js';
import type { WorkspaceAnchor } from './workspace-fd.js';
import type { LynoxConfig } from '../types/index.js';

const SOCKET = '/run/lynox-exec/exec.sock';
const fakeAnchor = { kind: 'anchor', fd: SIDECAR_ROOT_FD, pathBuf: Buffer.from(WORKSPACE_LABEL) } as unknown as WorkspaceAnchor;

const DATA = '/home/lynox/.lynox';
const ROOT_MOUNT = 500;
const DATA_MOUNT = 400;
const MOUNTINFO = [
  `1 0 0:50 / / ro,relatime - overlay overlay rw`,
  `${DATA_MOUNT} 1 8:1 /var/lib/docker/volumes/p_lynox-data/_data ${DATA} rw,relatime - ext4 /dev/sda1 rw`,
  `${ROOT_MOUNT} 1 8:1 /var/lib/docker/volumes/p_workspace/_data /run/lynox-anchor/ws rw,relatime - ext4 /dev/sda1 rw`,
  `510 1 8:1 /var/lib/docker/containers/abc/hosts /etc/hosts rw,relatime - ext4 /dev/sda1 rw`,
].join('\n') + '\n';

type TestInputs = ShellIsolationInputs & { anchored: Array<[number, string]>; logged: string[]; probed: string[] };

/**
 * Inputs of a healthy sidecar boot (every D2 check passes), with fd 3 a directory (`dir`) or not,
 * the socket env as given, and any input replaced.
 */
function inputs(socket: string | undefined, dir: boolean, over: Partial<ShellIsolationInputs> = {}): TestInputs {
  const anchored: Array<[number, string]> = [];
  const logged: string[] = [];
  const probed: string[] = [];
  return {
    socket,
    isDirFd: (fd) => fd === SIDECAR_ROOT_FD && dir,
    anchorFromFd: (fd, label) => { anchored.push([fd, label]); return fakeAnchor; },
    ids: () => ({ uid: 1001, euid: 1001, gid: 1001, egid: 1001, groups: [1002] }),
    procStatus: () => 'Name:\tnode\nCapInh:\t0000000000000000\nCapEff:\t0000000000000000\nNoNewPrivs:\t1\n',
    fstatFd: (fd) => fd === SIDECAR_ROOT_FD ? { uid: 1001, mode: 0o755, dev: 2049n, ino: 12n } : { uid: 1001, mode: 0o644, dev: 9n, ino: 99n },
    mountIdOfFd: (fd) => fd === SIDECAR_ROOT_FD ? ROOT_MOUNT : 600,
    mountIdOfDir: (path) => path === DATA ? DATA_MOUNT : null,
    mountinfo: () => MOUNTINFO,
    env: () => undefined,
    openFds: () => [0, 1, 2, 3, 19, 21],
    probeChild: (d) => { probed.push(d); return d === WORKSPACE_LABEL ? 'EROFS' : 'ENOENT'; },
    dataDir: DATA,
    log: (line) => { logged.push(line); },
    ...over,
    anchored,
    logged,
    probed,
  };
}

function failure(f: () => unknown): ShellIsolationError {
  try { f(); } catch (err) { if (err instanceof ShellIsolationError) return err; throw err; }
  throw new Error('expected a ShellIsolationError');
}

describe('the shell mode is built once from the env and fd 3 (PRD shell-sidecar-activation D1)', () => {
  it('is local without the socket and without a directory on fd 3 (self-host, unchanged)', () => {
    const i = inputs(undefined, false);
    expect(buildShellIsolation(i)).toEqual({ kind: 'local' });
    expect(i.anchored).toEqual([]);
  });

  it('is sidecar with the socket and the anchor on fd 3, under the label from the constant', () => {
    const i = inputs(SOCKET, true);
    expect(buildShellIsolation(i)).toEqual({ kind: 'sidecar', socket: SOCKET, root: { mode: 'sidecar', anchor: fakeAnchor, label: '/workspace' } });
    expect(i.anchored).toEqual([[3, '/workspace']]);
  });

  it('exits on a socket without the anchor: check (a)', () => {
    const err = failure(() => buildShellIsolation(inputs(SOCKET, false)));
    expect(err.check).toBe('a');
    expect(err.message).toMatch(/^Shell sidecar start check \(a\) failed: .*fd 3 is not an open directory/);
  });

  it('exits on the anchor without the socket: a template that hands over the tree without the sidecar', () => {
    const err = failure(() => buildShellIsolation(inputs(undefined, true)));
    expect(err.check).toBe('a');
    expect(err.message).toMatch(/fd 3 is a directory but LYNOX_SHELL_EXEC_SOCKET is not set/);
  });

  it.each([[''], ['   '], ['\t\n']])('exits on a socket that is set but blank (%j), even with the anchor: never "run here"', (value) => {
    expect(failure(() => buildShellIsolation(inputs(value, true))).check).toBe('socket');
    expect(failure(() => buildShellIsolation(inputs(value, false))).check).toBe('socket');
  });

  it('reads the real fd 3 of this process: a closed fd or any non-directory is not the anchor', () => {
    // The process's own inputs; under the test runner fd 3 is no directory (or closed).
    resetShellIsolationForTest();
    const saved = process.env['LYNOX_SHELL_EXEC_SOCKET'];
    delete process.env['LYNOX_SHELL_EXEC_SOCKET'];
    try {
      expect(buildShellIsolation()).toEqual({ kind: 'local' });
    } finally {
      if (saved !== undefined) process.env['LYNOX_SHELL_EXEC_SOCKET'] = saved;
      resetShellIsolationForTest();
    }
  });
});

describe('the D2 start checks, each one firing with its name (PRD shell-sidecar-activation D2)', () => {
  const build = (over: Partial<ShellIsolationInputs>) => buildShellIsolation(inputs(SOCKET, true, over));
  const check = (over: Partial<ShellIsolationInputs>) => failure(() => build(over));

  it('passes a healthy layout, probes the root label and <data>/workspace, and logs the witness line once', () => {
    const i = inputs(SOCKET, true);
    expect(buildShellIsolation(i).kind).toBe('sidecar');
    expect(i.probed).toEqual(['/workspace', `${DATA}/workspace`]);
    expect(i.logged).toEqual(['[lynox] sidecar anchor: fd=3 dev=2049 ino=12 uid=1001 mode=0755']);
  });

  describe('(h) identity', () => {
    const ids = { uid: 1001, euid: 1001, gid: 1001, egid: 1001, groups: [1002] };
    it.each([
      ['uid', { ...ids, uid: 0 }], ['euid', { ...ids, euid: 0 }], ['gid', { ...ids, gid: 1002 }], ['egid', { ...ids, egid: 0 }],
    ])('fires on a wrong %s', (_, v) => {
      const err = check({ ids: () => v });
      expect(err.check).toBe('h');
      expect(err.message).toMatch(/must be 1001:1001/);
    });
    it('fires without the shared group 1002', () => {
      expect(check({ ids: () => ({ ...ids, groups: [1001] }) }).message).toMatch(/\(h\) failed: .*supplementary group 1002/);
    });
    it.each([
      ['a capability left', 'CapEff:\t0000000000000400\nNoNewPrivs:\t1\n', /CapEff 0000000000000400/],
      ['CapEff missing', 'NoNewPrivs:\t1\n', /CapEff missing/],
      ['NoNewPrivs 0', 'CapEff:\t0000000000000000\nNoNewPrivs:\t0\n', /NoNewPrivs is 0/],
      ['NoNewPrivs missing', 'CapEff:\t0000000000000000\n', /NoNewPrivs is missing/],
    ])('fires on %s', (_, status, msg) => {
      const err = check({ procStatus: () => status });
      expect(err.check).toBe('h');
      expect(err.message).toMatch(msg);
    });
    it('fires when /proc/self/status cannot be read, never passes', () => {
      expect(check({ procStatus: () => { throw new Error('ENOENT'); } }).check).toBe('h');
    });
    it('runs before the anchor is read: a stage that kept uid 0 is named as such, not by fd 3', () => {
      const i = inputs(SOCKET, false, { ids: () => ({ ...ids, uid: 0, euid: 0 }) });
      expect(failure(() => buildShellIsolation(i)).check).toBe('h');
    });
  });

  describe('(b) ownership', () => {
    it.each([
      ['owner root', { uid: 0, mode: 0o755 }, /owner 0 and mode 0755/],
      ['a pool-writable mode', { uid: 1001, mode: 0o775 }, /owner 1001 and mode 0775/],
      ['setgid on the root', { uid: 1001, mode: 0o2755 }, /mode 2755/],
    ])('fires on %s', (_, st, msg) => {
      const err = check({ fstatFd: () => ({ ...st, dev: 1n, ino: 1n }) });
      expect(err.check).toBe('b');
      expect(err.message).toMatch(msg);
    });
  });

  describe('(c) own mount', () => {
    it('fires when fd 3 is on the data directory\'s mount', () => {
      const err = check({ mountIdOfDir: () => ROOT_MOUNT });
      expect(err.check).toBe('c');
      expect(err.message).toMatch(/on the data directory's mount/);
    });
    it('fires when a mount id cannot be read, never passes', () => {
      expect(check({ mountIdOfDir: () => null }).check).toBe('c');
      expect(check({ mountIdOfFd: (fd) => fd === SIDECAR_ROOT_FD ? null : 600 }).check).toBe('c');
    });
    it('reads the data directory the inputs name', () => {
      const seen: string[] = [];
      build({ mountIdOfDir: (p) => { seen.push(p); return DATA_MOUNT; } });
      expect(seen).toEqual([DATA]);
    });
  });

  describe('(d) no second name for the tree', () => {
    const extra = (line: string) => ({ mountinfo: () => MOUNTINFO + line + '\n' });
    it.each([
      ['the same root again', `520 1 8:1 /var/lib/docker/volumes/p_workspace/_data /mnt/x rw - ext4 /dev/sda1 rw`],
      ['a subdirectory of it', `520 1 8:1 /var/lib/docker/volumes/p_workspace/_data/http-api /mnt/x rw - ext4 /dev/sda1 rw`],
      ['an ancestor of it', `520 1 8:1 /var/lib/docker /mnt/x rw - ext4 /dev/sda1 rw`],
      ['the whole filesystem', `520 1 8:1 / /host rw - ext4 /dev/sda1 rw`],
      ['an escaped name for it', `520 1 8:1 /var/lib/docker/volumes/p_workspace/_data/a\\040b /mnt/x rw - ext4 /dev/sda1 rw`],
    ])('fires on %s', (_, line) => {
      const err = check(extra(line));
      expect(err.check).toBe('d');
      expect(err.message).toMatch(/mount 520 shows the workspace tree/);
    });
    it.each([
      ['a sibling by string prefix', `520 1 8:1 /var/lib/docker/volumes/p_workspace/_data2 /mnt/x rw - ext4 /dev/sda1 rw`],
      ['the same root on another device', `520 1 8:2 /var/lib/docker/volumes/p_workspace/_data /mnt/x rw - ext4 /dev/sdb1 rw`],
      ['a namespace file', `520 1 0:4 mnt:[4026531841] /mnt/x rw - nsfs nsfs rw`],
    ])('passes %s', (_, line) => {
      expect(build(extra(line)).kind).toBe('sidecar');
    });
    it('fires when the table cannot be read or misses fd 3\'s mount', () => {
      expect(check({ mountinfo: () => { throw new Error('EACCES'); } }).check).toBe('d');
      expect(check({ mountinfo: () => MOUNTINFO.split('\n').filter((l) => !l.startsWith(`${ROOT_MOUNT} `)).join('\n') }).check).toBe('d');
      expect(check({ mountinfo: () => MOUNTINFO + 'garbage\n' }).check).toBe('d');
    });
  });

  describe('(e) no root by name', () => {
    it.each([['LYNOX_WORKSPACE_ROOT'], ['LYNOX_WORKSPACE']])('fires on %s set, even empty', (name) => {
      for (const value of ['/data/ws', '']) {
        const err = check({ env: (n) => n === name ? value : undefined });
        expect(err.check).toBe('e');
        expect(err.message).toContain(`${name} is set`);
      }
    });
  });

  describe('(g) no other fd into the tree', () => {
    it('fires on another fd with fd 3\'s mount id, by mount id: its dev/ino differ', () => {
      const err = check({ mountIdOfFd: (fd) => fd === SIDECAR_ROOT_FD || fd === 21 ? ROOT_MOUNT : 600 });
      expect(err.check).toBe('g');
      expect(err.message).toMatch(/fd 21 is open on the workspace tree/);
    });
    it('checks fds 0-2 too', () => {
      expect(check({ mountIdOfFd: (fd) => fd === SIDECAR_ROOT_FD || fd === 0 ? ROOT_MOUNT : 600 }).message).toMatch(/fd 0 is open/);
    });
    it('skips an fd that closed after the listing, and fires on any other read failure', () => {
      const gone = Object.assign(new Error('gone'), { code: 'ENOENT' });
      const denied = Object.assign(new Error('denied'), { code: 'EACCES' });
      expect(build({ mountIdOfFd: (fd) => { if (fd === 21) throw gone; return fd === SIDECAR_ROOT_FD ? ROOT_MOUNT : 600; } }).kind).toBe('sidecar');
      expect(check({ mountIdOfFd: (fd) => { if (fd === 21) throw denied; return fd === SIDECAR_ROOT_FD ? ROOT_MOUNT : 600; } }).message).toMatch(/fd 21 cannot be read \(EACCES\)/);
      expect(check({ mountIdOfFd: (fd) => fd === SIDECAR_ROOT_FD ? ROOT_MOUNT : null }).check).toBe('g');
      expect(check({ openFds: () => { throw new Error('no /proc'); } }).check).toBe('g');
    });
  });

  describe('(i) nothing to write by name', () => {
    it.each([['/workspace'], [`${DATA}/workspace`]])('fires when a file can be created under %s', (path) => {
      const err = check({ probeChild: (d) => d === path ? 'created' : 'ENOENT' });
      expect(err.check).toBe('i');
      expect(err.message).toBe(`Shell sidecar start check (i) failed: a file could be created under ${path} by name; in sidecar mode nothing may be written there.`);
    });
    it.each([['EACCES'], ['EEXIST'], ['ENOTDIR']])('fires on any other outcome (%s)', (code) => {
      const err = check({ probeChild: () => code });
      expect(err.check).toBe('i');
      expect(err.message).toContain(`gave ${code}, not ENOENT or EROFS`);
    });
    it('fires on the context label in resolveContext', () => {
      const sidecar = buildShellIsolation(inputs(SOCKET, true));
      const cfg = { context: { id: 'http-api', name: 'lynox', source: 'pwa', workspaceDir: '' } } as unknown as LynoxConfig;
      const seen: string[] = [];
      expect(failure(() => resolveContext(cfg, sidecar, (d) => { seen.push(d); return 'created'; })).message).toMatch(/\(i\) failed: .*under \/workspace\/http-api by name/);
      expect(seen).toEqual(['/workspace/http-api']);
      expect(resolveContext(cfg, sidecar, () => 'EROFS').workspaceDir).toBe('/workspace/http-api');
    });
  });

  describe('the real probe on a real directory', () => {
    const made: string[] = [];
    afterEach(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); made.length = 0; });

    it('creates a child under a writable directory, removes it again and reports it', () => {
      const dir = mkdtempSync(join(tmpdir(), 'probe-'));
      made.push(dir);
      expect(() => checkNothingByName(dir)).toThrow(/\(i\) failed: a file could be created/);
      expect(readdirSync(dir)).toEqual([]);
    });

    it('reports ENOENT for an absent path and creates nothing: no EEXIST, and the path stays absent', () => {
      const dir = mkdtempSync(join(tmpdir(), 'probe-'));
      made.push(dir);
      const absent = join(dir, 'workspace');
      expect(() => checkNothingByName(absent)).not.toThrow();
      expect(existsSync(absent)).toBe(false);
    });

    it('reports a read-only directory as EACCES or EROFS, never as created, and leaves it unchanged', () => {
      const dir = mkdtempSync(join(tmpdir(), 'probe-'));
      made.push(dir);
      chmodSync(dir, 0o555);
      try {
        if (process.getuid?.() === 0) return; // root writes through the mode
        expect(() => checkNothingByName(dir)).toThrow(/gave EACCES, not ENOENT or EROFS/);
        expect(readdirSync(dir)).toEqual([]);
      } finally {
        chmodSync(dir, 0o755);
      }
    });
  });
});

describe('the mountinfo parser (D2 (d))', () => {
  it('unescapes the kernel\'s octal escapes', () => {
    expect(unescapeMountField('/a\\040b\\011c\\012d\\134e')).toBe('/a b\tc\nd\\e');
  });

  it('reads id, device and root by components; skips roots that are not paths', () => {
    const e = parseMountinfo('5 1 8:1 /a/b\\040c /x rw - ext4 /dev/sda1 rw\n6 1 0:4 net:[1] /y rw - nsfs nsfs rw\n7 1 8:1 /gone//deleted /z rw - ext4 /dev/sda1 rw\n');
    expect(e).toEqual([
      { id: 5, device: '8:1', root: ['a', 'b c'] },
      { id: 6, device: '0:4', root: null },
      { id: 7, device: '8:1', root: null },
    ]);
  });

  it('throws on a line without the fixed fields', () => {
    expect(() => parseMountinfo('5 1 x /a /x\n')).toThrow(/not understood/);
    expect(() => parseMountinfo('5 1\n')).toThrow(/not understood/);
  });

  it('compares by components, not by string prefix', () => {
    const e = parseMountinfo('1 0 8:1 /ws /a rw - ext4 d rw\n2 0 8:1 /ws2 /b rw - ext4 d rw\n3 0 8:1 /ws/x /c rw - ext4 d rw\n');
    expect(otherNamesFor(e, 1).map((m) => m.id)).toEqual([3]);
  });

  it('throws when the mount is missing or its root is not a path', () => {
    const e = parseMountinfo('1 0 8:1 /gone//deleted /a rw - ext4 d rw\n');
    expect(() => otherNamesFor(e, 1)).toThrow(/not a path/);
    expect(() => otherNamesFor(e, 9)).toThrow(/not in mountinfo/);
  });

  it('parses this process\'s own table (Linux), and finds the root mount in it', () => {
    if (process.platform !== 'linux') return;
    const e = parseMountinfo(readFileSync('/proc/self/mountinfo', 'utf8'));
    expect(e.length).toBeGreaterThan(0);
    expect(e.some((m) => m.root !== null)).toBe(true);
  });
});

describe('a real process: the start stops on a broken mode, with the check named', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs.length = 0; });

  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  /**
   * Make a tool context in a child process, with fd 3 a directory or not, and print the mode it
   * carries: what every consumer reads. A context made without an engine must carry the process's
   * mode, never a default "local".
   */
  function inChild(env: Record<string, string>, fd3Dir: boolean): { code: number; out: string } {
    const dir = mkdtempSync(join(tmpdir(), 'shell-iso-'));
    dirs.push(dir);
    const script = `import { createToolContext } from ${JSON.stringify(join(repoRoot, 'src/core/tool-context.ts'))};
      try { const c = createToolContext({}); process.stdout.write(c.shellIsolation.kind); } catch (e) { process.stdout.write(String(e.message)); process.exit(7); }`;
    const childEnv: Record<string, string> = { PATH: process.env['PATH'] ?? '', ...env };
    // fd 3 opened by the shell as a directory, as the root stage hands it over.
    const redirect = fd3Dir ? `3<${JSON.stringify(dir)}` : '3<&-';
    try {
      const out = execFileSync('sh', ['-c', `exec "$NODE" --import tsx --input-type=module -e "$SCRIPT" ${redirect}`], {
        env: { ...childEnv, SCRIPT: script, NODE: process.execPath }, encoding: 'utf8', cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { code: 0, out };
    } catch (err) {
      const e = err as { status: number; stdout: string };
      return { code: e.status, out: e.stdout };
    }
  }

  it('runs the start checks on an inherited directory on fd 3 and the socket: identity (h) fires first', () => {
    // The test runner is not uid 1001 with group 1002 and no capabilities, so a real process
    // reaches the checks and stops at (h), before any check that reads fd 3.
    const r = inChild({ LYNOX_SHELL_EXEC_SOCKET: SOCKET }, true);
    expect(r.code).toBe(7);
    expect(r.out).toMatch(/^Shell sidecar start check \(h\) failed: the engine runs as uid \d+/);
  });

  it('stops on the socket without fd 3 (at (h), which runs first, in a process that is not 1001)', () => {
    const r = inChild({ LYNOX_SHELL_EXEC_SOCKET: SOCKET }, false);
    expect(r.code).toBe(7);
    expect(r.out).toMatch(/start check \(h\) failed/);
  });

  it('stays local without either', () => {
    expect(inChild({}, false)).toEqual({ code: 0, out: 'local' });
  });
});

describe('the context label in sidecar mode (D0)', () => {
  const sidecar = buildShellIsolation(inputs(SOCKET, true));
  const config = (workspaceDir: string | undefined): LynoxConfig =>
    ({ context: { id: 'http-api', name: 'lynox', source: 'pwa', workspaceDir } }) as unknown as LynoxConfig;

  it('is /workspace/<ctx.id>, from the constant', () => {
    expect(contextLabel('http-api')).toBe('/workspace/http-api');
    expect(resolveContext(config(''), sidecar).workspaceDir).toBe('/workspace/http-api');
    expect(resolveContext(config(undefined), sidecar).workspaceDir).toBe('/workspace/http-api');
    expect(resolveContext(config('/workspace/http-api'), sidecar).workspaceDir).toBe('/workspace/http-api');
  });

  it('stops the start on a context that names another workspace', () => {
    const err = failure(() => resolveContext(config('/home/lynox/.lynox/workspace/http-api'), sidecar));
    expect(err.check).toBe('D0');
    expect(err.message).toContain('in sidecar mode it is /workspace/http-api');
  });

  it.each([['../x'], ['a/b'], ['..'], ['.'], ['']])('stops the start on a context id that is not one plain component (%j)', (id) => {
    const cfg = { context: { id, name: 'lynox', source: 'pwa', workspaceDir: '' } } as unknown as LynoxConfig;
    expect(failure(() => resolveContext(cfg, sidecar)).check).toBe('D0');
  });

  it('stops the start without an explicit context: no project workspace by name', () => {
    expect(failure(() => resolveContext({} as LynoxConfig, sidecar)).message).toMatch(/needs an explicit context/);
  });

  it('leaves a local process as it was: the context keeps its own workspace', () => {
    expect(resolveContext(config('/some/where'), { kind: 'local' }).workspaceDir).toBe('/some/where');
  });
});

describe('no consumer reads the socket env (D1)', () => {
  it('names LYNOX_SHELL_EXEC_SOCKET only in the boot module and the env registry', () => {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
    // Tracked and untracked source files, tests excluded.
    const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'src', 'packages/web-ui/src'], { cwd: repoRoot, encoding: 'utf8' })
      .split('\n').filter((f) => /\.(ts|mts|cts|tsx|js|mjs|cjs|svelte)$/.test(f) && !/\.test\.ts$/.test(f));
    expect(files.length).toBeGreaterThan(500);
    const naming = files.filter((f) => readFileSync(join(repoRoot, f), 'utf8').includes('LYNOX_SHELL_EXEC_SOCKET'));
    expect(naming.map((f) => relative('.', f)).sort()).toEqual(['src/contract/env-registry.ts', 'src/core/shell-isolation.ts']);
  });
});
