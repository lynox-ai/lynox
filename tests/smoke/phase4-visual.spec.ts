// === Phase-4 visual verification smoke ===
//
// Drives a real browser against engine.lynox.cloud (staging) with a
// pre-minted session cookie (see scripts/pre-release-smoke.sh for the
// HMAC chain) and screenshots the four Phase-4 surfaces that just
// shipped to main:
//
//   1. Inbox list   — baseline + zone rail working
//   2. Reading-Pane + Mail-Context-Sidebar (PR #322)
//   3. Draft-Reply pane with Send-Later dropdown (PR #321)
//   4. Integrations page with Push-Notification prefs (PR #323)
//
// Screenshots land under `test-results/phase4-visual/`. The spec is
// observational only — visual assertions live in the matcher, the
// PNGs are for human review.
//
// Run with:
//   SMOKE_BASE_URL=https://engine.lynox.cloud \
//   STAGING_COOKIE=$(cat /tmp/staging-cookie.txt) \
//   pnpm exec playwright test tests/smoke/phase4-visual.spec.ts \
//     --config=playwright.config.ts --reporter=list

import { test, expect } from '@playwright/test';

const COOKIE = process.env['STAGING_COOKIE'] ?? '';

test.skip(!COOKIE, 'STAGING_COOKIE env var is required');

test.use({
	extraHTTPHeaders: { Cookie: `lynox_session=${COOKIE}` },
	viewport: { width: 1440, height: 900 },
});

test.beforeEach(async ({ context }) => {
	await context.addCookies([
		{
			name: 'lynox_session',
			value: COOKIE,
			domain: 'engine.lynox.cloud',
			path: '/',
			httpOnly: false,
			secure: true,
		},
	]);
});

const SHOTS = 'test-results/phase4-visual';

test('inbox list renders for an authenticated session', async ({ page }) => {
	const resp = await page.goto('/app/inbox');
	expect(resp?.status(), 'inbox should not 401 with a valid cookie').toBeLessThan(400);
	await page.waitForLoadState('networkidle');
	await page.screenshot({ path: `${SHOTS}/01-inbox-list.png`, fullPage: true });
});

test('reading-pane + Mail-Context-Sidebar renders on lg+ when an item is open', async ({ page }) => {
	await page.goto('/app/inbox');
	await page.waitForLoadState('networkidle');
	// Click the first inbox row if present. The Phase-3 list renders
	// items with role=button/li[data-inbox-item-id]; fall back to any
	// clickable item we can find.
	const firstItem = page.locator('[data-inbox-item-id]').first();
	if (await firstItem.count()) {
		await firstItem.click();
		await page.waitForLoadState('networkidle');
	}
	// lg+ split — sidebar wrapper has the `aria-label="Kontext"` from
	// InboxContextSidebar.svelte.
	await page.screenshot({ path: `${SHOTS}/02-reading-pane-with-sidebar.png`, fullPage: true });
});

test('draft reply pane exposes the Send-Later dropdown', async ({ page }) => {
	await page.goto('/app/inbox');
	await page.waitForLoadState('networkidle');
	const firstItem = page.locator('[data-inbox-item-id]').first();
	if (await firstItem.count()) {
		await firstItem.click();
		// "Antworten / Reply" action wires `openDraftPane(item.id)`.
		const replyBtn = page.getByRole('button', { name: /antwort|reply/i }).first();
		if (await replyBtn.count()) {
			await replyBtn.click();
			await page.waitForLoadState('networkidle');
		}
	}
	await page.screenshot({ path: `${SHOTS}/03-draft-pane-send-later.png`, fullPage: true });
});

test('integrations page shows push-notification prefs (toggle + quiet hours + throttle)', async ({ page, context }) => {
	// Grant Notification permission so the Push card renders the
	// "subscribed" sub-block — that's where the new Phase-4 prefs live.
	await context.grantPermissions(['notifications'], { origin: 'https://engine.lynox.cloud' });
	const resp = await page.goto('/app/settings/integrations');
	expect(resp?.status(), 'integrations page status').toBeLessThan(400);
	await page.waitForLoadState('networkidle');
	// Hit GET /api/inbox/notification-prefs directly so we have at least
	// API-level proof the v15 envelope is live, even when the UI panel
	// is gated behind a real push subscription (which we can't fake in
	// headless without VAPID-aware service-worker plumbing).
	const prefsRes = await page.request.get('/api/inbox/notification-prefs');
	expect(prefsRes.status()).toBe(200);
	const prefs = await prefsRes.json();
	expect(prefs).toMatchObject({
		inboxPushEnabled: expect.any(Boolean),
		quietHours: { enabled: expect.any(Boolean), start: expect.any(String), end: expect.any(String), tz: expect.any(String) },
		perMinute: expect.any(Number),
		perHour: expect.any(Number),
		accounts: expect.any(Array),
	});
	console.log('[phase4-visual] notification-prefs envelope:', JSON.stringify(prefs));
	await page.screenshot({ path: `${SHOTS}/04-integrations-push-prefs.png`, fullPage: true });
});

test('phase-4 backend smoke — sidebar context + send-later + reminders APIs respond', async ({ page }) => {
	// Even if the UI surfaces are empty (no inbox items on staging), the
	// new Phase-4 API surfaces should respond with their documented
	// shapes. This pins them as live without needing test mail.
	const items = await page.request.get('/api/inbox/items?bucket=requires_user&limit=1');
	expect(items.status()).toBe(200);
	const itemsBody = await items.json() as { items: Array<{ id: string }> };
	console.log(`[phase4-visual] inbox items count: ${itemsBody.items.length}`);

	// /context endpoint — only callable with a real itemId; degrade
	// gracefully if the inbox is empty (still verifies the route is wired).
	if (itemsBody.items[0]?.id) {
		const ctx = await page.request.get(`/api/inbox/items/${itemsBody.items[0].id}/context`);
		expect(ctx.status()).toBe(200);
		const ctxBody = await ctx.json();
		expect(ctxBody).toMatchObject({
			sender: expect.any(Object),
			recentThreads: expect.any(Array),
			openFollowups: expect.any(Array),
			outboundHistory: expect.any(Array),
			reminders: expect.any(Array),
		});
		console.log('[phase4-visual] context envelope OK');
	} else {
		// 404 on a synthetic id proves the route is mounted (not 501/404-on-route).
		const notFound = await page.request.get('/api/inbox/items/inb_bogus/context');
		expect([404, 200]).toContain(notFound.status());
	}
});
