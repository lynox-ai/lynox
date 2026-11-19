import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { t } from '../i18n.svelte.js';
import { _resetManagedStatus } from '../stores/integrations/managed.svelte.js';

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
let config: Record<string, unknown> | 'fail' | 'hold';

const backup = (id: string, over: Record<string, unknown>): Record<string, unknown> => ({
	backup_id: id, version: '2.17.0', created_at: '2026-10-28T08:00:00.000Z', encrypted: false,
	files: [{ path: 'config.json', size_bytes: 10 }], file_count: 1, total_bytes: 10, checksum: 'c', ...over,
});

beforeEach(() => {
	target = document.createElement('div');
	document.body.appendChild(target);
	listed = [];
	config = { backup_retention_days: 30, billing_tier_set: false };
	_resetManagedStatus();
	vi.stubGlobal('fetch', vi.fn(async (url: string) => {
		const isConfig = String(url).endsWith('/config');
		if (isConfig && config === 'hold') return new Promise<Response>(() => { /* never answers */ });
		if (isConfig && config === 'fail') return new Response('{}', { status: 500 });
		const body = isConfig ? config : { backups: listed };
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
		expect(target.textContent).toContain('1 ' + t('backups.files_one'));
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
		config = { backup_retention_days: 30, managed: 'managed', billing_tier_set: true };
		listed = [backup('b-1', { provenance: 'verified', coverage: { workspace: 'omitted-sidecar' } })];
		await render();
		expect(lines()).toEqual([t('backups.coverage_omitted_managed')]);
	});

	// U-302: the way out is the engine's switch (any tier value), never a guess.
	const omitted = (): Record<string, unknown>[] => [backup('b-1', { provenance: 'verified', coverage: { workspace: 'omitted-sidecar' } })];

	it('names support for a tier value that does not normalize, as the engine refusals do', async () => {
		config = { backup_retention_days: 30, managed: null, billing_tier_set: true };
		listed = omitted();
		await render();
		expect(lines()).toEqual([t('backups.coverage_omitted_managed')]);
	});

	it('states the fact alone while the instance kind loads', async () => {
		config = 'hold';
		listed = omitted();
		await render();
		expect(lines()).toEqual([t('backups.coverage_omitted_fact')]);
	});

	it('says to reload when the instance kind could not be read, naming no way out', async () => {
		config = 'fail';
		listed = omitted();
		await render();
		expect(lines()).toEqual([t('backups.coverage_omitted_unknown')]);
	});

	it('keeps the way out an earlier read gave when a later read fails', async () => {
		config = { backup_retention_days: 30, billing_tier_set: true };
		listed = omitted();
		await render();
		unmount(component!);
		component = undefined;
		config = 'fail';
		await render();
		expect(lines()).toEqual([t('backups.coverage_omitted_managed')]);
	});

	it('counts an answer without the switch as not read', async () => {
		config = { backup_retention_days: 30, managed: 'managed' };
		listed = omitted();
		await render();
		expect(lines()).toEqual([t('backups.coverage_omitted_unknown')]);
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
		const notices = [...target.querySelectorAll('[data-testid^="backup-coverage-"]')];
		// Two badges and two lines, so the loop below cannot pass by finding nothing.
		expect(notices).toHaveLength(4);
		for (const el of notices) expect(el.className).not.toContain('warning');
	});
});
