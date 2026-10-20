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

let target: HTMLElement;
let component: Record<string, unknown> | undefined;
/** Bodies of every PUT /config, in order. */
let puts: Record<string, unknown>[];
let stored: Record<string, unknown>;
let putStatus: number;

beforeEach(() => {
	target = document.createElement('div');
	document.body.appendChild(target);
	puts = [];
	putStatus = 200;
	stored = { backup_retention_days: 0, backup_encrypt: false };
	vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
		const u = String(url);
		if (u.endsWith('/config') && init?.method === 'PUT') {
			puts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
			return new Response('{}', { status: putStatus, headers: { 'Content-Type': 'application/json' } });
		}
		const body = u.endsWith('/config') ? stored : { backups: [] };
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

async function render(): Promise<void> {
	const { default: BackupsView } = await import('./BackupsView.svelte');
	component = mount(BackupsView, { target });
	await settle();
}

function button(label: string): HTMLButtonElement {
	const found = [...target.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
	if (!found) throw new Error(`no button "${label}"`);
	return found;
}

function retentionInput(): HTMLInputElement {
	const input = target.querySelector<HTMLInputElement>('#backup-retention');
	if (!input) throw new Error('no retention input');
	return input;
}

async function enterDays(value: string): Promise<void> {
	const input = retentionInput();
	input.value = value;
	input.dispatchEvent(new Event('input', { bubbles: true }));
	await settle();
}

const NEVER = () => t('backups.retention_never');
const CONFIRM_START = () => t('backups.retention_confirm').split('{days}')[0]!;

describe('BackupsView with a stored retention of 0 ("never delete")', () => {
	it('says that backups are never deleted and does not show the 0 as a number of days', async () => {
		await render();
		expect(target.textContent).toContain(NEVER());
		expect(retentionInput().value).toBe('');
	});

	it('re-sends the stored 0 unchanged when another setting is saved', async () => {
		await render();
		button(t('settings.save')).click();
		await settle();
		expect(puts).toEqual([{ backup_retention_days: 0, backup_encrypt: false }]);
		expect(target.textContent).toContain(NEVER());
	});

	it('asks before it saves a number of days, and saves only on Apply', async () => {
		await render();
		await enterDays('7');
		button(t('settings.save')).click();
		await settle();
		expect(puts).toEqual([]);
		expect(target.textContent).toContain(`${CONFIRM_START()}7`);

		button(t('backups.retention_apply')).click();
		await settle();
		expect(puts).toEqual([{ backup_retention_days: 7, backup_encrypt: false }]);
		expect(target.textContent).not.toContain(NEVER());
		expect(retentionInput().value).toBe('7');
	});

	it('saves nothing and keeps the 0 when the confirmation is cancelled', async () => {
		await render();
		await enterDays('7');
		button(t('settings.save')).click();
		await settle();
		button(t('backups.cancel')).click();
		await settle();
		expect(puts).toEqual([]);
		expect(target.textContent).not.toContain(CONFIRM_START());
		expect(target.textContent).toContain(NEVER());
	});

	it('keeps showing the 0, and re-sends it, when saving the days failed', async () => {
		await render();
		await enterDays('7');
		button(t('settings.save')).click();
		await settle();
		putStatus = 500;
		button(t('backups.retention_apply')).click();
		await settle();
		expect(puts).toEqual([{ backup_retention_days: 7, backup_encrypt: false }]);
		expect(target.textContent).toContain(NEVER());

		putStatus = 200;
		await enterDays('');
		button(t('settings.save')).click();
		await settle();
		expect(puts.at(-1)).toEqual({ backup_retention_days: 0, backup_encrypt: false });
	});

	it('neither asks nor saves for an entry the field cannot read, and says so on the field', async () => {
		await render();
		const input = retentionInput();
		// A number field holding "30 Tage" reports an empty value and flags it as bad input.
		Object.defineProperty(input, 'validity', { configurable: true, get: () => ({ badInput: true }) });
		const report = vi.spyOn(input, 'reportValidity').mockReturnValue(false);
		await enterDays('');
		button(t('settings.save')).click();
		await settle();
		expect(puts).toEqual([]);
		expect(report).toHaveBeenCalled();
		expect(target.textContent).toContain(NEVER());
	});

	it('neither asks nor saves for an entry of 0', async () => {
		await render();
		await enterDays('0');
		button(t('settings.save')).click();
		await settle();
		expect(puts).toEqual([]);
		expect(target.textContent).not.toContain(CONFIRM_START());
	});
});

describe('BackupsView with a stored number of days', () => {
	it('shows the days in the field and no never-delete notice', async () => {
		stored = { backup_retention_days: 30, backup_encrypt: false };
		await render();
		expect(target.textContent).not.toContain(NEVER());
		expect(retentionInput().value).toBe('30');
		button(t('settings.save')).click();
		await settle();
		expect(puts).toEqual([{ backup_retention_days: 30, backup_encrypt: false }]);
	});
});
