import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { resetSettingsViewer } from '../stores/settings-viewer.svelte.js';

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

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('../stores/chat.svelte.js', () => ({ newChat: vi.fn(), sendMessage: vi.fn() }));
// Markdown is not compiled under vitest here: the entry is printed as its text.
vi.mock('./MarkdownRenderer.svelte', () => ({
	default: (anchor: Comment, props: { content: string }) => {
		const el = document.createElement('div');
		el.textContent = props.content;
		anchor.before(el);
	},
}));

// An engine that started without engine.db refuses a change to memory or to a to-do with a 409 and
// the code `engine_less`; each page says why in its own language. Any other refusal keeps the plain
// line, which the to-do page did not show at all before. The sentences are written out here, not
// read from the table.

const MEMORY_ENGINE_LESS = 'Nicht geändert: Die Engine ist ohne engine.db gestartet, und bis sie neu startet und wieder alle ihre Dateien öffnen kann, lässt sich das Gedächtnis nicht ändern.';
const TASKS_ENGINE_LESS = 'Nicht geändert: Die Engine ist ohne engine.db gestartet, und bis sie neu startet und wieder alle ihre Dateien öffnen kann, lässt sich keine Aufgabe anlegen, ändern oder löschen.';
const FAILED = 'Speichern fehlgeschlagen. Bitte erneut versuchen.';
const FACT = 'Das Lager zog im Oktober nach Thun.';
const TASK = { id: 'a1b2c3d4', title: 'Neue Regale bestellen', status: 'open' };

let target: HTMLElement;
let component: Record<string, unknown> | undefined;

/** The pages' reads, and every change answered with `status` and `body`; the changes are counted. */
function serve(status: number, body: unknown): { changes: string[] } {
	const changes: string[] = [];
	vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
		const path = String(url).split('?')[0]!;
		const json = (b: unknown, s = 200): Response => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
		const method = init?.method ?? 'GET';
		if (method !== 'GET') { changes.push(`${method} ${path}`); return json(body, status); }
		if (path.endsWith('/config')) return json({ viewer: 'owner' });
		if (path.endsWith('/memory/knowledge')) return json({ content: FACT });
		if (path.endsWith('/tasks')) return json({ tasks: [TASK] });
		return json({});
	}));
	vi.stubGlobal('confirm', () => true);
	return { changes };
}

beforeEach(() => {
	resetSettingsViewer();
	target = document.createElement('div');
	document.body.appendChild(target);
});

afterEach(() => {
	if (component) unmount(component);
	component = undefined;
	target.remove();
	vi.unstubAllGlobals();
});

async function settle(): Promise<void> {
	for (let i = 0; i < 10; i++) {
		await new Promise((r) => setTimeout(r, 0));
		await tick();
		flushSync();
	}
}

function button(label: string): HTMLButtonElement {
	const found = [...target.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === label);
	if (found === undefined) throw new Error(`fixture: no button "${label}" in: ${target.textContent ?? ''}`);
	return found;
}

async function memoryPage(): Promise<void> {
	const { default: MemoryView } = await import('./MemoryView.svelte');
	component = mount(MemoryView, { target, props: { hasDurableMemory: false } });
	await settle();
}

async function addToMemory(): Promise<string> {
	await memoryPage();
	const input = target.querySelector<HTMLInputElement>('input');
	if (input === null) throw new Error('fixture: no input');
	input.value = 'Das Büro schliesst freitags.';
	input.dispatchEvent(new Event('input', { bubbles: true }));
	await settle();
	button('Hinzufügen').click();
	await settle();
	return target.textContent ?? '';
}

async function deleteFromMemory(): Promise<string> {
	await memoryPage();
	button('Löschen').click();
	await settle();
	return target.textContent ?? '';
}

async function onTask(label: 'Erledigt' | 'Löschen'): Promise<string> {
	const { default: TasksView } = await import('./TasksView.svelte');
	component = mount(TasksView, { target });
	await settle();
	button(label).click();
	await settle();
	return target.textContent ?? '';
}

const ENGINE_LESS_BODY = { error: 'This engine is running without engine.db.', code: 'engine_less' };

describe('the memory page on an engine without engine.db', () => {
	it('says why an added entry was refused when the engine sends the code', async () => {
		const { changes } = serve(409, ENGINE_LESS_BODY);
		const text = await addToMemory();
		expect(changes).toEqual(['POST /api/memory/knowledge/append']);
		expect(text).toContain(MEMORY_ENGINE_LESS);
		expect(text).not.toContain(FAILED);
	});

	it('says why a deleted entry was refused when the engine sends the code, and the entry stays', async () => {
		const { changes } = serve(409, ENGINE_LESS_BODY);
		const text = await deleteFromMemory();
		expect(changes).toEqual(['DELETE /api/memory/knowledge']);
		expect(text).toContain(MEMORY_ENGINE_LESS);
		expect(text).toContain(FACT);
	});

	it('keeps the plain line for a refusal without the code', async () => {
		serve(409, { error: 'Something else.' });
		const text = await addToMemory();
		expect(text).toContain(FAILED);
		expect(text).not.toContain(MEMORY_ENGINE_LESS);
	});
});

describe('the to-do page on an engine without engine.db', () => {
	for (const [label, path] of [['Erledigt', 'POST /api/tasks/a1b2c3d4/complete'], ['Löschen', 'DELETE /api/tasks/a1b2c3d4']] as const) {
		it(`says why "${label}" was refused when the engine sends the code, and the to-do stays`, async () => {
			const { changes } = serve(409, ENGINE_LESS_BODY);
			const text = await onTask(label);
			expect(changes).toEqual([path]);
			expect(text).toContain(TASKS_ENGINE_LESS);
			expect(text).toContain(TASK.title);
		});

		it(`says that "${label}" failed for a refusal without the code`, async () => {
			serve(403, { error: 'Something else.' });
			const text = await onTask(label);
			expect(text).toContain(FAILED);
			expect(text).not.toContain(TASKS_ENGINE_LESS);
		});
	}
});
