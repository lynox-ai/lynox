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

/** Replace every credential-shaped run with `***` plus its last four characters. */
export function maskText(text: string): string {
  let result = text;
  for (const pattern of MASK_PATTERNS) {
    result = result.replace(pattern, (match) => `***${match.slice(-4)}`);
  }
  return result;
}
