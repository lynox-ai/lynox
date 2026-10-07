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

/**
 * The tag NAME, anchored at both ends and run against a candidate already cut out by index —
 * never against the whole body.
 *
 * ⚠ The first version of this was `/\s*<\/[A-Za-z][\w:-]*>\s*$/` applied with `.replace()` to
 * the body, and it was quadratic. `\s*` is unanchored, so the engine retries from every position
 * in a whitespace run and backtracks off the `<` each time. Measured on `'{' + n spaces + 'x'`:
 * 616 ms at n=20 000, 1783 ms at 40 000, **7652 ms at 80 000** — synchronous, inside the tool
 * handler, before anything else runs. A model, or a prompt injection reaching one, could freeze
 * the process for seconds with an 80 KB body that is broken for any reason at all. Found by a
 * review round; the shape is cheap to get wrong because the regex reads as obviously fine.
 */
const TAG_NAME = /^[A-Za-z][\w:-]*$/;

/**
 * Split a trailing closing tag off a body, in LINEAR time. Returns the body without it, or null.
 *
 * Index work only: `trimEnd`, one `endsWith`, one `lastIndexOf`, and the anchored name test over
 * the candidate. No unanchored quantifier ever sees the body.
 */
function withoutTrailingCloseTag(body: string): string | null {
  const trimmed = body.trimEnd();
  if (!trimmed.endsWith('>')) return null;
  const open = trimmed.lastIndexOf('</');
  if (open === -1) return null;
  if (!TAG_NAME.test(trimmed.slice(open + 2, -1))) return null;
  // ⚠ `trimEnd` again, on the part BEFORE the tag, and it is not cosmetic. JS `\s` includes
  // characters JSON does not accept as whitespace — U+00A0, U+FEFF, U+2028 — so a body reading
  // `{"a":1}<NBSP></body>` parses only once that character is gone too. Without this the repair
  // silently declines exactly those and the broken body goes out. Measured on a corpus of
  // 1 082 408 inputs: 366 bodies where the regex this replaced DID repair and an untrimmed
  // version does not, and 0 the other way. The prefix property survives: this trims a string
  // that is already a prefix of `trimmed`, which is a prefix of `body`.
  return trimmed.slice(0, open).trimEnd();
}

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
}

/**
 * ⚠ WHAT THIS DELIBERATELY DOES NOT RETURN: the text that was removed.
 *
 * It did, for one commit, so the caller's note could quote it — and that was an echo path from
 * model output into a privileged channel. A security round found what it costs. `agent.ts`
 * resolves `secret:NAME` references BEFORE the handler runs, so a model can write a body ending
 * in `</secret:NAME>` and the handler receives `…</THE-ACTUAL-VALUE>`; a vault value made of
 * `[A-Za-z0-9_:-]` passes the tag grammar whole. The repair then strips it — so the egress scan
 * no longer sees it — and the note quoted 37 characters of it into a line that sits outside the
 * untrusted-data wrap, where `maskSecrets` could not match it either, because masking replaces
 * the exact value and this was a prefix.
 *
 * A length cap was the first answer and it was the wrong shape: it bounded the symptom while
 * leaving the channel open, and it needed a cap, an allowlist AND a secret scan to be defended
 * — three checks per instance, which is the signature of a fix cut at the wrong place.
 *
 * The right answer is subtractive, and it costs nothing: **the model already knows what it
 * wrote.** Echoing the tag back informs nobody and opens a channel, so the note names the shape
 * ("it ended in a closing tag") and never a value.
 */

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

  const stripped = withoutTrailingCloseTag(body);
  if (stripped === null) return null;
  if (!parses(stripped)) return null;

  return { body: stripped };
}
