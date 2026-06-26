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
