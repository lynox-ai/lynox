#!/usr/bin/env node
/**
 * Shape contract — this repo, checked against itself.
 *
 * `tokens.contract.json` is about colour. This one is about FORM: the shapes that carry
 * what the app looks like — the chat turn, the tool call, the inbox row, the state
 * surface, the one primitive — which a design system elsewhere draws by hand, from
 * reading these components.
 *
 * ── WHY IT EXISTS ───────────────────────────────────────────────────────────────
 *
 * It was drawn by hand once, carefully, with a paragraph on the page promising the
 * shapes had been "read off the real Svelte". Two of the four were wrong: the inbox row
 * was drawn FLAT with 0.5px hairline separators (`0.5px` occurs nowhere in this package
 * — it is the marketing site's idiom), and the state surface was generalised from the
 * two warning callouts in LLMSettings into a rule most state surfaces do not follow.
 *
 * ── WHY IT CHECKS THE WHOLE CLASS ATTRIBUTE ─────────────────────────────────────
 *
 * The first version of this checked SUBSTRINGS — `src.includes(evidence)`. A review
 * broke it four ways in one sitting, every one of them printing ✓:
 *
 *   - appending `border-2` to the inbox row left the substring intact. The row went to
 *     2px; the design system kept drawing 1px;
 *   - the state surface was given `bg-danger border-danger text-text` on top of its
 *     existing classes — a full flood with normal ink, which the design system calls
 *     "shouting" and "never" — and the substring was still there;
 *   - the real `<ul>` was replaced with a flat `divide-y` list and the evidence moved
 *     into an HTML comment. The ORIGINAL LIE, re-landed, guard applauding;
 *   - the AI-disclosure badge was replaced with `class="hidden"`, evidence preserved in
 *     a comment.
 *
 * A substring check is orthogonal to whether the shape is still LIVE. So: comments are
 * stripped first, and the evidence is the WHOLE class attribute. Add a class, remove a
 * class, hide the element — the attribute changes and this fails.
 *
 * ── WHAT IT STILL DOES NOT CATCH ────────────────────────────────────────────────
 *
 * Said plainly, so nobody trusts it further than it goes: it checks the element still
 * carries these classes. Not that it is still rendered, still reachable, or still in the
 * place the design system shows it. A parent can hide it and this will not know. It
 * catches restyling — which is what actually happens.
 *
 * The far end is the design system's own check, which asserts the CSS it draws still
 * resolves to this file's `preview` declarations. It reads this contract over https,
 * because this repo is public — no checkout, and nothing here needs to know it exists.
 *
 * Run: node packages/web-ui/scripts/check-shape-contract.mjs   (`pnpm shapes:contract`)
 */

import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
const CONTRACT = resolve(ROOT, 'shapes.contract.json');

const contract = JSON.parse(await readFile(CONTRACT, 'utf8'));
const problems = [];

/** Markup inside a comment is not markup. This is the hole the substring check had. */
const live = (src) => src.replace(/<!--[\s\S]*?-->/g, '');

// ── the shapes: the whole class attribute, still there, still not commented out ──

for (const [name, shape] of Object.entries(contract.shapes)) {
  let src;
  try {
    src = live(await readFile(resolve(ROOT, shape.source), 'utf8'));
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
      `       trips it. That is deliberate: a substring check let a 1px row become 2px\n` +
      `       while the design system went on drawing 1px.\n\n` +
      `       Either this shape moved — update shapes.contract.json AND the design\n` +
      `       system's product page in the same change — or it was reformatted and the\n` +
      `       evidence needs re-copying. What is not an option is leaving the design\n` +
      `       system drawing a shape this app no longer has.`
    );
  }
}

// ── the state exceptions: counted, because both attempts to state them as a rule failed

const allSvelte = [];
for (const dir of ['src/lib/components', 'src/lib/primitives']) {
  for (const f of (await readdir(resolve(ROOT, dir))).filter((x) => x.endsWith('.svelte'))) {
    allSvelte.push(join(dir, f));
  }
}

const FULL_SEMANTIC_BORDER = /border-(danger|warning|success)(?![-/\w])/g;
let fullBorders = 0;
let fullSuccess = 0;
let styleBlocks = 0;

for (const f of allSvelte) {
  const src = await readFile(resolve(ROOT, f), 'utf8');
  if (/<style/.test(src)) styleBlocks++;
  for (const m of src.matchAll(FULL_SEMANTIC_BORDER)) {
    fullBorders++;
    if (m[1] === 'success') fullSuccess++;
  }
}

const ex = contract.stateExceptions ?? {};
if (fullBorders !== ex.fullStrengthSemanticBorders) {
  problems.push(
    `stateExceptions: the tree has ${fullBorders} full-strength semantic borders, the\n` +
    `       contract says ${ex.fullStrengthSemanticBorders}.\n\n` +
    `       The design system tells designers the app "almost never" does this, and gives\n` +
    `       the number. That sentence has now been written wrong twice — once counting\n` +
    `       only border-danger and calling it "the whole tree". If the number moved, the\n` +
    `       prose moves with it, or it is a lie with a citation.`
  );
}
if (fullSuccess !== ex.fullStrengthSuccessBorders) {
  problems.push(
    `stateExceptions: ${fullSuccess} full-strength border-success now exist; the contract\n` +
    `       says ${ex.fullStrengthSuccessBorders}. The design system says success never does it.`
  );
}

// ── the counts: the prose facts, checked against the tree ────────────────────────

const nComponents = allSvelte.filter((f) => f.includes('components')).length;
const nPrimitives = allSvelte.filter((f) => f.includes('primitives')).length;

const check = (label, got, want) => {
  if (got !== want) problems.push(`counts.${label}: the tree says ${got}, the contract says ${want}`);
};

check('components', nComponents, contract.counts.components);
check('primitives', nPrimitives, contract.counts.primitives);
check('scopedStyleBlocks', styleBlocks, contract.counts.scopedStyleBlocks);

// "There is no button component" — the design system tells designers this, because it
// changes what they can design against. It stops being true the moment someone adds one.
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

const n = Object.keys(contract.shapes).length;
console.log(
  `✓ Shape contract: ${n} shapes still carried by the elements they were read from; ` +
  `${fullBorders} full-strength semantic borders (${fullSuccess} success); ` +
  `${nComponents} components, ${nPrimitives} primitives, no button component.`
);
