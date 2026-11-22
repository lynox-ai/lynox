import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// An undo puts back only items still as the bulk action left them; the toast says how many it
// put back and how many it left, with the numbers the server reports.

const toasts: Array<{ message: string; type: string }> = [];
vi.mock('./toast.svelte.js', () => ({
	addToast: (message: string, type: string) => { toasts.push({ message, type }); return 1; },
}));

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let undoBody: unknown;

beforeEach(() => {
	toasts.length = 0;
	vi.stubGlobal('fetch', vi.fn(async (url: string) => (String(url).includes('/inbox/undo/') ? json(undoBody) : json({ items: [], counts: {} }))));
});
afterEach(() => vi.unstubAllGlobals());

describe('undoBulk', () => {
	it('names what it put back and what it skipped when an item changed since', async () => {
		const { setLocale } = await import('../i18n.svelte.js');
		setLocale('de');
		const { undoBulk } = await import('./inbox.svelte.js');
		undoBody = { ok: true, reverted: 2, skipped: 1 };
		expect(await undoBulk('bulk_1', 'auto_handled')).toBe(true);
		expect(toasts).toContainEqual({ message: '2 zurückgeholt, 1 übersprungen, weil sie sich seither geändert haben.', type: 'info' });
		setLocale('en');
		toasts.length = 0;
		await undoBulk('bulk_1', 'auto_handled');
		expect(toasts).toContainEqual({ message: '2 restored, 1 skipped because they changed since.', type: 'info' });
	});

	it('says nothing more when every item was put back', async () => {
		const { undoBulk } = await import('./inbox.svelte.js');
		undoBody = { ok: true, reverted: 3, skipped: 0 };
		await undoBulk('bulk_2', 'auto_handled');
		expect(toasts).toEqual([]);
	});
});
