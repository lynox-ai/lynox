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
 *   every image the model sees was deliberately attached by the USER.
 *
 * Mail attachments do not become image blocks (they are fetched deliberately
 * via `mail_attachment_get`), and nothing renders one from fetched content. The
 * text-only detector is therefore a bounded gap, not an open one.
 *
 * This file guards the two independent things that keep it true.
 *
 * (1) NO TOOL CAN RETURN AN IMAGE — and that is enforced by a TYPE, not by the
 *     producer count: `ToolHandler` returns `Promise<string>` (`types/tools.ts`),
 *     and `agent.ts` puts exactly that string into `tool_result.content`. A
 *     screenshot tool, a rendered attachment, an OCR preview cannot express
 *     themselves today. Widening that return type to accept content blocks is
 *     the single change that opens the channel, and the producer sweep below
 *     would stay green through it — so it gets its own assert.
 *
 * (2) ONE LITERAL CONSTRUCTOR, the user upload path. The sweep below.
 *
 * WHEN EITHER FAILS, the fix is NOT to extend the allowlist. It is to decide
 * how that image channel gets its own boundary (scan, wrap, or refuse), and
 * only then record it here with that decision named.
 *
 * Honest limits of this guard, so nobody reads it as more than it is:
 *  - "One producer" means one **literal constructor**. Images are also FORWARDED
 *    without a literal, and those paths are legitimate because they only move
 *    blocks that already passed (1): `compaction-messages.ts` re-attaches
 *    carried images across a summary, and `session-store.ts` revives stored
 *    message content via `JSON.parse`. Neither creates a new image SOURCE — but
 *    a future path that writes message rows from a non-user origin (a thread
 *    import, a shared thread) would inherit an image channel through the second
 *    one without tripping anything here.
 *  - A block built dynamically is only partly visible: the media-type ternary
 *    shape is covered below, an indirection through a variable is not. Tripwire
 *    for the ordinary shapes, not a proof of absence.
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
const IMAGE_BLOCK = /(?:type\s*:\s*|\?\s*)(['"`])image\1/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(?:m|c)?tsx?$/.test(entry.name)
             && !entry.name.endsWith('.test.ts')
             && !entry.name.endsWith('.d.ts')) out.push(full);
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
      + 'with the decision. If the match is a TYPE declaration rather than a new '
      + 'producer, tighten the matcher — never the allowlist. '
      + 'See DEF-three-unstated-security-invariants.',
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
    ["a media-type ternary", "({ type: mt.startsWith('image/') ? 'image' : 'document' })"],
  ])('the matcher catches an image block written with %s', (_form, line) => {
    expect(IMAGE_BLOCK.test(line)).toBe(true);
  });

  it('no tool can return an image at all — ToolHandler is still string-only', () => {
    // The real chokepoint for "a tool returns a screenshot". The sweep above
    // cannot see this: widening the return type adds no `type: 'image'` literal
    // anywhere, so every other assert in this file would stay green while the
    // channel opened. Verified by mutation: relaxing this declaration fails
    // HERE and nowhere else.
    const tools = readFileSync(join(SRC_DIR, 'types', 'tools.ts'), 'utf-8');
    expect(
      /export type ToolHandler<[^>]*>\s*=\s*\n?\s*\([^)]*\)\s*=>\s*Promise<string>;/.test(tools),
      'ToolHandler no longer returns a bare string. A tool that can return '
      + 'content blocks can return an IMAGE, which bypasses the text-only '
      + 'injection detector and wrapUntrustedData. Decide how that channel is '
      + 'bounded before widening this type.',
    ).toBe(true);
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
