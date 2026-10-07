import { describe, it, expect } from 'vitest';
import { isSvelteModuleId } from '../scripts/vitest-node-project-guard.js';

// This file runs in the node project. A test there that loads a Svelte module would see Svelte
// compiled for the server, not as the browser runs it, so the node project refuses to load one.

describe('a test in the node project', () => {
	it('cannot load a Svelte rune module: the load fails and names the fix', async () => {
		await expect(import('../packages/web-ui/src/lib/stores/toast.svelte.js')).rejects.toThrow(/svelte\.test\.ts/);
	});

	it('cannot reach one through a helper either', async () => {
		// The helper is a plain module that imports a store at runtime.
		await expect(import('./fixtures/imports-a-svelte-store.js')).rejects.toThrow(/svelte\.test\.ts/);
	});
});

describe('what counts as a Svelte module', () => {
	it('components and rune modules, with or without a query', () => {
		for (const id of ['/a/Button.svelte', '/a/chat.svelte.ts', '/a/chat.svelte.js', '/a/chat.svelte.ts?v=123', '/a/x.svelte.mjs']) {
			expect(isSvelteModuleId(id), id).toBe(true);
		}
	});

	it('not a module that merely mentions svelte in its name or path', () => {
		for (const id of ['/a/svelte-helpers.ts', '/a/svelte/index.ts', '/a/chat.svelte-like.ts', '/node_modules/svelte/internal/server/index.js']) {
			expect(isSvelteModuleId(id), id).toBe(false);
		}
	});
});
