#!/usr/bin/env node
/**
 * Shape contract — this repo, checked against itself.
 *
 * `tokens.contract.json` is about colour. This one is about FORM: the shapes that carry
 * what the app looks like — the chat turn, the tool call, the inbox row, the state
 * surface, the one primitive — which a design system elsewhere draws by hand, from
 * reading these components.
 *
 * ── WHAT THIS CHECKS, EXACTLY ───────────────────────────────────────────────────
 *
 * That the element carrying each shape is still CLASSED the way it was read. Not that
 * it still LOOKS that way. The distinction cost a review round: a previous version of
 * this header said "restyle the chat and it fails here", and it does not — a stylesheet
 * can restyle an element in place without touching a single class.
 *
 * So the stylesheet path is closed separately, by two rules rather than by a claim:
 *
 *   - app.css may not target any class this contract names. It is a token and base
 *     file (fifteen selectors, all scrollbar utilities); a rule in it aimed at
 *     `.ai-badge`, or redefining `.border-l-2`, is not a style, it is a shape change
 *     wearing a stylesheet. `.ai-badge { display: none }` would have deleted an EU AI
 *     Act Art. 50(1) disclosure with every class attribute byte-identical.
 *
 *   - `0.5px` is banned as a CSS value. It is the marketing site's hairline; this
 *     package does not use it, and the design system tells designers so. That sentence
 *     was the only unguarded claim left, and it was the one a review used to turn the
 *     inbox into hairline-separated rows from app.css.
 *
 * Evidence is matched with comments AND <script> blocks stripped: two rounds of review
 * hid the evidence in a comment, then in a string, while replacing the real markup.
 *
 * ── WHY THE EVIDENCE IS THE WHOLE CLASS ATTRIBUTE ───────────────────────────────
 *
 * The first version compared substrings. Appending `border-2` to the inbox row left the
 * substring intact — the row went to 2px while the design system kept drawing 1px, ✓.
 * A substring check is orthogonal to whether the shape is still live.
 *
 * The far end — the design system's own check — RENDERS its product page in a browser
 * and reads getComputedStyle off the real elements. It does not parse CSS. That took two
 * rounds to learn: a hand-written cascade model was walked around by a longhand after a
 * shorthand, by a higher-specificity selector, by `!important`, by an inline style. A
 * model of the pixel is not the pixel.
 *
 * Run: node packages/web-ui/scripts/check-shape-contract.mjs   (`pnpm shapes:contract`)
 */

import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
const CONTRACT = resolve(ROOT, 'shapes.contract.json');
const APP_CSS = resolve(ROOT, 'src/app.css');

const contract = JSON.parse(await readFile(CONTRACT, 'utf8'));
const problems = [];

/** Markup inside a comment is not markup. Nor is markup inside a string. */
const liveMarkup = (src) =>
  src.replace(/<!--[\s\S]*?-->/g, '').replace(/<script[\s\S]*?<\/script>/g, '');

// ── 1. the shapes: the whole class attribute, still on a live element ────────────

for (const [name, shape] of Object.entries(contract.shapes)) {
  let src;
  try {
    src = liveMarkup(await readFile(resolve(ROOT, shape.source), 'utf8'));
  } catch {
    problems.push(`${name}: its source is gone — ${shape.source}`);
    continue;
  }

  for (const ev of shape.evidence) {
    if (src.includes(ev)) continue;
    problems.push(
      `${name} — the design system draws this shape, and the element it was read from no\n` +
      `       longer carries these classes in ${shape.source}:\n\n` +
      `         ${ev}\n\n` +
      `       This is the WHOLE class attribute, so a single added or removed utility\n` +
      `       trips it, and it must be in live markup — not in a comment, not in a\n` +
      `       string. Both of those were used to walk past the earlier version.\n\n` +
      `       Either the shape moved — update shapes.contract.json AND the design\n` +
      `       system's product page in the same change — or it was reformatted and the\n` +
      `       evidence needs re-copying. What is not an option is leaving the design\n` +
      `       system drawing a shape this app no longer has.`
    );
  }
}

// ── 2. app.css may not restyle a shape out from under its classes ───────────────

/** Every class name the contract's evidence mentions — utilities included. */
const guardedClasses = new Set();
for (const shape of Object.values(contract.shapes)) {
  for (const ev of shape.evidence) {
    for (const m of ev.matchAll(/class="([^"]*)"/g)) {
      // Drop Svelte expressions; keep the literal utilities, including those inside them.
      for (const tok of m[1].replace(/[{}?:'"]/g, ' ').split(/\s+/)) {
        if (tok && /^[a-zA-Z][\w:./[\]()%-]*$/.test(tok)) guardedClasses.add(tok);
      }
    }
  }
}

const appCss = (await readFile(APP_CSS, 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '');

// Selectors only: the text before each `{`, minus at-rule preludes.
for (const m of appCss.matchAll(/([^{}();@]+)\{/g)) {
  const selector = m[1].trim();
  if (!selector || selector.startsWith('@')) continue;
  for (const c of selector.matchAll(/\.((?:[\w-]|\\.)+)/g)) {
    const cls = c[1].replace(/\\(.)/g, '$1'); // `space-y-0\.5` → `space-y-0.5`
    if (!guardedClasses.has(cls)) continue;
    problems.push(
      `app.css targets \`.${cls}\`, which is a class the shape contract depends on:\n\n` +
      `         ${selector} { … }\n\n` +
      `       A rule here can change what a shape LOOKS like while every class attribute\n` +
      `       stays byte-identical — the evidence check above cannot see it, and the\n` +
      `       design system would go on drawing the old shape. \`.ai-badge { display:\n` +
      `       none }\` would have deleted an EU AI Act Art. 50(1) disclosure exactly this\n` +
      `       way. app.css is tokens and base; style the component, not this file.`
    );
  }
}

// ── 3. the hairline the design system says this package does not have ───────────

for (const dir of ['src/app.css', 'src/lib']) {
  const files = dir.endsWith('.css')
    ? [dir]
    : (await readdir(resolve(ROOT, dir), { recursive: true }))
        .filter((f) => /\.(svelte|css)$/.test(f))
        .map((f) => join(dir, f));
  for (const f of files) {
    const src = await readFile(resolve(ROOT, f), 'utf8');
    if (!/\b0\.5px\b/.test(src)) continue;
    problems.push(
      `${f} uses \`0.5px\`.\n\n` +
      `       That is the marketing site's hairline. This package does not use it, and the\n` +
      `       design system tells designers so in as many words — it is the sentence a\n` +
      `       review used to turn the inbox into a flat hairline-separated list from a\n` +
      `       stylesheet, with every class attribute intact. If the product genuinely\n` +
      `       wants hairlines now, that is a real decision: make it in the design system\n` +
      `       too, and delete this check.`
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

// RESTING borders only. The previous regex had no left boundary, so `hover:border-danger`
// counted — and the design system's prose then claimed a destructive button carries a
// full-strength border when it does not until you point at it.
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
    `       contract says ${ex.fullStrengthSemanticBordersAtRest}.\n\n` +
    `       The design system tells designers the app "almost never" does this, and gives\n` +
    `       the number. That sentence has now been written wrong three times. If the\n` +
    `       number moved, the prose moves with it, or it is a lie with a citation.`
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
// Split, because "six COMPONENTS carry scoped CSS" was false — it is five components and
// one primitive — and the old check counted them in one bucket, so it could never fail
// on the sentence it existed to protect.
check('scopedStyleComponents', styleComponents, contract.counts.scopedStyleComponents);
check('scopedStylePrimitives', stylePrimitives, contract.counts.scopedStylePrimitives);

const hasButton = allSvelte.some((f) => /\/Button[A-Z.]/.test('/' + f));
if (hasButton !== contract.counts.buttonComponent) {
  problems.push(
    hasButton
      ? `counts.buttonComponent: a Button component now exists. The design system says\n` +
        `       "there is no button component to match" — that is now false, and a\n` +
        `       designer is being told to invent something that has since been built.`
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
  `✓ Shape contract: ${Object.keys(contract.shapes).length} shapes still classed as read; ` +
  `app.css targets none of their classes; no 0.5px hairline; ` +
  `${atRest} full-strength semantic borders at rest (${successBorders} success); ` +
  `${nComponents} components, ${nPrimitives} primitives, no button component.`
);
