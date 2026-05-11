import { test, expect } from '@playwright/test';
import { createHmac } from 'node:crypto';

const SMOKE_SECRET = process.env.SMOKE_HTTP_SECRET ?? 'smoke-test-http-secret-ephemeral';

function mintSessionCookie(secret: string): string {
  const ts = Math.floor(Date.now() / 1000).toString();
  const key = createHmac('sha256', 'lynox-session').update(secret).digest();
  const sig = createHmac('sha256', key).update(ts).digest('hex');
  return `${ts}.${sig}`;
}

test.describe('Unified Inbox Phase 2 smoke', () => {
  // One cookie per worker is plenty — the HMAC has a 7-day TTL on the server
  // and a smoke run takes seconds.
  const COOKIE_VALUE = mintSessionCookie(SMOKE_SECRET);

  test.beforeEach(async ({ context, baseURL }) => {
    const host = new URL(baseURL ?? 'http://localhost:3333').hostname;
    await context.addCookies([{
      name: 'lynox_session',
      value: COOKIE_VALUE,
      domain: host,
      path: '/',
      httpOnly: false,
      secure: false,
      sameSite: 'Lax',
    }]);
  });

  test('GET /api/inbox/counts returns the three-zone shape', async ({ request }) => {
    const res = await request.get('/api/inbox/counts');
    expect(res.status()).toBe(200);
    const body = (await res.json()) as unknown;
    expect(body).toEqual({
      counts: {
        requires_user: expect.any(Number),
        draft_ready: expect.any(Number),
        auto_handled: expect.any(Number),
      },
    });
  });

  test('GET /api/inbox/items returns an array for each zone', async ({ request }) => {
    for (const zone of ['requires_user', 'draft_ready', 'auto_handled']) {
      const res = await request.get(`/api/inbox/items?zone=${zone}`);
      expect(res.status(), `zone=${zone}`).toBe(200);
      const body = (await res.json()) as { items?: unknown };
      expect(Array.isArray(body.items), `zone=${zone} items is array`).toBe(true);
    }
  });

  test('GET /api/inbox/cold-start returns active+recent arrays', async ({ request }) => {
    const res = await request.get('/api/inbox/cold-start');
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { active?: unknown; recent?: unknown };
    expect(Array.isArray(body.active)).toBe(true);
    expect(Array.isArray(body.recent)).toBe(true);
  });

  test('Phase 2 draft endpoints return correct error shapes for missing resources', async ({ request }) => {
    const draftGet = await request.get('/api/inbox/items/__missing__/draft');
    expect(draftGet.status()).toBe(404);

    const draftGen = await request.post('/api/inbox/items/__missing__/draft/generate', {
      data: { tone: 'formal' },
    });
    expect(draftGen.status()).toBe(404);

    const draftGenBadTone = await request.post('/api/inbox/items/__missing__/draft/generate', {
      data: { tone: 'flippant' },
    });
    expect(draftGenBadTone.status()).toBe(400);
    const badToneBody = (await draftGenBadTone.json()) as { error?: string };
    expect(badToneBody.error ?? '').toMatch(/tone/i);

    const bodyRefresh = await request.post('/api/inbox/items/__missing__/body/refresh');
    expect(bodyRefresh.status()).toBe(404);

    const draftSend = await request.post('/api/inbox/drafts/__missing__/send', { data: {} });
    expect(draftSend.status()).toBe(404);

    const rulesNoAccount = await request.post('/api/inbox/rules', { data: {} });
    expect(rulesNoAccount.status()).toBe(400);
    const rulesBody = (await rulesNoAccount.json()) as { error?: string };
    expect(rulesBody.error ?? '').toMatch(/accountId/i);
  });

  test('/app/inbox route renders the zone-tab shell without JS errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
    });

    const res = await page.goto('/app/inbox');
    expect(res?.status(), 'GET /app/inbox should return 200').toBe(200);

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
    // Anchor on a stable selector that always renders, even when no rules exist.
    await expect(page.locator('main, [role="main"], body')).toBeVisible();

    expect(errors, `unexpected JS errors:\n${errors.join('\n')}`).toEqual([]);
  });
});
