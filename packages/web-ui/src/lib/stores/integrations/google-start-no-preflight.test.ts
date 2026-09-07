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

  // ⚠ THIS GUARD IS A TRIPWIRE, NOT A FENCE — and three review rounds are the
  // evidence. Round one: the checks above watched `fetch`, so
  // `new Image().src = data.url` walked past them. Round two: the check below
  // counted `data.url`, so `data['url']` walked past THAT. Each round found a
  // new shape, which is the signature of a detector sized to syntax rather than
  // to behaviour — and the list of ways a browser can fetch a URL is not one
  // anybody finishes.
  //
  // What actually closes the class is server-side: the control plane must stop
  // spending the nonce on the first request it answers. That is filed as
  // `DEF-broker-start-nonce-dies-on-any-fetch` in the private repo, and this
  // test is expected to become redundant when it lands — redundant, not wrong.
  // Until then it catches the shape that actually occurred once, which is worth
  // more than nothing and less than a guarantee.
  it('reads the start URL exactly twice, in either notation, and only to navigate', () => {
    const uses = code.match(/\bdata(?:\.url\b|\[\s*['"`]url['"`]\s*\])/g) ?? [];
    expect(uses, 'a third read of the start URL is a second request against it').toHaveLength(2);
    expect(code).toMatch(/window\.location\.href\s*=\s*data\.url/);
    expect(code).toMatch(/if\s*\(data\.url\)/);
  });
});
