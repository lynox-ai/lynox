import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { t, setLocale, getLocale } from '../i18n.svelte.js';

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

// The library says beforehand what a click would be refused (UX-053, UX-058; ux U-079, U-085, U-119):
// to the owner, a workflow whose person's access ended; to a mandate, a workflow not its to schedule.

let target: HTMLElement;
let component: Record<string, unknown> | undefined;
const localeBefore = getLocale();

const base = (id: string, name: string): Record<string, unknown> => ({
	id, name, description: '', step_count: 1, steps: [{ id: 'post', task: 'Send it' }],
	parameters: [], created_at: '2026-10-29', mode: 'autonomous', schedulable: true, confirmedAt: '2026-10-29T00:00:00Z',
});

function serve(viewer: 'owner' | 'mandate', workflows: Array<Record<string, unknown>>, schedule: { status: number; body: unknown } = { status: 201, body: {} }): void {
	vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
		const path = new URL(String(input), 'http://localhost').pathname.replace(/^\/api/, '');
		const method = init?.method ?? 'GET';
		if (method === 'GET' && path === '/workflows/library') return new Response(JSON.stringify({ workflows, viewer }), { status: 200 });
		if (method === 'POST' && path === '/tasks') return new Response(JSON.stringify(schedule.body), { status: schedule.status });
		return new Response('{}', { status: 404 });
	}));
}

async function settle(): Promise<void> {
	for (let i = 0; i < 10; i++) {
		await new Promise((r) => setTimeout(r, 0));
		await tick();
		flushSync();
	}
}

async function open(viewer: 'owner' | 'mandate', workflows: Array<Record<string, unknown>>, schedule?: { status: number; body: unknown }): Promise<void> {
	serve(viewer, workflows, schedule);
	const { default: WorkflowLibraryView } = await import('./WorkflowLibraryView.svelte');
	component = mount(WorkflowLibraryView, { target });
	await settle();
}

/** The card of the workflow named `name`. */
function card(name: string): HTMLElement {
	const c = [...target.querySelectorAll<HTMLElement>('div.group')].find((d) => d.querySelector('p')?.textContent?.trim() === name);
	expect(c, `the card of ${name}`).toBeDefined();
	return c!;
}
function button(c: HTMLElement, key: string): HTMLButtonElement | undefined {
	return [...c.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === t(key));
}
const note = (c: HTMLElement): string | undefined => c.querySelector<HTMLElement>('[data-library-note]')?.textContent?.trim();

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
	setLocale(localeBefore);
});

const EVA = 'eva@kanzlei.example';
const ENDED_A = `${EVA} hat diesen Workflow angelegt oder zuletzt geändert, und der Zugang dieser Person ist beendet. Darum lässt er sich nicht mehr ausführen, auch nicht als Kopie. Beschreib lynox im Chat in deinen eigenen Worten, was er tun soll, und bitte lynox, dafür einen neuen Workflow zu schreiben, statt diesen zu kopieren oder zu ändern. Ein neu geschriebener Workflow gehört dir und läuft unter dir.`;

describe('the owner\'s library, a workflow whose person\'s access ended (UX-053)', () => {
	it('marks it, turns off Run, Schedule and Edit, keeps Rename and Delete, and says why under the buttons', async () => {
		await open('owner', [
			{ ...base('wf-e', 'Ended one'), runs_as: { person: EVA, ended: true, covered_by_takeover: 0 } },
			{ ...base('wf-l', 'Live one'), runs_as: { person: 'jan@kanzlei.example', ended: false } },
		]);
		const ended = card('Ended one');
		expect(ended.querySelector('[data-testid="access-ended-badge"]')?.textContent?.trim()).toBe(`Zugang beendet: ${EVA}`);
		expect(ended.querySelector('[data-testid="runs-as-badge"]')).toBeNull();
		expect([button(ended, 'workflow_library.run')?.disabled, button(ended, 'workflow_library.schedule')?.disabled, button(ended, 'workflow_library.edit_in_chat')?.disabled]).toEqual([true, true, true]);
		expect([button(ended, 'workflow_library.rename')?.disabled, button(ended, 'workflow_library.delete')?.disabled]).toEqual([false, false]);
		expect(note(ended)).toBe(ENDED_A);
		// Twin in the same list: a live person's workflow keeps its mark and its buttons, with no sentence.
		const live = card('Live one');
		expect(live.querySelector('[data-testid="runs-as-badge"]')?.textContent?.trim()).toBe('Läuft als jan@kanzlei.example');
		expect(live.querySelector('[data-testid="access-ended-badge"]')).toBeNull();
		expect([button(live, 'workflow_library.run')?.disabled, button(live, 'workflow_library.schedule')?.disabled, button(live, 'workflow_library.edit_in_chat')?.disabled]).toEqual([false, false, false]);
		expect(note(live)).toBeUndefined();
	});

	it('the owner\'s own workflow is unchanged (control)', async () => {
		await open('owner', [base('wf-o', 'Own one')]);
		const own = card('Own one');
		expect(own.querySelector('[data-testid="access-ended-badge"]')).toBeNull();
		expect(button(own, 'workflow_library.run')?.disabled).toBe(false);
		expect(note(own)).toBeUndefined();
	});

	it('with paused plans whose takeover moves the workflow to the owner, names the way through them, counted', async () => {
		await open('owner', [
			{ ...base('wf-1', 'One plan'), runs_as: { person: EVA, ended: true, covered_by_takeover: 1 } },
			{ ...base('wf-2', 'Two plans'), runs_as: { person: EVA, ended: true, covered_by_takeover: 2 } },
		]);
		expect(note(card('One plan'))).toBe(`${EVA} hat diesen Workflow angelegt oder zuletzt geändert, und der Zugang dieser Person ist beendet. Ein Plan, der ihn ausführt, ist deshalb pausiert. Übernimmst du diesen Plan unter „Trigger“ mit „Übernehmen“, läuft danach auch dieser Workflow unter dir.`);
		expect(note(card('Two plans'))).toBe(`${EVA} hat diesen Workflow angelegt oder zuletzt geändert, und der Zugang dieser Person ist beendet. 2 Pläne, die ihn ausführen, sind deshalb pausiert. Übernimmst du einen davon unter „Trigger“ mit „Übernehmen“, läuft danach auch dieser Workflow unter dir.`);
	});

	it('without a name says "a person with access", in the mark and the sentence', async () => {
		await open('owner', [{ ...base('wf-u', 'Nameless'), runs_as: { person: '', ended: true, covered_by_takeover: 0 } }]);
		const c = card('Nameless');
		expect(c.querySelector('[data-testid="access-ended-badge"]')?.textContent?.trim()).toBe('Zugang beendet');
		expect(note(c)?.startsWith('Eine Person mit Zugang hat diesen Workflow angelegt oder zuletzt geändert, und ihr Zugang ist beendet. Darum')).toBe(true);
	});

	it('in English', async () => {
		setLocale('en');
		await open('owner', [{ ...base('wf-e', 'Ended one'), runs_as: { person: EVA, ended: true, covered_by_takeover: 1 } }]);
		const c = card('Ended one');
		expect(c.querySelector('[data-testid="access-ended-badge"]')?.textContent?.trim()).toBe(`Access ended: ${EVA}`);
		expect(note(c)).toBe(`${EVA} created or last changed this workflow, and their access has ended. One schedule that runs it is paused for that reason. If you take that schedule over under “Triggers” with “Take over”, this workflow runs under you afterwards too.`);
	});
});

const FOREIGN = 'Dieser Workflow enthält Schritte, die eine andere Person mit Zugang angelegt oder zuletzt geändert hat. So, wie er ist, lässt er sich deshalb nicht für dich planen. Willst du die Aufgabe selbst planen, beschreib lynox im Chat, was sie tun soll, und bitte lynox, dafür einen neuen Workflow zu schreiben, statt diesen zu kopieren oder zu ändern. Ein neu geschriebener Workflow gehört dir. Sonst bitte den Inhaber, diesen zu planen.';

describe('a mandate\'s library, a workflow not its to schedule (UX-058)', () => {
	it('turns off Schedule on another person\'s workflow and says why; its own stays as it was', async () => {
		await open('mandate', [
			{ ...base('wf-f', 'Foreign one'), schedule_refusal: 'foreign' },
			{ ...base('wf-u', 'Unreadable one'), schedule_refusal: 'unreadable' },
			base('wf-m', 'Mine'),
		]);
		const foreign = card('Foreign one');
		expect(button(foreign, 'workflow_library.schedule')?.disabled).toBe(true);
		expect(note(foreign)).toBe(FOREIGN);
		expect(note(card('Unreadable one'))).toBe('lynox konnte nicht lesen, wer diesen Workflow angelegt hat. Planen kann ihn deshalb nur der Inhaber. Bitte den Inhaber darum, oder beschreib lynox im Chat, was er tun soll, und bitte lynox, dafür einen neuen Workflow zu schreiben. Ein neu geschriebener Workflow gehört dir.');
		const mine = card('Mine');
		expect(button(mine, 'workflow_library.schedule')?.disabled).toBe(false);
		expect(note(mine)).toBeUndefined();
	});

	it('a workflow that cannot be scheduled anyway gets no sentence about scheduling', async () => {
		await open('mandate', [{ ...base('wf-f', 'Foreign one'), schedulable: false, mode: 'interactive', schedule_refusal: 'foreign' }]);
		const c = card('Foreign one');
		expect(button(c, 'workflow_library.schedule')).toBeUndefined();
		expect(note(c)).toBeUndefined();
	});
});

describe('a schedule refused after it was sent, in the reader\'s language (ux U-085, U-119)', () => {
	async function sendSchedule(body: unknown, status = 403): Promise<string> {
		await open('mandate', [base('wf-m', 'Mine')], { status, body });
		button(card('Mine'), 'workflow_library.schedule')!.click();
		await settle();
		const confirm = [...target.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === t('workflow_library.schedule_confirm'));
		expect(confirm, 'the dialog\'s confirm button').toBeDefined();
		confirm!.click();
		await settle();
		return target.textContent ?? '';
	}

	it('names another person\'s workflow by its code, not the engine\'s English', async () => {
		const text = await sendSchedule({ error: 'Not scheduled: engine sentence', code: 'foreign_workflow' });
		expect(text).toContain(`Nicht geplant: ${FOREIGN}`);
		expect(text).not.toContain('engine sentence');
	});

	it('an unreadable and a vanished workflow, each with its own sentence', async () => {
		expect(await sendSchedule({ error: 'engine sentence', code: 'unreadable_workflow' })).toContain('Nicht geplant: lynox konnte nicht lesen, wer diesen Workflow angelegt hat.');
		if (component) unmount(component);
		component = undefined;
		expect(await sendSchedule({ error: 'engine sentence', code: 'missing_workflow' }, 404)).toContain('Nicht geplant: lynox findet diesen Workflow nicht mehr unter den gespeicherten. Lade die Seite neu.');
	});

	it('CONTROL: a refusal without a known code still shows the engine\'s sentence', async () => {
		expect(await sendSchedule({ error: 'engine sentence' })).toContain('engine sentence');
	});
});
