import { SECRET_SHAPES } from './secret-shapes.js';
import { withFlags } from './jwt-scan.js';

/**
 * Credential shapes masked in text the chat shows (thinking blocks): the shared list plus
 * a few this view has always caught on its own.
 */
const MASK_PATTERNS: ReadonlyArray<RegExp> = [
  /sk-ant-[a-zA-Z0-9_-]{20,}/g,
  /sk-[a-zA-Z0-9_-]{20,}/g,
  /tvly-[a-zA-Z0-9_-]{10,}/g,
  // Telegram bot token: numeric id, colon, secret. The id's length is capped so a long run of
  // digits is not rescanned from every digit; no `\b` before it, because the token usually
  // sits in an API URL right after `/bot`.
  /\d{5,12}:[A-Za-z0-9_-]{30,}/g,
  ...SECRET_SHAPES.map((s) => withFlags(s.pattern, 'g')),
];

/** The engine's floor (`maskValue` in core's secret-store): the last four only from 16
 *  characters on, below that none. */
function maskMatch(match: string): string {
  return match.length >= 16 ? `***${match.slice(-4)}` : '***';
}

/** Replace every credential-shaped run with `***`, plus its last four characters when it is
 *  long enough to show them. */
export function maskText(text: string): string {
  let result = text;
  for (const pattern of MASK_PATTERNS) {
    result = result.replace(pattern, maskMatch);
  }
  return result;
}
