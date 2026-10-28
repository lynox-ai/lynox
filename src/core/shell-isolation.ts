/**
 * Where `bash` runs, decided once per process: in the engine's own container (`local`), or in the
 * shell sidecar (`sidecar`), which reaches the shared workspace tree through fd 3 (PRD
 * shell-sidecar-activation, D1).
 *
 * Why an object and not the env: the object exists only if its checks passed. An env value exists
 * whether they passed or not, so each reader of `LYNOX_SHELL_EXEC_SOCKET` was a chance to read a
 * broken value as "local" — and the readers disagreed: `bash` took `'   '` as a socket, the Shopify
 * gates as unset. This module is the only place outside the env registry that names the variable
 * (a test pins it); every consumer reads `ToolContext.shellIsolation`.
 *
 * Built once, held for the process. `createToolContext` hands the held object to every context, so
 * a context made without an engine (a standalone agent) cannot read "local" where the process is in
 * sidecar mode.
 */
import { closeSync, constants, fstatSync, openSync, readFileSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { getLynoxDir } from './config.js';
import { anchorFromFd, mountIdOf, mountIdOfDir, openFds, type WorkspaceAnchor } from './workspace-fd.js';
import { otherNamesFor, parseMountinfo } from './sidecar-mounts.js';


/** Where the host's `fs.protected_hardlinks` is read (check (hardlinks)). */
export const PROTECTED_HARDLINKS_PATH = '/proc/sys/fs/protected_hardlinks';

/** The fd the entrypoint's root stage hands over: the workspace tree, opened under a `0700` parent. */
export const SIDECAR_ROOT_FD = 3;

/**
 * The workspace root as user, model and shell see it (D0). A label, built from this constant and
 * never from the root object: it is meant for showing and for the sidecar's cwd, never for opening.
 * The engine reaches the tree only through {@link SidecarRoot.anchor}.
 */
export const WORKSPACE_LABEL = '/workspace';

/** The uid and gid the engine runs as in sidecar mode, and the owner of the tree's root (D2 (h), (b)). */
export const ENGINE_ID = 1001;
/** The group the engine shares the tree with the pool through (D2 (h), layout A1). */
export const SHARED_GROUP = 1002;
/** The mode of the tree's root: the pool cannot write it (D0, D2 (b)). */
export const ROOT_MODE = 0o755;

/** A context's workspace as user, model and shell see it: `/workspace/<ctx.id>` (D0). */
export function contextLabel(contextId: string): string {
  return `${WORKSPACE_LABEL}/${contextId}`;
}

/** The workspace tree in sidecar mode: the handle the engine opens through, and the label it shows. */
export interface SidecarRoot {
  readonly mode: 'sidecar';
  readonly anchor: WorkspaceAnchor;
  readonly label: typeof WORKSPACE_LABEL;
}

export type ShellIsolation =
  | { readonly kind: 'local' }
  | { readonly kind: 'sidecar'; readonly socket: string; readonly root: SidecarRoot };

/** A start check that failed. The message names the check; the engine does not start. */
export class ShellIsolationError extends Error {
  constructor(readonly check: string, message: string) {
    super(`Shell sidecar start check (${check}) failed: ${message}`);
    this.name = 'ShellIsolationError';
  }
}

/** What `fstat` reports on fd 3, as checks (b) and the witness line read it. */
export interface FdStat {
  readonly uid: number;
  readonly mode: number;
  readonly dev: bigint;
  readonly ino: bigint;
}

/**
 * What creating a probe child under a path gave: `created` (and removed again), or the error code
 * of the refused create.
 */
export type ProbeOutcome = 'created' | string;

/** What building the object reads; a test hands its own. */
export interface ShellIsolationInputs {
  /** `LYNOX_SHELL_EXEC_SOCKET` as the process has it, read once. */
  readonly socket: string | undefined;
  /** Whether `fd` is an open directory; false for a closed fd or any other kind. */
  readonly isDirFd: (fd: number) => boolean;
  /** Wrap the inherited fd as the workspace anchor. */
  readonly anchorFromFd: (fd: number, label: string) => WorkspaceAnchor;
  /** (h) `/proc/self/status`: ids, groups, capability sets and NoNewPrivs. */
  readonly procStatus: () => string;
  /** (b) `fstat` of an fd. */
  readonly fstatFd: (fd: number) => FdStat;
  /** (c), (g) The mount id of an open fd; null where it cannot be read. Throws ENOENT for an fd that closed meanwhile. */
  readonly mountIdOfFd: (fd: number) => number | null;
  /** (c) The mount id of the directory at a path; null where it cannot be read. */
  readonly mountIdOfDir: (path: string) => number | null;
  /** (d) `/proc/self/mountinfo`. */
  readonly mountinfo: () => string;
  /** (e) A variable of the process env. */
  readonly env: (name: string) => string | undefined;
  /** (g) The fds the process holds open. */
  readonly openFds: () => number[];
  /** (i) Try to create a fresh child under `dir`. */
  readonly probeChild: (dir: string) => ProbeOutcome;
  /** (hardlinks) `/proc/sys/fs/protected_hardlinks`, the host's setting (not namespaced). */
  readonly protectedHardlinks: () => string;
  /** (c), (i) The data directory (`getLynoxDir()`). */
  readonly dataDir: string;
  /** Where the witness line goes. */
  readonly log: (line: string) => void;
}

function isDirFd(fd: number): boolean {
  try {
    return fstatSync(fd).isDirectory();
  } catch {
    return false;
  }
}

function fstatFd(fd: number): FdStat {
  const st = fstatSync(fd, { bigint: true });
  return { uid: Number(st.uid), mode: Number(st.mode & 0o7777n), dev: st.dev, ino: st.ino };
}

function errCode(err: unknown): string {
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : 'unknown error';
}

/** How the probe child is opened: created fresh, never through a link, never read. */
export const PROBE_FLAGS = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW;

/**
 * Create `<dir>/.lynox-probe-<random>` exclusively, never `dir` itself: on an existing `dir` a
 * `mkdir` gives EEXIST, and on an absent one it would create it (PRD D2 (i), R1). A created probe is
 * removed before the outcome is returned, even when closing it fails.
 */
function probeChild(dir: string): ProbeOutcome {
  const path = join(dir, `.lynox-probe-${randomBytes(8).toString('hex')}`);
  let fd: number;
  try {
    fd = openSync(path, PROBE_FLAGS, 0o600);
  } catch (err) {
    return errCode(err);
  }
  try {
    closeSync(fd);
  } finally {
    unlinkSync(path);
  }
  return 'created';
}

/**
 * The process's own inputs. The one read of the socket env in the engine (a test pins it).
 * Exported for the test that pins each input to the process, not for callers.
 */
export function processInputs(): ShellIsolationInputs {
  return {
    socket: process.env['LYNOX_SHELL_EXEC_SOCKET'],
    isDirFd,
    anchorFromFd,
    procStatus: () => readFileSync('/proc/self/status', 'utf8'),
    fstatFd,
    mountIdOfFd: mountIdOf,
    mountIdOfDir,
    mountinfo: () => readFileSync('/proc/self/mountinfo', 'utf8'),
    env: (name) => process.env[name],
    openFds,
    probeChild,
    protectedHardlinks: () => readFileSync(PROTECTED_HARDLINKS_PATH, 'utf8'),
    dataDir: getLynoxDir(),
    log: (line) => { process.stderr.write(`${line}\n`); },
  };
}

/**
 * Check (i) for one path: nothing can be created under it by name. Expected is ENOENT (absent) or
 * EROFS (on the read-only root); anything else stops the start, a created probe included. Exported
 * for the context label, which only `resolveContext` knows.
 */
export function checkNothingByName(dir: string, probe: (dir: string) => ProbeOutcome = probeChild): void {
  const outcome = read('i', `the probe under ${dir}`, () => probe(dir));
  if (outcome === 'ENOENT' || outcome === 'EROFS') return;
  throw new ShellIsolationError('i', outcome === 'created'
    ? `a file could be created under ${dir} by name; in sidecar mode nothing may be written there.`
    : `creating a file under ${dir} by name gave ${outcome}, not ENOENT or EROFS.`);
}

/** Read a probe; a read that throws is the check's failure, never a pass. */
function read<T>(check: string, what: string, f: () => T): T {
  try {
    return f();
  } catch (err) {
    throw new ShellIsolationError(check, `${what} cannot be read (${err instanceof Error ? err.message : String(err)}).`);
  }
}

/** The fields of a `/proc/self/status` line, or undefined when the line is missing. */
function statusFields(status: string, key: string): string[] | undefined {
  const line = new RegExp(`^${key}:(.*)$`, 'm').exec(status)?.[1];
  return line === undefined ? undefined : line.trim().split(/\s+/).filter((f) => f !== '');
}

/**
 * (h) The engine runs as 1001:1001 in every id field, holds exactly group 1002, has no capability in
 * any set and cannot gain one. Read from `/proc/self/status`, not from `getuid()`/`geteuid()`: a
 * stage that left the saved uid at 0, or kept the permitted set, passes those, and the process
 * could then take root back with `seteuid(0)` or `capset` (sec-core refuter on da2da2c8, F1).
 */
function checkIdentity(inputs: ShellIsolationInputs): void {
  const status = read('h', '/proc/self/status', inputs.procStatus);
  const want = String(ENGINE_ID);
  for (const key of ['Uid', 'Gid']) {
    const ids = statusFields(status, key);
    // real, effective, saved, filesystem
    if (ids === undefined || ids.length !== 4 || ids.some((id) => id !== want)) {
      const runs = key === 'Uid' ? 'uid' : 'gid';
      throw new ShellIsolationError('h', `the engine runs as ${runs} ${ids?.join('/') ?? 'missing'} (real/effective/saved/fs); it must be ${ENGINE_ID} in all four.`);
    }
  }
  const groups = statusFields(status, 'Groups');
  if (groups === undefined || groups.length !== 1 || groups[0] !== String(SHARED_GROUP)) {
    throw new ShellIsolationError('h', `the engine holds the supplementary groups ${JSON.stringify(groups?.join(' ') ?? 'missing')}; it must hold exactly ${SHARED_GROUP}.`);
  }
  for (const set of ['CapInh', 'CapPrm', 'CapEff', 'CapAmb']) {
    const value = statusFields(status, set);
    const hex = value?.length === 1 ? value[0] : undefined;
    if (hex === undefined || !/^[0-9a-fA-F]+$/.test(hex) || BigInt(`0x${hex}`) !== 0n) {
      throw new ShellIsolationError('h', `the engine holds capabilities (${set} ${hex ?? 'missing'}); it must hold none.`);
    }
  }
  const nnp = statusFields(status, 'NoNewPrivs');
  if (nnp?.length !== 1 || nnp[0] !== '1') {
    throw new ShellIsolationError('h', `NoNewPrivs is ${nnp?.join(' ') ?? 'missing'}; it must be 1.`);
  }
}

/**
 * Read the env once and build the mode, running the checks that decide whether the object may
 * exist. Throws {@link ShellIsolationError} naming the check.
 *
 * - Socket unset and no directory on fd 3: `local` (self-host, unchanged), no check runs.
 * - Socket set but empty or blank: a broken config, never "run here" — exits.
 * - fd 3 a directory but the socket unset: exits. That is a misconfigured template, not self-host.
 * - Socket set: the D2 checks in the PRD's order, (h) (a) (b) (c) (d) (e) (g), then (hardlinks),
 *   then (i). Check (i) for the context label runs in `resolveContext`, which knows the context.
 *
 * On success it logs the anchor's identity once (the witness line), for the probe that compares
 * it with the sidecar's view of the tree.
 */
export function buildShellIsolation(inputs: ShellIsolationInputs = processInputs()): ShellIsolation {
  const socket = inputs.socket;
  const anchored = inputs.isDirFd(SIDECAR_ROOT_FD);
  if (socket === undefined) {
    if (anchored) {
      throw new ShellIsolationError('a', `fd ${SIDECAR_ROOT_FD} is a directory but LYNOX_SHELL_EXEC_SOCKET is not set: the template hands over the workspace without the sidecar.`);
    }
    return { kind: 'local' };
  }
  if (socket.trim() === '') {
    throw new ShellIsolationError('socket', `LYNOX_SHELL_EXEC_SOCKET is set but empty.`);
  }

  // (h) Before everything: a stage that kept uid 0 would pass every check below, because fd 3
  // still reads 1001/0755.
  checkIdentity(inputs);

  // (a) The anchor is there.
  if (!anchored) {
    throw new ShellIsolationError('a', `LYNOX_SHELL_EXEC_SOCKET is set but fd ${SIDECAR_ROOT_FD} is not an open directory: the sidecar's workspace anchor is missing.`);
  }

  // (b) Owned by the engine, not writable by the pool. No chown: a wrong owner is the operator's.
  const st = read('b', `fd ${SIDECAR_ROOT_FD}`, () => inputs.fstatFd(SIDECAR_ROOT_FD));
  if (st.uid !== ENGINE_ID || st.mode !== ROOT_MODE) {
    throw new ShellIsolationError('b', `the workspace root on fd ${SIDECAR_ROOT_FD} has owner ${st.uid} and mode ${st.mode.toString(8).padStart(4, '0')}; it must be ${ENGINE_ID} and 0755.`);
  }

  // (c) Its own mount, not a directory inside the data mount.
  const rootMount = read('c', `the mount id of fd ${SIDECAR_ROOT_FD}`, () => inputs.mountIdOfFd(SIDECAR_ROOT_FD));
  const dataMount = read('c', `the mount id of ${inputs.dataDir}`, () => inputs.mountIdOfDir(inputs.dataDir));
  if (rootMount === null || dataMount === null) {
    throw new ShellIsolationError('c', `the mount id of ${rootMount === null ? `fd ${SIDECAR_ROOT_FD}` : inputs.dataDir} cannot be read.`);
  }
  if (rootMount === dataMount) {
    throw new ShellIsolationError('c', `the workspace root on fd ${SIDECAR_ROOT_FD} is on the data directory's mount; it must be a mount of its own.`);
  }

  // (d) No other mount shows the same tree, wholly or in part.
  const others = read('d', '/proc/self/mountinfo', () => otherNamesFor(parseMountinfo(inputs.mountinfo()), rootMount));
  if (others.length > 0) {
    throw new ShellIsolationError('d', `mount ${others.map((m) => m.id).join(', ')} shows the workspace tree under another name.`);
  }

  // (e) No root by name.
  for (const name of ['LYNOX_WORKSPACE_ROOT', 'LYNOX_WORKSPACE']) {
    if (inputs.env(name) !== undefined) {
      throw new ShellIsolationError('e', `${name} is set; in sidecar mode the workspace has no name the engine opens.`);
    }
  }

  // (g) No other fd into the tree. By mount id: dev/ino would miss an fd on a file or a
  // subdirectory. Every fd but the anchor, 0–2 included.
  const fds = read('g', 'the list of open fds', inputs.openFds);
  for (const fd of fds) {
    if (fd === SIDECAR_ROOT_FD) continue;
    let mount: number | null;
    try {
      mount = inputs.mountIdOfFd(fd);
    } catch (err) {
      // The listing's own fd, closed once the listing was read, is gone; nothing else may be.
      if (errCode(err) === 'ENOENT') continue;
      throw new ShellIsolationError('g', `the mount id of fd ${fd} cannot be read (${errCode(err)}).`);
    }
    if (mount === null) throw new ShellIsolationError('g', `the mount id of fd ${fd} cannot be read.`);
    if (mount === rootMount) {
      throw new ShellIsolationError('g', `fd ${fd} is open on the workspace tree besides fd ${SIDECAR_ROOT_FD}.`);
    }
  }

  // (hardlinks) The host refuses a hard link to a file the linking uid could not read and write
  // itself. The file tools' "more than one name" check is check-then-use: a link unlinked between
  // the open and the fstat passes it. This setting is the guarantee, the nlink check a heuristic.
  // A link cannot leave its mount, so what it protects is a file of the engine's on the workspace
  // volume (another context's, mode 0600) that a pool uid could otherwise link where it can reach.
  // One setting per kernel, so the engine's read is the one the sidecar's link() is subject to.
  const hardlinks = read('hardlinks', PROTECTED_HARDLINKS_PATH, inputs.protectedHardlinks).trim();
  if (hardlinks !== '1') {
    throw new ShellIsolationError('hardlinks', `fs.protected_hardlinks is ${JSON.stringify(hardlinks)} on this host; it must be 1, or the sidecar could hard-link a file of the engine's on the workspace volume to where the engine reads or writes it for the shell. Set it on the host (sysctl -w fs.protected_hardlinks=1, kept in /etc/sysctl.d); it cannot be set from inside the container.`);
  }

  // (i) Nothing to write by name: the root label and <data>/workspace. The context label follows
  // in resolveContext.
  checkNothingByName(WORKSPACE_LABEL, inputs.probeChild);
  checkNothingByName(join(inputs.dataDir, 'workspace'), inputs.probeChild);

  const anchor = inputs.anchorFromFd(SIDECAR_ROOT_FD, WORKSPACE_LABEL);
  inputs.log(`[lynox] sidecar anchor: fd=${SIDECAR_ROOT_FD} dev=${st.dev} ino=${st.ino} uid=${st.uid} mode=${st.mode.toString(8).padStart(4, '0')}`);
  return { kind: 'sidecar', socket, root: { mode: 'sidecar', anchor, label: WORKSPACE_LABEL } };
}

let held: ShellIsolation | null = null;

/**
 * The process's mode, built on first use and held. The engine calls it while it is constructed, so
 * a failed check stops the start there.
 */
export function shellIsolation(): ShellIsolation {
  held ??= buildShellIsolation();
  return held;
}

/** Tests only: forget the held object, so the next {@link shellIsolation} builds it again. */
export function resetShellIsolationForTest(): void {
  held = null;
}

/** Tests only: hold `isolation` as the process's mode, as a boot in sidecar mode would. */
export function setShellIsolationForTest(isolation: ShellIsolation): void {
  held = isolation;
}
