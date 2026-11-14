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
   * measured 3.48 / 2.83 / 2.31 at 25.8 / 82.5 / 206.3 MiB; the plaintext path does not exist
   * yet, so this is the earlier in-memory rewrite spike's all-rows figure (7.1, one run,
   * ciphertext to ciphertext), a reference and not a proven bound, until the build that adds
   * the plaintext path measures it.
   */
  k: 7.1,
} as const;

/** Where the container's limit is read from: cgroup v2, then v1. */
const CGROUP_LIMIT_FILES = ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes'];

/**
 * The memory the import may use, in MiB: the container's limit when one is set, else the
 * host's memory. A cgroup without a limit says `max` (v2) or a value near 2^63 (v1); both
 * leave the host's memory as the bound, and so does a limit above it.
 */
export function readImportLimitMb(
  readFile: (path: string) => string = (p) => readFileSync(p, 'utf8'),
  hostBytes: number = totalmem(),
): number {
  let limit = hostBytes;
  for (const file of CGROUP_LIMIT_FILES) {
    let text: string;
    try { text = readFile(file).trim(); } catch { continue; }
    if (!/^\d+$/.test(text)) break; // `max`: no limit on this cgroup
    const bytes = Number(text);
    if (Number.isSafeInteger(bytes) && bytes > 0 && bytes < limit) limit = bytes;
    break;
  }
  return Math.floor(limit / MIB);
}

let cachedLimitMb: number | null = null;

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
  /** The decoded non-database chunks in bytes. */
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
 * with B = otherBytes + S. Negative when nothing fits.
 */
export function maxPlainStoreBytes(ceiling: MigrationCeiling, otherBytes: number, restBytes: number): number {
  const { import_limit_mb: limit, baseline_mb: baseline, k, rest_factor: restFactor } = ceiling;
  const headroomMb = limit - baseline - otherBytes / MIB - restFactor * (restBytes / MIB);
  return Math.floor((headroomMb * MIB) / k);
}
