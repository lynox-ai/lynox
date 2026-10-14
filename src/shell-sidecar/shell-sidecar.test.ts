import { describe, it, expect, afterEach } from 'vitest';
import { parseRequest, parseFrame, capTimeout, MAX_EXEC_TIMEOUT_MS, MAX_CMD_BYTES, MAX_RESPONSE_LINE_BYTES } from './protocol.js';
import { DEFAULT_BASH_TIMEOUT_MS } from '../core/constants.js';
import { UidPool } from './pool.js';
import { buildCallEnv, CALL_PATH } from './call-env.js';
import { releaseUid, killUntilEmpty, type ReleaseOps } from './release.js';
import { countProcessesOf, sysvipcOf, entriesOwnedBy } from './linux-ops.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('exec protocol: request', () => {
  it('accepts a plain request and caps its timeout', () => {
    const r = parseRequest(JSON.stringify({ cmd: 'echo hi', timeoutMs: 5000, env: { LANG: 'C' } }));
    expect(r).toEqual({ ok: true, value: { cmd: 'echo hi', timeoutMs: 5000, env: { LANG: 'C' } } });
  });

  it('caps the timeout: unset, zero and negative mean the default, above the ceiling means the ceiling', () => {
    expect(capTimeout(undefined)).toBe(DEFAULT_BASH_TIMEOUT_MS);
    expect(capTimeout(0)).toBe(DEFAULT_BASH_TIMEOUT_MS);
    expect(capTimeout(-1)).toBe(DEFAULT_BASH_TIMEOUT_MS);
    expect(capTimeout(Number.POSITIVE_INFINITY)).toBe(DEFAULT_BASH_TIMEOUT_MS);
    expect(capTimeout(MAX_EXEC_TIMEOUT_MS + 1)).toBe(MAX_EXEC_TIMEOUT_MS);
    expect(capTimeout(1234.9)).toBe(1234);
  });

  it('refuses unknown fields, a cwd among them', () => {
    const r = parseRequest(JSON.stringify({ cmd: 'ls', cwd: '/' }));
    expect(r).toEqual({ ok: false, error: 'unknown field "cwd"' });
  });

  it('refuses what it cannot run as written', () => {
    expect(parseRequest('not json').ok).toBe(false);
    expect(parseRequest('[]').ok).toBe(false);
    expect(parseRequest(JSON.stringify({ cmd: '' })).ok).toBe(false);
    expect(parseRequest(JSON.stringify({ cmd: 'a\0b' })).ok).toBe(false);
    expect(parseRequest(JSON.stringify({ cmd: 'x'.repeat(MAX_CMD_BYTES + 1) })).ok).toBe(false);
    expect(parseRequest(JSON.stringify({ cmd: 'ls', env: { 'A-B': '1' } })).ok).toBe(false);
    expect(parseRequest(JSON.stringify({ cmd: 'ls', env: { A: 1 } })).ok).toBe(false);
    expect(parseRequest(JSON.stringify({ cmd: 'ls', env: { A: 'x\0' } })).ok).toBe(false);
  });
});

describe('exec protocol: response frames', () => {
  it('passes the three frame shapes', () => {
    expect(parseFrame('{"t":"out","d":"a"}')).toEqual({ ok: true, value: { t: 'out', d: 'a' } });
    expect(parseFrame('{"t":"err","d":"b"}')).toEqual({ ok: true, value: { t: 'err', d: 'b' } });
    expect(parseFrame('{"t":"exit","code":0,"signal":null,"timedOut":false}'))
      .toEqual({ ok: true, value: { t: 'exit', code: 0, signal: null, timedOut: false } });
  });

  it('refuses anything else instead of passing it through', () => {
    expect(parseFrame('{"t":"out","d":"a","x":1}').ok).toBe(false);
    expect(parseFrame('{"t":"out","d":1}').ok).toBe(false);
    expect(parseFrame('{"t":"exit","code":"0","signal":null,"timedOut":false}').ok).toBe(false);
    expect(parseFrame('{"t":"exit","code":0,"signal":null}').ok).toBe(false);
    expect(parseFrame('{"t":"exit","code":0,"signal":null,"timedOut":false,"x":1}').ok).toBe(false);
    expect(parseFrame('{"t":"note","d":"a"}').ok).toBe(false);
    expect(parseFrame('garbage').ok).toBe(false);
    expect(parseFrame(JSON.stringify({ t: 'out', d: 'x'.repeat(MAX_RESPONSE_LINE_BYTES) })).ok).toBe(false);
  });
});

describe('uid pool', () => {
  it('hands a uid to one call at a time and refuses when empty', () => {
    const pool = new UidPool(20000, 2);
    const a = pool.acquire();
    const b = pool.acquire();
    expect([a, b]).toEqual([20000, 20001]);
    expect(pool.acquire()).toBeNull();
    pool.release(20000);
    expect(pool.acquire()).toBe(20000);
  });

  it('never hands out a quarantined uid again', () => {
    const pool = new UidPool(20000, 1);
    expect(pool.acquire()).toBe(20000);
    pool.quarantine(20000);
    expect(pool.acquire()).toBeNull();
    expect(pool.stats()).toEqual({ free: 0, busy: 0, quarantined: 1 });
  });

  it('refuses to release a uid that is not busy', () => {
    const pool = new UidPool(20000, 1);
    expect(() => pool.release(20000)).toThrow(/not busy/);
  });
});

describe('call env', () => {
  it('drops engine paths and sets the call’s own', () => {
    const env = buildCallEnv({
      LANG: 'C.UTF-8', HOME: '/home/lynox', TMPDIR: '/tmp', TMP: '/x', TEMP: '/y', PWD: '/home/lynox/.lynox/workspace',
      OLDPWD: '/', LYNOX_WORKSPACE: '/home/lynox/.lynox/workspace', XDG_CONFIG_HOME: '/z', LD_PRELOAD: '/evil.so',
      BASH_ENV: '/rc', ENV: '/rc', PATH: '/attacker',
    }, '/tmp/calls/c1');
    expect(env).toEqual({ LANG: 'C.UTF-8', HOME: '/tmp/calls/c1', TMPDIR: '/tmp/calls/c1', PATH: CALL_PATH });
  });
});

/** A fake process table: `counts` is what each successive scan returns. */
function fakeOps(counts: number[], opts: { residue?: string[]; onSweep?: () => void } = {}) {
  const log: string[] = [];
  let i = 0;
  const ops: ReleaseOps = {
    killPass: async (uid) => { log.push(`kill:${uid}`); },
    countProcesses: async () => { const n = counts[Math.min(i, counts.length - 1)] ?? 0; i++; log.push(`scan:${n}`); return n; },
    sweep: async (uid) => { log.push(`sweep:${uid}`); opts.onSweep?.(); },
    residue: async () => opts.residue ?? [],
  };
  return { ops, log };
}

describe('linux scans', () => {
  const made: string[] = [];
  const tmp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); made.push(d); return d; };
  afterEach(() => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); });

  function fakeProc(): string {
    const root = tmp('fake-proc-');
    const proc = (pid: string, status: string): void => {
      mkdirSync(join(root, pid));
      writeFileSync(join(root, pid, 'status'), status);
    };
    proc('1', 'Name:\tnode\nUid:\t0\t0\t0\t0\n');
    proc('10', 'Name:\tsh\nUid:\t20000\t20000\t20000\t20000\n');
    // effective uid 20000 but real uid 0: not the pool uid's process
    proc('11', 'Name:\tx\nUid:\t0\t20000\t20000\t20000\n');
    proc('12', 'Name:\tbroken\n');
    mkdirSync(join(root, 'self'));
    mkdirSync(join(root, 'sysvipc'));
    writeFileSync(join(root, 'sysvipc', 'shm'),
      '       key      shmid perms                  size  cpid  lpid nattch   uid   gid  cuid  cgid\n' +
      '         0         7   600                  4096    10    10      0 20000 20000 20000 20000\n' +
      '         0         8   600                  4096    10    10      0 20001 20000 20001 20000\n');
    writeFileSync(join(root, 'sysvipc', 'msg'), '       key      msqid perms      cbytes       qnum lspid lrpid   uid   gid\n');
    writeFileSync(join(root, 'sysvipc', 'sem'), '       key      semid perms      nsems   uid   gid\n');
    return root;
  }

  it('counts processes by REAL uid, and a status it cannot parse as alive', async () => {
    const root = fakeProc();
    expect(await countProcessesOf(20000, root)).toBe(2);
    expect(await countProcessesOf(0, root)).toBe(3);
    expect(await countProcessesOf(20001, root)).toBe(1);
  });

  it('finds the uid’s SysV objects by the header’s uid column', async () => {
    const root = fakeProc();
    expect(await sysvipcOf(20000, root)).toEqual(['shm 7']);
    expect(await sysvipcOf(20002, root)).toEqual([]);
  });

  it('refuses a sysvipc table without a uid column instead of reporting it clean', async () => {
    const root = fakeProc();
    writeFileSync(join(root, 'sysvipc', 'sem'), '       key      semid perms\n         0 3 600\n');
    await expect(sysvipcOf(20000, root)).rejects.toThrow(/no uid column/);
  });

  it('lists entries by owner and treats a missing dir as empty', async () => {
    const dir = tmp('calls-');
    writeFileSync(join(dir, 'mine'), '');
    const me = process.getuid?.() ?? 0;
    expect(await entriesOwnedBy(dir, me)).toEqual([join(dir, 'mine')]);
    expect(await entriesOwnedBy(dir, me + 1)).toEqual([]);
    expect(await entriesOwnedBy(join(dir, 'absent'), me)).toEqual([]);
  });
});

describe('releasing a uid', () => {
  it('needs two empty scans in a row — a process forked during the first empty scan is not missed', async () => {
    const { ops, log } = fakeOps([5, 0, 3, 0, 0, 0, 0]);
    expect(await killUntilEmpty(20000, ops)).toBe(5);
    expect(log.filter((l) => l.startsWith('kill:')).length).toBe(5);
  });

  it('kills again after the sweep, because the sweep ran as the uid', async () => {
    const counts = [0, 0];
    const { ops, log } = fakeOps(counts, { onSweep: () => { counts.push(1, 0, 0); } });
    const r = await releaseUid(20000, ops);
    expect(r).toEqual({ ok: true, passes: 2 + 3 });
    const sweepAt = log.indexOf('sweep:20000');
    expect(sweepAt).toBeGreaterThan(-1);
    expect(log.slice(sweepAt + 1).filter((l) => l.startsWith('kill:')).length).toBe(3);
  });

  it('quarantines when processes never go away', async () => {
    const { ops } = fakeOps([1]);
    expect(await releaseUid(20000, ops, 5)).toEqual({ ok: false, reason: 'uid 20000: processes left after 5 kill passes' });
  });

  it('quarantines when root still sees residue after the sweep', async () => {
    const { ops } = fakeOps([0], { residue: ['shm 7'] });
    expect(await releaseUid(20000, ops)).toEqual({ ok: false, reason: 'uid 20000: residue after the sweep: shm 7' });
  });
});
