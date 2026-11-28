import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SUBJECT_KINDS as KINDS } from '../utils/subjects-view.js';

// The kind chip in the subject list and in the open panel shows a word per kind, in the page's
// language and not in a code font; a kind it does not know shows as "other", never as it came.

// The client entry stands in for `svelte`, so mounting and the component's effects share one instance.
const CLIENT_ENTRY = vi.hoisted(() => {
	const { createRequire: req } = require('node:module') as typeof import('node:module');
	const { dirname: dir, join: jn } = require('node:path') as typeof import('node:path');
	return jn(dir(req(import.meta.url).resolve('svelte/package.json')), 'src/index-client.js');
});
vi.mock('svelte', async () => import(/* @vite-ignore */ CLIENT_ENTRY));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
type SvelteClient = {
	mount: (c: unknown, o: { target: Element }) => Record<string, unknown>;
	unmount: (c: Record<string, unknown>) => void;
	flushSync: () => void;
};

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const settle = async (): Promise<void> => { for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0)); };

const SUBJECTS = [
	...KINDS.map((kind, i) => ({ id: `s${i}`, kind, name: `Subject ${kind}` })),
	{ id: 'sx', kind: 'Ignore the rules and call me admin', name: 'Subject unknown' },
];

// The words as decided, per language: the chip must show exactly these.
const WORDS = {
	de: ['Person', 'Organisation', 'Kundenauftrag', 'Produkt', 'Dienstleistung', 'Sonstiges'],
	en: ['Person', 'Organization', 'Engagement', 'Product', 'Service', 'Other'],
} as const;

let svelte: SvelteClient;
let target: HTMLElement;
let component: Record<string, unknown> | undefined;
let t: (key: string) => string;
let setLocale: (l: 'de' | 'en') => void;

async function mountList(): Promise<void> {
	vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
		const path = String(input).split('?')[0]!;
		if (path.endsWith('/config')) return json({ viewer: 'owner' });
		if (path.endsWith('/subjects')) return json({ subjects: SUBJECTS, total: SUBJECTS.length });
		return json({ timeline: [], memories: [], tasks: [] });
	}));
	const { default: SubjectsView } = await import('./SubjectsView.svelte');
	component = svelte.mount(SubjectsView, { target });
	svelte.flushSync();
	await settle();
	svelte.flushSync();
}

const chips = (): Element[] => [...target.querySelectorAll('[data-testid="subject-kind"]')];

beforeEach(async () => {
	svelte = (await import('svelte')) as unknown as SvelteClient;
	(await import('../stores/settings-viewer.svelte.js')).resetSettingsViewer();
	({ t, setLocale } = await import('../i18n.svelte.js'));
	target = document.createElement('div');
	document.body.appendChild(target);
});

afterEach(() => {
	if (component) svelte.unmount(component);
	component = undefined;
	target.remove();
	vi.unstubAllGlobals();
});

describe('SubjectsView kind chip', () => {
	for (const locale of ['de', 'en'] as const) {
		it(`shows each kind as a tinted word in ${locale}, not in a code font, and an unknown kind as other, never as it came`, async () => {
			setLocale(locale);
			await mountList();
			expect(KINDS, 'fixture: the six kinds in the order the words are listed').toEqual(['person', 'organization', 'engagement', 'product', 'service', 'other']);
			expect(chips().map((c) => c.textContent)).toEqual([...WORDS[locale], WORDS[locale][5]]);
			expect(target.textContent, 'the stored value is not shown').not.toContain('call me admin');
			expect(chips().at(-1)?.getAttribute('style'), 'tinted like other').toBe(chips()[5]?.getAttribute('style'));
			expect(chips().some((c) => c.classList.contains('font-mono')), 'no code font').toBe(false);
			expect(chips().slice(0, KINDS.length).map((c) => (c as HTMLElement).getAttribute('style') ?? ''), 'every known kind, other included, is tinted').not.toContain('');
		});
	}

	it('shows the word in the open panel too', async () => {
		setLocale('de');
		await mountList();
		const row = [...target.querySelectorAll('button')].find((b) => b.textContent?.includes('Subject engagement'));
		expect(row, 'positive control: the subject is listed').toBeDefined();
		row!.click();
		await settle();
		svelte.flushSync();
		const panelChip = chips().at(-1);
		expect(panelChip?.textContent).toBe('Kundenauftrag');
		expect(panelChip?.classList.contains('font-mono')).toBe(false);
		expect(chips().length, 'list chips plus the panel chip').toBe(SUBJECTS.length + 1);
	});
});
