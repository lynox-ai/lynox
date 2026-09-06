/**
 * Make links in rendered chat markdown behave like links.
 *
 * Two separate complaints, one cause. A user reported that research links "are
 * not shown as clickable" — they ARE clickable (marked's GFM autolinker turns
 * bare URLs into anchors), but the chat prose style sets `prose-a:no-underline`,
 * so a link is only distinguishable from body text by a colour shift. And every
 * one of them navigates the whole app away, because the chat renderer — unlike
 * the prompt renderer one directory over, which sets `target="_blank"` on every
 * anchor it emits — leaves the target unset.
 *
 * This runs AFTER `DOMPurify.sanitize`, following `wrapTables` in
 * `MarkdownRenderer.svelte`. That ordering is deliberate: rewriting before the
 * sanitizer would mean adding attributes to markup that has not been cleaned
 * yet, and the sanitizer is what guarantees these are real anchors rather than
 * something shaped like one.
 */

/**
 * Add `target="_blank"` and a safe `rel` to anchors pointing off-site.
 *
 * Only absolute `http(s)` targets are touched. In-app links (`/threads/…`,
 * `#anchor`) must keep navigating in place — sending those to a new tab would
 * break navigation rather than protect it. Anchors that already declare a
 * target are left alone, so a future renderer that sets its own wins.
 *
 * `rel="noreferrer noopener"` matches what `prompt-markdown.ts` emits. Modern
 * browsers imply `noopener` for `target="_blank"`, but stating it keeps the
 * behaviour independent of that default — and `noreferrer` is a real change:
 * a chat message can carry a URL from a tool result, and the referrer would
 * otherwise tell that site which page the user came from.
 */
export function externalizeLinks(html: string): string {
	return html.replace(/<a\b[^>]*>/gi, (tag) => {
		if (/\starget\s*=/i.test(tag)) return tag;
		if (!/\shref\s*=\s*["']https?:\/\//i.test(tag)) return tag;
		return `${tag.slice(0, -1).replace(/\/$/, '')} rel="noreferrer noopener" target="_blank">`;
	});
}
