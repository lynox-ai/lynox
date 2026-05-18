/**
 * Manual e2e for the v29 secret-outcome refactor (run against engine.lynox.cloud).
 *
 * This is NOT wired into CI — invoke via:
 *
 *   STAGING_COOKIE=$(bash scripts/mint-staging-cookie.sh) \
 *   SMOKE_BASE_URL=https://engine.lynox.cloud \
 *   pnpm exec playwright test tests/smoke/secret-outcome-staging.spec.ts \
 *     --project=chromium --reporter=list
 *
 * Env var names match the sibling smoke specs (phase4-visual.spec.ts) and
 * scripts/mint-staging-cookie.sh — keep aligned to avoid the third name
 * drift this comment exists to prevent.
 *
 * What it verifies:
 *   1. The app actually loads under cookie auth on staging.
 *   2. The vault PUT correctly returns 403 for a non-allowlisted secret
 *      name on managed-tier (this is the precondition for the whole bug
 *      this PR fixes; if it stops returning 403, the new outcome wire
 *      becomes unreachable and the test should fail loudly).
 *   3. /secret-saved accepts the new `status` field shape end-to-end.
 *   4. /secret-saved without a pending prompt returns a structured 404
 *      (no leak of internal state).
 *
 * Why this exists separately from tests/smoke/*.spec.ts: those are
 * unauthenticated public-route smokes invoked by CI. This file needs
 * an admin-minted cookie and must NEVER run in public CI.
 */

import { test, expect } from '@playwright/test';

const STAGING = process.env['SMOKE_BASE_URL'] ?? 'https://engine.lynox.cloud';
const COOKIE = process.env['STAGING_COOKIE'] ?? '';

// Single skip at describe level — one clean reason in the report instead of
// five identical per-test skips, and avoids spinning a browser context per
// test when the cookie is absent.
test.skip(!COOKIE, 'STAGING_COOKIE required — staging-only smoke spec');

test.describe('secret-outcome v29 e2e', () => {
  test.beforeEach(async ({ context }) => {
    const url = new URL(STAGING);
    await context.addCookies([{
      name: 'lynox_session',
      value: COOKIE,
      domain: url.hostname,
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'Lax',
    }]);
  });

  test('app shell loads with cookie auth', async ({ page }) => {
    const res = await page.goto(`${STAGING}/app`);
    expect(res?.status()).toBeLessThan(400);
    // Engine version chip / thread list / message input — anything app-shell.
    await expect(page).toHaveTitle(/lynox|app/i);
  });

  test('managed-tier rejects non-LLM vault writes with 403', async ({ page }) => {
    await page.goto(`${STAGING}/app`);
    const result = await page.evaluate(async (base: string) => {
      const r = await fetch(`${base}/api/secrets/SHOPIFY_PW_SMOKE`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ value: 'placeholder-not-a-real-token-aaaaaaaaaaaaaaaa' }),
      });
      return { status: r.status, body: await r.text() };
    }, STAGING);
    expect(result.status).toBe(403);
    expect(result.body).toMatch(/not user-writable|Managed mode/i);
  });

  test('allowlisted ANTHROPIC_API_KEY accepts (no 403)', async ({ page }) => {
    await page.goto(`${STAGING}/app`);
    const result = await page.evaluate(async (base: string) => {
      // Use an empty body — engine returns 400 "Missing value" but the
      // 403 allowlist gate has already passed at that point. We only
      // care that allowlist != tighter-than-needed.
      const r = await fetch(`${base}/api/secrets/ANTHROPIC_API_KEY`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({}),
      });
      return r.status;
    }, STAGING);
    // 400 = missing value (gate passed). 403 = allowlist failure (bug).
    expect(result).toBe(400);
  });

  test('/secret-saved with bogus session returns 404 — no state leak', async ({ page }) => {
    await page.goto(`${STAGING}/app`);
    const result = await page.evaluate(async (base: string) => {
      const r = await fetch(`${base}/api/sessions/nonexistent-pw-smoke/secret-saved`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ status: 'bogus', promptId: 'no-such-id' }),
      });
      return { status: r.status, body: await r.text() };
    }, STAGING);
    expect(result.status).toBe(404);
    expect(result.body).toMatch(/No pending secret prompt/i);
  });

  test('/secret-saved accepts new status field shape (legacy saved still ok too)', async ({ page }) => {
    await page.goto(`${STAGING}/app`);
    // We can't easily inject a pending prompt without running an agent,
    // so verify shape acceptance by posting against a real session-id
    // pattern with no pending — both shapes should return 404 (not 400
    // bad request, which would mean the schema rejected the body).
    const result = await page.evaluate(async (base: string) => {
      const newShape = await fetch(`${base}/api/sessions/pw-shape-test/secret-saved`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ status: 'managed_blocked', promptId: 'fake' }),
      });
      const legacyShape = await fetch(`${base}/api/sessions/pw-shape-test/secret-saved`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ saved: false, promptId: 'fake' }),
      });
      return { newStatus: newShape.status, legacyStatus: legacyShape.status };
    }, STAGING);
    // 404 = body parsed + accepted, no matching pending prompt found.
    // 400 = body rejected = schema regression. Either shape returning 400
    // would mean the back-compat path broke.
    expect(result.newStatus).toBe(404);
    expect(result.legacyStatus).toBe(404);
  });
});
