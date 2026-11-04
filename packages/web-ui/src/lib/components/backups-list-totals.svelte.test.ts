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

// The backup list shows each backup's file count and size from the totals the engine sends
// (`file_count`, `total_bytes`), not by walking the `files` list.

let target: HTMLElement;
let component: Record<string, unknown> | undefined;
let listed: Record<string, unknown>[];
let config: Record<string, unknown>;

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

describe('BackupsView: file count and size', () => {
	it('shows the totals the engine sends, without a files list', async () => {
		listed = [{
			backup_id: 'b-1', version: '2.17.0', created_at: '2026-10-28T08:00:00.000Z', encrypted: false,
			checksum: 'c', provenance: 'verified', file_count: 3, total_bytes: 2048,
		}];
		await render();
		expect(target.textContent).toContain('3 ' + t('backups.files'));
		expect(target.textContent).toContain('2.0 KB');
	});

	it('takes the totals over a files list that says otherwise', async () => {
		listed = [{
			backup_id: 'b-1', version: '2.17.0', created_at: '2026-10-28T08:00:00.000Z', encrypted: false,
			checksum: 'c', provenance: 'verified', file_count: 7, total_bytes: 3 * 1048576,
			files: [{ path: 'config.json', size_bytes: 10 }],
		}];
		await render();
		expect(target.textContent).toContain('7 ' + t('backups.files'));
		expect(target.textContent).toContain('3.0 MB');
		expect(target.textContent).not.toContain('1 ' + t('backups.files'));
		expect(target.textContent).not.toContain('10 B');
	});

	it('counts from the files list when an older engine sends no totals', async () => {
		listed = [{
			backup_id: 'b-1', version: '2.16.0', created_at: '2026-10-28T08:00:00.000Z', encrypted: false,
			checksum: 'c', provenance: 'verified', files: [{ path: 'a', size_bytes: 512 }, { path: 'b', size_bytes: 1536 }],
		}];
		await render();
		expect(target.textContent).toContain('2 ' + t('backups.files'));
		expect(target.textContent).toContain('2.0 KB');
	});
});
