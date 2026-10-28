import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { t } from '../i18n.svelte.js';

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

// The backup list says what a backup leaves out of the workspace, and trusts that record only on a
// manifest whose origin the engine verified (row 987, ux U-030).

let target: HTMLElement;
let component: Record<string, unknown> | undefined;
let listed: Record<string, unknown>[];
let config: Record<string, unknown>;

const backup = (id: string, over: Record<string, unknown>): Record<string, unknown> => ({
	backup_id: id, version: '2.17.0', created_at: '2026-10-28T08:00:00.000Z', encrypted: false,
	files: [{ path: 'config.json', size_bytes: 10 }], checksum: 'c', ...over,
});

beforeEach(() => {
	target = document.createElement('div');
	document.body.appendChild(target);
	listed = [];
	config = { backup_retention_days: 30 };
	vi.stubGlobal('fetch', vi.fn(async (url: string) => {
		const body = String(url).endsWith('/config') ? config : { backups: listed };
		return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
	}));
});

afterEach(() => {
	if (component) unmount(component);
	component = undefined;
	target.remove();
	vi.unstubAllGlobals();
});

async function render(): Promise<void> {
	const { default: BackupsView } = await import('./BackupsView.svelte');
	component = mount(BackupsView, { target });
	for (let i = 0; i < 10; i++) {
		await new Promise((r) => setTimeout(r, 0));
		await tick();
		flushSync();
	}
}

const badges = (): string[] => [...target.querySelectorAll('[data-testid="backup-coverage-badge"]')].map((e) => e.textContent?.trim() ?? '');
const lines = (): string[] => [...target.querySelectorAll('[data-testid="backup-coverage-line"]')].map((e) => e.textContent?.trim() ?? '');

describe('BackupsView: what a backup covers', () => {
	it('control: a verified backup without a record shows no notice', async () => {
		listed = [backup('b-1', { provenance: 'verified' })];
		await render();
		expect(target.textContent).toContain('1 ' + t('backups.files'));
		expect(badges()).toEqual([]);
		expect(lines()).toEqual([]);
	});

	it('a verified backup without the workspace says so, with the self-hosted way out without a tier', async () => {
		listed = [backup('b-1', { provenance: 'verified', coverage: { workspace: 'omitted-sidecar' } })];
		await render();
		expect(badges()).toEqual([t('backups.coverage_omitted_badge')]);
		expect(lines()).toEqual([t('backups.coverage_omitted_self')]);
	});

	it('names support on a managed instance', async () => {
		config = { backup_retention_days: 30, managed: 'managed' };
		listed = [backup('b-1', { provenance: 'verified', coverage: { workspace: 'omitted-sidecar' } })];
		await render();
		expect(lines()).toEqual([t('backups.coverage_omitted_managed')]);
	});

	it('an unsigned backup is unclear, also without a record, and a keyed engine advises a new backup', async () => {
		listed = [backup('b-1', { provenance: 'none' }), backup('b-2', { provenance: 'no-key' })];
		await render();
		expect(badges()).toEqual([t('backups.coverage_unclear_badge'), t('backups.coverage_unclear_badge')]);
		expect(lines()).toEqual([
			`${t('backups.coverage_unclear')} ${t('backups.coverage_unclear_new_backup')}`,
			t('backups.coverage_unclear'),
		]);
	});

	it('a backup whose proof of origin does not match warns', async () => {
		listed = [backup('b-1', { provenance: 'mismatch' })];
		await render();
		expect(badges()).toEqual([t('backups.coverage_mismatch_badge')]);
		expect(lines()).toEqual([`${t('backups.coverage_mismatch')} ${t('backups.coverage_mismatch_advice')}`]);
		expect(target.querySelector('[data-testid="backup-coverage-line"]')?.className).toContain('text-warning');
		expect(target.querySelector('[data-testid="backup-coverage-badge"]')?.className).toContain('text-warning');
	});

	it('control: an omitted or unclear notice is not in warning colour', async () => {
		listed = [backup('b-1', { provenance: 'verified', coverage: { workspace: 'omitted-sidecar' } }), backup('b-2', { provenance: 'none' })];
		await render();
		for (const el of target.querySelectorAll('[data-testid^="backup-coverage-"]')) expect(el.className).not.toContain('warning');
	});
});
