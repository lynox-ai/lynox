import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { setLocale, getLocale, t } from '../i18n.svelte.js';

// A margin or a padding class of any side or axis, also behind variants (`sm:`, `hover:`) and `!`:
// `m`/`p` with one of `lrxytbse`, `bs` or `be`, or none. Not `max-w-`, `min-w-`, `place-`, `pointer-`.
const MARGIN_CLASS = /^(?:[^:\s]+:)*!?-?m(?:[lrxytbse]|bs|be)?-/;
const PADDING_CLASS = /^(?:[^:\s]+:)*!?-?p(?:[lrxytbse]|bs|be)?-/;

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
	// The mail connection is Eva's too, but no marked step uses it.
	connections: [
		{ profileId: 'shop', provider: 'Shop', account: 'Main store', by: EVA },
		{ profileId: 'mail', provider: 'Mail', account: null, by: EVA },
	],
	memberChanges: [{ id: 'p-c', title: 'Weekly', before: `mandate:${EVA}`, after: null, runsNoMore: false }],
	alsoReleased: [{ id: 'p-r', title: 'Daily' }],
	stillPaused: [{ id: 'p-s', title: 'Monthly' }],
	lapsing: [{ id: 'p-l', title: 'Hourly' }],
});

interface Served { posts: unknown[]; previews: number; lists: number }
let hosted: string | null = null;
// Set, a preview answers only once it is called: the dialog is seen while it loads.
let previewGate: Promise<void> | null = null;
// Set, the library's list answers only once it is called: the page is seen while it loads again.
let listGate: Promise<void> | null = null;
// What Run answers, when a test presses it.
let runAnswer: { status: number; body: unknown } = { status: 200, body: {} };

function serve(workflows: Array<Record<string, unknown>>, previews: Array<Record<string, unknown>>, post: { status: number; body: unknown } = { status: 200, body: { takenOver: true, runsAs: 'owner', stillOff: 0 } }): Served {
	const served: Served = { posts: [], previews: 0, lists: 0 };
	vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
		const path = new URL(String(input), 'http://localhost').pathname.replace(/^\/api/, '');
		const method = init?.method ?? 'GET';
		if (method === 'GET' && path === '/workflows/library') {
			served.lists++;
			if (listGate !== null) await listGate;
			return new Response(JSON.stringify({ workflows, viewer: 'owner' }), { status: 200 });
		}
		if (method === 'GET' && /^\/workflows\/[^/]+\/takeover-preview$/.test(path)) {
			const p = previews[Math.min(served.previews, previews.length - 1)]!;
			served.previews++;
			if (previewGate !== null) await previewGate;
			return new Response(JSON.stringify(p), { status: 200 });
		}
		if (method === 'POST' && /^\/workflows\/[^/]+\/takeover$/.test(path)) {
			served.posts.push(JSON.parse(String(init?.body ?? 'null')));
			return new Response(JSON.stringify(post.body), { status: post.status });
		}
		if (method === 'POST' && /^\/workflows\/[^/]+\/run$/.test(path)) return new Response(JSON.stringify(runAnswer.body), { status: runAnswer.status });
		if (method === 'GET' && path === '/secrets/status') return new Response(JSON.stringify({ managed: hosted }), { status: 200 });
		return new Response('{}', { status: 404 });
	}));
	return served;
}

function reset(): void {
	if (component) unmount(component);
	component = undefined;
	target.replaceChildren();
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

/**
 * Every text of `root` that names one of the `FX-` values: [the value, whether it sits inside a set-apart value].
 * The values are the fixture's own, so a value anywhere else in a sentence shows here as `false`.
 */
function foreignPlaces(root: Element): Array<[string, boolean]> {
	const out: Array<[string, boolean]> = [];
	const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	for (let n = walk.nextNode(); n !== null; n = walk.nextNode()) {
		const box = n.parentElement?.closest('bdi[data-foreign-value]') ?? null;
		for (const m of (n.textContent ?? '').matchAll(/FX-[a-z0-9]+/g)) {
			out.push([m[0], box !== null && /\bfont-mono\b|\bbg-bg-muted\b/.test(box.className)]);
		}
	}
	return out;
}


beforeEach(() => {
	hosted = null;
	previewGate = null;
	listGate = null;
	runAnswer = { status: 200, body: {} };
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

	it('at an ended workflow that also awaits its stamp, offers only the takeover', async () => {
		await open([
			{ ...ENDED, awaitsStamp: true },
			{ ...base('wf-l', 'Live one'), runs_as: { person: JAN, ended: false }, awaitsStamp: true },
		]);
		const ended = card('Ended one');
		expect(ended.querySelectorAll('[data-testid="takeover-open"]').length).toBe(1);
		expect(ended.querySelector('[data-testid="stamp-review"]')).toBeNull();
		// CONTROL: without the end, the stamp is offered as before.
		expect(card('Live one').querySelector('[data-testid="stamp-review"]')).not.toBeNull();
	});
});

describe('the dialog', () => {
	it('shows every part in the order of the design, the marks first and who may start it afterwards last', async () => {
		await open([ENDED]);
		const d = await openDialog();
		const parts = [...d.querySelectorAll<HTMLElement>('[data-takeover-part]')].map((e) => e.dataset['takeoverPart']);
		// One connection sentence: the mail connection no marked step uses gets none.
		expect(parts).toEqual(['marks', 'intro', 'stamp', 'connection', 'member_change', 'lapsing', 'released', 'paused', 'afterwards']);
		const text = (part: string): string | undefined => d.querySelector<HTMLElement>(`[data-takeover-part="${part}"]`)?.textContent?.trim();
		expect(text('intro')).toBe('Übernimmst du den Workflow, gehört er dir, und „Ausführen“ läuft unter deinem Namen.');
		expect(text('connection')).toBe(`${EVA} hat Shop mit einem eigenen Konto verbunden (Main store). Nach dem Übernehmen nutzt der Workflow diese Verbindung nicht mehr. Braucht er sie, verbinde das Programm selbst mit deinem Konto: in den Einstellungen unter „APIs“ über „Neue API“. Sonst scheitern die markierten Schritte.`);
		expect(text('member_change')).toBe(`Der Plan „Weekly“ läuft danach unter deinem Namen statt unter dem von ${EVA}.`);
		expect(text('lapsing')).toBe('Beim Plan „Hourly“ gelten die freigegebenen Verbindungen danach nicht mehr. Gib sie unter Automation → Trigger mit „Verbindungen prüfen“ neu frei. Bis dahin scheitern seine Schritte, die eine Verbindung brauchen.');
		expect(text('paused')).toBe('Der Plan „Monthly“ ist pausiert und bleibt es. Soll er weiterlaufen, übernimm ihn einzeln unter „Trigger“ mit „Übernehmen“.');
		expect(text('afterwards')).toBe('Danach gehört der Workflow keiner Person mit Zugang mehr. Jede Person, die Zugang hat, kann ihn dann im Chat ausführen oder planen lassen, unter ihrem eigenen Namen. Macht diese Person eine Kopie davon, gehört die Kopie ihr.');
		// The stamp's own part: the fields beside the steps, and the steps.
		const stamp = d.querySelector<HTMLElement>('[data-takeover-part="stamp"]')!;
		// The failure strategy by its name, not its stored value.
		expect(stamp.querySelector('[data-testid="stamp-on-failure"]')?.textContent?.trim()).toBe('Weitermachen');
		expect(stamp.textContent).not.toMatch(/\bcontinue\b/);
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

	it('after a change, exactly the step that changed is marked and takes the focus', async () => {
		const moved = FULL();
		moved['expect'] = 'digest-2';
		(moved['steps'] as Array<Record<string, unknown>>)[1]!['inputTemplate'] = { url: 'https://evil.example.invalid/post' };
		await open([ENDED], [FULL(), moved], { status: 409, body: { code: 'changed' } });
		const d = await openDialog();
		expect(d.querySelectorAll('[data-stamp-changed]')).toHaveLength(0);
		d.querySelector<HTMLButtonElement>('[data-testid="takeover-confirm"]')!.click();
		await settle();
		const stepEls = [...d.querySelectorAll<HTMLElement>('[data-testid="stamp-step"]')];
		expect(stepEls.map((s) => s.hasAttribute('data-stamp-changed'))).toEqual([false, true, false]);
		expect(d.querySelectorAll('[data-stamp-changed]')).toHaveLength(1);
		expect(document.activeElement).toBe(stepEls[1]);
	});

	it('a later refusal of another kind puts the focus back at the head, not on the old mark', async () => {
		const moved = FULL();
		moved['expect'] = 'digest-2';
		(moved['steps'] as Array<Record<string, unknown>>)[1]!['inputTemplate'] = { url: 'https://evil.example.invalid/post' };
		await open([ENDED], [FULL(), moved], { status: 409, body: { code: 'changed' } });
		const d = await openDialog();
		d.querySelector<HTMLButtonElement>('[data-testid="takeover-confirm"]')!.click();
		await settle();
		expect(d.querySelectorAll('[data-stamp-changed]')).toHaveLength(1);
		vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
		d.querySelector<HTMLButtonElement>('[data-testid="takeover-confirm"]')!.click();
		await settle();
		expect(d.querySelector('[data-testid="takeover-error"]')).not.toBeNull();
		expect(document.activeElement).toBe(d.querySelector('#workflow-takeover-title'));
	});

	it('a connection that changed hands marks the step that uses it', async () => {
		const moved = FULL();
		moved['expect'] = 'digest-2';
		(moved['connections'] as Array<Record<string, unknown>>)[0]!['by'] = JAN;
		await open([ENDED], [FULL(), moved], { status: 409, body: { code: 'changed' } });
		const d = await openDialog();
		d.querySelector<HTMLButtonElement>('[data-testid="takeover-confirm"]')!.click();
		await settle();
		const stepEls = [...d.querySelectorAll<HTMLElement>('[data-testid="stamp-step"]')];
		expect(stepEls.map((s) => s.hasAttribute('data-stamp-changed'))).toEqual([true, false, false]);
	});

	it('a change outside the stamp part marks nothing in it, and the focus stays at the head', async () => {
		const moved = FULL();
		moved['expect'] = 'digest-2';
		moved['stillPaused'] = [];
		await open([ENDED], [FULL(), moved], { status: 409, body: { code: 'changed' } });
		const d = await openDialog();
		d.querySelector<HTMLButtonElement>('[data-testid="takeover-confirm"]')!.click();
		await settle();
		expect(d.querySelectorAll('[data-stamp-changed]')).toHaveLength(0);
		expect(document.activeElement).toBe(d.querySelector('#workflow-takeover-title'));
	});

	it('the open dialog given another workflow shows that one without the marks of the last', async () => {
		const moved = FULL();
		moved['expect'] = 'digest-2';
		(moved['steps'] as Array<Record<string, unknown>>)[1]!['inputTemplate'] = { url: 'https://evil.example.invalid/post' };
		const other = FULL();
		other['expect'] = 'digest-3';
		other['workflow'] = { id: 'wf-f', name: 'Ended two' };
		const TWO = { ...base('wf-f', 'Ended two'), runs_as: { person: EVA, ended: true, covered_by_takeover: 0 } };
		const served = await open([ENDED, TWO], [FULL(), moved, other], { status: 409, body: { code: 'changed' } });
		const d = await openDialog();
		d.querySelector<HTMLButtonElement>('[data-testid="takeover-confirm"]')!.click();
		await settle();
		expect(d.querySelectorAll('[data-stamp-changed]')).toHaveLength(1);
		// The same dialog stays mounted and loads the other workflow.
		openButton(card('Ended two'))!.click();
		await settle();
		expect(served.previews).toBe(3);
		expect(dialog()).toBe(d);
		expect(d.querySelectorAll('[data-testid="stamp-step"]')).toHaveLength(3);
		expect(d.querySelectorAll('[data-stamp-changed]')).toHaveLength(0);
	});

	it('a stamp the engine refused reloads like a change, and says so above the new state', async () => {
		const moved = FULL();
		moved['expect'] = 'digest-2';
		const served = await open([ENDED], [FULL(), moved], { status: 409, body: { code: 'stamp_refused', error: 'engine sentence' } });
		const d = await openDialog();
		d.querySelector<HTMLButtonElement>('[data-testid="takeover-confirm"]')!.click();
		await settle();
		expect(served.previews).toBe(2);
		expect(d.querySelector('[data-testid="takeover-changed"]')?.textContent?.trim()).toBe('Der Workflow hat sich beim Übernehmen geändert. Darum hat lynox ihn nicht übernommen. Unten steht der neue Stand. Prüf ihn und übernimm ihn dann.');
		expect(d.querySelector('[data-testid="takeover-error"]')).toBeNull();
	});

	it('words a refusal by its code, and a code it does not know keeps the engine\'s sentence', async () => {
		await open([ENDED], [FULL()], { status: 409, body: { code: 'running', error: 'engine sentence' } });
		let d = await openDialog();
		d.querySelector<HTMLButtonElement>('[data-testid="takeover-confirm"]')!.click();
		await settle();
		expect(d.querySelector('[data-testid="takeover-error"]')?.textContent?.trim()).toBe('Ein Lauf eines Plans auf diesem Workflow ist noch nicht zu Ende. Versuch es in ein paar Minuten noch einmal.');
		reset();
		await open([ENDED], [FULL()], { status: 409, body: { code: 'not_a_code', error: 'engine sentence' } });
		d = await openDialog();
		d.querySelector<HTMLButtonElement>('[data-testid="takeover-confirm"]')!.click();
		await settle();
		expect(d.querySelector('[data-testid="takeover-error"]')?.textContent?.trim()).toBe('engine sentence');
	});

	it('names support under a lasting refusal where lynox hosts the instance, and only there', async () => {
		hosted = 'managed';
		await open([ENDED], [FULL()], { status: 503, body: { code: 'prompts', error: 'engine sentence' } });
		let d = await openDialog();
		d.querySelector<HTMLButtonElement>('[data-testid="takeover-confirm"]')!.click();
		await settle();
		const prompts = 'lynox kann die offenen Fragen der Pläne, die danach wieder laufen sollen, gerade nicht schliessen. Darum hat lynox den Workflow nicht übernommen. Versuch es in ein paar Minuten noch einmal.';
		expect(d.querySelector('[data-testid="takeover-error"]')?.textContent?.trim()).toBe(`${prompts} ${t('takeover.refused.support')}`);
		reset();
		hosted = null;
		await open([ENDED], [FULL()], { status: 503, body: { code: 'prompts', error: 'engine sentence' } });
		d = await openDialog();
		d.querySelector<HTMLButtonElement>('[data-testid="takeover-confirm"]')!.click();
		await settle();
		expect(d.querySelector('[data-testid="takeover-error"]')?.textContent?.trim()).toBe(prompts);
	});

	it('a takeover that cannot be recorded names support where lynox hosts the instance', async () => {
		hosted = 'managed';
		await open([ENDED], [FULL()], { status: 503, body: { code: 'unrecorded', error: 'engine sentence' } });
		const d = await openDialog();
		d.querySelector<HTMLButtonElement>('[data-testid="takeover-confirm"]')!.click();
		await settle();
		expect(d.querySelector('[data-testid="takeover-error"]')?.textContent?.trim()).toBe(`Die Übernahme lässt sich gerade nicht im Instanz-Protokoll festhalten. Darum hat lynox den Workflow nicht übernommen. Versuch es in ein paar Minuten noch einmal. ${t('takeover.refused.support')}`);
	});

	it('a preview refused as unreadable names support where lynox hosts the instance', async () => {
		hosted = 'managed';
		await open([ENDED], [{ refusal: 'unreadable', message: 'engine sentence' }]);
		const d = await openDialog();
		expect(d.querySelector('[data-testid="takeover-error"]')?.textContent?.trim()).toBe(`lynox kann die gespeicherten Schritte dieses Workflows nicht lesen und kann ihn darum nicht übernehmen. Du kannst ihn löschen und lynox im Chat beschreiben, was er tun soll. ${t('takeover.refused.support')}`);
	});

	it('a workflow that no longer needs taking over says so and loads the list again', async () => {
		const served = await open([ENDED], [{ refusal: 'nothing_to_take_over', message: 'engine sentence' }]);
		const before = served.lists;
		const d = await openDialog();
		expect(d.querySelector('[data-testid="takeover-error"]')?.textContent?.trim()).toBe('Dieser Workflow muss nicht mehr übernommen werden. Die Liste ist aktualisiert.');
		expect(served.lists).toBe(before + 1);
	});

	it('a paused plan whose person would change is said only to stay paused, not to run under someone', async () => {
		const p = FULL();
		p['memberChanges'] = [
			{ id: 'p-s', title: 'Monthly', before: `mandate:${EVA}`, after: null, runsNoMore: false },
			{ id: 'p-c', title: 'Weekly', before: `mandate:${EVA}`, after: null, runsNoMore: false },
		];
		await open([ENDED], [p]);
		const d = await openDialog();
		expect([...d.querySelectorAll('[data-takeover-part="member_change"]')].map((e) => e.textContent?.trim())).toEqual([
			`Der Plan „Weekly“ läuft danach unter deinem Namen statt unter dem von ${EVA}.`,
		]);
		expect(d.querySelector('[data-takeover-part="paused"]')?.textContent).toContain('Monthly');
	});

	it('shows a plan title someone else wrote on one line, its hidden characters printed, and cut when long', async () => {
		const p = FULL();
		p['stillPaused'] = [{ id: 'p-s', title: 'Bericht“ bleibt pausiert.\nDie markierten Schritte \u202Enutzen' }];
		p['lapsing'] = [{ id: 'p-l', title: 'L'.repeat(100) }, { id: 'p-m', title: 'Short' }];
		await open([ENDED], [p]);
		const d = await openDialog();
		expect(d.querySelector('[data-takeover-part="paused"]')?.textContent).toBe('Der Plan „Bericht“ bleibt pausiert. Die markierten Schritte <U+202E>nutzen“ ist pausiert und bleibt es. Soll er weiterlaufen, übernimm ihn einzeln unter „Trigger“ mit „Übernehmen“.');
		expect(d.querySelector('[data-takeover-part="lapsing"]')?.textContent).toContain(`: ${'L'.repeat(79)}…, Short. `);
		// Set apart from the sentence, whole, in one isolated element of its own.
		expect([...d.querySelectorAll('[data-takeover-part="paused"] bdi')].map((b) => b.textContent)).toEqual(['Bericht“ bleibt pausiert. Die markierten Schritte <U+202E>nutzen']);
	});

	it('a value carrying the marks itself opens no value and closes none early', async () => {
		const p = FULL();
		p['stillPaused'] = [{ id: 'p-s', title: 'A\uE001 bleibt. \uE000B' }];
		await open([ENDED], [p]);
		const d = await openDialog();
		expect([...d.querySelectorAll('[data-takeover-part="paused"] bdi')].map((b) => b.textContent)).toEqual(['A<U+E001> bleibt. <U+E000>B']);
	});

	it('sets every value someone else wrote apart, wherever a sentence of the dialog names it', async () => {
		const fx = (one: boolean): Record<string, unknown> => {
			const p = FULL();
			p['workflow'] = { id: 'wf-e', name: 'FX-wfname' };
			p['marks'] = [{ name: 'FX-markone', role: 'workflow-created', ended: false }, { name: 'FX-marktwo', role: 'workflow-edited', ended: true }];
			p['connections'] = [{ profileId: 'shop', provider: 'FX-provider', account: 'FX-account', by: 'FX-by' }];
			p['memberChanges'] = [
				{ id: 'p-c', title: 'FX-mcone', before: 'mandate:FX-before', after: 'mandate:FX-after', runsNoMore: false },
				{ id: 'p-d', title: 'FX-mctwo', before: 'mandate:FX-beforetwo', after: null, runsNoMore: false },
			];
			p['alsoReleased'] = one ? [{ id: 'p-r', title: 'FX-rel' }] : [{ id: 'p-r', title: 'FX-rel' }, { id: 'p-q', title: 'FX-reltwo' }];
			p['stillPaused'] = one ? [{ id: 'p-s', title: 'FX-paused' }] : [{ id: 'p-s', title: 'FX-paused' }, { id: 'p-t', title: 'FX-pausedtwo' }];
			p['lapsing'] = one ? [{ id: 'p-l', title: 'FX-lapse' }] : [{ id: 'p-l', title: 'FX-lapse' }, { id: 'p-m', title: 'FX-lapsetwo' }];
			return p;
		};
		const expected = ['FX-wfname', 'FX-markone', 'FX-marktwo', 'FX-by', 'FX-provider', 'FX-account', 'FX-mcone', 'FX-before', 'FX-after', 'FX-mctwo', 'FX-beforetwo', 'FX-rel', 'FX-paused', 'FX-lapse'];
		for (const one of [true, false]) {
			reset();
			await open([ENDED], [fx(one)]);
			const d = await openDialog();
			const places = foreignPlaces(d);
			const want = one ? expected : [...expected, 'FX-reltwo', 'FX-pausedtwo', 'FX-lapsetwo'];
			expect([...new Set(places.map(([v]) => v))].sort()).toEqual([...want].sort());
			expect(places.filter(([, apart]) => !apart)).toEqual([]);
		}
	});

	it('sets apart the plan and the person in the sentences of plans released to the owner, and the plan whose connections lapse after them', async () => {
		const owner = (id: string, title: string): Record<string, unknown> => ({ id, title, before: 'mandate:FX-ownerperson', after: null, runsNoMore: false });
		const boxes = (d: HTMLElement, kind: string): string[][] => [...d.querySelectorAll(`[data-takeover-part="${kind}"]`)].map((e) => [...e.querySelectorAll('bdi[data-foreign-value]')].map((b) => b.textContent ?? ''));
		// One plan to the owner; two others run again, one of which lapses: the sentence after names it.
		const one = FULL();
		one['alsoReleased'] = [{ id: 'p-o', title: 'FX-ownone' }, { id: 'p-x', title: 'FX-relx' }, { id: 'p-y', title: 'FX-rely' }];
		one['memberChanges'] = [owner('p-o', 'FX-ownone')];
		one['lapsing'] = [{ id: 'p-x', title: 'FX-relx' }];
		await open([ENDED], [one]);
		let d = await openDialog();
		expect(boxes(d, 'released')).toEqual([['FX-ownone', 'FX-ownerperson'], ['FX-relx', 'FX-rely']]);
		expect(boxes(d, 'lapsing')).toEqual([['FX-relx']]);
		expect(foreignPlaces(d).filter(([, apart]) => !apart)).toEqual([]);
		// Two plans to the owner, under the same person: one sentence names both and the person.
		reset();
		const many = FULL();
		many['alsoReleased'] = [{ id: 'p-o', title: 'FX-ownone' }, { id: 'p-p', title: 'FX-owntwo' }];
		many['memberChanges'] = [owner('p-o', 'FX-ownone'), owner('p-p', 'FX-owntwo')];
		await open([ENDED], [many]);
		d = await openDialog();
		expect(boxes(d, 'released')).toEqual([['FX-ownerperson', 'FX-ownone', 'FX-owntwo']]);
		expect(foreignPlaces(d).filter(([, apart]) => !apart)).toEqual([]);
		// Two plans run again and both lapse: the sentence after names both.
		reset();
		const both = FULL();
		both['alsoReleased'] = [{ id: 'p-x', title: 'FX-relx' }, { id: 'p-y', title: 'FX-rely' }];
		both['memberChanges'] = [];
		both['lapsing'] = [{ id: 'p-x', title: 'FX-relx' }, { id: 'p-y', title: 'FX-rely' }];
		await open([ENDED], [both]);
		d = await openDialog();
		expect(boxes(d, 'lapsing')).toEqual([['FX-relx', 'FX-rely']]);
		// It is the sentence that follows the released one, not the stand-alone lapsing sentence.
		const parts = [...d.querySelectorAll('[data-takeover-part]')];
		const lapsingAt = parts.findIndex((e) => e.getAttribute('data-takeover-part') === 'lapsing');
		expect(parts[lapsingAt - 1]?.getAttribute('data-takeover-part')).toBe('released');
		expect(parts[lapsingAt]!.textContent).toMatch(new RegExp(`^${t('workflow_library.takeover.lapsing_after_many').split('{plans}')[0]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
		expect(foreignPlaces(d).filter(([, apart]) => !apart)).toEqual([]);
	});

	it('the dialog\'s name, read from its heading, carries no mark', async () => {
		await open([ENDED]);
		const d = await openDialog();
		const heading = document.getElementById(d.getAttribute('aria-labelledby')!)!;
		expect(heading.textContent).toBe('Workflow übernehmen: Ended one');
		expect(heading.querySelector('bdi[data-foreign-value]')?.textContent).toBe('Ended one');
	});

	it('no text in the dialog shows a mark', async () => {
		await open([ENDED]);
		const d = await openDialog();
		expect(d.querySelectorAll('bdi[data-foreign-value]').length).toBeGreaterThan(0);
		expect(/[\uE000\uE001]/.test(d.textContent ?? '')).toBe(false);
		expect([...d.querySelectorAll('*')].some((e) => [...e.attributes].some((a) => /[\uE000\uE001]/.test(a.value)))).toBe(false);
	});

	it('says a plan that runs again under the owner\'s name once, in one sentence, and every plan once', async () => {
		const p = FULL();
		p['alsoReleased'] = [{ id: 'p-r', title: 'Daily' }, { id: 'p-n', title: 'Nightly' }, { id: 'p-q', title: 'Quarterly' }];
		p['memberChanges'] = [
			{ id: 'p-r', title: 'Daily', before: `mandate:${EVA}`, after: null, runsNoMore: false },
			{ id: 'p-n', title: 'Nightly', before: `mandate:${EVA}`, after: null, runsNoMore: false },
			{ id: 'p-c', title: 'Weekly', before: `mandate:${EVA}`, after: null, runsNoMore: false },
		];
		p['lapsing'] = [{ id: 'p-r', title: 'Daily' }];
		await open([ENDED], [p]);
		const d = await openDialog();
		const said = (kind: string): string[] => [...d.querySelectorAll(`[data-takeover-part="${kind}"]`)].map((e) => e.textContent ?? '');
		expect(said('released')).toEqual([
			`Diese Pläne laufen danach wieder, unter deinem Namen statt unter dem von ${EVA}: Daily, Nightly.`,
			'Dann läuft auch der Plan „Quarterly“ wieder.',
		]);
		expect(said('member_change')).toEqual([`Der Plan „Weekly“ läuft danach unter deinem Namen statt unter dem von ${EVA}.`]);
		// Every plan once, outside the sentence that its allowed connections lapse.
		const outside = [...d.querySelectorAll('[data-takeover-part]')].filter((e) => e.getAttribute('data-takeover-part') !== 'lapsing').map((e) => e.textContent ?? '').join(' ');
		for (const title of ['Daily', 'Nightly', 'Quarterly', 'Weekly', 'Monthly']) expect(outside.split(title).length - 1, title).toBe(1);
	});

	it('says that a released plan\'s connections lapse right after the sentence that names it', async () => {
		const p = FULL();
		p['alsoReleased'] = [{ id: 'p-r', title: 'Daily' }, { id: 'p-n', title: 'Nightly' }, { id: 'p-q', title: 'Quarterly' }];
		p['memberChanges'] = [
			{ id: 'p-r', title: 'Daily', before: `mandate:${EVA}`, after: null, runsNoMore: false },
			{ id: 'p-n', title: 'Nightly', before: `mandate:${EVA}`, after: null, runsNoMore: false },
		];
		p['lapsing'] = [{ id: 'p-l', title: 'Hourly' }, { id: 'p-r', title: 'Daily' }, { id: 'p-q', title: 'Quarterly' }];
		await open([ENDED], [p]);
		const d = await openDialog();
		const parts = [...d.querySelectorAll('[data-takeover-part="lapsing"], [data-takeover-part="released"]')].map((e) => e.textContent?.trim() ?? '');
		expect(parts).toEqual([
			'Beim Plan „Hourly“ gelten die freigegebenen Verbindungen danach nicht mehr. Gib sie unter Automation → Trigger mit „Verbindungen prüfen“ neu frei. Bis dahin scheitern seine Schritte, die eine Verbindung brauchen.',
			`Diese Pläne laufen danach wieder, unter deinem Namen statt unter dem von ${EVA}: Daily, Nightly.`,
			'Dabei verfallen beim Plan „Daily“ die bisher freigegebenen Verbindungen. Bis du sie unter Automation → Trigger mit „Verbindungen prüfen“ neu freigibst, scheitern seine Schritte, die eine Verbindung brauchen.',
			'Dann läuft auch der Plan „Quarterly“ wieder.',
			'Dabei verfallen seine bisher freigegebenen Verbindungen. Bis du sie unter Automation → Trigger mit „Verbindungen prüfen“ neu freigibst, scheitern seine Schritte, die eine Verbindung brauchen.',
		]);
	});

	it('says that several released plans\' connections lapse in one sentence after theirs', async () => {
		const p = FULL();
		p['alsoReleased'] = [{ id: 'p-r', title: 'Daily' }, { id: 'p-n', title: 'Nightly' }];
		p['lapsing'] = [{ id: 'p-r', title: 'Daily' }, { id: 'p-n', title: 'Nightly' }];
		await open([ENDED], [p]);
		const d = await openDialog();
		const parts = [...d.querySelectorAll('[data-takeover-part="lapsing"], [data-takeover-part="released"]')].map((e) => e.textContent?.trim() ?? '');
		expect(parts).toEqual([
			'Dann laufen auch diese Pläne wieder: Daily, Nightly.',
			'Dabei verfallen bei diesen Plänen die bisher freigegebenen Verbindungen: Daily, Nightly. Bis du sie je Plan unter Automation → Trigger mit „Verbindungen prüfen“ neu freigibst, scheitern ihre Schritte, die eine Verbindung brauchen.',
		]);
	});

	it('says one plan that runs again under the owner\'s name in one sentence', async () => {
		const p = FULL();
		p['alsoReleased'] = [{ id: 'p-r', title: 'Daily' }];
		p['memberChanges'] = [{ id: 'p-r', title: 'Daily', before: `mandate:${EVA}`, after: null, runsNoMore: false }];
		await open([ENDED], [p]);
		const d = await openDialog();
		expect([...d.querySelectorAll('[data-takeover-part="released"]')].map((e) => e.textContent)).toEqual([`Der Plan „Daily“ läuft danach wieder, unter deinem Namen statt unter dem von ${EVA}.`]);
		expect(d.querySelector('[data-takeover-part="member_change"]')).toBeNull();
	});

	it('says a connection only where a marked step uses it', async () => {
		await open([ENDED]);
		const d = await openDialog();
		const lines = [...d.querySelectorAll<HTMLElement>('[data-takeover-part="connection"]')].map((e) => e.textContent ?? '');
		expect(lines.length).toBe(1);
		expect(lines[0]).toContain(' Shop ');
		expect(lines.join(' ')).not.toContain('Mail');
	});

	it('after the takeover, says how many plans it switched off', async () => {
		await open([ENDED], [FULL()], { status: 200, body: { takenOver: true, runsAs: 'owner', stillOff: 2 } });
		const d = await openDialog();
		d.querySelector<HTMLButtonElement>('[data-testid="takeover-confirm"]')!.click();
		await settle();
		expect(target.querySelector('[data-testid="stamp-once"]')?.textContent?.trim()).toBe('2 Pläne warteten auf diese Bestätigung und sind jetzt ausgeschaltet. Schalte sie unter Automation → Trigger wieder ein.');
	});

	it('in English, the marks and the closing sentence', async () => {
		setLocale('en');
		await open([ENDED]);
		const d = await openDialog();
		expect([...d.querySelectorAll('[data-testid="takeover-mark"]')].map((m) => m.textContent?.trim())).toEqual([`Created by ${JAN} · still has access`, `Edited by ${EVA} · access ended`]);
		expect(d.querySelector('[data-takeover-part="afterwards"]')?.textContent?.trim()).toBe('Afterwards the workflow no longer belongs to anyone you gave access to. Anyone who has access can then have it run or scheduled in the chat, under their own name. If that person makes a copy of it, the copy is theirs.');
	});
});

describe('the dialog for keyboard and screen reader', () => {
	it('focuses its heading on opening, closes on Escape, and gives focus back to the button that opened it', async () => {
		await open([ENDED]);
		const opener = openButton(card('Ended one'))!;
		opener.focus();
		const d = await openDialog();
		expect(document.activeElement?.id).toBe('workflow-takeover-title');
		document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		await settle();
		expect(dialog()).toBeNull();
		expect(document.activeElement).toBe(openButton(card('Ended one')));
		expect(d.isConnected).toBe(false);
	});

	it('keeps Tab inside: from the last button to the first, and back', async () => {
		await open([ENDED]);
		const d = await openDialog();
		const buttons = [...d.querySelectorAll<HTMLButtonElement>('button:not([disabled])')];
		const last = buttons[buttons.length - 1]!;
		last.focus();
		last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
		expect(document.activeElement).toBe(buttons[0]);
		buttons[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
		expect(document.activeElement).toBe(last);
	});

	it('announces a refusal as an alert, and is busy while it sends', async () => {
		let release: (() => void) | undefined;
		await open([ENDED], [FULL()], { status: 409, body: { code: 'running', error: 'engine sentence' } });
		const inner = globalThis.fetch;
		vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
			if (init?.method === 'POST') await new Promise<void>((r) => { release = r; });
			return inner(input, init);
		}));
		const d = await openDialog();
		d.querySelector<HTMLButtonElement>('[data-testid="takeover-confirm"]')!.click();
		await settle();
		expect(d.getAttribute('aria-busy')).toBe('true');
		release!();
		await settle();
		expect(d.getAttribute('aria-busy')).toBe('false');
		expect(d.querySelector('[data-testid="takeover-error"]')?.getAttribute('role')).toBe('alert');
	});

	it('keeps Tab inside also from the page, where focus falls when what held it goes away', async () => {
		await open([ENDED]);
		const d = await openDialog();
		(document.activeElement as HTMLElement | null)?.blur();
		expect(document.activeElement).toBe(document.body);
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
		expect(d.contains(document.activeElement)).toBe(true);
	});

	it('after a refusal, focus is on the dialog\'s heading, not on the page behind it', async () => {
		await open([ENDED], [FULL()], { status: 409, body: { code: 'running', error: 'engine sentence' } });
		const d = await openDialog();
		d.querySelector<HTMLButtonElement>('[data-testid="takeover-confirm"]')!.focus();
		d.querySelector<HTMLButtonElement>('[data-testid="takeover-confirm"]')!.click();
		await settle();
		expect(document.activeElement?.id).toBe('workflow-takeover-title');
	});

	it('leaves Escape and Tab to an element outside it that has the focus, such as an overlay above it', async () => {
		await open([ENDED]);
		await openDialog();
		const overlay = document.createElement('input');
		document.body.appendChild(overlay);
		try {
			overlay.focus();
			overlay.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
			expect(document.activeElement).toBe(overlay);
			overlay.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
			await settle();
			expect(dialog()).not.toBeNull();
		} finally {
			overlay.remove();
		}
	});

	it('is busy while it loads, and names the workflow: from the list while loading, from the preview once loaded', async () => {
		const p = FULL();
		p['workflow'] = { id: 'wf-e', name: 'Ended, renamed' };
		let let_go: (() => void) | undefined;
		previewGate = new Promise<void>((r) => { let_go = r; });
		await open([ENDED], [p]);
		const d = await openDialog();
		expect(d.getAttribute('aria-busy')).toBe('true');
		expect(d.querySelector('h2')?.textContent?.trim()).toBe('Workflow übernehmen: Ended one');
		let_go!();
		await settle();
		expect(d.getAttribute('aria-busy')).toBe('false');
		expect(d.querySelector('h2')?.textContent?.trim()).toBe('Workflow übernehmen: Ended, renamed');
	});

	it('once taken over and the button that opened it is gone, focus goes to the library\'s heading', async () => {
		const wf: Record<string, unknown> = { ...ENDED };
		await open([wf]);
		await openDialog();
		const h1 = target.querySelector('h1')!;
		// The list loaded again shows the workflow taken over: no button to take it over.
		delete wf['runs_as'];
		dialog()!.querySelector<HTMLButtonElement>('[data-testid="takeover-confirm"]')!.click();
		await settle();
		expect(dialog()).toBeNull();
		expect(openButton(card('Ended one'))).toBeNull();
		expect(document.activeElement).toBe(h1);
	});

	it('once taken over, focus goes back to the button that opened it where the list loaded again still has it', async () => {
		await open([ENDED]);
		await openDialog();
		dialog()!.querySelector<HTMLButtonElement>('[data-testid="takeover-confirm"]')!.click();
		await settle();
		expect(dialog()).toBeNull();
		expect(document.activeElement).toBe(openButton(card('Ended one')));
	});

	it('once taken over, a field focused while the list loads again keeps the focus', async () => {
		await open([ENDED]);
		await openDialog();
		let let_go: (() => void) | undefined;
		listGate = new Promise<void>((r) => { let_go = r; });
		dialog()!.querySelector<HTMLButtonElement>('[data-testid="takeover-confirm"]')!.click();
		await settle();
		expect(dialog()).toBeNull();
		const field = document.createElement('input');
		document.body.appendChild(field);
		try {
			field.focus();
			let_go!();
			await settle();
			expect(document.activeElement).toBe(field);
		} finally {
			field.remove();
		}
	});

	it('a refusal leaves the focus where it went outside the dialog while the takeover was sent', async () => {
		let release: (() => void) | undefined;
		await open([ENDED], [FULL()], { status: 409, body: { code: 'running', error: 'engine sentence' } });
		const inner = globalThis.fetch;
		vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
			if (init?.method === 'POST') await new Promise<void>((r) => { release = r; });
			return inner(input, init);
		}));
		const d = await openDialog();
		d.querySelector<HTMLButtonElement>('[data-testid="takeover-confirm"]')!.click();
		await settle();
		const overlay = document.createElement('input');
		document.body.appendChild(overlay);
		try {
			overlay.focus();
			release!();
			await settle();
			expect(d.querySelector('[data-testid="takeover-error"]')).not.toBeNull();
			expect(document.activeElement).toBe(overlay);
		} finally {
			overlay.remove();
		}
	});

	it('a workflow that needed no takeover any more: once closed, focus goes to the library\'s heading', async () => {
		const wf: Record<string, unknown> = { ...ENDED };
		const served = serve([wf], [FULL()], { status: 409, body: { code: 'nothing_to_take_over', error: 'engine sentence' } });
		const { default: WorkflowLibraryView } = await import('./WorkflowLibraryView.svelte');
		component = mount(WorkflowLibraryView, { target });
		await settle();
		const d = await openDialog();
		// The list loaded again now shows the workflow as taken over: the button that opened it goes.
		delete wf['runs_as'];
		const before = served.lists;
		d.querySelector<HTMLButtonElement>('[data-testid="takeover-confirm"]')!.click();
		await settle();
		expect(served.lists).toBe(before + 1);
		expect(d.querySelector('[data-testid="takeover-error"]')?.textContent?.trim()).toBe('Dieser Workflow muss nicht mehr übernommen werden. Die Liste ist aktualisiert.');
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
		await settle();
		expect(dialog()).toBeNull();
		expect(document.activeElement).toBe(target.querySelector('h1'));
	});
});

describe('the library\'s own sentences', () => {
	it('at a mark whose person cannot be told, names no one: neither in the note nor after a refused run', async () => {
		const wf: Record<string, unknown> = { ...base('wf-u', 'Undetermined'), runs_as: { person: 'extern@kanzlei.example', ended: false, undetermined: true } };
		runAnswer = { status: 403, body: { error: 'engine sentence', code: 'author_ended', runs_as: 'extern@kanzlei.example' } };
		await open([wf]);
		wf['runs_as'] = { person: 'extern@kanzlei.example', ended: true, undetermined: true, covered_by_takeover: 0 };
		const run = [...target.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === 'Ausführen');
		run!.click();
		await settle();
		expect(target.querySelector('[data-page-error]')?.textContent).toBe('Eine Person mit Zugang hat den Workflow Undetermined angelegt oder zuletzt geändert, und ihr Zugang ist beendet. Er läuft erst wieder, wenn du ihn übernimmst: hier mit „Workflow übernehmen“.');
		expect(target.querySelector('[data-library-note="ended"]')?.textContent).toBe('Eine Person mit Zugang hat diesen Workflow angelegt oder zuletzt geändert, und ihr Zugang ist beendet. Er läuft erst wieder, wenn du ihn übernimmst.');
		expect(target.querySelector('[data-testid="access-ended-badge"]')?.textContent?.trim()).toBe('Zugang beendet');
		expect(target.textContent).not.toContain('extern@kanzlei.example');
	});

	it('sets the title apart on a card a person with access made, ended or not, and not on the owner\'s own', async () => {
		await open([ENDED, { ...base('wf-l', 'Live one'), runs_as: { person: JAN, ended: false } }, base('wf-o', 'Own one')]);
		const titleBox = (name: string): string | null | undefined => card(name).querySelector('p')?.querySelector('bdi[data-foreign-value]')?.textContent;
		expect(titleBox('Ended one')).toBe('Ended one');
		expect(titleBox('Live one')).toBe('Live one');
		expect(titleBox('Own one')).toBeUndefined();
	});

	it('draws an empty value as a box of its own width', async () => {
		const p = FULL();
		p['stillPaused'] = [{ id: 'p-s', title: '   ' }];
		await open([ENDED], [p]);
		const d = await openDialog();
		const empty = d.querySelector<HTMLElement>('[data-takeover-part="paused"] bdi[data-foreign-value]')!;
		expect(empty.textContent).toBe('');
		// Its inner space and its edge are what draw it.
		expect(empty.classList.contains('px-1')).toBe(true);
		expect(empty.classList.contains('border')).toBe(true);
	});

	it('sets a card title apart where the access of whoever made or changed it ended, in the list font', async () => {
		await open([
			base('wf-o', 'Owner one'),
			ENDED,
			{ ...base('wf-u', 'Unknown one'), runs_as: { person: EVA, ended: true, undetermined: true, covered_by_takeover: 0 } },
		]);
		const title = (t: string): Element | undefined => [...target.querySelectorAll('p.font-medium')].find((e) => e.textContent?.trim() === t);
		expect(title('Owner one'), 'Owner one').toBeDefined();
		expect(title('Owner one')!.querySelector('bdi')).toBeNull();
		for (const t of ['Ended one', 'Unknown one']) {
			const box = title(t)?.querySelector('bdi[data-foreign-value]');
			expect(box?.textContent, t).toBe(t);
			expect(box!.classList.contains('bg-bg-muted'), t).toBe(true);
			expect(box!.classList.contains('font-mono'), t).toBe(false);
		}
	});

	it('gives the box 4 px inside, closed on each line, and no space of its own outside', async () => {
		await open([ENDED]);
		const card = [...target.querySelectorAll('p.font-medium')].find((e) => e.textContent?.trim() === 'Ended one');
		const d = await openDialog();
		const inSentence = d.querySelector('[data-takeover-part="released"] bdi[data-foreign-value]');
		expect(inSentence?.textContent).toBe('Daily');
		for (const b of [card!.querySelector('bdi[data-foreign-value]')!, inSentence!]) {
			const classes = [...b.classList];
			expect(classes.filter((c) => MARGIN_CLASS.test(c))).toEqual([]);
			expect(classes.filter((c) => PADDING_CLASS.test(c))).toEqual(['px-1']);
			expect(classes).toContain('box-decoration-clone');
			// The 1 px edge that draws the box on the measured grounds, in a title and in a sentence.
			expect(classes.filter((c) => c.startsWith('border'))).toEqual(['border', 'border-text-subtle']);
		}
	});

	it('sets the workflow name in the dialog\'s heading in the heading\'s font, a value in a sentence in the code font', async () => {
		await open([ENDED]);
		const d = await openDialog();
		const heading = d.querySelector('#workflow-takeover-title bdi[data-foreign-value]');
		expect(heading?.textContent).toBe('Ended one');
		expect(heading!.classList.contains('font-mono')).toBe(false);
		const inSentence = d.querySelector('[data-takeover-part="released"] bdi[data-foreign-value]');
		expect(inSentence?.textContent).toBe('Daily');
		expect(inSentence!.classList.contains('font-mono')).toBe(true);
	});

	it('sets the person apart in the note at an ended workflow, with and without paused plans', async () => {
		await open([
			{ ...base('wf-a', 'Plain'), runs_as: { person: 'FX-person', ended: true, covered_by_takeover: 0 } },
			{ ...base('wf-b', 'With plans'), runs_as: { person: 'FX-personpaused', ended: true, covered_by_takeover: 2 } },
		]);
		const notes = [...target.querySelectorAll('[data-library-note="ended"]')];
		expect(notes.length).toBe(2);
		const places = notes.flatMap((n) => foreignPlaces(n));
		expect(places.map(([v]) => v).sort()).toEqual(['FX-person', 'FX-personpaused']);
		expect(places.filter(([, apart]) => !apart)).toEqual([]);
	});

	it('sets the workflow and the person apart in the banner after a run refused because that access ended', async () => {
		const wf: Record<string, unknown> = { ...base('wf-r', 'FX-wfname'), runs_as: { person: 'FX-person', ended: false } };
		runAnswer = { status: 403, body: { error: 'engine sentence', code: 'author_ended', runs_as: 'FX-person' } };
		await open([wf]);
		const run = [...target.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === 'Ausführen');
		expect(run, 'the Run button').toBeDefined();
		run!.click();
		await settle();
		const banner = target.querySelector('[data-page-error]');
		expect(banner?.textContent).toContain('angelegt oder zuletzt geändert');
		const places = foreignPlaces(banner!);
		expect(places.map(([v]) => v).sort()).toEqual(['FX-person', 'FX-wfname']);
		expect(places.filter(([, apart]) => !apart)).toEqual([]);
	});
});

describe('the spacing class patterns of these tests', () => {
	it('catch every margin and padding form, and no other class', () => {
		for (const c of ['mx-1', 'mbs-1', 'mbe-2', 'sm:mx-1', '!mx-1', 'hover:sm:-mt-1', 'ms-0.5', 'm-0']) expect(MARGIN_CLASS.test(c), c).toBe(true);
		for (const c of ['px-1', 'pbs-1', 'pbe-2', 'sm:px-1', '!px-1', 'ps-0.5', 'p-0']) expect(PADDING_CLASS.test(c), c).toBe(true);
		for (const c of ['max-w-1', 'min-w-0', 'mask-x', 'place-items-center', 'pointer-events-none', 'font-mono', 'bg-bg-muted', 'box-decoration-clone']) {
			expect(MARGIN_CLASS.test(c), c).toBe(false);
			expect(PADDING_CLASS.test(c), c).toBe(false);
		}
	});
});
