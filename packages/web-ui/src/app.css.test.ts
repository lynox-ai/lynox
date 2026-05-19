import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * PRD-LIGHT-MODE PR 3 — Token-symmetry assertion.
 *
 * Catches "forgot to define a token in one theme" regressions before they
 * surface in production. If the dark block declares --lyx-foo, the light
 * block MUST too (and vice versa). Tailwind v4 inline-@theme then resolves
 * --color-foo: var(--lyx-foo) and both themes paint correctly.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const cssPath = join(__dirname, 'app.css');
const css = readFileSync(cssPath, 'utf-8');

function extractTokens(blockSelector: RegExp): Set<string> {
  const match = css.match(blockSelector);
  if (!match) throw new Error(`Block ${blockSelector} not found in app.css`);
  const body = match[0];
  const keys = new Set<string>();
  for (const m of body.matchAll(/(--lyx-[a-z-]+)\s*:/g)) {
    if (m[1]) keys.add(m[1]);
  }
  return keys;
}

describe('app.css token symmetry', () => {
  const darkBlock = /:root,\s*\[data-theme="dark"\][^}]+\}/s;
  const lightBlock = /\[data-theme="light"\][^}]+\}/s;

  it('dark block defines >= 18 --lyx-* tokens', () => {
    const dark = extractTokens(darkBlock);
    expect(dark.size).toBeGreaterThanOrEqual(18);
  });

  it('light and dark blocks define the SAME --lyx-* keys', () => {
    const dark = extractTokens(darkBlock);
    const light = extractTokens(lightBlock);

    const onlyInDark = [...dark].filter((k) => !light.has(k));
    const onlyInLight = [...light].filter((k) => !dark.has(k));

    expect(
      onlyInDark,
      `Tokens defined in dark but missing in light: ${onlyInDark.join(', ')}`
    ).toEqual([]);
    expect(
      onlyInLight,
      `Tokens defined in light but missing in dark: ${onlyInLight.join(', ')}`
    ).toEqual([]);
  });

  it('@theme inline mapping references every --lyx-* token', () => {
    const themeBlock = css.match(/@theme inline\s*\{[^}]+\}/s)?.[0] ?? '';
    expect(themeBlock).toBeTruthy();
    const light = extractTokens(lightBlock);
    const missing: string[] = [];
    for (const key of light) {
      const colorKey = key.replace('--lyx-', '--color-');
      if (!themeBlock.includes(`var(${key})`)) {
        // Some tokens like --lyx-shadow-rgb are deliberately not mapped to a
        // --color-* utility class (used as raw triplets in box-shadow). Skip.
        if (key.endsWith('-rgb')) continue;
        missing.push(`${colorKey} → var(${key})`);
      }
    }
    expect(missing, `@theme inline is missing mappings: ${missing.join(', ')}`).toEqual([]);
  });
});
