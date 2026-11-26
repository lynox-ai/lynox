import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { setLocale, getLocale } from '../i18n.svelte.js';
import { startPausedPlansNav } from '../stores/paused-plans.svelte.js';
import { noteSettingsViewer, resetSettingsViewer } from '../stores/settings-viewer.svelte.js';

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

// The owner's takeover of a paused plan in the schedules view (641c-2): the button at the paused
// plan, for the owner only and never at a bulk run; the confirmation built from the preview; the
// POST held to the preview's digest; and the notice of each ended access, in full. This is the
// rendered half of Sperrtest 1 (`src/server/plan-pause-http.test.ts`): with the switch on, a
// paused plan carries the button.

let target: HTMLElement;
let component: Record<string, unknown> | undefined;
let viewer = 'owner';
let rows: Record<string, unknown>[] = [];
let preview: Record<string, unknown> = {};
/** What the next POST …/takeover answers, in order. */
let takeoverAnswers: Array<{ status: number; body: Record<string, unknown> }> = [];
let previews = 0;
let listLoads = 0;
let countReads = 0;
const posts: unknown[] = [];
const before = getLocale();

// A plan the owner alone set up and changed.
const OWN = { created_by: 'owner', edited_by: 'owner', mandate_editor: undefined } as const;
const PAUSED = {
	id: 'p1', title: 'Wochenreport', status: 'open', effect: 'run_agent', source: 'cron', confirmed_at: '2026-10-01T00:00:00.000Z',
	created_by: 'mandate:ida@example.invalid',
	paused: true, paused_who: ['ida@example.invalid'],
	paused_ended: [{ email: 'ida@example.invalid', reason: 'expired', ends_at: '2026-10-31T00:00:00.000Z', warned: false }],
};
const PREVIEW = {
	expect: 'digest-1', refusal: null,
	members: [{ name: 'ida@example.invalid', roles: ['created'], ended: true, reason: 'expired' }],
	runsAs: 'owner', workflow: null, memberChanges: [], alsoReleased: [], connections: [], schedule: 'kept', dueAt: null,
};


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

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
	setLocale('de');
	viewer = 'owner';
	rows = [PAUSED];
	preview = PREVIEW;
	takeoverAnswers = [];
	previews = 0;
	listLoads = 0;
	countReads = 0;
	posts.length = 0;
	vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
		const u = String(url);
		if (u.endsWith('/triggers')) { listLoads++; return json(200, { triggers: rows, viewer }); }
		if (u.endsWith('/triggers/paused-count')) { countReads++; return json(200, { viewer: 'owner', count: 1 }); }
		if (u.endsWith('/takeover-preview')) { previews++; return json(200, preview); }
		if (u.endsWith('/takeover')) {
			posts.push(JSON.parse(String(init?.body)));
			const a = takeoverAnswers.shift() ?? { status: 200, body: { ...PAUSED, paused: false } };
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

const button = (): HTMLButtonElement | null => target.querySelector<HTMLButtonElement>('[data-trigger-takeover]');
const dialog = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-takeover-dialog]');

async function open(): Promise<void> {
	button()!.click();
	await settle();
}

describe('the button at a paused plan', () => {
	it('shows for the owner at a paused plan', async () => {
		await render();
		expect(button()?.textContent?.trim()).toBe('Übernehmen');
	});
	it('ends the row of controls, where the hidden ones hold their place (ux)', async () => {
		await render();
		expect(button()?.parentElement?.lastElementChild).toBe(button());
	});
	it('not for a helper, not at a bulk run, not at a plan that is not paused', async () => {
		viewer = 'mandate';
		await render();
		expect(button()).toBeNull();
		unmount(component!);
		viewer = 'owner';
		rows = [{ ...PAUSED, effect: 'bulk_write' }, { ...PAUSED, id: 'p2', paused: false }];
		component = undefined;
		await render();
		expect(button()).toBeNull();
	});
});

describe('a completed plan that keeps its pause', () => {
	it('shows no label, no button and no notice; an open one does', async () => {
		rows = [{ ...PAUSED, status: 'completed' }];
		await render();
		expect([button(), target.querySelector('[data-trigger-paused]'), target.querySelector('[data-paused-notice]')]).toEqual([null, null, null]);
		unmount(component!);
		component = undefined;
		rows = [PAUSED];
		await render();
		expect([button() !== null, target.querySelector('[data-trigger-paused]') !== null, target.querySelector('[data-paused-notice]') !== null]).toEqual([true, true, true]);
	});
});

describe('a completed plan that keeps its pause (U-275)', () => {
	const mark = (): Element | null => target.querySelector('[data-trigger-paused-done]');
	const hint = (): Element | null => target.querySelector('[data-trigger-paused-done-hint]');
	it('is marked completed and paused, and its line names the way there is: a new plan', async () => {
		rows = [{ ...PAUSED, status: 'completed' }];
		await render();
		expect(mark()?.textContent).toBe('Abgeschlossen · pausiert');
		expect(hint()?.textContent).toBe('Ein Zugang endete. Soll der Plan wieder laufen, leg einen neuen an.');
		expect(target.querySelector('[data-trigger-paused]')).toBeNull();
	});
	it('an open paused plan keeps the takeover mark, and neither the completed mark nor its line', async () => {
		await render();
		expect(target.querySelector('[data-trigger-paused]')).not.toBeNull();
		expect(mark()).toBeNull();
		expect(hint()).toBeNull();
	});
	it('a completed plan without a pause has neither', async () => {
		rows = [{ ...PAUSED, status: 'completed', paused: false, paused_who: undefined, paused_ended: undefined }];
		await render();
		expect(target.textContent).toContain('Wochenreport');
		expect(mark()).toBeNull();
		expect(hint()).toBeNull();
	});
});

describe('Run now at a paused plan (ux U-179)', () => {
	const runNow = (): HTMLButtonElement | null => target.querySelector<HTMLButtonElement>('[data-trigger-run-now]');
	it('is not offered at a completed plan that keeps its pause, nor is its switch (U-275)', async () => {
		rows = [{ ...PAUSED, status: 'completed' }];
		await render();
		// The row is there, so the buttons are missing at it, not with an empty list.
		expect(target.textContent).toContain('Wochenreport');
		expect(runNow()).toBeNull();
		expect(target.querySelector('[data-trigger-toggle]')).toBeNull();
	});
	it('is not offered to a helper there either, who is told the pause without the names', async () => {
		viewer = 'mandate';
		const row = { id: 'p1', title: 'Wochenreport', effect: 'run_agent', source: 'cron', confirmed_at: '2026-10-01T00:00:00.000Z', paused: true };
		rows = [{ ...row, status: 'completed' }];
		await render();
		expect(target.textContent).toContain('Wochenreport');
		expect(runNow()).toBeNull();
		// The same row, not paused: the helper has the button, so its absence above is the pause's.
		unmount(component!);
		component = undefined;
		rows = [{ ...row, status: 'open', paused: false }];
		await render();
		expect(runNow()).not.toBeNull();
	});
});

describe('a plan that waits for its takeover (U-410)', () => {
	const runNow = (): HTMLButtonElement | null => target.querySelector<HTMLButtonElement>('[data-trigger-run-now]');
	const toggle = (): HTMLButtonElement | null => target.querySelector<HTMLButtonElement>('[data-trigger-toggle]');
	const ownerLine = (): HTMLElement | null => target.querySelector<HTMLElement>('[data-trigger-paused-owner]');
	it('offers the owner the takeover and neither Run now nor Pause, and no line for a helper', async () => {
		await render();
		expect(button()?.textContent?.trim()).toBe('Übernehmen');
		expect([runNow(), toggle(), ownerLine()]).toEqual([null, null, null]);
	});
	it('hides Resume too where the owner had paused the plan before', async () => {
		rows = [{ ...PAUSED, enabled: 0 }];
		await render();
		expect(target.textContent).toContain('Wochenreport');
		expect([runNow(), toggle()]).toEqual([null, null]);
	});
	it('tells a helper, visibly under the badge, who lets it run again, with neither button, in DE and EN', async () => {
		viewer = 'mandate';
		await render();
		expect([button(), runNow(), toggle()]).toEqual([null, null, null]);
		expect(ownerLine()?.textContent).toBe('Pausiert, bis der Inhaber den Plan übernimmt.');
		expect(ownerLine()?.previousElementSibling?.querySelector('[data-trigger-paused]')).not.toBeNull();
		unmount(component!);
		component = undefined;
		setLocale('en');
		await render();
		expect(ownerLine()?.textContent).toBe('Paused until the owner takes the plan over.');
		// Not at a bulk run, which no takeover lets run again (the engine never pauses one).
		unmount(component!);
		component = undefined;
		rows = [{ ...PAUSED, effect: 'bulk_apply' }];
		await render();
		// The row is there with its badge, so the line is missing at it, not with an empty list.
		expect(target.querySelector('[data-trigger-paused]')).not.toBeNull();
		expect(ownerLine()).toBeNull();
	});
	it('gives back both buttons, and no line, once the plan is not paused', async () => {
		for (const v of ['owner', 'mandate']) {
			viewer = v;
			rows = [{ ...PAUSED, paused: false, paused_who: undefined, paused_ended: undefined }];
			await render();
			expect([runNow() !== null, toggle()?.textContent?.trim(), ownerLine()]).toEqual([true, 'Pausieren', null]);
			unmount(component!);
			component = undefined;
		}
	});
	it('stays at a completed plan that is not paused', async () => {
		rows = [{ ...PAUSED, status: 'completed', paused: false, paused_who: undefined, paused_ended: undefined }];
		await render();
		expect(runNow()).not.toBeNull();
	});
});

describe('Delete and the switch at a paused plan, which the route refuses to a helper', () => {
	const del = (): HTMLButtonElement | null => target.querySelector<HTMLButtonElement>('[data-trigger-delete]');
	const toggle = (): HTMLButtonElement | null => target.querySelector<HTMLButtonElement>('[data-trigger-toggle]');
	// What a helper's list carries for a paused plan: the pause, not whose access ended (owner only).
	const HELPER_PAUSED = { ...PAUSED, paused_who: undefined, paused_ended: undefined };
	const remount = async (): Promise<void> => {
		unmount(component!);
		component = undefined;
		await render();
	};
	afterEach(() => { resetSettingsViewer(); });
	it('offers a helper neither at a paused plan, open or completed', async () => {
		viewer = 'mandate';
		rows = [HELPER_PAUSED];
		await render();
		// The row is there with its badge, so the buttons are missing at it, not with an empty list.
		expect(target.querySelector('[data-trigger-paused]')).not.toBeNull();
		expect([del(), toggle()]).toEqual([null, null]);
		rows = [{ ...HELPER_PAUSED, status: 'completed' }];
		await remount();
		expect(target.textContent).toContain('Wochenreport');
		expect([del(), toggle()]).toEqual([null, null]);
	});
	it('keeps Delete for the owner at a paused plan, open or completed, and offers no switch there', async () => {
		await render();
		expect([del()?.textContent?.trim(), toggle()]).toEqual(['Löschen', null]);
		// Completed, the plan never runs again, as its line says (U-275): a switch would say otherwise.
		rows = [{ ...PAUSED, status: 'completed' }];
		await remount();
		expect(target.querySelector('[data-trigger-paused-done-hint]')).not.toBeNull();
		expect([del()?.textContent?.trim(), toggle()]).toEqual(['Löschen', null]);
		// Nor a Resume where the owner had also switched it off before: it still never runs again.
		rows = [{ ...PAUSED, status: 'completed', enabled: 0 }];
		await remount();
		expect([del()?.textContent?.trim(), toggle()]).toEqual(['Löschen', null]);
		// CONTROL: the same plan completed without a pause keeps its switch.
		rows = [{ ...PAUSED, status: 'completed', paused: false, paused_who: undefined, paused_ended: undefined }];
		await remount();
		expect(toggle()?.textContent?.trim()).toBe('Pausieren');
	});
	it('keeps the switch at a plan the owner paused, which no ended access paused', async () => {
		// `enabled: 0` is the owner's own pause; `paused` is the one an ended access set.
		for (const status of ['open', 'completed']) {
			rows = [{ ...PAUSED, status, enabled: 0, paused: false, paused_who: undefined, paused_ended: undefined }];
			if (component) await remount(); else await render();
			expect(toggle()?.textContent?.trim()).toBe('Fortsetzen');
		}
	});
	it('keeps Delete for the owner the list does not name, once the session says owner', async () => {
		viewer = 'none';
		noteSettingsViewer({ viewer: 'owner' });
		rows = [{ ...PAUSED, status: 'completed' }];
		await render();
		expect(del()?.textContent?.trim()).toBe('Löschen');
	});
	it('gives a helper both at a plan that is not paused', async () => {
		viewer = 'mandate';
		rows = [{ ...HELPER_PAUSED, paused: false }];
		await render();
		expect([del()?.textContent?.trim(), toggle()?.textContent?.trim()]).toEqual(['Löschen', 'Pausieren']);
	});
});

describe('the notice of an ended access', () => {
	it('says the full address, which the push shortens, and that there was no advance notice', async () => {
		await render();
		const notice = target.querySelector('[data-paused-notice]')?.textContent ?? '';
		expect(notice).toContain('Für ida@example.invalid war ein Zugang bis zum 31.10.2026 eingetragen.');
		expect(notice.endsWith('Eine Vorwarnung gab es nicht.')).toBe(true);
	});
	it('is not shown to a helper, even if an answer carried the data', async () => {
		viewer = 'mandate';
		// The engine sends `paused_ended` to the owner only; the view does not lean on that alone.
		rows = [PAUSED];
		await render();
		expect(target.querySelector('[data-paused-notice]')).toBeNull();
	});
	it('names the day the access ended in UTC, as the push does', async () => {
		const tz = process.env['TZ'];
		process.env['TZ'] = 'America/New_York';
		try {
			rows = [{ ...PAUSED, paused_ended: [{ email: 'ida@x.ch', reason: 'expired', ends_at: '2026-10-31T02:00:00.000Z', warned: false }] }];
			await render();
			expect(target.querySelector('[data-paused-notice]')?.textContent).toContain('bis zum 31.10.2026');
		} finally {
			if (tz === undefined) delete process.env['TZ']; else process.env['TZ'] = tz;
		}
	});
});

describe('the confirmation', () => {
	it('sets the title apart on a plan with a takeover to give or one a person with access wrote, and on no plan of the owner\'s alone', async () => {
		const live = { paused: false, paused_who: undefined, paused_ended: undefined };
		rows = [
			PAUSED,
			{ ...PAUSED, ...live, id: 'p2', title: 'Monatsabschluss', created_by: 'mandate:ida@example.invalid' },
			{ ...PAUSED, ...live, id: 'p3', title: 'Eigener Plan', created_by: 'owner', edited_by: 'owner', mandate_editor: undefined },
		];
		await render();
		const titleBox = (title: string): Element | null | undefined => [...target.querySelectorAll('p.font-medium')].find((e) => e.textContent?.trim() === title)?.querySelector('bdi[data-foreign-value]');
		expect(titleBox('Wochenreport')?.textContent).toBe('Wochenreport');
		expect(titleBox('Monatsabschluss')?.textContent).toBe('Monatsabschluss');
		expect(titleBox('Eigener Plan')).toBeNull();
	});

	it('sets every paused title apart, and puts lynox\'s words before it only where the list says it is the workflow\'s name', async () => {
		const ida = 'mandate:ida@example.invalid';
		rows = [
			// The owner's plan may run a workflow someone else named, and carry that name: boxed too.
			{ ...PAUSED, created_by: 'owner', id: 'o1', title: 'Owner plan' },
			// Titled with its workflow's name by the engine, now (the name alone) and before (prefixed).
			{ ...PAUSED, id: 'w1', title: 'Wochenbericht', title_workflow: 'Wochenbericht', edited_by: ida },
			{ ...PAUSED, created_by: 'owner', id: 'w2', title: 'Scheduled: Monatsbericht', title_workflow: 'Monatsbericht' },
			// A title that starts with the prefix is whole in its box, the owner's own plan's too:
			// only the list says a title is the workflow's name, never the title's text.
			{ ...PAUSED, created_by: 'owner', id: 'f1', title: 'Scheduled: Forged' },
			{ ...PAUSED, id: 'f2', title: 'Scheduled: Mandate made', created_by: ida },
		];
		await render();
		const title = (t: string): Element | undefined => [...target.querySelectorAll('p.font-medium')].find((e) => e.textContent?.trim() === t);
		const boxed: Array<[string, string]> = [
			['Owner plan', 'Owner plan'],
			['Geplant: Wochenbericht', 'Wochenbericht'],
			['Geplant: Monatsbericht', 'Monatsbericht'],
			['Scheduled: Forged', 'Scheduled: Forged'],
			['Scheduled: Mandate made', 'Scheduled: Mandate made'],
		];
		for (const [line, value] of boxed) {
			const box = title(line)?.querySelector('bdi[data-foreign-value]');
			expect(box?.textContent, line).toBe(value);
			// One box per line: lynox's words stand outside it.
			expect(title(line)!.querySelectorAll('bdi[data-foreign-value]').length, line).toBe(1);
			// A grey box in the list's font: the title keeps its width.
			expect(box!.classList.contains('bg-bg-muted'), line).toBe(true);
			expect(box!.classList.contains('font-mono'), line).toBe(false);
			// No space of its own outside; 4 px inside, on each line of a wrapped title.
			expect([...box!.classList].filter((c) => MARGIN_CLASS.test(c)), line).toEqual([]);
			expect([...box!.classList].filter((c) => PADDING_CLASS.test(c)), line).toEqual(['px-1']);
			expect(box!.classList.contains('box-decoration-clone'), line).toBe(true);
			// Its 1 px edge, the part of the box that shows on the measured grounds.
			expect(box!.classList.contains('border'), line).toBe(true);
			expect(box!.classList.contains('border-text-subtle'), line).toBe(true);
		}
	});

	it('says lynox\'s words before a workflow\'s name in the reader\'s language, on a paused plan and in the list', async () => {
		const plans = [
			{ ...PAUSED, id: 'w1', title: 'Wochenbericht', title_workflow: 'Wochenbericht' },
			{ ...PAUSED, ...OWN, id: 'w2', title: 'Monatsbericht', title_workflow: 'Monatsbericht', paused: false, paused_who: undefined, paused_ended: undefined },
			{ ...PAUSED, ...OWN, id: 'f1', title: 'Scheduled: Forged', paused: false, paused_who: undefined, paused_ended: undefined },
			// Not paused, but a person with access set it up: the owner's list sets its title apart too.
			{ ...PAUSED, id: 'm1', title: 'Quartal', title_workflow: 'Quartal', paused: false, paused_who: undefined, paused_ended: undefined },
			{ ...PAUSED, id: 'm2', title: 'Scheduled: Forged too', paused: false, paused_who: undefined, paused_ended: undefined },
		];
		const lines = (): string[] => [...target.querySelectorAll('p[data-trigger-title]')].map((e) => (e.textContent ?? '').trim());
		rows = plans;
		await render();
		expect(lines()).toEqual(['Geplant: Wochenbericht', 'Geplant: Monatsbericht', 'Scheduled: Forged', 'Geplant: Quartal', 'Scheduled: Forged too']);
		unmount(component!);
		target.replaceChildren();
		setLocale('en');
		await render();
		expect(lines()).toEqual(['Scheduled: Wochenbericht', 'Scheduled: Monatsbericht', 'Scheduled: Forged', 'Scheduled: Quartal', 'Scheduled: Forged too']);
		// In English as in German: on the paused plan and on a plan a person with access set up, the
		// workflow's name is boxed and lynox's words stand outside; a title that only starts with
		// them is boxed whole. The owner's own plans in the list show no box.
		const boxes = [...target.querySelectorAll('p[data-trigger-title]')].map((e) => [...e.querySelectorAll('bdi[data-foreign-value]')].map((b) => b.textContent));
		expect(boxes).toEqual([['Wochenbericht'], [], [], ['Quartal'], ['Scheduled: Forged too']]);
	});

	it('sets every value someone else wrote apart, wherever a sentence of the plan takeover names it', async () => {
		rows = [{ ...PAUSED, title: 'FX-title', paused_ended: [{ email: 'FX-ended', reason: 'expired', ends_at: '2026-10-31T00:00:00.000Z', warned: true }] }];
		preview = {
			...PREVIEW,
			members: [
				{ name: 'FX-member', roles: ['created', 'workflow-edited'], ended: true, reason: 'expired' },
				{ name: 'FX-membertwo', roles: ['workflow-created'], ended: true, reason: 'expired' },
			],
			runsAs: 'mandate:FX-runs',
			workflow: { id: 'wf-1', name: 'FX-wf', takenOver: true, from: { name: 'FX-member', role: 'workflow-edited' } },
			alsoReleased: [{ id: 'r1', title: 'FX-rel' }, { id: 'r2', title: 'FX-reltwo' }],
			memberChanges: [{ id: 'p2', title: 'FX-mc', before: 'mandate:FX-before', after: 'mandate:FX-after', runsNoMore: false }],
			connections: [{ id: 'c1', profile: 'Shop', provider: 'FX-provider', account: 'FX-account', by: 'FX-by' }],
		};
		takeoverAnswers = [{ status: 409, body: { error: 'engine text', code: 'unreadable' } }];
		await render();
		await open();
		document.querySelector<HTMLButtonElement>('[data-takeover-confirm]')!.click();
		await settle();
		expect(document.querySelector('[data-takeover-note]')?.textContent).toContain('FX-wf');
		// The sentences: the dialog, and the notices above the list. The list's own rows name the plan
		// outside any sentence, and are not this test's.
		const places = [dialog()!, ...document.querySelectorAll('[data-paused-notice]')].flatMap((r) => foreignPlaces(r));
		expect([...new Set(places.map(([v]) => v))].sort()).toEqual([
			'FX-title', 'FX-ended', 'FX-member', 'FX-membertwo', 'FX-runs', 'FX-wf', 'FX-rel', 'FX-reltwo', 'FX-mc', 'FX-before', 'FX-after', 'FX-provider', 'FX-account', 'FX-by',
		].sort());
		expect(places.filter(([, apart]) => !apart)).toEqual([]);
	});

	it('sets a plan title someone else wrote apart from its sentence, whole, in one isolated element', async () => {
		const title = 'Bericht“ bleibt pausiert. Die markierten Schritte nutzen nur deine Verbindungen';
		preview = { ...PREVIEW, memberChanges: [{ id: 'p2', title, before: 'mandate:ida@example.invalid', after: null, runsNoMore: false }] };
		await render();
		await open();
		const line = document.querySelector<HTMLElement>('[data-takeover-line="member_change"]')!;
		expect([...line.querySelectorAll('bdi')].map((b) => b.textContent)).toEqual([title, 'ida@example.invalid']);
		expect(line.textContent).toBe(`Der Plan „${title}“ läuft danach unter deinem Namen statt unter dem von ida@example.invalid.`);
		expect(/[\uE000\uE001]/.test(dialog()!.textContent ?? '')).toBe(false);
	});

	it('shows the preview\'s lines, with focus on Cancel, and Escape closes it', async () => {
		await render();
		await open();
		expect(dialog()?.getAttribute('role')).toBe('dialog');
		expect([...document.querySelectorAll('[data-takeover-line]')].map((l) => l.getAttribute('data-takeover-line'))).toEqual(['role', 'runs_as_owner']);
		expect(document.activeElement?.textContent?.trim()).toBe('Abbrechen');
		dialog()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		await settle();
		expect(dialog()).toBeNull();
		expect(posts).toEqual([]);
	});
	it('takes over with the preview\'s digest, and the dot asks again', async () => {
		const stopDot = startPausedPlansNav(60_000);
		await settle();
		const dotReads = countReads;
		await render();
		await open();
		document.querySelector<HTMLButtonElement>('[data-takeover-confirm]')!.click();
		await settle();
		expect(posts).toEqual([{ expect: 'digest-1' }]);
		expect(dialog()).toBeNull();
		expect(countReads).toBe(dotReads + 1);
		stopDot();
	});
	it('a takeover that succeeds after its dialog was closed leaves the next dialog open', async () => {
		rows = [PAUSED, { ...PAUSED, id: 'p2', title: 'Monatsabschluss' }];
		let release: (() => void) | null = null;
		const inner = globalThis.fetch;
		vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
			if (String(url).endsWith('/p1/takeover')) {
				posts.push(JSON.parse(String(init?.body)));
				await new Promise<void>((r) => { release = r; });
				return json(200, { ...PAUSED, paused: false });
			}
			return inner(url, init);
		}));
		await render();
		const buttons = target.querySelectorAll<HTMLButtonElement>('[data-trigger-takeover]');
		buttons[0]!.click();
		await settle();
		document.querySelector<HTMLButtonElement>('[data-takeover-confirm]')!.click();
		await settle();
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
		await settle();
		buttons[1]!.click();
		await settle();
		release!();
		await settle();
		expect(dialog()).not.toBeNull();
		expect(document.querySelector('[data-takeover-confirm]')).not.toBeNull();
	});
	it('Escape closes from the window too, and focus goes back to the button that opened it', async () => {
		await render();
		button()!.focus();
		await open();
		document.body.focus();
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
		await settle();
		expect(dialog()).toBeNull();
		expect(document.activeElement).toBe(button());
	});
	it('a preview that answers after its dialog was closed and another opened is dropped', async () => {
		rows = [PAUSED, { ...PAUSED, id: 'p2', title: 'Monatsabschluss' }];
		let releaseFirst: (() => void) | null = null;
		const inner = globalThis.fetch;
		let first = true;
		vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
			if (String(url).endsWith('/p1/takeover-preview') && first) {
				first = false;
				await new Promise<void>((r) => { releaseFirst = r; });
				return json(200, { ...PREVIEW, expect: 'digest-of-p1' });
			}
			if (String(url).endsWith('/p2/takeover-preview')) return json(200, { ...PREVIEW, expect: 'digest-of-p2', runsAs: 'mandate:bo@x.ch', members: [{ name: 'bo@x.ch', roles: ['workflow-created'], ended: false, reason: null }] });
			return inner(url, init);
		}));
		await render();
		const buttons = target.querySelectorAll<HTMLButtonElement>('[data-trigger-takeover]');
		buttons[0]!.click();
		await settle();
		dialog()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		await settle();
		buttons[1]!.click();
		await settle();
		releaseFirst!();
		await settle();
		document.querySelector<HTMLButtonElement>('[data-takeover-confirm]')!.click();
		await settle();
		expect(posts).toEqual([{ expect: 'digest-of-p2' }]);
	});
	it('Escape in an overlay above the dialog is not the dialog\'s', async () => {
		await render();
		await open();
		const overlay = document.createElement('input');
		document.body.appendChild(overlay);
		overlay.focus();
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
		await settle();
		expect(dialog()).not.toBeNull();
		overlay.remove();
	});
	it('a takeover that answers after its dialog was closed says nothing in the next one', async () => {
		rows = [PAUSED, { ...PAUSED, id: 'p2', title: 'Monatsabschluss' }];
		let release: (() => void) | null = null;
		const inner = globalThis.fetch;
		vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
			if (String(url).endsWith('/p1/takeover')) {
				posts.push(JSON.parse(String(init?.body)));
				await new Promise<void>((r) => { release = r; });
				return json(409, { error: 'changed', code: 'changed' });
			}
			return inner(url, init);
		}));
		await render();
		const buttons = target.querySelectorAll<HTMLButtonElement>('[data-trigger-takeover]');
		buttons[0]!.click();
		await settle();
		document.querySelector<HTMLButtonElement>('[data-takeover-confirm]')!.click();
		await settle();
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
		await settle();
		buttons[1]!.click();
		await settle();
		const before = previews;
		release!();
		await settle();
		expect(document.querySelector('[data-takeover-note]')).toBeNull();
		expect(document.querySelector('[data-takeover-confirm]')).not.toBeNull();
		expect(previews).toBe(before);
		expect((document.querySelector<HTMLButtonElement>('[data-takeover-confirm]')!).disabled).toBe(false);
	});
	it('a re-fetch after a changed refusal that answers once another dialog is open writes nothing there', async () => {
		rows = [PAUSED, { ...PAUSED, id: 'p2', title: 'Monatsabschluss' }];
		takeoverAnswers = [{ status: 409, body: { error: 'changed', code: 'changed' } }];
		let release: (() => void) | null = null;
		let p1Previews = 0;
		const inner = globalThis.fetch;
		vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
			if (String(url).endsWith('/p1/takeover-preview') && ++p1Previews === 2) {
				await new Promise<void>((r) => { release = r; });
				return json(200, { ...PREVIEW, expect: 'digest-p1-new' });
			}
			return inner(url, init);
		}));
		await render();
		const buttons = target.querySelectorAll<HTMLButtonElement>('[data-trigger-takeover]');
		buttons[0]!.click();
		await settle();
		document.querySelector<HTMLButtonElement>('[data-takeover-confirm]')!.click();
		await settle();
		// A's re-fetch is in flight; the owner leaves and opens B.
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
		await settle();
		buttons[1]!.click();
		await settle();
		release!();
		await settle();
		expect(document.querySelector('[data-takeover-note]')).toBeNull();
		expect(document.querySelector('[data-takeover-confirm]')).not.toBeNull();
	});
	it('a plan that changed is shown again, with the line above it, and not taken over unseen', async () => {
		takeoverAnswers = [{ status: 409, body: { error: 'changed', code: 'changed' } }];
		await render();
		await open();
		preview = { ...PREVIEW, expect: 'digest-2' };
		const confirm = document.querySelector<HTMLButtonElement>('[data-takeover-confirm]')!;
		confirm.focus();
		confirm.click();
		await settle();
		expect(previews).toBe(2);
		expect(document.querySelector('[data-takeover-note]')?.textContent).toBe('Der Plan hat sich geändert, während du ihn angesehen hast. Unten steht der neue Stand. Prüf ihn und übernimm ihn dann.');
		// The focused button left with the old preview; focus is on Cancel again.
		expect(document.activeElement?.textContent?.trim()).toBe('Abbrechen');
		expect(dialog()).not.toBeNull();
		document.querySelector<HTMLButtonElement>('[data-takeover-confirm]')!.click();
		await settle();
		expect(posts).toEqual([{ expect: 'digest-1' }, { expect: 'digest-2' }]);
	});
	it('a refusal that lasts says so in the dialog, with support on a hosted instance', async () => {
		takeoverAnswers = [{ status: 503, body: { error: 'x', code: 'unrecorded' } }];
		await render();
		await open();
		document.querySelector<HTMLButtonElement>('[data-takeover-confirm]')!.click();
		await settle();
		expect(document.querySelector('[data-takeover-note]')?.textContent?.endsWith('Bleibt es so, schreib an support@lynox.ai.')).toBe(true);
		expect(dialog()).not.toBeNull();
	});
	it('a preview that cannot be loaded offers to load it again, and then the takeover', async () => {
		let fail = true;
		const inner = globalThis.fetch;
		vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
			if (String(url).endsWith('/takeover-preview') && fail) { previews++; return json(500, {}); }
			return inner(url, init);
		}));
		await render();
		await open();
		expect(document.querySelector('[data-takeover-note]')?.textContent).toBe('Die Übersicht lässt sich gerade nicht laden. Der Plan bleibt pausiert.');
		expect(document.querySelector('[data-takeover-confirm]')).toBeNull();
		fail = false;
		document.querySelector<HTMLButtonElement>('[data-takeover-reload]')!.click();
		await settle();
		expect(document.querySelector('[data-takeover-reload]')).toBeNull();
		expect(document.querySelector('[data-takeover-note]')).toBeNull();
		expect(document.querySelector('[data-takeover-confirm]')).not.toBeNull();
	});

	it('a preview that refuses offers no takeover, and the list is loaded again', async () => {
		preview = { refusal: 'nothing_to_take_over', message: 'x' };
		await render();
		const before = listLoads;
		await open();
		expect(listLoads).toBe(before + 1);
		expect(document.querySelector('[data-takeover-confirm]')).toBeNull();
		expect(document.querySelector('[data-takeover-note]')?.textContent).toBe('Dieser Plan muss nicht mehr übernommen werden. Die Liste ist aktualisiert.');
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
