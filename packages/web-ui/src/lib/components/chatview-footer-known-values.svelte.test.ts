import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readable } from 'svelte/store';

// The message footer shows a stats segment only when its value is known. A turn stopped before
// any token was counted used to read `Σ 0 tokens · -` under its note. Rendered here from the
// usage the thread load hands over (`usage_json` on the server), which is also the shape the
// live stream leaves on a stopped turn: zeros plus the client-measured first-event time.

// As in chatview-onboarding-mandate: the client entry of `svelte` stands in for its server entry.
const CLIENT_ENTRY = vi.hoisted(() => {
	const { createRequire: req } = require('node:module') as typeof import('node:module');
	const { dirname: dir, join: jn } = require('node:path') as typeof import('node:path');
	return jn(dir(req(import.meta.url).resolve('svelte/package.json')), 'src/index-client.js');
});
vi.mock('svelte', async () => import(/* @vite-ignore */ CLIENT_ENTRY));
type SvelteClient = {
	mount: (c: unknown, o: { target: Element }) => Record<string, unknown>;
	unmount: (c: Record<string, unknown>) => void;
	flushSync: () => void;
};

vi.mock('$app/stores', () => ({ page: readable({ url: new URL('http://localhost/app') }) }));
vi.mock('$app/navigation', () => ({
	goto: vi.fn(), afterNavigate: vi.fn(), beforeNavigate: vi.fn(), onNavigate: vi.fn(), invalidate: vi.fn(), invalidateAll: vi.fn(),
}));
vi.mock('./MarkdownRenderer.svelte', () => ({ default: () => {} }));

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const settle = async (): Promise<void> => { for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 0)); };

let svelte: SvelteClient;
let target: HTMLElement;
let component: Record<string, unknown> | undefined;
let t: (key: string) => string;

/** A reloaded thread whose last answer carries `usage`, as `GET /threads/:id/messages` returns it. */
async function render(usage: Record<string, unknown>): Promise<void> {
	vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
		const url = String(input);
		if (url.includes('/threads/foot/messages')) {
			return json({
				messages: [{ role: 'user', content: 'Werte aus' }, { role: 'assistant', content: 'Antwort', usage }],
				activeRun: null,
			});
		}
		if (url.endsWith('/onboarding/status')) return json({ knowledgeDone: true, skipped: true, durableMemory: false, firstSessionAt: 'x' });
		if (url.endsWith('/sessions')) return json({ sessionId: 'foot' });
		if (url.endsWith('/runs/active')) return json({ runs: [] });
		if (url.endsWith('/artifacts')) return json({ artifacts: [] });
		return json({});
	}));
	const store = await import('../stores/chat.svelte.js');
	await store.resumeThread('foot');
	await settle();
	const { default: ChatView } = await import('./ChatView.svelte');
	component = svelte.mount(ChatView, { target });
	svelte.flushSync();
	await settle();
	svelte.flushSync();
}

/** The answer's footer row: stats line (if any) plus the action buttons. */
const footerRow = (): Element => {
	const copy = [...target.querySelectorAll(`button[aria-label="${t('common.copy')}"]`)];
	expect(copy).toHaveLength(1);
	const row = copy[0]?.closest('.mt-2');
	if (!row) throw new Error('no footer row');
	return row;
};
const statsLine = (): Element | null => footerRow().querySelector('.scrollbar-none');
/** The stats line as read, separators included, the screen-reader twins left out. */
const visibleText = (el: Element): string => {
	const clone = el.cloneNode(true) as Element;
	clone.querySelectorAll('.sr-only').forEach((n) => n.remove());
	return (clone.textContent ?? '').replace(/\s+/g, ' ').trim();
};

beforeEach(async () => {
	vi.stubGlobal('navigator', { onLine: true });
	// The stats line scroll-fades its clipped edge, which jsdom cannot measure.
	vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} });
	svelte = (await import('svelte')) as unknown as SvelteClient;
	({ t } = await import('../i18n.svelte.js'));
	(await import('../i18n.svelte.js')).setLocale('de');
	target = document.createElement('div');
	document.body.appendChild(target);
});

afterEach(async () => {
	if (component) svelte.unmount(component);
	component = undefined;
	target.remove();
	vi.unstubAllGlobals();
	localStorage.clear();
	(await import('../stores/chat.svelte.js')).newChat();
});

describe('message footer: only segments with a known value', () => {
	it('a stopped turn without usage numbers has no stats line, and the copy button stays', async () => {
		await render({ tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, ttfbMs: 850 });
		expect(statsLine()).toBeNull();
		expect(footerRow().textContent).not.toContain('Σ');
		expect(footerRow().textContent).not.toContain('·');
	});

	it('no tokens but an amount: the amount alone, no Σ segment, no stray separator', async () => {
		await render({ tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0.0042 });
		const line = statsLine();
		expect(line).not.toBeNull();
		expect(visibleText(line as Element)).toBe('$0.0042');
		expect(line?.textContent).not.toContain(t('chat.footer_tokens_tooltip'));
	});

	it('a normal answer renders the line exactly as before', async () => {
		await render({ tokensIn: 42365, tokensOut: 1280, cacheRead: 38000, cacheWrite: 1500, costUsd: 0.043, model: 'mistral-large-2512' });
		const line = statsLine() as Element;
		const n = (43645).toLocaleString();
		// The text content as the line rendered before segments were filtered, whitespace included.
		expect(line.textContent).toBe(` Σ ${n} tokens${t('chat.footer_tokens_tooltip')} ·$0.04·90% cache·mistral-large-2512`);
		expect(visibleText(line)).toBe(`Σ ${n} tokens ·$0.04·90% cache·mistral-large-2512`);
	});
});
