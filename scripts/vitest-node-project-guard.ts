import type { Plugin } from 'vite';

/**
 * Whether a module id is one the svelte compiler would transform: a component (`.svelte`) or a
 * rune module (`.svelte.ts` / `.svelte.js`). Query and hash suffixes vite appends are ignored.
 */
export function isSvelteModuleId(id: string): boolean {
  const path = id.split(/[?#]/, 1)[0] ?? '';
  return /\.svelte(\.[cm]?[jt]s)?$/.test(path);
}

/**
 * Imports that ask for a file's text or URL, not its module: nothing of the file runs for them.
 * Only a bare `raw` or `url` parameter counts — vite runs the module for `?raw=1` or `?raw?x` —
 * and anything this does not recognise is treated as a module import, so it is refused.
 */
export function asksForSourceOrUrl(id: string): boolean {
  const [, query, ...more] = id.split('?');
  if (query === undefined || more.length > 0) return false;
  return query.split('&').some((param) => param === 'raw' || param === 'url');
}

/**
 * For the `node` test project: refuse to load a Svelte module. That project runs no Svelte
 * compiler, so the module would not run as the browser runs it, and a test that happens to load
 * it anyway would pass for the wrong reason. Keyed on what is loaded, so it also catches a Svelte module reached through
 * a helper; a type-only import is erased before anything loads and is not affected, and an
 * import of the file's text (`?raw`) or URL (`?url`) compiles nothing and is let through.
 */
export function rejectSvelteModules(): Plugin {
  return {
    name: 'reject-svelte-modules-in-node-project',
    enforce: 'pre',
    load(id) {
      if (!isSvelteModuleId(id) || asksForSourceOrUrl(id)) return null;
      throw new Error(
        `${id} is a Svelte module, loaded by a test in the node project. That project runs no ` +
        'Svelte compiler, so the module would not run as the browser runs it. A test that drives a Svelte module ' +
        'belongs in its package, as `packages/<package>/src/**/*.svelte.test.ts`: those run in the ' +
        'browser-compile project (see vitest.config.ts).',
      );
    },
  };
}
