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

// The run and schedule forms show what a parameter may take (U-362): a refusal no longer lists a
// contract's allowed values, so the owner sees them here, as text, and nobody else does.

let target: HTMLElement;
let component: Record<string, unknown> | undefined;

const SCRIPT = '<script>window.__x = 1</script>';
const WF = {
	id: 'wf-1', name: 'Monthly report', description: '', step_count: 1, steps: [{ id: 'post', task: 'Send it' }],
	parameters: [
		{ name: 'region', description: '', type: 'string' },
		{ name: 'count', description: '', type: 'number' },
	],
	created_at: '2026-10-29', mode: 'autonomous', schedulable: true, confirmedAt: '2026-10-29T00:00:00Z',
	capabilityContract: {
		grantedTools: ['http_request'], httpMethods: ['POST'], hostPatterns: ['api.example.com'], pathPatterns: ['/v1/*'],
		paramConstraints: { region: { enum: ['ch', 'de', SCRIPT] }, count: { min: 1, max: 10 } },
	},
};

async function settle(): Promise<void> {
	for (let i = 0; i < 10; i++) {
		await new Promise((r) => setTimeout(r, 0));
		await tick();
		flushSync();
	}
}

async function open(viewer: 'owner' | 'mandate'): Promise<void> {
	vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
		const path = new URL(String(input), 'http://localhost').pathname.replace(/^\/api/, '');
		if ((init?.method ?? 'GET') === 'GET' && path === '/workflows/library') return new Response(JSON.stringify({ workflows: [WF], viewer }), { status: 200 });
		return new Response('{}', { status: 404 });
	}));
	const { default: WorkflowLibraryView } = await import('./WorkflowLibraryView.svelte');
	component = mount(WorkflowLibraryView, { target });
	await settle();
}

async function press(label: string): Promise<void> {
	const button = [...target.querySelectorAll<HTMLElement>('button')].find((b) => b.textContent?.trim() === label);
	expect(button, `the ${label} button`).toBeDefined();
	button!.click();
	await settle();
}

const choice = (name: string): HTMLSelectElement | null => target.querySelector<HTMLSelectElement>(`[data-param-choice="${name}"]`);
const bounds = (name: string): HTMLElement | null => target.querySelector<HTMLElement>(`[data-param-bounds="${name}"]`);

beforeEach(() => {
	target = document.createElement('div');
	document.body.appendChild(target);
	delete (window as { __x?: number }).__x;
});

afterEach(() => {
	if (component) unmount(component);
	component = undefined;
	target.remove();
	vi.unstubAllGlobals();
});

describe('the run form shows the owner what a parameter may take', () => {
	it('offers the allowed values as a choice and the bounds as a hint, values as text, never as markup', async () => {
		await open('owner');
		await press('Ausführen');
		const select = choice('region');
		expect(select, 'a choice for region').not.toBeNull();
		expect([...select!.options].map((o) => o.textContent)).toEqual(['Wert wählen', 'ch', 'de', SCRIPT]);
		expect(target.querySelector('script')).toBeNull();
		expect((window as { __x?: number }).__x).toBeUndefined();
		expect(bounds('count')?.textContent?.trim()).toBe('Zwischen 1 und 10');
		expect(choice('count')).toBeNull();
	});

	it('shows the same in the schedule form', async () => {
		await open('owner');
		await press('Planen');
		expect([...choice('region')!.options].map((o) => o.value)).toEqual(['', 'ch', 'de', SCRIPT]);
		expect(bounds('count')?.textContent?.trim()).toBe('Zwischen 1 und 10');
	});

	it('shows a mandate neither the values nor the bounds, though the answer holds them', async () => {
		await open('mandate');
		await press('Planen');
		expect(target.querySelector('[data-param-choice]')).toBeNull();
		expect(target.querySelector('[data-param-bounds]')).toBeNull();
		expect(target.textContent).not.toContain('Zwischen 1 und 10');
		// The form is there, with free text for both.
		expect(target.querySelectorAll('input[type="text"]').length).toBeGreaterThanOrEqual(2);
	});
});
