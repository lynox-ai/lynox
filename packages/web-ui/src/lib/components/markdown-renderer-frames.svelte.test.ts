import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { answerFrameReady } from '../utils/artifact-frame-host.js';

// The chat view's artifact frames across re-renders: a frame whose document did not change keeps
// its element (matched by document, not by position), a rebuilt one starts at the last measured
// height, and a slow first render never replaces a newer one.

const CLIENT_ENTRY = join(dirname(createRequire(import.meta.url).resolve('svelte/package.json')), 'src/index-client.js');
type SvelteClient = {
	mount: (c: unknown, o: { target: Element; props?: Record<string, unknown> }) => Record<string, unknown>;
	unmount: (c: Record<string, unknown>) => void;
	flushSync: () => void;
	tick: () => Promise<void>;
};
const { mount, unmount, flushSync, tick } = (await import(/* @vite-ignore */ CLIENT_ENTRY)) as SvelteClient;

/** Code highlighting, held back on demand so a test can decide when the first render resolves. */
const shiki = vi.hoisted(() => ({ hold: null as null | Promise<void> }));
vi.mock('shiki', () => ({
	codeToHtml: async (code: string) => {
		const hold = shiki.hold;
		shiki.hold = null;
		if (hold) await hold;
		return `<pre class="shiki"><code>${code.replace(/</g, '&lt;')}</code></pre>`;
	},
}));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));

const doc = (word: string): string => '```html\n<!DOCTYPE html><html><body><p>' + word + '</p></body></html>\n```';
const A = doc('alpha');
const A2 = doc('alpha-edited');
const B = doc('beta');

let target: HTMLElement;
let component: Record<string, unknown> | undefined;

// Each frame gets one stand-in window for its whole life, as a browser's WindowProxy stays the
// same while the frame navigates. It records what it is sent.
const sentTo = new WeakMap<object, unknown[]>();
const windows = new WeakMap<HTMLIFrameElement, Window>();
function windowOf(f: HTMLIFrameElement): Window {
	let w = windows.get(f);
	if (!w) {
		const sent: unknown[] = [];
		w = { postMessage: (m: unknown) => { sent.push(m); } } as unknown as Window;
		sentTo.set(w, sent);
		windows.set(f, w);
	}
	return w;
}

/** The document the app sends `f` when the endpoint in it says ready. */
function documentOf(f: HTMLIFrameElement): string {
	const key = (f.getAttribute('src') ?? '').split('#')[1] ?? '';
	const w = windowOf(f);
	const before = (sentTo.get(w) ?? []).length;
	answerFrameReady({ data: { type: 'lynox-frame-ready', key }, origin: 'null', source: w });
	const sent = (sentTo.get(w) ?? []).slice(before) as { html: string }[];
	if (sent.length !== 1) throw new Error(`frame got ${sent.length} documents`);
	return sent[0]!.html;
}

function frames(): HTMLIFrameElement[] {
	return Array.from(target.querySelectorAll<HTMLIFrameElement>('.artifact-frame-slot iframe'));
}

async function settle(ms = 0): Promise<void> {
	if (ms > 0) await new Promise((r) => setTimeout(r, ms));
	for (let i = 0; i < 10; i++) {
		await new Promise((r) => setTimeout(r, 0));
		await tick();
		flushSync();
	}
}

/** Past the 400 ms debounce of the frame blocks. */
const DEBOUNCE = 500;

async function render(props: { content: string }): Promise<void> {
	const { default: MarkdownRenderer } = await import('./MarkdownRenderer.svelte');
	component = mount(MarkdownRenderer, { target, props });
	await settle(DEBOUNCE);
}

beforeEach(() => {
	shiki.hold = null;
	vi.spyOn(HTMLIFrameElement.prototype, 'contentWindow', 'get').mockImplementation(function (this: HTMLIFrameElement) {
		return windowOf(this);
	});
	target = document.createElement('div');
	document.body.appendChild(target);
});

afterEach(() => {
	if (component) unmount(component);
	component = undefined;
	target.remove();
	vi.restoreAllMocks();
});

describe('the artifact frames of a message', () => {
	it('keep their element when the message re-renders with the same artifact', async () => {
		const props = $state({ content: A });
		await render(props);
		const [first] = frames();
		expect(first).toBeDefined();
		const src = first!.getAttribute('src');
		props.content = `${A}\n\nA line after it.`;
		await settle(DEBOUNCE);
		expect(target.textContent).toContain('A line after it.');
		expect(frames()).toHaveLength(1);
		expect(frames()[0]).toBe(first);
		expect(first!.getAttribute('src')).toBe(src);
		expect(documentOf(first!)).toContain('<p>alpha</p>');
	});

	it('are matched by their document, not their position, when an artifact before them changes', async () => {
		const props = $state({ content: `${A}\n\n${B}` });
		await render(props);
		const [a, b] = frames();
		expect(documentOf(a!)).toContain('<p>alpha</p>');
		expect(documentOf(b!)).toContain('<p>beta</p>');
		props.content = `${A2}\n\n${B}`;
		// The first render after the change has no slot for the edited artifact yet: the frame of
		// B is the only one, at index 0, and must still be B's own element.
		await settle();
		expect(frames()).toEqual([b]);
		await settle(DEBOUNCE);
		const [a2, b2] = frames();
		expect(b2).toBe(b);
		expect(a2).not.toBe(a);
		expect(documentOf(a2!)).toContain('<p>alpha-edited</p>');
	});

	it('give equal artifacts back their own elements in the order they appear', async () => {
		const props = $state({ content: `${A}\n\n${A}` });
		await render(props);
		const [first, second] = frames();
		expect(first).not.toBe(second);
		first!.style.height = '111px';
		second!.style.height = '222px';
		props.content = `${A}\n\n${A}\n\nA line after them.`;
		await settle(DEBOUNCE);
		expect(frames()).toEqual([first, second]);
	});

	it('start a rebuilt frame at the height and content width the frame before it measured', async () => {
		const props = $state({ content: A });
		await render(props);
		const [before] = frames();
		before!.style.height = '321px';
		before!.dataset['cw'] = '777';
		// A new document in the same place gets a new element (a frame shows one document).
		props.content = A2;
		await settle(DEBOUNCE);
		const [rebuilt] = frames();
		expect(rebuilt).toBeDefined();
		expect(rebuilt).not.toBe(before);
		expect(documentOf(rebuilt!)).toContain('<p>alpha-edited</p>');
		expect(rebuilt!.style.height).toBe('321px');
		expect(rebuilt!.dataset['cw']).toBe('777');
	});

	it('are not replaced by a first render that resolves after the render that built them', async () => {
		let release!: () => void;
		shiki.hold = new Promise<void>((r) => { release = r; });
		const props = $state({ content: `${A}\n\n\`\`\`js\nconst x = 1;\n\`\`\`` });
		await render(props);
		expect(frames()).toHaveLength(1);
		const [built] = frames();
		// The first render was held at the code block; it saw the artifact still uncached and
		// would show its placeholder.
		release();
		await settle();
		expect(target.querySelector('.artifact-placeholder')).toBeNull();
		expect(frames()).toEqual([built]);
		expect(target.textContent).toContain('const x = 1;');
	});
});
