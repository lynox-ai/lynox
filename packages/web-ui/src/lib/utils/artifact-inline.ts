// Decide whether an `artifact_save` tool-call should render its own inline
// artifact card, or whether the agent already showed that content in its prose
// (in which case the card would be a duplicate).
//
// Why this exists: the chat renders a saved artifact as a card by reading the
// tool-call's `content` input. A previous coarse guard skipped that render for
// the WHOLE message as soon as ANY ```artifact fence was present — so when the
// agent EDITED an artifact (a second artifact_save with new content), its
// updated card was silently dropped and only the "Updated artifact ..." text
// remained ("edited artifacts not re-referenced"). Matching on the specific
// content instead fixes the edit case while still de-duplicating a card the
// agent already fenced inline.

/** Collapse whitespace runs so a re-formatted prose copy still matches. */
function normalizeWhitespace(s: string): string {
	return s.replace(/\s+/g, ' ').trim();
}

/**
 * True when `content` is already present in one of the message's prose text
 * blocks (the agent fenced the artifact inline), so the tool-call card would be
 * a duplicate and should be skipped. An edit supplies content NOT present
 * inline, so this returns false and the updated card renders.
 *
 * Comparison is whitespace-normalized: an agent that pretty-prints the prose
 * copy slightly differently from the saved content should still be de-duped (a
 * raw substring match would render a second card). A genuine edit changes more
 * than whitespace, so it still fails the match and renders.
 */
export function isArtifactContentInline(
	content: string,
	textBlocks: ReadonlyArray<string>,
): boolean {
	const needle = normalizeWhitespace(content);
	if (needle.length === 0) return false;
	return textBlocks.some((t) => normalizeWhitespace(t).includes(needle));
}

// ── Inline artifact ↔ gallery linking ─────────────────────────────────
//
// artifact_save persists to the gallery server-side and returns the id in its
// result string ("… (id: <id>, v<n>)."). The chat threads that id into the
// rendered artifact fence as a `<!-- id: X -->` marker so the inline card LINKS
// to the existing gallery entry instead of re-saving a duplicate row on every
// pin/open click. These helpers keep the marker format in ONE place so the
// writer (ChatView) and the readers (MarkdownRenderer) can't drift.

/** Pull the saved artifact id out of an `artifact_save` tool result string.
 *  '' when the result carries no id (error strings, older results). */
export function parseArtifactIdFromResult(result: string | undefined): string {
	if (!result) return '';
	const m = result.match(/\(id:\s*([^,)\s]+)\s*,\s*v\d+\)/);
	return m ? m[1]! : '';
}

/** The fence marker that carries the gallery id, or '' when there is no id. */
export function artifactIdMarker(id: string): string {
	return id ? `<!-- id: ${id} -->\n` : '';
}

/** Read the gallery id back out of a fence body. '' when absent. */
export function extractArtifactId(code: string): string {
	const m = code.match(/<!--\s*id:\s*([^\s>]+)\s*-->/i);
	return m ? m[1]! : '';
}

/** Remove the id marker from a fence body so it can't leak into rendered prose
 *  or a data preview. Idempotent; a no-op when no marker is present. */
export function stripArtifactIdMarker(code: string): string {
	return code.replace(/<!--\s*id:\s*[^\s>]+\s*-->\s*/i, '');
}
