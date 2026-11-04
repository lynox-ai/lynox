// === The text of an inbox rule: its name and what it matches, on one line ===
//
// A rule's name and value are read by the owner when they confirm it and by the model in the audit
// and in tool results. Both must read the same text, so every character a reader does not see (the
// class in `core/hidden-chars.ts`: controls, format and direction characters, joiners, variation
// selectors, the tag block, line and paragraph separators) becomes a space, as a line break does.
// A name is not running text, so none of them is kept in any place.

import { hiddenCharIndexes } from '../../core/hidden-chars.js';

/** One line of rule text: hidden characters and line breaks become spaces, runs of space collapse. */
export function ruleLine(raw: string): string {
  const chars = Array.from(raw);
  for (const i of hiddenCharIndexes(raw, { inPlace: false })) chars[i] = ' ';
  return chars.join('').replace(/\s+/g, ' ').trim();
}

/**
 * A matched value is not rewritten: the loader compares it with the mail as it arrives, so a value
 * with a character turned into a space would never match (a warning sign as emoji is U+26A0 U+FE0F,
 * and a subject carries both). Spaces are collapsed, and a value that still holds a character a
 * reader does not see, outside the places real text puts one (`hidden-chars.ts`), is refused by
 * the caller.
 */
export function ruleValue(raw: string): { value: string; hidden: boolean } {
  const value = raw.replace(/\s+/g, ' ').trim();
  return { value, hidden: hiddenCharIndexes(value).length > 0 };
}

/** Length in characters (code points), as `cutChars` counts. */
export function charCount(text: string): number {
  return Array.from(text).length;
}

/** At most `max` characters, counted in code points, so a surrogate pair is never cut. */
export function cutChars(text: string, max: number): string {
  return Array.from(text).slice(0, max).join('').trim();
}
