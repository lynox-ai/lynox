/**
 * Each accepted OSV finding (ACCEPTED in scripts/osv-report-gate.mjs) rests on a claim about this
 * repo: that the vulnerable path is not reachable. This file checks that claim against the tree for
 * every entry, so the acceptance cannot outlive its reason. An entry without a check here fails.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error — plain ESM CLI, no type declarations by design.
import { ACCEPTED } from '../scripts/osv-report-gate.mjs';
import { parse as parseYaml } from 'yaml';
import { runtimeReach, type LockDoc } from './helpers/osv-runtime-reach.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.svelte-kit', 'coverage']);

function files(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) files(p, out);
    else out.push(relative(ROOT, p));
  }
  return out;
}

/**
 * What SvelteKit remote functions need, in any one of three forms: the experimental flag in a
 * svelte config, a `*.remote.ts`/`*.remote.js` module, or an import from `$app/server` (where
 * `form`, `query` and `command` come from). Returns each place found.
 */
export function remoteFunctionUse(tree: Array<[string, string]>): string[] {
  const found: string[] = [];
  for (const [path, text] of tree) {
    if (/\.remote\.(ts|js)$/.test(path)) found.push(`${path}: a remote functions module`);
    if (/(^|\/)svelte\.config\.(js|ts|mjs)$/.test(path) && /\bremoteFunctions\b/.test(text)) found.push(`${path}: the remoteFunctions flag`);
    if (/\.(ts|js|mjs|svelte)$/.test(path) && /from\s+['"]\$app\/server['"]|import\s*\(?\s*['"]\$app\/server['"]/.test(text)) found.push(`${path}: an import from $app/server`);
  }
  return found;
}

function tree(): Array<[string, string]> {
  // Tests are left out: they hold the planted forms below as strings, and a test is not served.
  return files(ROOT)
    .filter((p) => /\.(ts|mts|cts|js|mjs|cjs|svelte)$/.test(p) && !/\.test\.(ts|js)$/.test(p) && !p.startsWith('tests/'))
    .map((p) => [p, readFileSync(join(ROOT, p), 'utf8')] as [string, string]);
}

/** The importers whose runtime dependencies ship: the npm package and the web UI in the image. */
const SHIPPED = ['.', 'packages/web-ui'];
const lock = (path: string): LockDoc => parseYaml(readFileSync(join(ROOT, path), 'utf8')) as LockDoc;

/** One premise check per accepted advisory id. */
const PREMISES: Record<string, () => string[]> = {
  // Advisory scope: only apps that enable the experimental remote functions and use form, query or command.
  'GHSA-3r8g-jcqq-3p5j': () => remoteFunctionUse(tree()),
};

describe('the premise of each accepted OSV finding holds in this tree', () => {
  it('every accepted entry has a premise check', () => {
    expect(ACCEPTED.map((a: { id: string }) => a.id).filter((id: string) => !(id in PREMISES))).toEqual([]);
  });

  it('every premise check belongs to an accepted entry, so a removed acceptance takes its check along', () => {
    const ids = new Set(ACCEPTED.map((a: { id: string }) => a.id));
    expect(Object.keys(PREMISES).filter((id) => !ids.has(id))).toEqual([]);
  });

  it.each(ACCEPTED.map((a: { id: string; package: string }) => [`${a.package} ${a.id}`, a.id]))('%s: the vulnerable path is not used', (_name, id) => {
    expect(PREMISES[id as string]!()).toEqual([]);
  });

  it('the check finds each form of remote function use (positive controls)', () => {
    expect(remoteFunctionUse([['packages/web-ui/src/routes/data.remote.ts', 'export const x = 1;']])).toHaveLength(1);
    expect(remoteFunctionUse([['packages/web-ui/src/lib/a.ts', "import { form } from '$app/server';"]])).toHaveLength(1);
    expect(remoteFunctionUse([['packages/web-ui/src/lib/b.svelte', "const m = await import('$app/server');"]])).toHaveLength(1);
    expect(remoteFunctionUse([['packages/web-ui/src/lib/d.ts', "import '$app/server';"]])).toHaveLength(1);
    expect(remoteFunctionUse([['packages/web-ui/svelte.config.js', 'export default { kit: { experimental: { remoteFunctions: true } } };']])).toHaveLength(1);
    expect(remoteFunctionUse([['packages/web-ui/src/lib/c.ts', "import { browser } from '$app/environment';"]])).toEqual([]);
  });

  it('the runtime walk finds a package the shipped code does depend on, and a planted path (positive controls)', () => {
    // A real runtime dependency is found through the same walk, and one only reached transitively
    // (rollup, through the error reporter's bundler plugins), so the snapshot lookups really walk.
    expect(runtimeReach(lock('pnpm-lock.yaml'), 'better-sqlite3', SHIPPED).length).toBeGreaterThan(0);
    expect(runtimeReach(lock('pnpm-lock.yaml'), 'rollup', SHIPPED).some((p) => p.split(' > ').length > 3)).toBe(true);
    // The web UI importer is walked too: one of its own runtime dependencies is found through it.
    expect(runtimeReach(lock('pnpm-lock.yaml'), 'dompurify', SHIPPED).some((p) => p.startsWith('packages/web-ui > '))).toBe(true);
    // An importer's optional dependencies are walked, and a listed importer the lockfile lacks is reported.
    const optional: LockDoc = { importers: { '.': { optionalDependencies: { picomatch: { version: '4.0.7' } } }, 'packages/web-ui': {} }, snapshots: { 'picomatch@4.0.7': {} } };
    expect(runtimeReach(optional, 'picomatch', SHIPPED)).toEqual(['. > picomatch']);
    expect(runtimeReach({ importers: { '.': {} }, snapshots: {} }, 'picomatch', SHIPPED)).toEqual(['missing importer: packages/web-ui']);
    // A dependency whose snapshot is missing is reported, never treated as a clean leaf.
    const unknownKey: LockDoc = { importers: { '.': { dependencies: { alias: { version: 'picomatch@4.0.7' } } }, 'packages/web-ui': {} }, snapshots: {} };
    expect(runtimeReach(unknownKey, 'picomatch', SHIPPED)).toEqual(['missing snapshot: alias@picomatch@4.0.7 (. > alias)']);
    // A planted transitive path is found; the same package as a dev dependency only is not.
    const planted: LockDoc = {
      importers: { '.': { dependencies: { a: { version: '1.0.0(p@2)' } } }, 'packages/web-ui': {} },
      snapshots: { 'a@1.0.0(p@2)': { dependencies: { '@s/b': '2.0.0' } }, '@s/b@2.0.0': { optionalDependencies: { picomatch: '4.0.7' } }, 'picomatch@4.0.7': {} },
    };
    expect(runtimeReach(planted, 'picomatch', SHIPPED)).toEqual(['. > a > @s/b > picomatch']);
    const devOnly = { importers: { '.': { devDependencies: { picomatch: { version: '4.0.7' } } }, 'packages/web-ui': {} }, snapshots: {} } as unknown as LockDoc;
    expect(runtimeReach(devOnly, 'picomatch', SHIPPED)).toEqual([]);
  });

  it('the walk reaches the web-ui source and its svelte config', () => {
    const paths = tree().map(([p]) => p);
    expect(paths).toContain('packages/web-ui/svelte.config.js');
    // .cjs modules are read too (the package's postinstall is one).
    expect(paths).toContain('scripts/postinstall.cjs');
    expect(paths.some((p) => p.startsWith('packages/web-ui/src/') && p.endsWith('.svelte'))).toBe(true);
  });
});
