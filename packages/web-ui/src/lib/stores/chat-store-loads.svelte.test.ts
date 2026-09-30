import { describe, it, expect } from 'vitest';

// The chat store is a Svelte 5 rune module: importing it needs the svelte
// compiler, which the root vitest config now carries. This file is the witness
// that it does — the precondition for testing the store by driving events
// through it instead of matching its source text.
describe('chat store under vitest', () => {
	it('imports and exposes its reactive state', async () => {
		const store = await import('./chat.svelte.js');
		expect(typeof store.getMessages).toBe('function');
		expect(Array.isArray(store.getMessages())).toBe(true);
	});
});
