import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { t } from '../i18n.svelte.js';
import { resetSettingsViewer } from '../stores/settings-viewer.svelte.js';

// Removing a contact, deleting a file, deciding on the knowledge queue and changing memory are the
// owner's: the routes refuse a mandate. Each page offers those acts only once the server said the
// session is the owner's (not even for the moment before it answers), keeps everything else for
// every reader, and tells a mandate who acts where it came to act (the queue, memory).

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

let target: HTMLElement;
let component: Record<string, unknown> | undefined;
/** What `GET /api/config` names: null answers 502. */
let viewer: 'owner' | 'mandate' | 'none' | null;

beforeEach(() => {
	target = document.createElement('div');
	document.body.appendChild(target);
	resetSettingsViewer();
	viewer = 'mandate';
	vi.stubGlobal('confirm', () => true);
	vi.stubGlobal('fetch', vi.fn(async (url: string) => {
		const u = String(url);
		const reply = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
		if (u.endsWith('/config')) return viewer === null ? new Response('', { status: 502 }) : reply({ viewer });
		if (u.includes('/crm/contacts?')) return reply({ contacts: [{ _id: 7, name: 'Anna Muster', email: 'anna@example.invalid' }] });
		if (u.includes('/crm/contacts/')) return reply({ interactions: [], deals: [] });
		if (u.includes('/crm/deals')) return reply({ deals: [] });
		if (u.includes('/files?')) return reply({ path: '.', entries: [{ name: 'offer.pdf', isDirectory: false, size: 10 }] });
		if (u.endsWith('/knowledge/queue')) return reply({ entries: [{ id: 'q1', text: 'Anna prefers mail', subjectHint: null, kind: 'fact', sourceChannel: null, sourceType: 'web', createdAt: '2026-11-01 10:00:00' }], pendingCount: 1 });
		if (u.endsWith('/knowledge/entries')) return reply({ entries: [{ id: 'k1', subjectName: null, kind: 'fact', text: 'Invoices go out on Fridays', pinned: false }] });
		if (u.endsWith('/knowledge/blocks')) return reply({ profile: '', playbook: '' });
		if (u.includes('/memory/')) return reply({ content: '[2026-11-01] Invoices go out on Fridays' });
		if (u.endsWith('/kg/stats')) return reply({ memoryCount: 0, entityCount: 0, relationCount: 0, communityCount: 0 });
		return reply({});
	}));
});

afterEach(() => {
	if (component) unmount(component);
	component = undefined;
	target.remove();
	resetSettingsViewer();
	vi.unstubAllGlobals();
});

async function settle(): Promise<void> {
	for (let i = 0; i < 10; i++) {
		await new Promise((r) => setTimeout(r, 0));
		await tick();
		flushSync();
	}
}

const PAGES = {
	contacts: () => import('./ContactsView.svelte'),
	files: () => import('./FileBrowserView.svelte'),
	queue: () => import('./KnowledgeQueueView.svelte'),
	memory: () => import('./MemoryView.svelte'),
} as const;

async function render(page: keyof typeof PAGES, props: Record<string, unknown> = {}): Promise<string> {
	const { default: Page } = await PAGES[page]();
	component = mount(Page, { target, props });
	await settle();
	return target.textContent ?? '';
}

const buttonByText = (text: string): HTMLButtonElement | undefined =>
	[...target.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
const buttonByTitle = (title: string): HTMLButtonElement | undefined =>
	[...target.querySelectorAll('button')].find((b) => b.getAttribute('title') === title);

async function openContact(): Promise<void> {
	[...target.querySelectorAll('button')].find((b) => b.textContent?.includes('Anna Muster'))!.click();
	await settle();
}

describe('contacts', () => {
	it('shows a mandate a contact without "remove", and no sentence', async () => {
		await render('contacts');
		await openContact();
		expect(target.textContent).toContain('anna@example.invalid');
		expect(buttonByText(t('crm.remove'))).toBeUndefined();
		expect(target.textContent).not.toContain('owner');
	});

	it('offers the owner to remove it', async () => {
		viewer = 'owner';
		await render('contacts');
		await openContact();
		expect(buttonByText(t('crm.remove'))).toBeDefined();
	});
});

describe('files', () => {
	it('lets a mandate download a file but not delete it', async () => {
		await render('files');
		expect(buttonByTitle('Download')).toBeDefined();
		expect(buttonByTitle('Delete')).toBeUndefined();
	});

	it('offers the owner to delete it', async () => {
		viewer = 'owner';
		await render('files');
		expect(buttonByTitle('Delete')).toBeDefined();
	});
});

describe('the knowledge queue', () => {
	it('shows a mandate the entry without deciding on it, and who decides', async () => {
		const text = await render('queue');
		expect(text).toContain('Anna prefers mail');
		for (const key of ['knowledge.queue.approve', 'knowledge.queue.edit', 'knowledge.queue.reject']) expect(buttonByText(t(key)), key).toBeUndefined();
		expect(text).toContain(t('knowledge.queue.owner_only_notice'));
		expect(text).toContain(t('knowledge.queue.subtitle_mandate'));
		expect(text).not.toContain(t('knowledge.queue.subtitle'));
	});

	it('offers the owner every decision, with the owner\'s subtitle and no sentence', async () => {
		viewer = 'owner';
		const text = await render('queue');
		for (const key of ['knowledge.queue.approve', 'knowledge.queue.edit', 'knowledge.queue.reject']) expect(buttonByText(t(key)), key).toBeDefined();
		expect(text).toContain(t('knowledge.queue.subtitle'));
		expect(text).not.toContain(t('knowledge.queue.owner_only_notice'));
	});
});

describe('memory', () => {
	it('shows a mandate the remembered entries without removing one, and who changes them', async () => {
		const text = await render('memory', { hasDurableMemory: true });
		expect(text).toContain('Invoices go out on Fridays');
		expect(buttonByText(t('knowledge.active.retire'))).toBeUndefined();
		expect(text).toContain(t('memory.owner_only_notice'));
		expect(text).toContain(t('knowledge.active.subtitle_mandate'));
		expect(text).not.toContain(t('knowledge.active.subtitle'));
		expect(text).not.toContain(t('knowledge.active.edit_hint'));
	});

	it('offers the owner to remove an entry, with the owner\'s texts', async () => {
		viewer = 'owner';
		const text = await render('memory', { hasDurableMemory: true });
		expect(buttonByText(t('knowledge.active.retire'))).toBeDefined();
		expect(text).toContain(t('knowledge.active.subtitle'));
		expect(text).toContain(t('knowledge.active.edit_hint'));
		expect(text).not.toContain(t('memory.owner_only_notice'));
	});

	it('names this instance, not the reader, to a mandate when nothing is remembered yet', async () => {
		vi.stubGlobal('fetch', vi.fn(async (url: string) => {
			const u = String(url);
			const reply = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
			if (u.endsWith('/config')) return reply({ viewer });
			if (u.endsWith('/knowledge/entries')) return reply({ entries: [] });
			if (u.endsWith('/knowledge/blocks')) return reply({ profile: '', playbook: '' });
			return reply({});
		}));
		const asMandate = await render('memory', { hasDurableMemory: true });
		expect(asMandate).toContain(t('knowledge.active.empty_mandate'));
		expect(asMandate).not.toContain(t('knowledge.active.empty'));
		unmount(component!);
		component = undefined;
		resetSettingsViewer();
		viewer = 'owner';
		const asOwner = await render('memory', { hasDurableMemory: true });
		expect(asOwner).toContain(t('knowledge.active.empty'));
	});

	it('shows a mandate the older memory without editing, deleting, adding or erasing', async () => {
		const text = await render('memory');
		expect(text).toContain('Invoices go out on Fridays');
		for (const key of ['memory.edit', 'memory.delete_button', 'memory.add_button', 'memory.erase_pattern_button']) expect(buttonByText(t(key)), key).toBeUndefined();
		expect(target.querySelector('input')).toBeNull();
		expect(text).toContain(t('memory.owner_only_notice'));
	});

	it('offers the owner every change to the older memory', async () => {
		viewer = 'owner';
		await render('memory');
		for (const key of ['memory.edit', 'memory.delete_button', 'memory.add_button']) expect(buttonByText(t(key)), key).toBeDefined();
		expect(target.querySelector('input')).not.toBeNull();
	});
});

describe('a session the server has not named as the owner\'s', () => {
	for (const [name, answer] of [['no answer', null], ['a viewer that is neither', 'none']] as const) {
		it(`offers no owner's act on any of the four pages, and no sentence, on ${name}`, async () => {
			viewer = answer;
			await render('contacts');
			await openContact();
			expect(buttonByText(t('crm.remove'))).toBeUndefined();
			unmount(component!);
			await render('files');
			expect(buttonByTitle('Delete')).toBeUndefined();
			unmount(component!);
			const queue = await render('queue');
			expect(buttonByText(t('knowledge.queue.approve'))).toBeUndefined();
			expect(queue).not.toContain(t('knowledge.queue.owner_only_notice'));
			unmount(component!);
			const memory = await render('memory', { hasDurableMemory: true });
			expect(buttonByText(t('knowledge.active.retire'))).toBeUndefined();
			expect(memory).not.toContain(t('memory.owner_only_notice'));
		});
	}
});
