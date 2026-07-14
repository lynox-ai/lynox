#!/usr/bin/env node
/**
 * Shape contract — this repo, checked against itself.
 *
 * `tokens.contract.json` is about colour. This one is about FORM: the shapes a design
 * system elsewhere draws by hand, from reading these components.
 *
 * ── FOUR ROUNDS OF REVIEW, THREE OF WHICH BROKE THE GUARD ───────────────────────
 *
 * v1 GREPPED for a substring of the class attribute. Appending `border-2` left the
 * substring intact — the row went to 2px, the design system kept drawing 1px, ✓.
 *
 * v2 grepped for the WHOLE class attribute. Better, and still a grep: a review hid the
 * evidence in an HTML comment, then in a JS string, then in a `<template>`, each time
 * while replacing the real markup with a flat list. Stripping comments, then scripts,
 * then templates is a race you lose one hiding place at a time.
 *
 * v3 (this) PARSES. The evidence is the value of a class attribute on a real element in
 * the Svelte AST. A comment is not an element; a string is not an element; a `<template>`
 * is not rendered. There is nowhere left to park it, structurally, rather than by another
 * regex.
 *
 * ── AND A GREP CANNOT SEE A STYLESHEET AT ALL ───────────────────────────────────
 *
 * Every class attribute can stay byte-identical while CSS changes what the element
 * looks like. `.ai-badge { display: none }` deletes an EU AI Act Art. 50(1) disclosure
 * without touching markup. So app.css AND every component's own scoped `<style>` are
 * forbidden from targeting a class this contract names — the first version of this rule
 * checked only app.css, which left the six components that HAVE a `<style>` wide open,
 * including the one carrying four of the ten shapes.
 *
 * `0.5px` — and `.5px`, which the first regex missed — is banned as a CSS value. It is
 * the marketing site's hairline. The design system tells designers this package does not
 * use it, and that sentence was the last unguarded claim in the contract.
 *
 * The stylesheet ban catches a rule that NAMES a guarded class, by every spelling a
 * review found — `.foo`, escaped, `[class~=foo]`, and the substring forms `[class*=fo]`.
 * The shape ELEMENT itself is checked too: no inline `style=`, no `class:` directive
 * handing a `:global()` a hook the class check cannot see.
 *
 * ── THE ONE BOUNDARY, STATED PLAINLY ────────────────────────────────────────────
 *
 * A static parser cannot resolve an arbitrary selector to the elements it hits. A rule
 * that reaches a shape WITHOUT naming its class — `ul[role="list"] > li`,
 * `input[type=checkbox]` — is invisible here, because knowing it lands on the inbox row
 * needs the rendered DOM. That is a browser's job; the complete fix is to render the app
 * and photograph it, the way the design-system PAGE is rendered on the pro side. It is
 * deferred, on the record, as DEF-0124 — not pretended closed. app.css is a token and
 * base file by convention (fifteen selectors, all scrollbar utilities), which is the
 * social half of the same guarantee.
 *
 * Run: node packages/web-ui/scripts/check-shape-contract.mjs   (`pnpm shapes:contract`)
 */

import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { parse } from 'svelte/compiler';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
const CONTRACT = resolve(ROOT, 'shapes.contract.json');
const APP_CSS = resolve(ROOT, 'src/app.css');

const contract = JSON.parse(await readFile(CONTRACT, 'utf8'));
const problems = [];

// ── 0. the contract itself must assert something ────────────────────────────────
//
// `declarations: {}` used to pass while the guard printed "all 10 shapes render the way
// the app does". A shape that asserts nothing is not a shape, it is a comment.

const shapeNames = Object.keys(contract.shapes ?? {});
if (shapeNames.length === 0) problems.push('the contract lists no shapes at all');

for (const [name, s] of Object.entries(contract.shapes ?? {})) {
  if (!s.evidence?.classes?.length) problems.push(`${name}: no class evidence — it asserts nothing here`);
  if (!s.preview?.sample) problems.push(`${name}: no \`sample\` — the design system has nothing to probe`);
  if (!Object.keys(s.preview?.declarations ?? {}).length) {
    problems.push(`${name}: \`declarations\` is empty — the design system could draw anything`);
  }
}

// ── 1. the elements, from the AST ───────────────────────────────────────────────

/**
 * Every real element, with its class-attribute value, whether it carries an inline
 * `style=`, and any `class:NAME` directives on it. Not a grep: a parse.
 *
 * The element node — not just its class string — because a shape can be restyled without
 * touching a class: an inline `style="border-radius:0"` on the same element, or a
 * `class:zapped` directive paired with a `:global(.zapped){display:none}`. A grep for the
 * class attribute is blind to both.
 */
function elements(src) {
  const out = [];
  const ast = parse(src, { modern: true });
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n.type === 'RegularElement' || n.type === 'SvelteElement') {
      let classValue = null;
      let hasStyle = false;
      const classDirectives = [];
      for (const a of n.attributes ?? []) {
        if (a.type === 'Attribute' && a.name === 'class') {
          const raw = src.slice(a.start, a.end);
          const eq = raw.indexOf('=');
          if (eq !== -1) classValue = raw.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
        } else if (a.type === 'Attribute' && a.name === 'style') {
          hasStyle = true;
        } else if (a.type === 'ClassDirective') {
          classDirectives.push(a.name);
        }
      }
      out.push({ classValue, hasStyle, classDirectives });
    }
    for (const k of Object.keys(n)) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') walk(v);
    }
  };
  walk(ast.fragment);
  return out;
}

/** The real utility classes in a class value: text outside `{…}`, plus string literals inside. */
function utilityClasses(value) {
  const outside = value.replace(/\{[^}]*\}/g, ' ');
  const inside = [...value.matchAll(/\{[^}]*\}/g)]
    .flatMap((m) => [...m[0].matchAll(/'([^']*)'|"([^"]*)"/g)].map((x) => x[1] ?? x[2]));
  return [outside, ...inside].join(' ').split(/\s+/).filter(Boolean);
}

const sources = new Map();
const guardedClasses = new Set();

for (const [name, shape] of Object.entries(contract.shapes)) {
  let src = sources.get(shape.source);
  if (src === undefined) {
    try {
      src = await readFile(resolve(ROOT, shape.source), 'utf8');
      sources.set(shape.source, src);
    } catch {
      problems.push(`${name}: its source is gone — ${shape.source}`);
      continue;
    }
  }

  let els;
  try {
    els = elements(src);
  } catch (e) {
    problems.push(`${name}: ${shape.source} does not parse as Svelte — ${e.message}`);
    continue;
  }

  for (const ev of shape.evidence.classes ?? []) {
    const carrier = els.find((e) => e.classValue === ev);
    if (carrier) {
      for (const c of utilityClasses(ev)) guardedClasses.add(c);
      // A shape's own element must not be restyled out from under its classes. An inline
      // `style=` does it directly; a `class:NAME` directive does it by handing a
      // stylesheet a hook (`:global(.NAME)`) the class-attribute check never sees. So the
      // element carries neither — and any class it toggles becomes a guarded class too,
      // so a rule that targets it is caught by the stylesheet ban below.
      if (carrier.hasStyle) {
        problems.push(
          `${name}: the element carrying this shape has an inline \`style=\` in ${shape.source}.\n` +
          `       Inline style restyles the shape while its class attribute stays byte-identical,\n` +
          `       which the class check cannot see. Style it through utilities, or move the shape.`
        );
      }
      for (const d of carrier.classDirectives) guardedClasses.add(d);
      continue;
    }
    problems.push(
      `${name} — no element in ${shape.source} carries this class attribute:\n\n` +
      `         ${ev}\n\n` +
      `       This is the value of a real element's \`class\`, read out of the Svelte AST,\n` +
      `       so it cannot be satisfied by a comment, a string or a <template> — three\n` +
      `       hiding places a review used, one per round, against the version that grepped.\n\n` +
      `       Either the shape moved — update shapes.contract.json AND the design system's\n` +
      `       product page in the same change — or it was reformatted and the evidence needs\n` +
      `       re-copying. What is not an option is leaving the design system drawing a shape\n` +
      `       this app no longer has.`
    );
  }

  for (const ev of shape.evidence.css ?? []) {
    if (src.includes(ev)) continue;
    problems.push(`${name}: ${shape.source} no longer declares \`${ev}\``);
  }
}

// ── 2. no stylesheet may restyle a shape out from under its classes ─────────────
//
// WHAT THIS CANNOT DO, said before the code so nobody trusts it further: a static parser
// cannot resolve an arbitrary selector to the elements it hits. A rule that reaches a
// shape WITHOUT naming its class — `ul[role="list"] > li { … }`, `input[type=checkbox]` —
// is invisible here, because knowing it lands on the inbox row needs the rendered DOM,
// which is a browser's job. The complete fix is to render the app and photograph it (as
// the design-system page IS rendered on the pro side); that is deferred (DEF-0124). What
// IS closed: any rule that names a guarded class, by any spelling — `.foo`, the escaped
// `.rounded-\[…\]`, `[class~=foo]`, and the substring forms `[class*=fo]` / `^` / `$`.

/** Brace-matched top-level rules, `{selector, body}`. Parens and escapes survive. */
function rules(css) {
  const out = [];
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open === -1) break;
    const selector = css.slice(i, open).split(/[;}]/).pop().trim();
    let depth = 1;
    let j = open + 1;
    while (j < css.length && depth > 0) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}') depth--;
      j++;
    }
    const body = css.slice(open + 1, j - 1);
    if (selector && !selector.startsWith('@') && !/[{}]/.test(body)) {
      out.push({ selector, body: body.replace(/\s+/g, ' ').trim() });
    }
    // Recurse: a rule nested in @media/@layer is still a rule.
    out.push(...rules(css.slice(open + 1, j - 1)));
    i = j;
  }
  return out;
}

/** Does this selector target one of the guarded classes, by any spelling? Returns it, or null. */
function targetsGuarded(selector) {
  for (const m of selector.matchAll(/\.((?:\\.|[\w-])+)/g)) {
    const c = m[1].replace(/\\(.)/g, '$1');
    if (guardedClasses.has(c)) return c;
  }
  // Attribute selectors on `class`. `~=`/`|=`/`=` name a whole token; `*=`/`^=`/`$=` name
  // a SUBSTRING — `[class*="ai-bad"]` reaches `.ai-badge` without ever writing it whole,
  // which is how a review deleted the badge past the token-only check.
  for (const m of selector.matchAll(/\[class([~^*$|]?)=\s*["']?([^"'\]]+)/g)) {
    const [, op, raw] = m;
    const val = raw.trim();
    for (const g of guardedClasses) {
      const hit =
        op === '*' ? g.includes(val)
        : op === '^' ? g.startsWith(val)
        : op === '$' ? g.endsWith(val)
        : val.split(/\s+/).includes(g); // '', '~', '|'
      if (hit) return g;
    }
  }
  // `[class]` bare — matches any element that has a class at all, guarded ones included.
  if (/\[class\s*\]/.test(selector) && guardedClasses.size) return '(any class)';
  return null;
}

// EVERY stylesheet in the library, not only the components the contract happens to cite.
// The first version scanned the cited ones, which left AppShell — whose <style> already
// uses `:global()` — free to hide `.ai-badge` app-wide with the guard printing a tick. A
// shape can be restyled from any file that ships, so every file that ships is read.
const stylesheets = [['src/app.css', await readFile(APP_CSS, 'utf8')]];
for (const dir of ['src/lib/components', 'src/lib/primitives']) {
  for (const f of (await readdir(resolve(ROOT, dir))).filter((x) => x.endsWith('.svelte'))) {
    const rel = join(dir, f);
    const src = sources.get(rel) ?? (await readFile(resolve(ROOT, rel), 'utf8'));
    for (const m of src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) stylesheets.push([rel, m[1]]);
  }
}

const allowed = contract.allowedStyleRules ?? {};
const seenAllowed = new Set();

for (const [file, css] of stylesheets) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const allowedHere = allowed[file] ?? {};
  for (const { selector, body } of rules(clean)) {
    // An allowed rule is checked by its BODY, not waved through by its selector. Allow-
    // listing `.lynox-checkbox` alone let a review add `border-radius:50%; width:40px` to
    // it and turn the square primitive into a big circle, guard green.
    if (selector in allowedHere) {
      seenAllowed.add(`${file}::${selector}`);
      if (body !== allowedHere[selector]) {
        problems.push(
          `${file}: the allowed rule \`${selector}\` has been restyled.\n\n` +
          `         is:       ${body}\n` +
          `         pinned:   ${allowedHere[selector]}\n\n` +
          `       This rule IS a shape — the design system draws it. Change it here and you\n` +
          `       change what the app looks like; update shapes.contract.json's\n` +
          `       allowedStyleRules and the design system in the same commit, or revert.`
        );
      }
      continue;
    }
    const cls = targetsGuarded(selector);
    if (!cls) continue;
    problems.push(
      `${file} targets \`${cls}\`, a class the shape contract depends on:\n\n` +
      `         ${selector} { … }\n\n` +
      `       A rule here changes what a shape LOOKS like while every class attribute\n` +
      `       stays byte-identical, so the AST check above cannot see it and the design\n` +
      `       system goes on drawing the old shape. \`.ai-badge { display: none }\` deletes\n` +
      `       an EU AI Act Art. 50(1) disclosure exactly this way.\n\n` +
      `       Style the component through its utilities, or change the shape properly —\n` +
      `       in the contract and in the design system, in the same commit.`
    );
  }
}

// Every pinned allowed rule must still exist — a shape cannot quietly lose its styling.
for (const [file, sels] of Object.entries(allowed)) {
  if (file === '$comment') continue;
  for (const selector of Object.keys(sels)) {
    if (seenAllowed.has(`${file}::${selector}`)) continue;
    problems.push(`${file}: the pinned rule \`${selector}\` is gone — the checkbox shape lost its styling`);
  }
}

// ── 3. the hairline this package does not have ──────────────────────────────────

// 0.5px AND .5px — the first version missed the second. The `(?<![\d.])` matters more than
// it looks: without it this fires on the `.5px` inside `2.5px`, and a ban that blocks real
// work gets deleted by the next person, which is the same as not having one.
const HAIRLINE = /(?<![\d.])0?\.50?px\b/;

for (const dir of ['src/app.css', 'src/lib']) {
  const files = dir.endsWith('.css')
    ? [dir]
    : (await readdir(resolve(ROOT, dir), { recursive: true }))
        .filter((f) => /\.(svelte|css)$/.test(f))
        .map((f) => join(dir, f));
  for (const f of files) {
    if (!HAIRLINE.test(await readFile(resolve(ROOT, f), 'utf8'))) continue;
    problems.push(
      `${f} uses a 0.5px hairline.\n\n` +
      `       That is the marketing site's idiom. This package does not use it, and the\n` +
      `       design system tells designers so in as many words — it is the sentence a\n` +
      `       review used, twice, to turn the inbox into a flat hairline-separated list.\n` +
      `       If the product genuinely wants hairlines now, that is a real decision: make\n` +
      `       it in the design system too, and delete this check.`
    );
  }
}

// ── 4. the counts and the state exceptions ──────────────────────────────────────

const allSvelte = [];
for (const dir of ['src/lib/components', 'src/lib/primitives']) {
  for (const f of (await readdir(resolve(ROOT, dir))).filter((x) => x.endsWith('.svelte'))) {
    allSvelte.push(join(dir, f));
  }
}

// RESTING borders only: the old regex had no left boundary and counted `hover:border-danger`.
const RESTING_SEMANTIC_BORDER = /(?<![\w:-])border-(danger|warning|success)(?![-/\w])/g;
let atRest = 0;
let successBorders = 0;
let styleComponents = 0;
let stylePrimitives = 0;

for (const f of allSvelte) {
  const src = await readFile(resolve(ROOT, f), 'utf8');
  if (/<style/.test(src)) {
    if (f.includes('primitives')) stylePrimitives++;
    else styleComponents++;
  }
  for (const m of src.matchAll(RESTING_SEMANTIC_BORDER)) {
    atRest++;
    if (m[1] === 'success') successBorders++;
  }
}

const ex = contract.stateExceptions ?? {};
if (atRest !== ex.fullStrengthSemanticBordersAtRest) {
  problems.push(
    `stateExceptions: the tree has ${atRest} full-strength semantic borders at rest, the\n` +
    `       contract says ${ex.fullStrengthSemanticBordersAtRest}. The design system gives that\n` +
    `       number to designers. It has been written wrong three times; if it moved, the\n` +
    `       prose moves with it, or it is a lie with a citation.`
  );
}
if (successBorders !== ex.fullStrengthSuccessBorders) {
  problems.push(
    `stateExceptions: ${successBorders} full-strength border-success now exist; the contract\n` +
    `       says ${ex.fullStrengthSuccessBorders}. The design system says success never does it.`
  );
}

const nComponents = allSvelte.filter((f) => f.includes('components')).length;
const nPrimitives = allSvelte.filter((f) => f.includes('primitives')).length;

const check = (label, got, want) => {
  if (got !== want) problems.push(`counts.${label}: the tree says ${got}, the contract says ${want}`);
};

check('components', nComponents, contract.counts.components);
check('primitives', nPrimitives, contract.counts.primitives);
check('scopedStyleComponents', styleComponents, contract.counts.scopedStyleComponents);
check('scopedStylePrimitives', stylePrimitives, contract.counts.scopedStylePrimitives);

const hasButton = allSvelte.some((f) => /\/Button[A-Z.]/.test('/' + f));
if (hasButton !== contract.counts.buttonComponent) {
  problems.push(
    hasButton
      ? `counts.buttonComponent: a Button component now exists. The design system says\n` +
        `       "there is no button component to match" — a designer is being told to invent\n` +
        `       something that has since been built.`
      : `counts.buttonComponent: the contract expects one, and there is none.`
  );
}

// ── verdict ─────────────────────────────────────────────────────────────────────

if (problems.length) {
  console.error('\n✗ The app no longer looks the way shapes.contract.json says it does:\n');
  for (const p of problems) console.error('  ' + p + '\n');
  console.error(
    '  A design system draws these shapes from this file. It cannot see this repo, so\n' +
    '  this is the only place the drift can be caught — and a design system that draws\n' +
    '  a shape the product does not have is worse than one that draws nothing.\n'
  );
  process.exit(1);
}

console.log(
  `✓ Shape contract: ${shapeNames.length} shapes still carried by real elements in the AST; ` +
  `${stylesheets.length} stylesheets target none of their ${guardedClasses.size} classes; ` +
  `no 0.5px hairline; ${atRest} full-strength semantic borders at rest (${successBorders} success); ` +
  `${nComponents} components, ${nPrimitives} primitives, no button component.`
);
