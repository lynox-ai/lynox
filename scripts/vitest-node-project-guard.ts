import type { Plugin } from 'vite';

/**
 * Whether a module id is one the svelte compiler would transform: a component (`.svelte`) or a
 * rune module (`.svelte.ts` / `.svelte.js`). Query and hash suffixes vite appends are ignored.
 */
export function isSvelteModuleId(id: string): boolean {
  const path = id.split(/[?#]/, 1)[0] ?? '';
  return /\.svelte(\.[cm]?[jt]s)?$/.test(path);
}

/** Imports that ask for a file's text or URL, not its module: nothing is compiled for them. */
export function asksForSourceOrUrl(id: string): boolean {
  const query = id.split('?')[1] ?? '';
  return /(^|&)(raw|url)(&|=|$)/.test(query);
}

/**
 * For the `node` test project: refuse to load a Svelte module. There it would compile for the
 * server, where Svelte state behaves differently from the browser, and the test would pass for
 * the wrong reason. Keyed on what is loaded, so it also catches a Svelte module reached through
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
        `${id} is a Svelte module, loaded by a test in the node project, where it would be compiled ` +
        'for the server rather than as the browser runs it. A test that drives a Svelte module ' +
        'belongs in its package, as `packages/<package>/src/**/*.svelte.test.ts`: those run in the ' +
        'browser-compile project (see vitest.config.ts).',
      );
    },
  };
}
