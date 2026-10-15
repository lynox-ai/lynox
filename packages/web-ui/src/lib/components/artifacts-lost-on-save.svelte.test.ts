import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { readable } from 'svelte/store';

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

// The gallery reads `$page` for its deep link and calls `goto` to strip it; neither matters here.
vi.mock('$app/stores', () => ({ page: readable({ url: new URL('http://localhost/app/artifacts') }) }));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
// The real renderer does not parse in this project's transform (a `<!--` inside a regex literal);
// what is rendered here is the content as text, which is all these tests read.
vi.mock('./MarkdownRenderer.svelte', () => ({
	default: (anchor: Comment, props: { content: string }) => {
		const el = document.createElement('div');
		el.textContent = props.content;
		anchor.before(el);
	},
}));

// The engine's placeholder as a damaged file holds it (measured on a real instance: 176 bytes).
const PLACEHOLDER = '[evicted after successful save — 5251 chars. The artifact is persisted; its id and file path are in the tool result below. read_file that path if you need the content again.]';

const META = {
	title: 'Pitch',
	description: 'A pitch',
	type: 'markdown',
	createdAt: '2026-10-09T19:34:00.000Z',
	updatedAt: '2026-10-09T19:34:00.000Z',
	threadId: 't',
	version: 1,
};
const LOST = { ...META, id: 'aaaaaaaa', lostOnSave: true };
const FINE = { ...META, id: 'bbbbbbbb', title: 'Fine' };

let target: HTMLElement;
let component: Record<string, unknown> | undefined;

beforeEach(() => {
	target = document.createElement('div');
	document.body.appendChild(target);
	vi.stubGlobal('fetch', vi.fn(async (url: string) => {
		const u = String(url);
		const body = u.endsWith('/artifacts')
			? { artifacts: [LOST, FINE] }
			: u.endsWith('/aaaaaaaa')
				? { ...LOST, content: PLACEHOLDER }
				: { ...FINE, content: '# Fine document' };
		return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
	}));
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

async function render(): Promise<void> {
	const { default: ArtifactsView } = await import('./ArtifactsView.svelte');
	component = mount(ArtifactsView, { target });
	await settle();
}

function card(title: string): HTMLElement {
	const h = [...target.querySelectorAll('h3')].find((el) => el.textContent === title);
	if (!h) throw new Error(`no card titled ${title}`);
	return h.closest('[role="button"]') as HTMLElement;
}

function toolbarButtons(): string[] {
	const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
	return [...(dialog?.querySelectorAll('button') ?? [])].map((b) => (b.textContent ?? '').trim());
}

describe('an artifact whose file holds the save placeholder', () => {
	it('is marked in the gallery, and only that one', async () => {
		await render();
		expect(card('Pitch').querySelector('[data-testid="artifact-lost-badge"]')).not.toBeNull();
		expect(card('Fine').querySelector('[data-testid="artifact-lost-badge"]')).toBeNull();
	});

	it('opens to a notice, not to the engine text', async () => {
		await render();
		card('Pitch').click();
		await settle();
		const notice = document.querySelector('[data-testid="artifact-lost-notice"]');
		expect(notice).not.toBeNull();
		expect(document.body.textContent).not.toContain('evicted after successful save');
		// Nothing to share or print: both would hand out the placeholder as the document.
		expect(toolbarButtons()).not.toContain('Teilen');
		expect(toolbarButtons()).not.toContain('Drucken');
	});

	it('control: a fine artifact opens to its content, without the notice', async () => {
		await render();
		card('Fine').click();
		await settle();
		expect(document.querySelector('[data-testid="artifact-lost-notice"]')).toBeNull();
		expect(document.body.textContent).toContain('Fine document');
		expect(toolbarButtons()).toContain('Teilen');
		expect(toolbarButtons()).toContain('Drucken');
	});
});
