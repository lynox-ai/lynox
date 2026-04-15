import { test, expect } from '@playwright/test';

// Local pre-release smoke test.
// Runs against a freshly built docker-compose.smoke.yml stack on :3333.
// Goal: catch "the build is completely broken" — not full feature coverage.
// Extended flows (chat send, thread resume, KG browse) are deliberately out
// of scope; those belong in a full e2e suite once we have one.

test.describe('lynox smoke', () => {
  test('health endpoint returns 200', async ({ request }) => {
    const res = await request.get('/api/health');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toBeTruthy();
  });

  test('homepage renders without JS errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
    });

    const response = await page.goto('/');
    expect(response?.status(), 'GET / should return 200').toBe(200);

    await page.waitForLoadState('networkidle');

    // Title sanity — SvelteKit sets this from app.html / +layout.svelte
    await expect(page).toHaveTitle(/lynox/i);

    // No uncaught errors on initial paint
    expect(errors, `unexpected console/page errors:\n${errors.join('\n')}`).toEqual([]);
  });

  test('primary shell is reachable', async ({ page }) => {
    await page.goto('/');
    // AppShell always renders, even when no credentials are set.
    // We don't assert specific copy to avoid coupling to i18n — just that
    // SvelteKit hydrated some main content.
    await expect(page.locator('main, [role="main"], #app, body')).toBeVisible();
  });
});
