/**
 * refresh-screenshots.ts — capture fresh staging screenshots for the website
 *
 * Purpose
 *   Walks the authenticated staging tenant (engine.lynox.cloud) with Playwright
 *   and writes screenshots into `pro/packages/web/public/screenshots/`. Used by
 *   Stream C (website refactor) of the HN-launch overnight execution.
 *
 * Required env
 *   STAGING_SESSION_COOKIE   — value of the `lynox_session` cookie for the
 *                              staging tenant. Mint via
 *                              `bash scripts/mint-staging-cookie.sh`. The cookie
 *                              is HMAC-signed against LYNOX_HTTP_SECRET and
 *                              valid for SESSION_MAX_AGE_S (30d).
 *
 * Optional env
 *   STAGING_BASE             — base URL (default https://engine.lynox.cloud)
 *   SCREENSHOT_OUT_DIR       — override output dir
 *   SCREENSHOT_DATE          — override datestamp suffix (default 2026-05-26)
 *
 * How to run
 *   export STAGING_SESSION_COOKIE=$(bash scripts/mint-staging-cookie.sh)
 *   pnpm exec tsx scripts/refresh-screenshots.ts
 *   #  or:  pnpm run screenshots:refresh
 *
 * Output
 *   pro/packages/web/public/screenshots/<view>-<theme>-<viewport>-<date>.png
 *
 * Failure policy
 *   No-stop. A failed view logs `BROKEN: <name> – <reason>` and the script
 *   continues with the next view. Final summary lists success vs broken.
 */

import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { mkdir, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const BASE = process.env.STAGING_BASE ?? 'https://engine.lynox.cloud';
const COOKIE = process.env.STAGING_SESSION_COOKIE ?? '';
const DATE = process.env.SCREENSHOT_DATE ?? '2026-05-26';
const OUT_DIR =
  process.env.SCREENSHOT_OUT_DIR ??
  resolve(__dirname, '../../pro/packages/web/public/screenshots');

const DESKTOP = { width: 1440, height: 900 } as const;
const MOBILE = { width: 390, height: 844 } as const;

const MIN_PNG_BYTES = 10 * 1024; // 10KB sanity threshold

type Theme = 'light' | 'dark';
type Viewport = 'desktop' | 'mobile';

interface ShotSpec {
  /** logical name (used in filename + log) */
  name: string;
  /** path relative to BASE (e.g. /app, /app/intelligence?tab=graph) */
  path: string;
  /** themes to capture */
  themes: Theme[];
  /** viewports to capture */
  viewports: Viewport[];
  /** optional pre-shot async work (e.g. click into a thread) */
  prepare?: (page: Page) => Promise<void>;
  /** ms to wait for app idle after navigation (default 2500) */
  settleMs?: number;
}

const SHOTS: ShotSpec[] = [
  // 1. dashboard — /app IS the chat shell, which is the app dashboard
  { name: 'dashboard', path: '/app', themes: ['light', 'dark'], viewports: ['desktop'] },
  // 2. chat — same root, named separately for site copy
  { name: 'chat', path: '/app', themes: ['light', 'dark'], viewports: ['desktop'] },
  // 3. KG (knowledge graph) — IntelligenceHub with tab=graph
  { name: 'kg', path: '/app/intelligence?tab=graph', themes: ['dark'], viewports: ['desktop'] },
  // 4. automation (workflows) — post-#510 unified hub
  { name: 'automation', path: '/app/automation', themes: ['dark'], viewports: ['desktop'] },
  // 5. CRM — IntelligenceHub with tab=contacts
  { name: 'crm', path: '/app/intelligence?tab=contacts', themes: ['dark'], viewports: ['desktop'] },
  // 6. inbox (unified)
  { name: 'inbox', path: '/app/inbox', themes: ['dark'], viewports: ['desktop'] },
  // 7. api-store — lives under settings/integrations
  {
    name: 'api-store',
    path: '/app/settings/integrations/api-store',
    themes: ['dark'],
    viewports: ['desktop'],
  },
  // 8. activity
  { name: 'activity', path: '/app/activity', themes: ['dark'], viewports: ['desktop'] },
  // 9. migration wizard
  { name: 'migration', path: '/app/migration', themes: ['dark'], viewports: ['desktop'] },
  // 10. settings (light + dark)
  { name: 'settings', path: '/app/settings', themes: ['light', 'dark'], viewports: ['desktop'] },
  // 11. mobile-hero — chat at 390x844
  { name: 'mobile-hero', path: '/app', themes: ['dark'], viewports: ['mobile'] },
  // 12. mobile triptych — kg + automation on mobile (chat is already covered by mobile-hero)
  {
    name: 'mobile-kg',
    path: '/app/intelligence?tab=graph',
    themes: ['dark'],
    viewports: ['mobile'],
  },
  { name: 'mobile-automation', path: '/app/automation', themes: ['dark'], viewports: ['mobile'] },
];

interface Result {
  ok: string[];
  broken: { name: string; reason: string }[];
}

const log = (msg: string) => {
  // eslint-disable-next-line no-console
  console.log(`[refresh-screenshots] ${msg}`);
};

async function setTheme(page: Page, theme: Theme): Promise<void> {
  // The web-ui stores theme preference in localStorage under 'theme'.
  // localStorage is per-origin, so callers must have navigated to BASE first.
  await page.evaluate((t) => {
    try {
      window.localStorage.setItem('theme', t);
      document.documentElement.setAttribute('data-theme', t);
      document.documentElement.classList.remove('light', 'dark');
      document.documentElement.classList.add(t);
    } catch {
      /* localStorage may be unavailable in some contexts; ignore */
    }
  }, theme);
}

async function captureOne(
  context: BrowserContext,
  spec: ShotSpec,
  theme: Theme,
  viewport: Viewport,
  result: Result,
): Promise<void> {
  const filename = `${spec.name}-${theme}-${viewport}-${DATE}.png`;
  const outPath = resolve(OUT_DIR, filename);
  const dims = viewport === 'desktop' ? DESKTOP : MOBILE;

  const page = await context.newPage();
  try {
    await page.setViewportSize(dims);
    // Land on origin first so we can set theme in localStorage
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await setTheme(page, theme);

    const target = new URL(spec.path, BASE).toString();
    await page.goto(target, { waitUntil: 'networkidle', timeout: 30_000 });

    if (spec.prepare) {
      await spec.prepare(page);
    }

    await page.waitForTimeout(spec.settleMs ?? 2500);

    await page.screenshot({ path: outPath, fullPage: false });

    const st = await stat(outPath);
    if (st.size < MIN_PNG_BYTES) {
      result.broken.push({
        name: filename,
        reason: `output size ${st.size}B < ${MIN_PNG_BYTES}B threshold (probably 404 / blank)`,
      });
      log(`BROKEN: ${filename} – output ${st.size}B too small`);
    } else {
      result.ok.push(filename);
      log(`OK: ${filename} (${Math.round(st.size / 1024)}KB)`);
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    result.broken.push({ name: filename, reason });
    log(`BROKEN: ${filename} – ${reason}`);
  } finally {
    await page.close().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  if (!COOKIE) {
    log('FATAL: STAGING_SESSION_COOKIE env var not set. Mint via scripts/mint-staging-cookie.sh');
    process.exit(2);
  }

  await mkdir(OUT_DIR, { recursive: true });
  log(`Base: ${BASE}`);
  log(`Out:  ${OUT_DIR}`);
  log(`Date: ${DATE}`);
  log(`Specs: ${SHOTS.length}`);

  let browser: Browser | undefined;
  const result: Result = { ok: [], broken: [] };

  try {
    browser = await chromium.launch({ headless: true });

    const host = new URL(BASE).hostname;
    const context = await browser.newContext({
      viewport: DESKTOP,
      ignoreHTTPSErrors: true,
    });
    await context.addCookies([
      {
        name: 'lynox_session',
        value: COOKIE,
        domain: host,
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
      },
    ]);

    for (const spec of SHOTS) {
      for (const theme of spec.themes) {
        for (const viewport of spec.viewports) {
          await captureOne(context, spec, theme, viewport, result);
        }
      }
    }

    await context.close();
  } finally {
    await browser?.close().catch(() => undefined);
  }

  log('========================================');
  log(`SUCCESS: ${result.ok.length} screenshots`);
  for (const name of result.ok) log(`  + ${name}`);
  if (result.broken.length > 0) {
    log(`BROKEN: ${result.broken.length} screenshots`);
    for (const { name, reason } of result.broken) log(`  - ${name}: ${reason}`);
  }
  log('========================================');

  if (result.ok.length === 0) {
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('[refresh-screenshots] fatal:', err);
  process.exit(1);
});
