import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { t, tf, setLocale, getLocale } from '../i18n.svelte.js';
import { reset, setTarget, startMigration, getStep } from '../stores/migration.svelte.js';
import { getToasts, dismissToast } from '../stores/toast.svelte.js';

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

// Files the export could not carry (a link, a special file, a name that cannot be transferred)
// are named on the done step: a count, the paths on request, and the next step (row 1033, ux U-056).

let target: HTMLElement;
let component: Record<string, unknown> | undefined;
let done: Record<string, unknown>;
let config: Record<string, unknown>;

const VERIFICATION = { secretsImported: 1, databasesRestored: ['engine.db'], artifactsImported: 0, memoryFilesImported: 0, configApplied: true };

beforeEach(() => {
	reset();
	for (const toast of getToasts()) dismissToast(toast.id);
	target = document.createElement('div');
	document.body.appendChild(target);
	done = { success: true, verification: VERIFICATION };
	config = {};
	vi.stubGlobal('fetch', vi.fn(async (url: string) => {
		const u = String(url);
		if (u.endsWith('/migration/export')) {
			return new Response(`event: done\ndata: ${JSON.stringify(done)}\n\n`, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
		}
		const body = u.endsWith('/config') ? config : { secrets: 1, databases: ['engine.db'], artifacts: 0, hasConfig: true };
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

async function migrate(): Promise<void> {
	const { default: MigrationWizard } = await import('./MigrationWizard.svelte');
	component = mount(MigrationWizard, { target });
	await settle();
	setTarget('https://target.example.com', 'a'.repeat(64));
	await startMigration();
	await settle();
	expect(getStep()).toBe('done');
}

const skippedBlock = (): HTMLDetailsElement | null => target.querySelector('[data-testid="migration-skipped"]');
const summary = (): string | undefined => skippedBlock()?.querySelector('summary')?.textContent?.trim();
const paths = (): string[] => [...(skippedBlock()?.querySelectorAll('li') ?? [])].map((li) => li.textContent ?? '');
const nextLine = (): string | undefined => target.querySelector('[data-testid="migration-skipped-next"]')?.textContent?.trim();
const omittedLine = (): string | undefined => target.querySelector('[data-testid="migration-workspace-omitted"]')?.textContent?.trim();

describe('files the migration could not transfer', () => {
	const initialLocale = getLocale();
	afterEach(() => { setLocale(initialLocale); });

	it('control: without `skipped` there is no line, no list and no next step', async () => {
		await migrate();
		expect(skippedBlock()).toBeNull();
		expect(nextLine()).toBeUndefined();
	});

	it('one file: the singular, its path, and the next step', async () => {
		done = { ...done, skipped: ['workspace/link-to-home'] };
		await migrate();
		expect(summary()).toBe(t('migration.skipped_one'));
		expect(paths()).toEqual(['workspace/link-to-home']);
		expect(nextLine()).toBe(t('migration.workspace_omitted_self'));
		// Closed until asked: the count is what the step says first.
		expect(skippedBlock()?.open).toBe(false);
	});

	it('three files: the count, and every path', async () => {
		done = { ...done, skipped: ['workspace/a', 'workspace/b', 'workspace/c'] };
		await migrate();
		expect(summary()).toBe(tf('migration.skipped_many', { n: '3' }));
		expect(paths()).toEqual(['workspace/a', 'workspace/b', 'workspace/c']);
	});

	it('more than 50: the full count, 50 paths, and how many more', async () => {
		done = { ...done, skipped: Array.from({ length: 53 }, (_, i) => `workspace/f${String(i)}`) };
		await migrate();
		expect(summary()).toBe(tf('migration.skipped_many', { n: '53' }));
		expect(paths()).toHaveLength(50);
		expect(paths()[49]).toBe('workspace/f49');
		expect(skippedBlock()?.textContent).toContain(tf('migration.skipped_more', { m: '3' }));
	});

	it('with the workspace left out too, the next step is said once', async () => {
		done = { ...done, workspace: 'omitted-sidecar', skipped: ['workspace/a'] };
		await migrate();
		expect(omittedLine()).toBe(t('migration.workspace_omitted_self'));
		expect(nextLine()).toBeUndefined();
		expect(summary()).toBe(t('migration.skipped_one'));
	});

	it('a second migration in the same wizard does not keep the first one\'s list', async () => {
		done = { ...done, skipped: ['workspace/a'] };
		await migrate();
		expect(paths()).toEqual(['workspace/a']);
		done = { success: true, verification: VERIFICATION };
		setTarget('https://target.example.com', 'a'.repeat(64));
		await startMigration();
		await settle();
		expect(getStep()).toBe('done');
		expect(skippedBlock()).toBeNull();
	});

	it('ignores a `skipped` that is not a list of names', async () => {
		done = { ...done, skipped: 'workspace/a' };
		await migrate();
		expect(skippedBlock()).toBeNull();
	});

	// Last: the managed status the wizard loads stays in its store for the rest of the file.
	it('names support as the next step on a managed instance', async () => {
		config = { managed: 'managed' };
		done = { ...done, skipped: ['workspace/a'] };
		await migrate();
		expect(nextLine()).toBe(t('migration.workspace_omitted_managed'));
	});

	it('the texts, word for word (ux U-056)', () => {
		setLocale('de');
		expect(t('migration.skipped_one')).toBe('1 Datei wurde nicht übertragen (eine Verknüpfung oder ein Name, der sich nicht übertragen lässt).');
		expect(tf('migration.skipped_many', { n: '3' })).toBe('3 Dateien wurden nicht übertragen (Verknüpfungen oder Namen, die sich nicht übertragen lassen).');
		expect(tf('migration.skipped_more', { m: '3' })).toBe('… und 3 weitere');
		setLocale('en');
		expect(t('migration.skipped_one')).toBe('1 file was not transferred (a link, or a name that cannot be transferred).');
		expect(tf('migration.skipped_many', { n: '3' })).toBe('3 files were not transferred (links, or names that cannot be transferred).');
		expect(tf('migration.skipped_more', { m: '3' })).toBe('… and 3 more');
	});
});
