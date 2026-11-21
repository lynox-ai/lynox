// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';

import { printHtmlDocument, printMarkdownDocument } from './artifact-print.js';
import { answerFrameReady } from './artifact-frame-host.js';
import { FRAME_READY, FRAME_RENDER } from './artifact-frame-protocol.js';

// What the two print actions actually open: the sandboxed print window on the frame endpoint, and
// the document it is sent once it says ready. The policy that keeps an artifact's script from
// running is only worth something if it is in THAT document.
function opened(print: () => boolean): string {
	const sent: unknown[] = [];
	const popup = { postMessage: (m: unknown) => { sent.push(m); } } as unknown as Window;
	const open = vi.spyOn(window, 'open').mockReturnValue(popup);
	vi.stubGlobal('URL', Object.assign(Object.create(URL), {
		createObjectURL: () => { throw new Error('print must not open a blob: document in the app origin'); },
		revokeObjectURL: () => {},
	}));
	expect(print()).toBe(true);
	expect(open).toHaveBeenCalledWith('/_artifact-frame?print', '_blank');
	expect(answerFrameReady({ data: { type: FRAME_READY }, origin: 'null', source: popup })).toBe(true);
	expect(sent).toHaveLength(1);
	const msg = sent[0] as { type: string; html: string };
	expect(msg.type).toBe(FRAME_RENDER);
	return msg.html;
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe('the print actions open the print window and send it a document with its own script policy', () => {
	it.each([
		['an HTML artifact', () => printHtmlDocument('<html><body><p>x</p></body></html>')],
		['a markdown artifact', () => printMarkdownDocument('# Title\n\ntext', 'Title')],
	])('%s', (_k, print) => {
		const doc = opened(print).replace(/^<!DOCTYPE html>/i, '');
		expect(doc.startsWith('<meta http-equiv="Content-Security-Policy" content="script-src \'nonce-')).toBe(true);
		expect(doc).toContain('window.print()');
	});
});
