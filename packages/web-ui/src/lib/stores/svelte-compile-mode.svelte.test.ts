import { describe, it, expect } from 'vitest';

// The rune-module tests are meant to see Svelte state as the browser does (see the
// `browser-compile` project in vitest.config.ts). In the browser a `$state` list is a proxy, and
// writes through it do not reach the array it was given; compiled for the server it is that array
// itself. A store test
// run in the wrong mode can pass for code that fails in the browser, so this fails when the mode
// is wrong.
// What a failure here means, said where it is read: the run did not use the browser-compile
// project. The usual cause is a vitest started with a configuration that lacks it.
const WRONG_MODE = 'Svelte was compiled for the server, not the browser: this run did not use the browser-compile project. Run vitest with the repo configuration (vitest.config.ts at the repo root).';

describe('the compile mode of rune-module tests', () => {
	it('is the browser\'s: a `$state` list is a proxy that does not write through to what it was given', () => {
		const raw: Array<{ n: number }> = [{ n: 1 }];
		let list = $state<Array<{ n: number }>>([]);
		list = raw;
		list.push({ n: 2 });
		expect(list, WRONG_MODE).not.toBe(raw);
		expect(raw, WRONG_MODE).toHaveLength(1);
		expect(list).toHaveLength(2);
	});
});
