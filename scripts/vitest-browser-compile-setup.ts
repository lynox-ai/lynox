import { beforeEach } from 'vitest';

// The `browser-compile` project runs in jsdom, where localStorage is real and outlives a test.
// Stores save on a 500 ms debounce, through whatever storage is there when the timer fires; a
// store module an earlier test loaded can still have one pending. So: let those land first, then
// start every test with an empty storage.
beforeEach(async () => {
	await new Promise((resolve) => setTimeout(resolve, 700));
	globalThis.localStorage?.clear();
});
