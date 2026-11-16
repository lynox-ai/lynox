// Which hidden characters a bulk target's after-state adds over its before-image, in place.
//
// A character real text may carry in a place of its own (`IN_PLACE_CHARS`: a soft hyphen or
// ZWNJ between letters, a direction mark after one, an emoji's joiner or presentation selector)
// is not shown where it stands in such a place, and neither the judge's check nor the markup
// check refuses it there. In public store text it is a channel the owner does not see, so the
// preview marks it. Counted per field and per code point: when the after-state holds more of one
// than the before-image, every occurrence of it in that field is marked. Which of them is new
// cannot be told without an alignment, and an alignment can be gamed. As many or fewer: none.

import { IN_PLACE_CHARS } from './hidden-chars.js';
import { htmlTextsOfTree } from './bulk-html.js';
import { readWithinBounds } from './html-tree.js';

/** A field whose after-state holds more of these code points than its before-image. `field` is
 *  `''` for a target whose value is one text, not an object of fields. `html`: an HTML field, whose
 *  character references (`&shy;`, `&#x200C;`) count and are marked with the characters. */
export interface FieldHiddenAdds {
  field: string;
  codePoints: number[];
  html?: true | undefined;
  /** An HTML field whose before-image or after-state is past the reading bounds: not parsed, so
   *  whether it adds one is not known. It names no code point, and is counted on its own, never
   *  as a field that adds. */
  unread?: true | undefined;
}

/** Per code point of {@link IN_PLACE_CHARS}: how often `text` holds it. An HTML value is counted
 *  over the texts the parser yields, as `checkMarkup` counts it: text nodes and attribute values
 *  with their references resolved (`&shy;` and `&#00173;` count as the character, `&shy=` in an
 *  attribute does not), comments as written. So a character the before-image holds where the
 *  page does not show it as text, in a comment or an attribute, counts as held all the same. The
 *  page places its marks by `inPlaceReferences`, which may mark one more; it counts nothing. */
function counts(text: string, html: boolean): Map<number, number> | null {
  // An HTML value is parsed once, within the reading bounds; past them it reads as unread, never
  // as empty.
  let texts: string[] = [text];
  if (html) {
    const tree = readWithinBounds(text);
    if (tree === null) return null;
    texts = htmlTextsOfTree(tree);
  }
  const out = new Map<number, number>();
  for (const t of texts) {
    for (const c of t) {
      const cp = c.codePointAt(0)!;
      if (IN_PLACE_CHARS.has(cp)) out.set(cp, (out.get(cp) ?? 0) + 1);
    }
  }
  return out;
}

/** The code points of {@link IN_PLACE_CHARS} that `after` holds more often than `before`, in
 *  ascending order; in an HTML field (`html`), its character references counted with them. */
export function hiddenAddsOf(before: string | null, after: string, html = false): number[] {
  return hiddenAddsRead(before, after, html) ?? [];
}

/** {@link hiddenAddsOf} for a value the owner copies into the shop by hand, where no sentence can
 *  say "not checked": a before-image past the reading bounds counts as empty, so every such
 *  character the value holds is marked. `after` itself past the bounds marks nothing. */
export function hiddenAddsToCopy(before: string | null, after: string): number[] {
  return hiddenAddsRead(before, after, true) ?? hiddenAddsRead(null, after, true) ?? [];
}

/** {@link hiddenAddsOf}, or `null` when either side is an HTML value past the reading bounds and
 *  was not read: what it adds is then not known, in neither direction. */
function hiddenAddsRead(before: string | null, after: string, html: boolean): number[] | null {
  const added = counts(after, html);
  if (added === null) return null;
  const held = counts(before ?? '', html);
  if (held === null) return null;
  return [...added].filter(([cp, n]) => n > (held.get(cp) ?? 0)).map(([cp]) => cp).sort((a, b) => a - b);
}

/** A value as the page shows it, for counting: text as it is, anything else as its JSON, which
 *  writes these characters as they are (it escapes only controls and lone surrogates). */
function shownText(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/** Per field of a target's after-state, the code points it adds; a field that adds none is left
 *  out. A field that is not text counts by its JSON, as the page shows it, so a string nested in
 *  an object is counted too. A target whose value is not an object of fields is one field, `''`.
 *  `htmlFields`: the run's HTML fields, whose character references count too. */
export function targetHiddenAdds(prior: unknown, after: unknown, htmlFields: readonly string[] = []): FieldHiddenAdds[] {
  const one = (field: string, before: unknown, next: unknown): FieldHiddenAdds[] => {
    const text = shownText(next);
    const held = shownText(before);
    // A field the run leaves as it is adds nothing, and is not parsed for it.
    if (text === null || text === held) return [];
    const html = typeof next === 'string' && htmlFields.includes(field);
    const codePoints = hiddenAddsRead(held, text, html);
    // A field past the reading bounds is named as unread: it is never left out, and never counted
    // as one that adds.
    if (codePoints === null) return [{ field, codePoints: [], html: true as const, unread: true as const }];
    return codePoints.length > 0 ? [{ field, codePoints, ...(html ? { html: true as const } : {}) }] : [];
  };
  if (after === null || typeof after !== 'object' || Array.isArray(after)) return one('', prior, after);
  const was = prior !== null && typeof prior === 'object' && !Array.isArray(prior) ? prior as Record<string, unknown> : {};
  return Object.keys(after).sort().flatMap((field) => one(field, was[field], (after as Record<string, unknown>)[field]));
}
