import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  buildShellIsolation,
  contextLabel,
  resetShellIsolationForTest,
  ShellIsolationError,
  SIDECAR_ROOT_FD,
  WORKSPACE_LABEL,
  type ShellIsolationInputs,
} from './shell-isolation.js';
import { resolveContext } from './context.js';
import type { WorkspaceAnchor } from './workspace-fd.js';
import type { LynoxConfig } from '../types/index.js';

const SOCKET = '/run/lynox-exec/exec.sock';
const fakeAnchor = { kind: 'anchor', fd: SIDECAR_ROOT_FD, pathBuf: Buffer.from(WORKSPACE_LABEL) } as unknown as WorkspaceAnchor;

/** Inputs with fd 3 a directory (`dir`) or not, and the socket env as given. */
function inputs(socket: string | undefined, dir: boolean): ShellIsolationInputs & { anchored: Array<[number, string]> } {
  const anchored: Array<[number, string]> = [];
  return {
    socket,
    isDirFd: (fd) => fd === SIDECAR_ROOT_FD && dir,
    anchorFromFd: (fd, label) => { anchored.push([fd, label]); return fakeAnchor; },
    anchored,
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

  it('builds sidecar from an inherited directory on fd 3 and the socket', () => {
    expect(inChild({ LYNOX_SHELL_EXEC_SOCKET: SOCKET }, true)).toEqual({ code: 0, out: 'sidecar' });
  });

  it('stops on the socket without fd 3', () => {
    const r = inChild({ LYNOX_SHELL_EXEC_SOCKET: SOCKET }, false);
    expect(r.code).toBe(7);
    expect(r.out).toMatch(/start check \(a\) failed/);
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
