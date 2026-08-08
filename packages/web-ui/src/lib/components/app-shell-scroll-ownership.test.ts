import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Guard: the chat route must own its scrolling alone.
 *
 * The bug (reported 2026-08-08 from an iPhone PWA and a Windows PC): with a
 * long thread the composer leaves the bottom of the screen, whitespace opens
 * below it, and the view can be dragged further up.
 *
 * The chat view is a fixed-height app surface — the transcript pane scrolls and
 * the composer is pinned under it. AppShell's content slot wrapped that column
 * in a SECOND scroller, so a wheel or touch anywhere (including over the
 * composer) scrolled the outer one and carried the whole column up. Measured on
 * a 37-message thread: one gesture over the composer moved its bottom edge from
 * 816 to 216, a second to -384; forcing the slot to `overflow-hidden` kept it
 * at 816.
 *
 * Every other route is document-shaped and must keep its scroller, so the fix
 * is scoped and this guard has to check the scoping, not just the class.
 *
 * Source-level for the same reason as `chat-detach-reset.test.ts`: the
 * component needs a svelte plugin the root vitest config does not carry. It
 * would not help anyway — jsdom does no layout, so the overflow would never
 * materialise. The causal check is the browser measurement above.
 */
const SRC = readFileSync(
	fileURLToPath(new URL('./AppShell.svelte', import.meta.url)),
	'utf-8',
);

describe('AppShell content slot scroll ownership', () => {
	it('does not scroll on the chat route, and still scrolls elsewhere', () => {
		const slot = SRC.split('\n').find(l => l.includes('{@render children()}') === false && l.includes('flex-1 min-w-0') && l.includes('scrollbar-none'));
		expect(slot, 'content slot not found — has its class list changed?').toBeDefined();
		// Both arms, so the fix cannot be "hidden everywhere" (which would break
		// settings) nor silently revert to always-auto.
		expect(slot!).toContain('overflow-hidden');
		expect(slot!).toContain('overflow-y-auto');
		expect(slot!).toContain('isChatRoute');
	});

	it('isChatRoute is derived from the route, not a mutable flag', () => {
		const line = SRC.split('\n').find(l => l.includes('const isChatRoute'));
		expect(line, 'isChatRoute not found').toBeDefined();
		expect(line!).toContain('$derived');
		expect(line!).toContain('pathname');
	});
});
