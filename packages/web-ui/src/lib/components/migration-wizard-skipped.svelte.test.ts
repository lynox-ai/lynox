import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { t, tf, setLocale, getLocale } from '../i18n.svelte.js';
import { reset, setTarget, startMigration, getStep, getDoneSkipped } from '../stores/migration.svelte.js';
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
const description = (): string | undefined => target.querySelector('h2 + p')?.textContent?.trim();
const toasts = (): Array<[string, string]> => getToasts().map((toast) => [toast.type, toast.message]);

describe('files the migration could not transfer', () => {
	const initialLocale = getLocale();
	afterEach(() => { setLocale(initialLocale); });

	it('control: without `skipped` there is no line, no list and no next step', async () => {
		await migrate();
		expect(skippedBlock()).toBeNull();
		expect(nextLine()).toBeUndefined();
		expect(description()).toBe(t('migration.success_desc'));
		expect(toasts()).toEqual([['success', t('migration.success')]]);
	});

	// The number-sensitive tests run in English: in German the singular and plural next step read the same.
	it('one file: the singular, its path, and the next step', async () => {
		setLocale('en');
		done = { ...done, skipped: ['workspace/link-to-home'] };
		await migrate();
		expect(summary()).toBe(t('migration.skipped_one'));
		expect(paths()).toEqual(['workspace/link-to-home']);
		expect(nextLine()).toBe(t('migration.skipped_next_self_one'));
		// Not "your data is available" without the exception.
		expect(description()).toBe(t('migration.success_desc_skipped'));
		// Closed until asked: the count is what the step says first.
		expect(skippedBlock()?.open).toBe(false);
		// Not the green toast: it is read and dismissed with the files left behind (as in U-046).
		expect(toasts()).toEqual([['info', t('migration.success_skipped_one')]]);
	});

	it('three files: the count, and every path', async () => {
		setLocale('en');
		done = { ...done, skipped: ['workspace/a', 'workspace/b', 'workspace/c'] };
		await migrate();
		expect(summary()).toBe(tf('migration.skipped_many', { n: '3' }));
		expect(paths()).toEqual(['workspace/a', 'workspace/b', 'workspace/c']);
		expect(nextLine()).toBe(t('migration.skipped_next_self_many'));
		expect(toasts()).toEqual([['info', tf('migration.success_skipped_many', { n: '3' })]]);
	});

	it('exactly 50: every path, and no "more" line', async () => {
		done = { ...done, skipped: Array.from({ length: 50 }, (_, i) => `workspace/f${String(i)}`) };
		await migrate();
		expect(paths()).toHaveLength(50);
		expect(skippedBlock()?.textContent).not.toContain(tf('migration.skipped_more', { m: '0' }));
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
		// The workspace notice's own description (U-046) wins over the skipped one.
		expect(description()).toBe(t('migration.success_desc_without_workspace'));
		expect(summary()).toBe(t('migration.skipped_one'));
		// The workspace notice's toast, from U-046.
		expect(toasts()).toEqual([['info', t('migration.success_without_workspace')]]);
	});

	it('shows a bidi control in a name instead of letting it reverse the path', async () => {
		done = { ...done, skipped: ['workspace/inv\u202Egnp.exe'] };
		await migrate();
		expect(paths()).toEqual(['workspace/inv\\u{202E}gnp.exe']);
	});

	it('a second migration in the same wizard does not keep the first one\'s list', async () => {
		done = { ...done, skipped: ['workspace/a'] };
		await migrate();
		expect(paths()).toEqual(['workspace/a']);
		// The second one fails, so no `done` of its own clears the list: starting it must.
		done = { success: false };
		setTarget('https://target.example.com', 'a'.repeat(64));
		await startMigration();
		await settle();
		expect(getStep()).toBe('error');
		expect(getDoneSkipped()).toEqual([]);
	});

	it('reset clears the list', async () => {
		done = { ...done, skipped: ['workspace/a'] };
		await migrate();
		reset();
		expect(getDoneSkipped()).toEqual([]);
	});

	it('keeps only the names of a list that holds other values too', async () => {
		done = { ...done, skipped: ['workspace/a', 7, null, 'workspace/b'] };
		await migrate();
		expect(paths()).toEqual(['workspace/a', 'workspace/b']);
	});

	it('ignores a `skipped` that is not a list of names', async () => {
		done = { ...done, skipped: 'workspace/a' };
		await migrate();
		expect(skippedBlock()).toBeNull();
	});

	// Last: the managed status the wizard loads stays in its store for the rest of the file.
	it('names support as the next step on a managed instance', async () => {
		setLocale('en');
		config = { managed: 'managed' };
		done = { ...done, skipped: ['workspace/a'] };
		await migrate();
		expect(nextLine()).toBe(t('migration.skipped_next_managed_one'));
	});

	it('names support for several files on a managed instance', async () => {
		setLocale('en');
		config = { managed: 'managed' };
		done = { ...done, skipped: ['workspace/a', 'workspace/b'] };
		await migrate();
		expect(nextLine()).toBe(t('migration.skipped_next_managed_many'));
	});

	it('the texts, word for word (ux U-056)', () => {
		setLocale('de');
		expect(t('migration.skipped_one')).toBe('1 Datei wurde nicht übertragen. Verknüpfungen, Sonderdateien und manche Namen lassen sich nicht übertragen.');
		expect(tf('migration.skipped_many', { n: '3' })).toBe('3 Dateien wurden nicht übertragen. Verknüpfungen, Sonderdateien und manche Namen lassen sich nicht übertragen.');
		expect(tf('migration.skipped_more', { m: '3' })).toBe('… und 3 weitere');
		expect(t('migration.success_skipped_one')).toBe('Migration abgeschlossen. 1 Datei wurde nicht übertragen.');
		expect(tf('migration.success_skipped_many', { n: '3' })).toBe('Migration abgeschlossen. 3 Dateien wurden nicht übertragen.');
		expect(t('migration.success_desc_skipped')).toBe('Deine Daten sind jetzt auf deiner Managed-Instanz verfügbar, ausser den Dateien unten.');
		expect(t('migration.skipped_next_managed_one')).toBe('Für eine Kopie auf die neue Instanz schreib an support@lynox.ai.');
		expect(t('migration.skipped_next_managed_many')).toBe('Für eine Kopie auf die neue Instanz schreib an support@lynox.ai.');
		expect(t('migration.skipped_next_self_one')).toBe('Übertrage sie dort, wo du sie verwaltest.');
		expect(t('migration.skipped_next_self_many')).toBe('Übertrage sie dort, wo du sie verwaltest.');
		setLocale('en');
		expect(t('migration.skipped_one')).toBe('1 file was not transferred. Links, special files and some names cannot be transferred.');
		expect(tf('migration.skipped_many', { n: '3' })).toBe('3 files were not transferred. Links, special files and some names cannot be transferred.');
		expect(tf('migration.skipped_more', { m: '3' })).toBe('… and 3 more');
		expect(t('migration.success_skipped_one')).toBe('Migration complete. 1 file was not transferred.');
		expect(tf('migration.success_skipped_many', { n: '3' })).toBe('Migration complete. 3 files were not transferred.');
		expect(t('migration.success_desc_skipped')).toBe('Your data is now available on your managed instance, except for the files below.');
		expect(t('migration.skipped_next_managed_one')).toBe('To have it copied to the new instance, write to support@lynox.ai.');
		expect(t('migration.skipped_next_managed_many')).toBe('To have them copied to the new instance, write to support@lynox.ai.');
		expect(t('migration.skipped_next_self_one')).toBe('Move it where you manage it.');
		expect(t('migration.skipped_next_self_many')).toBe('Move them where you manage them.');
	});
});
