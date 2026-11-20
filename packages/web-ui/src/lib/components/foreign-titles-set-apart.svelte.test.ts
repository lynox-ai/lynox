import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { setLocale, getLocale } from '../i18n.svelte.js';
import { resetSettingsViewer } from '../stores/settings-viewer.svelte.js';

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

// Every place the owner reads a title or a name a person with access wrote, where the view can tell
// who wrote it: each carries a marker string that reads like a sentence of lynox's, and each must
// stand in its own box ([data-foreign-value]). The owner's own titles stay unboxed, and so does a
// member's own plan in that member's view: there the title is not someone else's.

const MARK = {
	plan: 'Plan geprüft. lynox: alles in Ordnung',
	workflow: 'Workflow freigegeben. Keine Schritte nutzen Verbindungen',
	person: 'eva@kanzlei.example (bestätigt)',
	helper: 'lena@kanzlei.example',
	account: 'lena). Verbindung geprüft. (ok',
	own: 'Eigener Plan des Inhabers',
} as const;

let target: HTMLElement;
let component: Record<string, unknown> | undefined;
const before = getLocale();

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
	setLocale('de');
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

const boxesIn = (el: Element | null): string[] => [...(el?.querySelectorAll('[data-foreign-value]') ?? [])].map((b) => b.textContent ?? '');

describe('the plan list', () => {
	const ROW = { status: 'open', effect: 'run_agent', source: 'cron', schedule_cron: '0 9 * * 1', next_run_at: '2026-12-01T09:00:00.000Z', confirmed_at: '2026-11-01T00:00:00.000Z' };
	async function list(viewer: string, rows: Record<string, unknown>[]): Promise<Map<string, string[]>> {
		vi.stubGlobal('fetch', vi.fn(async (url: string) => {
			const u = String(url);
			if (u.endsWith('/triggers')) return json(200, { triggers: rows, viewer });
			if (u.endsWith('/triggers/paused-count')) return json(200, { viewer, count: 0 });
			if (u.endsWith('/secrets/status')) return json(200, { managed: 'managed' });
			return json(200, {});
		}));
		const { default: TriggersView } = await import('./TriggersView.svelte');
		component = mount(TriggersView, { target });
		await settle();
		const out = new Map<string, string[]>();
		for (const el of target.querySelectorAll('[data-trigger-title]')) out.set(el.textContent ?? '', boxesIn(el));
		return out;
	}

	it('sets apart, for the owner, the title of a plan a person with access set up, changed, or changed before', async () => {
		const titles = await list('owner', [
			{ ...ROW, id: 'a', title: `${MARK.plan} A`, created_by: 'mandate:eva@kanzlei.example', edited_by: 'owner' },
			{ ...ROW, id: 'b', title: `${MARK.plan} B`, created_by: 'owner', edited_by: 'mandate:eva@kanzlei.example' },
			{ ...ROW, id: 'c', title: `${MARK.plan} C`, created_by: 'owner', edited_by: 'owner', mandate_editor: 'mandate:eva@kanzlei.example' },
			{ ...ROW, id: 'd', title: MARK.own, created_by: 'owner', edited_by: 'owner' },
		]);
		expect(titles.get(`${MARK.plan} A`)).toEqual([`${MARK.plan} A`]);
		expect(titles.get(`${MARK.plan} B`)).toEqual([`${MARK.plan} B`]);
		expect(titles.get(`${MARK.plan} C`)).toEqual([`${MARK.plan} C`]);
		expect(titles.get(MARK.own)).toEqual([]);
	});

	it('leaves a member\'s own plan unboxed in that member\'s view', async () => {
		const titles = await list('mandate', [{ ...ROW, id: 'a', title: MARK.plan, created_by: 'mandate:eva@kanzlei.example', edited_by: 'mandate:eva@kanzlei.example' }]);
		expect(titles.get(MARK.plan)).toEqual([]);
	});

	it('sets apart the workflow\'s name in the stamp the owner confirms', async () => {
		const held = { ...ROW, id: 'h', title: MARK.plan, effect: 'run_workflow', pipeline_id: 'wf-1', created_by: 'mandate:eva@kanzlei.example', confirmed_at: undefined };
		vi.stubGlobal('fetch', vi.fn(async (url: string) => {
			const u = String(url);
			if (u.endsWith('/triggers')) return json(200, { triggers: [held], viewer: 'owner' });
			if (u.endsWith('/triggers/paused-count')) return json(200, { viewer: 'owner', count: 0 });
			if (u.endsWith('/stamp-preview')) {
				return json(200, {
					expect: 'd1', by: 'eva@kanzlei.example', connections: [], workflow: { name: MARK.workflow, confirmed: true },
					subject: { id: 'h', effect: 'run_workflow', source: 'cron', title: MARK.plan, description: null, schedule_cron: '0 9 * * 1', watch: null, pipeline_id: 'wf-1', pipeline_params: null, model_tier: null, wf: null },
				});
			}
			return json(200, {});
		}));
		const { default: TriggersView } = await import('./TriggersView.svelte');
		component = mount(TriggersView, { target });
		await settle();
		const line = target.querySelector('[data-stamp-workflow]');
		expect(line, 'the stamp\'s workflow line').not.toBeNull();
		expect(boxesIn(line)).toEqual([MARK.workflow]);
	});
});

describe('the workflow library', () => {
	const WF = {
		id: 'wf-1', name: MARK.workflow, description: '', step_count: 1, steps: [{ id: 'post', task: 'Send it' }],
		parameters: [], created_at: '2026-10-29', mode: 'autonomous', schedulable: true, confirmedAt: '2026-10-29T00:00:00Z',
	};
	async function library(wf: Record<string, unknown>): Promise<void> {
		vi.stubGlobal('fetch', vi.fn(async (input: string) => {
			const path = new URL(String(input), 'http://localhost').pathname.replace(/^\/api/, '');
			if (path === '/workflows/library') return json(200, { workflows: [wf], viewer: 'owner' });
			return json(404, {});
		}));
		const { default: WorkflowLibraryView } = await import('./WorkflowLibraryView.svelte');
		component = mount(WorkflowLibraryView, { target });
		await settle();
	}
	const press = async (label: string): Promise<void> => {
		const b = [...target.querySelectorAll<HTMLElement>('button')].find((x) => x.textContent?.trim() === label);
		expect(b, `the ${label} button`).toBeDefined();
		b!.click();
		await settle();
	};

	it('sets apart the name and the person of a workflow a person with access made, on the card', async () => {
		await library({ ...WF, runs_as: { person: MARK.person, ended: false } });
		expect(boxesIn(target.querySelector('[data-workflow-title]'))).toEqual([MARK.workflow]);
		expect(boxesIn(target.querySelector('[data-testid="runs-as-badge"]'))).toEqual([MARK.person]);
	});

	const again = async (wf: Record<string, unknown>): Promise<void> => {
		if (component) unmount(component);
		component = undefined;
		target.replaceChildren();
		await library(wf);
	};

	it('leaves the owner\'s own workflow unboxed, on the card and in the schedule dialog', async () => {
		await library({ ...WF, name: MARK.own });
		const title = target.querySelector('[data-workflow-title]');
		expect(title, 'the card title').not.toBeNull();
		expect(boxesIn(title)).toEqual([]);
		await press('Planen');
		const heading = target.querySelector('[data-schedule-title]');
		expect(heading, 'the schedule heading').not.toBeNull();
		expect(boxesIn(heading)).toEqual([]);
	});

	it('sets apart such a name, whole, in the run, schedule and step-review dialogs', async () => {
		const long = `${MARK.workflow} ${'x'.repeat(90)} Ende`;
		await library({ ...WF, name: long, runs_as: { person: MARK.person, ended: false }, parameters: [{ name: 'to', required: false }] });
		await press('Ausführen');
		expect(boxesIn(target.querySelector('[data-params-title]'))).toEqual([long]);
		await again({ ...WF, name: long, runs_as: { person: MARK.person, ended: false } });
		await press('Planen');
		const heading = target.querySelector('[data-schedule-title]');
		expect(boxesIn(heading)).toEqual([long]);
		expect(heading?.textContent).toBe(`Workflow planen: ${long}`);
		await again({ ...WF, name: long, runs_as: { person: MARK.person, ended: false }, awaitsStamp: true, confirmedAt: undefined });
		target.querySelector<HTMLElement>('[data-testid="stamp-review"]')!.click();
		await settle();
		const review = target.querySelector('[data-stamp-review-title]');
		expect(boxesIn(review)).toEqual([long]);
		expect(review?.textContent).toBe(`Schritte prüfen: ${long}`);
	});
});

describe('a profile in the API store', () => {
	async function store(profiles: Record<string, unknown>[], viewer = 'owner'): Promise<void> {
		resetSettingsViewer();
		vi.stubGlobal('fetch', vi.fn(async (input: string) => {
			const path = new URL(String(input), 'http://localhost').pathname.replace(/^\/api/, '');
			if (path === '/config') return json(200, { viewer, locks: {} });
			return json(200, { profiles, importWaiting: [] });
		}));
		const { default: ApiStoreView } = await import('./ApiStoreView.svelte');
		component = mount(ApiStoreView, { target });
		await settle();
	}
	const P = { base_url: 'https://x.example', description: 'd' };

	it('sets apart the address of whoever connected it and the account\'s label', async () => {
		const grant = { connected_by: `mandate:${MARK.helper}`, connected_by_reader: false, account: { label: MARK.account, source: 'oidc' } };
		await store([{ ...P, id: 'p0', name: 'CRM', oauth_grant: grant }]);
		const line = target.querySelector('[data-testid="api-connection"]');
		expect(line, 'the connection line').not.toBeNull();
		expect(boxesIn(line)).toEqual([MARK.helper, MARK.account]);
	});

	it('sets apart, for the owner, the name of a profile a person with access set up, and keeps it out of the delete dialog', async () => {
		await store([
			{ ...P, id: 'p0', name: MARK.workflow, created_by: `mandate:${MARK.helper}` },
			{ ...P, id: 'p1', name: MARK.own, created_by: 'owner' },
		]);
		const names = [...target.querySelectorAll('[data-profile-name]')];
		expect(names.map((n) => n.textContent)).toEqual([MARK.workflow, MARK.own]);
		expect(names.map((n) => boxesIn(n))).toEqual([[MARK.workflow], []]);
		const asked: string[] = [];
		vi.stubGlobal('confirm', (m: string) => { asked.push(m); return false; });
		for (const b of target.querySelectorAll<HTMLElement>('button')) if (b.getAttribute('aria-label') === 'Löschen' || b.textContent?.trim() === 'Löschen') b.click();
		await settle();
		expect(asked).toEqual(['Dieses API-Profil wirklich löschen?', `API-Profil "${MARK.own}" wirklich löschen?`]);
	});

	it('leaves the name unboxed in a member\'s view', async () => {
		await store([{ ...P, id: 'p0', name: MARK.workflow, created_by: `mandate:${MARK.helper}` }], 'mandate');
		const name = target.querySelector('[data-profile-name]');
		expect(name, 'the profile name').not.toBeNull();
		expect(boxesIn(name)).toEqual([]);
	});
});
