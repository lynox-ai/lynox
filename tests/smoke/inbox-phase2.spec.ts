import { test, expect, type APIRequestContext, type BrowserContext } from '@playwright/test';
import { createHmac } from 'node:crypto';

const SMOKE_SECRET = process.env.SMOKE_HTTP_SECRET ?? 'smoke-test-http-secret-ephemeral';

function mintSessionCookie(secret: string): string {
	const ts = Math.floor(Date.now() / 1000).toString();
	const key = createHmac('sha256', 'lynox-session').update(secret).digest();
	const sig = createHmac('sha256', key).update(ts).digest('hex');
	return `${ts}.${sig}`;
}

async function setAuthCookie(ctx: BrowserContext | APIRequestContext, baseURL: string): Promise<void> {
	const url = new URL(baseURL);
	await ctx.storageState; // typeguard: BrowserContext has addCookies, APIRequestContext does not
	if ('addCookies' in ctx) {
		await ctx.addCookies([{
			name: 'lynox_session',
			value: mintSessionCookie(SMOKE_SECRET),
			domain: url.hostname,
			path: '/',
			httpOnly: false,
			secure: false,
			sameSite: 'Lax',
		}]);
	}
}

test.describe('Unified Inbox Phase 2 smoke', () => {
	test.beforeEach(async ({ context, baseURL }) => {
		await setAuthCookie(context, baseURL ?? 'http://localhost:3333');
	});

	test('GET /api/inbox/counts returns the three-zone shape', async ({ request }) => {
		const res = await request.get('/api/inbox/counts', {
			headers: { Cookie: `lynox_session=${mintSessionCookie(SMOKE_SECRET)}` },
		});
		expect(res.status()).toBe(200);
		const body = await res.json();
		expect(body).toEqual({
			counts: {
				requires_user: expect.any(Number),
				draft_ready: expect.any(Number),
				auto_handled: expect.any(Number),
			},
		});
	});

	test('GET /api/inbox/items?zone=draft_ready returns an items array', async ({ request }) => {
		const cookie = `lynox_session=${mintSessionCookie(SMOKE_SECRET)}`;
		for (const zone of ['requires_user', 'draft_ready', 'auto_handled']) {
			const res = await request.get(`/api/inbox/items?zone=${zone}`, { headers: { Cookie: cookie } });
			expect(res.status(), `zone=${zone}`).toBe(200);
			const body = await res.json();
			expect(Array.isArray(body.items), `zone=${zone} items is array`).toBe(true);
		}
	});

	test('GET /api/inbox/cold-start returns active+recent arrays', async ({ request }) => {
		const res = await request.get('/api/inbox/cold-start', {
			headers: { Cookie: `lynox_session=${mintSessionCookie(SMOKE_SECRET)}` },
		});
		expect(res.status()).toBe(200);
		const body = await res.json();
		expect(Array.isArray(body.active)).toBe(true);
		expect(Array.isArray(body.recent)).toBe(true);
	});

	test('Phase 2 draft endpoints return correct error shapes for missing resources', async ({ request }) => {
		const cookie = `lynox_session=${mintSessionCookie(SMOKE_SECRET)}`;

		const draftGet = await request.get('/api/inbox/items/__missing__/draft', { headers: { Cookie: cookie } });
		expect(draftGet.status()).toBe(404);

		const draftGen = await request.post('/api/inbox/items/__missing__/draft/generate', {
			headers: { Cookie: cookie, 'Content-Type': 'application/json' },
			data: { tone: 'formal' },
		});
		expect(draftGen.status()).toBe(404);

		const draftGenBadTone = await request.post('/api/inbox/items/__missing__/draft/generate', {
			headers: { Cookie: cookie, 'Content-Type': 'application/json' },
			data: { tone: 'flippant' },
		});
		expect(draftGenBadTone.status()).toBe(400);

		const bodyRefresh = await request.post('/api/inbox/items/__missing__/body/refresh', { headers: { Cookie: cookie } });
		expect(bodyRefresh.status()).toBe(404);

		const draftSend = await request.post('/api/inbox/drafts/__missing__/send', {
			headers: { Cookie: cookie, 'Content-Type': 'application/json' },
			data: {},
		});
		expect(draftSend.status()).toBe(404);

		const rulesNoAccount = await request.post('/api/inbox/rules', {
			headers: { Cookie: cookie, 'Content-Type': 'application/json' },
			data: {},
		});
		expect(rulesNoAccount.status()).toBe(400);
	});

	test('/app/inbox route renders the zone-tab shell without JS errors', async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
		page.on('console', (msg) => {
			if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
		});

		const res = await page.goto('/app/inbox');
		expect(res?.status(), 'GET /app/inbox should return 200').toBe(200);
		await page.waitForLoadState('networkidle');

		// Three zone tabs from InboxView.svelte (role="tablist" with three role="tab")
		const tablist = page.getByRole('tablist').first();
		await expect(tablist).toBeVisible();
		const tabs = page.getByRole('tab');
		await expect(tabs).toHaveCount(3);

		expect(errors, `unexpected JS errors:\n${errors.join('\n')}`).toEqual([]);
	});

	test('/app/inbox/rules renders without JS errors', async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
		page.on('console', (msg) => {
			if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
		});

		const res = await page.goto('/app/inbox/rules');
		expect(res?.status(), 'GET /app/inbox/rules should return 200').toBe(200);
		await page.waitForLoadState('networkidle');

		expect(errors, `unexpected JS errors:\n${errors.join('\n')}`).toEqual([]);
	});
});
