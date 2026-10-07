/**
 * A model that ends a JSON request body with a stray closing tag, and the one repair that is
 * safe to make on its behalf.
 *
 * THE OBSERVATION, because this is a foreign defect and the file should say whose: `minimax-m3`
 * on Fireworks appends a literal `</body>` to the `body` STRING of an `http_request` tool call.
 * The `arguments` JSON around it is well-formed every time; the tag sits inside the string value,
 * so nothing upstream notices. The body is then not valid JSON, and an API that expects JSON
 * answers with its own idea of "empty request" — DataForSEO returns `40502 POST Data Is Empty.`
 * under HTTP 200. Measured 2026-10-07 against the provider APIs directly: 5 of 5 generated tool
 * calls carried it, against 13 clean calls from `deepseek-v4p1-flash`, `kimi-k3` and
 * `mistral-medium-2604` on the same prompt and the same tool schema.
 *
 * WHY REPAIR RATHER THAN REFUSE LOUDLY, which was the other candidate and lost on evidence: in
 * the thread that reported this, the engine told the model its call had failed eight times in
 * thirty-one seconds. The model read the error, diagnosed it correctly in prose, and re-issued
 * the identical broken call until the loop guard fired. A clear error is not a fix when the
 * party that must act on it is the one that is broken.
 *
 * ⚠ IT IS NOT A THRESHOLD FIX. Lowering the loop guard's threshold was considered and is
 * decided AGAINST (core#1364, withdrawn 2026-09-24): at the `(call, result)` level a stuck loop
 * and a poll-until-done are not distinguishable, so a higher round count only buys a slower
 * false positive. What that PR named as missing is a progress signal the guard does not receive.
 * This is that signal, and it arrives earlier: a body that cannot parse is hopeless BEFORE the
 * request goes out, without counting anything and without seeing a result.
 */

/** A trailing closing tag — `</body>`, `</html>`, `</ns:x>` — and any whitespace around it. */
const TRAILING_CLOSE_TAG = /\s*<\/[A-Za-z][\w:-]*>\s*$/;

const parses = (text: string): boolean => {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
};

const declaredContentType = (headers: Readonly<Record<string, string>>): string | null => {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === 'content-type');
  return key === undefined ? null : String(headers[key]);
};

export interface RepairedBody {
  /** The body to send instead. */
  readonly body: string;
  /** Exactly what was taken off the end, for the note the call carries. */
  readonly removed: string;
}

/**
 * Three conditions. TWO of them discriminate and the third does not, and saying which is which
 * is the point of this paragraph — an earlier draft of it claimed all three were load-bearing,
 * which is not true and would have made this comment the least reliable thing in the file:
 *
 *   (a) JSON INTENT — load-bearing. The body looks like JSON (`{`, `[`, `"` after whitespace)
 *       **or** the call declares `application/json`. Two entrances on purpose: the declared type
 *       was the first and only condition drafted, and it is a PROXY — measured on the real
 *       model, 1 call in 4 set no `Content-Type` at all while still carrying the tag. The body's
 *       own first character is the property; the header is corroboration, not the test. What (a)
 *       alone refuses: `123</body>`, `true</body>` — they fail (a), pass (b), and would PASS (c),
 *       because `123` parses as JSON. Without (a) this function would quietly rewrite a
 *       plain-text body that happens to end in markup.
 *   (b) IT DOES NOT PARSE — **redundant under (c) as written, and kept deliberately.** There is
 *       no body that (b) refuses and (c) accepts: valid JSON ends in `}`, `]`, `"`, a digit or
 *       `e`/`l`, never in `>`, so anything that parses also fails (c). It stays because it
 *       states the guarantee DIRECTLY — a correct body is never touched — instead of leaving it
 *       to be derived from a property of JSON's grammar by whoever next edits (c). The test
 *       asserts the redundancy rather than hiding it, so nobody re-derives it.
 *   (c) REMOVING ONE TRAILING TAG MAKES IT PARSE — load-bearing, and the condition that carries
 *       the whole objection to this repair. A legitimate POST of an HTML document also ends in
 *       `</body>` — and it still does not parse once the tag is gone, so it is refused here. The
 *       repair cannot reach the class it must not reach, because that class fails (c) by
 *       construction, whatever its headers claim.
 *
 * Returns `null` when the body should go out exactly as the model wrote it. The caller is
 * expected to say in its result that a repair happened: silently correcting another party's
 * output is how a defect stops being visible, and this one belongs upstream at the provider.
 */
export function repairStrayCloseTag(
  body: string,
  headers: Readonly<Record<string, string>> = {},
): RepairedBody | null {
  const lead = body.trimStart()[0];
  const looksLikeJson = lead === '{' || lead === '[' || lead === '"';
  if (!looksLikeJson && !/application\/json/i.test(declaredContentType(headers) ?? '')) return null;

  if (parses(body)) return null;

  const stripped = body.replace(TRAILING_CLOSE_TAG, '');
  if (stripped === body) return null;
  if (!parses(stripped)) return null;

  // ⚠ CAPPED, because `removed` is MODEL OUTPUT and its caller puts it in a line that sits
  // OUTSIDE the untrusted-data wrap — engine guidance, which is the surface a model reads as
  // instruction. The tag grammar above already forbids whitespace and punctuation, so no
  // sentence fits through; what it does NOT bound is length (`[\w:-]*`), and an arbitrarily long
  // token in a system line is worth refusing even when it cannot say anything.
  const removed = body.slice(stripped.length).trim();
  return { body: stripped, removed: removed.length > 40 ? `${removed.slice(0, 37)}…` : removed };
}
