import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Every in-app navigation target named in ChatView must be a route that exists.
 *
 * A `goto` to a path that does not resolve renders as a control that does nothing — the most
 * expensive kind of UI bug, because it looks like it works. This is caught by reading the
 * routes directory rather than by a browser: the components are not mountable in this suite,
 * and an assertion nobody can run is not a guard.
 */
describe('ChatView navigation targets', () => {
	it('every goto("/app/...") points at a real route directory', () => {
		const src = readFileSync(
			fileURLToPath(new URL('./ChatView.svelte', import.meta.url)),
			'utf-8',
		);
		const targets = [...src.matchAll(/goto\('(\/app\/[^'?]+)/g)].map(m => m[1]!);
		expect(targets.length).toBeGreaterThan(0); // the regex still matches something
		for (const target of targets) {
			const dir = fileURLToPath(new URL(`../../routes${target}`, import.meta.url));
			expect(
				() => readFileSync(`${dir}/+page.svelte`, 'utf-8'),
				`no route for ${target}`,
			).not.toThrow();
		}
	});
});
