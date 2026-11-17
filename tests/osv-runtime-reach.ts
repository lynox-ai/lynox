/**
 * Whether a package is reachable from the runtime dependencies of the shipped packages, read from
 * a pnpm lockfile (v9): from each importer's `dependencies` and `optionalDependencies` (never its
 * `devDependencies`) through every snapshot's own dependencies. Returns one path per place the
 * package is reached, or none. A dependency whose snapshot the walk cannot find is returned too,
 * as `missing snapshot: <key>`: a key form the walk does not understand (an alias, a tarball, a
 * new lockfile format) must not read as a clean leaf.
 */
interface LockDep { readonly version: string }
interface LockImporter {
  readonly dependencies?: Readonly<Record<string, LockDep>>;
  readonly optionalDependencies?: Readonly<Record<string, LockDep>>;
}
interface LockSnapshot {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
}
export interface LockDoc {
  readonly importers?: Readonly<Record<string, LockImporter>>;
  readonly snapshots?: Readonly<Record<string, LockSnapshot>>;
}

/** The package name of a snapshot key (`@scope/name@1.2.3(peer@4)` → `@scope/name`). */
function nameOf(key: string): string {
  const base = key.split('(')[0]!;
  return base.slice(0, base.lastIndexOf('@'));
}

export function runtimeReach(lock: LockDoc, target: string, importers: readonly string[]): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const stack: Array<{ key: string; path: string[] }> = [];
  for (const imp of importers) {
    const entry = lock.importers?.[imp];
    const deps = { ...(entry?.dependencies ?? {}), ...(entry?.optionalDependencies ?? {}) };
    for (const [name, dep] of Object.entries(deps)) {
      // A workspace link is another importer, walked on its own when it is listed.
      if (dep.version.startsWith('link:')) continue;
      stack.push({ key: `${name}@${dep.version}`, path: [imp, name] });
    }
  }
  while (stack.length > 0) {
    const { key, path } = stack.pop()!;
    if (nameOf(key) === target) found.push(path.join(' > '));
    if (seen.has(key)) continue;
    seen.add(key);
    const snap = lock.snapshots?.[key];
    if (snap === undefined) {
      found.push(`missing snapshot: ${key} (${path.join(' > ')})`);
      continue;
    }
    const deps = { ...(snap.dependencies ?? {}), ...(snap.optionalDependencies ?? {}) };
    for (const [name, version] of Object.entries(deps)) {
      if (version.startsWith('link:')) continue;
      stack.push({ key: `${name}@${version}`, path: [...path, name] });
    }
  }
  return found;
}
