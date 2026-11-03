import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { t } from '../i18n.svelte.js';
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

// A migration whose export left the workspace out in shell sidecar mode says so on its done step
// and in its toast, instead of "completed successfully" alone (row 987 part 4, ux U-046).

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

const omittedLine = (): string | undefined => target.querySelector('[data-testid="migration-workspace-omitted"]')?.textContent?.trim();
const toastMessages = (): string[] => getToasts().map((toast) => toast.message);

describe('the migration done step', () => {
	it('control: with the workspace carried along it says the migration completed', async () => {
		await migrate();
		expect(target.textContent).toContain(t('migration.success_desc'));
		expect(omittedLine()).toBeUndefined();
		expect(toastMessages()).toEqual([t('migration.success')]);
		expect(getToasts().map((toast) => toast.type)).toEqual(['success']);
	});

	it('without the workspace it says so in the description, a warning line and the toast', async () => {
		done = { ...done, workspace: 'omitted-sidecar' };
		await migrate();
		expect(target.textContent).toContain(t('migration.success_desc_without_workspace'));
		expect(target.textContent).not.toContain(t('migration.success_desc'));
		expect(omittedLine()).toBe(t('migration.workspace_omitted_self'));
		expect(target.querySelector('[data-testid="migration-workspace-omitted"]')?.className).toContain('text-warning');
		expect(toastMessages()).toEqual([t('migration.success_without_workspace')]);
		// Not the green success toast: it is read and dismissed with the files left behind.
		expect(getToasts().map((toast) => toast.type)).toEqual(['info']);
	});

	it('names support on a managed instance', async () => {
		config = { managed: 'managed' };
		done = { ...done, workspace: 'omitted-sidecar' };
		await migrate();
		expect(omittedLine()).toBe(t('migration.workspace_omitted_managed'));
	});
});
