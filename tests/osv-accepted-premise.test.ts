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
    if (/\.(ts|js|mjs|svelte)$/.test(path) && /from\s+['"]\$app\/server['"]|import\(\s*['"]\$app\/server['"]\s*\)/.test(text)) found.push(`${path}: an import from $app/server`);
  }
  return found;
}

function tree(): Array<[string, string]> {
  // Tests are left out: they hold the planted forms below as strings, and a test is not served.
  return files(ROOT)
    .filter((p) => /\.(ts|js|mjs|svelte)$/.test(p) && !/\.test\.(ts|js)$/.test(p) && !p.startsWith('tests/'))
    .map((p) => [p, readFileSync(join(ROOT, p), 'utf8')] as [string, string]);
}

/** One premise check per accepted advisory id. */
const PREMISES: Record<string, () => string[]> = {
  // Advisory scope: only apps that enable the experimental remote functions and use form, query or command.
  'GHSA-3r8g-jcqq-3p5j': () => remoteFunctionUse(tree()),
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
    expect(remoteFunctionUse([['packages/web-ui/svelte.config.js', 'export default { kit: { experimental: { remoteFunctions: true } } };']])).toHaveLength(1);
    expect(remoteFunctionUse([['packages/web-ui/src/lib/c.ts', "import { browser } from '$app/environment';"]])).toEqual([]);
  });

  it('the walk reaches the web-ui source and its svelte config', () => {
    const paths = tree().map(([p]) => p);
    expect(paths).toContain('packages/web-ui/svelte.config.js');
    expect(paths.some((p) => p.startsWith('packages/web-ui/src/') && p.endsWith('.svelte'))).toBe(true);
  });
});
