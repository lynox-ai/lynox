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

// The owner's takeover of a workflow whose person's access ended, from the library: where the button
// is, what the dialog shows and in which order, and what it sends.

let target: HTMLElement;
let component: Record<string, unknown> | undefined;
const localeBefore = getLocale();

const EVA = 'eva@kanzlei.example';
const JAN = 'jan@kanzlei.example';
const base = (id: string, name: string): Record<string, unknown> => ({
	id, name, description: '', step_count: 2, steps: [{ id: 's1', task: 'Read' }, { id: 's2', task: 'Call' }],
	parameters: [], created_at: '2026-10-29', mode: 'autonomous', schedulable: true, confirmedAt: '2026-10-29T00:00:00Z',
});
const step = (id: string, task: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
	id, task, tool: null, inputTemplate: null, tools: [], model: null, role: null, roleGrant: null, effort: null, thinking: null,
	timeoutMs: null, inputFrom: [], foreignConnection: false, connectionProfile: null, ...extra,
});

/** A preview with every part filled. */
const FULL = (): Record<string, unknown> => ({
	expect: 'digest-1', refusal: null,
	workflow: { id: 'wf-e', name: 'Ended one' },
	mode: 'autonomous', onFailure: 'continue', limits: null, contract: null,
	parameters: [{ name: 'recipient', required: false, default: 'someone@example.invalid' }],
	marks: [
		{ name: JAN, role: 'workflow-created', ended: false },
		{ name: EVA, role: 'workflow-edited', ended: true },
	],
	steps: [
		step('s1', 'Read the orders', { tool: 'http_request', inputTemplate: { url: 'https://shop.example.invalid/orders' }, foreignConnection: true, connectionProfile: 'shop' }),
		step('s2', 'Post the summary', { tool: 'http_request', inputTemplate: { url: 'https://chat.example.invalid/post' }, foreignConnection: true, connectionProfile: 'chat' }),
		step('s3', 'Write it up'),
	],
	connections: [{ profileId: 'shop', provider: 'Shop', account: 'Main store', by: EVA }],
	memberChanges: [{ id: 'p-c', title: 'Weekly', before: `mandate:${EVA}`, after: null, runsNoMore: false }],
	alsoReleased: [{ id: 'p-r', title: 'Daily' }],
	stillPaused: [{ id: 'p-s', title: 'Monthly' }],
	lapsing: [{ id: 'p-l', title: 'Hourly' }],
});

interface Served { posts: unknown[]; previews: number }

function serve(workflows: Array<Record<string, unknown>>, previews: Array<Record<string, unknown>>, post: { status: number; body: unknown } = { status: 200, body: { takenOver: true, runsAs: 'owner', stillOff: 0 } }): Served {
	const served: Served = { posts: [], previews: 0 };
	vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
		const path = new URL(String(input), 'http://localhost').pathname.replace(/^\/api/, '');
		const method = init?.method ?? 'GET';
		if (method === 'GET' && path === '/workflows/library') return new Response(JSON.stringify({ workflows, viewer: 'owner' }), { status: 200 });
		if (method === 'GET' && /^\/workflows\/[^/]+\/takeover-preview$/.test(path)) {
			const p = previews[Math.min(served.previews, previews.length - 1)]!;
			served.previews++;
			return new Response(JSON.stringify(p), { status: 200 });
		}
		if (method === 'POST' && /^\/workflows\/[^/]+\/takeover$/.test(path)) {
			served.posts.push(JSON.parse(String(init?.body ?? 'null')));
			return new Response(JSON.stringify(post.body), { status: post.status });
		}
		if (method === 'GET' && path === '/secrets/status') return new Response(JSON.stringify({ managed: null }), { status: 200 });
		return new Response('{}', { status: 404 });
	}));
	return served;
}

async function settle(): Promise<void> {
	for (let i = 0; i < 12; i++) {
		await new Promise((r) => setTimeout(r, 0));
		await tick();
		flushSync();
	}
}

async function open(workflows: Array<Record<string, unknown>>, previews: Array<Record<string, unknown>> = [FULL()], post?: { status: number; body: unknown }): Promise<Served> {
	const served = serve(workflows, previews, post);
	const { default: WorkflowLibraryView } = await import('./WorkflowLibraryView.svelte');
	component = mount(WorkflowLibraryView, { target });
	await settle();
	return served;
}

function card(name: string): HTMLElement {
	const c = [...target.querySelectorAll<HTMLElement>('div.group')].find((d) => d.querySelector('p')?.textContent?.trim() === name);
	expect(c, `the card of ${name}`).toBeDefined();
	return c!;
}
const openButton = (c: HTMLElement): HTMLButtonElement | null => c.querySelector<HTMLButtonElement>('[data-testid="takeover-open"]');
const dialog = (): HTMLElement | null => target.querySelector<HTMLElement>('[data-testid="takeover-dialog"]');

async function openDialog(): Promise<HTMLElement> {
	openButton(card('Ended one'))!.click();
	await settle();
	const d = dialog();
	expect(d, 'the takeover dialog').not.toBeNull();
	return d!;
}

const ENDED = { ...base('wf-e', 'Ended one'), runs_as: { person: EVA, ended: true, covered_by_takeover: 0 } };

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

describe('the button', () => {
	it('stands only at a workflow whose person\'s access ended: not at a live person\'s, not at the owner\'s own', async () => {
		await open([
			ENDED,
			{ ...base('wf-l', 'Live one'), runs_as: { person: JAN, ended: false } },
			base('wf-o', 'Own one'),
		]);
		expect(openButton(card('Ended one'))?.textContent?.trim()).toBe('Workflow übernehmen');
		expect(openButton(card('Live one'))).toBeNull();
		expect(openButton(card('Own one'))).toBeNull();
	});
});

describe('the dialog', () => {
	it('shows every part in the order of the design, the marks first and who may start it afterwards last', async () => {
		await open([ENDED]);
		const d = await openDialog();
		const parts = [...d.querySelectorAll<HTMLElement>('[data-takeover-part]')].map((e) => e.dataset['takeoverPart']);
		expect(parts).toEqual(['marks', 'intro', 'stamp', 'connection', 'member_change', 'lapsing', 'released', 'paused', 'afterwards']);
		const text = (part: string): string | undefined => d.querySelector<HTMLElement>(`[data-takeover-part="${part}"]`)?.textContent?.trim();
		expect(text('intro')).toBe('Übernimmst du den Workflow, gehört er dir, und „Ausführen“ läuft unter deinem Namen.');
		expect(text('connection')).toBe(`${EVA} hat Shop mit einem eigenen Konto verbunden (Main store). Nach dem Übernehmen nutzt der Workflow diese Verbindung nicht mehr. Braucht er sie, verbinde das Programm selbst mit deinem Konto: in den Einstellungen unter „APIs“ über „Neue API“. Sonst scheitern die markierten Schritte.`);
		expect(text('member_change')).toBe(`Der Plan „Weekly“ läuft danach unter deinem Namen statt unter dem von ${EVA}.`);
		expect(text('lapsing')).toBe('Beim Plan „Hourly“ gelten die freigegebenen Verbindungen danach nicht mehr. Gib sie unter Automation → Trigger mit „Verbindungen prüfen“ neu frei. Bis dahin scheitern seine Schritte, die eine Verbindung brauchen.');
		expect(text('paused')).toBe('Der Plan „Monthly“ ist pausiert und bleibt es. Soll er weiterlaufen, übernimm ihn einzeln unter „Trigger“ mit „Übernehmen“.');
		expect(text('afterwards')).toBe('Danach gehört der Workflow keiner Person mit Zugang mehr. Jede Person, die Zugang hat, kann ihn dann im Chat ausführen oder planen lassen, unter ihrem eigenen Namen. Macht sie eine Kopie davon, gehört die Kopie ihr.');
		// The stamp's own part: the fields beside the steps, and the steps.
		const stamp = d.querySelector<HTMLElement>('[data-takeover-part="stamp"]')!;
		expect(stamp.textContent).toContain('continue');
		expect(stamp.textContent).toContain('recipient = someone@example.invalid');
		expect(stamp.querySelectorAll('[data-testid="stamp-step"]').length).toBe(3);
		expect(d.querySelector('[data-testid="takeover-confirm"]')?.textContent?.trim()).toBe('Übernehmen und Schritte bestätigen');
	});

	it('marks a live person "still has access" and an ended one "access ended"', async () => {
		await open([ENDED]);
		const d = await openDialog();
		expect([...d.querySelectorAll('[data-testid="takeover-mark"]')].map((m) => m.textContent?.trim())).toEqual([
			`Angelegt von ${JAN} · hat weiter Zugang`,
			`Bearbeitet von ${EVA} · Zugang beendet`,
		]);
	});

	it('says of a mark without a grant that lynox cannot tell who', async () => {
		const p = FULL();
		p['marks'] = [{ name: EVA, role: 'workflow-created', ended: true, undetermined: true }];
		await open([ENDED], [p]);
		const d = await openDialog();
		expect(d.querySelector('[data-testid="takeover-mark"]')?.textContent?.trim()).toBe('Angelegt von einer Person mit Zugang; wer, kann lynox nicht feststellen.');
	});

	it('notes at a step on someone\'s connection whose connection it is: named where a listed connection is that profile, unnamed otherwise, none without one', async () => {
		await open([ENDED]);
		const d = await openDialog();
		const notes = [...d.querySelectorAll<HTMLElement>('[data-testid="stamp-step"]')].map((s) => s.querySelector('[data-testid="stamp-step-note"]')?.textContent?.trim() ?? null);
		expect(notes).toEqual([`Verbindung von ${EVA}`, 'Verbindung einer Person mit Zugang', null]);
	});

	it('says one released plan by its title, and several in one sentence', async () => {
		await open([ENDED]);
		const d = await openDialog();
		expect(d.querySelector('[data-takeover-part="released"]')?.textContent?.trim()).toBe('Dann läuft auch der Plan „Daily“ wieder.');
		if (component) unmount(component);
		component = undefined;
		target.replaceChildren();
		const p = FULL();
		p['alsoReleased'] = [{ id: 'a', title: 'Daily' }, { id: 'b', title: 'Nightly' }];
		await open([ENDED], [p]);
		const d2 = await openDialog();
		expect(d2.querySelector('[data-takeover-part="released"]')?.textContent?.trim()).toBe('Dann laufen auch diese Pläne wieder: Daily, Nightly.');
	});

	it('sends the digest it was shown, and once taken over closes and says so', async () => {
		const served = await open([ENDED]);
		const d = await openDialog();
		d.querySelector<HTMLButtonElement>('[data-testid="takeover-confirm"]')!.click();
		await settle();
		expect(served.posts).toEqual([{ expect: 'digest-1' }]);
		expect(dialog()).toBeNull();
		expect(target.textContent).toContain('Workflow übernommen. Er gehört jetzt dir, und „Ausführen“ läuft unter deinem Namen.');
	});

	it('when something shown moved, loads the preview again, says so above it, and sends the new digest next', async () => {
		const moved = FULL();
		moved['expect'] = 'digest-2';
		moved['stillPaused'] = [];
		const served = await open([ENDED], [FULL(), moved], { status: 409, body: { code: 'changed', error: 'engine sentence' } });
		const d = await openDialog();
		d.querySelector<HTMLButtonElement>('[data-testid="takeover-confirm"]')!.click();
		await settle();
		expect(served.previews).toBe(2);
		expect(d.querySelector('[data-testid="takeover-changed"]')?.textContent?.trim()).toBe('Der Workflow hat sich geändert, während du ihn angesehen hast. Unten steht der neue Stand. Prüf ihn und übernimm ihn dann.');
		expect(d.querySelector('[data-takeover-part="paused"]')).toBeNull();
		expect(d.textContent).not.toContain('engine sentence');
		d.querySelector<HTMLButtonElement>('[data-testid="takeover-confirm"]')!.click();
		await settle();
		expect(served.posts).toEqual([{ expect: 'digest-1' }, { expect: 'digest-2' }]);
	});

	it('words a refusal by its code: a stamp the engine refused, and a code it does not know keeps the engine\'s sentence', async () => {
		await open([ENDED], [FULL()], { status: 409, body: { code: 'stamp_refused', error: 'engine sentence' } });
		const d = await openDialog();
		d.querySelector<HTMLButtonElement>('[data-testid="takeover-confirm"]')!.click();
		await settle();
		expect(d.querySelector('[data-testid="takeover-error"]')?.textContent?.trim()).toBe('Die Schritte lassen sich gerade nicht so bestätigen, wie sie gezeigt wurden. Darum hat lynox den Workflow nicht übernommen. Versuch es in ein paar Minuten noch einmal.');
		if (component) unmount(component);
		component = undefined;
		target.replaceChildren();
		await open([ENDED], [FULL()], { status: 409, body: { code: 'running', error: 'engine sentence' } });
		const d2 = await openDialog();
		d2.querySelector<HTMLButtonElement>('[data-testid="takeover-confirm"]')!.click();
		await settle();
		expect(d2.querySelector('[data-testid="takeover-error"]')?.textContent?.trim()).toBe('engine sentence');
	});

	it('in English, the marks and the closing sentence', async () => {
		setLocale('en');
		await open([ENDED]);
		const d = await openDialog();
		expect(d.querySelector('[data-testid="takeover-mark"]')?.textContent?.trim()).toBe(`Created by ${JAN} · still has access`);
		expect(d.querySelector('[data-takeover-part="afterwards"]')?.textContent?.trim()).toBe('Afterwards the workflow no longer belongs to anyone you gave access to. Anyone who has access can then have it run or scheduled in the chat, under their own name. If they make a copy of it, the copy is theirs.');
	});
});
