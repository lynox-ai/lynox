#!/usr/bin/env node
/**
 * Token contract — this repo, checked against itself.
 *
 * `tokens.contract.json` lists the brand primitives that lynox paints on more than
 * one surface: this product UI, and the lynox.ai marketing site, which is a separate
 * codebase and cannot depend on this package. The values are therefore duplicated.
 * Duplication is fine; SILENT duplication is not. This asserts app.css still says
 * what the contract says — here, in this repo, on the commit that changes it.
 *
 * It names no other repository and no private path. It is a list of colours checked
 * against a stylesheet, which is why it can live in a public repo at all.
 *
 * It exists because nothing here knew those values were shared: hex-guard allowlists
 * app.css as "the token definitions themselves", so the values IN it were unguarded.
 * A rebrand could land here and be discovered somewhere else, later, by someone else.
 *
 * ── WHY IT PARSES BLOCKS INSTEAD OF SLICING THE FILE ────────────────────────────
 *
 * The first version of this took everything before the first `[data-theme="light"]`
 * and called it "the dark values". Review broke it in four ways, and three of them
 * made it print ✓ while the product's rendered brand colour had changed:
 *
 *   - a `[data-theme="dark"] { --lyx-accent: red }` appended AFTER the light block
 *     wins the cascade and was never read — the check verified a PREFIX of the file,
 *     not the effective value;
 *   - `@theme inline` — the layer components actually consume (`bg-accent`,
 *     `text-accent`, `var(--color-*)`) — sits after that point, so rewriting
 *     `--color-accent: var(--lyx-accent)` to a literal repainted the whole UI and
 *     passed;
 *   - `--lyx-accent-disabled: color-mix(in srgb, #6525EF 35%, #0c0c20)` was a second
 *     literal copy of two guarded values three lines below their own declarations —
 *     so following this script's own advice ("update the contract in the same
 *     change") left the disabled state painting the old brand. That is now written
 *     as var(), and rule 4 below stops it coming back;
 *   - the shared set could never be seen GROWING: a new `--lyx-*` in the dark block
 *     was simply not looked at.
 *
 * So it parses. Four assertions:
 *
 *   1. EFFECTIVE dark value — the LAST declaration in any dark-applicable block, in
 *      file order, exactly as the cascade resolves it — matches the contract.
 *   2. Bidirectional: every `--lyx-*` in a dark block is either IN the contract or
 *      listed in `notGuarded` with a reason. A token cannot appear unnoticed.
 *   3. `@theme inline` aliases only. No literal colour may live there — it is a
 *      mapping layer, and a literal in it silently overrides the token it maps.
 *   4. No hex literal inside a function in a token block (`color-mix(… #hex …)`).
 *      That is a copy of a value that has a name, and copies rot.
 *
 * DARK ONLY. The light ramps are deliberately not shared — see the contract.
 *
 * Run: node packages/web-ui/scripts/check-token-contract.mjs   (from the repo root:
 *      `pnpm tokens:contract`)
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const CSS = resolve(here, '../src/app.css');
const CONTRACT = resolve(here, '../tokens.contract.json');

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * Top-level `prelude { body }` blocks, in file order. Brace-matched, so a nested
 * block cannot be mistaken for the end of its parent.
 */
function blocks(css) {
  const out = [];
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open === -1) break;
    // Only the last STATEMENT before the brace is the selector. Everything before a
    // `;` is a statement at-rule of its own (`@import …;`, `@custom-variant …;`) and
    // would otherwise be glued onto the front of the next selector — which made the
    // real dark block look like an at-rule and get skipped, silently, on the first
    // run of this parser. Caught by the baseline failing; that is what a baseline
    // assertion is for.
    const prelude = css.slice(i, open).split(';').pop().trim();
    let depth = 1;
    let j = open + 1;
    while (j < css.length && depth > 0) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}') depth--;
      j++;
    }
    out.push({ prelude, body: css.slice(open + 1, j - 1) });
    i = j;
  }
  return out;
}

/** `--name: value;` pairs in a block body, in order. */
function decls(body) {
  return [...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => ({
    name: m[1].slice(2),
    value: m[2].trim(),
  }));
}

/**
 * Does this selector list apply when the theme is dark?
 *
 * `:root, [data-theme="dark"]` — yes. `[data-theme=dark]` unquoted — yes (valid CSS,
 * and this file already uses the unquoted form in @custom-variant). `:root select` —
 * no: a descendant selector is a component rule, not the token block.
 */
function isDarkBlock(prelude) {
  if (prelude.startsWith('@')) return false;
  return prelude.split(',').some((sel) => {
    const s = sel.trim();
    if (/\[data-theme\s*=\s*["']?light["']?\]/.test(s)) return false;
    return s === ':root' || /^\[data-theme\s*=\s*["']?dark["']?\]$/.test(s);
  });
}

const isThemeBlock = (prelude) => /^@theme\b/.test(prelude);

const HEX = /#[0-9a-fA-F]{3,8}\b/;

// ── read ────────────────────────────────────────────────────────────────────────

const contract = JSON.parse(await readFile(CONTRACT, 'utf8'));
const raw = await readFile(CSS, 'utf8');
const parsed = blocks(stripComments(raw));

const guarded = contract.primitives;
const excused = contract.notGuarded ?? {};

const problems = [];

// ── 1 + 2 + 4: the token blocks ─────────────────────────────────────────────────

/** Effective value per token, per theme: last write wins, exactly like the cascade. */
const effectiveDark = new Map();
const effectiveLight = new Map();

for (const b of parsed) {
  const dark = isDarkBlock(b.prelude);
  const light = /\[data-theme\s*=\s*["']?light["']?\]/.test(b.prelude);
  if (!dark && !light) continue;

  for (const d of decls(b.body)) {
    if (!d.name.startsWith('lyx-')) continue;

    // 4 — a hex inside a function is a copy of a value that already has a name.
    if (/\(/.test(d.value) && HEX.test(d.value)) {
      problems.push(
        `--${d.name} embeds a raw hex inside a function:\n` +
        `         ${d.value}\n` +
        `       Reference the token instead — color-mix(in srgb, var(--lyx-x) …). A literal\n` +
        `       copy of a value that has a name will rot the next time the name changes.`
      );
    }

    if (dark) effectiveDark.set(d.name, d.value.toLowerCase());
    if (light) effectiveLight.set(d.name, d.value.toLowerCase());
  }
}

// The light ramp is NOT shared — but it IS recorded, so that anything drawing this
// surface (a design system, a preview) can show it truthfully instead of borrowing
// the other surface's light and lying about it. A record that drifts is a wrong
// answer with a house style, so it is guarded like everything else.
for (const [token, expected] of Object.entries(contract.productLight ?? {})) {
  const got = effectiveLight.get(token);
  if (got === undefined) {
    problems.push(`--${token} is gone from app.css's light block, but \`productLight\` still records it`);
  } else if (got !== expected.toLowerCase()) {
    problems.push(
      `--${token} (light)\n` +
      `       app.css:      ${got}\n` +
      `       productLight: ${expected}`
    );
  }
}

for (const [token, expected] of Object.entries(guarded)) {
  const got = effectiveDark.get(token);
  if (got === undefined) {
    problems.push(`--${token} is gone from app.css, but the contract still lists it`);
  } else if (got !== expected.toLowerCase()) {
    problems.push(
      `--${token}\n` +
      `       app.css (effective dark):  ${got}\n` +
      `       contract:                  ${expected}`
    );
  }
}

// 2 — the set can be seen growing, not only shrinking.
for (const token of effectiveDark.keys()) {
  if (token in guarded) continue;
  if (token in excused) continue;
  problems.push(
    `--${token} is a new --lyx-* token, and the contract says nothing about it.\n` +
    `       Add it to "primitives" if the other surface paints it too, or to\n` +
    `       "notGuarded" with a reason if it does not. Silence is the one option\n` +
    `       that is not available.`
  );
}

// ── 5: shape — theme-independent, so read it anywhere it is declared ────────────

const allDecls = new Map();
for (const b of parsed) for (const d of decls(b.body)) allDecls.set(d.name, d.value.trim());

for (const [token, expected] of Object.entries(contract.shape ?? {})) {
  const got = allDecls.get(token);
  if (got === undefined) {
    problems.push(`--${token} is gone from app.css, but the contract's \`shape\` still lists it`);
  } else if (got.toLowerCase() !== expected.toLowerCase()) {
    problems.push(
      `--${token} (shape)\n` +
      `       app.css:  ${got}\n` +
      `       contract: ${expected}`
    );
  }
}

// ── 6: type — only the FIRST family is the brand; the fallback stack is free ────

const firstFamily = (stack) => stack.split(',')[0].trim().replace(/^["']|["']$/g, '').trim();

for (const [token, expected] of Object.entries(contract.typeFamilies ?? {})) {
  const got = allDecls.get(token);
  if (got === undefined) {
    problems.push(`--${token} is gone from app.css, but the contract's \`typeFamilies\` still lists it`);
    continue;
  }
  const family = firstFamily(got);
  if (family.toLowerCase() !== expected.toLowerCase()) {
    problems.push(
      `--${token} leads with a different family\n` +
      `       app.css:  ${family}   (from: ${got})\n` +
      `       contract: ${expected}\n` +
      `       The fallback chain after it is yours — the first family is the brand.`
    );
  }
}

// ── 3: @theme inline is a mapping layer, not a place to define colour ───────────

for (const b of parsed.filter((x) => isThemeBlock(x.prelude))) {
  for (const d of decls(b.body)) {
    if (!HEX.test(d.value)) continue;
    problems.push(
      `--${d.name} in \`${b.prelude}\` is a literal colour: ${d.value}\n` +
      `       This block aliases tokens (--color-x: var(--lyx-x)) and is what the\n` +
      `       components actually consume. A literal here silently overrides the token\n` +
      `       it is supposed to map — the contract would still pass while the UI changed.`
    );
  }
}

// ── verdict ─────────────────────────────────────────────────────────────────────

if (problems.length) {
  console.error('\n✗ app.css does not hold up its end of tokens.contract.json:\n');
  for (const p of problems) console.error('  ' + p + '\n');
  console.error(
    '  These primitives are ONE brand painted on more than one surface. Changing a\n' +
    '  value here means the other surface has to follow — that is what the contract is\n' +
    '  for, and why you are being told now rather than by someone else later.\n' +
    '\n  Either revert, or update tokens.contract.json in the same change and carry it\n' +
    '  across. If a token genuinely stops being shared, move it to "notGuarded" and\n' +
    '  say why.\n'
  );
  process.exit(1);
}

const shared =
  Object.keys(guarded).length +
  Object.keys(contract.shape ?? {}).length +
  Object.keys(contract.typeFamilies ?? {}).length;

console.log(
  `✓ Token contract: ${shared} shared decisions hold — ` +
  `${Object.keys(guarded).length} colours (effective dark), ` +
  `${Object.keys(contract.shape ?? {}).length} radii, ` +
  `${Object.keys(contract.typeFamilies ?? {}).length} type families. ` +
  `${Object.keys(excused).length} tokens accounted for as not shared.`
);
