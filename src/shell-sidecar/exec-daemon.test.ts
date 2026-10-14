import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, connect, type Server } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleConnection, startupSweep, CALL_WRAPPER, callNproc, type DaemonDeps } from './exec-daemon.js';
import { spawnSync } from 'node:child_process';
import { UidPool } from './pool.js';
import { parseFrame, MAX_RESPONSE_LINE_BYTES, type ExecFrame } from './protocol.js';
import type { ReleaseOps } from './release.js';

/** The daemon's wiring with a spawner that runs as the current user; kills go to the call's process group. */
function harness(opts: { poolSize?: number; residue?: string[]; killDelayMs?: number; requestDeadlineMs?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'exec-daemon-'));
  const children = new Map<number, ChildProcess>();
  const events: string[] = [];
  const ops: ReleaseOps = {
    killPass: async () => {},
    countProcesses: async () => 0,
    sweep: async (uid) => { events.push(`sweep:${uid}`); },
    residue: async () => opts.residue ?? [],
  };
  const deps: DaemonDeps = {
    pool: new UidPool(20000, opts.poolSize ?? 2),
    ops,
    spawnCall: (uid, cmd, env) => {
      events.push(`spawn:${uid}`);
      const child = spawn('/bin/sh', ['-c', cmd], { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      children.set(uid, child);
      return child;
    },
    killCall: async (uid) => {
      events.push(`kill:${uid}`);
      const pid = children.get(uid)?.pid;
      if (pid) { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } }
      // A real kill loop goes on after the process is gone (two empty scans, more passes).
      if (opts.killDelayMs) await new Promise((r) => setTimeout(r, opts.killDelayMs));
      events.push(`kill-end:${uid}`);
    },
    newCallId: () => 'c1',
    callsDir: join(dir, 'calls'),
    log: (line) => events.push(`log:${line}`),
    exhausted: () => events.push('exhausted'),
    ...(opts.requestDeadlineMs !== undefined ? { requestDeadlineMs: opts.requestDeadlineMs } : {}),
  };
  const server: Server = createServer((s) => handleConnection(s, deps));
  const sock = join(dir, 'exec.sock');
  const ready = new Promise<void>((r) => server.listen(sock, () => r()));
  const cleanup = async (): Promise<void> => {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  };
  const connections = (): Promise<number> => new Promise((r, j) => server.getConnections((e, n) => (e ? j(e) : r(n))));
  return { deps, events, sock, ready, cleanup, connections };
}

/** Send one raw request; collect raw lines until the daemon ends the stream. `hangUpAfterMs` drops the connection early. */
function call(sock: string, raw: string, hangUpAfterMs?: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const c = connect(sock);
    let buf = '';
    c.on('data', (d) => { buf += d.toString('utf8'); });
    c.on('end', () => resolve(buf.split('\n').filter((l) => l.length > 0)));
    c.on('close', () => resolve(buf.split('\n').filter((l) => l.length > 0)));
    c.on('error', reject);
    c.write(raw);
    if (hangUpAfterMs !== undefined) setTimeout(() => c.destroy(), hangUpAfterMs);
  });
}

function frames(lines: string[]): ExecFrame[] {
  return lines.map((l) => { const f = parseFrame(l); if (!f.ok) throw new Error(`bad frame: ${f.error}: ${l.slice(0, 80)}`); return f.value; });
}

const waitFor = async (pred: () => boolean, ms = 3000): Promise<void> => {
  const end = Date.now() + ms;
  while (!pred()) { if (Date.now() > end) throw new Error('timed out waiting'); await new Promise((r) => setTimeout(r, 10)); }
};

const req = (o: Record<string, unknown>): string => JSON.stringify(o) + '\n';

let current: ReturnType<typeof harness> | null = null;
afterEach(async () => { await current?.cleanup(); current = null; });

describe('exec daemon: one call', () => {
  it('streams stdout and stderr apart, ends with the exit frame, then releases the uid', async () => {
    const h = (current = harness());
    await h.ready;
    const f = frames(await call(h.sock, req({ cmd: 'echo out; echo err >&2; exit 3' })));
    expect(f.filter((x) => x.t === 'out').map((x) => (x as { d: string }).d).join('')).toBe('out\n');
    expect(f.filter((x) => x.t === 'err').map((x) => (x as { d: string }).d).join('')).toBe('err\n');
    expect(f.at(-1)).toEqual({ t: 'exit', code: 3, signal: null, timedOut: false });
    expect(f.filter((x) => x.t === 'exit')).toHaveLength(1);
    await waitFor(() => h.deps.pool.stats().free === 2);
    expect(h.events).toContain('sweep:20000');
  });

  it('gives the call its own HOME/TMPDIR/PATH and drops engine paths', async () => {
    const h = (current = harness());
    await h.ready;
    const f = frames(await call(h.sock, req({ cmd: 'echo "$HOME|$TMPDIR|${PWD_X-unset}|${XDG_X-unset}|$KEEP"', env: { XDG_X: '/engine', KEEP: 'k' } })));
    expect((f[0] as { d: string }).d).toBe(`${h.deps.callsDir}/c1|${h.deps.callsDir}/c1|unset|unset|k\n`);
  });

  it('keeps a UTF-8 character whole across output chunks', async () => {
    const h = (current = harness());
    await h.ready;
    const f = frames(await call(h.sock, req({ cmd: "printf '\\303'; sleep 0.2; printf '\\244'" })));
    const out = f.filter((x) => x.t === 'out').map((x) => (x as { d: string }).d).join('');
    expect(out).toBe('ä');
  });

  it('chunks large output below the line cap, even when every character escapes', async () => {
    const h = (current = harness());
    await h.ready;
    // 200 KiB of \x01: each one becomes six bytes of JSON.
    const lines = await call(h.sock, req({ cmd: "head -c 204800 /dev/zero | tr '\\0' '\\1'" }));
    for (const l of lines) expect(Buffer.byteLength(l)).toBeLessThanOrEqual(MAX_RESPONSE_LINE_BYTES);
    const out = frames(lines).filter((x) => x.t === 'out').map((x) => (x as { d: string }).d).join('');
    expect(out.length).toBe(204800);
  });
});

describe('exec daemon: transport', () => {
  it('runs the command as sent when a character of it is split across two chunks', async () => {
    const h = (current = harness());
    await h.ready;
    const line = Buffer.from(req({ cmd: "printf %s 'ä'" }));
    const cut = line.indexOf(Buffer.from('ä')) + 1; // inside the two bytes of ä
    const lines = await new Promise<string[]>((resolve, reject) => {
      const c = connect(h.sock);
      let buf = '';
      c.on('data', (d) => { buf += d.toString('utf8'); });
      c.on('close', () => resolve(buf.split('\n').filter((l) => l.length > 0)));
      c.on('error', reject);
      c.write(line.subarray(0, cut));
      setTimeout(() => c.write(line.subarray(cut)), 100);
    });
    expect(frames(lines).filter((x) => x.t === 'out').map((x) => (x as { d: string }).d).join('')).toBe('ä');
  });

  it('drops a connection that never finishes its request line', async () => {
    const h = (current = harness({ requestDeadlineMs: 150 }));
    await h.ready;
    const lines = await new Promise<string[]>((resolve, reject) => {
      const c = connect(h.sock);
      let buf = '';
      c.on('data', (d) => { buf += d.toString('utf8'); });
      c.on('close', () => resolve(buf.split('\n').filter((l) => l.length > 0)));
      c.on('error', reject);
      c.write('{"cmd":"echo never ending');
    });
    expect(frames(lines)).toEqual([{ t: 'exit', code: null, signal: null, timedOut: false, error: 'request missing or too large' }]);
    expect(h.events.filter((e) => e.startsWith('spawn:'))).toEqual([]);
  });

  // Two shapes: the call's own shell still writes, or it has exited and a process it left in
  // the background writes. Node resumes a paused stdio stream once, on the direct child's exit —
  // in the second shape that has already happened, and only the daemon's own resume ends it.
  it.each([['the call itself writes', 'yes'], ['a background process writes after the call exited', 'yes & exit 0']])(
    'releases the uid when the client drops while output is held back: %s', async (_shape, cmd) => {
      const h = (current = harness());
      await h.ready;
      await new Promise<void>((resolve) => {
        const c = connect(h.sock);
        let got = 0;
        c.on('data', (d) => { got += d.length; if (got > 64 * 1024) { c.pause(); setTimeout(() => c.destroy(), 300); } });
        c.on('close', () => resolve());
        c.on('error', () => resolve());
        c.write(req({ cmd }));
      });
      await waitFor(() => h.events.includes('kill:20000'));
      await waitFor(() => h.deps.pool.stats().free === 2, 5000);
    });
});

describe('exec daemon: a client that stays but stops reading', () => {
  it('releases the uid at the timeout even though the client never drains', async () => {
    const h = (current = harness());
    await h.ready;
    const c = connect(h.sock);
    c.on('error', () => {});
    let got = 0;
    c.on('data', (d) => { got += d.length; if (got > 64 * 1024) c.pause(); });
    c.write(req({ cmd: 'yes & exit 0', timeoutMs: 500 }));
    await waitFor(() => h.events.includes('kill:20000'), 3000);
    await waitFor(() => h.deps.pool.stats().free === 2, 5000);
    c.destroy();
  });

  it('closes a refused connection even when the client never closes its side', async () => {
    const h = (current = harness());
    await h.ready;
    // The client half-closes nothing: without the daemon's own destroy, `end` would wait for a
    // FIN that never comes and the server would hold the connection.
    const c = connect({ path: h.sock, allowHalfOpen: true });
    c.on('error', () => {});
    let refusal = '';
    c.on('data', (d) => { refusal += d.toString('utf8'); });
    c.write(req({ cmd: 'ls', cwd: '/' }));
    await waitFor(() => refusal.includes('unknown field'));
    expect(await h.connections()).toBe(1);
    const end = Date.now() + 3000;
    while ((await h.connections()) > 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    expect(await h.connections()).toBe(0);
    c.destroy();
  });
});

describe('exec daemon: refusals', () => {
  it('refuses a bad request without taking a uid', async () => {
    const h = (current = harness());
    await h.ready;
    const f = frames(await call(h.sock, req({ cmd: 'ls', cwd: '/' })));
    expect(f).toEqual([{ t: 'exit', code: null, signal: null, timedOut: false, error: 'unknown field "cwd"' }]);
    expect(h.events.filter((e) => e.startsWith('spawn:'))).toEqual([]);
  });

  it('refuses an oversize request line that does end in a newline', async () => {
    const h = (current = harness());
    await h.ready;
    const f = frames(await call(h.sock, req({ cmd: 'x'.repeat(600 * 1024) })));
    expect(f).toEqual([{ t: 'exit', code: null, signal: null, timedOut: false, error: 'request too large' }]);
    expect(h.events.filter((e) => e.startsWith('spawn:'))).toEqual([]);
  });

  it('refuses an oversize request line', async () => {
    const h = (current = harness());
    await h.ready;
    const f = frames(await call(h.sock, 'x'.repeat(600 * 1024)));
    expect(f).toEqual([{ t: 'exit', code: null, signal: null, timedOut: false, error: 'request missing or too large' }]);
  });

  it('refuses when the pool is empty — it never shares a uid', async () => {
    const h = (current = harness({ poolSize: 1 }));
    await h.ready;
    const first = call(h.sock, req({ cmd: 'sleep 0.5' }));
    await waitFor(() => h.events.includes('spawn:20000'));
    const f = frames(await call(h.sock, req({ cmd: 'echo second' })));
    expect(f).toEqual([{ t: 'exit', code: null, signal: null, timedOut: false, error: 'no free uid in the pool' }]);
    await first;
  });
});

describe('exec daemon: ending a call early', () => {
  it('kills on timeout and says so', async () => {
    const h = (current = harness());
    await h.ready;
    const f = frames(await call(h.sock, req({ cmd: 'sleep 5', timeoutMs: 200 })));
    expect(f.at(-1)).toMatchObject({ t: 'exit', timedOut: true, signal: 'SIGKILL' });
    expect(h.events).toContain('kill:20000');
  });

  it('starts the release only after the timeout’s kill has ended — its passes would kill the sweep', async () => {
    const h = (current = harness({ killDelayMs: 300 }));
    await h.ready;
    await call(h.sock, req({ cmd: 'sleep 5', timeoutMs: 100 }));
    await waitFor(() => h.events.includes('sweep:20000'));
    expect(h.events.indexOf('kill-end:20000')).toBeGreaterThan(-1);
    expect(h.events.indexOf('kill-end:20000')).toBeLessThan(h.events.indexOf('sweep:20000'));
  });

  it('kills when the client goes away', async () => {
    const h = (current = harness());
    await h.ready;
    await call(h.sock, req({ cmd: 'sleep 5' }), 200);
    await waitFor(() => h.events.includes('kill:20000'));
    await waitFor(() => h.deps.pool.stats().free === 2);
  });

  it('quarantines a uid that is not proven empty', async () => {
    const h = (current = harness({ residue: ['shm 7'] }));
    await h.ready;
    await call(h.sock, req({ cmd: 'true' }));
    await waitFor(() => h.deps.pool.stats().quarantined === 1);
    expect(h.events.some((e) => e.startsWith('log:QUARANTINE uid 20000'))).toBe(true);
  });
});

describe('the call wrapper', () => {
  // The real wrapper, run as the current user: the harness spawner above skips it.
  function wrap(nproc: string, cmd: string) {
    const dir = mkdtempSync(join(tmpdir(), 'wrapper-'));
    try {
      const home = join(dir, 'call');
      const r = spawnSync('/bin/sh', ['-c', CALL_WRAPPER, 'lynox-call', dir, nproc, cmd], { env: { HOME: home, PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
      return { status: r.status, out: r.stdout.trim() };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  it('runs the command in the workspace, in a private HOME it made itself', () => {
    const r = wrap('', 'echo "$(pwd)|$(stat -c %a "$HOME")|$1"');
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/\/wrapper-[^|]+\|700\|$/);
  });

  it('takes a process limit from the env only when it is a whole number of at least 1', () => {
    expect(callNproc(undefined)).toBe('');
    expect(callNproc('')).toBe('');
    expect(callNproc('256')).toBe('256');
    expect(() => callNproc('0')).toThrow(/at least 1/);
    expect(() => callNproc('-3')).toThrow();
    expect(() => callNproc('2.5')).toThrow();
    expect(() => callNproc('0x10')).toThrow();
  });

  it('applies a process limit when one is given, and refuses one that is not a number', () => {
    expect(wrap('7', 'ulimit -p').out).toBe('7');
    expect(wrap('1;id', 'echo ran').status).toBe(125);
  });
});

describe('exec daemon: exhausted pool', () => {
  it('ends the daemon once every uid is quarantined, and not before', async () => {
    const h = (current = harness({ poolSize: 2, residue: ['shm 1'] }));
    await h.ready;
    await call(h.sock, req({ cmd: 'true' }));
    await waitFor(() => h.deps.pool.stats().quarantined === 1);
    expect(h.events).not.toContain('exhausted');
    await call(h.sock, req({ cmd: 'true' }));
    await waitFor(() => h.events.includes('exhausted'));
  });
});

describe('exec daemon: start-up sweep', () => {
  it('releases every pool uid before the first call and refuses a non-empty calls dir', async () => {
    const h = (current = harness({ poolSize: 3 }));
    const { mkdirSync } = await import('node:fs');
    mkdirSync(h.deps.callsDir);
    await startupSweep(h.deps);
    expect(h.events.filter((e) => e.startsWith('sweep:'))).toEqual(['sweep:20000', 'sweep:20001', 'sweep:20002']);
    expect(h.deps.pool.stats()).toEqual({ free: 3, busy: 0, quarantined: 0 });
    mkdirSync(join(h.deps.callsDir, 'left'));
    await expect(startupSweep(h.deps)).rejects.toThrow(/not empty/);
  });

  it('refuses to start when no uid could be released', async () => {
    const h = (current = harness({ poolSize: 2, residue: ['msg 1'] }));
    const { mkdirSync } = await import('node:fs');
    mkdirSync(h.deps.callsDir);
    await expect(startupSweep(h.deps)).rejects.toThrow(/no usable pool uid/);
  });
});
