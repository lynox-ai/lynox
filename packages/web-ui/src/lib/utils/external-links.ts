/**
 * DOM passes over ALREADY-SANITIZED markup — and why they are DOM passes is the
 * whole content of this file.
 *
 * ## The defect these replace
 *
 * Both of these were string rewrites that ran AFTER `DOMPurify.sanitize`:
 * `html.replace(/<a\b[^>]*>/gi, …)` and `html.replace(/<table\b[^>]*>/g, …)`.
 * The previous version of this comment defended that ordering, and its argument
 * was sound as far as it went — "rewriting before the sanitizer would mean adding
 * attributes to markup that has not been cleaned yet". What it missed is that
 * there was a third option, and the two it compared were both wrong.
 *
 * A regex over sanitized HTML can match into an ATTRIBUTE VALUE. DOMPurify
 * returns `body.innerHTML`, and until the 2025 serializer change (Chromium 138,
 * Firefox 140, WebKit 26) attribute-mode escaping touched only `&`, `"` and
 * NBSP — `<` and `>` came back RAW. So on an older engine a sanitized
 * `title="x>…"` serialises with a real `>`, `/<a\b[^>]*>/` stops inside the
 * attribute, and the replacement's own `"` terminates it while its `>` closes
 * the tag. Whatever the attacker put after that is then live markup.
 *
 * Measured, not argued, with the old serializer's output fed in as a string and
 * the result re-parsed: the link rewrite and the table rewrite each turn
 * `title="x><img src=/nope onerror=…>"` into a real `<img>`.
 *
 * ⚠ The witness feeds that output in DIRECTLY rather than building it through a
 * parser, and the reason this comment used to give for that was false. It said
 * `linkedom` and a current browser both escape the `>`, so the suite could never
 * see the breakout. Measured: a current browser does escape it — `linkedom` does
 * NOT. `setAttribute('title', 'a></body>…')` serialises back with a RAW `>`, so
 * a payload built through linkedom would reproduce this defect perfectly well,
 * and the suite was never blind to it. (Measured further, and it matters for the
 * next reader: linkedom is LAXER than the dangerous engine, not equal to it — it
 * also leaves `&` and NBSP raw, which even the old spec escaped. So "reproduces
 * the old engine" holds for `<`/`>` and must not be read as equivalence.) The literal stays for a better reason
 * than the one claimed: it pins what the OLD BROWSER emitted, which is the input
 * that was actually dangerous, rather than depending on a test library happening
 * to agree with it.
 *
 * ## The rule this file exists to hold
 *
 * **Never run a string rewrite over sanitized HTML.** Mutate NODES, then
 * serialise ONCE. A raw `>` inside an attribute re-parses as part of that
 * attribute; it only becomes markup when a second pass inserts a quote.
 *
 * The module path did not move even though the file now holds a table pass too:
 * renaming a module inside a security fix is the kind of change that hides in
 * one. Its importer did move — the pipeline that calls these passes is now
 * `utils/markdown-render.ts`, and `utils/markdown-render.test.ts` is what pins
 * the import. (This paragraph named `markdown-link-affordance.test.ts` until
 * that stopped being true.)
 */

/**
 * Give off-site anchors `target="_blank"` and a safe `rel`.
 *
 * Two separate complaints, one cause. A user reported that research links "are
 * not shown as clickable" — they ARE clickable (marked's GFM autolinker turns
 * bare URLs into anchors), but the chat prose style sets `prose-a:no-underline`,
 * so a link is only distinguishable from body text by a colour shift. And every
 * one of them navigated the whole app away, because the chat renderer — unlike
 * the prompt renderer one directory over — left the target unset.
 *
 * Only absolute `http(s)` targets are touched. In-app links (`/threads/…`,
 * `#anchor`) must keep navigating in place. An anchor that already declares a
 * target is left alone, so a future renderer that sets its own wins.
 *
 * `rel="noreferrer noopener"` matches what `prompt-markdown.ts` emits. Modern
 * browsers imply `noopener` for `target="_blank"`, but stating it keeps the
 * behaviour independent of that default — and `noreferrer` is a real change: a
 * chat message can carry a URL from a tool result, and the referrer would
 * otherwise tell that site which page the user came from.
 *
 * The href is read with `getAttribute`, which returns the parsed attribute
 * VALUE. That is the second half of the repair: the old guard tested the
 * serialised tag text, so a `>` in a neighbouring attribute changed what the
 * guard was even looking at.
 */
export function externalizeLinksInDom(root: ParentNode): void {
	for (const anchor of root.querySelectorAll('a[href]')) {
		if (anchor.hasAttribute('target')) continue;
		if (!/^https?:\/\//i.test(anchor.getAttribute('href') ?? '')) continue;
		anchor.setAttribute('rel', 'noreferrer noopener');
		anchor.setAttribute('target', '_blank');
	}
}

/**
 * Put each `<table>` inside a scrollable container, so a wide table scrolls
 * instead of stretching the message.
 *
 * ⚠ The first version of this spread the node list first, with a comment saying
 * a live `NodeList` would be walked while the loop mutated the tree. That reason
 * is FALSE — `querySelectorAll` returns a STATIC list by spec, unlike
 * `getElementsByTagName` — and a mutation round is what said so: swapping the
 * spread for a direct iteration survived, which for a snapshot-vs-live question
 * is the answer, not a gap. The snapshot is gone with its justification; if a
 * later change moves to a live collection, the snapshot has to come back WITH a
 * reason that holds.
 */
export function wrapTablesInDom(root: ParentNode): void {
	for (const table of root.querySelectorAll('table')) {
		const doc = table.ownerDocument;
		if (!doc) continue;
		const wrap = doc.createElement('div');
		wrap.className = 'table-wrap';
		table.replaceWith(wrap);
		wrap.appendChild(table);
	}
}
