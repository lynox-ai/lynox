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
			/** Asked by the store after each of its own awaits (`KnowledgeLayer.store`). */
			cancelled?: (() => boolean) | undefined;
		},
	): Promise<unknown>;
}

// Chunk size aligned with the embedding truncation cap (embedding.ts MAX_EMBED_CHARS
// = 2000): a chunk past it wouldn't add similarity signal. The chunk-count cap
// bounds storage + extraction work; it holds at most 200k chars, and a document the
// extractor kept whole can still be cut by it (paragraph packing leaves chunks short).
export const DEFAULT_MAX_CHARS = 2000;
export const DEFAULT_MAX_CHUNKS = 100;

/**
 * Split extracted document text into recall-sized chunks on paragraph
 * boundaries: pack paragraphs up to `maxChars`, hard-split any single paragraph
 * longer than that, and stop at `maxChunks`. Pure + unit-testable.
 */
export function chunkDocumentText(
	text: string,
	opts?: { maxChars?: number; maxChunks?: number },
): string[] {
	return chunkDocumentTextReportingCut(text, opts).chunks;
}

/** {@link chunkDocumentText}, plus whether `maxChunks` left text out: `dropped` is true when
 *  some paragraph content is in no chunk (whitespace between paragraphs is never stored). */
export function chunkDocumentTextReportingCut(
	text: string,
	opts?: { maxChars?: number; maxChunks?: number },
): { chunks: string[]; dropped: boolean } {
	const maxChars = opts?.maxChars ?? DEFAULT_MAX_CHARS;
	const maxChunks = opts?.maxChunks ?? DEFAULT_MAX_CHUNKS;
	const chunks: string[] = [];
	let current = '';
	let dropped = false;
	const flush = (): void => {
		if (current) {
			chunks.push(current);
			current = '';
		}
	};
	for (const raw of text.split(/\n\s*\n/)) {
		const para = raw.trim();
		if (para.length === 0) continue;
		if (chunks.length >= maxChunks) { dropped = true; break; }
		if (para.length > maxChars) {
			flush();
			for (let i = 0; i < para.length; i += maxChars) {
				if (chunks.length >= maxChunks) { dropped = true; break; }
				chunks.push(para.slice(i, i + maxChars));
			}
			if (dropped) break;
			continue;
		}
		if (current.length + para.length + 2 > maxChars) flush();
		current = current ? `${current}\n\n${para}` : para;
	}
	if (current) {
		if (chunks.length < maxChunks) chunks.push(current);
		else dropped = true;
	}
	return { chunks, dropped };
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
 * memories. Returns the number of chunks handed to the store — the store may still
 * drop one (a dedup hit, or `cancelled`), so it is an upper bound. Each chunk is tagged
 * `external_unverified` (untrusted uploaded content) so the recall path applies
 * its injection guard, and `document_upload` so the document's memories are
 * attributable. Best-effort: the caller fires this without awaiting.
 *
 * `durableKnowledgeActive` is REQUIRED rather than optional so the compiler
 * enumerates every caller: the answer decides whether this writes at all, and a
 * caller that forgot to pass it would silently keep the legacy write alive.
 * When it is true the archive is NOT written — see the guard below for why.
 *
 * `isPrivate` is REQUIRED for the same reason. It is asked before the first chunk and
 * again before each one, because the caller fires this after the run is accepted and
 * private mode can be switched on while the chunks are embedding. A chat in private mode
 * stores nothing here: the switch's own purge removes what carries the thread id, and a
 * chunk written after it would carry the id and stay. A check here cannot reach a chunk
 * whose `store` call is already in flight when the switch is flipped, so the predicate is
 * also handed to `store` as `cancelled`, which asks it again after each of its own awaits.
 */
export async function ingestDocumentText(
	sink: DocumentMemorySink,
	params: {
		text: string;
		fileName: string;
		scope: MemoryScopeRef;
		threadId: string;
		durableKnowledgeActive: boolean;
		/** Whether the chat is in private mode NOW — read again before every chunk. */
		isPrivate: () => boolean;
		/** Whether the extractor cut the text. REQUIRED for the reason above: a caller that forgot
		 *  it would store a cut document as a whole one. */
		cutAtExtraction: boolean;
	},
): Promise<number> {
	// Under the durable substrate this path is the LAST writer into the legacy
	// agent-memory store, and writing there buys nothing: `recall` and the
	// always-loaded block both read `knowledge_entries` and never see it, so the
	// chunks would be reachable only through `archive_search` — a tool whose own
	// description tells the model it holds facts "collected BEFORE the durable-memory
	// cutover". A document uploaded a minute ago does not belong there.
	//
	// Nor do the chunks belong in `knowledge_entries`: that store ranks by raw token
	// overlap, so 2000-char excerpts would outrank every one-sentence fact and eat the
	// recall budget. A document is SOURCE MATERIAL, not a durable fact.
	//
	// So under DK nothing is persisted here. The extracted text is still inlined into the
	// turn by the caller and rides the thread's own history, so the document stays
	// available for the rest of that conversation; what the model judges durable it
	// records via `remember`. Keeping the archive un-written also makes
	// `archive_search`'s "before the cutover" description true again.
	//
	// The trade, stated rather than implied: cross-THREAD reachability of the raw text
	// goes away. It was only ever reachable through `archive_search` anyway, and the
	// automatic recall path was already dead under DK (`session.ts` skips
	// `knowledgeLayer.retrieve`) — but a document whose facts the model does not record
	// leaves no durable trace, and measured capture is low. That is the accepted cost of
	// treating a document as source material rather than as durable knowledge.
	//
	// NOT claimed here, because it is not true: that an upload routes the turn's writes
	// to the review queue. `deriveTurnUntrusted` is seated only from TOOL signals (a
	// wrapped tool result, an external-content tool at dispatch, or the rehydration scan
	// for those two); an HTTP-attached document sets none of them. That gap predates this
	// change — do not read this branch as if a trust gate had replaced the tier the
	// archive copy used to carry.
	if (params.durableKnowledgeActive) return 0;

	const { chunks, dropped } = chunkDocumentTextReportingCut(params.text);
	// Two cuts, each reported by what made it: the extractor's, and the chunk cap's, which also
	// cuts documents the extractor kept whole. Neither implies the other: the cap usually drops a
	// cut text's own marker at its end, but text with much whitespace between paragraphs can fit.
	// Recall returns chunks one at a time, so every chunk says so in its header.
	const header = params.cutAtExtraction || dropped
		? `[Document: ${params.fileName} — CUT: only the beginning of this document is stored]`
		: `[Document: ${params.fileName}]`;
	let stored = 0;
	for (const chunk of chunks) {
		if (params.isPrivate()) break;
		await sink.store(`${header}\n${chunk}`, 'knowledge', params.scope, {
			sourceThreadId: params.threadId,
			// An uploaded document is untrusted external content → `upload` channel +
			// untrusted → external_unverified (Wave 1.3 §3; rule 1 and rule 3 agree here).
			sourceChannel: 'upload',
			sourceUntrusted: true,
			sourceToolName: 'document_upload',
			// The same question, asked again inside the store after the embedding and the
			// entity extraction: a chunk already in flight when the switch flips is dropped there.
			cancelled: params.isPrivate,
		});
		stored++;
	}
	return stored;
}
