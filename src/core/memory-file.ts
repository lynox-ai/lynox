/**
 * The portable shape of the flat-file memory store (`memory/<scopeDir>/<ns>.txt`).
 *
 * Lives apart from both `memory.ts` (whose `Memory` class pulls in the LLM
 * extraction path) and `scope-resolver.ts` (which is about scope hierarchy, not
 * file layout), so the migration exporter and importer can agree on what is
 * portable without importing either.
 */

import { ALL_NAMESPACES } from '../types/index.js';

/**
 * Directory-name shape {@link import('./scope-resolver.js').scopeToDir} produces:
 * `global`, a bare context id, or `user-<id>`. The ceiling sits above
 * `SAFE_SCOPE_ID`'s so a max-length user id survives its `user-` prefix; the
 * "accepts a max-length user scope dir" test pins that relationship, so the two
 * cannot drift apart silently.
 */
export const SAFE_SCOPE_DIR = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/;

/**
 * Namespace file names inside a scope directory, DERIVED from the namespace enum
 * rather than restated — a hand-written list is how a description drifts away
 * from the values its parser accepts.
 */
export const MEMORY_NAMESPACE_FILES: ReadonlySet<string> =
  new Set(ALL_NAMESPACES.map(ns => `${ns}.txt`));

/**
 * Validate a `<scopeDir>/<namespace>.txt` key from a migration memory bundle.
 *
 * The single source of truth for which memory files are portable — the exporter
 * emits only keys this accepts, and the importer writes only keys this accepts.
 * `SAFE_SCOPE_DIR` requires an alphanumeric first character, so `.`, `..` and
 * absolute paths are rejected before any filesystem call.
 *
 * @returns the split segments, or `null` if the key is not portable
 */
export function parsePortableMemoryKey(key: string): { scopeDir: string; fileName: string } | null {
  const parts = key.split('/');
  if (parts.length !== 2) return null;
  const [scopeDir, fileName] = parts as [string, string];
  if (!SAFE_SCOPE_DIR.test(scopeDir)) return null;
  if (!MEMORY_NAMESPACE_FILES.has(fileName)) return null;
  return { scopeDir, fileName };
}

/** Byte ceiling for a single namespace file. `Memory` enforces it on every write. */
export const MAX_MEMORY_FILE_BYTES = 256 * 1024;

/**
 * Trim a namespace file to {@link MAX_MEMORY_FILE_BYTES} by dropping the oldest
 * lines. Every writer of the flat-file store must route through this, including
 * the migration importer — a restored file that skipped it would exceed a bound
 * `Memory` itself can never produce, and `loadScoped` reads the whole file into
 * the model's context.
 *
 * Linear in the input. The obvious shift-one-line-and-rejoin loop is quadratic,
 * which is harmless for `Memory` (it trims after each append, so at most a line
 * or two comes off) and a synchronous denial of service for the importer, whose
 * input is a bundle the source instance controls: a 20 MB file needed >20k full
 * re-splits — minutes of uninterruptible CPU on the request thread.
 */
export function trimMemoryContent(content: string): string {
  const buf = Buffer.from(content, 'utf-8');
  if (buf.length <= MAX_MEMORY_FILE_BYTES) return content;

  // Keep the largest suffix of whole lines that fits: the smallest newline index
  // `p` with `len - p - 1 <= cap`. `\n` (0x0a) never occurs inside a multi-byte
  // UTF-8 sequence, so scanning bytes cannot cut a character in half.
  const from = Math.max(0, buf.length - MAX_MEMORY_FILE_BYTES - 1);
  const p = buf.indexOf(0x0a, from);
  if (p !== -1) return buf.subarray(p + 1).toString('utf-8');

  // No newline in the tail — the final line alone exceeds the ceiling. Keep just
  // it, or the whole content when there is no newline at all. Both match the
  // previous "shift until one line remains" behaviour, which likewise could not
  // shrink a single line below the ceiling.
  const last = buf.lastIndexOf(0x0a);
  return last === -1 ? content : buf.subarray(last + 1).toString('utf-8');
}
