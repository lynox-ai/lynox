import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { answerFrameReady } from '../utils/artifact-frame-host.js';
import { setThemeMode } from '../stores/theme.svelte.js';
import { buildArtifactBubbleFrame } from '../utils/artifact-frame.js';
import { artifactFenceHeader } from '../utils/artifact-inline.js';
import { t } from '../i18n.svelte.js';

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
const shared = vi.hoisted(() => [] as { blob: Blob; name: string }[]);
vi.mock('../utils/save-blob.js', () => ({ saveOrShareBlob: vi.fn(async (blob: Blob, name: string) => { shared.push({ blob, name }); }) }));

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
	// The store is one module for the whole file; put the theme back to its start value.
	setThemeMode('dark');
	localStorage.removeItem('lyx-theme');
});

describe('the download of an svg artifact from the chat', () => {
	it('is the html frame document with the artifact policy, not the raw svg', async () => {
		shared.length = 0;
		// Spelled in two parts: a module parser reads the comment opener as an HTML-like comment.
		const open = '<!' + '--';
		const svg = '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://elsewhere.example/x.png" width="9" height="9"/></svg>';
		await render({ content: '```artifact\n' + open + ' type: svg -->\n' + open + ' title: Logo -->\n' + svg + '\n```' });
		const share = target.querySelector<HTMLElement>('.artifact-container[data-artifact-type="svg"] [data-action="share"]');
		expect(share, 'no share button on the svg artifact').not.toBeNull();
		share!.click();
		await settle();
		expect(shared).toHaveLength(1);
		expect(shared[0]!.name).toBe('logo.html');
		const file = await shared[0]!.blob.text();
		expect(file).toContain('elsewhere.example');
		expect(file).toMatch(/<meta http-equiv="Content-Security-Policy" content="[^"]*img-src data: blob:/);
	});
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

	it('are rebuilt with the new palette when the theme flips on a message with an HTML artifact and no diagram', async () => {
		// A fragment, not a full document: a document with its own <html> brings its own styling
		// and gets no palette, so a flip would leave it byte-equal.
		const props = $state({ content: '```artifact\n<p id="m">gamma</p>\n```' });
		await render(props);
		const [dark] = frames();
		expect(dark).toBeDefined();
		// Each theme's default body style, as the frame module builds it.
		const palette = (theme: 'light' | 'dark'): string =>
			/<style>body\{[^}]*\}/.exec(buildArtifactBubbleFrame('<p></p>', theme, ''))?.[0] ?? '';
		expect(palette('dark')).not.toBe('');
		expect(palette('light')).not.toBe(palette('dark'));
		const darkDoc = documentOf(dark!);
		expect(darkDoc).toContain('<p id="m">gamma</p>');
		expect(darkDoc).toContain(palette('dark'));
		setThemeMode('light');
		await settle(DEBOUNCE);
		const [light] = frames();
		expect(frames()).toHaveLength(1);
		expect(light).not.toBe(dark);
		const lightDoc = documentOf(light!);
		expect(lightDoc).toContain('<p id="m">gamma</p>');
		expect(lightDoc).toContain(palette('light'));
		expect(lightDoc).not.toContain(palette('dark'));
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

describe('an artifact card the chat marks as lost', () => {
	const PLACEHOLDER = '[evicted after successful save]';
	const body = '<p>' + PLACEHOLDER + '</p>';
	// The fence as the chat writes it for a save: the two cards differ only in the store's flag.
	const card = (lost: boolean, title = 'Report', type = 'html', content = body): string =>
		'```artifact\n' + artifactFenceHeader({ title, type, id: '', typed: true, lost }) + content + '\n```';
	const intact = card(false, 'Preisliste', 'html', '<p>Schneeräumung ab CHF 80</p>');
	const BADGE = /^(Content missing|Inhalt fehlt)$/;
	const notices = (): Element[] => Array.from(target.querySelectorAll('[data-testid="artifact-inline-lost-notice"]'));
	const badges = (): Element[] => Array.from(target.querySelectorAll('[data-testid="artifact-inline-lost-badge"]'));

	it('shows the gallery\'s notice for a lost document in place of the placeholder, and builds no frame', async () => {
		await render({ content: card(true) });
		expect(badges(), 'positive control: the card carries the badge').toHaveLength(1);
		expect(notices(), 'one notice').toHaveLength(1);
		const container = target.querySelector('.artifact-container')!;
		expect(container.querySelector('.artifact-frame-slot'), 'no slot').toBeNull();
		expect(frames(), 'no frame').toHaveLength(0);
		expect(container.textContent, 'the placeholder is not shown').not.toContain(PLACEHOLDER);
	});

	it('holds only the fixed notice text, nothing from the fence, not its title or type', async () => {
		const title = 'Q3 <b>bold</b> " onmouseover="x';
		await render({ content: card(true, title) });
		expect(badges(), 'one badge').toHaveLength(1);
		const badge = badges()[0]!;
		expect(badge.textContent, 'its text is the fixed label').toMatch(BADGE);
		expect(badge.getAttribute('title'), 'and so is its title').toMatch(BADGE);
		expect(badge.children, 'no markup inside it').toHaveLength(0);
		expect(Array.from(badge.attributes).map((a) => a.name).sort(), 'no attribute but its own').toEqual(['class', 'data-testid', 'title']);
		const notice = notices()[0]!;
		const parts = Array.from(notice.children);
		expect(parts.map((p) => p.tagName), 'two paragraphs, nothing else').toEqual(['P', 'P']);
		expect(parts.map((p) => p.textContent), 'the gallery\'s two sentences').toEqual([t('artifacts.lost_title'), t('artifacts.lost_body')]);
		expect(parts.every((p) => p.children.length === 0), 'as text').toBe(true);
		expect(notice.textContent, 'nothing of the title').not.toContain('bold');
		expect(notice.textContent, 'nothing of the type').not.toMatch(/html/i);
		expect(Array.from(notice.attributes).map((a) => a.name).sort(), 'no attribute but its own').toEqual(['class', 'data-testid', 'role']);
	});

	it('shows the notice in place of the body of a lost markdown or data card too', async () => {
		await render({ content: card(true, 'Notiz', 'markdown', PLACEHOLDER) + '\n\n' + card(true, 'Liste', 'csv', PLACEHOLDER) });
		expect(Array.from(target.querySelectorAll('.artifact-container')).map((c) => c.getAttribute('data-artifact-type')), 'positive control: a markdown and a data card').toEqual(['markdown', 'csv']);
		expect(notices(), 'a notice on each').toHaveLength(2);
		expect(target.querySelector('.artifact-md-body'), 'no markdown body').toBeNull();
		expect(target.querySelector('.artifact-data-body'), 'no data preview').toBeNull();
		expect(target.textContent, 'the placeholder is not shown').not.toContain(PLACEHOLDER);
	});

	for (const [order, content] of [['before', () => card(true) + '\n\n' + intact], ['after', () => intact + '\n\n' + card(true)]] as const) {
		it(`leaves the intact card in the same message its frame and document, with the lost card ${order} it`, async () => {
			await render({ content: content() });
			expect(target.querySelectorAll('.artifact-container'), 'positive control: two cards').toHaveLength(2);
			expect(notices(), 'one notice').toHaveLength(1);
			expect(frames(), 'one frame, the intact card\'s').toHaveLength(1);
			const frameCard = frames()[0]!.closest('.artifact-container')!;
			expect(frameCard.querySelector('[data-testid="artifact-inline-lost-badge"]'), 'in the card without the badge').toBeNull();
			expect(documentOf(frames()[0]!), 'showing its own document').toContain('Schneeräumung ab CHF 80');
		});
	}

	it('keeps the content of a short fence the model wrote: the rule on its text gives the badge only', async () => {
		// The same kind of fence as below, under the store's bound: the rule on its text marks it,
		// but no save stands behind it, so it keeps its frame and its document.
		const short = '<!' + '-- type: html -->\n<h1>Debug</h1><p>The note ' + PLACEHOLDER + ' replaced a body.</p>';
		await render({ content: '```artifact\n' + short + '\n```' });
		expect(badges(), 'positive control: the rule on the text marks it').toHaveLength(1);
		expect(notices(), 'no notice').toHaveLength(0);
		expect(frames(), 'its frame').toHaveLength(1);
		expect(documentOf(frames()[0]!), 'with its document').toContain('Debug');
	});

	it('is not raised by an intact document that only quotes the placeholder', async () => {
		// A fence the model wrote (no title comment first), longer than the store's bound, with a
		// placeholder opening inside: a document quoting it, still readable.
		const quoting = '<!' + '-- type: html -->\n<h1>Changelog</h1><p>The note ' + PLACEHOLDER + ' replaced a body.</p>' + '<p>' + 'x'.repeat(2100) + '</p>';
		await render({ content: '```artifact\n' + quoting + '\n```' });
		expect(target.querySelectorAll('.artifact-container'), 'positive control: the card').toHaveLength(1);
		expect(badges(), 'no badge').toHaveLength(0);
		expect(notices(), 'no notice').toHaveLength(0);
		expect(frames(), 'its frame').toHaveLength(1);
		expect(documentOf(frames()[0]!), 'with its document').toContain('Changelog');
	});
});
