import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
// Imported by name, exactly as a component imports it.
import { untrack } from 'svelte';

// A component imports `svelte` by name. In the browser that name resolves to svelte's client
// build; resolved without the `browser` condition it is the server build, where `untrack` only
// calls its function, so a read inside it is still tracked and an effect that relies on it runs
// again. Both tests fail when the browser-compile project resolves `svelte` for
// the server.
const CLIENT_ENTRY = join(dirname(createRequire(import.meta.url).resolve('svelte/package.json')), 'src/index-client.js');

const WRONG_BUILD = 'the name `svelte` resolved to the server build: the browser-compile project must resolve it with the `browser` condition (vitest.config.ts).';

describe('svelte imported by name in a browser-compile test', () => {
	it('is the client build: the same `untrack` as svelte\'s client entry', async () => {
		const client = (await import(pathToFileURL(CLIENT_ENTRY).href)) as typeof import('svelte');
		expect(untrack, WRONG_BUILD).toBe(client.untrack);
	});

	it('does not track a read inside `untrack`', async () => {
		// flushSync from the client entry by path, so the effect is flushed whatever `svelte` resolves to.
		const { flushSync } = (await import(pathToFileURL(CLIENT_ENTRY).href)) as typeof import('svelte');
		let tracked = $state(0);
		let untracked = $state(0);
		let runs = 0;
		const stop = $effect.root(() => {
			$effect(() => {
				void tracked;
				untrack(() => untracked);
				runs++;
			});
		});
		try {
			flushSync();
			expect(runs).toBe(1);

			untracked = 1;
			flushSync();
			expect(runs, WRONG_BUILD).toBe(1);

			// Positive control: a tracked read does run the effect again, so the effect is live.
			tracked = 1;
			flushSync();
			expect(runs).toBe(2);
		} finally {
			stop();
		}
	});
});
