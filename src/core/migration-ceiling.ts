/**
 * The memory a migration into this instance may use, and the rule that decides per store
 * whether its plaintext form fits.
 *
 * An import holds the whole bundle in memory until it cleans up, decodes the non-database
 * chunks into objects, and rewrites a store in memory. So a store of S bytes takes the
 * plaintext path only if
 *
 *   baseline + B + rest_factor * rest + (k - 1) * S <= import_limit
 *
 * where B is the bundle's total original size (the store included) and rest the size of the
 * decoded non-database chunks. The destination publishes the four numbers in `/api/health`
 * (`HealthBody.migration`); a source decides with them, and the destination checks a manifest
 * with the same numbers, so a later release that re-measures them does not make an honest
 * older source fail.
 *
 * The bound on S is never written down as a number. It follows from the constants below
 * through the predicate, so a change to a constant moves it.
 */
import { readFileSync } from 'node:fs';
import { totalmem } from 'node:os';
import type { HealthBody } from '../contract/http.js';

export type MigrationCeiling = NonNullable<HealthBody['migration']>;
export type StorePath = 'plain' | 'raw';

const MIB = 1024 * 1024;

/**
 * The measured constants, each with its source. All runs: 2026-11-14, the v2.17.0 image
 * (build df844a31), in a container limited to 1536 MiB and 0.8 CPU, the image's own exporter
 * and `MigrationImporter` driven directly; peak = the process's high-water mark after a reset
 * at the baseline, checked by a 200 MiB positive control (ratio 1.000).
 */
export const MIGRATION_MEMORY = {
  /**
   * Resident memory of the engine before the first chunk arrives, MiB. One reading of
   * `process.memory_rss_mb` on a freshly booted instance with no session (uptime 60 s).
   * A reading after a chat session is not yet taken.
   */
  baselineMb: 191,
  /**
   * Peak over the baseline, minus the bundle, per byte of decoded non-database chunks, with
   * every non-database chunk type at its cap. Maximum of three runs (1.944).
   */
  restFactor: 1.944,
  /**
   * Peak over the baseline per byte of a store rewritten in memory. For the raw path the runs
   * measured 3.48 / 2.83 / 2.31 at 25.8 / 82.5 / 206.3 MiB. The plaintext path is not measured
   * yet: its destination half re-encrypts in memory in steps (`migration-rekey.ts`), its source
   * half is not built. Until the same driver measures both, this is the earlier in-memory rewrite
   * spike's all-rows figure (7.1, one run, ciphertext to ciphertext), a reference and not a
   * proven bound; no source sends a plaintext store before that measurement.
   */
  k: 7.1,
  /**
   * The SOURCE's peak on the plaintext path, over its resident memory at the moment it judges a
   * store (the raw snapshots are held by then): `kSourceBaseMb + kSource` MiB per MiB of the store.
   * It is a line above every reading, not a fit; the peak is not proportional to the store (a fixed
   * part plus a falling slope), so a factor alone would undercount small stores.
   * Measured 2026-11-17 in the engine image (sha256:3fe4b651b272b3e7dba17e6b5e9e5c42d9af1dc2dbf491c6692af06a85dc8c8d,
   * core 9d9c96b4), one container per run with `--memory=1536m --memory-swap=1536m` (the tenant
   * container's limit), node 22.23; engine.db with 4 KiB encrypted memories, both stores on the
   * plaintext path, the own-memory check let through to read the peak; VmHWM reset after the
   * fixture, the resident memory read when the check reads it. Peak over it, two runs each:
   * 12.7 MiB → 102.2 / 102.7; 36.7 → 238.3 / 237.9; 84.7 → 448.4 / 440.8; 156.7 → 757.2 / 759.4;
   * 216.7 → 977.4 / 965.8. `80 + 5.0 · S` is above each, by 10.6 % at the closest (36.7 MiB).
   * Not covered: other row shapes (many small rows, large blobs), the host's swap and load. The
   * merge ledgers' plaintext form is not counted in it (it is built only for ledgers within the
   * 64 MiB cap).
   */
  kSourceBaseMb: 80,
  kSource: 5.0,
} as const;

/**
 * The files that may hold a memory limit for this process: for its own cgroup and every
 * ancestor, the v2 `memory.max` and the v1 `memory.limit_in_bytes`, each read relative to the
 * mount. The cgroup's path comes from `/proc/self/cgroup` (`0::<path>` on v2,
 * `<n>:memory:<path>` on v1). Inside a private cgroup namespace (Docker's default on v2) the
 * path is `/` and only the mount's own file counts; without one (a shared namespace, a nested
 * slice) the limit can sit on any ancestor, and a cgroup that says `max` can sit under one
 * that does not.
 */
function cgroupLimitFiles(readFile: (path: string) => string): string[] {
  const paths: Array<{ mount: string; file: string; path: string }> = [];
  let self = '';
  try { self = readFile('/proc/self/cgroup'); } catch { /* not Linux, or no procfs */ }
  for (const line of self.split('\n')) {
    const [, controllers, path] = /^\d+:([^:]*):(\/.*)$/.exec(line.trim()) ?? [];
    if (path === undefined) continue;
    if (controllers === '') paths.push({ mount: '/sys/fs/cgroup', file: 'memory.max', path });
    else if (controllers!.split(',').includes('memory')) paths.push({ mount: '/sys/fs/cgroup/memory', file: 'memory.limit_in_bytes', path });
  }
  // No procfs entry: still read the mounts' own files.
  if (paths.length === 0) {
    paths.push({ mount: '/sys/fs/cgroup', file: 'memory.max', path: '/' });
    paths.push({ mount: '/sys/fs/cgroup/memory', file: 'memory.limit_in_bytes', path: '/' });
  }
  const files: string[] = [];
  for (const { mount, file, path } of paths) {
    const parts = path.split('/').filter((p) => p !== '' && p !== '..');
    for (let depth = parts.length; depth >= 0; depth--) {
      files.push([mount, ...parts.slice(0, depth), file].join('/'));
    }
  }
  return files;
}

/**
 * The memory the import may use, in MiB: the smallest limit set on this process's cgroup or
 * any ancestor (cgroup v2 or v1), else the host's memory. A cgroup without a limit says `max`
 * (v2) or a value near 2^63 (v1); neither lowers the bound, and neither does a limit above the
 * host's memory or one that reads as 0.
 */
export function readImportLimitMb(
  readFile: (path: string) => string = (p) => readFileSync(p, 'utf8'),
  hostBytes: number = totalmem(),
): number {
  let limit = hostBytes;
  for (const file of cgroupLimitFiles(readFile)) {
    let text: string;
    try { text = readFile(file).trim(); } catch { continue; }
    if (!/^\d+$/.test(text)) continue; // `max`: no limit on this cgroup, an ancestor may have one
    const bytes = Number(text);
    if (bytes > 0 && bytes < limit) limit = bytes;
  }
  return Math.floor(limit / MIB);
}

let cachedLimitMb: number | null = null;

/** This process's memory limit in MiB (`readImportLimitMb`), read once per process. */
export function ownMemoryLimitMb(): number {
  cachedLimitMb ??= readImportLimitMb();
  return cachedLimitMb;
}

/** The `migration` block of the health body. The limit is read once per process. */
export function migrationCeiling(): MigrationCeiling {
  cachedLimitMb ??= readImportLimitMb();
  return {
    import_limit_mb: cachedLimitMb,
    baseline_mb: MIGRATION_MEMORY.baselineMb,
    k: MIGRATION_MEMORY.k,
    rest_factor: MIGRATION_MEMORY.restFactor,
  };
}

export interface MigrationSizes {
  /** The bundle's total original size in bytes, the store included. */
  bundleBytes: number;
  /**
   * The non-database chunks in bytes, at their original size as they travel (the merge ledgers
   * at their raw form's), not at their decoded size: the rest factor was measured that way (the
   * R run's rest was the bundle). So the rest is part of the bundle, and a bundle smaller than
   * the store and the rest is malformed, not merely large.
   */
  restBytes: number;
  /** The store's payload in bytes. */
  storeBytes: number;
}

const usable = (n: number): boolean => Number.isFinite(n) && n >= 0;

/**
 * Which path a store takes: `plain` only when the predicate holds. Anything it cannot judge
 * (a number that is not finite or is negative, a bundle smaller than the store and the rest it
 * contains, a k below 1) takes `raw`, today's path, which migrates the store unreadable rather
 * than not at all.
 */
export function storePath(ceiling: MigrationCeiling, sizes: MigrationSizes): StorePath {
  const { import_limit_mb: limit, baseline_mb: baseline, k, rest_factor: restFactor } = ceiling;
  const { bundleBytes, restBytes, storeBytes } = sizes;
  if (![limit, baseline, k, restFactor, bundleBytes, restBytes, storeBytes].every(usable)) return 'raw';
  if (k < 1 || bundleBytes < storeBytes + restBytes) return 'raw';
  const peakMb = baseline + bundleBytes / MIB + restFactor * (restBytes / MIB) + (k - 1) * (storeBytes / MIB);
  return peakMb <= limit ? 'plain' : 'raw';
}

/**
 * The largest store, in bytes, that takes the plaintext path next to `otherBytes` of other
 * chunks (the rest among them) and `restBytes` of decoded rest: the predicate solved for S,
 * with B = otherBytes + S. Negative when nothing fits, and -1 for inputs `storePath` would
 * not judge (a k below 1, a number that is not finite or is negative); never NaN, and Infinity
 * only for a limit so large that the product overflows (the source's own checks still apply).
 */
export function maxPlainStoreBytes(ceiling: MigrationCeiling, otherBytes: number, restBytes: number): number {
  const { import_limit_mb: limit, baseline_mb: baseline, k, rest_factor: restFactor } = ceiling;
  if (![limit, baseline, k, restFactor, otherBytes, restBytes].every(usable) || k < 1) return -1;
  const headroomMb = limit - baseline - otherBytes / MIB - restFactor * (restBytes / MIB);
  return Math.floor((headroomMb * MIB) / k);
}
