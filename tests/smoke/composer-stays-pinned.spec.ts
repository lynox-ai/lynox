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
			return {
				top: pane.scrollTop,
				overflowY: getComputedStyle(pane).overflowY,
				overscrollY: getComputedStyle(pane).overscrollBehaviorY,
			};
		});

		expect(scrolled.top).toBeGreaterThan(0);
		expect(scrolled.overflowY).toBe('auto');
		// Overscroll at the transcript's ends must not chain into ancestors —
		// chaining is the touch-gesture path by which a swipe on the chat used
		// to move the shell around the pinned composer on iOS. Headless
		// Chromium cannot perform the chaining gesture itself, so this pins the
		// computed style (the whole behavior surface CSS controls here).
		expect(scrolled.overscrollY).toBe('contain');
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

	// ── iOS scroll-displacement class (reported again 2026-09-06) ─────────
	// On an iPhone the composer could be dragged upward, opening whitespace
	// between it and the status bar — while a drag on the status bar moved
	// nothing. The asymmetry is structural: the status bar has NO scrollable
	// ancestor (every box from it to <html> is overflow hidden/clip), while
	// the composer had exactly one — AppShell's page slot (`overflow-y-auto`).
	// The fix removes that scroller on pages that own their scrolling
	// (ChatView declares `data-owns-scroll`; the slot flips to `overflow:
	// clip` via app.css) and converts the shell's structural containers from
	// `hidden` to `clip`, because iOS WebKit will also scroll an
	// overflow:HIDDEN ancestor programmatically to reveal a focused input —
	// `clip` is the only overflow value that refuses scrolling from everyone.
	//
	// LIMIT, stated plainly: headless Chromium has no visual viewport
	// dynamics, no on-screen keyboard, and (measured 2026-08-09, note above)
	// no wheel path that scrolls the slot. These tests therefore verify that
	// the DISPLACEMENT TARGET IS GONE — no ancestor of the composer accepts a
	// scroll, by gesture or by code — not that an iPhone stops exhibiting the
	// symptom. That verification only exists on a real device.

	/** Force real overflow into the shell slot, try to scroll it, restore.
	 *  The forced overflow is the point: without it scrollTop clamps to 0
	 *  under EVERY overflow value and the probe cannot discriminate clip
	 *  from auto/hidden (programmatic scroll works on hidden AND auto). */
	async function probeSlotScroll(page: Page, px: number): Promise<{ moved: number; overflowY: string }> {
		return await page.evaluate((px) => {
			const slot = document.querySelector('[data-app-shell-slot]') as HTMLElement | null;
			if (!slot) throw new Error('page slot not found');
			const tall = document.createElement('div');
			tall.style.minHeight = '4000px';
			slot.appendChild(tall);
			slot.scrollTop = px;
			const moved = slot.scrollTop;
			const overflowY = getComputedStyle(slot).overflowY;
			tall.remove();
			slot.scrollTop = 0;
			return { moved, overflowY };
		}, px);
	}

	test('the shell slot is not a scroll container on the chat route', async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto('/app');
		await page.waitForLoadState('networkidle');
		await expect(page.locator('textarea').first()).toBeVisible();

		const probe = await probeSlotScroll(page, 200);

		// `clip` — not `auto` (the pre-fix scroller the iPhone drag engaged)
		// and not `hidden` (still a scroll container; the scrollTop write
		// above would stick on it).
		expect(probe.overflowY).toBe('clip');
		expect(probe.moved).toBe(0);
	});

	test('the inbox slot is not a scroll container either', async ({ page }) => {
		// Same defect class, second member: InboxTriagePane pins the triage
		// footer to the bottom edge, so InboxView also declares
		// `data-owns-scroll` (its list/reading/triage panes self-scroll).
		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto('/app/inbox');
		await page.waitForLoadState('networkidle');

		const probe = await probeSlotScroll(page, 200);
		expect(probe.overflowY).toBe('clip');
		expect(probe.moved).toBe(0);
	});

	test('no shell ancestor of the composer accepts scroll displacement', async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto('/app');
		await page.waitForLoadState('networkidle');
		await expect(page.locator('textarea').first()).toBeVisible();

		const results = await page.evaluate(() => {
			const textarea = document.querySelector('textarea');
			if (!textarea) throw new Error('composer textarea not found');
			const out: Array<{ tag: string; overflowY: string; userScrollable: boolean; displaced: number }> = [];
			// Walk the REAL ancestor chain of the FOCUSED ELEMENT (the textarea
			// — iOS keyboard-avoidance scrolls ancestors of the focused input,
			// nearest first) up to <body>. body itself is excluded: its only
			// in-flow child is the fixed shell, which never contributes scroll
			// height — an assumption, not a guarantee; if body ever gains an
			// in-flow child this walk must extend to it. For each ancestor,
			// force overflow and try to displace it the way keyboard-avoidance
			// does — programmatically. Every box on this chain exists to clip,
			// never to scroll; any one that moves is the whitespace bug's next
			// home.
			let el: HTMLElement | null = textarea.parentElement;
			while (el && el !== document.body) {
				const cs = getComputedStyle(el);
				const tall = document.createElement('div');
				tall.style.minHeight = '4000px';
				el.appendChild(tall);
				el.scrollTop = 100;
				const displaced = el.scrollTop;
				tall.remove();
				el.scrollTop = 0;
				out.push({
					// getAttribute, not className: className is SVGAnimatedString
					// on SVG elements and .split would turn a real regression
					// into an opaque TypeError. Keep enough classes to tell
					// look-alike DIVs apart in the failure message.
					tag: el.tagName + '.' + (el.getAttribute('class') ?? '').split(' ').slice(0, 3).join('.'),
					overflowY: cs.overflowY,
					userScrollable: cs.overflowY === 'auto' || cs.overflowY === 'scroll',
					displaced,
				});
				el = el.parentElement;
			}
			return out;
		});

		for (const r of results) {
			// No user-scrollable ancestor: the drag gesture has no target.
			expect(r.userScrollable, `${r.tag} is user-scrollable`).toBe(false);
			// No programmatically scrollable ancestor either: WebKit's
			// keyboard-avoidance has no target. This is what kills a revert of
			// any single overflow-clip-safe back to overflow-hidden.
			expect(r.displaced, `${r.tag} accepted scrollTop`).toBe(0);
		}
		// Identity check, not just cardinality: the chain must actually contain
		// the protective clip boxes (textarea wrapper, slot, inner row, main,
		// right column, body row, shell root = 7). A refactor that reverts or
		// merges one away shrinks this count and fails here even though the
		// per-element asserts above cannot see a box that left the chain.
		const clipCount = results.filter((r) => r.overflowY === 'clip').length;
		expect(clipCount, `clip boxes in chain: ${results.map((r) => r.tag).join(' > ')}`).toBeGreaterThanOrEqual(7);

		// Past the last inner scroller the chain ends at the document, which
		// must refuse to rubber-band. html and body each declare
		// `overscroll-behavior: none` — independently, not redundantly:
		// body->viewport propagation only applies while html computes `auto`.
		// Computed style is the surface CSS controls here; the bounce itself
		// only exists on a touch device.
		const rootOverscroll = await page.evaluate(() => [
			getComputedStyle(document.documentElement).overscrollBehaviorY,
			getComputedStyle(document.body).overscrollBehaviorY,
		]);
		expect(rootOverscroll).toEqual(['none', 'none']);
	});

	test('the shell slot still scrolls a document-shaped route', async ({ page }) => {
		// The counter-direction: the :has(> [data-owns-scroll]) switch must not
		// clip pages that RELY on the slot (SettingsIndex renders plain
		// content and owns no scroller). Kills the "clip the slot everywhere"
		// mutation that the generic some-div-scrolls test above would survive.
		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto('/app/settings');
		await page.waitForLoadState('networkidle');

		const probe = await probeSlotScroll(page, 150);

		expect(probe.overflowY).toBe('auto');
		expect(probe.moved).toBeGreaterThan(0);
	});
});
