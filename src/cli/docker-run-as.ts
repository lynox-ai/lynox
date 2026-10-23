/**
 * Which user the installer's containers run as, so they can read and write
 * what the installer wrote for them.
 *
 * The installer creates `~/.lynox` (mode 0700) and `searxng/settings.yml`
 * (mode 0600) as the user who runs it. The image runs as uid 1001, and SearXNG
 * as root without capabilities (`cap_drop: ALL` removes `CAP_DAC_OVERRIDE`).
 * On native Linux neither of them is the owner, so both containers restart in
 * a loop. The fix keeps the files as they are and runs each container as the
 * id that IS their owner on the host:
 *
 * - rootful Docker: the user's own uid and gid;
 * - rootless Docker: 0, because root inside a rootless container is the host
 *   user who runs the daemon.
 *
 * The hardening (`cap_drop: ALL`, `no-new-privileges`, `read_only`) stays as
 * it is. What changes on rootful Docker: the process runs as the real host user
 * rather than as a uid that usually belongs to nobody on the host.
 *
 * Three rules hold whatever the inputs:
 * - on rootful Docker no container runs as uid 0, ever;
 * - a mode that cannot be read counts as rootful, so a wrong guess never ends
 *   in uid 0;
 * - existing data keeps its owner: an install whose data already belongs to
 *   uid 1001 keeps running as 1001.
 */
import { chownSync, lchownSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** The uid and gid the image's runtime user `lynox` has (`Dockerfile`, `useradd -u 1001`). */
export const IMAGE_IDS: Ids = { uid: 1001, gid: 1001 };

export type DockerMode = 'rootful' | 'rootless';

export interface Ids {
  readonly uid: number;
  readonly gid: number;
}

/**
 * Reads `docker info --format '{{json .SecurityOptions}}'`. Rootless only when
 * an option names it; everything else, an unreadable answer included, is
 * rootful.
 */
export function dockerModeFromSecurityOptions(raw: string): DockerMode {
  try {
    const options: unknown = JSON.parse(raw);
    if (Array.isArray(options)
      && options.some((o) => typeof o === 'string' && o.split(',').includes('name=rootless'))) {
      return 'rootless';
    }
  } catch {
    // Not JSON: rootful, see above.
  }
  return 'rootful';
}

/**
 * The owner of the databases already in the data dir: `null` when there are
 * none, `'mixed'` when they belong to more than one id. Symlinks are not
 * followed and do not count.
 */
export function dataOwnerOf(dataDir: string): Ids | 'mixed' | null {
  let names: string[];
  try {
    names = readdirSync(dataDir);
  } catch {
    return null;
  }
  const owners = new Map<string, Ids>();
  for (const name of names) {
    if (!name.endsWith('.db')) continue;
    const st = lstatSync(join(dataDir, name));
    if (!st.isFile()) continue;
    owners.set(`${String(st.uid)}:${String(st.gid)}`, { uid: st.uid, gid: st.gid });
  }
  if (owners.size === 0) return null;
  if (owners.size > 1) return 'mixed';
  return [...owners.values()][0]!;
}

export type RunAsPlan =
  | {
    readonly kind: 'run';
    /** The engine container's `user:`. */
    readonly engine: Ids;
    /** The SearXNG container's `user:`; it reads a file the installer wrote. */
    readonly search: Ids;
    /** Running as root on rootful Docker: hand the data dir and the SearXNG file to uid 1001 first. */
    readonly chownToImage: boolean;
  }
  | {
    readonly kind: 'refuse';
    /** What is wrong, in one sentence. */
    readonly reason: string;
    /** The one command that fixes it. */
    readonly command: string;
  };

/**
 * Decides the ids. `host` is the user who runs the installer, `dataOwner` what
 * {@link dataOwnerOf} found.
 */
export function planRunAs(opts: {
  readonly mode: DockerMode;
  readonly host: Ids;
  readonly dataOwner: Ids | 'mixed' | null;
  readonly dataDir: string;
}): RunAsPlan {
  const { mode, host, dataOwner, dataDir } = opts;

  // Installing as root: never run a container as 0. Hand the files to the
  // image's own user, which root may do, and run as that user, as before.
  if (host.uid === 0) {
    return { kind: 'run', engine: IMAGE_IDS, search: IMAGE_IDS, chownToImage: true };
  }

  // The id under which a container acts as this host user.
  const self: Ids = mode === 'rootless' ? { uid: 0, gid: 0 } : host;

  if (dataOwner === 'mixed') {
    return {
      kind: 'refuse',
      reason: `The databases in ${dataDir} belong to more than one user.`,
      command: chownCommand(mode, host, dataDir),
    };
  }
  if (dataOwner === null) {
    return { kind: 'run', engine: self, search: self, chownToImage: false };
  }
  if (dataOwner.uid === host.uid) {
    return { kind: 'run', engine: self, search: self, chownToImage: false };
  }
  if (dataOwner.uid === 0) {
    return {
      kind: 'refuse',
      reason: `The databases in ${dataDir} belong to root, and lynox does not run as root.`,
      command: chownCommand(mode, host, dataDir),
    };
  }
  // Data written by another id: on rootful Docker that is the id to keep
  // (typically 1001, an install from before this change); on rootless Docker
  // the host sees the image's user as a subordinate id, so it is the image's.
  return {
    kind: 'run',
    engine: mode === 'rootless' ? IMAGE_IDS : dataOwner,
    search: self,
    chownToImage: false,
  };
}

function chownCommand(mode: DockerMode, host: Ids, dataDir: string): string {
  const quoted = shellQuote(dataDir);
  return mode === 'rootless'
    ? `docker run --rm -v ${quoted}:/d alpine chown -R 0:0 /d`
    : `sudo chown -R ${String(host.uid)}:${String(host.gid)} ${quoted}`;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Checks, before `docker compose up`, that the engine will be able to write
 * the data dir. Returns `null` when it will, or the refusal to print. Only the
 * cases the host can see are checked: a rootless engine running as the image's
 * user maps to a subordinate id the installer does not compute.
 */
export function precheckDataDir(opts: {
  readonly mode: DockerMode;
  readonly host: Ids;
  readonly engine: Ids;
  readonly dataDir: string;
}): { reason: string; command: string } | null {
  const { mode, host, engine, dataDir } = opts;
  let st;
  try {
    st = lstatSync(dataDir);
  } catch {
    return { reason: `${dataDir} does not exist.`, command: `mkdir -p ${shellQuote(dataDir)}` };
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    return { reason: `${dataDir} is not a directory.`, command: `ls -la ${shellQuote(dataDir)}` };
  }
  const hostUid = mode === 'rootless'
    ? (engine.uid === 0 ? host.uid : null)
    : engine.uid;
  if (hostUid === null) return null;
  if (st.uid !== hostUid || (st.mode & 0o200) === 0) {
    return {
      reason: `${dataDir} belongs to uid ${String(st.uid)}, and the container writes as uid ${String(hostUid)}.`,
      command: hostUid === host.uid
        ? chownCommand(mode, host, dataDir)
        : `sudo chown -R ${String(hostUid)}:${String(engine.gid)} ${shellQuote(dataDir)}`,
    };
  }
  return null;
}

/**
 * Hands the data dir to the image's user. Root only, and only the one
 * directory: the path must be exactly `<home>/.lynox`, must be a real
 * directory and not a symlink, and must not resolve elsewhere. The walk never
 * follows a symlink; a link is re-owned itself (`lchown`) and not entered.
 */
export function chownDataDirToImage(dataDir: string, home: string): void {
  const expected = join(home, '.lynox');
  if (resolve(dataDir) !== resolve(expected)) {
    throw new Error(`refusing to chown ${dataDir}: only ${expected} is handed to the image's user`);
  }
  const st = lstatSync(dataDir);
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new Error(`refusing to chown ${dataDir}: not a real directory`);
  }
  if (realpathSync(dataDir) !== join(realpathSync(home), '.lynox')) {
    throw new Error(`refusing to chown ${dataDir}: it resolves to ${realpathSync(dataDir)}`);
  }
  chownTree(dataDir);
}

function chownTree(dir: string): void {
  chownSync(dir, IMAGE_IDS.uid, IMAGE_IDS.gid);
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const st = lstatSync(path);
    if (st.isSymbolicLink()) {
      lchownSync(path, IMAGE_IDS.uid, IMAGE_IDS.gid);
    } else if (st.isDirectory()) {
      chownTree(path);
    } else {
      chownSync(path, IMAGE_IDS.uid, IMAGE_IDS.gid);
    }
  }
}

/** Hands one file the installer wrote (SearXNG's settings) to the image's user. Never through a symlink. */
export function chownFileToImage(path: string): void {
  const st = lstatSync(path);
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new Error(`refusing to chown ${path}: not a regular file`);
  }
  chownSync(path, IMAGE_IDS.uid, IMAGE_IDS.gid);
}
