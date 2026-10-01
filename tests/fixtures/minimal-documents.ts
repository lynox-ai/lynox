/**
 * Minimal, self-contained PDF / DOCX generators for tests.
 *
 * Both were validated to round-trip through unpdf / mammoth before being committed,
 * so no binary blobs are checked in. They live here rather than beside one test
 * because two suites need them — the extractor's own unit tests and the HTTP upload
 * route test, which drives a real document through the real extractor instead of
 * mocking it away.
 */
import zlib from 'node:zlib';

/** A one-page PDF whose only content is `text`, with a correctly computed xref. */
export function buildPdf(text: string): Buffer {
	const objs: (string | null)[] = [
		'<</Type/Catalog/Pages 2 0 R>>',
		'<</Type/Pages/Kids[3 0 R]/Count 1>>',
		'<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
		null,
		'<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
	];
	const stream = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;
	objs[3] = `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`;

	let pdf = '%PDF-1.4\n';
	const offsets: number[] = [];
	objs.forEach((body, i) => {
		offsets[i] = Buffer.byteLength(pdf, 'latin1');
		pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
	});
	const xrefOffset = Buffer.byteLength(pdf, 'latin1');
	pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
	for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
	pdf += `trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xrefOffset}\n%%EOF`;
	return Buffer.from(pdf, 'latin1');
}

/** A single-paragraph .docx — a hand-built stored (uncompressed) ZIP. */
export function buildDocx(bodyText: string): Buffer {
	const parts: [string, string][] = [
		['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`],
		['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`],
		['word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t xml:space="preserve">${bodyText}</w:t></w:r></w:p></w:body></w:document>`],
	];
	const locals: Buffer[] = [];
	const central: Buffer[] = [];
	let offset = 0;
	for (const [name, content] of parts) {
		const data = Buffer.from(content, 'utf-8');
		const crc = zlib.crc32(data) >>> 0;
		const nameBuf = Buffer.from(name, 'utf-8');
		const lh = Buffer.alloc(30);
		lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4);
		lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22);
		lh.writeUInt16LE(nameBuf.length, 26);
		locals.push(lh, nameBuf, data);
		const ch = Buffer.alloc(46);
		ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
		ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24);
		ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(offset, 42);
		central.push(ch, nameBuf);
		offset += lh.length + nameBuf.length + data.length;
	}
	const localBuf = Buffer.concat(locals);
	const centralBuf = Buffer.concat(central);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(parts.length, 8); eocd.writeUInt16LE(parts.length, 10);
	eocd.writeUInt32LE(centralBuf.length, 12); eocd.writeUInt32LE(localBuf.length, 16);
	return Buffer.concat([localBuf, centralBuf, eocd]);
}
