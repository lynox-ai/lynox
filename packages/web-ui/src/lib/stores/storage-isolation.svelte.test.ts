import { describe, it, expect, vi, afterEach } from 'vitest';

// A store saves on a debounce. A save still pending when a test ends must not land in the next
// test's storage: the browser-compile project's setup lets it land first, then empties storage.

vi.mock('./toast.svelte.js', () => ({ addToast: () => 1 }));
afterEach(() => { vi.unstubAllGlobals(); });

describe('storage between tests', () => {
	it('a test ends with a save still pending', async () => {
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
		vi.resetModules();
		const store = await import('./chat.svelte.js');
		// No session can be opened: the turn fails and the store schedules a save.
		await store.sendMessage('go');
		expect(localStorage.getItem('lynox-chat')).toBeNull();
	});

	it('the next one does not see it, even after the save would have fired', async () => {
		await new Promise((r) => setTimeout(r, 600));
		expect(localStorage.getItem('lynox-chat')).toBeNull();
	});
});
