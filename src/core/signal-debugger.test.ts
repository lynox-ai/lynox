import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SIGNAL_DEBUGGER_OFF, assertSignalDebuggerOff, signalDebuggerOff, startedFromImage } from './signal-debugger.js';

const ROOT = join(__dirname, '..', '..');

/** What a real node child sees as its own execArgv and NODE_OPTIONS, for the given start. */
function startedWith(argv: string[], nodeOptions: string | undefined): { execArgv: string[]; nodeOptions: string | undefined } {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (nodeOptions === undefined) delete env['NODE_OPTIONS']; else env['NODE_OPTIONS'] = nodeOptions;
  const r = spawnSync(process.execPath, [...argv, '-e', 'process.stdout.write(JSON.stringify({ a: process.execArgv, o: process.env.NODE_OPTIONS ?? null }))'], { env, encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
  const seen = JSON.parse(r.stdout) as { a: string[]; o: string | null };
  return { execArgv: seen.a, nodeOptions: seen.o ?? undefined };
}

describe('signalDebuggerOff', () => {
  it('holds for the flag in the argv, in NODE_OPTIONS, or among other options there', () => {
    expect(signalDebuggerOff([SIGNAL_DEBUGGER_OFF], undefined)).toBe(true);
    expect(signalDebuggerOff([], SIGNAL_DEBUGGER_OFF)).toBe(true);
    expect(signalDebuggerOff([], `--max-old-space-size=512 ${SIGNAL_DEBUGGER_OFF}`)).toBe(true);
  });

  it('does not hold without the flag, or for an option that only starts like it', () => {
    expect(signalDebuggerOff([], undefined)).toBe(false);
    expect(signalDebuggerOff(['--max-old-space-size=512'], '--max-old-space-size=512')).toBe(false);
    expect(signalDebuggerOff([`${SIGNAL_DEBUGGER_OFF}x`], `${SIGNAL_DEBUGGER_OFF}x`)).toBe(false);
  });

  it('reads the flag the way node applies it: NODE_OPTIONS first, the argv after, the last word wins', () => {
    expect(signalDebuggerOff(['--no-disable-sigusr1'], SIGNAL_DEBUGGER_OFF)).toBe(false);
    expect(signalDebuggerOff([], `${SIGNAL_DEBUGGER_OFF} --no-disable-sigusr1`)).toBe(false);
    expect(signalDebuggerOff([SIGNAL_DEBUGGER_OFF], '--no-disable-sigusr1')).toBe(true);
    expect(signalDebuggerOff([], `"${SIGNAL_DEBUGGER_OFF}"`)).toBe(true);
  });

  it('refuses an option that opens a debugger without a signal, even with the flag', () => {
    for (const open of ['--inspect', '--inspect=0.0.0.0:9229', '--inspect-brk', '--inspect-wait=9229']) {
      expect(signalDebuggerOff([SIGNAL_DEBUGGER_OFF, open], undefined), open).toBe(false);
      expect(signalDebuggerOff([SIGNAL_DEBUGGER_OFF], open), open).toBe(false);
    }
    expect(signalDebuggerOff([SIGNAL_DEBUGGER_OFF, '--inspect-port=0'], undefined)).toBe(true);
  });

  it('reads a real start: the image NODE_OPTIONS replaced by an operator and no argv flag fails, the argv flag holds', () => {
    // The image sets NODE_OPTIONS; an operator's own replaces it, and only the argv flag is left.
    const replaced = startedWith([], '--max-old-space-size=512');
    expect(signalDebuggerOff(replaced.execArgv, replaced.nodeOptions)).toBe(false);
    expect(() => assertSignalDebuggerOff('egress-proxy', replaced.execArgv, replaced.nodeOptions)).toThrow(/egress-proxy must start with --disable-sigusr1/);
    const byEnv = startedWith([], SIGNAL_DEBUGGER_OFF);
    expect(signalDebuggerOff(byEnv.execArgv, byEnv.nodeOptions)).toBe(true);
    const byArgv = startedWith([SIGNAL_DEBUGGER_OFF], '--max-old-space-size=512');
    expect(signalDebuggerOff(byArgv.execArgv, byArgv.nodeOptions)).toBe(true);
    expect(() => assertSignalDebuggerOff('the engine', byArgv.execArgv, byArgv.nodeOptions)).not.toThrow();
  });
});

describe('startedFromImage', () => {
  it("asks for the image's code only", () => {
    expect(startedFromImage('/app/dist/index.js')).toBe(true);
    expect(startedFromImage('/app/dist/shell-sidecar/exec-daemon.js')).toBe(true);
    expect(startedFromImage(join(ROOT, 'dist', 'index.js'))).toBe(false);
    expect(startedFromImage('/application/dist/index.js')).toBe(false);
    expect(startedFromImage(undefined)).toBe(false);
  });
});

describe.skipIf(process.platform === 'win32')('the flag in a real node process', () => {
  // A process that waits, signalled the way a process of the same user would; the debugger port is
  // 0 so no fixed port is taken. Only node's own line on stderr is read, nothing is connected.
  // `ready` says the child was running when it was signalled, so a child that never started (a
  // node that does not know the flag) cannot pass as one that kept its debugger closed.
  const signalled = (argv: string[], nodeOptions?: string): Promise<{ err: string; ready: boolean }> => new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (nodeOptions === undefined) delete env['NODE_OPTIONS']; else env['NODE_OPTIONS'] = nodeOptions;
    const child = spawn(process.execPath, [...argv, '--inspect-port=0', '-e', 'process.stdout.write("ready\\n"); setInterval(() => {}, 1000)'], { env });
    let err = '';
    let ready = false;
    child.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    child.stdout.once('data', () => {
      ready = true;
      child.kill('SIGUSR1');
      setTimeout(() => { child.kill('SIGKILL'); }, 1500);
    });
    child.once('error', reject);
    child.once('exit', () => { resolve({ err, ready }); });
  });

  it('keeps the debugger closed on the signal, by argv or by NODE_OPTIONS, where the same start without it opens one', async () => {
    const without = await signalled([]);
    expect(without.ready).toBe(true);
    expect(without.err).toMatch(/Debugger listening/);
    const byArgv = await signalled([SIGNAL_DEBUGGER_OFF]);
    expect(byArgv.ready).toBe(true);
    expect(byArgv.err).not.toMatch(/Debugger listening/);
    const byEnv = await signalled([], SIGNAL_DEBUGGER_OFF);
    expect(byEnv.ready).toBe(true);
    expect(byEnv.err).not.toMatch(/Debugger listening/);
  });
});

describe('the image starts every node with the flag', () => {
  it('passes it in the argv of each node the entrypoint runs', () => {
    const lines = readFileSync(join(ROOT, 'entrypoint-webui.sh'), 'utf8').split('\n')
      .filter((l) => !/^\s*#/.test(l) && /(^|[\s$(])node\s/.test(l));
    expect(lines.length).toBe(3);
    for (const l of lines) expect(l, l).toMatch(/(^|[\s$(])node --disable-sigusr1 /);
    expect(lines.some((l) => /exec node --disable-sigusr1 \/app\/dist\/index\.js --http-api/.test(l))).toBe(true);
  });

  it('sets it as NODE_OPTIONS in the stage the image runs', () => {
    const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');
    const production = dockerfile.slice(dockerfile.lastIndexOf('\nFROM '));
    expect(production).toMatch(/AS production/);
    expect(production).toMatch(/^ENV NODE_OPTIONS=--disable-sigusr1$/m);
  });
});
