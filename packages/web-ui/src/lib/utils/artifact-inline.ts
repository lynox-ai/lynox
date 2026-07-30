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
// rendered artifact fence as a marker so the inline card LINKS to the existing
// gallery entry instead of re-saving a duplicate row on every pin/open click.
// These helpers keep the fence format in ONE place so the writer (ChatView)
// and the reader (MarkdownRenderer) can't drift.
//
// The marker is NAMESPACED (`lynox-artifact-id`, not a bare `id`): buildArtifact
// runs the reader on EVERY artifact/html fence, including agent-authored ones
// whose content may contain an ordinary `<!-- id: … -->` HTML comment — a bare
// name would be misread as a gallery id (stripping the comment + a dead link).

const ID_MARKER_RE = /<!--\s*lynox-artifact-id:\s*([^\s>]+)\s*-->\s*/i;

/** Pull the saved artifact id out of an `artifact_save` tool result string.
 *  '' when the result carries no id (error strings, older results). The id
 *  sits at the END of the first line; a title can itself contain literal
 *  "(id: x, v1)" text, so anchor to the line end to skip an injected/echoed
 *  id inside the title rather than first-matching it. (Residual: a title with
 *  an embedded newline could still land a spoof id at a line end above the
 *  real one → a dead gallery link, agent-controlled, no data risk. Parsing a
 *  human string is inherently fragile; the durable fix is a structured id
 *  field on the tool_result SSE event. Deferred — see REGISTER.) */
export function parseArtifactIdFromResult(result: string | undefined): string {
	if (!result) return '';
	const m = result.match(/\(id:\s*([^,)\s]+)\s*,\s*v\d+\)\.\s*$/m);
	return m ? m[1]! : '';
}

/** The fence marker that carries the gallery id, or '' when there is no id. */
export function artifactIdMarker(id: string): string {
	return id ? `<!-- lynox-artifact-id: ${id} -->\n` : '';
}

/** Build the leading marker block for an inline artifact fence. Single source
 *  of the fence format shared by the writer and the round-trip test. */
export function artifactFenceHeader(opts: { title: string; type: string; id: string; typed: boolean }): string {
	const typeMarker = opts.typed ? `<!-- type: ${opts.type} -->\n` : '';
	return `<!-- title: ${opts.title} -->\n${typeMarker}${artifactIdMarker(opts.id)}`;
}

/** Read the gallery id back out of a fence body. '' when absent. */
export function extractArtifactId(code: string): string {
	const m = code.match(ID_MARKER_RE);
	return m ? m[1]! : '';
}

/** Remove the id marker from a fence body so it can't leak into rendered prose
 *  or a data preview. Idempotent; a no-op when no marker is present. */
export function stripArtifactIdMarker(code: string): string {
	return code.replace(ID_MARKER_RE, '');
}

/** Resolve a fence body for rendering: its gallery id (if any) and the body
 *  with the id marker stripped. What MarkdownRenderer.buildArtifact consumes —
 *  extracted so the writer→reader round-trip is driven by a test, not asserted
 *  on the helpers in isolation. */
export function resolveArtifactRender(code: string): { artifactId: string; src: string } {
	const artifactId = extractArtifactId(code);
	return { artifactId, src: artifactId ? stripArtifactIdMarker(code) : code };
}
