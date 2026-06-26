/**
 * Small input-hardening helpers (security follow-ups).
 *
 * Code-point filters (decimal comparisons) are used deliberately instead of
 * regex/`\u` literals so the source carries no control characters.
 */

/**
 * Strip the EXOTIC line-separators + control characters that a user never types
 * but an injection payload uses to put a pseudo-directive on its own visual line
 * (U+2028, U+2029, NEL/U+0085, the rest of C1, and C0 controls). Legitimate
 * whitespace — TAB (9), LF (10), CR (13) — is preserved, so a normal multi-line
 * message is untouched. Defense-in-depth behind the client-side framing
 * sanitiser (see web-ui chat-framing.ts / chat-context.ts `oneLine`).
 */
export function stripUntrustedSeparators(s: string): string {
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    const exotic =
      cp <= 8 || // C0 below TAB
      cp === 11 || // VT
      cp === 12 || // FF
      (cp >= 14 && cp <= 31) || // C0 above CR
      (cp >= 127 && cp <= 159) || // DEL + C1 (incl. NEL 0x85)
      cp === 8232 || // U+2028 LINE SEPARATOR
      cp === 8233; // U+2029 PARAGRAPH SEPARATOR
    out += exotic ? ' ' : ch;
  }
  return out;
}

/**
 * Sanitise a filename for a `Content-Disposition` header value: drop control
 * characters (incl. CR/LF — header-injection / response-splitting), the C1
 * range, and the quote/backslash that would break out of the quoted-string.
 * The caller wraps the result in `filename="..."`.
 */
export function sanitizeAttachmentFilename(name: string): string {
  let out = '';
  for (const ch of name) {
    const cp = ch.codePointAt(0) ?? 0;
    const drop =
      cp <= 31 || // C0 controls incl. CR/LF
      (cp >= 127 && cp <= 159) || // DEL + C1
      cp === 34 || // double-quote
      cp === 92; // backslash
    if (!drop) out += ch;
  }
  return out;
}

/**
 * Read a fetch Response body as UTF-8 text, aborting once it exceeds maxBytes.
 * The fetch timeout bounds TIME, not BYTES — a hostile target streaming a
 * multi-GB body within the window would otherwise buffer it all and OOM the
 * worker. Falls back to `res.text()` when the body is not a readable stream.
 */
export async function readBodyCapped(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return res.text();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`response body exceeded ${String(maxBytes)} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf-8');
}
