/**
 * Characters a reader does not see, and the few places text may carry one anyway.
 *
 * A text a bulk run acts on is read by a model as it is. What the owner reads must be that text
 * too, so a character that shows nothing, or reorders what is shown, is either refused (a judge
 * rule at planning) or shown as its code point (the bulk pages). Hidden is a class, not a list:
 * every default-ignorable code point (format characters, joiners, variation selectors, the tag
 * block, fillers), every control and format character, the line and paragraph separators, the
 * braille blank and the noncharacters. Tab, newline and carriage return are text.
 *
 * Real text needs a few of them. Each is taken only where real text puts it, never in a run, and
 * at most HIDDEN_ALLOWED_MAX times in one text; anywhere else it is hidden like the rest, because
 * a free choice of where to put one is a channel the reader does not see. Within those places the
 * choice to put one or not remains, and the cap bounds it:
 * - ZWJ (U+200D) between two parts of an emoji, as in a family or a profession;
 * - the emoji variation selector (U+FE0F) once, right after an emoji, and after a digit, # or *
 *   only in a keycap; the other variation selectors are hidden;
 * - ZWNJ (U+200C) and the soft hyphen (U+00AD) between two letters;
 * - the direction marks LRM, RLM and ALM (U+200E, U+200F, U+061C) right after a letter, before a
 *   letter, a space, a digit or punctuation.
 *
 * This file exists twice, byte for byte: `src/core/hidden-chars.ts` in the engine and
 * `packages/web-ui/src/lib/hidden-chars.ts` in the web UI, which is a package of its own.
 * `tests/hidden-chars-drift.test.ts` fails when the two differ.
 */

const HIDDEN = /[\p{Default_Ignorable_Code_Point}\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Noncharacter_Code_Point}\u2800]/u;
const TEXT_CONTROLS = new Set([0x09, 0x0a, 0x0d]);
const ZWJ = 0x200d;
const VS16 = 0xfe0f;
const KEYCAP = 0x20e3;
const BETWEEN_LETTERS = new Set([0x200c, 0x00ad]);
const DIRECTION_MARKS = new Set([0x200e, 0x200f, 0x061c]);
const PICTOGRAPH = /\p{Extended_Pictographic}/u;
const EMOJI_MODIFIER = /\p{Emoji_Modifier}/u;
const EMOJI = /\p{Emoji}/u;
const KEYCAP_BASE = /[0-9#*]/;
const LETTER = /[\p{L}\p{M}]/u;
const AFTER_MARK = /[\p{L}\p{M}\p{N}\p{P}\p{Zs}]/u;

/** The hidden characters real text may carry in a place of its own, as listed above. One of
 *  them is not shown where it stands in such a place, so a bulk page marks it where a run adds
 *  one (`bulk-hidden-adds.ts`). */
export const IN_PLACE_CHARS: ReadonlySet<number> = new Set([ZWJ, VS16, ...BETWEEN_LETTERS, ...DIRECTION_MARKS]);

/** HTML's names for the characters above that have one; the soft hyphen's is also read without
 *  its `;`, as a browser reads it. */
const IN_PLACE_NAMES: Readonly<Record<string, number>> = { shy: 0x00ad, zwnj: 0x200c, zwj: 0x200d, lrm: 0x200e, rlm: 0x200f };
// Leading zeros are read in any number, as a browser reads them; a number left over after them that
// is longer than these bounds is above U+10FFFF, which a browser reads as U+FFFD.
const REFERENCE = /&(?:#[xX]0*([0-9a-fA-F]{1,8});?|#0*([0-9]{1,10});?|(shy|zwnj|zwj|lrm|rlm);|(shy))/g;

/** In HTML source, every character reference that a browser may turn into one of
 *  {@link IN_PLACE_CHARS} — `&shy;`, `&#173;`, `&#xAD;` and the like — by its place in `text`
 *  (UTF-16 offsets, `end` exclusive). The source shows such a reference as text, but the page it
 *  renders carries the character, so a bulk page marks it with the rest. It errs toward more: a
 *  bare `&shy` in an attribute, which a browser leaves as it is, is found too. Counting is the
 *  engine's, over the parsed value. */
export function inPlaceReferences(text: string): { start: number; end: number; cp: number }[] {
  const out: { start: number; end: number; cp: number }[] = [];
  for (const m of text.matchAll(REFERENCE)) {
    const name = m[3] ?? m[4];
    const cp = name !== undefined ? IN_PLACE_NAMES[name]! : parseInt(m[1] ?? m[2]!, m[1] !== undefined ? 16 : 10);
    if (IN_PLACE_CHARS.has(cp)) out.push({ start: m.index, end: m.index + m[0].length, cp });
  }
  return out;
}

/** The most hidden characters one text may carry in the places it may carry one. */
export const HIDDEN_ALLOWED_MAX = 32;

/** The indexes, counted in characters (code points), of every hidden character in `text`.
 *  `inPlace: false` takes none of them in any place: for a value that is not running text, such
 *  as one of a fixed set of choices. */
export function hiddenCharIndexes(text: string, opts: { inPlace?: boolean } = {}): number[] {
  const takeInPlace = opts.inPlace ?? true;
  const chars = Array.from(text);
  const hidden: boolean[] = [];
  const out: number[] = [];
  let allowed = 0;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!;
    const cp = c.codePointAt(0)!;
    let isHidden: boolean;
    if (TEXT_CONTROLS.has(cp) || !HIDDEN.test(c)) {
      isHidden = false;
    } else if (takeInPlace && inPlace(chars, hidden, i, cp) && allowed < HIDDEN_ALLOWED_MAX) {
      allowed++;
      isHidden = false;
    } else {
      isHidden = true;
    }
    hidden.push(isHidden);
    if (isHidden) out.push(i);
  }
  return out;
}

/** The index, in characters, of the first hidden character in `text`, or -1. */
export function hiddenCharAt(text: string, opts: { inPlace?: boolean } = {}): number {
  const at = hiddenCharIndexes(text, opts);
  return at.length === 0 ? -1 : at[0]!;
}

/** Whether the hidden character at `i` stands where real text puts it. `hidden` holds the
 *  verdict on every character before `i`; one that is hidden is no neighbour to stand next to. */
function inPlace(chars: string[], hidden: boolean[], i: number, cp: number): boolean {
  const prev = i > 0 && !hidden[i - 1] ? chars[i - 1]! : undefined;
  const next = chars[i + 1];
  const prevCp = prev?.codePointAt(0);
  if (cp === ZWJ) {
    const prevEmoji = prev !== undefined && (PICTOGRAPH.test(prev) || EMOJI_MODIFIER.test(prev) || prevCp === VS16);
    return prevEmoji && next !== undefined && PICTOGRAPH.test(next);
  }
  if (cp === VS16) {
    // VS16 is no emoji itself, so a second one in a row is refused here too.
    if (prev === undefined || !EMOJI.test(prev)) return false;
    return KEYCAP_BASE.test(prev) ? next?.codePointAt(0) === KEYCAP : true;
  }
  if (BETWEEN_LETTERS.has(cp)) {
    return prev !== undefined && LETTER.test(prev) && next !== undefined && LETTER.test(next);
  }
  if (DIRECTION_MARKS.has(cp)) {
    return prev !== undefined && LETTER.test(prev) && next !== undefined && AFTER_MARK.test(next);
  }
  return false;
}
