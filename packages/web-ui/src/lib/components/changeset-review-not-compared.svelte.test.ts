import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// A file the engine could not compare (too large, or no diff) comes with a note instead of a diff,
// and its line counts are 0. The review must not show "+0 -0" for it: that reads as "nothing
// changed", and whoever does not expand the row keeps a file nobody compared.

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

const NOTE = '--- a/big.bin\n+++ b/big.bin\n(Content not compared: …)';

async function render(files: unknown[]): Promise<HTMLElement> {
	const { default: ChangesetReview } = await import('./ChangesetReview.svelte');
	component = svelte.mount(ChangesetReview, { target, props: { files, onReview: () => {} } });
	svelte.flushSync();
	return target;
}

/** The text of the file row for `file`. */
const row = (root: HTMLElement, file: string): string =>
	[...root.querySelectorAll('button')].map((b) => b.textContent ?? '').find((s) => s.includes(file)) ?? '';

describe('the changeset review, a file shown with a note instead of a diff', () => {
	it('shows "not compared" in its row instead of +0 -0, and the counts for a compared file', async () => {
		const root = await render([
			{ file: 'big.bin', status: 'modified', diff: NOTE, added: 0, removed: 0, compared: false },
			{ file: 'small.txt', status: 'modified', diff: '--- a/small.txt\n+++ b/small.txt\n-a\n+b', added: 1, removed: 1, compared: true },
		]);
		const big = row(root, 'big.bin');
		expect(big).toContain(t('changeset.not_compared'));
		expect(big).not.toMatch(/\+0|-0/);
		const small = row(root, 'small.txt');
		expect(small).toContain('+1');
		expect(small).not.toContain(t('changeset.not_compared'));
		expect(root.textContent, 'the header names how many were not compared').toContain(`1 ${t('changeset.not_compared')}`);
	});

	it('leaves the counts of a file not compared out of the header totals', async () => {
		const root = await render([
			{ file: 'cut.txt', status: 'modified', diff: '--- a/cut.txt\n+++ b/cut.txt\n-a\n+b\n(Diff cut: …)', added: 7000, removed: 9000, compared: false },
			{ file: 'small.txt', status: 'modified', diff: '--- a/small.txt\n+++ b/small.txt\n-a\n+b', added: 1, removed: 2, compared: true },
		]);
		const header = root.textContent ?? '';
		expect(header).toContain('+1');
		expect(header).toContain('-2');
		expect(header, 'a cut diff counts only its start').not.toMatch(/\+7001|-9002/);
	});

	it('an engine from before the flag (no `compared`) still shows the counts', async () => {
		const root = await render([
			{ file: 'small.txt', status: 'modified', diff: '--- a/small.txt\n+++ b/small.txt\n-a\n+b', added: 1, removed: 1 },
		]);
		expect(row(root, 'small.txt')).toContain('+1');
		expect(root.textContent).not.toContain(t('changeset.not_compared'));
	});
});
