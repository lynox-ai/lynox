/**
 * Persist an uploaded document's extracted text into the knowledge layer (U1).
 *
 * After a PDF/Word upload is text-extracted (see `document-extract.ts`), the
 * text is inlined into that turn — but it used to vanish afterwards. Here we
 * also store it as recall-sized memories so the document survives the turn and
 * is auto-recalled on later turns/threads (the existing knowledge-layer
 * retrieval path, no new recall machinery). This rides the same persistence the
 * agent's own memories use, rather than a bespoke document store.
 *
 * Must run OFF the request path (fire-and-forget): each `store()` embeds and may
 * entity-extract, which must not block the chat turn.
 */
import type { MemoryNamespace, MemoryScopeRef } from '../types/memory.js';

/** The minimal slice of KnowledgeLayer this module needs (keeps it testable). */
export interface DocumentMemorySink {
	store(
		text: string,
		namespace: MemoryNamespace,
		scope: MemoryScopeRef,
		options?: {
			sourceThreadId?: string | undefined;
			// Wave 1.3: report the write channel; the tier is derived at the store boundary.
			sourceChannel?: string | undefined;
			sourceUntrusted?: boolean | undefined;
			sourceToolName?: string | undefined;
		},
	): Promise<unknown>;
}

// Chunk size aligned with the embedding truncation cap (embedding.ts MAX_EMBED_CHARS
// = 2000): a chunk past it wouldn't add similarity signal. The chunk-count cap
// bounds storage + extraction work for a max-size (200k-char) document.
const DEFAULT_MAX_CHARS = 2000;
const DEFAULT_MAX_CHUNKS = 100;

/**
 * Split extracted document text into recall-sized chunks on paragraph
 * boundaries: pack paragraphs up to `maxChars`, hard-split any single paragraph
 * longer than that, and stop at `maxChunks`. Pure + unit-testable.
 */
export function chunkDocumentText(
	text: string,
	opts?: { maxChars?: number; maxChunks?: number },
): string[] {
	const maxChars = opts?.maxChars ?? DEFAULT_MAX_CHARS;
	const maxChunks = opts?.maxChunks ?? DEFAULT_MAX_CHUNKS;
	const chunks: string[] = [];
	let current = '';
	const flush = (): void => {
		if (current) {
			chunks.push(current);
			current = '';
		}
	};
	for (const raw of text.split(/\n\s*\n/)) {
		if (chunks.length >= maxChunks) break;
		const para = raw.trim();
		if (para.length === 0) continue;
		if (para.length > maxChars) {
			flush();
			for (let i = 0; i < para.length && chunks.length < maxChunks; i += maxChars) {
				chunks.push(para.slice(i, i + maxChars));
			}
			continue;
		}
		if (current.length + para.length + 2 > maxChars) flush();
		current = current ? `${current}\n\n${para}` : para;
	}
	if (current && chunks.length < maxChunks) chunks.push(current);
	return chunks;
}

/**
 * Pick the scope a document's memories should live in: the CONTEXT (workspace)
 * scope, matching how the agent's own memories are written (resolveWriteScope
 * defaults to context). `getActiveScopes()[0]` is the GLOBAL scope — too broad,
 * lowest recall weight, would store cross-context, and is brittle to a reorder —
 * so we select by type, not position. Falls back to the first available scope
 * (global) when no context is active, and null when there are none.
 */
export function pickDocumentScope(scopes: ReadonlyArray<MemoryScopeRef>): MemoryScopeRef | null {
	return scopes.find((s) => s.type === 'context') ?? scopes[0] ?? null;
}

/**
 * Store an uploaded document's text into the knowledge layer as recall-sized
 * memories. Returns the number of chunks stored. Each chunk is tagged
 * `external_unverified` (untrusted uploaded content) so the recall path applies
 * its injection guard, and `document_upload` so the document's memories are
 * attributable. Best-effort: the caller fires this without awaiting.
 */
export async function ingestDocumentText(
	sink: DocumentMemorySink,
	params: { text: string; fileName: string; scope: MemoryScopeRef; threadId: string },
): Promise<number> {
	const chunks = chunkDocumentText(params.text);
	let stored = 0;
	for (const chunk of chunks) {
		await sink.store(`[Document: ${params.fileName}]\n${chunk}`, 'knowledge', params.scope, {
			sourceThreadId: params.threadId,
			// An uploaded document is untrusted external content → `upload` channel +
			// untrusted → external_unverified (Wave 1.3 §3; rule 1 and rule 3 agree here).
			sourceChannel: 'upload',
			sourceUntrusted: true,
			sourceToolName: 'document_upload',
		});
		stored++;
	}
	return stored;
}
