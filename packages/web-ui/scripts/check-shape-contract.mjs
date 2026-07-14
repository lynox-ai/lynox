#!/usr/bin/env node
/**
 * Shape contract — this repo, checked against itself.
 *
 * `tokens.contract.json` is about colour. This one is about FORM: the handful of
 * shapes that carry what the app looks like — the chat turn, the tool call, the inbox
 * row, the state surface, the one primitive — which a design system elsewhere draws by
 * hand, from reading these components.
 *
 * ── WHY IT EXISTS ───────────────────────────────────────────────────────────────
 *
 * It was drawn by hand once, carefully, with a paragraph on the page promising the
 * shapes had been "read off the real Svelte". Two of the four were wrong:
 *
 *   - the inbox row was drawn FLAT, with 0.5px hairline separators and no selection
 *     state. The real row is a bordered card (`rounded-[var(--radius-sm)] border`) in a
 *     spaced list (`space-y-0.5`), whose dominant state is `border-accent bg-accent/5`.
 *     `0.5px` does not occur anywhere in this package — it is the marketing site's
 *     idiom, imported and then asserted as the product's;
 *   - the state surface was generalised into "a 10% tint with the same colour at FULL
 *     strength as a border, and the text stays the normal ink" — from the two warning
 *     callouts in LLMSettings. Across the tree there are 3 full-strength `border-danger`
 *     and 0 full-strength `border-success`, against ~90 fractional ones; the canonical
 *     surface is `bg-danger/10 border border-danger/20 text-danger`, and the text is
 *     never the normal ink.
 *
 * Both were plausible, both were sincere, and nothing in either repo could tell.
 *
 * So the reading is written down (`shapes.contract.json`) and checked from both ends.
 * This is the near end: every `evidence` string must still be present, literally, in
 * the component it was read from. Restyle a shape and this fails HERE, on the commit
 * that does it — not later, in a design system, silently, in front of a designer.
 *
 * The far end is the design system's own check, which asserts the CSS it draws matches
 * this file's `preview` declarations. It reads this contract over https, because this
 * repo is public — it needs no checkout of anything, and nothing here needs to know it
 * exists.
 *
 * The `counts` block is the same idea for the facts the design system states in prose
 * ("the app has N components", "there is no button component"). Prose rots quietly. The
 * first draft claimed 75 components, taken from a "~75" in a CLAUDE.md rather than from
 * the tree, which has 71.
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

// ── the shapes: every recorded class string still exists where it was read ───────

for (const [name, shape] of Object.entries(contract.shapes)) {
  let src;
  try {
    src = await readFile(resolve(ROOT, shape.source), 'utf8');
  } catch {
    problems.push(`${name}: its source is gone — ${shape.source}`);
    continue;
  }

  for (const ev of shape.evidence) {
    if (src.includes(ev)) continue;
    problems.push(
      `${name} — the design system draws this shape, and the class string it was\n` +
      `       read from is no longer in ${shape.source}:\n\n` +
      `         ${ev}\n\n` +
      `       Either this shape moved (update shapes.contract.json AND the design\n` +
      `       system's product page in the same change), or it was reformatted and the\n` +
      `       evidence needs re-copying. What is not an option is leaving the design\n` +
      `       system drawing a shape this app no longer has.`
    );
  }
}

// ── the counts: the prose facts, checked against the tree ────────────────────────

const svelteIn = async (dir) =>
  (await readdir(resolve(ROOT, dir))).filter((f) => f.endsWith('.svelte'));

const components = await svelteIn('src/lib/components');
const primitives = await svelteIn('src/lib/primitives');

const check = (label, got, want) => {
  if (got !== want) problems.push(`counts.${label}: the tree says ${got}, the contract says ${want}`);
};

check('components', components.length, contract.counts.components);
check('primitives', primitives.length, contract.counts.primitives);

// "There is no button component" — the design system tells designers this, because it
// changes what they can design against. It stops being true the moment someone adds one.
const allSvelte = [
  ...components.map((f) => join('src/lib/components', f)),
  ...primitives.map((f) => join('src/lib/primitives', f)),
];
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

let styleBlocks = 0;
for (const f of allSvelte) {
  const src = await readFile(resolve(ROOT, f), 'utf8');
  if (/<style/.test(src)) styleBlocks++;
}
check('scopedStyleBlocks', styleBlocks, contract.counts.scopedStyleBlocks);

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
  `✓ Shape contract: ${n} shapes still present in the components they were read from; ` +
  `${components.length} components, ${primitives.length} primitives, no button component.`
);
