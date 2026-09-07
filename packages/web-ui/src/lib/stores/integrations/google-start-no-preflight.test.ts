import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * A SOURCE guard, and the reason is worth stating rather than hiding.
 *
 * `startManagedGoogleOAuth` takes no injected `fetch` and ends in
 * `window.location.href` — unlike its neighbours in `google-switch.ts`, which
 * are pure because they were written to be driven. Making it injectable is a
 * larger change than the one-line fix it would guard, so the check reads the
 * source instead.
 *
 * What it pins is narrow on purpose: the function may reach the network EXACTLY
 * ONCE, to ask the engine for the start URL. Anything else it fetches is a
 * request against the control plane's start route, and that route consumes the
 * one-time start nonce on the first request it answers — `HEAD` included, since
 * Hono routes `HEAD` to the `GET` handler. Measured against staging on
 * 2026-09-07: a `HEAD` preflight returns 302, and the navigation that follows
 * lands on `google_oauth_error=replayed`.
 *
 * This exact probe stood here until 2026-09-07 and was harmless only while the
 * URL carried no token. The token made it fatal, which is why a comment alone
 * is not enough to keep it gone.
 */
const source = readFileSync(
  fileURLToPath(new URL('./google.svelte.ts', import.meta.url)),
  'utf-8',
);

/** The body of `startManagedGoogleOAuth`, brace-matched from its declaration. */
function bodyOf(name: string): string {
  const start = source.indexOf(`export async function ${name}(`);
  expect(start, `${name} not found — this guard is pinned to a name that moved`).toBeGreaterThan(-1);
  let depth = 0;
  let i = source.indexOf('{', start);
  const open = i;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(open, i + 1);
  }
  throw new Error(`unbalanced braces after ${name}`);
}

describe('startManagedGoogleOAuth must not touch the start URL before navigating', () => {
  const body = bodyOf('startManagedGoogleOAuth');

  // Strip line comments first: the fix left an explanatory comment that names
  // `HEAD` and `fetch`, and a guard that counted those would fire on the very
  // text explaining why it exists.
  const code = body.replace(/\/\/.*$/gm, '');

  it('makes exactly ONE network call — the engine asking for the URL', () => {
    const calls = code.match(/\bfetch\s*\(/g) ?? [];
    expect(calls).toHaveLength(1);
  });

  it('that one call goes to the engine route, not to the returned URL', () => {
    expect(code).toMatch(/fetch\(`\$\{getApiBase\(\)\}\/google\/oauth-url`\)/);
    expect(code, 'a request against the start URL consumes its one-time nonce').not.toMatch(
      /fetch\(\s*data\.url/,
    );
  });

  it('never names the HEAD method — the shape the removed probe had', () => {
    expect(code).not.toMatch(/HEAD/);
  });

  // ⚠ The three checks above all watch `fetch`, and a delta round pointed out
  // that they are trivially side-stepped: `new Image().src = data.url`,
  // `navigator.sendBeacon(data.url)` or an XHR burns the nonce exactly as the
  // HEAD probe did and touches none of them. The pattern was the wrong size.
  //
  // So this one inverts the question. Instead of listing the ways to reach the
  // URL — a list that is never finished — it pins the ONE use that is allowed.
  it('uses data.url exactly once, and only to navigate', () => {
    const uses = code.match(/\bdata\.url\b/g) ?? [];
    expect(uses).toHaveLength(2); // the `if (data.url)` guard, and the assignment
    expect(code).toMatch(/window\.location\.href\s*=\s*data\.url/);
    expect(code).toMatch(/if\s*\(data\.url\)/);
  });
});
