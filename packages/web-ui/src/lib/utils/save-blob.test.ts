import { afterEach, describe, expect, it, vi } from 'vitest';
import { saveOrShareBlob } from './save-blob.js';
import { __resetIosSafariCache } from './ios-safari.js';

const IPHONE_UA =
	'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const ANDROID_UA =
	'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36';
const DESKTOP_UA =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const ORIG = {
	navigator: (globalThis as { navigator?: unknown }).navigator,
	document: (globalThis as { document?: unknown }).document,
	URL: (globalThis as { URL?: unknown }).URL,
};

let anchor: { href: string; download: string; click: ReturnType<typeof vi.fn> };
let createElement: ReturnType<typeof vi.fn>;
let shareFn: ReturnType<typeof vi.fn>;

function setup(opts: { ua: string; canShare?: boolean; share?: () => Promise<void> }): void {
	__resetIosSafariCache();
	anchor = { href: '', download: '', click: vi.fn() };
	createElement = vi.fn(() => anchor);
	shareFn = vi.fn(opts.share ?? (() => Promise.resolve()));
	const nav: Record<string, unknown> = { userAgent: opts.ua, share: shareFn };
	if (opts.canShare !== undefined) nav['canShare'] = vi.fn(() => opts.canShare as boolean);
	// `navigator` is a getter-only global in newer Node — defineProperty, not assign.
	Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true, writable: true });
	(globalThis as { document?: unknown }).document = { createElement };
	(globalThis as { URL?: unknown }).URL = { createObjectURL: vi.fn(() => 'blob:mock'), revokeObjectURL: vi.fn() };
}

afterEach(() => {
	__resetIosSafariCache();
	Object.defineProperty(globalThis, 'navigator', { value: ORIG.navigator, configurable: true, writable: true });
	(globalThis as { document?: unknown }).document = ORIG.document;
	(globalThis as { URL?: unknown }).URL = ORIG.URL;
});

const pngBlob = (): Blob => new Blob(['x'], { type: 'image/png' });

describe('saveOrShareBlob', () => {
	it('iOS + shareable → Web Share, NO anchor download', async () => {
		setup({ ua: IPHONE_UA, canShare: true });
		await saveOrShareBlob(pngBlob(), 'a.png');
		expect(shareFn).toHaveBeenCalledOnce();
		expect(shareFn.mock.calls[0]![0]).toHaveProperty('files');
		expect(createElement).not.toHaveBeenCalled(); // the iOS bug this fixes
	});

	it('Android + shareable → Web Share sheet, NO anchor download', async () => {
		setup({ ua: ANDROID_UA, canShare: true });
		await saveOrShareBlob(pngBlob(), 'a.png');
		expect(shareFn).toHaveBeenCalledOnce();
		expect(createElement).not.toHaveBeenCalled();
	});

	it('Android WITHOUT Web Share (older) → falls back to download', async () => {
		setup({ ua: ANDROID_UA, canShare: false });
		await saveOrShareBlob(pngBlob(), 'a.png');
		expect(shareFn).not.toHaveBeenCalled();
		expect(anchor.click).toHaveBeenCalledOnce();
	});

	it('desktop → anchor download, Web Share NOT used', async () => {
		setup({ ua: DESKTOP_UA, canShare: true });
		await saveOrShareBlob(pngBlob(), 'a.png');
		expect(shareFn).not.toHaveBeenCalled();
		expect(createElement).toHaveBeenCalledWith('a');
		expect(anchor.download).toBe('a.png');
		expect(anchor.click).toHaveBeenCalledOnce();
	});

	it('iOS but canShare=false → falls back to download', async () => {
		setup({ ua: IPHONE_UA, canShare: false });
		await saveOrShareBlob(pngBlob(), 'a.png');
		expect(shareFn).not.toHaveBeenCalled();
		expect(anchor.click).toHaveBeenCalledOnce();
	});

	it('iOS + user cancels the share (AbortError) → does NOT surprise-download', async () => {
		setup({
			ua: IPHONE_UA,
			canShare: true,
			share: () => Promise.reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })),
		});
		await saveOrShareBlob(pngBlob(), 'a.png');
		expect(shareFn).toHaveBeenCalledOnce();
		expect(anchor.click).not.toHaveBeenCalled(); // cancel must be a no-op
	});

	it('iOS + share fails (non-abort) → falls back to download, never dead-ends', async () => {
		setup({
			ua: IPHONE_UA,
			canShare: true,
			share: () => Promise.reject(Object.assign(new Error('nope'), { name: 'NotAllowedError' })),
		});
		await saveOrShareBlob(pngBlob(), 'a.png');
		expect(shareFn).toHaveBeenCalledOnce();
		expect(anchor.click).toHaveBeenCalledOnce();
	});
});
