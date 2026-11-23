import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { t } from '../i18n.svelte.js';

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

// A bulk run's trigger is titled with its run id, which the model reads. The schedules list names it
// by its stage and the host its run works on instead; a person never reads the id (U-324).

const RUN_ID = '5f0c8a2e-1b7d-4c3e-9a61-2d4e8f9b7c10';
let target: HTMLElement;
let component: Record<string, unknown> | undefined;
let rows: Record<string, unknown>[] = [];

beforeEach(() => {
	rows = [];
	vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ triggers: rows }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
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

async function render(): Promise<void> {
	const { default: TriggersView } = await import('./TriggersView.svelte');
	component = mount(TriggersView, { target });
	for (let i = 0; i < 10; i++) {
		await new Promise((r) => setTimeout(r, 0));
		await tick();
		flushSync();
	}
}

const BASE = { status: 'open', source: 'manual', confirmed_at: '2026-10-01T00:00:00.000Z' };

describe('the schedules list names a bulk run\'s trigger by stage and host', () => {
	it('shows the stage and host for a bulk trigger, the stage alone without a host, and any other trigger by its title', async () => {
		rows = [
			{ ...BASE, id: `bulk-preview-${RUN_ID}`, title: `Bulk preview ${RUN_ID}`, effect: 'bulk_preview', bulk_host: 'demo-shop.myshopify.com' },
			{ ...BASE, id: `bulk-${RUN_ID}`, title: `Bulk run ${RUN_ID}`, effect: 'bulk_apply', bulk_host: 'api.bexio.com' },
			{ ...BASE, id: 'bulk-u', title: `Bulk undo ${RUN_ID}`, effect: 'bulk_undo', bulk_host: null },
			{ ...BASE, id: 'bulk-j', title: `Bulk judge ${RUN_ID}`, effect: 'bulk_judge' },
			{ ...BASE, id: 'w', title: 'Wochenreport', effect: 'run_agent', source: 'cron' },
		];
		await render();
		const shown = [...target.querySelectorAll('[data-trigger-title]')].map((e) => e.textContent?.trim());
		expect(shown).toEqual([
			`${t('triggers.bulk.preview')} · demo-shop.myshopify.com`,
			`${t('triggers.bulk.apply')} · api.bexio.com`,
			t('triggers.bulk.undo'),
			t('triggers.bulk.judge'),
			'Wochenreport',
		]);
		// The id stays where the model reads it, never where a person does.
		expect(target.textContent ?? '').not.toContain(RUN_ID);
	});

	it('boxes the host as code beside the stage, the stage staying text, and boxes nothing else', async () => {
		rows = [
			{ ...BASE, id: `bulk-${RUN_ID}`, title: `Bulk run ${RUN_ID}`, effect: 'bulk_apply', bulk_host: 'api.bexio.com' },
			{ ...BASE, id: 'bulk-u', title: `Bulk undo ${RUN_ID}`, effect: 'bulk_undo', bulk_host: '' },
			{ ...BASE, id: 'w', title: 'api.bexio.com', effect: 'run_agent', source: 'cron', bulk_host: 'api.bexio.com' },
		];
		await render();
		const titles = [...target.querySelectorAll('[data-trigger-title]')];
		expect(titles.map((e) => [...e.querySelectorAll('code[data-testid="trigger-bulk-host"]')].map((c) => c.textContent))).toEqual([['api.bexio.com'], [], []]);
		expect([...titles[0]!.childNodes].filter((n) => !(n instanceof Element)).map((n) => n.textContent).join('')).toBe(`${t('triggers.bulk.apply')} · `);
	});

	it('words the stages as they are worded, in both languages', async () => {
		const { readFileSync } = await import('node:fs');
		const src = readFileSync(join(dirname(new URL(import.meta.url).pathname), '../i18n.svelte.ts'), 'utf8');
		for (const line of [
			"'triggers.bulk.preview': { de: 'Vorschau', en: 'Preview' },",
			"'triggers.bulk.judge': { de: 'Beurteilung', en: 'Judging' },",
			"'triggers.bulk.apply': { de: 'Massenlauf', en: 'Bulk run' },",
			"'triggers.bulk.undo': { de: 'Rücknahme', en: 'Undo' },",
		]) expect(src).toContain(line);
	});
});
