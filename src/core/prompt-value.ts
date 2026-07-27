/**
 * Helpers for interpolating VALUES into a `promptUser()` confirmation prompt.
 *
 * ## Why this exists
 *
 * A confirmation prompt is a string the caller assembles from a system-authored
 * FRAME (`**Host:** `, `Time: `, `Share file … with `) and one or more VALUES
 * (a hostname, an event summary, a recipient). The web UI renders that string:
 * an `Allow`/`Deny` prompt goes into a `<pre>` and is immune to everything
 * below, but every OTHER option set — `['Yes','No']`, `['Proceed','Adjust',
 * 'Cancel']`, ask_user labels — goes through markdown
 * (`ChatView.svelte` → `MarkdownRenderer` → `renderPromptMarkdown`).
 *
 * The render layer receives ONE finished string. It cannot tell a frame `\n`
 * from a value `\n`, so it cannot fix this: escaping newlines there would
 * destroy both the field structure of the prompts and the legitimately
 * multi-line values (knowledge snippets). Only the caller knows which spans are
 * values — which is why the neutralisation belongs here, at build time.
 *
 * ## What a newline in a value buys an attacker
 *
 * With `renderPromptMarkdown`'s `breaks: true`, a `\n` inside a value renders as
 * a real line break, so the value can write what LOOKS like another field line:
 *
 *     summary = 'Coffee\nTime: 09:00 – 09:15'
 *     →  Create event "Coffee
 *        Time: 09:00 – 09:15"
 *        Time: <the real, different time> with <the real, longer invitee list>
 *
 * The forged line cannot REMOVE the true one — suppression was closed in #1078
 * — so this is an attention attack, not a proof break. It still matters,
 * because a prompt that carries a security decision is only worth as much as
 * the reader's ability to tell which line the system wrote.
 *
 * ## Scope, honestly
 *
 * This is the per-caller variant of the fix: whoever adds the NEXT `promptUser`
 * caller can forget it. The structural version — `promptUser` taking frame and
 * values separately, so the boundary is carried by the type rather than by
 * convention — is the real answer and is still open. Do not read a call to
 * `singleLine` as a guarantee about the prompt as a whole.
 */

/**
 * Collapse a value to a single line so it cannot forge a field line or open a
 * block-level markdown/HTML construct in the prompt that renders it.
 *
 * Use it on every value interpolated into a confirmation prompt whose field is
 * single-line by nature — an id, a host, a filename, an address, a timestamp, a
 * range. Do NOT use it on a value that is legitimately multi-line (a knowledge
 * snippet, a mail body quote); those need the structural fix instead, not a
 * silent reflow of the user's content.
 *
 * Two things about the character class, both measured rather than assumed:
 *
 * 1. It is NOT the reason a leftover character is harmless. C1 controls (U+0085
 *    NEL, U+0084, U+009B) survive `\s` — and are inert anyway, because neither
 *    JS's LineTerminator set nor CSS's segment-break set contains them, so
 *    `marked` can never see one as a line end and no renderer breaks on one.
 *    That is a property of the ENVIRONMENT, not of this class. Anyone extending
 *    this to a consumer that does treat C1 as a break (a terminal, a CSV or
 *    header export) has to re-derive the class, not trust this one.
 * 2. It strips `\p{Cf}` (bidi overrides, zero-width space, BOM) rather than
 *    collapsing them. Those forge nothing by themselves, but they are stripped
 *    by `clip()` in `tools/builtin/knowledge.ts` and `subjects-merge.ts`, which
 *    guard the same kind of prompt. A SHARED helper that is weaker than the two
 *    local ones it generalises is an invitation to a regression — the natural
 *    next refactor ("just use the central one") would quietly remove a guard.
 */
export function singleLine(value: string): string {
  // Format characters removed outright; every break-ish character collapsed to
  // one space. `\s` misses most of C0 and all of C1, so both are named.
  return value.replace(/\p{Cf}/gu, '').replace(/[\s\u0000-\u001f\u0085]+/gu, ' ');
}
