import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// The status bar's cost is today's, and it says so: next to a note about the monthly cap, a bare
// amount reads as the month's. Mounted for real, on the phone bar and the desktop bar.

// `svelte` resolves to its server entry under node, where `mount` throws. The component is compiled
// for the client, so it is mounted with the client entry, loaded by path.
const CLIENT_ENTRY = join(dirname(createRequire(import.meta.url).resolve('svelte/package.json')), 'src/index-client.js');
type SvelteClient = {
	mount: (c: unknown, o: { target: Element }) => Record<string, unknown>;
	unmount: (c: Record<string, unknown>) => void;
	flushSync: () => void;
	tick: () => Promise<void>;
};
const { mount, unmount, flushSync, tick } = (await import(/* @vite-ignore */ CLIENT_ENTRY)) as SvelteClient;
vi.mock('svelte', async () => {
	const { createRequire: req } = await import('node:module');
	const path = await import('node:path');
	return import(/* @vite-ignore */ path.join(path.dirname(req(import.meta.url).resolve('svelte/package.json')), 'src/index-client.js'));
});

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

async function settle(): Promise<void> {
	for (let i = 0; i < 20; i++) {
		await new Promise((r) => setTimeout(r, 0));
		await tick();
		flushSync();
	}
}

const today = (): string => {
	const d = new Date();
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** What the cost endpoint answers: today's rows, an error status, or nothing yet (held). */
let costAnswer: 'held' | 'not-json' | number | readonly unknown[] | Readonly<Record<string, unknown>>;
/** A proxy page on every route: the providers' body is not JSON, which throws before the cost is read. */
let providersBroken = false;
let target: HTMLElement;
let component: Record<string, unknown> | undefined;

async function mountIn(locale: 'de' | 'en'): Promise<void> {
	const i18n = await import('../i18n.svelte.js');
	i18n.setLocale(locale);
	target = document.createElement('div');
	document.body.appendChild(target);
	const { default: StatusBar } = await import('./StatusBar.svelte');
	component = mount(StatusBar, { target });
	await settle();
}

/** The phone bar's button (it opens the status panel) and the desktop bar's link to the activity page. */
function shown(): { phone: string; phoneName: string; desktop: HTMLAnchorElement; phoneButton: HTMLButtonElement } {
	const desktop = target.querySelector<HTMLAnchorElement>('a[href="/app/activity"]');
	const phoneButton = target.querySelector<HTMLButtonElement>('div.md\\:hidden button, button[aria-label*="$"], button[aria-label*="Kosten heute unbekannt"]');
	if (!desktop || !phoneButton) throw new Error('status bar parts not found');
	const amount = phoneButton.querySelector('span.shrink-0.whitespace-nowrap');
	return { phone: (amount?.textContent ?? '').replace(/\s+/g, ' ').trim(), phoneName: phoneButton.getAttribute('aria-label') ?? '', desktop, phoneButton };
}

beforeEach(() => {
	vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} });
	vi.stubGlobal('navigator', { onLine: true });
	costAnswer = [{ day: today(), cost_usd: 0.4, run_count: 1, user_turns: 1 }];
	providersBroken = false;
	vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
		const url = String(input);
		if (url.includes('/history/cost/daily')) {
			if (costAnswer === 'held') return new Promise<Response>(() => {});
			if (costAnswer === 'not-json') return new Response('<html>proxy error</html>', { status: 200 });
			return typeof costAnswer === 'number' ? json({ error: 'x' }, costAnswer) : json(costAnswer);
		}
		if (url.endsWith('/runs/active')) return json({ runs: [] });
		if (url.endsWith('/health')) return json({ status: 'ok', version: '0.0.0', build_sha: null });
		if (url.endsWith('/providers/status')) return providersBroken ? new Response('<html>maintenance</html>', { status: 200 }) : json({ providers: [] });
		return json({}, 404);
	}));
});

afterEach(() => {
	if (component) unmount(component);
	component = undefined;
	target.remove();
	vi.unstubAllGlobals();
});

describe('the status bar names the period of its cost', () => {
	it.each([['de', 'heute $0.40'], ['en', 'today $0.40']] as const)('%s: "%s" on the phone bar and the desktop bar', async (locale, text) => {
		await mountIn(locale);
		const { phone, phoneName, desktop } = shown();
		expect(phone).toBe(text);
		expect(desktop.textContent?.replace(/\s+/g, ' ').trim()).toBe(text);
		// The link's name is its visible text (no aria-label that says it otherwise); the phone
		// button's spoken summary carries the same words.
		expect(desktop.hasAttribute('aria-label')).toBe(false);
		expect(phoneName).toContain(text);
	});

	it.each([
		['a day without a row', [] as const],
		['a row of zero', 'zero'],
	] as const)('shows a real zero as "heute $0.00" (%s)', async (_what, rows) => {
		costAnswer = rows === 'zero' ? [{ day: today(), cost_usd: 0, run_count: 0, user_turns: 0 }] : [];
		await mountIn('de');
		const { phone, desktop } = shown();
		expect(phone).toBe('heute $0.00');
		expect(desktop.textContent?.replace(/\s+/g, ' ').trim()).toBe('heute $0.00');
		// A real zero is known: no label, never "unknown"; the name is the visible text.
		expect(desktop.hasAttribute('aria-label')).toBe(false);
		expect(shown().phoneName).not.toContain('unbekannt');
	});

	it.each([
		['not answered yet', 'held'],
		['answered with an error', 500],
		['answered with no JSON', 'not-json'],
		['answered with something other than a list', { error: 'x' }],
		['a figure that is text', [{ day: today(), cost_usd: '0.40', run_count: 1, user_turns: 1 }]],
		['a figure below zero', [{ day: today(), cost_usd: -5, run_count: 1, user_turns: 1 }]],
		['a figure the answer leaves empty (null)', [{ day: today(), cost_usd: null, run_count: 1, user_turns: 1 }]],
	] as const)('shows no figure while the cost is unknown, and says so to a screen reader (%s)', async (_what, answer) => {
		costAnswer = answer;
		await mountIn('de');
		const { phone, phoneName, desktop } = shown();
		expect(phone).toBe('-');
		expect(desktop.textContent?.replace(/\s+/g, ' ').trim()).toBe('-');
		// A bare "-" is not spoken: both say that today's cost is unknown, and show no amount.
		expect(desktop.getAttribute('aria-label')).toBe('Kosten heute unbekannt');
		expect(phoneName.endsWith('· Kosten heute unbekannt')).toBe(true);
		expect(phoneName).not.toContain('$0');
	});

	it('drops a figure it knew once another part of the same read throws', async () => {
		await mountIn('de');
		expect(shown().phone).toBe('heute $0.40');
		providersBroken = true;
		window.dispatchEvent(new Event('lynox:run-ended'));
		await new Promise((r) => setTimeout(r, 450));
		await settle();
		expect(shown().phone).toBe('-');
	});

	it.each([
		['a real zero', [] as const, '$0.00'],
		['an unknown cost', 'held', '-'],
	] as const)('the status panel shows %s as "%s"', async (_what, answer, tile) => {
		costAnswer = answer;
		await mountIn('de');
		shown().phoneButton.click();
		await settle();
		const costTile = [...target.querySelectorAll<HTMLAnchorElement>('a[href="/app/activity"]')].find((a) => a.querySelector('p.text-lg'));
		expect(costTile, 'the panel opened').toBeDefined();
		expect(costTile?.querySelector('p.text-lg')?.textContent?.trim()).toBe(tile);
	});

	it.each([
		['an error', 500],
		['no JSON', 'not-json'],
		['something other than a list', { error: 'x' }],
		['a figure below zero', [{ day: today(), cost_usd: -5, run_count: 1, user_turns: 1 }]],
	] as const)('drops a figure it knew once a later read answers with %s', async (_what, answer) => {
		await mountIn('de');
		expect(shown().phone).toBe('heute $0.40');
		costAnswer = answer;
		// A run's end reads the cost again (after a short delay that coalesces several ends).
		window.dispatchEvent(new Event('lynox:run-ended'));
		await new Promise((r) => setTimeout(r, 450));
		await settle();
		expect(shown().phone).toBe('-');
	});
});
