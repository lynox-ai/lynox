// === One header value, one line — inside an <untrusted_data> block ===

import { LINE_BREAK_CLASS } from '../../core/data-boundary.js';

/**
 * The line-break classes a reader may honour (see {@link LINE_BREAK_CLASS}, shared with the
 * role-line scan). A run of them becomes one space.
 */
const BREAKS = new RegExp(`[${LINE_BREAK_CLASS}]+`, 'g');

/**
 * Put a sender-written header value on one line before it is rendered as `Label: value`
 * inside a wrapped block, so a decoded line break cannot start a second label line.
 *
 * Nothing else is touched. The value is the sender's text and the model may quote it back
 * (a subject into a search, a name into a reply), so joiners, soft hyphens and every other
 * character arrive as they were sent; only the breaks are collapsed.
 */
export function oneBlockLine(value: string): string {
  return value.replace(BREAKS, ' ');
}
