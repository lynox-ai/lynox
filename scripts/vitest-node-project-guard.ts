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
 * For the `node` test project: refuse to load a Svelte module. There it would compile for the
 * server, where Svelte state behaves differently from the browser, and the test would pass for
 * the wrong reason. Keyed on what is loaded, so it also catches a Svelte module reached through
 * a helper; a type-only import is erased before anything loads and is not affected.
 */
export function rejectSvelteModules(): Plugin {
  return {
    name: 'reject-svelte-modules-in-node-project',
    enforce: 'pre',
    load(id) {
      if (!isSvelteModuleId(id)) return null;
      throw new Error(
        `${id} is a Svelte module, loaded by a test in the node project, where it would be compiled ` +
        'for the server rather than as the browser runs it. Name the test `*.svelte.test.ts` so it ' +
        'runs in the browser-compile project (see vitest.config.ts).',
      );
    },
  };
}
