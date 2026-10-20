import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

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

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));

// The schedules view says in words that a run was stopped, and it keeps `running`/`stoppable`
// current while the tab is visible: a scheduled run starts on its own, and its Stop button has to
// appear without the owner reloading the page.

const REFRESH_MS = 15_000;
let target: HTMLElement;
let component: Record<string, unknown> | undefined;
let visibility: DocumentVisibilityState = 'visible';
/** Every `GET /triggers` the view made, in order. */
let loads = 0;
/** What the next `GET /triggers` answers. */
let rows: Record<string, unknown>[] = [];

const ROW = { id: 't1', title: 'Wochenreport', status: 'open', effect: 'run_agent', source: 'cron', confirmed_at: '2026-10-01T00:00:00.000Z' };

beforeEach(() => {
	visibility = 'visible';
	loads = 0;
	rows = [];
	Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
	vi.stubGlobal('fetch', vi.fn(async (url: string) => {
		if (String(url).endsWith('/triggers')) loads++;
		return new Response(JSON.stringify({ triggers: rows }), { status: 200, headers: { 'Content-Type': 'application/json' } });
	}));
	// Only the interval is faked: the settle loop below runs on real timeouts.
	vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
	target = document.createElement('div');
	document.body.appendChild(target);
});

afterEach(() => {
	if (component) unmount(component);
	component = undefined;
	target.remove();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

async function settle(): Promise<void> {
	for (let i = 0; i < 10; i++) {
		await new Promise((r) => setTimeout(r, 0));
		await tick();
		flushSync();
	}
}

async function render(): Promise<void> {
	const { default: TriggersView } = await import('./TriggersView.svelte');
	component = mount(TriggersView, { target });
	await settle();
}

async function wait(ms: number): Promise<void> {
	vi.advanceTimersByTime(ms);
	await settle();
}

describe('a stopped run is named, not only coloured', () => {
	it('`stopped` and `halted` share a colour and differ by their word', async () => {
		rows = [
			{ ...ROW, id: 's', title: 'Gestoppt', last_run_at: '2026-10-19T08:00:00.000Z', last_run_status: 'stopped' },
			{ ...ROW, id: 'h', title: 'Gehalten', last_run_at: '2026-10-19T08:00:00.000Z', last_run_status: 'halted' },
		];
		await render();
		const stopped = target.querySelector('[data-run-status="stopped"]')?.textContent ?? '';
		const halted = target.querySelector('[data-run-status="halted"]')?.textContent ?? '';
		expect(stopped).toContain('gestoppt, bevor er fertig war');
		expect(halted).toContain('wie vorgesehen angehalten');
		expect(stopped).not.toContain('angehalten');
	});

	it('the Stop button says „Lauf stoppen“, not the word of the planned halt', async () => {
		rows = [{ ...ROW, running: true, stoppable: true }];
		await render();
		const button = target.querySelector('[data-trigger-stop]');
		expect(button?.textContent).toContain('Lauf stoppen');
		expect(button?.textContent).not.toContain('anhalten');
	});
});

describe('the view refreshes while the tab is visible', () => {
	it('a run that starts on its own gets its Stop button within one interval', async () => {
		rows = [{ ...ROW }];
		await render();
		expect(loads).toBe(1);
		expect(target.querySelector('[data-trigger-stop]')).toBeNull();
		rows = [{ ...ROW, running: true, stoppable: true }];
		await wait(REFRESH_MS);
		expect(loads).toBe(2);
		expect(target.querySelector('[data-trigger-stop]')).not.toBeNull();
	});

	it('a hidden tab loads nothing', async () => {
		rows = [{ ...ROW }];
		await render();
		visibility = 'hidden';
		await wait(REFRESH_MS * 3);
		expect(loads).toBe(1);
		// …and the same interval does load once the tab is visible again (the counter-witness).
		visibility = 'visible';
		await wait(REFRESH_MS);
		expect(loads).toBe(2);
	});

	it('a refresh keeps the list on screen while it loads', async () => {
		// A refresh that swapped the list for the loading line every 15 s would drop keyboard
		// focus from whatever row the owner is on.
		rows = [{ ...ROW, running: true, stoppable: true }];
		await render();
		let release!: () => void;
		vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => {
			loads++;
			release = () => resolve(new Response(JSON.stringify({ triggers: rows }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
		})));
		await wait(REFRESH_MS);
		expect(loads).toBe(2);   // witness: the refresh is in flight
		expect(target.querySelector('[data-trigger-stop]')).not.toBeNull();
		release();
		await settle();
	});

	it('the interval ends when the view is left', async () => {
		rows = [{ ...ROW }];
		await render();
		unmount(component!);
		component = undefined;
		await wait(REFRESH_MS * 3);
		expect(loads).toBe(1);
	});
});
