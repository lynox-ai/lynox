import { describe, expect, it } from 'vitest';
import {
  MIGRATION_MEMORY,
  maxPlainStoreBytes,
  migrationCeiling,
  readImportLimitMb,
  storePath,
  type MigrationCeiling,
} from './migration-ceiling.js';

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

/** The published numbers with the limit of a 1536 MiB container. */
const CONTAINER: MigrationCeiling = {
  import_limit_mb: 1536,
  baseline_mb: MIGRATION_MEMORY.baselineMb,
  k: MIGRATION_MEMORY.k,
  rest_factor: MIGRATION_MEMORY.restFactor,
};

/** The decoded rest with every non-database chunk type at its cap, as in the measured runs. */
const REST_AT_CAPS = 283 * MIB;

const files = (map: Record<string, string>) => (path: string): string => {
  const text = map[path];
  if (text === undefined) throw new Error(`ENOENT ${path}`);
  return text;
};

describe('readImportLimitMb', () => {
  it('takes the cgroup v2 limit when one is set', () => {
    expect(readImportLimitMb(files({ '/sys/fs/cgroup/memory.max': '1610612736\n' }), 4 * GIB)).toBe(1536);
  });

  it('takes the cgroup v1 limit when there is no v2 file', () => {
    expect(readImportLimitMb(files({ '/sys/fs/cgroup/memory/memory.limit_in_bytes': '1073741824' }), 4 * GIB)).toBe(1024);
  });

  it('takes the smaller of a v2 and a v1 limit', () => {
    const read = files({
      '/sys/fs/cgroup/memory.max': '1610612736',
      '/sys/fs/cgroup/memory/memory.limit_in_bytes': '1073741824',
    });
    expect(readImportLimitMb(read, 4 * GIB)).toBe(1024);
  });

  it('reads on past a v2 `max` to a v1 limit', () => {
    const read = files({
      '/sys/fs/cgroup/memory.max': 'max',
      '/sys/fs/cgroup/memory/memory.limit_in_bytes': '1073741824',
    });
    expect(readImportLimitMb(read, 4 * GIB)).toBe(1024);
  });

  it('finds the limit on its own cgroup outside a private namespace', () => {
    const read = files({
      '/proc/self/cgroup': '0::/system.slice/docker-abc.scope\n',
      '/sys/fs/cgroup/system.slice/docker-abc.scope/memory.max': '1610612736',
      '/sys/fs/cgroup/memory.max': 'max',
    });
    expect(readImportLimitMb(read, 4 * GIB)).toBe(1536);
  });

  it('finds a limit on an ancestor when its own cgroup says max', () => {
    const read = files({
      '/proc/self/cgroup': '0::/kubepods/pod1/c1\n',
      '/sys/fs/cgroup/kubepods/pod1/c1/memory.max': 'max',
      '/sys/fs/cgroup/kubepods/pod1/memory.max': '1073741824',
      '/sys/fs/cgroup/kubepods/memory.max': 'max',
    });
    expect(readImportLimitMb(read, 4 * GIB)).toBe(1024);
  });

  it('reads the v1 memory controller line of /proc/self/cgroup', () => {
    const read = files({
      '/proc/self/cgroup': '5:cpu,cpuacct:/docker/abc\n4:memory:/docker/abc\n',
      '/sys/fs/cgroup/memory/docker/abc/memory.limit_in_bytes': '1073741824',
      '/sys/fs/cgroup/memory/memory.limit_in_bytes': '9223372036854771712',
    });
    expect(readImportLimitMb(read, 4 * GIB)).toBe(1024);
  });

  it('reads the mount root inside a private namespace', () => {
    const read = files({
      '/proc/self/cgroup': '0::/\n',
      '/sys/fs/cgroup/memory.max': '1610612736',
    });
    expect(readImportLimitMb(read, 4 * GIB)).toBe(1536);
  });

  it('stays under the mount for a path that leaves the namespace root', () => {
    const read = files({
      '/proc/self/cgroup': '0::/../x\n',
      '/sys/fs/cgroup/x/memory.max': '1073741824',
      '/sys/fs/cgroup/../x/memory.max': '536870912',
    });
    expect(readImportLimitMb(read, 4 * GIB)).toBe(1024);
  });

  it('ignores a limit that reads as 0', () => {
    expect(readImportLimitMb(files({ '/sys/fs/cgroup/memory.max': '0' }), 4 * GIB)).toBe(4096);
  });

  it('falls back to the host when the cgroup has no limit', () => {
    expect(readImportLimitMb(files({ '/sys/fs/cgroup/memory.max': 'max' }), 4 * GIB)).toBe(4096);
    // v1 without a limit reports a value near 2^63, above any host
    expect(readImportLimitMb(files({ '/sys/fs/cgroup/memory/memory.limit_in_bytes': '9223372036854771712' }), 4 * GIB)).toBe(4096);
  });

  it('falls back to the host when there is no cgroup file', () => {
    expect(readImportLimitMb(files({}), 2 * GIB)).toBe(2048);
  });

  it('keeps the host when the limit is above it', () => {
    expect(readImportLimitMb(files({ '/sys/fs/cgroup/memory.max': String(8 * GIB) }), 4 * GIB)).toBe(4096);
  });
});

describe('migrationCeiling', () => {
  it('publishes the measured constants next to a positive limit', () => {
    const c = migrationCeiling();
    expect(c.baseline_mb).toBe(MIGRATION_MEMORY.baselineMb);
    expect(c.k).toBe(MIGRATION_MEMORY.k);
    expect(c.rest_factor).toBe(MIGRATION_MEMORY.restFactor);
    expect(c.import_limit_mb).toBeGreaterThan(0);
  });
});

describe('storePath', () => {
  // Both sides of the bound, the bound taken from the predicate solved for S, never typed.
  it.each([
    ['the rest at its caps', REST_AT_CAPS],
    ['no rest', 0],
  ])('takes plain just under the bound and raw just over it, with %s', (_label, rest) => {
    const bound = maxPlainStoreBytes(CONTAINER, rest, rest);
    expect(bound).toBeGreaterThan(0);
    expect(storePath(CONTAINER, { bundleBytes: rest + bound, restBytes: rest, storeBytes: bound })).toBe('plain');
    expect(storePath(CONTAINER, { bundleBytes: rest + bound + 1, restBytes: rest, storeBytes: bound + 1 })).toBe('raw');
  });

  // A cross-check of the constants against the figures the design states (72 MiB with the rest
  // at its caps, 189 MiB with none). A change to a constant fails here and has to be carried
  // into the design in the same change.
  it('derives the stated bounds from the constants', () => {
    expect(Math.floor(maxPlainStoreBytes(CONTAINER, REST_AT_CAPS, REST_AT_CAPS) / MIB)).toBe(72);
    expect(Math.floor(maxPlainStoreBytes(CONTAINER, 0, 0) / MIB)).toBe(189);
  });

  it('takes plain at exactly the limit', () => {
    // baseline 0, no rest, k 2: the peak is B + S = 2 * S, so 5 MiB lands on a 10 MiB limit
    const c: MigrationCeiling = { import_limit_mb: 10, baseline_mb: 0, k: 2, rest_factor: 1 };
    expect(storePath(c, { bundleBytes: 5 * MIB, restBytes: 0, storeBytes: 5 * MIB })).toBe('plain');
    expect(storePath(c, { bundleBytes: 5 * MIB + 1, restBytes: 0, storeBytes: 5 * MIB + 1 })).toBe('raw');
  });

  // Each term on its own: with the others zero, a size that fits without the term does not with it.
  it.each([
    ['the baseline', { import_limit_mb: 100, baseline_mb: 60, k: 1, rest_factor: 0 }, { bundleBytes: 50 * MIB, restBytes: 0, storeBytes: 0 }],
    ['the bundle', { import_limit_mb: 100, baseline_mb: 0, k: 1, rest_factor: 0 }, { bundleBytes: 101 * MIB, restBytes: 0, storeBytes: 0 }],
    ['the rest factor', { import_limit_mb: 100, baseline_mb: 0, k: 1, rest_factor: 2 }, { bundleBytes: 40 * MIB, restBytes: 40 * MIB, storeBytes: 0 }],
    ['k - 1', { import_limit_mb: 100, baseline_mb: 0, k: 3, rest_factor: 0 }, { bundleBytes: 40 * MIB, restBytes: 0, storeBytes: 40 * MIB }],
  ] as const)('counts %s', (_label, ceiling, sizes) => {
    expect(storePath(ceiling, sizes)).toBe('raw');
  });

  it('takes raw for anything it cannot judge', () => {
    const fine = { bundleBytes: 10 * MIB, restBytes: 0, storeBytes: 10 * MIB };
    expect(storePath(CONTAINER, fine)).toBe('plain'); // the control: the same sizes pass
    expect(storePath({ ...CONTAINER, k: Number.NaN }, fine)).toBe('raw');
    expect(storePath({ ...CONTAINER, import_limit_mb: Number.POSITIVE_INFINITY }, fine)).toBe('raw');
    expect(storePath({ ...CONTAINER, baseline_mb: -1 }, fine)).toBe('raw');
    expect(storePath({ ...CONTAINER, k: 0.5 }, fine)).toBe('raw');
    expect(storePath(CONTAINER, { ...fine, storeBytes: -1 })).toBe('raw');
    // a bundle smaller than the store it contains
    expect(storePath(CONTAINER, { bundleBytes: MIB, restBytes: 0, storeBytes: 10 * MIB })).toBe('raw');
    // a bundle smaller than the store and the rest it contains
    expect(storePath(CONTAINER, { bundleBytes: 15 * MIB, restBytes: 10 * MIB, storeBytes: 10 * MIB })).toBe('raw');
    expect(storePath(CONTAINER, { bundleBytes: 20 * MIB, restBytes: 10 * MIB, storeBytes: 10 * MIB })).toBe('plain'); // control
  });
});
