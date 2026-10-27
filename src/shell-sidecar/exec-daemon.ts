/**
 * The exec daemon of the shell sidecar (PRD 152 v2 §4.1, W1 plan v2.1).
 *
 * Runs in the sidecar as uid 0 with only CAP_SETUID/CAP_SETGID, under the image's init
 * (without one, killed calls stay as zombies: 33 measured, 0 with tini). It accepts one
 * request per connection on a unix socket only the engine's group may open, runs it as an
 * exclusive pool uid, streams the output back and releases the uid only once it is
 * proven empty (release.ts).
 *
 * Root here cannot signal a pool uid's processes (no CAP_KILL) or remove what one owns
 * (no CAP_FOWNER/CAP_IPC_OWNER), so every kill and every removal runs AS the uid.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server, type Socket } from 'node:net';
import { mkdirSync, chmodSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { parseRequest, encodeFrame, MAX_REQUEST_BYTES, type ExecFrame, type ExecRequest } from './protocol.js';
import { UidPool, DEFAULT_POOL_FIRST_UID, DEFAULT_POOL_SIZE } from './pool.js';
import { buildCallEnv } from './call-env.js';
import { releaseUid, killUntilEmpty, type ReleaseOps } from './release.js';
import { linuxReleaseOps, CALLS_DIR } from './linux-ops.js';

export const DEFAULT_SOCKET_PATH = '/run/lynox-exec/s/exec.sock';
export const DEFAULT_WORKSPACE = '/workspace';
/** Output characters per frame. JSON escaping can grow a character to six bytes; 16Ki × 6 stays under the line cap. */
export const OUT_CHUNK_CHARS = 16 * 1024;
/** How long a connection may take to send its request line. */
export const REQUEST_DEADLINE_MS = 30_000;

/**
 * What runs as the pool uid. The command is an argument, never part of this script; the
 * call dir is created by the uid itself (root may not chown) under a 1733 root dir, and the
 * directory change happens as the uid, so nothing a previous call left is followed as root.
 */
export const CALL_WRAPPER = 'umask 077; mkdir "$HOME" || exit 125; cd "$1" || exit 125; if [ -n "$2" ]; then ulimit -p "$2" || exit 125; fi; umask 002; shift 2; exec /bin/sh -c "$1"';

export interface DaemonDeps {
  pool: UidPool;
  ops: ReleaseOps;
  /** Start the call as `uid`. Tests pass a spawner that runs as the current user. */
  spawnCall(uid: number, cmd: string, env: Record<string, string>): ChildProcess;
  /** Make every process of `uid` go away (one kill loop); used on timeout and disconnect. */
  killCall(uid: number): Promise<void>;
  newCallId(): string;
  callsDir: string;
  log(line: string): void;
  /** Every uid is quarantined: nothing can run until the sidecar restarts. `main` exits. */
  exhausted(): void;
  requestDeadlineMs?: number;
}

function send(socket: Socket, frame: ExecFrame): boolean {
  if (socket.destroyed) return false;
  return socket.write(encodeFrame(frame));
}

function refuse(socket: Socket, error: string): void {
  send(socket, { t: 'exit', code: null, signal: null, timedOut: false, error });
  socket.end();
  // `end` waits for the client's FIN; a client that never sends one keeps the descriptor.
  setTimeout(() => socket.destroy(), 1000).unref();
}

/** Read exactly one request line, bounded. */
function readRequestLine(socket: Socket, onLine: (line: string | null) => void, deadlineMs: number): void {
  // Bytes, decoded once the line is whole: a character split across two chunks would
  // otherwise turn into two replacement characters, and a different command would run.
  let buf = Buffer.alloc(0);
  let done = false;
  const finish = (line: string | null): void => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    socket.off('data', onData);
    socket.off('end', onEnd);
    onLine(line);
  };
  const onData = (chunk: Buffer): void => {
    buf = Buffer.concat([buf, chunk]);
    const nl = buf.indexOf(0x0a);
    // The line's size is the parser's to refuse (`parseRequest`); decoding never makes it shorter.
    if (nl >= 0) return finish(buf.subarray(0, nl).toString('utf8'));
    if (buf.length > MAX_REQUEST_BYTES) finish(null);
  };
  const onEnd = (): void => finish(buf.length > 0 ? buf.toString('utf8') : null);
  // A connection that never finishes its line holds no uid, but it holds a socket.
  const timer = setTimeout(() => finish(null), deadlineMs);
  socket.on('data', onData);
  socket.on('end', onEnd);
}

export function handleConnection(socket: Socket, deps: DaemonDeps): void {
  socket.on('error', () => { /* the client went away; the close path handles it */ });
  readRequestLine(socket, (line) => {
    if (line === null) return refuse(socket, 'request missing or too large');
    const parsed = parseRequest(line);
    if (!parsed.ok) return refuse(socket, parsed.error);
    const uid = deps.pool.acquire();
    if (uid === null) return refuse(socket, 'no free uid in the pool');
    runCall(socket, uid, parsed.value, deps);
  }, deps.requestDeadlineMs ?? REQUEST_DEADLINE_MS);
}

function runCall(socket: Socket, uid: number, req: ExecRequest, deps: DaemonDeps): void {
  const callDir = `${deps.callsDir}/${deps.newCallId()}`;
  const env = buildCallEnv(req.env, callDir);
  let child: ChildProcess;
  try {
    child = deps.spawnCall(uid, req.cmd, env);
  } catch (err: unknown) {
    refuse(socket, `spawn failed: ${err instanceof Error ? err.message : String(err)}`);
    void finishUid(uid, deps);
    return;
  }

  let timedOut = false;
  let ended = false;
  // A kill runs its passes AS the uid, and a pass kills every process of the uid — the release's
  // sweep included, if the two overlapped (measured: the call dir survived, the uid was
  // quarantined). So kills are chained, and the release starts only after the last one ended.
  let killing: Promise<void> = Promise.resolve();
  const stopCall = (): void => { killing = killing.then(() => deps.killCall(uid)).catch(() => {}); };
  // Once a call is over — timed out, or its client gone — its output goes nowhere, and the
  // streams are read on into nothing. Node resumes a paused stdio stream only once, on the
  // direct child's exit; if the call's shell has already exited and something it left behind
  // still writes, that resume is spent, and a stream paused for a slow (or vanished) client
  // would stay paused past the kill — no 'close', the uid busy for good.
  let discard = false;
  const drainToNowhere = (): void => {
    discard = true;
    child.stdout?.resume();
    child.stderr?.resume();
  };
  const timer = setTimeout(() => { timedOut = true; drainToNowhere(); stopCall(); }, req.timeoutMs);
  const onGone = (): void => {
    drainToNowhere();
    if (!ended) stopCall();
  };
  socket.on('close', onGone);

  const pipe = (stream: NodeJS.ReadableStream | null, t: 'out' | 'err'): void => {
    if (!stream) return;
    const dec = new StringDecoder('utf8');
    const emit = (text: string): void => {
      if (discard) return;
      for (let i = 0; i < text.length; i += OUT_CHUNK_CHARS) {
        // A pause here is undone, and never repeated, once the call is over (`drainToNowhere`).
        if (!send(socket, { t, d: text.slice(i, i + OUT_CHUNK_CHARS) }) && !stream.isPaused()) {
          stream.pause();
          socket.once('drain', () => stream.resume());
        }
      }
    };
    stream.on('data', (chunk: Buffer) => { const s = dec.write(chunk); if (s) emit(s); });
    stream.on('end', () => { const s = dec.end(); if (s) emit(s); });
  };
  pipe(child.stdout, 'out');
  pipe(child.stderr, 'err');

  let settled = false;
  const settle = (frame: ExecFrame): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    ended = true;
    socket.off('close', onGone);
    send(socket, frame);
    socket.end();
    void killing.then(() => finishUid(uid, deps));
  };
  child.on('error', (err) => settle({ t: 'exit', code: null, signal: null, timedOut, error: `spawn failed: ${err.message}` }));
  child.on('close', (code, signal) => settle({ t: 'exit', code, signal, timedOut }));
}

async function finishUid(uid: number, deps: DaemonDeps): Promise<void> {
  let reason: string;
  try {
    const r = await releaseUid(uid, deps.ops);
    if (r.ok) { deps.pool.release(uid); return; }
    reason = r.reason;
  } catch (err: unknown) {
    reason = `uid ${uid}: release threw: ${err instanceof Error ? err.message : String(err)}`;
  }
  try { deps.pool.quarantine(uid); } catch { /* not busy: nothing to take out */ }
  deps.log(`QUARANTINE ${reason}`);
  const { free, busy } = deps.pool.stats();
  if (free === 0 && busy === 0) deps.exhausted();
}

/** Before the first call: every pool uid released, and nothing at all left in the calls dir (S6). */
export async function startupSweep(deps: DaemonDeps): Promise<void> {
  const uids: number[] = [];
  for (let uid = deps.pool.acquire(); uid !== null; uid = deps.pool.acquire()) uids.push(uid);
  for (const uid of uids) await finishUid(uid, deps);
  const left = readdirSync(deps.callsDir);
  if (left.length > 0) throw new Error(`calls dir not empty after the start-up sweep: ${left.slice(0, 5).join(', ')}`);
  const { free, quarantined } = deps.pool.stats();
  if (free === 0) throw new Error(`no usable pool uid after the start-up sweep (${quarantined} quarantined)`);
}

/** `/tmp/calls`: root-owned, 1733 — a pool uid may create its own entry but not list or touch another's. */
export function prepareCallsDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o1733);
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.uid !== 0) throw new Error(`${dir} must be a root-owned directory`);
}

/**
 * Bind the socket so only the engine's group can reach it, without CAP_CHOWN: with the
 * effective gid switched to the engine's, the directory (0710) and the socket (0660) are
 * created with that group (measured, B2). The umask covers the moment between bind and chmod.
 */
function setEgid(gid: number): void {
  if (!process.setegid) throw new Error('setegid is not available on this platform');
  process.setegid(gid);
}

export function listenForEngine(server: Server, socketPath: string, engineGid: number): Promise<void> {
  const dir = dirname(socketPath);
  rmSync(dir, { recursive: true, force: true });
  const oldUmask = process.umask(0o117);
  setEgid(engineGid);
  try {
    mkdirSync(dir, { mode: 0o710 });
    chmodSync(dir, 0o710);
  } catch (err) {
    setEgid(0);
    process.umask(oldUmask);
    throw err;
  }
  return new Promise((resolve, reject) => {
    const restore = (): void => { setEgid(0); process.umask(oldUmask); };
    server.once('error', (err) => { restore(); reject(err); });
    server.listen(socketPath, () => {
      try {
        chmodSync(socketPath, 0o660);
        const st = lstatSync(socketPath);
        if (st.gid !== engineGid) throw new Error(`socket group is ${st.gid}, expected ${engineGid}`);
      } catch (err) {
        restore();
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      restore();
      resolve();
    });
  });
}

/** `raw` is passed as a literal `process.env['NAME']` read, so the contract's read sweep sees every name. */
function intFromEnv(name: string, raw: string | undefined, fallback?: number): number {
  if (raw === undefined || raw === '') {
    if (fallback === undefined) throw new Error(`${name} must be set`);
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
  return n;
}

/** The per-call process limit for the wrapper: '' = none. 0 would let no call fork at all. */
export function callNproc(raw: string | undefined): string {
  if (raw === undefined || raw === '') return '';
  if (!/^[0-9]+$/.test(raw)) throw new Error('LYNOX_EXEC_CALL_NPROC must be a whole number of at least 1, or unset');
  const n = Number(raw);
  if (n < 1) throw new Error('LYNOX_EXEC_CALL_NPROC must be at least 1, or unset');
  return String(n);
}

export async function main(): Promise<void> {
  if (process.getuid?.() !== 0) throw new Error('the exec daemon runs as uid 0 (with only CAP_SETUID/CAP_SETGID)');
  if (process.pid === 1) throw new Error('the exec daemon must not be pid 1: run it under the image init (tini)');
  const socketPath = process.env['LYNOX_EXEC_SOCKET_PATH'] || DEFAULT_SOCKET_PATH;
  const workspace = process.env['LYNOX_EXEC_WORKSPACE'] || DEFAULT_WORKSPACE;
  const engineGid = intFromEnv('LYNOX_EXEC_ENGINE_GID', process.env['LYNOX_EXEC_ENGINE_GID'], 1001);
  const poolGid = intFromEnv('LYNOX_EXEC_POOL_GID', process.env['LYNOX_EXEC_POOL_GID']);
  if (poolGid === 0 || poolGid === engineGid) throw new Error('LYNOX_EXEC_POOL_GID must be set to the lynox-ws group, never 0 or the engine group');
  const pool = new UidPool(intFromEnv('LYNOX_EXEC_POOL_FIRST_UID', process.env['LYNOX_EXEC_POOL_FIRST_UID'], DEFAULT_POOL_FIRST_UID), intFromEnv('LYNOX_EXEC_POOL_SIZE', process.env['LYNOX_EXEC_POOL_SIZE'], DEFAULT_POOL_SIZE));
  const ops = linuxReleaseOps(poolGid);
  // RLIMIT_NPROC counts per uid and user namespace, not per container: off until measured on a
  // host without and with userns-remap — on a shared namespace it would let one
  // container's calls hold another's back.
  const nproc = callNproc(process.env['LYNOX_EXEC_CALL_NPROC']);
  const deps: DaemonDeps = {
    pool,
    ops,
    // libuv drops the supplementary groups when uid/gid are set, so the call holds only poolGid.
    spawnCall: (uid, cmd, env) => spawn('/bin/sh', ['-c', CALL_WRAPPER, 'lynox-call', workspace, nproc, cmd], {
      uid, gid: poolGid, cwd: '/', env, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    }),
    killCall: async (uid) => { await killUntilEmpty(uid, ops); },
    newCallId: () => randomBytes(12).toString('hex'),
    callsDir: CALLS_DIR,
    log: (line) => process.stderr.write(`[exec-daemon] ${line}\n`),
    // A restart (the template restarts the sidecar) ends whatever kept every uid busy.
    exhausted: () => { process.stderr.write('[exec-daemon] fatal: every pool uid is quarantined\n'); process.exit(1); },
  };
  prepareCallsDir(CALLS_DIR);
  await startupSweep(deps);
  const server = createServer((socket) => handleConnection(socket, deps));
  await listenForEngine(server, socketPath, engineGid);
  deps.log(`listening on ${socketPath}, pool ${pool.first}..${pool.first + pool.size - 1}`);
}

if (process.argv[1] && /exec-daemon\.js$/.test(process.argv[1])) {
  main().catch((err: unknown) => {
    process.stderr.write(`[exec-daemon] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
