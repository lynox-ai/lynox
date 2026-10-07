import { describe, it, expect } from 'vitest';
import { asksForSourceOrUrl, isSvelteModuleId } from '../scripts/vitest-node-project-guard.js';

// This file runs in the node project. A test there that loads a Svelte module would see Svelte
// compiled for the server, not as the browser runs it, so the node project refuses to load one.

describe('a test in the node project', () => {
	it('cannot load a Svelte rune module: the load fails and names the fix', async () => {
		// The fix it names must be one that works: only tests under a package's src/ run in the
		// browser-compile project, so a `*.svelte.test.ts` at the repo root would not.
		await expect(import('../packages/web-ui/src/lib/stores/toast.svelte.js')).rejects.toThrow(
			'packages/<package>/src/**/*.svelte.test.ts',
		);
	});

	it('cannot reach one through a helper either', async () => {
		// The helper is a plain module that imports a store at runtime.
		await expect(import('./fixtures/imports-a-svelte-store.js')).rejects.toThrow(/svelte\.test\.ts/);
	});

	it('can still read a Svelte file\'s text: that compiles nothing', async () => {
		const source = await import('../packages/web-ui/src/lib/stores/toast.svelte.ts?raw');
		expect(typeof source.default).toBe('string');
		expect(source.default).toContain('addToast');
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

describe('which imports ask for a file\'s text or URL rather than its module', () => {
	it('?raw and ?url, alone or among other parameters', () => {
		for (const id of ['/a/chat.svelte.ts?raw', '/a/chat.svelte.ts?url', '/a/chat.svelte.ts?v=1&raw', '/a/chat.svelte.ts?url&v=1']) {
			expect(asksForSourceOrUrl(id), id).toBe(true);
		}
	});

	it('not a module import that only carries a version or a look-alike name', () => {
		for (const id of ['/a/chat.svelte.ts', '/a/chat.svelte.ts?v=123', '/a/chat.svelte.ts?rawish', '/a/raw.svelte.ts', '/a/chat.svelte.ts?curl']) {
			expect(asksForSourceOrUrl(id), id).toBe(false);
		}
	});
});
