// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';

import { printHtmlDocument, printMarkdownDocument } from './artifact-print.js';

// What the two print actions actually open: the blob behind the popup's URL. The policy that keeps
// an artifact's script from running is only worth something if it is in THAT document.
async function opened(print: () => boolean): Promise<string> {
	const blobs: Blob[] = [];
	vi.stubGlobal('URL', Object.assign(Object.create(URL), {
		createObjectURL: (blob: Blob) => { blobs.push(blob); return 'blob:test'; },
		revokeObjectURL: () => {},
	}));
	vi.spyOn(window, 'open').mockReturnValue({} as Window);
	expect(print()).toBe(true);
	expect(blobs).toHaveLength(1);
	return blobs[0]!.text();
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe('the print actions open a document with its own script policy', () => {
	it.each([
		['an HTML artifact', () => printHtmlDocument('<html><body><p>x</p></body></html>')],
		['a markdown artifact', () => printMarkdownDocument('# Title\n\ntext', 'Title')],
	])('%s', async (_k, print) => {
		const doc = await opened(print);
		expect(doc.startsWith('<meta http-equiv="Content-Security-Policy" content="script-src \'nonce-')).toBe(true);
		expect(doc).toContain('window.print()');
	});
});
