import { describe, it, expect } from 'vitest';
import { chunkDocumentText, chunkDocumentTextReportingCut, ingestDocumentText, pickDocumentScope, DEFAULT_MAX_CHARS, DEFAULT_MAX_CHUNKS, type DocumentMemorySink } from './document-ingest.js';
import { MAX_EXTRACTED_CHARS } from './document-extract.js';
import type { MemoryNamespace, MemoryScopeRef } from '../types/memory.js';
import { OWNER_PRINCIPAL } from './request-principal.js';

describe('chunkDocumentText', () => {
	it('returns [] for empty / whitespace-only text', () => {
		expect(chunkDocumentText('')).toEqual([]);
		expect(chunkDocumentText('   \n\n  ')).toEqual([]);
	});

	it('keeps a short document as a single chunk', () => {
		expect(chunkDocumentText('Hello world.')).toEqual(['Hello world.']);
	});

	it('packs consecutive paragraphs up to maxChars', () => {
		expect(chunkDocumentText('aaa\n\nbbb\n\nccc', { maxChars: 8 })).toEqual(['aaa\n\nbbb', 'ccc']);
	});

	it('hard-splits a single paragraph longer than maxChars', () => {
		expect(chunkDocumentText('x'.repeat(25), { maxChars: 10 })).toEqual([
			'x'.repeat(10),
			'x'.repeat(10),
			'x'.repeat(5),
		]);
	});

	it('stops at maxChunks', () => {
		const many = Array.from({ length: 50 }, () => 'ab').join('\n\n');
		expect(chunkDocumentText(many, { maxChars: 5, maxChunks: 3 }).length).toBe(3);
	});
});

interface RecordedCall {
	text: string;
	namespace: MemoryNamespace;
	scope: MemoryScopeRef;
	options?: { sourceThreadId?: string; sourceChannel?: string; sourceUntrusted?: boolean; sourceToolName?: string; cancelled?: (() => boolean) | undefined };
}

function fakeSink(): { sink: DocumentMemorySink; calls: RecordedCall[] } {
	const calls: RecordedCall[] = [];
	const sink: DocumentMemorySink = {
		async store(text, namespace, scope, options) {
			calls.push({ text, namespace, scope, options });
			return {};
		},
	};
	return { sink, calls };
}

const scope: MemoryScopeRef = { type: 'context', id: 'ctx-1' };

describe('pickDocumentScope', () => {
	it('selects the context (workspace) scope, not the global [0]', () => {
		const scopes: MemoryScopeRef[] = [
			{ type: 'global', id: 'global' },
			{ type: 'context', id: 'ws-1' },
			{ type: 'user', id: 'u-1' },
		];
		expect(pickDocumentScope(scopes)).toEqual({ type: 'context', id: 'ws-1' });
	});

	it('falls back to the first scope when no context is active', () => {
		expect(pickDocumentScope([{ type: 'global', id: 'global' }])).toEqual({ type: 'global', id: 'global' });
	});

	it('returns null when there are no scopes', () => {
		expect(pickDocumentScope([])).toBeNull();
	});
});

describe('chunkDocumentTextReportingCut', () => {
	const full = 'x'.repeat(DEFAULT_MAX_CHUNKS * DEFAULT_MAX_CHARS);

	it('leaves nothing out of a text that fills the cap exactly', () => {
		expect(chunkDocumentTextReportingCut(full)).toMatchObject({ dropped: false });
	});

	it('reports a paragraph the cap stops in the middle of', () => {
		expect(chunkDocumentTextReportingCut(`${full}x`).dropped).toBe(true);
	});

	it('reports a paragraph after the cap is full', () => {
		expect(chunkDocumentTextReportingCut(`${full}\n\nnext`).dropped).toBe(true);
	});

	it('does not report blank lines after a full cap', () => {
		expect(chunkDocumentTextReportingCut(`${full}\n\n   \n\n`).dropped).toBe(false);
	});
});

describe('ingestDocumentText', () => {
	it('stores one knowledge memory per chunk with document provenance', async () => {
		const { sink, calls } = fakeSink();
		const text = 'first paragraph\n\n' + 'y'.repeat(30);
		const n = await ingestDocumentText(sink, { text, fileName: 'report.pdf', scope, threadId: 'th-9', durableKnowledgeActive: false, isPrivate: () => false, cutAtExtraction: false, principal: OWNER_PRINCIPAL });

		expect(n).toBe(calls.length);
		expect(n).toBeGreaterThanOrEqual(1);
		for (const c of calls) {
			expect(c.namespace).toBe('knowledge');
			expect(c.scope).toBe(scope);
			expect(c.text.startsWith('[Document: report.pdf]\n')).toBe(true);
			// Wave 1.3: the sink reports EVIDENCE (upload channel + untrusted), and the tier
			// is derived downstream at the store boundary (→ external_unverified).
			expect(c.options?.sourceChannel).toBe('upload');
			expect(c.options?.sourceUntrusted).toBe(true);
			expect(c.options?.sourceToolName).toBe('document_upload');
			expect(c.options?.sourceThreadId).toBe('th-9');
		}
	});

	const CUT_HEADER = '[Document: report.pdf — CUT: only the beginning of this document is stored]\n';

	it('the chunk cap holds no more than the extractor keeps', () => {
		// Capacity only: whether a given cut text fits also depends on the whitespace the chunks drop.
		expect(DEFAULT_MAX_CHUNKS * DEFAULT_MAX_CHARS).toBeLessThanOrEqual(MAX_EXTRACTED_CHARS);
	});

	it('marks every chunk of a document the extractor cut, though it fits the chunk cap', async () => {
		const { sink, calls } = fakeSink();
		const text = ['a'.repeat(1900), 'b'.repeat(1900), 'c'.repeat(1900) + '\n[…truncated]'].join('\n\n');
		const n = await ingestDocumentText(sink, { text, fileName: 'report.pdf', scope, threadId: 'th-9', durableKnowledgeActive: false, isPrivate: () => false, cutAtExtraction: true, principal: OWNER_PRINCIPAL });

		expect(n).toBe(3);
		for (const c of calls) expect(c.text.startsWith(CUT_HEADER)).toBe(true);
	});

	it('marks every chunk of a document the chunk cap cut, not only the last one', async () => {
		const { sink, calls } = fakeSink();
		// 101 paragraphs that each fill a chunk: the 101st is left out.
		const text = Array.from({ length: 101 }, (_, i) => `${String(i)} ${'x'.repeat(1900)}`).join('\n\n');
		const n = await ingestDocumentText(sink, { text, fileName: 'report.pdf', scope, threadId: 'th-9', durableKnowledgeActive: false, isPrivate: () => false, cutAtExtraction: false, principal: OWNER_PRINCIPAL });

		expect(n).toBe(100);
		for (const c of calls) expect(c.text.startsWith(CUT_HEADER)).toBe(true);
	});

	it('does not mark a document that fits, up to exactly the chunk cap', async () => {
		const { sink, calls } = fakeSink();
		const text = Array.from({ length: 100 }, (_, i) => `${String(i)} ${'x'.repeat(1900)}`).join('\n\n');
		const n = await ingestDocumentText(sink, { text, fileName: 'report.pdf', scope, threadId: 'th-9', durableKnowledgeActive: false, isPrivate: () => false, cutAtExtraction: false, principal: OWNER_PRINCIPAL });

		expect(n).toBe(100);
		for (const c of calls) expect(c.text.startsWith('[Document: report.pdf]\n')).toBe(true);
	});

	it('stores nothing for an empty document', async () => {
		const { sink, calls } = fakeSink();
		const n = await ingestDocumentText(sink, { text: '   ', fileName: 'x.pdf', scope, threadId: 't', durableKnowledgeActive: false, isPrivate: () => false, cutAtExtraction: false, principal: OWNER_PRINCIPAL });
		expect(n).toBe(0);
		expect(calls.length).toBe(0);
	});

	it('writes NOTHING to the archive when the durable substrate is active', async () => {
		const { sink, calls } = fakeSink();
		// Same input that stores several chunks above — only the substrate differs, so a
		// zero here can only come from the DK guard, not from an empty/short document.
		const text = 'first paragraph\n\n' + 'y'.repeat(30);
		const n = await ingestDocumentText(sink, { text, fileName: 'report.pdf', scope, threadId: 'th-9', durableKnowledgeActive: true, isPrivate: () => false, cutAtExtraction: false, principal: OWNER_PRINCIPAL });
		expect(n).toBe(0);
		expect(calls).toHaveLength(0);
	});

	it('still writes the archive when the durable substrate is OFF — byte-identical legacy path', async () => {
		// The pair matters more than either half: it pins that the guard keys on the
		// substrate and nothing else. Without this, dropping the write unconditionally
		// would also pass — and would silently take document recall away from every
		// self-hosted (flag-off) tenant.
		const { sink, calls } = fakeSink();
		const text = 'first paragraph\n\n' + 'y'.repeat(30);
		const n = await ingestDocumentText(sink, { text, fileName: 'report.pdf', scope, threadId: 'th-9', durableKnowledgeActive: false, isPrivate: () => false, cutAtExtraction: false, principal: OWNER_PRINCIPAL });
		expect(n).toBeGreaterThanOrEqual(1);
		expect(calls).toHaveLength(n);
	});

	it('stores nothing from a chat that is already private', async () => {
		const { sink, calls } = fakeSink();
		const text = 'first paragraph\n\n' + 'y'.repeat(30);
		const n = await ingestDocumentText(sink, { text, fileName: 'report.pdf', scope, threadId: 'th-9', durableKnowledgeActive: false, isPrivate: () => true, cutAtExtraction: false, principal: OWNER_PRINCIPAL });
		expect(n).toBe(0);
		expect(calls).toHaveLength(0);
	});

	it('hands the same predicate to the store, which asks it after its own awaits', async () => {
		const { sink, calls } = fakeSink();
		const isPrivate = (): boolean => false;
		const text = 'first paragraph\n\n' + 'y'.repeat(30);
		await ingestDocumentText(sink, { text, fileName: 'report.pdf', scope, threadId: 'th-9', durableKnowledgeActive: false, isPrivate, cutAtExtraction: false, principal: OWNER_PRINCIPAL });
		expect(calls.length).toBeGreaterThan(0);
		for (const c of calls) expect(c.options?.cancelled).toBe(isPrivate);
	});

	it('stops at the next chunk when private mode is switched on during the ingest', async () => {
		const { sink, calls } = fakeSink();
		// Three paragraphs over the 2000-char chunk size: three chunks.
		const text = ['a', 'b', 'c'].map(c => c.repeat(1900)).join('\n\n');
		let privateMode = false;
		const flipping: typeof sink = {
			store: async (...args) => { const r = await sink.store(...args); privateMode = true; return r; },
		};
		const n = await ingestDocumentText(flipping, { text, fileName: 'report.pdf', scope, threadId: 'th-9', durableKnowledgeActive: false, isPrivate: () => privateMode, cutAtExtraction: false, principal: OWNER_PRINCIPAL });
		expect(n).toBe(1);
		expect(calls).toHaveLength(1);
		// Positive control: the same text, never private, is more than one chunk.
		const control = fakeSink();
		const all = await ingestDocumentText(control.sink, { text, fileName: 'report.pdf', scope, threadId: 'th-9', durableKnowledgeActive: false, isPrivate: () => false, cutAtExtraction: false, principal: OWNER_PRINCIPAL });
		expect(all).toBeGreaterThan(1);
	});
});
