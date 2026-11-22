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

/**
 * Whether an `artifact_save` call gets an inline artifact card. Not when the
 * call's status is `error` (the handler threw): the card is drawn from the
 * call's INPUT, so a refused save (e.g. the eviction placeholder sent as
 * content) would still show a card that reads like a finished document, and
 * opening it would save that input to the gallery. A failure the handler
 * returns as plain text ("Artifact store not available.") arrives as `done`
 * and is not caught here. Not when the call is `done` without a result either:
 * every `tool_result` sets one, so such a call was only swept to `done` when
 * the run ended (`settleRunningToolCalls`), its `tool_result` event lost, and
 * this tab cannot tell whether the save was refused. Not
 * when the content is empty or already inline either.
 */
export function shouldRenderArtifactCard(
	call: { status: 'running' | 'done' | 'error'; result?: string | undefined },
	content: string,
	textBlocks: ReadonlyArray<string>,
): boolean {
	if (call.status === 'error') return false;
	if (call.status === 'done' && call.result === undefined) return false;
	if (!content) return false;
	return !isArtifactContentInline(content, textBlocks);
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
 *  field on the tool_result SSE event.) */
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

// ── An inline artifact that holds only the engine's placeholder ───────
//
// The gallery and the chips under the chat mark an artifact whose file holds
// the engine's placeholder for a saved body instead of a document (`lostOnSave`,
// set by the engine's artifact store). The inline card reads its body from the
// message, not from the store, so it gets no such flag: an older thread whose
// save stored the placeholder, or a fence the model filled with it, showed the
// placeholder as if it were the document. These helpers apply the store's own
// rule to the fence body, so the card carries the same badge.

/** The three openings of the references the engine writes where a saved body
 *  was (`src/core/artifact-eviction.ts`, `containsEvictionMarker`): the old
 *  in-field form and the two notes. Kept equal to the engine's by a test that
 *  runs both on the same inputs. */
const PLACEHOLDER_OPENINGS = [
	'[evicted after successful save',
	'[The body of this document was removed from the conversation',
	'[The content of this call was the engine\'s placeholder',
] as const;

/** The store's size bound (`LOST_ON_SAVE_MAX_BYTES`): a larger body that holds
 *  a placeholder is a document quoting it, still readable, and the badge would
 *  be false there. */
export const PLACEHOLDER_MAX_BYTES = 2048;

/** Whether a fence body holds only the engine's placeholder, by the store's
 *  rule: at most {@link PLACEHOLDER_MAX_BYTES} bytes of UTF-8 and a placeholder
 *  opening anywhere in it. */
export function holdsOnlyPlaceholder(src: string): boolean {
	if (new TextEncoder().encode(src).length > PLACEHOLDER_MAX_BYTES) return false;
	return PLACEHOLDER_OPENINGS.some((opening) => src.includes(opening));
}

/** The leading markers the chat writes before a saved artifact's content in
 *  its fence ({@link artifactFenceHeader}: title, then type; the id marker is
 *  gone by the time {@link resolveArtifactRender} hands the body on). */
const LEADING_FENCE_MARKERS_RE = /^<!--\s*title:[^\n]*?-->\n(?:<!--\s*type:\s*\w+\s*-->\n)?/;

/** Whether a rendered fence body holds only the placeholder, measured on what
 *  the store would hold: the content without the markers the chat put before
 *  it and without the line end the markdown parser adds to every code block.
 *  Measured with them, a stored placeholder near the bound got no badge.
 *  Bounded, not exact: within a few bytes of the bound the count can differ
 *  from the store's in either direction, so a badge can be missed or shown
 *  there. A title with a line break keeps its marker in the count; content
 *  that opened with whitespace, ended with a line end or opened with a type
 *  comment of its own loses those bytes. Away from the bound both agree. The
 *  badge only warns: it changes no save, open or share. */
export function fenceHoldsOnlyPlaceholder(src: string): boolean {
	return holdsOnlyPlaceholder(src.replace(LEADING_FENCE_MARKERS_RE, '').replace(/\n$/, ''));
}

/** Put the badge after the card's title. `label` is shown as text and escaped
 *  here; `card` is one of MarkdownRenderer's own card builders' output, whose
 *  title span holds escaped text only, so the first such span is the card's. A
 *  card without a title span is returned unchanged. */
export function withPlaceholderBadge(card: string, label: string): string {
	const safe = label.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
	// A function, not a replacement string: `$&` or `$'` in a label would be read as patterns.
	return card.replace(
		/<span class="artifact-title">[^<]*<\/span>/,
		(title) => `${title}\n\t\t\t\t<span class="artifact-lost-badge" data-testid="artifact-inline-lost-badge" title="${safe}">${safe}</span>`,
	);
}
