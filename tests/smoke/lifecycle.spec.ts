import { test, expect, type Page } from '@playwright/test';
import { createHmac } from 'node:crypto';

/**
 * CHAT-RUN LIFECYCLE RESILIENCE — the missing automated layer.
 *
 * Unit tests cover run/message DATA (a row persists). NOTHING covered the LIVE
 * SSE/reload BEHAVIOUR: when a run is actively streaming and the client
 * reloads / cache-reloads / switches thread, does the client re-attach and keep
 * showing the agent's activity — or go blind? v1.9.0 fixed message data
 * durability but NOT live-stream reconnect, and it shipped because the
 * staging-walk asserted "durability verified" instead of reproducing the
 * reload-mid-active-run scenario. This file encodes that scenario as an
 * executable contract so the gap is a RED test, not a feeling.
 * See memory: project_run_resilience_proposal · feedback_verify_reproduce_not_assert.
 *
 * STATUS: run-resilience Tier 1 + Tier 2 SHIPPED in v1.10.0 (registry +
 * /api/runs/active + resumable SSE + disconnect≠abort headless + nav live-run
 * indicator). The baseline below has FLIPPED — it now asserts the registry
 * endpoint is live. Un-skip happens cluster-by-cluster: the soft-reload
 * re-attach + nav-indicator clusters are active (verified live on staging +
 * the v1.10.0 prod canary). The two harsher timing-sensitive clusters
 * (hard cache-reload with a cookie wipe, thread-switch round-trip) stay
 * `test.skip` pending a dedicated staging-walk timing pass — they need a
 * guaranteed-long run to reload INTO, which a fast smoke LLM may not give.
 *
 * Run: SMOKE_BASE_URL=<staging-engine-url> SMOKE_HTTP_SECRET=<secret> \
 *      pnpm exec playwright test tests/smoke/lifecycle.spec.ts
 */

const SMOKE_SECRET = process.env['SMOKE_HTTP_SECRET'] ?? 'smoke-test-http-secret-ephemeral';

function mintSessionCookie(secret: string): string {
  const ts = Math.floor(Date.now() / 1000).toString();
  const key = createHmac('sha256', 'lynox-session').update(secret).digest();
  return `${ts}.${createHmac('sha256', key).update(ts).digest('hex')}`;
}

async function authenticate(page: Page): Promise<void> {
  await page.goto('/');
  await page.evaluate((cookie) => {
    document.cookie = `lynox_session=${cookie}; path=/; max-age=2592000`;
  }, mintSessionCookie(SMOKE_SECRET));
}

/** Start a run that takes long enough to reload INTO (a multi-step task). */
async function startLongRun(page: Page): Promise<void> {
  await page.goto('/app');
  const input = page.getByPlaceholder(/nachricht|message/i).first();
  await input.fill('Research three competitors and write a short comparison — take your time.');
  await input.press('Enter');
  // Wait until the run is demonstrably ACTIVE (streaming indicator / stop button).
  await expect(page.getByText(/denkt|thinking|arbeitet|working/i).first()).toBeVisible({ timeout: 15_000 });
}

test.describe('chat-run lifecycle resilience', () => {
  test('active-run registry is queryable (run-resilience Tier 1 shipped)', async ({ request, page }) => {
    await authenticate(page);
    // FLIPPED: the per-thread run registry shipped — /api/runs/active is live.
    // Query it authenticated (the standalone `request` fixture carries no page
    // cookie) and assert it returns a runs array, not a 404.
    const cookie = mintSessionCookie(SMOKE_SECRET);
    const res = await request.get('/api/runs/active', { headers: { cookie: `lynox_session=${cookie}` } });
    expect(res.ok(), 'run-registry endpoint is live post-resilience').toBeTruthy();
    const body = (await res.json()) as { runs?: unknown };
    expect(Array.isArray(body.runs), '/api/runs/active returns a runs array').toBeTruthy();
  });

  test('reload mid-run: client re-attaches and still shows the agent working', async ({ page }) => {
    await authenticate(page);
    await startLongRun(page);
    await page.reload(); // soft reload mid-stream
    // The run is still active server-side → the client must re-attach and show it
    // as active, not go blind. (resumable SSE re-attach + run registry, v1.10.0.)
    await expect(page.getByText(/denkt|thinking|arbeitet|working/i).first()).toBeVisible({ timeout: 10_000 });
  });

  // Still skipped — needs a dedicated staging-walk timing pass (a guaranteed-long
  // run to reload INTO; a fast smoke LLM can finish before the cookie-wipe reload).
  test.skip('hard cache-reload mid-run: live activity (tools/tokens) resumes, not just prompts', async ({ page, context }) => {
    await authenticate(page);
    await startLongRun(page);
    await context.clearCookies(); // simulate a harsher reload; re-auth below
    await authenticate(page);
    await page.goto('/app');
    // After a hard reload the client must replay/resume the in-flight run's
    // activity stream (tool calls + streamed text), not sit blind until an ask_user.
    await expect(page.getByText(/denkt|thinking|arbeitet|working/i).first()).toBeVisible({ timeout: 10_000 });
  });

  // Still skipped — same reason: needs a guaranteed-long run for the round-trip.
  test.skip('thread-switch during an active run: returning to the thread shows it still running', async ({ page }) => {
    await authenticate(page);
    await startLongRun(page);
    // Switch to a different thread (new chat), then back.
    await page.getByRole('button', { name: /neuer chat|new chat/i }).first().click();
    await page.goBack();
    await expect(page.getByText(/denkt|thinking|arbeitet|working/i).first()).toBeVisible({ timeout: 10_000 });
  });

  test('nav shows which threads have an active run', async ({ page }) => {
    await authenticate(page);
    await startLongRun(page);
    await page.reload();
    // The thread-history nav must surface a working/active indicator on the
    // thread whose run is live (and an "awaiting input" state when an ask_user
    // is pending) — so parallel runs across chats are visible to the user.
    const navActive = page.locator('[data-thread-active], [data-run-status="running"]').first();
    await expect(navActive).toBeVisible({ timeout: 10_000 });
  });
});
