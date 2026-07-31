import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * Invariant guard: NO attacker-controlled image may reach the model.
 *
 * The engine's injection detection is TEXT-ONLY — `detectInjectionAttempt`
 * (`data-boundary.ts`) runs regexes over a string, and `wrapUntrustedData`
 * wraps strings. Neither can see inside a base64 image. That is not a defect
 * today, and the reason is a property nobody had written down until now:
 *
 *   an image content block has exactly ONE producer in the whole engine —
 *   the USER's own upload path (`server/http-api.ts`).
 *
 * Mail attachments do not become image blocks (they are fetched deliberately
 * via `mail_attachment_get`), no tool returns one, and nothing renders one from
 * fetched content. So every image the model sees was deliberately attached by
 * the user. The text-only detector is therefore a bounded gap, not an open one.
 *
 * This test is the tripwire for the moment that stops being true. The first
 * tool that RETURNS an image — a screenshot, a rendered attachment, an OCR
 * preview, a chart built from fetched data — silently routes attacker-shaped
 * content past every scanner we have. That change must not be able to land
 * quietly, and prose in a doc does not stop it; a failing test does.
 *
 * WHEN THIS TEST FAILS, the fix is NOT to extend the allowlist. It is to decide
 * how that image channel gets its own boundary (scan, wrap, or refuse), and
 * only then record the new producer here with that decision named.
 *
 * Honest limits of this guard, so nobody reads it as more than it is:
 *  - It matches the literal block shape `type: 'image'`. A producer that builds
 *    the block dynamically (`{ type: kind }`) is invisible to it. It is a
 *    tripwire for the ordinary shape, not a proof of absence.
 *  - It says nothing about whether the upload path itself is safe. It is not
 *    wrapped or scanned either — a user who uploads a screenshot of someone
 *    else's mail hands the model unscanned foreign text through a trusted-by-
 *    source channel. That is a separate, smaller question (see the register row
 *    DEF-three-unstated-security-invariants) and deliberately NOT what this
 *    test asserts.
 *
 * Implementation note: the sweep reads files with `readFileSync` and matches in
 * JS on purpose. A shell `grep` treats a NUL-tainted file as binary and returns
 * ZERO matches silently, which would turn this guard into a green no-op.
 */

const SRC_DIR = join(import.meta.dirname, '..');

/** Files allowed to construct an image content block, repo-relative with `/`. */
const ALLOWED_PRODUCERS: readonly string[] = [
  // The user's own upload: a human deliberately attaches an image to their
  // message. Trusted by source — this is the channel the invariant permits.
  'server/http-api.ts',
];

/** Every quoting form of an image-block discriminant we can match statically. */
const IMAGE_BLOCK = /type\s*:\s*(['"`])image\1/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

describe('image-block producers (untrusted-channel invariant)', () => {
  it('the ONLY producer of an image content block is the user upload path', () => {
    const producers = sourceFiles(SRC_DIR)
      .filter((f) => IMAGE_BLOCK.test(readFileSync(f, 'utf-8')))
      .map((f) => relative(SRC_DIR, f).split(sep).join('/'))
      .sort();

    expect(
      producers,
      'A new producer of image content blocks appeared. Images bypass the '
      + 'text-only injection detector AND wrapUntrustedData. Do not just add the '
      + 'file here — decide how that channel is bounded first, then record it '
      + 'with the decision. See DEF-three-unstated-security-invariants.',
    ).toEqual([...ALLOWED_PRODUCERS].sort());
  });

  it('the allowlist is not vacuous — the known producer really is detected', () => {
    // Guards the guard: if the sweep silently found nothing (wrong root, a
    // broken matcher, an extension filter that excludes everything), the test
    // above would still pass against an empty allowlist. This one fails then.
    const upload = join(SRC_DIR, 'server', 'http-api.ts');
    expect(IMAGE_BLOCK.test(readFileSync(upload, 'utf-8'))).toBe(true);
    expect(sourceFiles(SRC_DIR).length).toBeGreaterThan(100);
  });

  // The sweep above can only ever be as good as its matcher, and the real
  // source tree cannot prove the matcher: every producer in it today happens to
  // use single quotes, so narrowing IMAGE_BLOCK to /'image'/ leaves BOTH tests
  // above green while going blind to a double-quoted producer tomorrow.
  // (Verified — that mutation survived until this block existed.) The corpus has
  // to carry the distinction, so it is synthetic here: one line per quoting form
  // that must match, plus the near-misses that must not.
  it.each([
    ["single quotes", "content.push({ type: 'image', source: s });"],
    ["double quotes", 'content.push({ type: "image", source: s });'],
    ["backticks", 'content.push({ type: `image`, source: s });'],
    ["space before colon", "({ type : 'image' })"],
    ["no space after colon", "({ type:'image' })"],
  ])('the matcher catches an image block written with %s', (_form, line) => {
    expect(IMAGE_BLOCK.test(line)).toBe(true);
  });

  it.each([
    ["a different block kind", "({ type: 'text', text: t })"],
    ["a longer word starting with image", "({ type: 'images' })"],
    ["a media_type, not a block type", "({ media_type: 'image/png' })"],
    ["mismatched quotes", "({ type: 'image\" })"],
  ])('the matcher does NOT fire on %s', (_form, line) => {
    expect(IMAGE_BLOCK.test(line)).toBe(false);
  });
});
