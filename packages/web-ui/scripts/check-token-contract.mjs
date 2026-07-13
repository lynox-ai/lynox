#!/usr/bin/env node
/**
 * Token contract — this repo, checked against itself.
 *
 * `tokens.contract.json` lists the brand primitives that lynox paints on more than
 * one surface (this product UI, and the lynox.ai marketing site, which is a separate
 * codebase). This asserts that `app.css` still says what the contract says.
 *
 * WHY IT LIVES HERE, and not only on the other side:
 *
 *   The parity check used to exist only in the website's repo. That meant a token
 *   changed HERE was caught THERE — at the next website CSS commit, by whoever
 *   happened to touch that file, possibly weeks later. Wrong moment, wrong person,
 *   and in practice not at all: that check resolved this repo through a relative
 *   path and exited 0 — silently — whenever it wasn't found, which is to say in
 *   every CI run.
 *
 *   A guard that skips itself is not a guard. So the contract moved to the side that
 *   OWNS the values. This file names no other repository and touches no private path
 *   — it is this repo checking a list of colours against its own stylesheet, which
 *   is why it can live in a public repo at all.
 *
 * DARK ONLY. The light ramps are deliberately not shared — see the contract.
 *
 * Run: node packages/web-ui/scripts/check-token-contract.mjs  (or `pnpm tokens:contract`)
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const CSS = resolve(here, '../src/app.css');
const CONTRACT = resolve(here, '../tokens.contract.json');

const decomment = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** Declarations in the DARK baseline only — everything before the light theme opens. */
function darkTokens(css) {
  const body = decomment(css);
  const cut = body.search(/\[data-theme="light"\]/);
  const dark = cut === -1 ? body : body.slice(0, cut);
  const out = new Map();
  for (const m of dark.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
    out.set(m[1], m[2].trim().toLowerCase());
  }
  return out;
}

const contract = JSON.parse(await readFile(CONTRACT, 'utf8'));
const actual = darkTokens(await readFile(CSS, 'utf8'));

const problems = [];
for (const [token, expected] of Object.entries(contract.primitives)) {
  const got = actual.get(token);
  if (got === undefined) {
    problems.push(`--${token} is gone from app.css, but the contract still lists it`);
  } else if (got !== expected.toLowerCase()) {
    problems.push(
      `--${token}\n` +
      `       app.css:  ${got}\n` +
      `       contract: ${expected}`
    );
  }
}

if (problems.length) {
  console.error('\n✗ app.css no longer matches tokens.contract.json:\n');
  for (const p of problems) console.error('  ' + p);
  console.error(
    '\n  These primitives are ONE brand painted on more than one surface. Changing a\n' +
    '  value here means the other surface has to follow — that is what the contract\n' +
    '  is for, and why you are being told now rather than by someone else later.\n' +
    '\n  Either revert the value, or update tokens.contract.json in the same change and\n' +
    '  carry it across. If a token genuinely stops being shared, remove it from the\n' +
    '  contract and say why in "notGuarded".\n'
  );
  process.exit(1);
}

console.log(
  `✓ Token contract: ${Object.keys(contract.primitives).length} shared primitives match app.css.`
);
