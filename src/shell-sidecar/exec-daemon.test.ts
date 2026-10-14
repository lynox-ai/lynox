import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, connect, type Server } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleConnection, startupSweep, type DaemonDeps } from './exec-daemon.js';
import { UidPool } from './pool.js';
import { parseFrame, MAX_RESPONSE_LINE_BYTES, type ExecFrame } from './protocol.js';
import type { ReleaseOps } from './release.js';

/** The daemon's wiring with a spawner that runs as the current user; kills go to the call's process group. */
function harness(opts: { poolSize?: number; residue?: string[] } = {}) {
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
    },
    newCallId: () => 'c1',
    callsDir: join(dir, 'calls'),
    log: (line) => events.push(`log:${line}`),
  };
  const server: Server = createServer((s) => handleConnection(s, deps));
  const sock = join(dir, 'exec.sock');
  const ready = new Promise<void>((r) => server.listen(sock, () => r()));
  const cleanup = async (): Promise<void> => {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  };
  return { deps, events, sock, ready, cleanup };
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

describe('exec daemon: refusals', () => {
  it('refuses a bad request without taking a uid', async () => {
    const h = (current = harness());
    await h.ready;
    const f = frames(await call(h.sock, req({ cmd: 'ls', cwd: '/' })));
    expect(f).toEqual([{ t: 'exit', code: null, signal: null, timedOut: false, error: 'unknown field "cwd"' }]);
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
