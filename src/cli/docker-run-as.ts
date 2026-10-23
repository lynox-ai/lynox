/**
 * Which user the installer's containers run as, so they can read and write
 * what the installer wrote for them.
 *
 * The installer creates `~/.lynox` (mode 0700) and `searxng/settings.yml`
 * (mode 0600) as the user who runs it. The image runs as uid 1001, and SearXNG
 * as root without capabilities (`cap_drop: ALL` removes `CAP_DAC_OVERRIDE`).
 * On native Linux neither of them is the owner, so both containers restart in
 * a loop. What the fix does depends on the Docker mode:
 *
 * - rootful Docker: each container runs as the id that owns its files, the
 *   user's own uid and gid. The files stay as they are and stay readable for
 *   the user. The process runs as the real host user rather than as a uid
 *   that usually belongs to nobody on the host.
 * - rootless Docker: the engine runs as the image's user, 1001, as before, and
 *   the data dir is handed to it with a pinned helper container (root inside a
 *   rootless container may re-own the user's files to its own ids). The data
 *   then belongs to a subordinate id on the host; the user reads it through a
 *   container. Not as 0: root inside the container owns the image's
 *   execute-only programs, which would make its processes dumpable again, and
 *   a shell command the model runs could read the engine's environment.
 *   SearXNG keeps the image default there, which is the host user.
 *
 * The hardening (`cap_drop: ALL`, `no-new-privileges`, `read_only`) stays as
 * it is. Four rules hold whatever the inputs:
 * - no container is planned as uid 0, in either mode;
 * - a mode that cannot be read counts as rootful;
 * - existing data keeps its owner: an install whose data already belongs to
 *   uid 1001 keeps running as 1001;
 * - installing as root runs as 1001 and hands the files over directly.
 */
import { lchownSync, lstatSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** The uid and gid the image's runtime user `lynox` has (`Dockerfile`, `useradd -u 1001`). */
export const IMAGE_IDS: Ids = { uid: 1001, gid: 1001 };

/** The image that re-owns the data dir on rootless Docker. Pinned by digest: it runs as root over the user's data. */
export const HELPER_IMAGE = 'alpine@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc';

/**
 * `docker` arguments that hand the data dir to the image's user on rootless
 * Docker: no network, every capability dropped but `CHOWN`, one mount.
 */
export function helperChownArgs(dataDir: string): string[] {
  if (dataDir.includes(':') || dataDir.includes(',')) {
    throw new Error(`refusing to mount ${dataDir}: a ':' or ',' in the path would split the mount option`);
  }
  return [
    'run', '--rm', '--network', 'none', '--cap-drop', 'ALL', '--cap-add', 'CHOWN',
    '-v', `${dataDir}:/d`, HELPER_IMAGE, 'chown', '-R', `${String(IMAGE_IDS.uid)}:${String(IMAGE_IDS.gid)}`, '/d',
  ];
}

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

/** The SQLite files the engine keeps in the data dir: the databases and their journals. */
const DATA_FILE = /\.db(-wal|-shm)?$/;

/**
 * Who the data in the data dir belongs to:
 * - the owner of its databases (and their WAL/SHM journals), `'mixed'` when
 *   they belong to more than one uid;
 * - when there are none, or the directory cannot be listed (an install that
 *   ran as 1001 leaves it 0700 and 1001-owned), the owner of the directory;
 * - `null` when the directory does not exist.
 * Symlinks are not followed and do not count.
 */
export function dataOwnerOf(dataDir: string): Ids | 'mixed' | null {
  let dir;
  try {
    dir = lstatSync(dataDir);
  } catch {
    return null;
  }
  if (dir.isSymbolicLink() || !dir.isDirectory()) return null;
  const owners = new Map<number, Ids>();
  let names: string[] = [];
  try {
    names = readdirSync(dataDir);
  } catch {
    // Not listable by this user: the directory's owner is all there is to go by.
  }
  for (const name of names) {
    if (!DATA_FILE.test(name)) continue;
    let st;
    try {
      st = lstatSync(join(dataDir, name));
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    if (!owners.has(st.uid)) owners.set(st.uid, { uid: st.uid, gid: st.gid });
  }
  if (owners.size > 1) return 'mixed';
  if (owners.size === 1) return [...owners.values()][0]!;
  return { uid: dir.uid, gid: dir.gid };
}

export type RunAsPlan =
  | {
    readonly kind: 'run';
    /** The engine container's `user:`. */
    readonly engine: Ids;
    /** The SearXNG container's `user:`, or `null` for the image's default. */
    readonly search: Ids | null;
    /**
     * Who hands the files to the image's user first: `direct` when installing
     * as root (data dir and SearXNG's settings), `helper` on rootless Docker
     * (the data dir, through {@link helperChownArgs}), `none` otherwise.
     */
    readonly chown: 'none' | 'direct' | 'helper';
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

  // Installing as root: never run a container as 0. Run as the image's own
  // user, as before, and hand it a fresh data dir; data it already owns stays.
  if (host.uid === 0) {
    if (dataOwner !== null && dataOwner !== 'mixed' && dataOwner.uid === IMAGE_IDS.uid) {
      return { kind: 'run', engine: IMAGE_IDS, search: IMAGE_IDS, chown: 'none' };
    }
    if (dataOwner === null || (dataOwner !== 'mixed' && dataOwner.uid === 0)) {
      return { kind: 'run', engine: IMAGE_IDS, search: IMAGE_IDS, chown: 'direct' };
    }
    return {
      kind: 'refuse',
      reason: `The data in ${dataDir} belongs to another user, and lynox runs as uid ${String(IMAGE_IDS.uid)} here.`,
      command: `chown -R -P ${String(IMAGE_IDS.uid)}:${String(IMAGE_IDS.gid)} ${shellQuote(dataDir)}`,
    };
  }

  if (dataOwner !== null && dataOwner !== 'mixed' && dataOwner.uid === 0) {
    return {
      kind: 'refuse',
      reason: `The databases in ${dataDir} belong to root, and lynox does not run as root.`,
      command: chownCommand(host, dataDir),
    };
  }

  if (mode === 'rootless') {
    // The image's user, and the data handed to it on every run. Which ids the
    // helper can re-own is not read from the owners here: it re-owns what it
    // maps, and a file it does not map makes it fail, which the installer
    // turns into a refusal (helperFailure). So a run that stopped half-way
    // never passes as done.
    return { kind: 'run', engine: IMAGE_IDS, search: null, chown: 'helper' };
  }

  if (dataOwner === 'mixed') {
    return {
      kind: 'refuse',
      reason: `The databases in ${dataDir} belong to more than one user.`,
      command: chownCommand(host, dataDir),
    };
  }
  // Rootful: the user's own ids, unless the data belongs to someone else
  // (typically 1001, an install from before this change), whose id is kept.
  // Never group 0 either: a process in group root reads what that group may.
  const self = withoutRootGroup(host);
  const engine = dataOwner === null || dataOwner.uid === host.uid ? self : withoutRootGroup(dataOwner);
  return { kind: 'run', engine, search: self, chown: 'none' };
}

function withoutRootGroup(ids: Ids): Ids {
  return ids.gid === 0 ? { uid: ids.uid, gid: ids.uid } : ids;
}

// Hands the data dir to the host user, from where the installer takes over.
// Files a rootless container wrote show as subordinate ids on the host, and
// root-owned files are not the user's to change: both need the host's root.
export function chownCommand(host: Ids, dataDir: string): string {
  return `sudo chown -R ${String(host.uid)}:${String(host.gid)} ${shellQuote(dataDir)}`;
}

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Checks, before anything is written, that the engine will be able to write
 * the data dir. Returns `null` when it will, or the refusal to print. On
 * rootless Docker only that it is a real directory: the engine runs as the
 * image's user, a subordinate id on the host the installer does not compute,
 * and the helper container hands the directory to it.
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
  if (mode === 'rootless') return null;
  const writable = (st.uid === engine.uid && (st.mode & 0o300) === 0o300)
    || (st.uid !== engine.uid && st.gid === engine.gid && (st.mode & 0o030) === 0o030)
    || (st.uid !== engine.uid && st.gid !== engine.gid && (st.mode & 0o003) === 0o003);
  if (!writable) {
    return {
      reason: `${dataDir} belongs to uid ${String(st.uid)}, and the container writes as uid ${String(engine.uid)}.`,
      command: engine.uid === host.uid
        ? chownCommand(host, dataDir)
        : `sudo chown -R ${String(engine.uid)}:${String(engine.gid)} ${shellQuote(dataDir)}`,
    };
  }
  return null;
}

/**
 * Why a data dir cannot be handed to the image's user as it is, or `null`.
 * Installing as root, only a fresh directory is handed over: the directory
 * itself and the recovery copy `.env` the installer writes into it. No walk
 * over anything else, because a tree that another id can change while root
 * walks it lets that id point root at any file on the host. Anything more is
 * refused, with the command to run by hand.
 * - the path must be exactly `<home>/.lynox`, a real directory owned by root;
 * - `<home>` must belong to root (under `sudo -E` it is the user's home);
 * - nothing in it but a `.env` that is a regular file with one name.
 */
export function freshDataDirProblem(
  dataDir: string,
  home: string,
): { readonly reason: string; readonly command: string | null } | null {
  const expected = join(home, '.lynox');
  if (resolve(dataDir) !== resolve(expected)) {
    return { reason: `Only ${expected} is handed to the image's user, not ${dataDir}.`, command: null };
  }
  if (lstatSync(home).uid !== 0) {
    return { reason: `${home} does not belong to root. Run the installer without sudo, or with sudo -H.`, command: null };
  }
  const handBack = `chown -R -P ${String(IMAGE_IDS.uid)}:${String(IMAGE_IDS.gid)} ${shellQuote(dataDir)}`;
  let st;
  try {
    st = lstatSync(dataDir);
  } catch {
    return { reason: `${dataDir} does not exist.`, command: `mkdir -p ${shellQuote(dataDir)}` };
  }
  if (st.isSymbolicLink() || !st.isDirectory()) return { reason: `${dataDir} is not a real directory.`, command: null };
  if (st.uid !== 0) return { reason: `${dataDir} belongs to uid ${String(st.uid)}, not to root or to the image's user.`, command: handBack };
  for (const name of readdirSync(dataDir)) {
    if (name !== '.env') return { reason: `${dataDir} already holds ${name}; only a fresh directory is handed over.`, command: handBack };
    const env = lstatSync(join(dataDir, name));
    if (!env.isFile() || env.nlink > 1) { // lstat: a symlink is never a file
      return { reason: `${join(dataDir, name)} is not a regular file with one name.`, command: null };
    }
  }
  return null;
}

/**
 * Hands a fresh data dir ({@link freshDataDirProblem}) to the image's user:
 * the `.env` first, then the directory, both with `lchown`, which never
 * follows a symlink. Checks again right before, and throws on a problem.
 */
export function handOverFreshDataDir(dataDir: string, home: string): void {
  const problem = freshDataDirProblem(dataDir, home);
  if (problem) throw new Error(`refusing to chown: ${problem.reason}`);
  const env = join(dataDir, '.env');
  if (readdirSync(dataDir).includes('.env')) lchownSync(env, IMAGE_IDS.uid, IMAGE_IDS.gid);
  lchownSync(dataDir, IMAGE_IDS.uid, IMAGE_IDS.gid);
}

/** Hands one file the installer wrote (SearXNG's settings) to the image's user. Never through a symlink. */
export function chownFileToImage(path: string): void {
  const st = lstatSync(path);
  if (st.isSymbolicLink() || !st.isFile() || st.nlink > 1) {
    throw new Error(`refusing to chown ${path}: not a regular file with one name`);
  }
  lchownSync(path, IMAGE_IDS.uid, IMAGE_IDS.gid);
}

export type VaultKeyDecision =
  | { readonly kind: 'reuse'; readonly key: string; readonly from: string }
  | { readonly kind: 'new' }
  | { readonly kind: 'refuse'; readonly reason: string; readonly command: string };

/**
 * Where the vault key comes from. A new key is made only when it is certain
 * that no vault exists: a new key next to an existing `vault.db` makes every
 * secret in it unreadable. A data dir this user cannot list may hold one, so
 * it counts as "a vault exists".
 *
 * - `recoveryKey`: the key in `<dataDir>/.env`, if this user could read it;
 * - `installKey`: the key in the install dir's `.env`, from an earlier run;
 * - `listable`: whether this user could list the data dir;
 * - `vaultExists`: whether a database is in it (meaningful only when listable);
 *   not only `vault.db`, the other databases hold fields encrypted with the key.
 */
export function decideVaultKey(opts: {
  readonly mode: DockerMode;
  readonly dataDir: string;
  readonly installEnv: string;
  readonly recoveryKey: string | null;
  readonly installKey: string | null;
  readonly listable: boolean;
  readonly vaultExists: boolean;
}): VaultKeyDecision {
  const { mode, dataDir, installEnv, recoveryKey, installKey, listable, vaultExists } = opts;
  if (recoveryKey) return { kind: 'reuse', key: recoveryKey, from: join(dataDir, '.env') };
  if (listable && !vaultExists) return { kind: 'new' };
  if (installKey) return { kind: 'reuse', key: installKey, from: installEnv };
  // Copies the key line across without printing it. The newline first, so
  // the line cannot join the last one of a file that does not end in one.
  const source = join(dataDir, '.env');
  const copy = mode === 'rootless'
    ? `docker run --rm --network none -v ${shellQuote(`${dataDir}:/d:ro`)} ${HELPER_IMAGE} grep '^LYNOX_VAULT_KEY=' /d/.env`
    : `sudo grep '^LYNOX_VAULT_KEY=' ${shellQuote(source)}`;
  const command = `mkdir -p ${shellQuote(dirname(installEnv))} && printf '\\n' >> ${shellQuote(installEnv)} && ${copy} >> ${shellQuote(installEnv)}`;
  return {
    kind: 'refuse',
    reason: listable
      ? `${dataDir} holds a vault, and no key for it was found. A new key would make it unreadable.`
      : `${dataDir} cannot be read by this user, so it may hold a vault, and no key for it was found in ${installEnv}. A new key would make it unreadable.`,
    command,
  };
}

/**
 * What to tell the user when the helper container failed. A `chown` that was
 * refused means a file in the data dir belongs to an id the helper does not
 * map (host root, another user): handing it all to the host user lets the next
 * run complete it. Anything else (the image could not be pulled, Docker
 * failed, the time ran out) has no such command.
 */
export function helperFailure(stderr: string, host: Ids, dataDir: string): { reason: string; command: string | null } {
  const firstLine = stderr.trim().split('\n')[0] ?? '';
  if (/chown: .*(Operation not permitted|Permission denied)/.test(stderr)) {
    return {
      reason: `Could not hand ${dataDir} to the container's user: something in it belongs to an id the helper cannot change (${firstLine}).`,
      command: chownCommand(host, dataDir),
    };
  }
  return {
    reason: `Could not hand ${dataDir} to the container's user: the helper container (${HELPER_IMAGE}) did not run${firstLine ? ` (${firstLine})` : ''}. Check that Docker can pull it, then run this again.`,
    command: null,
  };
}
