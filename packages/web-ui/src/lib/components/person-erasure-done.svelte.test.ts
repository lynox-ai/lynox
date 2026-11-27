import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PERSON_ERASURE_NOT_COVERED, type PersonErasureResult } from '../api/person-erasure.js';

// The person erasure panel after it has answered: once the erasure is done the panel says so
// and offers to close; it no longer reads as an open action. A partial answer is not done and
// keeps the erase heading and the cancel button.

// The client entry stands in for `svelte`, so mounting and the component's effects share one instance.
const CLIENT_ENTRY = vi.hoisted(() => {
	const { createRequire: req } = require('node:module') as typeof import('node:module');
	const { dirname: dir, join: jn } = require('node:path') as typeof import('node:path');
	return jn(dir(req(import.meta.url).resolve('svelte/package.json')), 'src/index-client.js');
});
vi.mock('svelte', async () => import(/* @vite-ignore */ CLIENT_ENTRY));
type SvelteClient = {
	mount: (c: unknown, o: { target: Element; props?: Record<string, unknown> }) => Record<string, unknown>;
	unmount: (c: Record<string, unknown>) => void;
	flushSync: () => void;
};

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const settle = async (): Promise<void> => { for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0)); };

const RESULT: PersonErasureResult = {
	erased: true,
	done: ['durable_knowledge', 'memories_legacy', 'memories_engine', 'subject'],
	failed: null,
	subjectId: 's1',
	scrubbed: true,
	counts: { entries: 1, memories: 0, legacyEntities: 0, subjects: 1 },
	left: { entries: 0, memories: 0, legacyEntities: 0, blocks: [] },
	notCovered: [...PERSON_ERASURE_NOT_COVERED],
};
const PARTIAL: PersonErasureResult = { ...RESULT, erased: false, done: ['durable_knowledge'], failed: 'memories_legacy' };
const PREVIEW = {
	subject: { id: 's1', name: 'Anna Muster', aliases: [] },
	entries: [{ id: 'e1', text: 'Anna Muster prefers mail', matchedBy: 'subject' }],
	memories: [],
	legacyEntities: [],
	blocksMentioning: [],
	plan: 'p1',
	notCovered: [...PERSON_ERASURE_NOT_COVERED],
};

let svelte: SvelteClient;
let target: HTMLElement;
let component: Record<string, unknown> | undefined;
let t: (key: string) => string;

/** Mounts the panel, the erase call answering with `answer`, and returns once the preview shows. */
let closed = 0;

async function mountPanel(answer: Response): Promise<void> {
	vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
		const path = String(input).split('?')[0]!;
		if (path.endsWith('/privacy/person-erasure/preview')) return json(PREVIEW);
		if (path.endsWith('/privacy/person-erasure')) return answer;
		return json({});
	}));
	const { default: PersonErasurePanel } = await import('./PersonErasurePanel.svelte');
	component = svelte.mount(PersonErasurePanel, { target, props: { subjectId: 's1', onclose: () => { closed++; }, onerased: () => {} } });
	svelte.flushSync();
	await settle();
	svelte.flushSync();
}

const heading = (): string | null | undefined => target.querySelector('h3')?.textContent;
const region = (): string | null | undefined => target.querySelector('[role="region"]')?.getAttribute('aria-label');
const topButton = (): string | null | undefined => target.querySelector('h3')?.parentElement?.querySelector('button')?.textContent;

async function confirmErasure(): Promise<void> {
	const button = [...target.querySelectorAll('button')].find((b) => b.textContent?.includes(t('erasure.confirm')));
	expect(button, 'positive control: the preview offers to erase').toBeDefined();
	button!.click();
	await settle();
	svelte.flushSync();
}

beforeEach(async () => {
	svelte = (await import('svelte')) as unknown as SvelteClient;
	({ t } = await import('../i18n.svelte.js'));
	(await import('../i18n.svelte.js')).setLocale('de');
	target = document.createElement('div');
	document.body.appendChild(target);
});

afterEach(() => {
	if (component) svelte.unmount(component);
	component = undefined;
	target.remove();
	vi.unstubAllGlobals();
});

describe('PersonErasurePanel once the erasure has answered', () => {
	it('says it is done and offers to close, in heading, region label and button', async () => {
		await mountPanel(json(RESULT));
		expect([heading(), region(), topButton()], 'before: an open action').toEqual([t('erasure.title'), t('erasure.title'), t('erasure.cancel')]);
		await confirmErasure();
		expect(target.querySelector('[role="status"]'), 'positive control: the done answer is shown').not.toBeNull();
		expect([heading(), region(), topButton()]).toEqual([t('erasure.done_title'), t('erasure.done_title'), t('erasure.close')]);
		const before = closed;
		target.querySelector('h3')?.parentElement?.querySelector('button')?.click();
		expect(closed - before, 'the button closes the panel').toBe(1);
	});

	it('keeps the erase heading and the cancel button after a partial answer', async () => {
		await mountPanel(json(PARTIAL, 500));
		await confirmErasure();
		expect(target.querySelector('[role="alert"]')?.textContent, 'positive control: the partial answer is shown').toContain(t('erasure.step.memories_legacy'));
		expect([heading(), region(), topButton()]).toEqual([t('erasure.title'), t('erasure.title'), t('erasure.cancel')]);
	});
});
