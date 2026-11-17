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
import { runtimeReach, type LockDoc } from './osv-runtime-reach.js';

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
    .filter((p) => /\.(ts|js|mjs|svelte)$/.test(p) && !/\.test\.(ts|js)$/.test(p) && !p.startsWith('tests/'))
    .map((p) => [p, readFileSync(join(ROOT, p), 'utf8')] as [string, string]);
}

/** The importers whose runtime dependencies ship: the npm package and the web UI in the image. */
const SHIPPED = ['.', 'packages/web-ui'];
const lock = (path: string): LockDoc => parseYaml(readFileSync(join(ROOT, path), 'utf8')) as LockDoc;

/**
 * Why the docs site could ship, or nothing: it must stay a private package, out of the npm
 * package's `files` (no entry naming docs, no glob, not the whole tree) and out of the image
 * (no COPY/ADD naming docs, and `.dockerignore` keeps `docs/` out of a broad COPY).
 */
export function docsShipped(docsPackage: string, rootPackage: string, dockerfile: string, dockerignore: string): string[] {
  const out: string[] = [];
  if ((JSON.parse(docsPackage) as { private?: unknown }).private !== true) out.push('docs/package.json is not private');
  const files = (JSON.parse(rootPackage) as { files?: unknown }).files;
  if (!Array.isArray(files) || files.some((f) => typeof f !== 'string' || /docs|\*/.test(f) || /^\.?\/?$/.test(f))) out.push('package.json files may carry docs');
  if (/^\s*(COPY|ADD)\b[^\n]*\bdocs\b/m.test(dockerfile)) out.push('the Dockerfile copies docs');
  if (!/^\/?docs\/?\s*$/m.test(dockerignore)) out.push('.dockerignore does not keep docs/ out');
  return out;
}

/**
 * Where code outside tests loads a bundler plugin entry: rollup, `@sentry/bundler-plugins`, or a
 * `@sentry/node/<bundler>` subpath. rollup ships as an optional dependency of those plugins and
 * inlines its own picomatch, which no lockfile scan sees; the premise is that nothing loads it.
 */
export function bundlerPluginUse(tree: Array<[string, string]>): string[] {
  const re = /['"](rollup|@sentry\/bundler-plugins|@sentry\/node\/(rollup|vite|webpack|esbuild))(\/[^'"]*)?['"]/;
  return tree.filter(([path, text]) => !/(^|\/)(vite|vitest|svelte|rollup)\.config\.(js|ts|mjs)$/.test(path) && re.test(text)).map(([path]) => `${path}: loads a bundler plugin entry`);
}

/** What the picomatch premise reads: the root lockfile, the docs and image files, and the source. */
interface PicomatchInputs {
  readonly lock: LockDoc;
  readonly docsPackage: string;
  readonly rootPackage: string;
  readonly dockerfile: string;
  readonly dockerignore: string;
  readonly source: Array<[string, string]>;
}

/** Every reason the picomatch acceptance would no longer hold, or nothing. */
export function picomatchPremise(i: PicomatchInputs): string[] {
  return [
    ...runtimeReach(i.lock, 'picomatch', SHIPPED),
    ...docsShipped(i.docsPackage, i.rootPackage, i.dockerfile, i.dockerignore),
    ...bundlerPluginUse(i.source.filter(([p]) => p.startsWith('src/') || p.startsWith('packages/web-ui/src/'))),
  ];
}

const realPicomatchInputs = (): PicomatchInputs => ({
  lock: lock('pnpm-lock.yaml'),
  docsPackage: readFileSync(join(ROOT, 'docs/package.json'), 'utf8'),
  rootPackage: readFileSync(join(ROOT, 'package.json'), 'utf8'),
  dockerfile: readFileSync(join(ROOT, 'Dockerfile'), 'utf8'),
  dockerignore: readFileSync(join(ROOT, '.dockerignore'), 'utf8'),
  source: tree(),
});

/** The picomatch premise on this tree; a patch replaces inputs, so a control can plant a finding. */
const picomatchCheck = (patch: Partial<PicomatchInputs> = {}): string[] => picomatchPremise({ ...realPicomatchInputs(), ...patch });

/** One premise check per accepted advisory id. */
const PREMISES: Record<string, () => string[]> = {
  // Advisory scope: only apps that enable the experimental remote functions and use form, query or command.
  'GHSA-3r8g-jcqq-3p5j': () => remoteFunctionUse(tree()),
  // Advisory scope: an attacker-chosen glob pattern. picomatch must not be a runtime dependency of
  // what ships, the docs that also carry it must stay unshipped, and nothing may load the bundler
  // plugins whose rollup inlines its own copy.
  'GHSA-fc5q-39xc-vjpf': picomatchCheck,
};

describe('the premise of each accepted OSV finding holds in this tree', () => {
  it('every accepted entry has a premise check', () => {
    expect(ACCEPTED.map((a: { id: string }) => a.id).filter((id: string) => !(id in PREMISES))).toEqual([]);
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
    // A dependency whose snapshot is missing is reported, never treated as a clean leaf.
    const unknownKey: LockDoc = { importers: { '.': { dependencies: { alias: { version: 'picomatch@4.0.7' } } } }, snapshots: {} };
    expect(runtimeReach(unknownKey, 'picomatch', SHIPPED)).toEqual(['missing snapshot: alias@picomatch@4.0.7 (. > alias)']);
    // A planted transitive path is found; the same package as a dev dependency only is not.
    const planted: LockDoc = {
      importers: { '.': { dependencies: { a: { version: '1.0.0(p@2)' } } }, 'packages/web-ui': {} },
      snapshots: { 'a@1.0.0(p@2)': { dependencies: { '@s/b': '2.0.0' } }, '@s/b@2.0.0': { optionalDependencies: { picomatch: '4.0.7' } }, 'picomatch@4.0.7': {} },
    };
    expect(runtimeReach(planted, 'picomatch', SHIPPED)).toEqual(['. > a > @s/b > picomatch']);
    const devOnly = { importers: { '.': { devDependencies: { picomatch: { version: '4.0.7' } } } }, snapshots: {} } as unknown as LockDoc;
    expect(runtimeReach(devOnly, 'picomatch', SHIPPED)).toEqual([]);
  });

  it('the docs check names each way the docs could ship (positive controls)', () => {
    const ok = ['{"private": true}', '{"files": ["dist/", "README.md"]}', 'COPY --from=build /app/dist/ /app/dist/', 'node_modules\ndocs/\n'] as const;
    expect(docsShipped(...ok)).toEqual([]);
    expect(docsShipped('{"private": false}', ok[1], ok[2], ok[3])).toHaveLength(1);
    for (const files of ['["dist/", "docs/"]', '["./docs"]', '["*"]', '["**/*.md"]', '["."]']) {
      expect(docsShipped(ok[0], `{"files": ${files}}`, ok[2], ok[3])).toHaveLength(1);
    }
    expect(docsShipped(ok[0], '{}', ok[2], ok[3])).toHaveLength(1);
    expect(docsShipped(ok[0], ok[1], 'COPY docs/ /app/docs/', ok[3])).toHaveLength(1);
    expect(docsShipped(ok[0], ok[1], ok[2], 'node_modules\n')).toHaveLength(1);
  });

  it('the bundler plugin check finds each entry form (positive controls)', () => {
    for (const text of ["import x from 'rollup';", "await import('@sentry/node/rollup')", "require('@sentry/bundler-plugins/vite')", 'import "@sentry/node/esbuild";']) {
      expect(bundlerPluginUse([['src/core/x.ts', text]])).toHaveLength(1);
    }
    expect(bundlerPluginUse([['src/core/x.ts', "await import('@sentry/node');"]])).toEqual([]);
    expect(bundlerPluginUse([['packages/web-ui/vite.config.ts', "import x from 'rollup';"]])).toEqual([]);
  });

  it('the picomatch premise reports each of its three conditions (wiring controls)', () => {
    expect(PREMISES['GHSA-fc5q-39xc-vjpf']).toBe(picomatchCheck);
    const real = realPicomatchInputs();
    expect(picomatchCheck()).toEqual([]);
    const reached: LockDoc = { ...real.lock, importers: { ...real.lock.importers, '.': { dependencies: { picomatch: { version: '4.0.7' } } } } };
    expect(picomatchCheck({ lock: reached })).toEqual(['. > picomatch']);
    expect(picomatchCheck({ dockerfile: `${real.dockerfile}\nCOPY docs/ /app/docs/\n` })).toEqual(['the Dockerfile copies docs']);
    expect(picomatchCheck({ source: [...real.source, ['src/core/x.ts', "await import('@sentry/node/rollup');"]] })).toEqual(['src/core/x.ts: loads a bundler plugin entry']);
  });

  it('the walk reaches the web-ui source and its svelte config', () => {
    const paths = tree().map(([p]) => p);
    expect(paths).toContain('packages/web-ui/svelte.config.js');
    expect(paths.some((p) => p.startsWith('packages/web-ui/src/') && p.endsWith('.svelte'))).toBe(true);
  });
});
