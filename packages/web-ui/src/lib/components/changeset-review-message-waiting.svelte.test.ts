import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// A message held for an open review shows as a waiting bubble, which can sit far above the review
// card. The card says what the message waits for, and only while one does.

// `svelte` resolves to its server entry under node, where `mount` throws; mount with the client entry.
const CLIENT_ENTRY = join(dirname(createRequire(import.meta.url).resolve('svelte/package.json')), 'src/index-client.js');
type SvelteClient = {
	mount: (c: unknown, o: { target: Element; props: Record<string, unknown> }) => Record<string, unknown>;
	unmount: (c: Record<string, unknown>) => void;
	flushSync: () => void;
};
let svelte: SvelteClient;
let t: (key: string) => string;
let target: HTMLElement;
let component: Record<string, unknown> | undefined;

beforeEach(async () => {
	vi.resetModules();
	svelte = (await import(/* @vite-ignore */ CLIENT_ENTRY)) as SvelteClient;
	({ t } = await import('../i18n.svelte.js'));
	target = document.createElement('div');
	document.body.appendChild(target);
});

afterEach(() => {
	if (component) svelte.unmount(component);
	component = undefined;
	target.remove();
});

const FILES = [{ file: 'notes.md', status: 'modified', diff: '-a\n+b', added: 1, removed: 1 }];

async function render(props: Record<string, unknown>): Promise<HTMLElement> {
	const { default: ChangesetReview } = await import('./ChangesetReview.svelte');
	component = svelte.mount(ChangesetReview, { target, props: { files: FILES, onReview: () => {}, ...props } });
	svelte.flushSync();
	return target;
}

describe('the review card while a message waits for it', () => {
	it('says the message goes out once the changes are decided', async () => {
		const root = await render({ messageWaiting: true });
		expect(t('changeset.message_waiting'), 'positive control: the key has a text').not.toBe('changeset.message_waiting');
		expect(root.querySelector('[data-testid="changeset-message-waiting"]')?.textContent).toBe(t('changeset.message_waiting'));
	});

	it('says nothing of the kind when no message waits', async () => {
		const root = await render({});
		expect(root.textContent, 'positive control: the card is there').toContain('notes.md');
		expect(root.querySelector('[data-testid="changeset-message-waiting"]')).toBeNull();
	});
});

describe('the review card after a rollback stopped partway', () => {
	it('says in the card, as a warning, which files are not restored yet, each name a unit of its own', async () => {
		const root = await render({ rollbackStopped: ['preise-2027.csv', 'angebot.md'] });
		const p = root.querySelector('[data-testid="changeset-rollback-stopped"]');
		expect(t('changeset.rollback_aborted'), 'positive control: the key has a text').toContain('{files}');
		const [before, after] = t('changeset.rollback_aborted').split('{files}');
		expect(p?.textContent).toBe(`${before}preise-2027.csv, angebot.md${after}`);
		expect(p?.className).toContain('text-warning');
		expect([...(p?.querySelectorAll('span.inline-block') ?? [])].map((s) => s.textContent)).toEqual(['preise-2027.csv', 'angebot.md']);
	});

	it('names five files and counts the rest', async () => {
		const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((n) => `${n}.md`);
		const root = await render({ rollbackStopped: names });
		const p = root.querySelector('[data-testid="changeset-rollback-stopped"]');
		expect(p?.querySelectorAll('span.inline-block').length).toBe(5);
		const { tf } = await import('../i18n.svelte.js');
		expect(p?.textContent).toContain(tf('changeset.not_restored_more', { files: '', n: '2' }));
	});

	it('says nothing of the kind without a stopped rollback', async () => {
		const root = await render({});
		expect(root.textContent, 'positive control: the card is there').toContain('notes.md');
		expect(root.querySelector('[data-testid="changeset-rollback-stopped"]')).toBeNull();
	});
});
