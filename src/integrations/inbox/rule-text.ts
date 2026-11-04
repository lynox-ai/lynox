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
 * and a subject carries both), and neither would one with its spaces collapsed (a subject may hold
 * two, or a non-breaking one). So the value is only trimmed. The caller refuses one that holds a
 * character a reader does not see, outside the places real text puts one (`hidden-chars.ts`,
 * checked on the raw input), or a line break or tab, which no subject or address carries.
 */
export function ruleValue(raw: string): { value: string; hidden: boolean; multiline: boolean } {
  return { value: raw.trim(), hidden: hiddenCharIndexes(raw).length > 0, multiline: /[\t\n\r]/.test(raw.trim()) };
}

/** A rule description: one line a reader sees whole, 3 to 300 characters. */
export const DESCRIPTION_MIN = 3;
export const DESCRIPTION_MAX = 300;
/** At most this many description rules per account, in any state: each is in every model call
 *  of its account, so the list must stay short (PRD inbox-user-rules E3, E11). */
export const MAX_DESCRIPTION_RULES = 20;

/** Why a description cannot be stored, or null. Checked on the raw input, as `ruleValue` does. */
export function descriptionProblem(raw: string): string | null {
  const v = ruleValue(raw);
  if (v.hidden) return 'holds characters a reader does not see';
  if (v.multiline) return 'must be one line';
  if (namesRuleLabel(v.value)) return 'must not name a rule label such as R1';
  const n = charCount(v.value);
  if (n < DESCRIPTION_MIN || n > DESCRIPTION_MAX) return `must be ${String(DESCRIPTION_MIN)} to ${String(DESCRIPTION_MAX)} characters`;
  return null;
}

/** True when the text names a label the rule check uses (`R1`, `r 12`): a rule text that names
 *  one could steer the check towards another rule. */
export function namesRuleLabel(text: string): boolean {
  return /(^|[^\p{L}\p{N}])r\s?\d{1,3}(?![\p{N}])/iu.test(text);
}

/** Length in characters (code points), as `cutChars` counts. */
export function charCount(text: string): number {
  return Array.from(text).length;
}

/** At most `max` characters, counted in code points, so a surrogate pair is never cut. */
export function cutChars(text: string, max: number): string {
  return Array.from(text).slice(0, max).join('').trim();
}
