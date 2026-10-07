import { beforeEach } from 'vitest';

// The `browser-compile` project runs in jsdom, where localStorage is real and outlives a test.
// A store that saved in one test must not hand its state to the next: every test starts empty.
beforeEach(() => {
	globalThis.localStorage?.clear();
});
