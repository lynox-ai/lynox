import { test, expect, type Page } from '@playwright/test';
import { createHmac } from 'node:crypto';

/**
 * The composer must stay at the bottom of the chat, whatever state the column
 * is in.
 *
 * The bug (reported 2026-08-08 from an iPhone PWA and a Windows PC during a
 * live workflow run): the composer leaves the bottom of the screen, whitespace
 * opens below it, and the view can be dragged further up.
 *
 * Ground truth, re-measured 2026-08-09 against a dev build with a REAL
 * 37-message thread: a long transcript alone does NOT overflow the column —
 * the transcript pane is shrinkable (`flex-1 min-h-0`) and scrolls internally.
 * What overflows the column is the NON-TRANSCRIPT stack between transcript and
 * composer (ChangesetReview, batch prompts, permission dialogs, pipeline
 * progress): those blocks had `min-height: auto`, so a tall one pushed the
 * whole column taller than AppShell's slot, the slot's own scroller engaged,
 * and the composer rode out of the viewport — exactly the state a running
 * workflow (Roland's bexio test) produces.
 *
 * This is a browser test rather than a source-level guard because the defect
 * is a LAYOUT one, and the first attempt at guarding it in source was theatre:
 * it asserted class strings, which stays green when the ternary arms are
 * swapped. A measured `boundingBox().y` cannot be satisfied that way. Note
 * also that `element.scrollTop = n` does NOT model a user gesture —
 * programmatic scrolling ignores `overflow`, so only `page.mouse.wheel` can
 * tell a fixed shell from a broken one.
 */

// Same session-mint idiom as lifecycle.spec / inbox-phase2.spec: the smoke
// stack requires the auth cookie or /app renders the login page (no textarea,
// no transcript — every assertion below would fail for the wrong reason).
const SMOKE_SECRET = process.env['SMOKE_HTTP_SECRET'] ?? 'smoke-test-http-secret-ephemeral';

function mintSessionCookie(secret: string): string {
	const ts = Math.floor(Date.now() / 1000).toString();
	const key = createHmac('sha256', 'lynox-session').update(secret).digest();
	return `${ts}.${createHmac('sha256', key).update(ts).digest('hex')}`;
}

async function authenticate(page: Page): Promise<void> {
	await page.goto('/login');
	const origin = new URL(page.url()).origin;
	await page.context().addCookies([{
		name: 'lynox_session',
		value: mintSessionCookie(SMOKE_SECRET),
		url: origin,
		httpOnly: true,
		secure: origin.startsWith('https'),
		sameSite: 'Lax',
	}]);
}

/** Models the real overflow driver: a tall block in the non-transcript stack
 *  (a ChangesetReview with a long file list easily reaches this on a phone). */
const TALL_SIBLING_PX = 1200;

async function injectTallStackBlock(page: import('@playwright/test').Page, px: number = TALL_SIBLING_PX): Promise<void> {
	await page.evaluate((px) => {
		const composerRow = document.querySelector('textarea')?.closest('div.border-t');
		if (!composerRow || !composerRow.parentElement) throw new Error('composer row not found');
		const block = document.createElement('div');
		block.style.minHeight = `${px}px`;
		block.className = 'border-t border-border bg-bg-subtle px-4 py-3';
		block.textContent = 'simulated changeset review block';
		// Into the column stack, directly above the composer — the position
		// ChangesetReview renders at. The wrapper the fix adds must contain it.
		const stack = document.querySelector('[data-chat-stack]');
		(stack ?? composerRow.parentElement).insertBefore(block, stack ? null : composerRow);
	}, px);
}

test.describe('composer stays pinned', () => {
	test.beforeEach(async ({ page }) => { await authenticate(page); });

	test('a tall non-transcript block does not push the composer off-screen', async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto('/app');
		await page.waitForLoadState('networkidle');

		const composer = page.locator('textarea').first();
		await expect(composer).toBeVisible();

		await injectTallStackBlock(page);
		await page.waitForTimeout(300);

		// The column must absorb the tall block (the stack shrinks + scrolls);
		// pre-fix the block pushes the composer below the viewport.
		const box = (await composer.boundingBox())!;
		const viewport = page.viewportSize()!;
		expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);

		// And the transcript must NOT have been collapsed to nothing to pay for
		// it (the cap on the stack is what guarantees this).
		const transcriptHeight = await page.evaluate(() => {
			const pane = document.querySelector('[class*="overflow-y-auto"][class*="py-6"]');
			return pane ? pane.clientHeight : 0;
		});
		expect(transcriptHeight).toBeGreaterThan(100);
	});

	// NOTE deliberately ABSENT: a "wheel gesture over the composer doesn't move
	// it" test. Measured 2026-08-09: in headless Chromium NO wheel position
	// scrolls the outer slot pre-fix (composer y stays put at every probe), so
	// such a test cannot fail and would be theatre. The off-screen assertion
	// above is the gate that discriminates — verified failing pre-fix, green
	// post-fix.

	test('the transcript itself still scrolls', async ({ page }) => {
		// The contrast that stops the fix from being "nothing scrolls any more".
		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto('/app');
		await page.waitForLoadState('networkidle');

		const scrolled = await page.evaluate(() => {
			const pane = document.querySelector('[class*="overflow-y-auto"][class*="py-6"]');
			if (!pane) throw new Error('transcript pane not found');
			// Append to the PANE, not its first child — in the empty state the
			// first child is a centered h-full box whose height doesn't grow.
			for (let i = 0; i < 12; i++) {
				const d = document.createElement('div');
				d.style.minHeight = '320px';
				pane.appendChild(d);
			}
			pane.scrollTop = 200;
			// scrollTop succeeds on overflow:hidden too (programmatic scrolling
			// ignores overflow), so assert the pane is genuinely USER-scrollable.
			return { top: pane.scrollTop, overflowY: getComputedStyle(pane).overflowY };
		});

		expect(scrolled.top).toBeGreaterThan(0);
		expect(scrolled.overflowY).toBe('auto');
	});

	test('the stack block itself stays reachable (scrollable), not clipped away', async ({ page }) => {
		// The blocker that killed the first fix: slot-level overflow-hidden made
		// a tall ChangesetReview UNREACHABLE. The stack must scroll internally.
		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto('/app');
		await page.waitForLoadState('networkidle');
		await injectTallStackBlock(page);
		await page.waitForTimeout(300);

		const reachable = await page.evaluate(() => {
			const block = [...document.querySelectorAll('div')].find(d => d.textContent === 'simulated changeset review block');
			if (!block) return 'block gone';
			// Reachable = every pixel of the block can be brought into view by
			// scrolling SOME ancestor scroller (not the window/outer slot).
			let el: HTMLElement | null = block;
			while (el && el !== document.body) {
				const cs = getComputedStyle(el);
				if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 2) return 'scrollable-ancestor';
				el = el.parentElement;
			}
			// No scrollable ancestor is fine ONLY if the block is fully visible.
			const r = block.getBoundingClientRect();
			return r.top >= 0 && r.bottom <= window.innerHeight ? 'fully-visible' : 'clipped';
		});

		expect(['scrollable-ancestor', 'fully-visible']).toContain(reachable);
	});

	test('a document-shaped route keeps its own scroller', async ({ page }) => {
		// The fix is scoped to the chat column. Settings is long-form and must
		// still scroll.
		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto('/app/settings');
		await page.waitForLoadState('networkidle');

		const canScroll = await page.evaluate(() => {
			const els = [...document.querySelectorAll('div')];
			return els.some((e) => {
				const cs = getComputedStyle(e);
				return (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && e.scrollHeight > e.clientHeight + 2;
			});
		});

		expect(canScroll).toBe(true);
	});
});
