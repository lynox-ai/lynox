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
			const doc = await getDocumentProxy(new Uint8Array(buf));
			const { text } = await extractText(doc, { mergePages: true });
			merged = Array.isArray(text) ? text.join('\n') : String(text);
		} catch (err) {
			throw new DocumentExtractError('pdf', err instanceof Error ? err.message : 'PDF parse failed');
		}
		const trimmed = merged.trim();
		if (trimmed.length === 0) {
			throw new DocumentExtractError('pdf', 'No extractable text (the PDF may be scanned/image-only)');
		}
		const { text: capped, truncated } = cap(trimmed);
		return { format, text: capped, truncated };
	}

	// docx
	let value: string;
	try {
		const result = await mammoth.extractRawText({ buffer: buf });
		value = result.value;
	} catch (err) {
		throw new DocumentExtractError('docx', err instanceof Error ? err.message : 'DOCX parse failed');
	}
	const trimmed = value.trim();
	if (trimmed.length === 0) {
		throw new DocumentExtractError('docx', 'No extractable text in the Word document');
	}
	const { text: capped, truncated } = cap(trimmed);
	return { format, text: capped, truncated };
}
