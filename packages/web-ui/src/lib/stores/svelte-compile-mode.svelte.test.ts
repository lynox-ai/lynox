import { describe, it, expect } from 'vitest';

// The rune-module tests are meant to see Svelte state as the browser does (see the
// `browser-compile` project in vitest.config.ts). In the browser a `$state` list is a proxy, and
// writes through it do not reach the array it was given; compiled for the server it is that array
// itself. A store test
// run in the wrong mode can pass for code that fails in the browser, so this fails when the mode
// is wrong.
describe('the compile mode of rune-module tests', () => {
	it('is the browser\'s: a `$state` list is a proxy that does not write through to what it was given', () => {
		const raw: Array<{ n: number }> = [{ n: 1 }];
		let list = $state<Array<{ n: number }>>([]);
		list = raw;
		list.push({ n: 2 });
		expect(list).not.toBe(raw);
		expect(raw).toHaveLength(1);
		expect(list).toHaveLength(2);
	});
});
