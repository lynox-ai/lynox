import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { t, setLocale, getLocale } from '../i18n.svelte.js';

// The run history's title and its times. The engine stamps a run with SQLite's `datetime('now')`:
// UTC, without a zone. The page shows it in the viewer's time; read as local time, it stood an
// hour early in Zurich.

// The run's answer is rendered as Markdown; this test reads no answer.
vi.mock('./MarkdownRenderer.svelte', () => ({ default: () => {} }));

// `svelte` resolves to its server entry under node, where `mount` throws. The component is compiled
// for the client, so it is mounted with the client entry, loaded by path.
const CLIENT_ENTRY = join(dirname(createRequire(import.meta.url).resolve('svelte/package.json')), 'src/index-client.js');
type SvelteClient = {
	mount: (c: unknown, o: { target: Element; props?: Record<string, unknown> }) => Record<string, unknown>;
	unmount: (c: Record<string, unknown>) => void;
	flushSync: () => void;
	tick: () => Promise<void>;
};
const { mount, unmount, flushSync, tick } = (await import(/* @vite-ignore */ CLIENT_ENTRY)) as SvelteClient;
const HistoryView = (await import('./HistoryView.svelte')).default;

function run(createdAt: string): Record<string, unknown> {
	return {
		id: 'run-1', session_id: 'th-1', task_text: 'Bericht', response_text: '', status: 'completed', cost_usd: 0.01,
		duration_ms: 1000, model_id: 'm', tokens_in: 1, tokens_out: 1, tokens_cache_read: 0, tokens_cache_write: 0,
		user_wait_ms: 0, created_at: createdAt,
	};
}

let target: HTMLDivElement;
let component: Record<string, unknown> | undefined;
let createdAt = '';
const tz = process.env['TZ'];
const locale = getLocale();

beforeEach(() => {
	process.env['TZ'] = 'Europe/Zurich';
	setLocale('de');
	target = document.createElement('div');
	document.body.appendChild(target);
	vi.stubGlobal('fetch', vi.fn(async (url: string) => {
		const u = String(url);
		const body = u.includes('/history/runs?') ? { runs: [run(createdAt)] }
			: u.includes('/history/stats') ? { total_runs: 1, total_cost_usd: 0.01, total_tokens_in: 1, total_tokens_out: 1, avg_duration_ms: 1000 }
			: u.includes('/threads?') ? { threads: [{ id: 'th-1', title: 'Wochenbericht', is_archived: 0, updated_at: createdAt }] }
			: {};
		return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
	}));
});

afterEach(() => {
	if (component) unmount(component);
	component = undefined;
	target.remove();
	vi.unstubAllGlobals();
	if (tz === undefined) delete process.env['TZ']; else process.env['TZ'] = tz;
	setLocale(locale);
});

async function render(): Promise<void> {
	component = mount(HistoryView, { target });
	for (let i = 0; i < 10; i++) { await new Promise((r) => setTimeout(r, 0)); await tick(); flushSync(); }
}

describe('the run history', () => {
	it('is titled the history of the runs, in either language', () => {
		expect(t('history.title')).toBe('Verlauf der Läufe');
		setLocale('en');
		expect(t('history.title')).toBe('Run history');
	});

	// The engine's own form, and one with a zone, which is read as it says.
	for (const at of ['2026-11-12 07:53:09', '2026-11-12T07:53:09.000Z']) {
		it(`shows a run's time as the viewer's time (${at})`, async () => {
			createdAt = at;
			await render();
			expect(target.textContent).toContain('Wochenbericht');
			expect(target.textContent).toContain('08:53');
			expect(target.textContent).not.toContain('07:53');
		});
	}
});
