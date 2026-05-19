import { test, expect } from '@playwright/test';

/**
 * PRD-LIGHT-MODE PR 3 — Theme-toggle smoke + visual artefacts.
 *
 * Observational (PNG-as-CI-artifact, no pixel diff) so it matches the
 * existing phase4-visual.spec.ts pattern — pixel-diff baselines would add
 * git-LFS pain and false-positive noise. The point here is:
 *   1. Console-error gate: light mode must not raise new errors.
 *   2. Asserted DOM state: data-theme attribute flips with localStorage.
 *   3. Token integrity: --color-bg actually changes between themes.
 *   4. Multi-route walk: every top-level surface paints in both modes
 *      so a human reviewer scrolling the test-results/ folder can spot
 *      regressions (white text on white, broken artifact frames, etc.).
 */

const ROUTES = [
  '/app',
  '/app/settings',
  '/app/settings/account/appearance',
  '/app/artifacts',
  '/app/inbox',
  '/app/intelligence',
];

const THEMES = ['light', 'dark'] as const;

test.describe('light mode smoke', () => {
  test('appearance route renders the theme toggle radiogroup', async ({ page }) => {
    await page.goto('/app/settings/account/appearance');
    await page.waitForLoadState('networkidle');
    const group = page.getByRole('radiogroup');
    await expect(group).toBeVisible();
    const radios = group.getByRole('radio');
    await expect(radios).toHaveCount(3);
  });

  test('setting lyx-theme via localStorage flips html[data-theme]', async ({ page }) => {
    await page.goto('/app');
    await page.waitForLoadState('networkidle');

    for (const theme of THEMES) {
      await page.evaluate((t) => {
        localStorage.setItem('lyx-theme', t);
      }, theme);
      await page.reload();
      await page.waitForLoadState('networkidle');
      const attr = await page.locator('html').getAttribute('data-theme');
      expect(attr, `expected html[data-theme="${theme}"]`).toBe(theme);
    }
  });

  test('--color-bg actually differs between themes', async ({ page }) => {
    await page.goto('/app');
    await page.waitForLoadState('networkidle');

    async function bgFor(theme: 'light' | 'dark'): Promise<string> {
      await page.evaluate((t) => {
        localStorage.setItem('lyx-theme', t);
      }, theme);
      await page.reload();
      await page.waitForLoadState('networkidle');
      return page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--color-bg').trim());
    }

    const light = await bgFor('light');
    const dark = await bgFor('dark');
    expect(light, 'light --color-bg').not.toBe(dark);
    expect(light.toLowerCase()).toContain('ffffff');
    expect(dark.toLowerCase()).toContain('050510');
  });

  for (const route of ROUTES) {
    for (const theme of THEMES) {
      test(`route ${route} renders in ${theme}`, async ({ page }) => {
        const errors: string[] = [];
        page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
        page.on('console', (msg) => {
          if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
        });

        // Set theme BEFORE navigation so FOUC-script picks it up on first paint.
        await page.context().addInitScript((t: string) => {
          try {
            localStorage.setItem('lyx-theme', t);
          } catch {
            /* private mode in tests is unlikely; ignore */
          }
        }, theme);

        const res = await page.goto(route);
        // /app/inbox etc. may 200 or 404 depending on engine state — accept anything < 500.
        expect(res?.status() ?? 0, `${route} status`).toBeLessThan(500);
        await page.waitForLoadState('networkidle');

        const attr = await page.locator('html').getAttribute('data-theme');
        expect(attr).toBe(theme);

        await page.screenshot({
          path: `test-results/light-mode-${route.replace(/\//g, '_')}-${theme}.png`,
          fullPage: true,
        });

        expect(
          errors.filter((e) => !e.includes('Failed to load resource') && !e.includes('FetchError')),
          `unexpected console/page errors on ${route} in ${theme}:\n${errors.join('\n')}`
        ).toEqual([]);
      });
    }
  }
});
