import { PROMPT_TEXT_BRAND, type PromptSegment, type PromptText } from '../types/agent.js';

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
 * ## The structural answer: `pv`
 *
 * Everything above describes the per-caller fix, and its weakness was always
 * that the next caller can forget it. `pv` removes the choice: it is a tagged
 * template, so the LANGUAGE splits frame from value. Every interpolation is a
 * value by construction — there is no way to write one that isn't marked, and
 * no second sanitiser to remember.
 *
 *     promptUser(pv`Share file ${fileId} with ${email} as ${role}?`, ['Yes','No'])
 *
 * The segments travel to the renderer, which puts value spans in TEXT NODES —
 * so a value cannot open a markdown construct at all, whether it is one line or
 * twenty. `singleLine` survives for what it was actually good at: keeping a
 * field that is single-line by nature from wrapping the display. It is no
 * longer what carries the security boundary.
 *
 * A plain string still works and means "all frame, no values" — that is what
 * every un-migrated caller and every prompt restored from before this change
 * is, and it renders exactly as it did.
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

// --- The structural boundary: frame vs. value, carried by the type ---
//
// The TYPES live in `types/agent.ts` (the barrel is the single source of truth
// for shared types, and `PromptUserFn` has to name them). The construction and
// the reading of them live here.

export function isPromptText(value: unknown): value is PromptText {
  return typeof value === 'object' && value !== null && PROMPT_TEXT_BRAND in value;
}

/**
 * Build a prompt whose frame and values are separated by the language itself.
 *
 * Every `${...}` is a value; everything between them is frame. That is the
 * whole mechanism — there is no marker to strip, no escape to remember, and no
 * way to interpolate something without marking it, because the tag sees the two
 * halves as separate arguments before they are ever a string.
 *
 * Values compose: interpolating another `pv` splices its segments in, so a
 * builder can hand back a fragment (`buildSendPreview`) without flattening it
 * into an unmarked string. Anything else is stringified.
 *
 * Adjacent frames are merged and empty segments dropped, so the wire carries
 * the shortest form and `[frame, value, frame]` is stable to assert on.
 */
export function pv(strings: TemplateStringsArray, ...values: unknown[]): PromptText {
  const segments: PromptSegment[] = [];

  const push = (segment: PromptSegment): void => {
    if (segment.text === '') return;
    const last = segments[segments.length - 1];
    if (last?.kind === 'frame' && segment.kind === 'frame') {
      segments[segments.length - 1] = { kind: 'frame', text: last.text + segment.text };
      return;
    }
    segments.push(segment);
  };

  for (let i = 0; i < strings.length; i++) {
    push({ kind: 'frame', text: strings[i] ?? '' });
    if (i < values.length) {
      const value = values[i];
      if (isPromptText(value)) {
        for (const segment of value.segments) push(segment);
      } else {
        push({ kind: 'value', text: String(value) });
      }
    }
  }

  return { [PROMPT_TEXT_BRAND]: true, segments };
}

/**
 * Wrap an already-assembled string as a single VALUE.
 *
 * For the callers whose prompt IS one interpolated thing — `ask_user`, whose
 * whole text is the agent's question, and `plan_task`, whose presentation is
 * built line by line. Without this they would have to be frame, which would be
 * the wrong claim: nothing in them was written by the system.
 */
export function promptValue(text: string): PromptText {
  return { [PROMPT_TEXT_BRAND]: true, segments: text === '' ? [] : [{ kind: 'value', text }] };
}

/** Segments of either form — a plain string is all frame (the legacy meaning). */
export function promptSegments(prompt: string | PromptText): readonly PromptSegment[] {
  if (isPromptText(prompt)) return prompt.segments;
  return prompt === '' ? [] : [{ kind: 'frame', text: prompt }];
}

/**
 * Flatten to the plain string, for consumers that cannot show the distinction:
 * the CLI, logs, and the `question` column kept for prompts restored by an
 * older client. Flattening LOSES the boundary — never flatten on the way to a
 * renderer that could parse the result.
 */
export function flattenPrompt(prompt: string | PromptText): string {
  if (!isPromptText(prompt)) return prompt;
  return prompt.segments.map((s) => s.text).join('');
}

/**
 * Join built prompts with a frame separator.
 *
 * For a prompt assembled line by line (`plan_task`), where writing one big
 * template is not an option. The separator is FRAME — it is the caller's own
 * text — while every part keeps its own segments, so a value in the middle of
 * the list stays a value.
 */
export function joinPrompts(parts: readonly PromptText[], separator: string): PromptText {
  const segments: PromptSegment[] = [];
  parts.forEach((part, i) => {
    if (i > 0 && separator !== '') segments.push({ kind: 'frame', text: separator });
    segments.push(...part.segments);
  });
  // Re-run through `pv` so adjacent frames merge exactly as they do there,
  // instead of leaving the wire shape dependent on how the caller sliced it.
  return pv`${{ [PROMPT_TEXT_BRAND]: true, segments } as PromptText}`;
}
