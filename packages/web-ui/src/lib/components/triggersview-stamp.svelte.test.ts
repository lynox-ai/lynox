import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { setLocale, getLocale } from '../i18n.svelte.js';

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

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));

// The owner's stamp of a schedule in the schedules view (641 4b (ii-a), ii-c-min): a schedule a
// mandate set up waits, shows what the stamp holds from the stamp preview (not from the list), and
// is confirmed with the preview's digest; a 409 `changed` shows the new state for a second look,
// every other refusal is final; a workflow schedule on an unconfirmed workflow is not offered a
// confirm; a confirmed schedule offers "Check connections".

let target: HTMLElement;
let component: Record<string, unknown> | undefined;
let viewer = 'owner';
let rows: Record<string, unknown>[] = [];
let previewAnswers: Record<string, unknown>[] = [];
let confirmAnswers: Array<{ status: number; body: Record<string, unknown> }> = [];
let previews = 0;
const posts: unknown[] = [];
const before = getLocale();

const HELD = {
	id: 't1', title: 'Row title (from the list)', status: 'open', effect: 'run_agent', source: 'cron',
	created_by: 'mandate:eva@kanzlei.example', schedule_cron: '0 9 * * 1', next_run_at: '2026-11-02T09:00:00.000Z',
};
const SUBJECT = {
	id: 't1', effect: 'run_agent', source: 'cron', title: 'Report', description: 'Mail every customer the totals',
	schedule_cron: '0 9 * * 1', watch: null, pipeline_id: null, pipeline_params: null, model_tier: null, wf: null,
};
const PREVIEW = {
	expect: 'digest-1', subject: SUBJECT, by: 'eva@kanzlei.example', workflow: null,
	connections: [{ id: 'crm', profile: 'CRM', provider: 'api.crm.example', account: null }],
};

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
	setLocale('de');
	viewer = 'owner';
	rows = [HELD];
	previewAnswers = [];
	confirmAnswers = [];
	previews = 0;
	posts.length = 0;
	vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
		const u = String(url);
		if (u.endsWith('/triggers')) return json(200, { triggers: rows, viewer });
		if (u.endsWith('/triggers/paused-count')) return json(200, { viewer, count: 0 });
		if (u.endsWith('/stamp-preview')) { previews++; return json(200, previewAnswers.shift() ?? PREVIEW); }
		if (u.endsWith('/confirm')) {
			posts.push(init?.body === undefined ? undefined : JSON.parse(String(init.body)));
			const a = confirmAnswers.shift() ?? { status: 200, body: { ...HELD, confirmed_at: '2026-10-29T00:00:00.000Z' } };
			return json(a.status, a.body);
		}
		if (u.endsWith('/secrets/status')) return json(200, { managed: 'managed' });
		return json(200, {});
	}));
	target = document.createElement('div');
	document.body.appendChild(target);
});

afterEach(() => {
	if (component) unmount(component);
	component = undefined;
	target.remove();
	vi.unstubAllGlobals();
	setLocale(before);
});

async function settle(): Promise<void> {
	for (let i = 0; i < 10; i++) {
		await new Promise((r) => setTimeout(r, 0));
		await tick();
		flushSync();
	}
}

async function render(): Promise<void> {
	const { default: TriggersView } = await import('./TriggersView.svelte');
	component = mount(TriggersView, { target });
	await settle();
}

const q = (sel: string): HTMLElement | null => target.querySelector<HTMLElement>(sel);
const confirmButton = (): HTMLButtonElement | null => target.querySelector<HTMLButtonElement>('[data-stamp-confirm-button]');
const runNow = (): HTMLButtonElement | undefined => [...target.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('Jetzt ausführen') || b.getAttribute('aria-label') === 'Jetzt ausführen');

describe('a schedule a mandate set up', () => {
	it('waits: its badge, no next run, no run-now', async () => {
		await render();
		expect(q('[data-trigger-held]')).not.toBeNull();
		expect(target.textContent).not.toContain('Nächster Lauf');
		expect(runNow()).toBeUndefined();
	});

	it('shows the owner what the stamp holds from the preview, not from the list', async () => {
		await render();
		expect(previews).toBe(1);
		const instruction = q('[data-stamp-instruction]')!.textContent!;
		expect(instruction).toContain('Mail every customer the totals');
		expect(instruction).not.toContain('Row title');
		expect(q('[data-stamp-connections]')!.textContent).toBe('Dieser Plan nutzt Verbindungen, die eva@kanzlei.example mit eigenem Login verbunden hat: api.crm.example (Konto unbekannt).');
		expect(q('[data-stamp-schedule]')).not.toBeNull();
	});

	it('is confirmed with the digest of what was shown', async () => {
		await render();
		confirmButton()!.click();
		await settle();
		expect(posts).toEqual([{ expect: 'digest-1' }]);
	});

	it('after a 409 `changed`, shows the new state and confirms only on a second click, with its digest', async () => {
		confirmAnswers = [{ status: 409, body: { error: 'changed', code: 'changed' } }];
		previewAnswers = [PREVIEW, { ...PREVIEW, expect: 'digest-2', subject: { ...SUBJECT, description: 'Mail every customer AND delete the list' } }];
		await render();
		confirmButton()!.click();
		await settle();
		expect(posts).toEqual([{ expect: 'digest-1' }]);
		expect(previews).toBe(2);
		expect(q('[data-stamp-changed]')).not.toBeNull();
		expect(document.activeElement).toBe(q('[data-stamp-changed]'));
		expect(q('[data-stamp-instruction]')!.textContent).toContain('AND delete the list');
		confirmButton()!.click();
		await settle();
		expect(posts).toEqual([{ expect: 'digest-1' }, { expect: 'digest-2' }]);
	});

	it('any other refusal is final: no new preview, no second look', async () => {
		confirmAnswers = [{ status: 409, body: { error: 'paused', code: 'paused' } }];
		await render();
		confirmButton()!.click();
		await settle();
		expect(previews).toBe(1);
		expect(q('[data-stamp-changed]')).toBeNull();
	});

	it('a helper sees that it waits, but neither the preview nor a button', async () => {
		viewer = 'mandate';
		await render();
		expect(q('[data-trigger-held]')).not.toBeNull();
		expect(previews).toBe(0);
		expect(confirmButton()).toBeNull();
		expect(runNow()).toBeUndefined();
	});

	it('held for a mandate\'s change only: once the owner changed it last, it no longer waits', async () => {
		// A backup has no confirmation of its own (`awaitsConfirmation` is the agent run's), so only
		// the mandate's authorship holds it.
		rows = [{ ...HELD, effect: 'backup' }];
		await render();
		expect(q('[data-trigger-held]')).not.toBeNull();
		expect(confirmButton()).not.toBeNull();
		unmount(component!);
		component = undefined;
		rows = [{ ...HELD, effect: 'backup', edited_by: 'owner' }];
		previews = 0;
		await render();
		expect(q('[data-trigger-held]')).toBeNull();
		expect(previews).toBe(0);
	});
});

describe('a workflow schedule', () => {
	const WF_ROW = { ...HELD, effect: 'run_workflow', pipeline_id: 'wf-1' };
	const WF_PREVIEW = { ...PREVIEW, subject: { ...SUBJECT, effect: 'run_workflow', pipeline_id: 'wf-1', pipeline_params: '{"to":"all"}' }, workflow: { name: 'Monthly mail', confirmed: true } };

	it('shows its workflow and values, and is confirmed', async () => {
		rows = [WF_ROW];
		previewAnswers = [WF_PREVIEW];
		await render();
		expect(q('[data-stamp-workflow]')!.textContent).toContain('Monthly mail');
		expect(q('[data-stamp-workflow]')!.textContent).toContain('to: all');
		expect(confirmButton()).not.toBeNull();
	});

	it('on an unconfirmed workflow: says where to review its steps, and offers no confirm', async () => {
		rows = [WF_ROW];
		previewAnswers = [{ ...WF_PREVIEW, workflow: { name: 'Monthly mail', confirmed: false } }];
		await render();
		expect(q('[data-stamp-workflow-unconfirmed]')!.textContent).toBe('Prüf zuerst seine Schritte unter Automation → Workflows, mit „Schritte prüfen“.');
		expect(confirmButton()).toBeNull();
	});
});

describe('a watch', () => {
	it('whose page cannot be read is offered no confirm', async () => {
		rows = [{ ...HELD, source: 'watch' }];
		previewAnswers = [{ ...PREVIEW, subject: { ...SUBJECT, source: 'watch', watch: '{"url":"ftp://a.example/x"}' } }];
		await render();
		expect(q('[data-stamp-watch]')).toBeNull();
		expect(q('[data-stamp-instruction]')).toBeNull();
		expect(confirmButton()).toBeNull();
	});
	it('shows the page it fetches, not the text', async () => {
		rows = [{ ...HELD, source: 'watch' }];
		previewAnswers = [{ ...PREVIEW, subject: { ...SUBJECT, source: 'watch', watch: '{"url":"https://lynox.ai@evil.example/prices","selector":"#p"}' } }];
		await render();
		expect(q('[data-stamp-watch]')!.textContent).toContain('https://evil.example');
		expect(q('[data-stamp-watch]')!.textContent).toContain('#p');
		expect(q('[data-stamp-instruction]')).toBeNull();
		expect(confirmButton()).not.toBeNull();
	});
});

describe('"Check connections" on a confirmed schedule', () => {
	const CONFIRMED = { ...HELD, confirmed_at: '2026-10-01T00:00:00.000Z', edited_by: 'owner' };
	const check = (): HTMLButtonElement | null => target.querySelector<HTMLButtonElement>('[data-trigger-check]');

	it('is offered to the owner only, at an agent or workflow run, and asks for the preview only when opened', async () => {
		rows = [CONFIRMED, { ...CONFIRMED, id: 't2', effect: 'backup' }];
		await render();
		expect(target.querySelectorAll('[data-trigger-check]')).toHaveLength(1);
		expect(check()!.textContent).toBe('Verbindungen prüfen');
		expect(previews).toBe(0);
		check()!.click();
		await settle();
		expect(previews).toBe(1);
		expect(check()!.getAttribute('aria-expanded')).toBe('true');
		confirmButton()!.click();
		await settle();
		expect(posts).toEqual([{ expect: 'digest-1' }]);
	});

	it('with nothing listed: says so, and offers no confirm', async () => {
		rows = [CONFIRMED];
		previewAnswers = [{ ...PREVIEW, connections: [] }];
		await render();
		check()!.click();
		await settle();
		expect(q('[data-stamp-none]')).not.toBeNull();
		expect(confirmButton()).toBeNull();
	});

	it('not for a helper', async () => {
		viewer = 'mandate';
		rows = [CONFIRMED];
		await render();
		expect(check()).toBeNull();
	});
});
