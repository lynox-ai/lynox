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

// Whom the library's Run runs a workflow as (1055, ux U-063): the badge names the person a mandate's
// workflow runs as, and a run refused because that person's access ended names them and the way out.

let target: HTMLElement;
let component: Record<string, unknown> | undefined;

const WF = {
	id: 'wf-1', name: 'Monthly report', description: '', step_count: 1, steps: [{ id: 'post', task: 'Send it' }],
	parameters: [], created_at: '2026-10-29', mode: 'autonomous', schedulable: true, confirmedAt: '2026-10-29T00:00:00Z',
};

function serve(run: { status: number; body: unknown }, wf: Record<string, unknown>): void {
	vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
		const path = new URL(String(input), 'http://localhost').pathname.replace(/^\/api/, '');
		const method = init?.method ?? 'GET';
		if (method === 'GET' && path === '/workflows/library') return new Response(JSON.stringify({ workflows: [wf], viewer: 'owner' }), { status: 200 });
		if (method === 'POST' && path === `/workflows/${String(wf['id'])}/run`) return new Response(JSON.stringify(run.body), { status: run.status });
		return new Response('{}', { status: 404 });
	}));
}

async function settle(): Promise<void> {
	for (let i = 0; i < 10; i++) {
		await new Promise((r) => setTimeout(r, 0));
		await tick();
		flushSync();
	}
}

async function open(wf: Record<string, unknown>, run: { status: number; body: unknown } = { status: 200, body: {} }): Promise<void> {
	serve(run, wf);
	const { default: WorkflowLibraryView } = await import('./WorkflowLibraryView.svelte');
	component = mount(WorkflowLibraryView, { target });
	await settle();
}

const badge = (): HTMLElement | null => target.querySelector<HTMLElement>('[data-testid="runs-as-badge"]');
async function pressRun(): Promise<void> {
	const run = [...target.querySelectorAll<HTMLElement>('button')].find((b) => b.textContent?.trim() === 'Ausführen');
	expect(run, 'the Run button').toBeDefined();
	run!.click();
	await settle();
}

beforeEach(() => {
	target = document.createElement('div');
	document.body.appendChild(target);
});

afterEach(() => {
	if (component) unmount(component);
	component = undefined;
	target.remove();
	vi.unstubAllGlobals();
});

describe('the library names whom Run runs a workflow as', () => {
	it('marks a workflow a person the owner let in shaped with that person', async () => {
		await open({ ...WF, runs_as: { person: 'eva@kanzlei.example', ended: false } });
		expect(badge()?.textContent?.trim()).toBe('Läuft als eva@kanzlei.example');
	});

	it('marks none of the owner\'s own workflows (control)', async () => {
		await open(WF);
		expect(badge()).toBeNull();
	});
});

describe('a run refused because that person\'s access ended', () => {
	it('names the person and the way out, a new workflow from the chat', async () => {
		await open({ ...WF, runs_as: { person: 'eva@kanzlei.example', ended: true } }, { status: 403, body: { error: 'engine sentence', code: 'author_ended', runs_as: 'eva@kanzlei.example' } });
		await pressRun();
		const text = target.textContent ?? '';
		expect(text).toContain('eva@kanzlei.example hat diesen Workflow angelegt oder zuletzt geändert, und ihr Zugang ist beendet.');
		// Not a copy: a copy keeps the mark of the steps it holds and is refused again (`upsertCopy`).
		expect(text).toContain('auch nicht als Kopie');
		expect(text).toContain('bitte lynox, dafür einen neuen Workflow zu schreiben, statt diesen zu kopieren oder zu ändern.');
		expect(text).not.toContain('engine sentence');
	});

	it('without a name says "a person with access"', async () => {
		await open(WF, { status: 403, body: { error: 'engine sentence', code: 'author_ended', runs_as: null } });
		await pressRun();
		expect(target.textContent ?? '').toContain('Eine Person mit Zugang hat diesen Workflow angelegt');
	});

	it('CONTROL: another refusal still shows the engine\'s sentence', async () => {
		await open(WF, { status: 403, body: { error: 'engine sentence' } });
		await pressRun();
		expect(target.textContent ?? '').toContain('engine sentence');
	});
});
