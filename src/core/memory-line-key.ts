import { createHash } from 'node:crypto';

/** A memory doc line's date stamp — stripped so the KG mirror matches the stored statement text. */
export const DATE_PREFIX_RE = /^\[\d{4}-\d{2}-\d{2}\]\s*/;

/** The marker `memory_update` puts before a line it supersedes. */
export const SUPERSEDED_PREFIX_RE = /^\[SUPERSEDED \d{4}-\d{2}-\d{2}\]\s*/;

/** A flat line without the prefixes the writers put before its text, in any order: the date
 *  (`status` lines get one even in front of a `[SUPERSEDED …]` marker) and the marker. */
export function stripLinePrefixes(line: string): string {
  let rest = line.trim();
  for (;;) {
    const next = rest.replace(SUPERSEDED_PREFIX_RE, '').replace(DATE_PREFIX_RE, '');
    if (next === rest) return rest;
    rest = next;
  }
}

/**
 * The key under which a flat memory line's untrusted mark is recorded and looked up — the one
 * normalization both sides use, so a line written marked is found marked whatever prefix or
 * case it is later read with: the body without its prefixes, trimmed, lower-cased, hashed.
 * `null` for a line with no body.
 *
 * Only the hash is stored, never the text. Its limit: the hash of a short line is open to a
 * guess-and-compare, so a line removed by `memory_delete` (a soft delete, whose twin rows stay
 * recoverable too) leaves a key a guess can confirm, and so does a line the memory upkeep
 * removes. The erasures — the memory view's erase (`MemoryFacade.delete`) and the wipe of all
 * data — remove the keys of the lines they erase.
 */
export function untrustedLineKey(line: string): string | null {
  const body = stripLinePrefixes(line).toLowerCase();
  return body.length > 0 ? createHash('sha256').update(body).digest('hex') : null;
}

/** The keys of the lines of `text` (blank lines skipped). */
export function untrustedLineKeys(text: string): string[] {
  return text.split('\n').map(untrustedLineKey).filter((k): k is string => k !== null);
}
