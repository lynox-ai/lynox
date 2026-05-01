// === Mail charset decoding ===
//
// Single decode chokepoint for both header MIME-words and body parts.
// Replaces the previous Buffer.toString-only path that silently fell
// back to UTF-8 best-effort for anything outside utf-8/latin1/ascii —
// which produced replacement chars, but worse, could fold adversarial
// non-ASCII bytes into invisible/normalised forms that slipped past
// the downstream wrapUntrustedData boundary scanner.
//
// Strategy:
// 1. Native Buffer codecs first — utf-8, latin1, ascii — fastest path.
// 2. iconv-lite for the remainder of the real-world charset zoo
//    (Big5, Shift_JIS, GB2312, EUC-JP, ISO-2022-JP, Windows-1252, KOI8-R…).
// 3. Anything iconv-lite doesn't recognise is QUARANTINED — the caller
//    receives `null` text plus a reason string. Body callers replace
//    the body with a placeholder; header callers drop the encoded-word
//    to an empty string. This keeps unknown bytes from ever reaching
//    the LLM as decoded text.

import iconv from 'iconv-lite';

const NATIVE_UTF8 = new Set(['utf-8', 'utf8']);
const NATIVE_LATIN1 = new Set(['iso-8859-1', 'latin1', 'iso_8859-1', 'iso8859-1']);
const NATIVE_ASCII = new Set(['us-ascii', 'ascii']);

export interface DecodeResult {
  /** Decoded string, or null when the charset was rejected. */
  text: string | null;
  /** Normalised charset that produced the result, for diagnostics. */
  charset: string;
  /** When text is null, a one-line explanation suitable for placeholders. */
  reason?: string;
}

function normalize(charset: string): string {
  return charset.trim().toLowerCase().replace(/_/g, '-');
}

/**
 * Decode raw bytes using the declared charset.
 *
 * Returns `{ text, charset }` on success. On unknown charsets returns
 * `{ text: null, charset, reason }` — the caller decides the user-
 * visible substitute (placeholder for bodies, empty string for header
 * words, etc.).
 */
export function decodeBytes(bytes: Buffer | Uint8Array, charset: string | undefined): DecodeResult {
  const cs = normalize(charset ?? 'utf-8') || 'utf-8';
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);

  if (NATIVE_UTF8.has(cs)) return { text: buf.toString('utf-8'), charset: cs };
  if (NATIVE_LATIN1.has(cs)) return { text: buf.toString('latin1'), charset: cs };
  if (NATIVE_ASCII.has(cs)) return { text: buf.toString('ascii'), charset: cs };

  if (iconv.encodingExists(cs)) {
    try {
      return { text: iconv.decode(buf, cs), charset: cs };
    } catch (err: unknown) {
      return {
        text: null,
        charset: cs,
        reason: `iconv decode failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  return {
    text: null,
    charset: cs,
    reason: `charset "${cs}" is not in the decoder allow-list`,
  };
}

/**
 * Body-shaped substitute when decode is rejected. Renders an obvious
 * placeholder so the LLM sees a clear "content elided" signal rather
 * than a best-effort UTF-8 mojibake string that could harbour
 * injection-shaped bytes.
 */
export function bodyQuarantinePlaceholder(charset: string, sizeBytes: number): string {
  return `[mail body in unsupported charset "${charset}" (${String(sizeBytes)} bytes) — content not shown]`;
}
