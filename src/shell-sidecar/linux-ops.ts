/**
 * The Linux side of releasing a pool uid (see release.ts for the order and why).
 *
 * Everything a pool uid owns is removed BY that uid: the daemon is root with only
 * CAP_SETUID/CAP_SETGID, so it may not remove another uid's IPC objects or its entries in
 * sticky directories. Root only scans. The commands run as the uid are fixed strings —
 * nothing in them comes from a request.
 */

import { spawn } from 'node:child_process';
import { readdir, readFile, lstat } from 'node:fs/promises';
import type { ReleaseOps } from './release.js';

export const CALLS_DIR = '/tmp/calls';
const QUEUE_DIRS = ['/dev/mqueue', '/dev/shm'];
const SYSVIPC_KINDS = ['shm', 'msg', 'sem'] as const;
const AS_UID_TIMEOUT_MS = 10_000;

/**
 * The sweep, run as the uid. `/tmp/calls` is 1733: the uid may not LIST it, so it cannot find
 * its own entries there — root lists them (it owns the directory) and passes the paths as
 * arguments (measured: a `find` as the uid deleted nothing). Paths are absolute, so none reads
 * as an option; directories are opened up with `find -P`, which does not follow a symlink, before
 * they are removed. /dev/mqueue and /dev/shm are 1777 and the uid lists them itself.
 */
const SWEEP_SCRIPT = [
  'u=$(id -u)',
  'ipcrm --all >/dev/null 2>&1',
  `for d in ${QUEUE_DIRS.join(' ')}; do [ -d "$d" ] && find "$d" -mindepth 1 -maxdepth 1 -user "$u" -exec rm -rf -- {} + 2>/dev/null; done`,
  'for p in "$@"; do find -P "$p" -type d -exec chmod u+rwx {} + 2>/dev/null; rm -rf -- "$p" 2>/dev/null; done',
  'true',
].join('\n');

function errCode(err: unknown): string | undefined {
  return err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : undefined;
}

/**
 * Run a fixed script as `uid`; resolves when it ends, or after a timeout. Root here cannot
 * signal the uid's processes (no CAP_KILL), so a script still running after the timeout is
 * left to the next kill loop — which is why every step is followed by a scan, never trusted.
 */
export function runAsUid(uid: number, gid: number, script: string, args: readonly string[] = []): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', script, 'lynox-sweep', ...args], { uid, gid, stdio: 'ignore', cwd: '/', env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' } });
    let settled = false;
    const done = (): void => { if (settled) return; settled = true; clearTimeout(timer); resolve(); };
    const timer = setTimeout(done, AS_UID_TIMEOUT_MS);
    child.on('error', done);
    child.on('close', done);
  });
}

/** Live processes whose REAL uid is `uid`. Unreadable entries other than vanished ones count as live. */
export async function countProcessesOf(uid: number, procRoot = '/proc'): Promise<number> {
  const entries = await readdir(procRoot);
  let n = 0;
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    let status: string;
    try {
      status = await readFile(`${procRoot}/${name}/status`, 'utf8');
    } catch (err: unknown) {
      const code = errCode(err);
      if (code === 'ENOENT' || code === 'ESRCH') continue;
      n++;
      continue;
    }
    const m = /^Uid:\s+(\d+)/m.exec(status);
    if (!m) { n++; continue; }
    if (Number(m[1]) === uid) n++;
  }
  return n;
}

/** SysV objects of `uid`, read from /proc/sysvipc (its header names the uid column). */
export async function sysvipcOf(uid: number, procRoot = '/proc'): Promise<string[]> {
  const found: string[] = [];
  for (const kind of SYSVIPC_KINDS) {
    const text = await readFile(`${procRoot}/sysvipc/${kind}`, 'utf8');
    const [header, ...rows] = text.split('\n').filter((l) => l.trim().length > 0);
    if (header === undefined) continue;
    const cols = header.trim().split(/\s+/);
    const uidCol = cols.indexOf('uid');
    const idCol = cols.indexOf(kind === 'shm' ? 'shmid' : kind === 'msg' ? 'msqid' : 'semid');
    if (uidCol < 0) throw new Error(`sysvipc/${kind}: no uid column`);
    for (const row of rows) {
      const f = row.trim().split(/\s+/);
      if (Number(f[uidCol]) === uid) found.push(`${kind} ${idCol >= 0 ? (f[idCol] ?? '?') : '?'}`);
    }
  }
  return found;
}

/** Top-level entries of `dir` owned by `uid`. A missing directory holds nothing. */
export async function entriesOwnedBy(dir: string, uid: number): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err: unknown) {
    if (errCode(err) === 'ENOENT') return [];
    throw err;
  }
  const out: string[] = [];
  for (const name of names) {
    try {
      const st = await lstat(`${dir}/${name}`);
      if (st.uid === uid) out.push(`${dir}/${name}`);
    } catch (err: unknown) {
      if (errCode(err) !== 'ENOENT') out.push(`${dir}/${name} (unreadable)`);
    }
  }
  return out;
}

export function linuxReleaseOps(poolGid: number): ReleaseOps {
  return {
    killPass: (uid) => runAsUid(uid, poolGid, 'kill -9 -1 2>/dev/null; true'),
    countProcesses: (uid) => countProcessesOf(uid),
    sweep: async (uid) => {
      const mine = (await entriesOwnedBy(CALLS_DIR, uid)).filter((p) => !p.endsWith(' (unreadable)'));
      await runAsUid(uid, poolGid, SWEEP_SCRIPT, mine);
    },
    residue: async (uid) => [
      ...(await sysvipcOf(uid)),
      ...(await entriesOwnedBy(CALLS_DIR, uid)),
      ...(await Promise.all(QUEUE_DIRS.map((d) => entriesOwnedBy(d, uid)))).flat(),
    ],
  };
}
