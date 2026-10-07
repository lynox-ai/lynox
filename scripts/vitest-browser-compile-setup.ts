import { beforeEach } from 'vitest';

// The `browser-compile` project runs in jsdom, where localStorage is real and outlives a test.
// Stores save on a 500 ms debounce, through whatever storage is there when the timer fires; a
// store module an earlier test loaded can still have one pending. So: wait past that debounce,
// then start every test with an empty storage. This covers a save already scheduled when the
// earlier test ended; a chain that schedules its save later (a retry that fails, then saves) can
// still land in a later test.
beforeEach(async () => {
	await new Promise((resolve) => setTimeout(resolve, 700));
	globalThis.localStorage?.clear();
});
