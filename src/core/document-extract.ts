/**
 * Server-side text extraction for uploaded documents (U1).
 *
 * Chat uploads of PDF / Word files used to be rejected with a 415 ("inline text
 * extraction isn't supported yet") because the bytes are binary. This module
 * extracts their text so the agent can actually read them. Spreadsheets / slides
 * (.xlsx / .pptx) and scanned/image-only PDFs are out of scope for v1 and still
 * fall through to the caller's existing handling.
 *
 * Libraries: `unpdf` (a serverless/Node build of Mozilla's pdf.js) for PDF,
 * `mammoth` for DOCX — both pure-JS, ESM-importable in the Node engine.
 */
import zlib from 'node:zlib';
import { extractText, getDocumentProxy } from 'unpdf';
import mammoth from 'mammoth';

export type ExtractableFormat = 'pdf' | 'docx';

export interface DocumentExtractResult {
	format: ExtractableFormat;
	text: string;
	/** True when the extracted text was capped at MAX_EXTRACTED_CHARS. */
	truncated: boolean;
}

/** Raised when a recognized format (PDF/DOCX) cannot be parsed (corrupt / encrypted / image-only). */
export class DocumentExtractError extends Error {
	constructor(
		readonly format: ExtractableFormat,
		message: string,
	) {
		super(message);
		this.name = 'DocumentExtractError';
	}
}

const PDF_MAGIC = Buffer.from('%PDF', 'latin1');
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // "PK\x03\x04"

/** Mirror of the existing inline-text cap so a huge document can't flood the model context. */
export const MAX_EXTRACTED_CHARS = 200_000;

/**
 * Detect a supported document format from the leading bytes + filename.
 * Returns null for anything we don't extract (the caller keeps its behaviour).
 *
 * DOCX shares the ZIP magic with .xlsx/.pptx/.jar, so we additionally gate on
 * the `.docx` extension — attempting a Word-body extraction on a spreadsheet
 * would just throw, and we'd rather let those fall through to the 415 path.
 */
export function detectDocumentFormat(buf: Buffer, fileName: string): ExtractableFormat | null {
	if (buf.length >= 4 && buf.subarray(0, 4).equals(PDF_MAGIC)) return 'pdf';
	if (
		buf.length >= 4 &&
		buf.subarray(0, 4).equals(ZIP_MAGIC) &&
		fileName.toLowerCase().endsWith('.docx')
	) {
		return 'docx';
	}
	return null;
}

function cap(text: string): { text: string; truncated: boolean } {
	if (text.length <= MAX_EXTRACTED_CHARS) return { text, truncated: false };
	const omitted = text.length - MAX_EXTRACTED_CHARS;
	return {
		text: `${text.slice(0, MAX_EXTRACTED_CHARS)}\n[…truncated, ${String(omitted)} chars omitted]`,
		truncated: true,
	};
}

/**
 * Hard ceiling on a DOCX's *decompressed* size. The 10 MB base64 upload cap
 * bounds the COMPRESSED input, but DEFLATE inflates ~1000x, so a small malicious
 * .docx (a repetitive `word/document.xml`) can expand to gigabytes inside
 * `mammoth.extractRawText` and OOM the worker before MAX_EXTRACTED_CHARS (which
 * only caps the OUTPUT string) ever applies. We pre-scan the ZIP central
 * directory — reading the declared uncompressed sizes WITHOUT inflating anything
 * — and reject before handing the buffer to mammoth. 50 MB is far above any real
 * text document (even image-heavy ones) yet far below the GB range a bomb needs.
 */
export const MAX_DOCX_DECOMPRESSED_BYTES = 50 * 1024 * 1024;

/** Wall-clock bound on a single extraction so a pathological file can't hang the request. */
const EXTRACT_TIMEOUT_MS = 15_000;

/**
 * Reject a DOCX that decompresses to more than `max` bytes, with peak memory
 * bounded to `max` (NOT the bomb's full size). Walks the ZIP central directory
 * for each entry's compressed range, then ACTUALLY inflates it through a hard
 * output cap (`zlib` `maxOutputLength`) and sums the real output against the
 * budget. Checking the *declared* uncompressed size is not enough: jszip (and
 * pako) inflate the real DEFLATE stream and only notice a size mismatch AFTER
 * fully materializing it, so a bomb that lies about its declared size would
 * still OOM the worker before mammoth. Inflating with a cap measures the TRUE
 * size and aborts at the budget. A ZIP64 sentinel (0xFFFFFFFF) is rejected
 * outright (a real text .docx never needs it). If the structure can't be parsed
 * the buffer is left to mammoth, which rejects a non-ZIP with a DocumentExtractError.
 *
 * Exported for unit testing.
 */
export function assertDocxWithinDecompressedBound(buf: Buffer, max: number): void {
	const EOCD_SIG = 0x06054b50;
	const CDH_SIG = 0x02014b50;
	const LFH_SIG = 0x04034b50;
	// EOCD is the trailing 22 bytes (Office docs carry no archive comment); scan
	// back up to the 64 KB a comment could otherwise add.
	let eocd = -1;
	const minPos = Math.max(0, buf.length - 22 - 0xffff);
	for (let i = buf.length - 22; i >= minPos; i--) {
		if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
	}
	if (eocd < 0) return; // not a parseable ZIP — let mammoth throw
	const entries = buf.readUInt16LE(eocd + 10);
	let off = buf.readUInt32LE(eocd + 16); // central-directory start offset
	let remaining = max;
	const tooLarge = (): never => {
		throw new DocumentExtractError('docx', 'document is too large to read safely');
	};
	for (let n = 0; n < entries; n++) {
		// A central-directory record we cannot read means we cannot reliably find
		// the NEXT record either — stop (jszip would fail to parse it too). But a
		// problem with a single entry's *data* (truncated / corrupt / unknown
		// method) must NOT abort the whole scan: the central record still tells us
		// where the next record is, and mammoth inflates entries LAZILY (only the
		// parts it reads, e.g. word/document.xml), so a junk entry crafted to make
		// us bail early could otherwise hide a real bomb in a later entry. Skip the
		// bad entry, keep scanning.
		if (off + 46 > buf.length || buf.readUInt32LE(off) !== CDH_SIG) return; // central dir unreadable — defer to mammoth
		const method = buf.readUInt16LE(off + 10);
		const compSize = buf.readUInt32LE(off + 20);
		const uncompDeclared = buf.readUInt32LE(off + 24);
		const nameLen = buf.readUInt16LE(off + 28);
		const extraLen = buf.readUInt16LE(off + 30);
		const commentLen = buf.readUInt16LE(off + 32);
		const localOff = buf.readUInt32LE(off + 42);
		const nextOff = off + 46 + nameLen + extraLen + commentLen; // reliable from the central record
		// ZIP64 escapes the 32-bit size fields — a real text document never needs
		// it, so treat the sentinel as a refusal rather than parsing the extra field.
		if (uncompDeclared === 0xffffffff || compSize === 0xffffffff || localOff === 0xffffffff) tooLarge();
		if (method === 0) {
			// stored: real uncompressed size == compressed size (the declared field is untrusted)
			remaining -= compSize;
			if (remaining < 0) tooLarge();
		} else if (method === 8 && compSize > 0 && localOff + 30 <= buf.length && buf.readUInt32LE(localOff) === LFH_SIG) {
			// Find the data start from the LOCAL header's own name/extra lengths
			// (they can differ from the central record), then inflate with a cap.
			const lNameLen = buf.readUInt16LE(localOff + 26);
			const lExtraLen = buf.readUInt16LE(localOff + 28);
			const dataStart = localOff + 30 + lNameLen + lExtraLen;
			if (dataStart + compSize <= buf.length) {
				const comp = buf.subarray(dataStart, dataStart + compSize);
				try {
					const out = zlib.inflateRawSync(comp, { maxOutputLength: remaining });
					remaining -= out.length;
				} catch (err) {
					// Over the cap -> reject. Any other inflate error (corrupt stream)
					// -> skip this one entry and keep scanning the rest.
					if ((err as NodeJS.ErrnoException | undefined)?.code === 'ERR_BUFFER_TOO_LARGE') tooLarge();
				}
			}
			// truncated data (dataStart+compSize past EOF) -> skip this entry, keep scanning
		}
		off = nextOff;
	}
}

/**
 * Reject a promise that doesn't settle within `ms`. The underlying work may keep
 * running, but the request is bounded; the size caps bound the actual CPU/memory.
 * Exported for unit testing.
 */
export async function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => { reject(onTimeout()); }, ms);
	});
	try {
		return await Promise.race([p, timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/**
 * Extract plain text from a supported document. Returns null when the format is
 * not one we extract (caller keeps existing handling); throws
 * `DocumentExtractError` when a recognized format fails to parse (corrupt,
 * encrypted, or scanned image-only — no embedded text).
 */
export async function extractDocumentText(
	buf: Buffer,
	fileName: string,
): Promise<DocumentExtractResult | null> {
	const format = detectDocumentFormat(buf, fileName);
	if (format === null) return null;

	if (format === 'pdf') {
		let merged: string;
		try {
			merged = await withTimeout(
				(async () => {
					const doc = await getDocumentProxy(new Uint8Array(buf));
					const { text } = await extractText(doc, { mergePages: true });
					return Array.isArray(text) ? text.join('\n') : String(text);
				})(),
				EXTRACT_TIMEOUT_MS,
				() => new DocumentExtractError('pdf', 'PDF extraction timed out'),
			);
		} catch (err) {
			if (err instanceof DocumentExtractError) throw err;
			throw new DocumentExtractError('pdf', err instanceof Error ? err.message : 'PDF parse failed');
		}
		const trimmed = merged.trim();
		if (trimmed.length === 0) {
			throw new DocumentExtractError('pdf', 'No extractable text (the PDF may be scanned/image-only)');
		}
		const { text: capped, truncated } = cap(trimmed);
		return { format, text: capped, truncated };
	}

	// docx — bound the decompressed size BEFORE mammoth inflates the zip (throws
	// DocumentExtractError on a decompression bomb; its own inflation is hard-capped).
	assertDocxWithinDecompressedBound(buf, MAX_DOCX_DECOMPRESSED_BYTES);
	let value: string;
	try {
		value = await withTimeout(
			mammoth.extractRawText({ buffer: buf }).then((result) => result.value),
			EXTRACT_TIMEOUT_MS,
			() => new DocumentExtractError('docx', 'DOCX extraction timed out'),
		);
	} catch (err) {
		if (err instanceof DocumentExtractError) throw err;
		throw new DocumentExtractError('docx', err instanceof Error ? err.message : 'DOCX parse failed');
	}
	const trimmed = value.trim();
	if (trimmed.length === 0) {
		throw new DocumentExtractError('docx', 'No extractable text in the Word document');
	}
	const { text: capped, truncated } = cap(trimmed);
	return { format, text: capped, truncated };
}
