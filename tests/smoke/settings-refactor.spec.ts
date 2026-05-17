/**
 * Playwright FULL smoke for the Settings & Usage IA Refactor
 * (PRD-SETTINGS-REFACTOR Phases 0–5). Covers every changed feature,
 * not just route presence — per project standard
 * `feedback_thorough_smoke_test`.
 *
 * **Staging-only** — needs a real session cookie + the deployed
 * Settings-Refactor routes (cost-limits, /api/llm/test, etc.). Run via:
 *
 *   STAGING_URL=https://engine.lynox.cloud \
 *   STAGING_COOKIE='lynox_session=...' \
 *   npx playwright test tests/smoke/settings-refactor.spec.ts --reporter=list
 *
 * In CI (smoke-local.sh against a fresh docker-compose stack) neither env
 * var is set, so every test would 401 against the staging engine. The
 * beforeEach below skips the whole spec when `STAGING_COOKIE` is absent
 * — operator-driven staging smoke still runs, CI stays green.
 */
import { test, expect, type Page, type APIRequestContext } from '@playwright/test';

const BASE = process.env.STAGING_URL ?? 'https://engine.lynox.cloud';
const COOKIE = process.env.STAGING_COOKIE ?? '';
const cookieHeader = COOKIE ? { Cookie: COOKIE } : {};

function consoleErrorCollector(page: Page): { errors: string[] } {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => { errors.push(err.message); });
  return { errors };
}

async function setCookie(page: Page): Promise<void> {
  if (!COOKIE) return;
  const eq = COOKIE.indexOf('=');
  await page.context().addCookies([{
    name: COOKIE.slice(0, eq),
    value: COOKIE.slice(eq + 1),
    domain: new URL(BASE).hostname,
    path: '/',
  }]);
}

test.beforeEach(async ({ page }) => {
  test.skip(!COOKIE, 'STAGING_COOKIE required — staging-only smoke spec');
  await setCookie(page);
});

// ─────────────────────────────────────────────────────────────────────
// Phase 0 — Foundation endpoints
// ─────────────────────────────────────────────────────────────────────

test('0b — /api/config exposes capabilities + locks + hard_limits', async ({ request }) => {
  const res = await request.get(`${BASE}/api/config`, { headers: cookieHeader });
  expect(res.status()).toBe(200);
  const body = await res.json() as { capabilities?: Record<string, unknown>; locks?: unknown };
  expect(body.capabilities).toBeDefined();
  const caps = body.capabilities!;
  for (const key of [
    'mistral_available', 'voice_stt_available', 'voice_tts_available', 'whisper_local_available',
    'can_set_provider', 'can_set_limits', 'can_set_context_window', 'can_set_thinking_effort',
    'can_set_custom_endpoints', 'can_export_data', 'can_delete_account',
    'has_mcp_support', 'has_calendar', 'hard_limits',
  ]) {
    expect(caps[key], `capability.${key}`).toBeDefined();
  }
  expect(body).toHaveProperty('locks');
});

test('0c — /api/llm/catalog returns 4 providers with expected gating flags', async ({ request }) => {
  const res = await request.get(`${BASE}/api/llm/catalog`, { headers: cookieHeader });
  expect(res.status()).toBe(200);
  expect(res.headers()['cache-control']).toContain('max-age=');
  const body = await res.json() as { providers: Array<{ provider: string; models: unknown[]; requires_base_url: boolean; requires_region: boolean }> };
  expect(body.providers.map((p) => p.provider).sort()).toEqual(['anthropic', 'custom', 'openai', 'vertex']);
  const byName = Object.fromEntries(body.providers.map((p) => [p.provider, p]));
  expect(byName['anthropic']!.requires_base_url).toBe(false);
  expect(byName['anthropic']!.requires_region).toBe(false);
  expect(byName['vertex']!.requires_region).toBe(true);
  expect(byName['openai']!.requires_base_url).toBe(true);
  expect(byName['custom']!.models).toHaveLength(0);
});

test('0d — /app/automation redirects to /app/hub preserving query-string', async ({ page }) => {
  await page.goto(`${BASE}/app/automation?section=activity&tab=usage`);
  await page.waitForURL(/\/app\/hub/);
  expect(page.url()).toContain('section=activity');
  expect(page.url()).toContain('tab=usage');
});

test('0e — /api/usage/current returns SSoT shape with projection + hard_limits', async ({ request }) => {
  const res = await request.get(`${BASE}/api/usage/current`, { headers: cookieHeader });
  expect(res.status()).toBe(200);
  const body = await res.json() as Record<string, unknown>;
  expect(body['period']).toBeDefined();
  expect(body).toHaveProperty('projection');
  expect(body).toHaveProperty('hard_limits');
  expect(body).toHaveProperty('limit_cents');
  expect(body).toHaveProperty('used_cents');
});

test('0e — /api/usage/summary is an alias of /api/usage/current (same payload)', async ({ request }) => {
  const [current, summary] = await Promise.all([
    request.get(`${BASE}/api/usage/current`, { headers: cookieHeader }),
    request.get(`${BASE}/api/usage/summary`, { headers: cookieHeader }),
  ]);
  expect(current.status()).toBe(200);
  expect(summary.status()).toBe(200);
  const [a, b] = await Promise.all([current.json(), summary.json()]);
  expect(b).toEqual(a);
});

// ─────────────────────────────────────────────────────────────────────
// Phase 1 — Cost & Limits surface (feature depth)
// PRD-IA-V2 P3-PR-X retired `/app/hub/cost-limits` (CostLimits.svelte deleted).
// Spend-limits + HTTP-cap moved to `/app/settings/workspace/limits` (Self-Host
// only — WorkspaceLimitsView), context-window radio moved to
// `/app/settings/llm/advanced` (LLMAdvancedView). The legacy URL 301-redirects
// to `/app/settings/workspace/limits`.
// ─────────────────────────────────────────────────────────────────────

test('1 — /app/hub/cost-limits 301-redirects to /app/settings/workspace/limits', async ({ page }) => {
  const { errors } = consoleErrorCollector(page);
  await page.goto(`${BASE}/app/hub/cost-limits`, { waitUntil: 'domcontentloaded' });
  // After 301 SvelteKit lands on the canonical home.
  expect(page.url()).toContain('/app/settings/workspace/limits');
  expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
});

test('1 — /app/settings/llm/advanced exposes 4 context-window radios', async ({ page }) => {
  const { errors } = consoleErrorCollector(page);
  await page.goto(`${BASE}/app/settings/llm/advanced`, { waitUntil: 'domcontentloaded' });
  // Context-window radio group should expose all 4 options (default + 200k / 500k / 1M)
  const radios = page.locator('input[name="llm-context-window"]');
  await expect(radios).toHaveCount(4);
  expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
});

test('1 — PUT /api/config round-trips max_context_window_tokens', async ({ request }) => {
  // Save original to restore later
  const orig = await (await request.get(`${BASE}/api/config`, { headers: cookieHeader })).json() as { max_context_window_tokens?: number };
  try {
    const put = await request.put(`${BASE}/api/config`, {
      headers: { ...cookieHeader, 'Content-Type': 'application/json' },
      data: { max_context_window_tokens: 500_000 },
    });
    expect(put.status()).toBe(200);
    const after = await (await request.get(`${BASE}/api/config`, { headers: cookieHeader })).json() as { max_context_window_tokens?: number };
    expect(after.max_context_window_tokens).toBe(500_000);
  } finally {
    // Restore: send the original value if it was defined, otherwise omit the
    // key entirely. JSON `null` would 400 against `z.number().int().positive()`
    // (the schema doesn't accept null) and leave staging persisted at 500k
    // across runs — restore must be schema-valid.
    const restoreBody: Record<string, number> = {};
    if (typeof orig.max_context_window_tokens === 'number') {
      restoreBody['max_context_window_tokens'] = orig.max_context_window_tokens;
    }
    if (Object.keys(restoreBody).length > 0) {
      await request.put(`${BASE}/api/config`, {
        headers: { ...cookieHeader, 'Content-Type': 'application/json' },
        data: restoreBody,
      });
    }
  }
});

// ─────────────────────────────────────────────────────────────────────
// Phase 2 — LLM settings page + /api/llm/test
// ─────────────────────────────────────────────────────────────────────

test('2 — /app/settings/llm renders 4 provider cards + Test button', async ({ page }) => {
  const { errors } = consoleErrorCollector(page);
  await page.goto(`${BASE}/app/settings/llm`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('h1')).toContainText(/LLM/i);
  // 4 provider cards under the provider-picker grid. The grid is the only
  // div with `grid sm:grid-cols-2` containing buttons inside the
  // `[aria-labelledby="llm-provider-heading"]` section, so the selector
  // anchors on that section instead of `has-text` substrings (which double-
  // counted any model-label button that contained "Mistral").
  const providerCards = page.locator('section[aria-labelledby="llm-provider-heading"] button');
  await expect(providerCards).toHaveCount(4);
  // Connection-test button visible
  await expect(page.getByRole('button', { name: /Test connection|Verbindung testen/i })).toBeVisible();
  expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
});

test('2 — POST /api/llm/test vertex returns skipped happy-path (no real key needed)', async ({ request }) => {
  const res = await request.post(`${BASE}/api/llm/test`, {
    headers: { ...cookieHeader, 'Content-Type': 'application/json' },
    data: { provider: 'vertex', api_key: '' },
  });
  expect(res.status()).toBe(200);
  const body = await res.json() as { ok: boolean; skipped?: boolean };
  expect(body.ok).toBe(true);
  expect(body.skipped).toBe(true);
});

test('2 — POST /api/llm/test rejects unknown provider with 400', async ({ request }) => {
  const res = await request.post(`${BASE}/api/llm/test`, {
    headers: { ...cookieHeader, 'Content-Type': 'application/json' },
    data: { provider: 'bogus', api_key: 'xxx' },
  });
  expect(res.status()).toBe(400);
});

test('2 — POST /api/llm/test rejects missing api_key for anthropic with 400', async ({ request }) => {
  const res = await request.post(`${BASE}/api/llm/test`, {
    headers: { ...cookieHeader, 'Content-Type': 'application/json' },
    data: { provider: 'anthropic', api_key: '' },
  });
  expect(res.status()).toBe(400);
});

test('2 — POST /api/llm/test blocks SSRF via custom base_url to 169.254.169.254', async ({ request }) => {
  const res = await request.post(`${BASE}/api/llm/test`, {
    headers: { ...cookieHeader, 'Content-Type': 'application/json' },
    data: { provider: 'custom', api_key: 'fake', base_url: 'http://169.254.169.254/v1' },
  });
  // Either 200 with error body (in-band) or 4xx — accept both, but error must contain SSRF signal
  const body = await res.json() as { error?: string; ok?: boolean };
  expect(body.ok).not.toBe(true);
  expect(JSON.stringify(body)).toMatch(/Blocked|private|SSRF|allowed|public|reject/i);
});

test('2 — POST /api/llm/test rate-limits at 6/min (7th call returns 429)', async ({ request }) => {
  // Burst 7 probes with vertex (cheap happy-path). 7th should 429.
  const probes = [];
  for (let i = 0; i < 7; i++) {
    probes.push(request.post(`${BASE}/api/llm/test`, {
      headers: { ...cookieHeader, 'Content-Type': 'application/json' },
      data: { provider: 'vertex', api_key: '' },
    }));
  }
  const responses = await Promise.all(probes);
  const statuses = responses.map((r) => r.status());
  // At least one 429 in the batch (timing-dependent — under load might be more)
  expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(1);
});

// ─────────────────────────────────────────────────────────────────────
// Phase 3 — Voice + Privacy & Data
// ─────────────────────────────────────────────────────────────────────

test('3 — /app/settings/voice renders STT + TTS provider dropdowns', async ({ page }) => {
  const { errors } = consoleErrorCollector(page);
  await page.goto(`${BASE}/app/settings/voice`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('h1')).toContainText(/Voice|Sprache/i);
  // STT + TTS section headings
  await expect(page.getByText(/Speech-to-Text|Eingabe/i).first()).toBeVisible();
  await expect(page.getByText(/Text-to-Speech|Ausgabe/i).first()).toBeVisible();
  expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
});

test('3 — /app/settings/privacy renders 4 sections + Delete-request button', async ({ page }) => {
  const { errors } = consoleErrorCollector(page);
  await page.goto(`${BASE}/app/settings/privacy`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('h1')).toContainText(/Privacy.*Data|Privatsphäre.*Daten/i);
  // Sections: Export / Audit / Bugsink / Delete
  await expect(page.getByText(/Export.*data|Daten exportieren/i).first()).toBeVisible();
  await expect(page.getByText(/Audit.*log|Audit-Log/i).first()).toBeVisible();
  await expect(page.getByText(/Error reporting|Fehler-Reporting/i).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /Request deletion|Löschung anfordern/i })).toBeVisible();
  expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
});

test('3 — POST /api/privacy/delete-request returns mailto channel', async ({ request }) => {
  const res = await request.post(`${BASE}/api/privacy/delete-request`, { headers: cookieHeader });
  expect(res.status()).toBe(200);
  const body = await res.json() as { ok: boolean; channel: string; recipient: string };
  expect(body.ok).toBe(true);
  expect(body.channel).toBe('mailto');
  expect(body.recipient).toContain('privacy@lynox.ai');
});

// ─────────────────────────────────────────────────────────────────────
// Phase 4 — Integrations: API Store sub-route reservation
// ─────────────────────────────────────────────────────────────────────

test('4 — /app/settings/integrations/api-store renders without 404', async ({ page }) => {
  const { errors } = consoleErrorCollector(page);
  const response = await page.goto(`${BASE}/app/settings/integrations/api-store`, { waitUntil: 'domcontentloaded' });
  expect(response?.status()).toBeLessThan(400);
  expect(page.url()).toContain('api-store');
  expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
});

// ─────────────────────────────────────────────────────────────────────
// Phase 5 — System page
// ─────────────────────────────────────────────────────────────────────

test('5 — /app/settings/system renders Vault + Token + Update-check sections', async ({ page }) => {
  const { errors } = consoleErrorCollector(page);
  await page.goto(`${BASE}/app/settings/system`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('h1')).toContainText(/System/i);
  // For self-host the three sections render; for managed only the minimal notice.
  // Either path is acceptable — assert at least one of the sections OR the managed notice.
  const hasVault = await page.getByText(/Vault.*key|Vault-Schlüssel/i).first().isVisible().catch(() => false);
  const hasManaged = await page.getByText(/managed by hosting|Managed-Hosting verwaltet/i).first().isVisible().catch(() => false);
  expect(hasVault || hasManaged).toBe(true);
  expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
});

// ─────────────────────────────────────────────────────────────────────
// Cross-surface — StatusBar SSoT consistency + mobile + a11y
// ─────────────────────────────────────────────────────────────────────

test('X — StatusBar cost-pill links to /app/activity (P2-PR-B target after P3-PR-X retired CostLimits)', async ({ page }) => {
  await page.goto(`${BASE}/app`, { waitUntil: 'domcontentloaded' });
  const pill = page.locator('a[href="/app/activity"]');
  await expect(pill.first()).toHaveAttribute('href', '/app/activity');
});

test('X — Mobile 390px: LLM page renders without horizontal scroll', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}/app/settings/llm`, { waitUntil: 'domcontentloaded' });
  const scrollX = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(scrollX, 'horizontal scroll on mobile').toBeLessThanOrEqual(2);
});

test('X — Mobile 390px: Workspace Limits renders without horizontal scroll', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}/app/settings/workspace/limits`, { waitUntil: 'domcontentloaded' });
  const scrollX = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(scrollX, 'horizontal scroll on mobile').toBeLessThanOrEqual(2);
});
